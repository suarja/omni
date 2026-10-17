import { useLayoutEffect, useRef, type ReactElement, type ReactNode } from "react";
import { CanvasGlyph, type CanvasGlyphName } from "../CanvasGlyph";
export { layoutPageSections } from "./page-grid-layout";

export type PageNode = Readonly<{
  id: string;
  title: string;
  kind: CanvasGlyphName;
  meta: ReactNode;
  metadataLabels?: readonly string[];
  unused?: boolean;
  skillName?: string;
  onOpen: () => void;
}>;
export type PageSection = Readonly<{
  id: string;
  title: ReactNode;
  onOpen?: () => void;
  label?: string;
  nodes: readonly PageNode[];
}>;
export function PageGraph(
  props: Readonly<{
    sections: readonly PageSection[];
    tops: readonly number[];
    nodeTops: readonly (readonly number[])[];
    height: number;
    banner?: ReactNode;
    onBannerMeasure?: (height: number) => void;
    onMeasure: (heights: ReadonlyMap<string, number>) => void;
  }>,
): ReactElement {
  const graph = useRef<HTMLDivElement>(null);
  const ids = JSON.stringify(props.sections.flatMap((section) => section.nodes.map((node) => node.id)));
  useLayoutEffect(() => {
    const nodes = [...(graph.current?.querySelectorAll<HTMLElement>("[data-page-node]") ?? [])];
    const banner = graph.current?.querySelector<HTMLElement>(".page-banner");
    const measure = (): void => {
      props.onBannerMeasure?.(banner?.offsetHeight ?? 0);
      const heights = new Map(
        nodes.flatMap((node) => (node.offsetHeight > 0 ? [[node.dataset.pageNode!, node.offsetHeight] as const] : [])),
      );
      if (heights.size) props.onMeasure(heights);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    nodes.forEach((node) => observer?.observe(node));
    if (banner) observer?.observe(banner);
    return () => observer?.disconnect();
  }, [ids, Boolean(props.banner), props.onMeasure, props.onBannerMeasure]);
  return (
    <div ref={graph} className="page-graph" style={{ width: 1216, height: props.height }}>
      {props.banner ? <div className="page-banner">{props.banner}</div> : null}
      {props.sections.map((section, index) => (
        <section key={section.id} data-page-section={section.id}>
          <h3 className="page-section-title" style={{ left: 40, top: props.tops[index] }}>
            {section.onOpen ? (
              <button type="button" aria-label={section.label} onClick={section.onOpen}>
                {section.title} <span aria-hidden="true">›</span>
              </button>
            ) : (
              section.title
            )}
          </h3>
          {section.nodes.map((node, item) => (
            <div
              key={node.id}
              data-page-node={node.id}
              data-external-skill={node.skillName}
              data-tone={node.kind}
              className={`canvas-node-row page-node${node.unused ? " is-unused" : ""}`}
              style={{ left: 40 + (item % 4) * 284, top: props.nodeTops[index]![item] }}
            >
              <button type="button" className="canvas-node" aria-label={node.title} onClick={node.onOpen}>
                <span className={`canvas-node-icon page-icon-${node.kind}`}>
                  <CanvasGlyph name={node.kind} size={20} />
                </span>
                <span className="canvas-node-body">
                  <span className="canvas-node-label">{node.title}</span>
                  <span className="canvas-node-meta">{node.meta}</span>
                </span>
              </button>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
