import chroma from "chroma-js";
import { clamp } from "@humansignal/core/lib/utils/lodash-replacements";
import { observer } from "mobx-react";
import { getParentOfType } from "mobx-state-tree";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Layer, Rect, Stage, Transformer } from "react-konva";
import Constants from "../../../core/Constants";
import { Annotation } from "../../../stores/Annotation/Annotation";
import { fixMobxObserve } from "../../../utils/utilities";
import { Rectangle } from "./Rectangle";
import { SquareCircle } from "./SquareCircle";
import { VideoVectorShape } from "./VideoVector";
import { createBoundingBoxGetter, createOnDragMoveHandler } from "./TransformTools";
import ToolsManager from "../../../tools/Manager";

export const MIN_SIZE = 5;

/**
 * BROS-1527: VideoVectorTool is auto-selected whenever VideoVectorLabels exists.
 * Only consume empty-stage events when the vector tool is actively drawing/resuming
 * or when it can actually start (correct control + label). Otherwise fall through to
 * VideoRectangle drag creation.
 */
export const shouldRouteToVectorTool = (vectorTool) => {
  if (!vectorTool) return false;
  if (vectorTool.isDrawing || vectorTool.canResumeDrawing) return true;
  return typeof vectorTool.canStartDrawing === "function" ? vectorTool.canStartDrawing() : true;
};

const SelectionRect = (props) => {
  return (
    <>
      <Rect {...props} strokeWidth={2} stroke="#fff" />
      <Rect {...props} fill={chroma("#617ADA").alpha(0.1).css()} strokeWidth={2} stroke="#617ADA" dash={[2, 2]} />
    </>
  );
};

