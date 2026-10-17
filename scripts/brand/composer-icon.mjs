import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { glyph, themes } from "./artwork.mjs";

const color = (hex) =>
  `srgb:${[1, 3, 5].map((offset) => (parseInt(hex.slice(offset, offset + 2), 16) / 255).toFixed(5)).join(",")},1.00000`;
const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">${body}</svg>\n`;
const mono = {
  plate: "#d6d6d6",
  dot: "#ababab",
  edge: "#737373",
  center: "#ffffff",
  centerRing: "#999999",
  project: "#505050",
  plugin: "#505050",
  marketplace: "#505050",
};

/** Derive the existing glyph and dot pattern without the legacy plate, frame or shadow.
 * @returns {Record<string, string>}
 */
export function composerArtwork() {
  const assets = {};
  for (const [appearance, theme] of Object.entries({ light: themes.light, dark: themes.dark, tinted: mono })) {
    assets[`graph-${appearance}.svg`] = svg(
      `<g transform="translate(512 512) scale(${1024 / 120})">${glyph(theme)}</g>`,
    );
    assets[`dots-${appearance}.svg`] = svg(
      `<defs><pattern id="dots" width="${(68 * 1024) / 824}" height="${(68 * 1024) / 824}" patternUnits="userSpaceOnUse"><circle cx="${(34 * 1024) / 824}" cy="${(34 * 1024) / 824}" r="${(6.5 * 1024) / 824}" fill="${theme.dot}"/></pattern></defs><rect width="1024" height="1024" fill="url(#dots)"/>`,
    );
  }
  return assets;
}
/** @returns {Record<string, unknown>} */
export function composerDocument() {
  return {
    "fill-specializations": [
      { value: { solid: color(themes.light.plate) } },
      { appearance: "dark", value: { solid: color(themes.dark.plate) } },
      { appearance: "tinted", value: { solid: color(mono.plate) } },
    ],
    groups: ["light", "dark", "tinted"].map((appearance) => ({
      "hidden-specializations": [
        { value: appearance !== "light" },
        { appearance: "dark", value: appearance !== "dark" },
        { appearance: "tinted", value: appearance !== "tinted" },
      ],
      layers: ["graph", "dots"].map((name) => ({
        name: `${name}-${appearance}`,
        "image-name": `${name}-${appearance}.svg`,
        glass: false,
      })),
      shadow: { kind: "none", opacity: 0 },
      specular: false,
      translucency: { enabled: false, value: 0 },
    })),
    "supported-platforms": { squares: "shared" },
  };
}
/** @returns {Promise<void>} */
export async function buildComposerIcon(output) {
  const document = join(output, "Omni.icon");
  await mkdir(join(document, "Assets"), { recursive: true });
  for (const [name, source] of Object.entries(composerArtwork()))
    await writeFile(join(document, "Assets", name), source);
  await writeFile(join(document, "icon.json"), JSON.stringify(composerDocument(), null, 2) + "\n");
  const scratch = await mkdtemp(join(tmpdir(), "omni-composer-"));
  try {
    execFileSync(
      "xcrun",
      [
        "actool",
        document,
        "--compile",
        scratch,
        "--platform",
        "macosx",
        "--minimum-deployment-target",
        "12.0",
        "--app-icon",
        "Omni",
        "--output-partial-info-plist",
        join(scratch, "icon.plist"),
      ],
      { stdio: "inherit" },
    );
    await cp(join(scratch, "Assets.car"), join(output, "Assets.car"));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
