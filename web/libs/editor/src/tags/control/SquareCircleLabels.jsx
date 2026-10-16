import { observer } from "mobx-react";
import { types } from "mobx-state-tree";

import LabelMixin from "../../mixins/LabelMixin";
import Registry from "../../core/Registry";
import SelectedModelMixin from "../../mixins/SelectedModel";
import Types from "../../core/Types";
import { HtxLabels, LabelsModel } from "./Labels/Labels";
import { SquareCircleModel } from "./SquareCircle";
import ControlBase from "./Base";

/**
 * The `SquareCircleLabels` tag creates labeled square-with-inscribed-circle
 * regions on images. A single click places a locked square of a predefined
 * size at the click point, carrying the selected label; the shape can then be
 * moved and resized while staying square.
 *
 * Use with the following data types: image.
 * @example
 * <View>
 *   <SquareCircleLabels name="sc-1" toName="img-1">
 *     <Label value="Ball" />
 *     <Label value="Head" />
 *   </SquareCircleLabels>
 *   <Image name="img-1" value="$img" />
 * </View>
 * @name SquareCircleLabels
 * @regions SquareCircleRegion
 * @meta_title SquareCircleLabels Tag for Labeled Square+Circle Regions
 * @meta_description Customize Label Studio with the SquareCircleLabels tag to add labeled, click-to-place square (with inscribed circle) regions to images.
 * @param {string} name                   - Name of the element
 * @param {string} toName                 - Name of the image to label
 * @param {single|multiple=} [choice=single] - Configure whether you can select one or multiple labels
 * @param {number} [maxUsages]            - Maximum number of times a label can be used per task
 * @param {boolean} [showInline=true]     - Show labels in the same visual line
 * @param {number=} [size=40]             - Default square side length in pixels on click
 * @param {float=} [opacity=0.2]          - Opacity of the shape
 * @param {string=} [fillColor]           - Fill color in hexadecimal
 * @param {string=} [strokeColor=#f48a42] - Stroke color in hexadecimal
 * @param {number=} [strokeWidth=1]       - Width of the stroke
 * @param {boolean=} [canRotate=true]     - Whether to show or hide the rotation control
 * @param {pixel|none} [snap=none]        - Snap to image pixels
 */

const Validation = types.model({
  controlledTags: Types.unionTag(["Image"]),
});

const ModelAttrs = types
  .model("SquareCircleLabelsModel", {
    type: "squarecirclelabels",
    children: Types.unionArray(["label", "header", "view", "hypertext"]),
  })
  .views((self) => ({
    get hasStates() {
      const states = self.states();

      return states && states.length > 0;
    },
  }));

const Composition = types.compose(
  ControlBase,
  LabelsModel,
  ModelAttrs,
  SquareCircleModel,
  Validation,
  LabelMixin,
  SelectedModelMixin.props({ _child: "LabelModel" }),
);

const SquareCircleLabelsModel = types.compose("SquareCircleLabelsModel", Composition);

const HtxSquareCircleLabels = observer(({ item }) => {
  return <HtxLabels item={item} />;
});

Registry.addTag("squarecirclelabels", SquareCircleLabelsModel, HtxSquareCircleLabels);

export { HtxSquareCircleLabels, SquareCircleLabelsModel };
