type CanvasBounds = Readonly<{ left: number; top: number; width: number; height: number }>;
type TriggerBounds = Readonly<{ right: number; top: number; bottom: number }>;
type FloatingSize = Readonly<{ width: number; height: number }>;

export function positionFloatingMenu(
  canvas: CanvasBounds,
  trigger: TriggerBounds,
  floating: FloatingSize,
  bottomLimit: number,
): Readonly<{ left: number; top: number }> {
  const below = trigger.bottom - canvas.top + 6;
  const limit = Math.min(canvas.height - 12, bottomLimit - canvas.top - 6);
  const top = below + floating.height <= limit ? below : trigger.top - canvas.top - floating.height - 6;
  return {
    left: Math.max(12, Math.min(trigger.right - canvas.left - floating.width, canvas.width - floating.width - 12)),
    top: Math.max(12, Math.min(top, limit - floating.height)),
  };
}
