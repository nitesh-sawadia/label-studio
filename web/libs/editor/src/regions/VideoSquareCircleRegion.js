import { types } from "mobx-state-tree";

import NormalizationMixin from "../mixins/Normalization";
import RegionsMixin from "../mixins/Regions";
import Registry from "../core/Registry";
import { AreaMixin } from "../mixins/AreaMixin";
import { onlyProps, VideoRegion } from "./VideoRegion";
import { interpolateProp } from "../utils/props";

/**
 * Detects a square-circle video region. The serialized value is circle-shaped
 * (cx/cy/radius on each keyframe), which also distinguishes it from a plain
 * videorectangle (x/y/width/height).
 */
export const isVideoSquareCircleRegionValue = (value = {}) => {
  if (value.shape === "squarecircle" || value.value?.shape === "squarecircle") return true;

  const sequence = value.sequence ?? value.value?.sequence;

  return (
    Array.isArray(sequence) &&
    sequence.some((keyframe) => keyframe?.radius !== undefined || keyframe?.shape === "squarecircle")
  );
};

/**
 * Coordinate contract
 * -------------------
 * Serialized keyframe (what gets SAVED): { frame, enabled, cx, cy, radius, time }
 *   - cx     : circle center X, percent of frame width  (0-100)
 *   - cy     : circle center Y, percent of frame height (0-100)
 *   - radius : circle radius,   percent of frame width  (0-100)
 *
 * Internal keyframe (what the Konva stage renders): { x, y, width, height }
 *   - x/y     : top-left corner, percent of width / height
 *   - width   : square side, percent of width  = 2*radius
 *   - height  : square side, percent of height; chosen by the view so the
 *               pixel height equals the pixel width (a true square on screen).
 *
 * Internal <-> saved conversions here only use the width axis, so they need no
 * aspect-ratio knowledge:
 *   radius = width / 2
 *   cx     = x + width / 2           (percent of width)
 *   cy     = y + height / 2          (percent of height)
 *   x      = cx - radius
 *   width  = 2 * radius
 *   y/height are reconstructed on load from the stage aspect ratio so the box
 *   is square in pixels; see fromCircle() below.
 */

const sideHeightPctForSquare = (object, widthPct) => {
  // pixel width == pixel height  =>  widthPct*realW == heightPct*realH
  const wa = object?.workingArea;
  const realW = wa?.realWidth;
  const realH = wa?.realHeight;
  if (realW && realH) return (widthPct * realW) / realH;
  // Fallback before the stage is measured: assume already provided elsewhere.
  return widthPct;
};

/** circle (cx,cy,radius) -> internal square (x,y,width,height) */
const fromCircle = (object, kf) => {
  if (kf.radius === undefined) return kf; // already internal
  const widthPct = 2 * kf.radius;
  const heightPct = sideHeightPctForSquare(object, widthPct);
  const cx = kf.cx ?? 0;
  const cy = kf.cy ?? 0;
  const rest = { ...kf };
  delete rest.cx;
  delete rest.cy;
  delete rest.radius;
  return {
    ...rest,
    x: cx - widthPct / 2,
    y: cy - heightPct / 2,
    width: widthPct,
    height: heightPct,
    rotation: kf.rotation ?? 0,
  };
};

/** internal square (x,y,width,height) -> circle (cx,cy,radius) */
const toCircle = (kf) => {
  const widthPct = kf.width ?? 0;
  const heightPct = kf.height ?? widthPct;
  const radius = widthPct / 2;
  const cx = (kf.x ?? 0) + widthPct / 2;
  const cy = (kf.y ?? 0) + heightPct / 2;
  const rest = { ...kf };
  delete rest.x;
  delete rest.y;
  delete rest.width;
  delete rest.height;
  return { ...rest, cx, cy, radius };
};

