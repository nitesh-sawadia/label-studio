import { observer } from "mobx-react";
import { type FC, useCallback, useState } from "react";
import { Button } from "@humansignal/ui";

/**
 * TrackWithCsrt — a minimal, self-contained interactive-tracking button for
 * video, independent of the SAM2 `ml-interactive` subsystem.
 *
 * Flow:
 *   1. Read the currently selected video region's box at the current frame
 *      (getShape -> {x,y,width,height,rotation}, already in percent 0-100).
 *   2. POST it as an interactive seed to the connected ML backend through the
 *      Label Studio proxy (/api/ml/:pk/interactive-annotating), which also
 *      lets the backend fetch the video server-side.
 *   3. Write the returned keyframe sequence back into the region via
 *      updateShape(), so the box follows the tracker frame-by-frame.
 *
 * It works with any interactive backend that accepts a videorectangle seed and
 * returns a videorectangle sequence (e.g. the CSRT OpenCV backend). It does NOT
 * require the SAM2 capability protocol or PNG masks.
 */

const API_BASE = (window as any).APP_SETTINGS?.hostname ?? "";

function getCsrfToken(): string {
  const match = document.cookie.split(";").find((c) => c.trim().startsWith("csrftoken="));
  return match ? match.trim().split("=")[1] : "";
}

// Region types that carry a box we can seed the tracker with.
const TRACKABLE_TYPES = new Set(["videorectangleregion", "videosquarecircleregion"]);

interface TrackWithCsrtProps {
  item: any; // Video object tag model
}

const TrackWithCsrtPure: FC<TrackWithCsrtProps> = ({ item }) => {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const annotation = item?.annotation;
  const store = annotation?.store;

  // The single selected region, if it's a trackable video box.
  const selected = annotation?.regionStore?.selection?.highlighted;
  const region = selected && TRACKABLE_TYPES.has(selected.type) ? selected : null;

  const resolveBackendId = useCallback(async (): Promise<number | null> => {
    const projectId = store?.project?.id ?? (window as any).DM?.project?.id;
    if (!projectId) return null;
    const res = await fetch(`${API_BASE}/api/ml/?project=${projectId}&is_interactive=true`, {
      credentials: "same-origin",
    });
    if (!res.ok) return null;
    const data = await res.json();
    const backends = data.results ?? data ?? [];
    return backends.length ? backends[0].id : null;
  }, [store]);

  const onTrack = useCallback(async () => {
    if (!region || !store) return;
    setMessage(null);

    const frame = item.frame ?? item.currentFrame ?? 1;
    const seedBox = region.getShape(frame); // {x,y,width,height,rotation} in %
    if (!seedBox) {
      setMessage("No box on the current frame to track.");
      return;
    }

    const taskId = store.task?.id;
    if (!taskId) {
      setMessage("No task id.");
      return;
    }

    setBusy(true);
    try {
      const backendId = await resolveBackendId();
      if (!backendId) {
        setMessage("No interactive ML backend connected (Settings → Model).");
        return;
      }

      // Seed the backend with the current box as a one-keyframe videorectangle
      // sequence — the exact shape CSRTVideoTracker._extract_seed expects.
      const context = {
        result: [
          {
            id: region.cleanId ?? region.id,
            type: "videorectangle",
            from_name: "box",
            to_name: item.name,
            value: {
              framesCount: item.length,
              sequence: [
                {
                  frame,
                  enabled: true,
                  x: seedBox.x,
                  y: seedBox.y,
                  width: seedBox.width,
                  height: seedBox.height,
                  rotation: seedBox.rotation ?? 0,
                },
              ],
              labels: region.labels ?? [],
            },
          },
        ],
      };

      const res = await fetch(`${API_BASE}/api/ml/${backendId}/interactive-annotating`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRFToken": getCsrfToken() },
        credentials: "same-origin",
        body: JSON.stringify({ task: taskId, context }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => `HTTP ${res.status}`);
        setMessage(`Backend error: ${text.slice(0, 160)}`);
        return;
      }

      const data = await res.json();
      if (data.errors?.length) {
        setMessage(`Backend error: ${data.errors[0]}`);
        return;
      }

      const sequence = data?.data?.result?.[0]?.value?.sequence;
      if (!Array.isArray(sequence) || sequence.length === 0) {
        setMessage("Tracker returned no keyframes.");
        return;
      }

      // Write every tracked keyframe back into the region.
      annotation.history?.freeze?.();
      let lastFrame = frame;
      for (const kf of sequence) {
        if (typeof kf.frame !== "number") continue;
        region.updateShape(
          {
            x: kf.x,
            y: kf.y,
            width: kf.width,
            height: kf.height,
            rotation: kf.rotation ?? 0,
          },
          kf.frame,
        );
        if (kf.frame > lastFrame) lastFrame = kf.frame;
      }
      // End the lifespan one frame past the last tracked keyframe so the box
      // doesn't persist forever after tracking stops.
      if (typeof region.setLifespanAt === "function" && lastFrame + 1 <= item.length) {
        region.setLifespanAt(lastFrame + 1, false);
      }
      annotation.history?.unfreeze?.();
      annotation.history?.recordNow?.();

      setMessage(`Tracked ${sequence.length} frames.`);
    } catch (err: any) {
      setMessage(`Track failed: ${err?.message ?? String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [region, store, item, resolveBackendId, annotation]);

  const wrapperClass =
    "box-border flex items-center gap-base px-tighter py-tighter h-1100 border-t border-neutral-border bg-neutral-background";

  return (
    <div className={wrapperClass} data-testid="track-with-csrt-bar">
      <Button
        variant="primary"
        look="filled"
        size="small"
        disabled={!region || busy}
        waiting={busy}
        onClick={onTrack}
        data-testid="track-with-csrt-button"
      >
        {busy ? "Tracking…" : "Track with CSRT"}
      </Button>
      <span className="text-neutral-content-subtler text-sm">
        {region
          ? (message ?? "Select frame & press Track to follow this box forward")
          : "Select a video box region to track"}
      </span>
    </div>
  );
};

export const TrackWithCsrt = observer(TrackWithCsrtPure);
