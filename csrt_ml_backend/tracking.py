"""Pure tracking engines with no Label Studio SDK dependency.

Keeping these free of SDK imports lets them be unit-tested in isolation and
reused by the ML backend (`model.py`).

Two engines:
  * CSRTSingleObjectTracker     — interactive, single object seeded from one box.
  * ByteTrackMultiObjectTracker — batch, multi-object; a detector feeds boxes
    per frame and ByteTrack associates them into tracks.

All geometry crossing the Label Studio boundary is in percentages (0-100) and
frames are 1-indexed, matching VideoRegion.serialize().
"""
import logging
from typing import Callable, Dict, List, Tuple

import cv2
import numpy as np

logger = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# shared helpers
# --------------------------------------------------------------------------- #
def create_csrt_tracker():
    """OpenCV moved the tracker factory around between versions."""
    if hasattr(cv2, "TrackerCSRT_create"):
        return cv2.TrackerCSRT_create()
    if hasattr(cv2, "legacy") and hasattr(cv2.legacy, "TrackerCSRT_create"):
        return cv2.legacy.TrackerCSRT_create()
    if hasattr(cv2, "TrackerCSRT"):
        return cv2.TrackerCSRT.create()
    raise RuntimeError(
        "CSRT tracker not available. Install opencv-contrib-python "
        "(not plain opencv-python)."
    )


def pixel_box_to_keyframe(frame_1indexed, bx, by, bw, bh, frame_w, frame_h, fps, enabled=True):
    """Convert a pixel (x, y, w, h) box to an LS percentage-space keyframe."""
    return {
        "frame": int(frame_1indexed),
        "enabled": enabled,
        "x": max(0.0, bx / frame_w * 100.0),
        "y": max(0.0, by / frame_h * 100.0),
        "width": bw / frame_w * 100.0,
        "height": bh / frame_h * 100.0,
        "rotation": 0,
        "time": (frame_1indexed - 1) / fps if fps else 0.0,
    }


def _video_meta(cap) -> Tuple[int, float, int, int]:
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 24.0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    return total, fps, w, h


# --------------------------------------------------------------------------- #
# CSRT single-object (interactive)
# --------------------------------------------------------------------------- #
class CSRTSingleObjectTracker:
    def __init__(self, max_frames: int = 100, keyframe_stride: int = 1):
        self.max_frames = max_frames
        self.keyframe_stride = max(1, keyframe_stride)

    def track(self, video_path: str, seed: Dict) -> Dict:
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            raise ValueError(f"Could not open video: {video_path}")

        total, fps, fw, fh = _video_meta(cap)
        duration = total / fps if fps else 0.0
        start_idx = seed["frame"] - 1  # 0-indexed for OpenCV

        cap.set(cv2.CAP_PROP_POS_FRAMES, start_idx)
        ok, frame = cap.read()
        if not ok:
            cap.release()
            raise ValueError(f"Could not read seed frame {seed['frame']}")

        px = seed["x"] / 100.0 * fw
        py = seed["y"] / 100.0 * fh
        pw = seed["width"] / 100.0 * fw
        ph = seed["height"] / 100.0 * fh

        tracker = create_csrt_tracker()
        # OpenCV's tracker.init expects an integer-pixel bounding box.
        tracker.init(frame, (int(round(px)), int(round(py)), int(round(pw)), int(round(ph))))

        sequence = [pixel_box_to_keyframe(seed["frame"], px, py, pw, ph, fw, fh, fps)]

        tracked = 0
        cur = start_idx
        while tracked < self.max_frames and cur + 1 < total:
            ok, frame = cap.read()
            if not ok:
                break
            cur += 1
            tracked += 1

            ok, box = tracker.update(frame)
            if not ok:
                # Tracker lost the object: end the lifespan here.
                sequence[-1]["enabled"] = False
                break

            bx, by, bw, bh = box
            if tracked % self.keyframe_stride == 0 or cur + 1 >= total:
                sequence.append(pixel_box_to_keyframe(cur + 1, bx, by, bw, bh, fw, fh, fps))

        cap.release()
        return {
            "framesCount": total,
            "duration": duration,
            "sequence": sequence,
            "labels": seed.get("labels", []),
        }


