import os
import logging
from typing import Dict, List, Optional
from uuid import uuid4

from label_studio_ml.model import LabelStudioMLBase
from label_studio_ml.response import ModelResponse

from tracking import CSRTSingleObjectTracker, ByteTrackMultiObjectTracker

logger = logging.getLogger(__name__)

# --- CSRT (interactive, single object) -------------------------------------
MAX_FRAMES_TO_TRACK = int(os.getenv("MAX_FRAMES_TO_TRACK", 100))
KEYFRAME_STRIDE = int(os.getenv("KEYFRAME_STRIDE", 1))

# --- ByteTrack (batch, multi object) ---------------------------------------
# Set TRACKER=bytetrack to run multi-object detect-then-track on /predict
# without an interactive seed. Requires a detector (YOLO by default).
TRACKER = os.getenv("TRACKER", "csrt").lower()
BYTETRACK_MAX_FRAMES = int(os.getenv("BYTETRACK_MAX_FRAMES", 300))
BYTETRACK_FRAME_STRIDE = int(os.getenv("BYTETRACK_FRAME_STRIDE", 1))
YOLO_MODEL = os.getenv("YOLO_MODEL", "yolov8n.pt")
YOLO_CONF = float(os.getenv("YOLO_CONF", 0.3))


def _build_yolo_detector():
    """Return a detector callback: frame_bgr -> [(x,y,w,h,score,class_name)].

    Lazily imports ultralytics so CSRT-only deployments don't need it.
    """
    try:
        from ultralytics import YOLO
    except ImportError as e:
        raise RuntimeError(
            "ByteTrack mode needs a detector. Install ultralytics "
            "(pip install ultralytics) or supply your own detector."
        ) from e

    model = YOLO(YOLO_MODEL)
    names = model.names

    def detect(frame_bgr):
        results = model.predict(frame_bgr, conf=YOLO_CONF, verbose=False)
        out = []
        for r in results:
            if r.boxes is None:
                continue
            for b in r.boxes:
                x1, y1, x2, y2 = b.xyxy[0].tolist()
                score = float(b.conf[0])
                cls = int(b.cls[0])
                out.append((x1, y1, x2 - x1, y2 - y1, score, names.get(cls, str(cls))))
        return out

    return detect


class CSRTVideoTracker(LabelStudioMLBase):
    """Video object tracking backend.

    - CSRT mode (default, interactive): seed one box, track it forward with
      OpenCV CSRT. Replaces Label Studio's linear interpolation with real
      visual tracking.
    - ByteTrack mode (TRACKER=bytetrack, batch): detect all objects per frame
      with YOLO and associate them across frames into multi-object tracks.
    """

    def setup(self):
        self.set("model_version", f"video-tracker-{TRACKER}-v1")

    def _get_video_tag(self):
        from_name, to_name, value = self.get_first_tag_occurence("VideoRectangle", "Video")
        return from_name, to_name, value

    def _resolve_video_url(self, task: Dict, value_key: Optional[str]) -> str:
        data = task["data"]
        if value_key and value_key in data:
            return data[value_key]
        return next(iter(data.values()))

    # ------------------------------------------------------------------ #
    # CSRT seed extraction (interactive)
    # ------------------------------------------------------------------ #
    def _extract_seed(self, context: Dict) -> Optional[Dict]:
        results = (context or {}).get("result") or []
        for ctx in results:
            value = ctx.get("value", {})
            sequence = value.get("sequence") or []
            if not sequence:
                continue
            kf = sorted(sequence, key=lambda k: k["frame"])[0]
            return {
                "id": ctx.get("id") or str(uuid4())[:8],
                "frame": int(kf["frame"]),
                "x": float(kf["x"]),
                "y": float(kf["y"]),
                "width": float(kf["width"]),
                "height": float(kf["height"]),
                "rotation": float(kf.get("rotation", 0)),
                "labels": value.get("labels") or [],
            }
        return None

    def _resolve_local_video(self, task: Dict, video_url: str):
        """Resolve the video to a local file.

        Prefer a direct filesystem lookup under LABEL_STUDIO_LOCAL_FILES_DOCUMENT_ROOT
        (set when LS serves local files), which avoids an authenticated HTTP
        round-trip. Fall back to the SDK's get_local_path (download+cache) for
        cloud/remote storage.
        """
        import os
        from urllib.parse import urlparse, parse_qs, unquote

        doc_root = os.getenv("LABEL_STUDIO_LOCAL_FILES_DOCUMENT_ROOT")
        if doc_root and "/data/local-files" in video_url:
            # URL form: /data/local-files/?d=<relative path under doc_root>
            qs = parse_qs(urlparse(video_url).query)
            rel = (qs.get("d") or [None])[0]
            if rel:
                candidate = os.path.join(doc_root, unquote(rel))
                if os.path.isfile(candidate):
                    logger.info(f"Resolved video locally: {candidate}")
                    return candidate
        # Fallback: fetch via Label Studio API (needs LABEL_STUDIO_URL + API key).
        return self.get_local_path(video_url, task_id=task.get("id"))

    def _region(self, region_id, from_name, to_name, value) -> Dict:
        return {
            "id": region_id,
            "type": "videorectangle",
            "from_name": from_name,
            "to_name": to_name,
            "value": value,
        }

    # ------------------------------------------------------------------ #
    # Entry point
    # ------------------------------------------------------------------ #
    def predict(self, tasks: List[Dict], context: Optional[Dict] = None, **kwargs) -> ModelResponse:
        from_name, to_name, value_key = self._get_video_tag()
        task = tasks[0]
        video_url = self._resolve_video_url(task, value_key)
        local_video = self._resolve_local_video(task, video_url)

        # Interactive single-object CSRT: triggered when the user supplies a seed box.
        if context and context.get("result"):
            seed = self._extract_seed(context)
            if seed is None:
                logger.warning("Interactive context had no usable seed keyframe.")
                return ModelResponse(predictions=[])

            engine = CSRTSingleObjectTracker(
                max_frames=MAX_FRAMES_TO_TRACK, keyframe_stride=KEYFRAME_STRIDE
            )
            value = engine.track(local_video, seed)
            region = self._region(seed["id"], from_name, to_name, value)
            return ModelResponse(
                predictions=[
                    {
                        "result": [region],
                        "score": 1.0,
                        "model_version": self.get("model_version"),
                    }
                ]
            )

        # Batch multi-object ByteTrack: no seed, detect-then-track everything.
        if TRACKER == "bytetrack":
            detector = _build_yolo_detector()
            engine = ByteTrackMultiObjectTracker(
                detector=detector,
                max_frames=BYTETRACK_MAX_FRAMES,
                keyframe_stride=KEYFRAME_STRIDE,
                frame_stride=BYTETRACK_FRAME_STRIDE,
            )
            track_values = engine.track(local_video)
            regions = [
                self._region(f"track-{tv['track_id']}", from_name, to_name,
                             {k: v for k, v in tv.items() if k != "track_id"})
                for tv in track_values
            ]
            return ModelResponse(
                predictions=[
                    {
                        "result": regions,
                        "score": 1.0,
                        "model_version": self.get("model_version"),
                    }
                ]
            )

        # CSRT mode with no seed → nothing to do.
        logger.info("No interactive seed provided and TRACKER!=bytetrack; nothing to track.")
        return ModelResponse(predictions=[])