const VideoRegionsPure = ({
  item,
  regions,
  width,
  height,
  zoom,
  workingArea: videoDimensions,
  locked = false,
  allowRegionsOutsideWorkingArea = true,
  pan = { x: 0, y: 0 },
  stageRef,
  currentFrame, // Add currentFrame prop to force re-renders when frame changes
}) => {
  const [newRegion, setNewRegion] = useState();
  const [isDrawing, setDrawingMode] = useState(false);

  const selected = regions.filter((reg) => {
    return (reg.selected || reg.inSelection) && !reg.hidden && !reg.isReadOnly() && reg.isInLifespan(item.frame);
  });
  const listenToEvents = !locked;

  // if region is not in lifespan, it's not rendered,
  // so we observe all the sequences to rerender transformer
  regions.map((reg) => fixMobxObserve(reg.sequence));

  const workinAreaCoordinates = useMemo(() => {
    const resultWidth = videoDimensions.width * zoom;
    const resultHeight = videoDimensions.height * zoom;
    const overshotX = Math.abs(pan.x) >= Math.abs((width - resultWidth) / 2);
    const overshotY = Math.abs(pan.y) >= Math.abs((height - resultHeight) / 2);
    const panXDirection = pan.x > 0 ? 1 : -1;
    const panYDirection = pan.y > 0 ? 1 : -1;
    const overshotXAmmount = (Math.abs(pan.x) - Math.abs((width - resultWidth) / 2)) * panXDirection;
    const overshotYAmmount = (Math.abs(pan.y) - Math.abs((height - resultHeight) / 2)) * panYDirection;
    const edgeZoomOffestX = overshotX ? overshotXAmmount : 0;
    const edgeZoomOffestY = overshotY ? overshotYAmmount : 0;
    const offsetLeft = (width - resultWidth) / 2 + pan.x - edgeZoomOffestX;
    const offsetTop = (height - resultHeight) / 2 + pan.y - edgeZoomOffestY;

    return {
      width: resultWidth,
      height: resultHeight,
      x: offsetLeft,
      y: offsetTop,
      scale: zoom,
      realWidth: videoDimensions.width,
      realHeight: videoDimensions.height,
    };
  }, [pan.x, pan.y, zoom, videoDimensions, width, height]);

  useEffect(() => {
    if (stageRef.current) {
      item.setStageRef(stageRef.current);
    }
  });

  useEffect(() => {
    item.setWorkingArea(workinAreaCoordinates);
  }, [workinAreaCoordinates]);

  const layerProps = useMemo(
    () => ({
      width: workinAreaCoordinates.width,
      height: workinAreaCoordinates.height,
      scaleX: zoom,
      scaleY: zoom,
      position: {
        x: workinAreaCoordinates.x,
        y: workinAreaCoordinates.y,
      },
    }),
    [workinAreaCoordinates, zoom],
  );

  const normalizeMouseOffsets = useCallback(
    (x, y) => {
      const { x: offsetLeft, y: offsetTop } = workinAreaCoordinates;

      return {
        x: (x - offsetLeft) / zoom,
        y: (y - offsetTop) / zoom,
      };
    },
    [workinAreaCoordinates, zoom],
  );

  useEffect(() => {
    if (!isDrawing && newRegion) {
      const { width: waWidth, height: waHeight } = videoDimensions;
      let x = (newRegion.x / waWidth) * 100;
      let y = (newRegion.y / waHeight) * 100;
      let width = (newRegion.width / waWidth) * 100;
      let height = (newRegion.height / waHeight) * 100;

      // deal with negative sizes
      if (width < 0) {
        width *= -1;
        x -= width;
      }
      if (height < 0) {
        height *= -1;
        y -= height;
      }

      const fixedRegion = { x, y, width, height };

      // When a VideoSquareCircle control is active, a drag produces a square
      // (the inscribed circle is derived). Click placement is handled in
      // handleMouseUp; this covers the drag-to-size case.
      if (item.videoSquareCircleControl) {
        item.addVideoSquareCircleRegion(fixedRegion);
      } else {
        item.addVideoRegion(fixedRegion);
      }
      setNewRegion(null);
    }
  }, [isDrawing, workinAreaCoordinates, videoDimensions]);

  const inBounds = (x, y) => {
    if (allowRegionsOutsideWorkingArea) return true;

    return x > 0 && y > 0 && x < workinAreaCoordinates.realWidth && y < workinAreaCoordinates.realHeight;
  };

  const limitCoordinates = ({ x, y }) => {
    if (allowRegionsOutsideWorkingArea) return { x, y };

    return {
      x: clamp(x, 0, workinAreaCoordinates.realWidth),
      y: clamp(y, 0, workinAreaCoordinates.realHeight),
    };
  };

  const getVectorTool = useCallback(() => {
    try {
      const manager = ToolsManager.getInstance({ name: item.name });
      const selected = manager?.findSelectedTool();
      const drawing = manager?.findDrawingTool();

      if (drawing?.toolName === "VideoVectorTool") return drawing;
      if (selected?.toolName === "VideoVectorTool") return selected;
    } catch {
      // No tool manager available
    }
    return null;
  }, [item.name]);

  const handleMouseDown = (e) => {
    if (item.annotation?.isReadOnly()) return;

    const vectorTool = getVectorTool();

    if (vectorTool?.isDrawing || vectorTool?.canResumeDrawing) {
      const { x, y } = limitCoordinates(normalizeMouseOffsets(e.evt.offsetX, e.evt.offsetY));

      vectorTool.event("mousedown", e.evt, [x, y]);
      return;
    }

    if (e.target !== stageRef.current) return;

    const { x, y } = limitCoordinates(normalizeMouseOffsets(e.evt.offsetX, e.evt.offsetY));
    const isInBounds = inBounds(x, y);

    if (!isInBounds) return;

    if (shouldRouteToVectorTool(vectorTool)) {
      vectorTool.event("mousedown", e.evt, [x, y]);
      return;
    }

    item.annotation.unselectAreas();
    setNewRegion({ x, y, width: 0, height: 0 });
    setDrawingMode(true);
  };

  const handleMouseMove = (e) => {
    const vectorTool = getVectorTool();

    if (vectorTool?.isDrawing) {
      const { x, y } = limitCoordinates(normalizeMouseOffsets(e.evt.offsetX, e.evt.offsetY));

      vectorTool.event("mousemove", e.evt, [x, y]);
      return;
    }

    if (!isDrawing || item.annotation?.isReadOnly()) return false;

    const { x, y } = limitCoordinates(normalizeMouseOffsets(e.evt.offsetX, e.evt.offsetY));

    setNewRegion((region) => ({
      ...region,
      width: x - region.x,
      height: y - region.y,
    }));
  };

  const getSquareCircleControl = useCallback(() => {
    const control = item.videoSquareCircleControl;
    if (!control) return null;
    // Only treat as active when it's the selected control (or it's the only
    // video control present). Mirrors how the stage routes to the vector tool.
    return control;
  }, [item]);

  const handleMouseUp = (e) => {
    const vectorTool = getVectorTool();

    if (vectorTool?.isDrawing) {
      const { x, y } = limitCoordinates(normalizeMouseOffsets(e.evt.offsetX, e.evt.offsetY));

      vectorTool.event("mouseup", e.evt, [x, y]);
      return;
    }

    if (!isDrawing || item.annotation?.isReadOnly()) return false;

    const { x, y } = limitCoordinates(normalizeMouseOffsets(e.evt.offsetX, e.evt.offsetY));

    if (Math.abs(newRegion.x - x) < MIN_SIZE && Math.abs(newRegion.y - y) < MIN_SIZE) {
      // A click (no meaningful drag). If a VideoSquareCircle control is active,
      // place a default-size square centered on the click instead of
      // discarding the gesture.
      const scControl = getSquareCircleControl();

      if (scControl) {
        const { width: waWidth, height: waHeight } = videoDimensions;
        const sizePx = Number(scControl.size) || 40;
        // We want a true SQUARE in pixels. width% and height% map to different
        // pixel sizes because the frame is not square (waWidth != waHeight), so
        // convert the same pixel side independently per axis. In the view,
        // widthPct*waWidth == heightPct*waHeight == sizePx -> equal pixels.
        const widthPct = (sizePx / waWidth) * 100;
        const heightPct = (sizePx / waHeight) * 100;
        const cx = (newRegion.x / waWidth) * 100;
        const cy = (newRegion.y / waHeight) * 100;

        item.annotation.unselectAreas();
        item.addVideoSquareCircleRegion({
          x: cx - widthPct / 2,
          y: cy - heightPct / 2,
          width: widthPct,
          height: heightPct,
        });
      }
      setNewRegion(null);
    } else {
      setNewRegion((region) => ({ ...region, width: x - region.x, height: y - region.y }));
    }
    setDrawingMode(false);
  };

  const handleClick = useCallback(
    (e) => {
      const vectorTool = getVectorTool();

      if (shouldRouteToVectorTool(vectorTool)) {
        const { x, y } = limitCoordinates(normalizeMouseOffsets(e.evt.offsetX, e.evt.offsetY));

        vectorTool.event("click", e.evt, [x, y]);
      }
    },
    [getVectorTool, limitCoordinates, normalizeMouseOffsets],
  );

  const initTransform = (tr) => {
    if (!tr) return;

    const stage = tr.getStage();
    // @todo not an obvious way to not render transformer for hidden regions
    // @todo could it be rewritten to usual react way?
    const shapes = selected.map((shape) => stage.findOne(`#${shape.id}`)).filter(Boolean);

    tr.nodes(shapes);
    tr.getLayer().batchDraw();
  };

  const eventHandlers = listenToEvents
    ? {
        onMouseDown: handleMouseDown,
        onMouseMove: handleMouseMove,
        onMouseUp: handleMouseUp,
        onClick: handleClick,
      }
    : {};

  return (
    <Stage
      ref={stageRef}
      width={width}
      height={height}
      style={{ position: "absolute", zIndex: 1 }}
      listening={listenToEvents}
      {...eventHandlers}
    >
      <Layer {...layerProps}>
        <RegionsLayer
          regions={regions}
          item={item}
          layerProps={layerProps}
          locked={locked}
          isDrawing={isDrawing}
          workinAreaCoordinates={workinAreaCoordinates}
          onDragMove={createOnDragMoveHandler(workinAreaCoordinates, !allowRegionsOutsideWorkingArea)}
          stageRef={stageRef}
          currentFrame={currentFrame}
          allowRegionsOutsideWorkingArea={allowRegionsOutsideWorkingArea}
        />
      </Layer>
      {!item.annotation?.isReadOnly() && isDrawing ? (
        <Layer {...layerProps}>
          <SelectionRect {...newRegion} />
        </Layer>
      ) : null}
      {!item.annotation?.isReadOnly() && selected?.length > 0 ? (
        <Layer>
          <Transformer
            ref={initTransform}
            keepRatio={false}
            ignoreStroke
            flipEnabled={false}
            boundBoxFunc={createBoundingBoxGetter(workinAreaCoordinates, !allowRegionsOutsideWorkingArea)}
            onDragMove={createOnDragMoveHandler(workinAreaCoordinates, !allowRegionsOutsideWorkingArea)}
          />
        </Layer>
      ) : null}
    </Stage>
  );
};

