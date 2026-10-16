import { describe, expect, it } from "vitest";

import { fitCamera, panCamera, recenterCamera, zoomCamera } from "../../src/renderer/canvas/spatial/camera";

describe("canvas camera geometry", () => {
  it("keeps the pointer's world coordinate while zooming", () => {
    expect(zoomCamera({ x: 100, y: 60, scale: 1 }, 1.2, { x: 300, y: 200 })).toEqual({ x: 60, y: 32, scale: 1.2 });
  });

  it("keeps dense nodes readable at the fit floor and centers complete bounds", () => {
    const camera = fitCamera({ left: -617, top: -400, right: 617, bottom: 400 }, { width: 320, height: 500 });
    expect(camera).toEqual({ x: 160, y: 250, scale: 0.8 });
  });

  it("pans in screen pixels independently of zoom", () => {
    expect(panCamera({ x: 10, y: 20, scale: 0.8 }, { x: 100, y: 60 })).toEqual({ x: 110, y: 80, scale: 0.8 });
  });

  it("clamps zoom and recenters without changing scale", () => {
    expect(zoomCamera({ x: 0, y: 0, scale: 1 }, 3, { x: 10, y: 20 }).scale).toBe(1.8);
    expect(recenterCamera({ x: -30, y: 90, scale: 0.8 }, { width: 800, height: 600 })).toEqual({
      x: 400,
      y: 300,
      scale: 0.8,
    });
  });
});