const Model = types
  .model("VideoSquareCircleRegionModel", {
    type: "videosquarecircleregion",
  })
  .volatile(() => ({
    props: ["x", "y", "width", "height", "rotation"],
  }))
  .preProcessSnapshot((snapshot) => {
    // On load, snapshot.sequence (or value.sequence) holds circle keyframes.
    // Convert them to the internal square geometry the stage renders. The Video
    // object is resolved lazily, so we defer aspect-ratio-dependent height to
    // afterAttach; here we only do the width-axis conversion that is always safe.
    const seq = snapshot.sequence || snapshot.value?.sequence;
    if (!Array.isArray(seq)) return snapshot;
    const converted = seq.map((kf) => {
      if (kf.radius === undefined) return kf;
      const widthPct = 2 * kf.radius;
      const rest = { ...kf };
      delete rest.cx;
      delete rest.cy;
      delete rest.radius;
      return {
        ...rest,
        x: (kf.cx ?? 0) - widthPct / 2,
        y: kf.cy ?? 0, // provisional; afterAttach re-centers vertically
        width: widthPct,
        height: widthPct, // provisional; afterAttach fixes to a pixel-square
        _cy: kf.cy ?? 0, // keep original center to finalize once stage is known
        rotation: kf.rotation ?? 0,
      };
    });
    return { ...snapshot, sequence: converted };
  })
  .views((self) => ({
    getShape(frame) {
      let prev;
      let next;

      for (const item of self.sequence) {
        if (item.frame === frame) {
          return onlyProps(self.props, item);
        }

        if (item.frame > frame) {
          next = item;
          break;
        }
        prev = item;
      }

      if (!prev) return null;
      if (!next) return onlyProps(self.props, prev);

      return Object.fromEntries(self.props.map((prop) => [prop, interpolateProp(prev, next, frame, prop)]));
    },

    getVisibility() {
      return true;
    },
  }))
  .actions((self) => ({
    afterAttach() {
      // Finalize provisional vertical geometry now that the Video object (and
      // its working area) is resolvable, so each keyframe is a true pixel-square.
      if (!self.sequence?.length) return;
      let changed = false;
      const fixed = self.sequence.map((kf) => {
        if (kf._cy === undefined) return kf;
        changed = true;
        const widthPct = kf.width;
        const heightPct = sideHeightPctForSquare(self.object, widthPct);
        const rest = { ...kf };
        delete rest._cy;
        return { ...rest, y: kf._cy - heightPct / 2, height: heightPct };
      });
      if (changed) self.sequence = fixed;
    },

    /**
     * Keep every keyframe a pixel-square. A resize handle on the video stage
     * can change width and height independently (in their own axis percents);
     * we re-derive a single pixel side from the width axis and recompute the
     * matching height percent so the inscribed circle stays a true circle.
     */
    updateShape(data, frame) {
      const squared = { ...data };

      if (squared.width !== undefined || squared.height !== undefined) {
        const widthPct = Math.abs(squared.width ?? squared.height ?? 0);
        squared.width = widthPct;
        squared.height = sideHeightPctForSquare(self.object, widthPct);
      }

      const newItem = {
        ...squared,
        frame,
        enabled: true,
      };

      const kp = self.closestKeypoint(frame);
      const index = self.sequence.findIndex((item) => item.frame >= frame);

      if (index < 0) {
        self.sequence = [...self.sequence, newItem];
      } else {
        const keypoint = {
          ...(self.sequence[index] ?? {}),
          ...squared,
          enabled: kp?.enabled ?? true,
          frame,
        };

        self.sequence = [
          ...self.sequence.slice(0, index),
          keypoint,
          ...self.sequence.slice(index + (self.sequence[index].frame === frame)),
        ];
      }
    },

    /**
     * Save as circle keyframes: { frame, enabled, cx, cy, radius, time }.
     */
    serialize() {
      const { framerate, length: framesCount } = self.object;
      const duration = self.object?.ref?.current?.duration ?? 0;

      const value = {
        framesCount,
        duration,
        sequence: self.sequence.map((keyframe) => {
          const circle = toCircle(keyframe);
          // strip any internal scratch fields
          delete circle._cy;
          return { ...circle, time: keyframe.frame / framerate };
        }),
      };

      return { value };
    },
  }));

const VideoSquareCircleRegionModel = types.compose(
  "VideoSquareCircleRegionModel",
  RegionsMixin,
  VideoRegion,
  AreaMixin,
  NormalizationMixin,
  Model,
);

Registry.addRegionType(VideoSquareCircleRegionModel, "video", isVideoSquareCircleRegionValue);

export { VideoSquareCircleRegionModel, fromCircle, toCircle };
