import { types } from "mobx-state-tree";

import ControlBase from "./Base";
import Registry from "../../core/Registry";
import { customTypes } from "../../core/CustomTypes";
import { AnnotationMixin } from "../../mixins/AnnotationMixin";
import SeparatedControlMixin from "../../mixins/SeparatedControlMixin";
import { ToolManagerMixin } from "../../mixins/ToolManagerMixin";

/**
 * The `SquareCircle` tag adds a locked square with an inscribed circle to an
 * image on a single click. The square is placed at a predefined default size
 * centered on the click point, and can then be moved and resized; it stays
 * square (so the inscribed circle stays a true circle). Use it when you have
 * only one class and don't need label selection.
 *
 * Use with the following data types: image.
 *
 * @example
 * <View>
 *   <SquareCircle name="sc-1" toName="img-1" />
 *   <Image name="img-1" value="$img" />
 * </View>
 * @name SquareCircle
 * @meta_title SquareCircle Tag for Click-to-place Square with Inscribed Circle
 * @meta_description Add a click-to-place, resizable square (with an inscribed circle) region to images.
 * @param {string} name                   - Name of the element
 * @param {string} toName                 - Name of the image to label
 * @param {number=} [size=40]             - Default square side length in pixels on click
 * @param {float=} [opacity=0.2]          - Opacity of the shape
 * @param {string=} [fillColor]           - Fill color in hexadecimal
 * @param {string=} [strokeColor=#f48a42] - Stroke color in hexadecimal
 * @param {number=} [strokeWidth=1]       - Width of the stroke
 * @param {boolean=} [canRotate=true]     - Whether to show or hide the rotation control
 * @param {boolean} [smart]               - Show smart tool for interactive pre-annotations
 * @param {boolean} [smartOnly]           - Only show smart tool for interactive pre-annotations
 * @param {pixel|none} [snap=none]        - Snap to image pixels
 */
const TagAttrs = types.model({
  toname: types.maybeNull(types.string),

  size: types.optional(types.string, "40"),
  opacity: types.optional(customTypes.range(), "0.2"),
  fillcolor: types.optional(customTypes.color, "#f48a42"),

  strokewidth: types.optional(types.string, "1"),
  strokecolor: types.optional(customTypes.color, "#f48a42"),
  fillopacity: types.maybeNull(customTypes.range()),

  canrotate: types.optional(types.boolean, true),
  snap: types.optional(types.string, "none"),
});

const Model = types
  .model({
    type: "squarecircle",
  })
  .volatile(() => ({
    toolNames: ["SquareCircle"],
  }));

const SquareCircleModel = types.compose(
  "SquareCircleModel",
  ControlBase,
  AnnotationMixin,
  SeparatedControlMixin,
  TagAttrs,
  Model,
  ToolManagerMixin,
);

const HtxView = () => {
  return null;
};

Registry.addTag("squarecircle", SquareCircleModel, HtxView);

export { HtxView, SquareCircleModel };
