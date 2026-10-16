import { expect, it } from "vitest";
import { positionFloatingMenu } from "../../src/renderer/canvas/floating-position";
const canvas = { left: 0, top: 56, width: 1440, height: 854 };
it("opens a row menu above its trigger when the sheet footer leaves too little room below", () => {
  expect(
    positionFloatingMenu(canvas, { right: 1400, top: 780, bottom: 808 }, { width: 252, height: 100 }, 850),
  ).toEqual({ left: 1148, top: 618 });
});
it("opens a row menu below its trigger when it fits and clamps its left edge", () => {
  expect(positionFloatingMenu(canvas, { right: 100, top: 200, bottom: 228 }, { width: 252, height: 100 }, 850)).toEqual(
    { left: 12, top: 178 },
  );
});
