# CSRT Video Tracking ML Backend

Replaces Label Studio's default **linear interpolation** between video keyframes
with real **visual tracking** using OpenCV's CSRT tracker
(`cv2.TrackerCSRT`). You draw one bounding box on an object; the backend tracks
it forward through the video and returns a dense keyframe sequence that follows
the object's actual motion.

## How it fits into Label Studio

Label Studio stores a video rectangle as a *keyframe `sequence`*. Normally only
the frames you annotate are stored, and every frame in between is reconstructed
by `interpolateProp()` in the frontend — a straight line between keyframes. This
backend plugs into Label Studio's **interactive** prediction path: the frontend
sends your seed box via the `/predict` endpoint with an interactive `context`,
and this backend returns CSRT-tracked keyframes instead.

Contract (same one `label_studio/ml/api_connector.py` + `models.py` expect):
`{"results": [{"result": [ <videorectangle region> ], "score": ..., "model_version": ...}]}`.
Box geometry (`x/y/width/height`) is in **percentages (0-100)** and frames are
**1-indexed**, matching `VideoRegion.serialize()`.

## Install & run

```bash
cd csrt_ml_backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Label Studio needs to let the backend fetch the video file:
export LABEL_STUDIO_URL=http://localhost:8080
export LABEL_STUDIO_API_KEY=<your personal access token>

python _wsgi.py -p 9090
```

> Use `opencv-contrib-python` (not plain `opencv-python`) — CSRT lives in the
> contrib modules.

## Connect it in Label Studio

1. Project → **Settings → Model → Connect Model**.
2. URL: `http://localhost:9090`.
3. Enable **"Use for interactive preannotations"** so it responds to seed boxes
   rather than running as a batch pre-labeler.

## Labeling config

The backend looks for a `VideoRectangle` control pointed at a `Video` object:

```xml
<View>
  <Video name="video" value="$video" framerate="25"/>
  <VideoRectangle name="box" toName="video"/>
  <Labels name="videoLabels" toName="video">
    <Label value="Car" background="#FF0000"/>
    <Label value="Person" background="#00FF00"/>
  </Labels>
</View>
```

## Tunables (environment variables)

- `MAX_FRAMES_TO_TRACK` (default 100) — how far forward to track from the seed.
- `KEYFRAME_STRIDE` (default 1) — emit a keyframe every N frames. `1` = every
  frame (most accurate, bigger payload); higher values let Label Studio
  interpolate between tracker keyframes to shrink the result.

## Notes & limitations

- CSRT tracks **translation + scale**, not rotation, so emitted `rotation` is 0.
- If the tracker loses the object, the last keyframe's lifespan is ended
  (`enabled: false`) so the region stops rather than drifting.
- Tracking is forward-only from the seed frame. For bidirectional tracking,
  run a second pass over reversed frames.
