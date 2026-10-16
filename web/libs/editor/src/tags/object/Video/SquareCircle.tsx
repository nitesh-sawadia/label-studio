import type { KonvaEventObject } from "konva/lib/Node";
import { observer } from "mobx-react";
import { type FC, useMemo } from "react";
import { Circle, Group, Rect } from "react-konva";
import { useRegionStyles } from "../../../hooks/useRegionColor";
import { getNodeAbsoluteDimensions, normalizeNodeDimentions } from "./tools";
import type { WorkingArea } from "./types";
import { LabelOnVideoBbox } from "../../../components/ImageView/LabelOnRegion";

type RectPropsExtend = typeof Rect;

interface SquareCircleProps extends RectPropsExtend {
  id: string;
  reg: any;
  frame: number;
  selected: boolean;
  draggable: boolean;
  listening: boolean;
  box: { x: number; y: number; width: number; height: number; rotation: number };
  workingArea: WorkingArea;
  onDragMove: (e: KonvaEventObject<DragEvent>) => void;
}

const SquareCirclePure: FC<SquareCircleProps> = ({
  id,
  reg,
  box,
  frame,
  workingArea,
  selected,
  draggable,
  listening,
  onDragMove,
  ...rest
}) => {
  const style = useRegionStyles(reg, { includeFill: true });

  const { realWidth: waWidth, realHeight: waHeight, scale: waScale } = workingArea;

  // The region stores width as %-of-width and height as the %-of-height that
  // yields an equal PIXEL side (a true square on screen). So convert each axis
  // with its own working-area dimension — do NOT re-equalize the percentages.
  const newBox = useMemo(
    () => ({
      x: (box.x * waWidth) / 100,
      y: (box.y * waHeight) / 100,
      width: (box.width * waWidth) / 100,
      height: (box.height * waHeight) / 100,
      rotation: box.rotation,
    }),
    [box, waWidth, waHeight],
  );

  const onDimensionUpdate = (e: KonvaEventObject<Event>) => {
    const node = e.target;

    if (e.type === "dragmove") onDragMove(e as KonvaEventObject<DragEvent>);

    reg.updateShape(getNodeAbsoluteDimensions(node, workingArea), frame);
  };

  const onTransform = (e: KonvaEventObject<Event>) => {
    normalizeNodeDimentions(e.target, "rect");
  };

  // Pixel width == pixel height (true square), so radius is half the side.
  const radius = newBox.width / 2;
  const centerX = newBox.x + newBox.width / 2;
  const centerY = newBox.y + newBox.height / 2;

  return (
    <Group>
      <LabelOnVideoBbox
        reg={reg}
        box={newBox}
        scale={waScale}
        color={style.strokeColor}
        strokeWidth={style.strokeWidth}
        adjacent
      />
      <Rect
        id={id}
        {...newBox}
        fill={style.fillColor ?? "#fff"}
        stroke={style.strokeColor}
        strokeScaleEnabled={false}
        selected={selected}
        draggable={draggable}
        listening={listening}
        opacity={reg.hidden ? 0 : 1}
        onTransform={onTransform}
        onTransformEnd={onDimensionUpdate}
        onDragMove={onDimensionUpdate}
        onDragEnd={onDimensionUpdate}
        {...rest}
      />
      {/* Derived inscribed circle. For a Konva Circle, x/y IS the center, so
          no offset is needed. Non-listening so the Rect keeps the transform
          handles; it re-renders with the box automatically. */}
      <Circle
        x={centerX}
        y={centerY}
        radius={radius}
        stroke={style.strokeColor}
        strokeScaleEnabled={false}
        listening={false}
        opacity={reg.hidden ? 0 : 1}
      />
    </Group>
  );
};

export const SquareCircle = observer(SquareCirclePure);
