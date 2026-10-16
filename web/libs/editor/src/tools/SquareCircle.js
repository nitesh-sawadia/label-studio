import { types } from "mobx-state-tree";

import BaseTool, { DEFAULT_DIMENSIONS } from "./Base";
import ToolMixin from "../mixins/Tool";
import { DrawingTool } from "../mixins/DrawingTool";
import { AnnotationMixin } from "../mixins/AnnotationMixin";
import { NodeViews } from "../components/Node/Node";

/**
 * SquareCircle tool — single click places a locked square (with an inscribed
 * circle rendered by the region) of a predefined default size, centered on the
 * click point. No drag: mirrors the KeyPoint tool's click-to-create pattern.
 */
const _Tool = types
  .model("SquareCircleTool", {
    group: "segmentation",
    shortcut: "tool:square-circle",
    smart: true,
  })
  .views((self) => ({
    get tagTypes() {
      return {
        stateTypes: "squarecirclelabels",
        controlTagTypes: ["squarecirclelabels", "squarecircle"],
      };
    },
    get defaultDimensions() {
      return DEFAULT_DIMENSIONS.squarecircle;
    },
    get viewTooltip() {
      return "Square with circle";
    },
    get iconComponent() {
      // Reuse the rectangle icon until a dedicated icon is added.
      return NodeViews.RectRegionModel.icon;
    },
  }))
  .actions((self) => ({
    clickEv(ev, [x, y]) {
      if (!self.canStartDrawing()) return;
      if (!self.isAllowedInteraction(ev)) return;

      const c = self.control;

      if (c.type === "squarecirclelabels" && !c.isSelected) return;
      if (self.annotation.isReadOnly()) return;

      // Default side length is configured in screen pixels; convert to the
      // stage's internal relative units, then center the square on the click.
      const side = self.obj.canvasToInternalX(self.defaultDimensions.size);
      const half = side / 2;

      const region = self.createRegion({
        x: x - half,
        y: y - half,
        width: side,
        height: side,
        rotation: 0,
        dynamic: self.dynamic,
      });

      region.setDrawing(false);
      region.notifyDrawingFinished();
    },
  }));

const SquareCircle = types.compose(_Tool.name, ToolMixin, BaseTool, DrawingTool, _Tool);

export { SquareCircle };
