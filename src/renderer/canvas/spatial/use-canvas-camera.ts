import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type PointerEventHandler,
  type RefObject,
} from "react";

import { fitCamera, panCamera, recenterCamera, zoomCamera } from "./camera";
import type { Camera, CanvasLayout, Point, Size } from "./spatial-types";

export type CameraInputs = Readonly<{
  viewportRef: RefObject<HTMLDivElement | null>;
  viewKey: string;
  layout: CanvasLayout;
  minimumFitScale?: number;
  layoutForSize?: (size: Size) => CanvasLayout;
  initialCamera?: Camera;
  resizeAnchor?: "center" | "origin";
  disabled: boolean;
  pending?: boolean;
  onCameraChange: (camera: Camera) => void;
}>;
export type CameraControls = Readonly<{
  camera: Camera;
  ready: boolean;
  size: Size;
  onPointerDown: PointerEventHandler<HTMLDivElement>;
  onPointerMove: PointerEventHandler<HTMLDivElement>;
  onPointerUp: PointerEventHandler<HTMLDivElement>;
  onPointerCancel: PointerEventHandler<HTMLDivElement>;
  onLostPointerCapture: PointerEventHandler<HTMLDivElement>;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  zoomIn(): void;
  zoomOut(): void;
  fit(): void;
  recenter(): void;
}>;

type PointerPosition = Point & Readonly<{ clientX: number; clientY: number }>;
type Gesture = {
  ids: number[];
  starts: Map<number, PointerPosition>;
  startCamera: Camera;
  captured: Set<number>;
  active: boolean;
};

const initialCamera: Camera = { x: 0, y: 0, scale: 1 };
const dragThreshold = 4;

function pointerPosition(viewport: HTMLDivElement, clientX: number, clientY: number): PointerPosition {
  const bounds = viewport.getBoundingClientRect();
  return { x: clientX - bounds.left, y: clientY - bounds.top, clientX, clientY };
}

function ignoredTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      "button,input,textarea,select,[contenteditable='true'],[data-canvas-control],[data-canvas-reader],[data-canvas-menu],.canvas-sheet,.canvas-search-sheet",
    ),
  );
}

function distance(start: Point, end: Point): number {
  return Math.hypot(end.x - start.x, end.y - start.y);
}

function midpoint(points: readonly PointerPosition[]): Point {
  return {
    x: (points[0]!.x + points[1]!.x) / 2,
    y: (points[0]!.y + points[1]!.y) / 2,
  };
}

function pointerDistance(points: readonly PointerPosition[]): number {
  return Math.max(1, distance(points[0]!, points[1]!));
}

