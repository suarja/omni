import type { Point } from "./spatial-types";

/** Shared detail/workspace grammar: one stem, a vertical bus and horizontal branches. */
export function routeCircuitTree(
  start: Point,
  bus: number,
  ends: readonly Point[],
): Readonly<{
  trunk: string;
  branches: readonly string[];
}> {
  const minimum = Math.min(start.y, ...ends.map((end) => end.y));
  const maximum = Math.max(start.y, ...ends.map((end) => end.y));
  return {
    trunk: `M ${start.x} ${start.y} H ${bus} M ${bus} ${minimum} V ${maximum}`,
    branches: ends.map((end) => `M ${bus} ${end.y} H ${end.x}`),
  };
}
