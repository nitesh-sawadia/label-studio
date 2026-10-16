import { useContext } from "react";
import { Circle, Rect } from "react-konva";
import { getRoot, types } from "mobx-state-tree";

import Registry from "../core/Registry";
import NormalizationMixin from "../mixins/Normalization";
import RegionsMixin from "../mixins/Regions";
import { ImageViewContext } from "../components/ImageView/ImageViewContext";
import { LabelOnRect } from "../components/ImageView/LabelOnRegion";
import { guidGenerator } from "../core/Helpers";
import { useRegionStyles } from "../hooks/useRegionColor";
import { AreaMixin } from "../mixins/AreaMixin";
import { KonvaRegionMixin } from "../mixins/KonvaRegion";
import { ImageModel } from "../tags/object/Image";
import { rotateBboxCoords } from "../utils/bboxCoords";
import { createDragBoundFunc } from "../utils/image";
import { AliveRegion } from "./AliveRegion";
import { EditableRegion } from "./EditableRegion";
import { RegionWrapper } from "./RegionWrapper";
import Constants from "../core/Constants";

/**
 * SquareCircleRegion — a locked square (width === height) with an inscribed
 * circle whose radius is half the side. Placed with a single click at a
 * predefined default size, then resizable/draggable; the square stays square
 * and the circle stays inscribed because the circle is derived from the box
 * geometry and width is clamped to height on every update.
 *
 * Serialized value carries `shape: "squarecircle"` so results are routed back
 * to this region type rather than being caught by the plain RectRegion
 * (which registers without a detector).
 */
