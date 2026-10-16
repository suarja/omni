import { useRef, type PointerEventHandler } from "react";

const controls =
  "button,input,textarea,select,a,[role=button],[data-canvas-control],.canvas-node-row,.project-chip,.canvas-stage-heading,.project-stage-heading,.project-source-heading,.project-legend,.canvas-legend,.canvas-glossary,.sheet,[role=dialog]";
type Press = { id: number; x: number; y: number; moved: boolean };
export function useEmptyCanvasPress(
  onClose: () => void,
  blocked: boolean,
): Readonly<{
  onPointerDownCapture: PointerEventHandler<HTMLElement>;
  onPointerMoveCapture: PointerEventHandler<HTMLElement>;
  onPointerUpCapture: PointerEventHandler<HTMLElement>;
  onPointerCancelCapture: PointerEventHandler<HTMLElement>;
}> {
  const press = useRef<Press | null>(null);
  const empty = (target: EventTarget): boolean => target instanceof Element && !target.closest(controls);
  return {
    onPointerDownCapture: (event) => {
      press.current =
        !blocked && event.button === 0 && event.isPrimary !== false && empty(event.target)
          ? { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false }
          : null;
    },
    onPointerMoveCapture: (event) => {
      const start = press.current;
      if (start?.id === event.pointerId && Math.hypot(event.clientX - start.x, event.clientY - start.y) >= 4)
        start.moved = true;
    },
    onPointerUpCapture: (event) => {
      const start = press.current;
      press.current = null;
      if (
        !blocked &&
        start?.id === event.pointerId &&
        event.button === 0 &&
        !start.moved &&
        empty(event.target) &&
        Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4
      )
        onClose();
    },
    onPointerCancelCapture: () => {
      press.current = null;
    },
  };
}
