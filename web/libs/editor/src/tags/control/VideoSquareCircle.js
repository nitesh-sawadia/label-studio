import { observer } from "mobx-react";
import { types } from "mobx-state-tree";

import Registry from "../../core/Registry";
import { guidGenerator } from "../../core/Helpers";
import ControlBase from "./Base";
import { AnnotationMixin } from "../../mixins/AnnotationMixin";
import { InteractivePromptMixin } from "../../mixins/InteractivePromptMixin";

/**
 * The `VideoSquareCircle` tag brings click-to-place, locked-square (with an
 * inscribed circle) object tracking to videos. It works with the `<Video/>`
 * tag and a sibling `<Labels/>` tag for class selection, mirroring how
 * `<VideoRectangle/>` is used.
 *
 * A single click on the frame places a square of a default size centered on
 * the click; the square can then be moved/resized across keyframes and stays
 * square, so the inscribed circle stays a true circle. Intermediate frames are
 * interpolated like any video region.
 *
 * Use with the following data types: video
 * @example
 * <View>
 *   <Video name="video" value="$video" />
 *   <VideoSquareCircle name="sc" toName="video" />
 *   <Labels name="videoLabels" toName="video">
 *     <Label value="Ball" background="#944BFF"/>
 *   </Labels>
 * </View>
 * @name VideoSquareCircle
 * @meta_title VideoSquareCircle Tag for Click-to-place Square+Circle Video Tracking
 * @meta_description Add click-to-place, resizable square (with inscribed circle) tracking regions to videos.
 * @param {string} name   Name of the element
 * @param {string} toName Name of the video element to control
 * @param {number=} [size=40] Default square side length in pixels on click
 */
const TagAttrs = types.model({
  toname: types.maybeNull(types.string),
  size: types.optional(types.string, "40"),
});

const ModelAttrs = types.model("VideoSquareCircleModel", {
  pid: types.optional(types.string, guidGenerator),
  type: "videosquarecircle",
});

const VideoSquareCircleModel = types.compose(
  "VideoSquareCircleModel",
  ControlBase,
  AnnotationMixin,
  ModelAttrs,
  TagAttrs,
  InteractivePromptMixin,
);

const HtxVideoSquareCircle = observer(() => {
  return null;
});

Registry.addTag("videosquarecircle", VideoSquareCircleModel, HtxVideoSquareCircle);

export { HtxVideoSquareCircle, VideoSquareCircleModel };