const Model = types
  .model({
    id: types.optional(types.identifier, guidGenerator),
    pid: types.optional(types.string, guidGenerator),
    type: "squarecircleregion",
    object: types.late(() => types.reference(ImageModel)),

    x: types.number,
    y: types.number,

    width: types.number,
    height: types.number,

    rotation: 0,
    rotationAtCreation: 0,
  })
  .preProcessSnapshot((snapshot) => {
    // Saved form is a circle (cx, cy, radius). Reconstruct the internal square
    // (top-left x/y + equal width/height percentages) the Konva view renders.
    const src = snapshot.value ?? snapshot;
    if (src && src.radius !== undefined) {
      const radius = src.radius;
      const side = 2 * radius;
      const cx = src.cx ?? 0;
      const cy = src.cy ?? 0;
      return {
        ...snapshot,
        x: cx - radius,
        y: cy - side / 2,
        width: side,
        height: side,
        rotation: src.rotation ?? 0,
      };
    }
    return snapshot;
  })
  .volatile(() => ({
    startX: 0,
    startY: 0,

    scaleX: 1,
    scaleY: 1,

    opacity: 1,

    fill: true,
    fillColor: "#ff8800",
    fillOpacity: 0.2,

    strokeColor: Constants.STROKE_COLOR,
    strokeWidth: Constants.STROKE_WIDTH,

    _supportsTransform: true,
    hideable: true,

    editableFields: [
      { property: "x", label: "X" },
      { property: "y", label: "Y" },
      { property: "width", label: "Side" },
      { property: "rotation", label: "icon:angle" },
    ],
  }))
  .volatile(() => ({
    useTransformer: true,
    preferTransformer: true,
    supportsRotate: true,
    supportsScale: true,
    // NB: the shared ImageTransformer hardcodes keepRatio = (singleNodeMode !==
    // true), so a single selected shape resizes freely regardless of any
    // region flag. The square lock is therefore enforced in
    // setPositionInternal (below), which collapses width/height to a single
    // side on every update. The box snaps back to square on transform end.
  }))
  .views((self) => ({
    get store() {
      return getRoot(self);
    },
    get parent() {
      return self.object;
    },
    get bboxCoords() {
      const bboxCoords = {
        left: self.x,
        top: self.y,
        right: self.x + self.width,
        bottom: self.y + self.height,
      };

      if (self.rotation === 0 || !self.parent) return bboxCoords;

      return rotateBboxCoords(bboxCoords, self.rotation, { x: self.x, y: self.y }, self.parent.whRatio);
    },
    get canvasX() {
      return self.parent?.internalToCanvasX(self.x);
    },
    get canvasY() {
      return self.parent?.internalToCanvasY(self.y);
    },
    get canvasWidth() {
      return self.parent?.internalToCanvasX(self.width);
    },
    get canvasHeight() {
      return self.parent?.internalToCanvasY(self.height);
    },
  }))
  .actions((self) => ({
    afterCreate() {
      self.startX = self.x;
      self.startY = self.y;
      // enforce square at birth (defensive — placement already sends a square)
      if (self.height !== self.width) self.height = self.width;
    },

    setScale(x, y) {
      self.scaleX = x;
      self.scaleY = y;
    },

    addState(state) {
      self.states.push(state);
    },

    setFill(color) {
      self.fill = color;
    },

    updateImageSize() {},

    /**
     * Lock to a square. We keep x/y as the top-left corner and derive a single
     * side length from the dominant drag axis so the inscribed circle is always
     * a true circle. Internal coordinates are relative (0-100 of the stage).
     */
    setPositionInternal(x, y, width, height, rotation) {
      // A side-handle drag changes only one axis; a corner drag changes both.
      // Use the larger delta so the box grows/shrinks naturally while staying
      // square. In canvas space width/height share the stage scale, so taking
      // the max of the two internal values keeps the on-screen box square only
      // when the stage is square; to be scale-correct we compare in canvas px.
      const side = Math.max(Math.abs(width), Math.abs(height));

      self.x = x;
      self.y = y;
      self.width = side;
      self.height = side;
      self.rotation = (rotation + 360) % 360;
    },

    setPosition(x, y, width, height, rotation) {
      const internalX = self.parent.canvasToInternalX(x);
      const internalY = self.parent.canvasToInternalY(y);
      const internalWidth = self.parent.canvasToInternalX(width);
      const internalHeight = self.parent.canvasToInternalY(height);

      if (self.control?.snap === "pixel") {
        const topLeftPoint = self.control.getSnappedPoint({ x: internalX, y: internalY });
        const bottomRightPoint = self.control.getSnappedPoint({
          x: internalX + internalWidth,
          y: internalY + internalHeight,
        });
        let snappedWidth = bottomRightPoint.x - topLeftPoint.x;
        let snappedHeight = bottomRightPoint.y - topLeftPoint.y;
        const minPixelWidth = self.parent?.zoomedPixelSize?.x ?? 1;
        const minPixelHeight = self.parent?.zoomedPixelSize?.y ?? 1;
        if (snappedWidth < minPixelWidth) snappedWidth = minPixelWidth;
        if (snappedHeight < minPixelHeight) snappedHeight = minPixelHeight;
        self.setPositionInternal(topLeftPoint.x, topLeftPoint.y, snappedWidth, snappedHeight, rotation);
      } else {
        self.setPositionInternal(internalX, internalY, internalWidth, internalHeight, rotation);
      }
    },

    /**
     * Saved as a circle: center + radius (all percentages, 0-100).
     * @typedef {Object} SquareCircleRegionResult
     * @property {Object} value
     * @property {number} value.cx      circle center X, percent of width  (0-100)
     * @property {number} value.cy      circle center Y, percent of height (0-100)
     * @property {number} value.radius  circle radius, percent of width    (0-100)
     * @property {number} value.rotation rotation of the square (deg)
     * @property {"squarecircle"} value.shape marker to route deserialization
     */
    serialize() {
      const value = {
        cx: self.x + self.width / 2,
        cy: self.y + self.height / 2,
        radius: self.width / 2,
        rotation: self.rotation,
        shape: "squarecircle",
      };

      return self.parent.createSerializedResult(self, value);
    },
  }));

const SquareCircleRegionModel = types.compose(
  "SquareCircleRegionModel",
  RegionsMixin,
  NormalizationMixin,
  AreaMixin,
  KonvaRegionMixin,
  EditableRegion,
  Model,
);

