// Canvas palette (src/renderer/canvas/canvas-tokens.css); dark accents are lifted for contrast on ink.
export const themes = {
  light: {
    plate: "#f7f8f6",
    plateEdge: "#dce0dc",
    dot: "#d3d7d2",
    edge: "#a8afb0",
    center: "#ffffff",
    centerRing: "#c9d3e2",
    project: "#567faf",
    plugin: "#388777",
    marketplace: "#7b62b0",
  },
  dark: {
    plate: "#2e3438",
    plateEdge: "#2e3438",
    dot: "#454c51",
    edge: "#787f83",
    center: "#f7f8f6",
    centerRing: "#787f83",
    project: "#6f97c6",
    plugin: "#4fa18f",
    marketplace: "#9580c8",
  },
};

/** The graph glyph in a -60..60 coordinate space: a center node linked to three entities.
 * @returns {string}
 */
export function glyph(t) {
  return [
    `<path d="M0,0 L-26,-24 M0,0 L30,-6 M0,0 L-6,30" fill="none" stroke="${t.edge}" stroke-width="2.5" stroke-linecap="round"/>`,
    `<rect x="-13" y="-13" width="26" height="26" rx="7" fill="${t.center}" stroke="${t.centerRing}" stroke-width="3"/>`,
    `<rect x="-34" y="-32" width="16" height="16" rx="5" fill="${t.project}"/>`,
    `<rect x="22" y="-14" width="16" height="16" rx="5" fill="${t.plugin}"/>`,
    `<rect x="-14" y="22" width="16" height="16" rx="5" fill="${t.marketplace}"/>`,
  ].join("");
}
