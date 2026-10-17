import type { CSSProperties, ReactElement, ReactNode, RefObject } from "react";

import { CanvasCameraControls } from "./CanvasCameraControls";
import type { CameraControls } from "./use-canvas-camera";
import "./spatial.css";

export function CanvasViewport(
  props: Readonly<{
    viewportRef: RefObject<HTMLDivElement | null>;
    controls: CameraControls;
    disabled: boolean;
    children: ReactNode;
  }>,
): ReactElement {
  const { camera } = props.controls;
  const worldStyle = {
    visibility: props.controls.ready ? "visible" : "hidden",
    // Skeleton children set visibility themselves; opacity gates paint while preserving measurement.
    opacity: props.controls.ready ? 1 : 0,
    transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`,
    transformOrigin: "0 0",
  } as CSSProperties;
  return (
    <div
      className="canvas-viewport"
      data-testid="canvas-viewport"
      onKeyDown={props.controls.onKeyDown}
      onLostPointerCapture={props.controls.onLostPointerCapture}
      onPointerCancel={props.controls.onPointerCancel}
      onPointerDown={props.controls.onPointerDown}
      onPointerMove={props.controls.onPointerMove}
      onPointerUp={props.controls.onPointerUp}
      ref={props.viewportRef}
      style={{
        backgroundSize: `${16 * camera.scale}px ${16 * camera.scale}px, 100% 100%`,
        backgroundPosition: `${camera.x}px ${camera.y}px, 0 0`,
      }}
      tabIndex={0}
    >
      <div className="canvas-world" style={worldStyle} inert={!props.controls.ready}>
        {props.children}
      </div>
      <CanvasCameraControls
        camera={camera}
        disabled={props.disabled || !props.controls.ready}
        onFit={props.controls.fit}
        onRecenter={props.controls.recenter}
        onZoomIn={props.controls.zoomIn}
        onZoomOut={props.controls.zoomOut}
      />
    </div>
  );
}