# --------------------------------------------------------------------------- #
# ByteTrack multi-object (batch)
# --------------------------------------------------------------------------- #
# Detector callback contract:
#   detect(frame_bgr) -> list of (x, y, w, h, score, class_name) in PIXELS.
Detection = Tuple[float, float, float, float, float, str]
DetectorFn = Callable[[np.ndarray], List[Detection]]


class ByteTrackMultiObjectTracker:
    """Multi-object tracking via ByteTrack over per-frame detections.

    ByteTrack itself does no detection: it associates detection boxes across
    frames into stable track IDs. We run a user-supplied detector per frame,
    feed its boxes to `supervision.ByteTrack`, and group the resulting
    tracker_ids — each track becomes one Label Studio video region.
    """

    def __init__(
        self,
        detector: DetectorFn,
        max_frames: int = 300,
        keyframe_stride: int = 1,
        frame_stride: int = 1,
    ):
        self.detector = detector
        self.max_frames = max_frames
        self.keyframe_stride = max(1, keyframe_stride)
        self.frame_stride = max(1, frame_stride)

    def _make_bytetrack(self, fps: float):
        try:
            import supervision as sv
        except ImportError as e:
            raise RuntimeError(
                "ByteTrack mode requires the 'supervision' package "
                "(pip install supervision)."
            ) from e
        return sv, sv.ByteTrack(frame_rate=int(round(fps)) or 24)

    def track(self, video_path: str) -> List[Dict]:
        cap = cv2.VideoCapture(video_path)
        if not cap.isOpened():
            raise ValueError(f"Could not open video: {video_path}")

        total, fps, fw, fh = _video_meta(cap)
        duration = total / fps if fps else 0.0
        sv, byte_track = self._make_bytetrack(fps)

        # tracker_id -> {"label": str, "frames": {frame_1indexed: (x, y, w, h)}}
        tracks: Dict[int, Dict] = {}

        idx = 0          # 0-indexed position in the video
        processed = 0    # number of frames actually run through the detector
        while processed < self.max_frames:
            ok, frame = cap.read()
            if not ok:
                break
            if idx % self.frame_stride != 0:
                idx += 1
                continue
            idx += 1
            processed += 1

            dets = self.detector(frame)
            if dets:
                xyxy = np.array(
                    [[x, y, x + w, y + h] for (x, y, w, h, s, c) in dets], dtype=float
                )
                conf = np.array([d[4] for d in dets], dtype=float)
                class_names = [d[5] for d in dets]
                detections = sv.Detections(
                    xyxy=xyxy,
                    confidence=conf,
                    class_id=np.arange(len(dets)),
                )
            else:
                detections = sv.Detections.empty()
                class_names = []

            tracked = byte_track.update_with_detections(detections)

            for i in range(len(tracked)):
                if tracked.tracker_id is None:
                    continue
                tid = int(tracked.tracker_id[i])
                x1, y1, x2, y2 = tracked.xyxy[i]
                cls_idx = int(tracked.class_id[i]) if tracked.class_id is not None else None
                label = (
                    class_names[cls_idx]
                    if cls_idx is not None and 0 <= cls_idx < len(class_names)
                    else "object"
                )
                entry = tracks.setdefault(tid, {"label": label, "frames": {}})
                entry["frames"][idx] = (x1, y1, x2 - x1, y2 - y1)

        cap.release()

        regions = []
        for tid, entry in tracks.items():
            frames = sorted(entry["frames"].items())
            sequence = []
            for n, (fnum, (bx, by, bw, bh)) in enumerate(frames):
                if n % self.keyframe_stride != 0 and n != len(frames) - 1:
                    continue
                sequence.append(pixel_box_to_keyframe(fnum, bx, by, bw, bh, fw, fh, fps))
            if not sequence:
                continue
            regions.append(
                {
                    "track_id": tid,
                    "framesCount": total,
                    "duration": duration,
                    "sequence": sequence,
                    "labels": [entry["label"]],
                }
            )
        return regions
