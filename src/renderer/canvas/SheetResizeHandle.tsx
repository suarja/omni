import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactElement } from "react";
import { useI18n } from "../i18n";
import "./sheet-resize.css";

type SheetKind = "details" | "document" | "setup" | "changes";
type WidthRange = Readonly<{ min: number; max: number; enabled: boolean }>;
type Drag = Readonly<{ pointerId: number; originX: number; originWidth: number }>;
const widths: Record<SheetKind, Readonly<{ initial: number; min: number; max: number; breakpoint: number }>> = {
  details: { initial: 520, min: 320, max: 800, breakpoint: 760 },
  document: { initial: 520, min: 320, max: 800, breakpoint: 760 },
  setup: { initial: 520, min: 320, max: 800, breakpoint: 500 },
  changes: { initial: 520, min: 320, max: 800, breakpoint: 760 },
};
// Widths belong to presentation, never to a resource or its persisted profile.
const sessionWidths = new Map<SheetKind, number>();

function constrainWidth(value: number, range: WidthRange): number {
  return Math.round(Math.max(range.min, Math.min(range.max, value)));
}

/** Shared left-edge control for right-anchored sheets; narrow layouts retain their CSS sizing. */
export function SheetResizeHandle({ kind }: Readonly<{ kind: SheetKind }>): ReactElement {
  const { t } = useI18n();
  const edge = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const config = widths[kind];
  const [range, setRange] = useState<WidthRange>({ min: config.min, max: config.max, enabled: false });
  const [width, setWidth] = useState(config.initial);
  const [dragging, setDragging] = useState(false);

  useLayoutEffect(() => {
    const sheet = edge.current?.parentElement;
    const canvas = sheet?.parentElement;
    if (!sheet || !canvas) return;
    function measure(): void {
      const available = canvas!.getBoundingClientRect().width || window.innerWidth;
      const next = {
        min: config.min,
        // Reserve room for the canvas, including its rail and sheet margins.
        max: Math.max(config.min, Math.min(config.max, available - 280)),
        enabled: window.innerWidth > config.breakpoint && available >= config.min + 80,
      };
      setRange(next);
      setWidth(constrainWidth(sessionWidths.get(kind) ?? config.initial, next));
      drag.current = null;
      setDragging(false);
    }
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(canvas);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      sheet.style.removeProperty("--canvas-sheet-width");
    };
  }, [config, kind]);

  useLayoutEffect(() => {
    const sheet = edge.current?.parentElement;
    if (range.enabled) sheet?.style.setProperty("--canvas-sheet-width", `${width}px`);
    else sheet?.style.removeProperty("--canvas-sheet-width");
  }, [range, width]);

  function resize(value: number): void {
    const next = constrainWidth(value, range);
    sessionWidths.set(kind, next);
    setWidth(next);
  }

  function reset(): void {
    sessionWidths.delete(kind);
    setWidth(constrainWidth(config.initial, range));
  }

  function begin(event: PointerEvent<HTMLDivElement>): void {
    if (!range.enabled || event.button !== 0 || drag.current) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    drag.current = { pointerId: event.pointerId, originX: event.clientX, originWidth: width };
    setDragging(true);
  }

  function move(event: PointerEvent<HTMLDivElement>): void {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId || !range.enabled) return;
    event.preventDefault();
    event.stopPropagation();
    resize(current.originWidth + current.originX - event.clientX);
  }

  function finish(event: PointerEvent<HTMLDivElement>): void {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function key(event: KeyboardEvent<HTMLDivElement>): void {
    if (!range.enabled || event.altKey || event.ctrlKey || event.metaKey) return;
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Home") reset();
    else if (event.key === "End") resize(range.max);
    else resize(width + (event.key === "ArrowLeft" ? 24 : -24));
  }

  return (
    <div
      aria-label={t("canvas.resizeSheet")}
      aria-orientation="vertical"
      aria-valuemax={range.max}
      aria-valuemin={range.min}
      aria-valuenow={width}
      aria-valuetext={t("canvas.sheetWidth", { width })}
      className={`canvas-sheet-resize${dragging ? " is-dragging" : ""}`}
      hidden={!range.enabled}
      onDoubleClick={reset}
      onKeyDown={key}
      onLostPointerCapture={() => {
        drag.current = null;
        setDragging(false);
      }}
      onPointerCancel={finish}
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={finish}
      ref={edge}
      role="separator"
      tabIndex={range.enabled ? 0 : -1}
      title={t("canvas.resizeSheetHint")}
    />
  );
}
