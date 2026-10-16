import type { CanvasLayout } from "../spatial/spatial-types";
import type { PageSection, PageNode } from "./PageGraph";

function estimateNodeHeight(node: PageNode): number {
  if (!node.metadataLabels?.length) return 72;
  const width = 200;
  let lineWidth = 0,
    lineHeight = 19,
    height = 0;
  for (const label of node.metadataLabels) {
    const chipWidth = Array.from(label).length * 8 + 16;
    const fittedWidth = Math.min(width, chipWidth);
    if (lineWidth && lineWidth + 4 + fittedWidth > width) {
      height += lineHeight + 4;
      lineWidth = 0;
      lineHeight = 19;
    }
    lineWidth += (lineWidth ? 4 : 0) + fittedWidth;
    lineHeight = Math.max(lineHeight, Math.ceil(chipWidth / width) * 17 + 2);
  }
  const titleLines = Math.min(2, Math.max(1, Math.ceil((Array.from(node.title).length * 8) / width)));
  return Math.max(72, Math.ceil(22 + titleLines * 19 + 3 + height + lineHeight));
}

export function layoutPageSections(
  sections: readonly PageSection[],
  start = 70,
  gap = 18,
  measured: ReadonlyMap<string, number> = new Map(),
): Readonly<{ tops: readonly number[]; nodeTops: readonly (readonly number[])[]; layout: CanvasLayout }> {
  let y = start;
  const nodeTops: number[][] = [];
  const tops = sections.map((section) => {
    const top = y;
    const positions: number[] = [];
    if (!section.nodes.length) y += 30;
    else {
      y += 28;
      for (let index = 0; index < section.nodes.length; index += 4) {
        const row = section.nodes.slice(index, index + 4);
        positions.push(...row.map(() => y));
        const height = Math.max(...row.map((node) => measured.get(node.id) ?? estimateNodeHeight(node)));
        y += Math.max(96, Math.ceil(height) + 24);
      }
      y += gap;
    }
    nodeTops.push(positions);
    return top;
  });
  return {
    tops,
    nodeTops,
    layout: { nodes: [], wires: [], ports: [], bounds: { left: 0, top: 0, right: 1216, bottom: y + 40 } },
  };
}