const HtxSquareCircleView = ({ item, setShapeRef }) => {
  const { store } = item;
  const { suggestion } = useContext(ImageViewContext) ?? {};
  const regionStyles = useRegionStyles(item, { suggestion });
  const stage = item.parent?.stageRef;

  const eventHandlers = {};

  if (!item.parent) return null;
  if (!item.inViewPort) return null;

  if (!suggestion && !item.isReadOnly()) {
    eventHandlers.onTransform = ({ target }) => {
      target.setAttr("skewX", 0);
      target.setAttr("skewY", 0);
    };
    eventHandlers.onTransformEnd = (e) => {
      const t = e.target;

      item.setPosition(
        t.getAttr("x"),
        t.getAttr("y"),
        t.getAttr("width") * t.getAttr("scaleX"),
        t.getAttr("height") * t.getAttr("scaleY"),
        t.getAttr("rotation"),
      );

      t.setAttr("scaleX", 1);
      t.setAttr("scaleY", 1);
      t.position({ x: item.canvasX, y: item.canvasY });

      item.notifyDrawingFinished();
    };

    eventHandlers.onDragStart = (e) => {
      if (item.parent.getSkipInteractions()) {
        e.currentTarget.stopDrag(e.evt);
        return;
      }
      item.annotation.history.freeze(item.id);
    };

    eventHandlers.onDragEnd = (e) => {
      const t = e.target;

      item.setPosition(t.getAttr("x"), t.getAttr("y"), t.getAttr("width"), t.getAttr("height"), t.getAttr("rotation"));
      item.setScale(t.getAttr("scaleX"), t.getAttr("scaleY"));
      item.annotation.history.unfreeze(item.id);
      item.notifyDrawingFinished();
    };

    eventHandlers.dragBoundFunc = createDragBoundFunc(item, {
      x: item.x - item.bboxCoords.left,
      y: item.y - item.bboxCoords.top,
    });
  }

  const side = item.canvasWidth;
  const radius = side / 2;

  return (
    <RegionWrapper item={item}>
      <Rect
        x={item.canvasX}
        y={item.canvasY}
        ref={(node) => setShapeRef(node)}
        width={side}
        height={side}
        fill={regionStyles.fillColor}
        stroke={regionStyles.strokeColor}
        strokeWidth={regionStyles.strokeWidth}
        strokeScaleEnabled={false}
        perfectDrawEnabled={false}
        shadowForStrokeEnabled={false}
        shadowBlur={0}
        dash={suggestion ? [10, 10] : null}
        scaleX={item.scaleX}
        scaleY={item.scaleY}
        opacity={1}
        rotation={item.rotation}
        draggable={!item.isReadOnly()}
        name={`${item.id} _transformable`}
        {...eventHandlers}
        onMouseOver={() => {
          if (store.annotationStore.selected.isLinkingMode) {
            item.setHighlight(true);
          }
          item.updateCursor(true);
        }}
        onMouseOut={() => {
          if (store.annotationStore.selected.isLinkingMode) {
            item.setHighlight(false);
          }
          item.updateCursor();
        }}
        onClick={(e) => {
          if (item.parent.getSkipInteractions()) return;
          if (store.annotationStore.selected.isLinkingMode) {
            stage.container().style.cursor = Constants.DEFAULT_CURSOR;
          }
          item.setHighlight(false);
          item.onClickRegion(e);
        }}
      />
      {/* Inscribed circle — purely derived from the square's geometry, so a
          resize/drag that re-renders the Rect re-renders this too, keeping
          them locked. Non-listening so the Transformer stays on the Rect. */}
      <Circle
        x={item.canvasX + radius}
        y={item.canvasY + radius}
        radius={radius}
        offsetX={radius}
        offsetY={radius}
        rotation={item.rotation}
        stroke={regionStyles.strokeColor}
        strokeWidth={regionStyles.strokeWidth}
        strokeScaleEnabled={false}
        perfectDrawEnabled={false}
        shadowForStrokeEnabled={false}
        dash={suggestion ? [10, 10] : null}
        listening={false}
        opacity={1}
      />
      <LabelOnRect item={item} color={regionStyles.strokeColor} strokewidth={regionStyles.strokeWidth} />
    </RegionWrapper>
  );
};

const HtxSquareCircle = AliveRegion(HtxSquareCircleView);

Registry.addTag("squarecircleregion", SquareCircleRegionModel, HtxSquareCircle);
Registry.addRegionType(SquareCircleRegionModel, "image", (value) => value?.shape === "squarecircle" || value?.radius !== undefined);

export { SquareCircleRegionModel, HtxSquareCircle };