export function useCanvasCamera(input: CameraInputs): CameraControls {
  const [camera, setCamera] = useState<Camera>(input.initialCamera ?? initialCamera);
  const [readyView, setReadyView] = useState<string | null>(null);
  const cameraRef = useRef(camera);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const sizeRef = useRef(size);
  const onCameraChangeRef = useRef(input.onCameraChange);
  const initializedViews = useRef(new Set<string>());
  const activeView = useRef(input.viewKey);
  const pointers = useRef(new Map<number, PointerPosition>());
  const gesture = useRef<Gesture | null>(null);
  const fittingLayout = input.layoutForSize?.(size) ?? input.layout;
  const boundsSignature = useMemo(
    () =>
      `${fittingLayout.bounds.left}:${fittingLayout.bounds.top}:${fittingLayout.bounds.right}:${fittingLayout.bounds.bottom}`,
    [fittingLayout.bounds.bottom, fittingLayout.bounds.left, fittingLayout.bounds.right, fittingLayout.bounds.top],
  );

  const commitCamera = useCallback((next: Camera): void => {
    cameraRef.current = next;
    setCamera(next);
    onCameraChangeRef.current(next);
  }, []);

  useLayoutEffect(() => {
    onCameraChangeRef.current = input.onCameraChange;
  }, [input.onCameraChange]);

  useLayoutEffect(() => {
    if (activeView.current === input.viewKey) return;
    activeView.current = input.viewKey;
    setReadyView(null);
    // Session writes echo the live camera; only a new visit may restore or fit it.
    initializedViews.current.delete(input.viewKey);
  }, [input.viewKey]);

  useLayoutEffect(() => {
    const viewport = input.viewportRef.current;
    if (!viewport) return;
    let previous: Size | undefined;
    const measure = (): void => {
      const next = { width: viewport.clientWidth, height: viewport.clientHeight };
      if (next.width <= 0 || next.height <= 0) {
        setSize(next);
        sizeRef.current = next;
        return;
      }
      const changed = !previous || previous.width !== next.width || previous.height !== next.height;
      if (!changed) return;
      if (previous && initializedViews.current.has(input.viewKey) && input.resizeAnchor !== "origin") {
        commitCamera(
          panCamera(cameraRef.current, {
            x: (next.width - previous.width) / 2,
            y: (next.height - previous.height) / 2,
          }),
        );
      }
      previous = next;
      sizeRef.current = next;
      setSize(next);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(viewport);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [commitCamera, input.resizeAnchor, input.viewKey, input.viewportRef]);

  useLayoutEffect(() => {
    const measured = sizeRef.current;
    if (input.pending || measured.width <= 0 || measured.height <= 0 || initializedViews.current.has(input.viewKey))
      return;
    const measuredLayout = input.layoutForSize?.(measured) ?? input.layout;
    const next = input.initialCamera ?? fitCamera(measuredLayout.bounds, measured, input.minimumFitScale);
    initializedViews.current.add(input.viewKey);
    commitCamera(next);
    setReadyView(input.viewKey);
  }, [boundsSignature, commitCamera, input.initialCamera, input.viewKey, input.minimumFitScale, input.pending, size]);

  useEffect(() => {
    if (!input.disabled) return;
    pointers.current.clear();
    gesture.current = null;
    input.viewportRef.current?.classList.remove("is-dragging");
  }, [input.disabled, input.viewportRef]);

  useEffect(() => {
    const viewport = input.viewportRef.current;
    if (!viewport || input.disabled) return;
    const onWheel = (event: WheelEvent): void => {
      if (ignoredTarget(event.target)) return;
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? viewport.clientHeight
            : 1;
      const dx = event.deltaX * unit;
      const dy = event.deltaY * unit;
      const bounds = viewport.getBoundingClientRect();
      const anchor = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      const current = cameraRef.current;
      const next =
        event.ctrlKey || event.metaKey
          ? zoomCamera(current, current.scale * Math.exp(-dy * 0.002), anchor)
          : panCamera(current, { x: -dx, y: -dy });
      event.preventDefault();
      commitCamera(next);
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [commitCamera, input.disabled, input.viewportRef]);

  const onPointerDown: PointerEventHandler<HTMLDivElement> = useCallback(
    (event): void => {
      if (input.disabled || event.button !== 0 || ignoredTarget(event.target) || pointers.current.size >= 2) return;
      const viewport = event.currentTarget;
      const position = pointerPosition(viewport, event.clientX, event.clientY);
      pointers.current.set(event.pointerId, position);
      const previous = gesture.current;
      const ids = [...pointers.current.keys()];
      const starts = new Map(pointers.current);
      const captured = previous?.captured ?? new Set<number>();
      gesture.current = {
        ids,
        starts,
        startCamera: cameraRef.current,
        captured: new Set(captured),
        active: Boolean(previous?.active),
      };
    },
    [input.disabled],
  );

  const onPointerMove: PointerEventHandler<HTMLDivElement> = useCallback(
    (event): void => {
      const currentGesture = gesture.current;
      if (input.disabled || !currentGesture || !pointers.current.has(event.pointerId)) return;
      pointers.current.set(event.pointerId, pointerPosition(event.currentTarget, event.clientX, event.clientY));
      const starts = currentGesture.ids.map((id) => currentGesture.starts.get(id)!).filter(Boolean);
      const current = currentGesture.ids.map((id) => pointers.current.get(id)!).filter(Boolean);
      if (!currentGesture.active) {
        const moved = current.reduce((maximum, point, index) => Math.max(maximum, distance(starts[index]!, point)), 0);
        if (moved < dragThreshold) return;
        currentGesture.active = true;
        event.currentTarget.classList.add("is-dragging");
      }
      for (const id of currentGesture.ids) {
        if (currentGesture.captured.has(id)) continue;
        try {
          event.currentTarget.setPointerCapture(id);
          currentGesture.captured.add(id);
        } catch {
          // Detached test nodes and cancelled native pointers may reject capture.
        }
      }
      event.preventDefault();
      if (current.length === 1) {
        commitCamera(
          panCamera(currentGesture.startCamera, {
            x: current[0]!.clientX - starts[0]!.clientX,
            y: current[0]!.clientY - starts[0]!.clientY,
          }),
        );
        return;
      }
      const startCenter = midpoint(starts);
      const currentCenter = midpoint(current);
      const zoomed = zoomCamera(
        currentGesture.startCamera,
        (currentGesture.startCamera.scale * pointerDistance(current)) / pointerDistance(starts),
        startCenter,
      );
      commitCamera(
        panCamera(zoomed, {
          x: currentCenter.x - startCenter.x,
          y: currentCenter.y - startCenter.y,
        }),
      );
    },
    [commitCamera, input.disabled],
  );

  const onPointerUp: PointerEventHandler<HTMLDivElement> = useCallback((event): void => {
    pointers.current.delete(event.pointerId);
    const currentGesture = gesture.current;
    if (!currentGesture) return;
    if (!pointers.current.size) {
      gesture.current = null;
      event.currentTarget.classList.remove("is-dragging");
      return;
    }
    const ids = [...pointers.current.keys()];
    gesture.current = {
      ids,
      starts: new Map(pointers.current),
      startCamera: cameraRef.current,
      captured: new Set(ids.filter((id) => currentGesture.captured.has(id))),
      active: currentGesture.active,
    };
  }, []);

  const cancelGesture = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    pointers.current.clear();
    gesture.current = null;
    event.currentTarget.classList.remove("is-dragging");
  }, []);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      if (
        input.disabled ||
        event.nativeEvent.isComposing ||
        event.nativeEvent.keyCode === 229 ||
        document.activeElement !== event.currentTarget ||
        ignoredTarget(event.target)
      )
        return;
      const current = cameraRef.current;
      const pan = (delta: Point): void => {
        event.preventDefault();
        commitCamera(panCamera(current, delta));
      };
      if (event.key === "ArrowRight") pan({ x: -40, y: 0 });
      else if (event.key === "ArrowLeft") pan({ x: 40, y: 0 });
      else if (event.key === "ArrowDown") pan({ x: 0, y: -40 });
      else if (event.key === "ArrowUp") pan({ x: 0, y: 40 });
      else if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        commitCamera(
          zoomCamera(current, current.scale * 1.2, { x: sizeRef.current.width / 2, y: sizeRef.current.height / 2 }),
        );
      } else if (event.key === "-") {
        event.preventDefault();
        commitCamera(
          zoomCamera(current, current.scale / 1.2, { x: sizeRef.current.width / 2, y: sizeRef.current.height / 2 }),
        );
      } else if (event.key === "0") {
        event.preventDefault();
        if (sizeRef.current.width > 0 && sizeRef.current.height > 0)
          commitCamera(fitCamera(fittingLayout.bounds, sizeRef.current, input.minimumFitScale));
      }
    },
    [boundsSignature, commitCamera, input.disabled, input.minimumFitScale],
  );

  const zoomAtCenter = useCallback(
    (factor: number): void => {
      if (input.disabled || sizeRef.current.width <= 0 || sizeRef.current.height <= 0) return;
      const current = cameraRef.current;
      commitCamera(
        zoomCamera(current, current.scale * factor, {
          x: sizeRef.current.width / 2,
          y: sizeRef.current.height / 2,
        }),
      );
    },
    [commitCamera, input.disabled],
  );
  const fit = useCallback((): void => {
    if (input.disabled || sizeRef.current.width <= 0 || sizeRef.current.height <= 0) return;
    commitCamera(fitCamera(fittingLayout.bounds, sizeRef.current, input.minimumFitScale));
  }, [boundsSignature, commitCamera, input.disabled, input.minimumFitScale]);
  const recenter = useCallback((): void => {
    if (input.disabled || sizeRef.current.width <= 0 || sizeRef.current.height <= 0) return;
    commitCamera(recenterCamera(cameraRef.current, sizeRef.current));
  }, [commitCamera, input.disabled]);

  return {
    camera,
    ready: readyView === input.viewKey && activeView.current === input.viewKey,
    size,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: cancelGesture,
    onLostPointerCapture: cancelGesture,
    onKeyDown,
    zoomIn: () => zoomAtCenter(1.2),
    zoomOut: () => zoomAtCenter(1 / 1.2),
    fit,
    recenter,
  };
}