const RegionsLayer = observer(
  ({
    regions,
    item,
    locked,
    isDrawing,
    workinAreaCoordinates,
    stageRef,
    onDragMove,
    currentFrame,
    allowRegionsOutsideWorkingArea,
  }) => {
    // Use currentFrame prop (from React state) to ensure regions update during fast scrubbing
    // Since item.frame is volatile, React state triggers re-renders
    const frame = currentFrame ?? item.frame;

    return (
      <>
        {regions.map((reg) => (
          <Shape
            id={reg.id}
            key={reg.id}
            reg={reg}
            item={item}
            workingArea={workinAreaCoordinates}
            draggable={!reg.isReadOnly() && !isDrawing && !locked}
            selected={reg.selected || reg.inSelection}
            listening={!reg.locked && !reg.hidden}
            stageRef={stageRef}
            onDragMove={onDragMove}
            currentFrame={frame}
            allowRegionsOutsideWorkingArea={allowRegionsOutsideWorkingArea}
          />
        ))}
      </>
    );
  },
);

const Shape = observer(({ id, reg, item, stageRef, currentFrame, allowRegionsOutsideWorkingArea, ...props }) => {
  const frame = currentFrame ?? item.frame;
  const box = reg.getShape(frame);

  if (!reg.isInLifespan(frame) || !box) return null;

  const handleClick = (e) => {
    const annotation = getParentOfType(reg, Annotation);

    if (annotation && annotation.isLinkingMode) {
      stageRef.current.container().style.cursor = Constants.DEFAULT_CURSOR;
    }

    reg.setHighlight(false);
    reg.onClickRegion(e);
  };

  if (reg.type === "videovectorregion") {
    return (
      <VideoVectorShape
        id={id}
        reg={reg}
        box={box}
        frame={frame}
        onClick={handleClick}
        allowOutsideBounds={allowRegionsOutsideWorkingArea}
        {...props}
      />
    );
  }

  if (reg.type === "videosquarecircleregion") {
    return (
      <SquareCircle id={id} reg={reg} box={box} frame={frame} onClick={handleClick} {...props} />
    );
  }

  return <Rectangle id={id} reg={reg} box={box} frame={frame} onClick={handleClick} {...props} />;
});

export const VideoRegions = observer(VideoRegionsPure);
