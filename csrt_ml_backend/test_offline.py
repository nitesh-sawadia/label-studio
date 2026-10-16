"""Offline verification of both tracking engines (no Label Studio required).

CSRT:      synthetic video with one moving box; seed on frame 1, check the
           tracked keyframes follow the object.
ByteTrack: synthetic video with two boxes moving in opposite directions;
           a fake detector feeds boxes, check two stable tracks come out.
"""
import os
import tempfile

import cv2
import numpy as np

from tracking import CSRTSingleObjectTracker, ByteTrackMultiObjectTracker

W, H, N = 320, 240, 40
BOX = 40


def _frame_bg():
    return np.full((H, W, 3), 30, np.uint8)


# --------------------------------------------------------------------------- #
# CSRT
# --------------------------------------------------------------------------- #
def _textured_box(frame, x, y, color):
    """Draw a box with internal texture so feature-based trackers can lock on."""
    cv2.rectangle(frame, (x, y), (x + BOX, y + BOX), color, -1)
    # internal grid + diagonals give CSRT corners/edges to track
    cv2.line(frame, (x, y), (x + BOX, y + BOX), (0, 0, 0), 2)
    cv2.line(frame, (x + BOX, y), (x, y + BOX), (255, 255, 255), 2)
    cv2.circle(frame, (x + BOX // 2, y + BOX // 2), 8, (10, 10, 10), -1)


def make_single_box_video(path):
    out = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"), 25.0, (W, H))
    positions = []
    for i in range(N):
        frame = _frame_bg()
        x, y = 20 + i * 6, 100
        _textured_box(frame, x, y, (0, 200, 255))
        positions.append((x, y))
        out.write(frame)
    out.release()
    return positions


def test_csrt(tmp):
    video = os.path.join(tmp, "single.mp4")
    positions = make_single_box_video(video)

    seed = {
        "id": "r1", "frame": 1,
        "x": positions[0][0] / W * 100, "y": positions[0][1] / H * 100,
        "width": BOX / W * 100, "height": BOX / H * 100,
        "rotation": 0, "labels": ["Car"],
    }
    value = CSRTSingleObjectTracker(max_frames=100).track(video, seed)
    seq = value["sequence"]
    print(f"[CSRT] framesCount={value['framesCount']} keyframes={len(seq)}")

    ok = True
    for kf in seq[::10]:
        gt_x = positions[kf["frame"] - 1][0]
        tracked_x = kf["x"] / 100 * W
        err = abs(tracked_x - gt_x)
        print(f"[CSRT] frame {kf['frame']:>3}: gt_x={gt_x:>3} tracked_x={tracked_x:6.1f} err={err:5.1f}px")
        ok = ok and err <= 15
    assert len(seq) >= N - 2, "CSRT stopped too early"
    assert ok, "CSRT drifted too far"
    print("[CSRT] PASS\n")


# --------------------------------------------------------------------------- #
# ByteTrack
# --------------------------------------------------------------------------- #
def make_two_box_video(path):
    out = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"mp4v"), 25.0, (W, H))
    gt = []  # per-frame list of (x,y,w,h,label)
    for i in range(N):
        frame = _frame_bg()
        ax, ay = 20 + i * 6, 60      # moves right
        bx, by = 260 - i * 6, 140    # moves left
        cv2.rectangle(frame, (ax, ay), (ax + BOX, ay + BOX), (0, 200, 255), -1)
        cv2.rectangle(frame, (bx, by), (bx + BOX, by + BOX), (255, 100, 0), -1)
        out.write(frame)
        gt.append([(ax, ay, BOX, BOX, "Car"), (bx, by, BOX, BOX, "Person")])
    out.release()
    return gt


def test_bytetrack(tmp):
    video = os.path.join(tmp, "double.mp4")
    gt = make_two_box_video(video)

    # Fake "detector": return the ground-truth boxes (+ a little noise) for the
    # frame currently being read. This exercises ByteTrack's association logic
    # without needing a real YOLO model.
    state = {"i": 0}

    def fake_detector(_frame):
        i = min(state["i"], N - 1)
        state["i"] += 1
        dets = []
        for (x, y, w, h, label) in gt[i]:
            jitter = np.random.uniform(-2, 2, size=2)
            dets.append((x + jitter[0], y + jitter[1], w, h, 0.9, label))
        return dets

    engine = ByteTrackMultiObjectTracker(detector=fake_detector, max_frames=N)
    regions = engine.track(video)
    print(f"[ByteTrack] tracks produced: {len(regions)}")
    for r in regions:
        print(f"[ByteTrack] track {r['track_id']}: label={r['labels']} "
              f"keyframes={len(r['sequence'])} "
              f"frames={r['sequence'][0]['frame']}..{r['sequence'][-1]['frame']}")

    assert len(regions) >= 2, f"expected >=2 tracks, got {len(regions)}"
    # Each track should span most of the video and carry a label.
    long_tracks = [r for r in regions if len(r["sequence"]) >= N * 0.6]
    assert len(long_tracks) >= 2, "ByteTrack did not form two stable long tracks"
    labels = {r["labels"][0] for r in long_tracks}
    assert {"Car", "Person"} & labels, "expected Car/Person labels on tracks"
    print("[ByteTrack] PASS\n")


def main():
    tmp = tempfile.mkdtemp()
    test_csrt(tmp)
    test_bytetrack(tmp)
    print("ALL TESTS PASSED")


if __name__ == "__main__":
    main()
