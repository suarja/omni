import type { Bounds, Camera, Point, Size } from "./spatial-types";

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function panCamera(camera: Camera, delta: Point): Camera {
  return { ...camera, x: camera.x + delta.x, y: camera.y + delta.y };
}

export function zoomCamera(camera: Camera, nextScale: number, anchor: Point): Camera {
  const scale = clamp(nextScale, 0.5, 1.8);
  const ratio = scale / camera.scale;
  return {
    scale,
    x: anchor.x - (anchor.x - camera.x) * ratio,
    y: anchor.y - (anchor.y - camera.y) * ratio,
  };
}

export function fitCamera(bounds: Bounds, viewport: Size): Camera {
  if (viewport.width <= 0 || viewport.height <= 0) return { x: 0, y: 0, scale: 1 };
  const width = Math.max(1, bounds.right - bounds.left);
  const height = Math.max(1, bounds.bottom - bounds.top);
  const scale = clamp(Math.min((viewport.width - 80) / width, (viewport.height - 124) / height), 0.8, 1);
  return {
    scale,
    x: viewport.width / 2 - ((bounds.left + bounds.right) * scale) / 2,
    y: viewport.height / 2 - ((bounds.top + bounds.bottom) * scale) / 2,
  };
}

export function recenterCamera(camera: Camera, viewport: Size): Camera {
  if (viewport.width <= 0 || viewport.height <= 0) return camera;
  return { ...camera, x: viewport.width / 2, y: viewport.height / 2 };
}
