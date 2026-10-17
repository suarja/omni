// Builds Omni's brand assets from one definition: SVG sources, PNG renders and the macOS .icns.
// Run with Electron so rendering uses Chromium: `pnpm brand:build`.
import { app, BrowserWindow } from "electron";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const out = join(root, "resources/brand");

// Canvas palette (src/renderer/canvas/canvas-tokens.css); dark accents are lifted for contrast on ink.
const themes = {
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

/** The graph glyph in a -60..60 coordinate space: a center node linked to three entities. */
function glyph(t) {
  return [
    `<path d="M0,0 L-26,-24 M0,0 L30,-6 M0,0 L-6,30" fill="none" stroke="${t.edge}" stroke-width="2.5" stroke-linecap="round"/>`,
    `<rect x="-13" y="-13" width="26" height="26" rx="7" fill="${t.center}" stroke="${t.centerRing}" stroke-width="3"/>`,
    `<rect x="-34" y="-32" width="16" height="16" rx="5" fill="${t.project}"/>`,
    `<rect x="22" y="-14" width="16" height="16" rx="5" fill="${t.plugin}"/>`,
    `<rect x="-14" y="22" width="16" height="16" rx="5" fill="${t.marketplace}"/>`,
  ].join("");
}

/** macOS app icon on a 1024 canvas: 824 plate, 100 margin, soft shadow. Dots are dropped at small sizes. */
function icon(t, { dots = true } = {}) {
  const scale = 824 / 120;
  const pattern = dots
    ? `<pattern id="dots" width="68" height="68" patternUnits="userSpaceOnUse" x="12" y="12"><circle cx="34" cy="34" r="6.5" fill="${t.dot}"/></pattern>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
<defs><filter id="shadow" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#283328" flood-opacity="0.22"/></filter>${pattern}</defs>
<rect x="100" y="100" width="824" height="824" rx="185" fill="${t.plate}" stroke="${t.plateEdge}" stroke-width="4" filter="url(#shadow)"/>
${dots ? `<rect x="134" y="134" width="756" height="756" rx="160" fill="url(#dots)"/>` : ""}
<g transform="translate(512 512) scale(${scale})">${glyph(t)}</g>
</svg>
`;
}

/** The bare glyph on a transparent square, for favicons and inline marks. */
function mark(t) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-44 -44 88 88" width="88" height="88">${glyph(t)}</svg>\n`;
}

async function render(window, svg, size) {
  const html = `<html><body style="margin:0;background:transparent"><img width="${size}" height="${size}" src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}"></body></html>`;
  window.setContentSize(size, size);
  await window.loadURL(`data:text/html;base64,${Buffer.from(html).toString("base64")}`);
  await window.webContents.executeJavaScript("document.images[0].decode()");
  const image = await window.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  return image.resize({ width: size, height: size }).toPNG();
}

app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.dock?.hide();
// A top-level await before "ready" stalls Electron's ESM main; start from the ready callback.
app
  .whenReady()
  .then(build)
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

async function build() {
  const window = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    webPreferences: { offscreen: true },
  });
  try {
    await mkdir(out, { recursive: true });
    const sources = {
      "icon.svg": icon(themes.light),
      "icon-dark.svg": icon(themes.dark),
      "mark.svg": mark(themes.light),
      "mark-dark.svg": mark(themes.dark),
    };
    for (const [name, svg] of Object.entries(sources)) await writeFile(join(out, name), svg);
    await writeFile(join(out, "icon-512.png"), await render(window, sources["icon.svg"], 512));

    const iconset = join(await mkdtemp(join(tmpdir(), "omni-brand-")), "Omni.iconset");
    await mkdir(iconset);
    const small = icon(themes.light, { dots: false });
    for (const base of [16, 32, 128, 256, 512]) {
      for (const factor of [1, 2]) {
        const size = base * factor;
        const name = factor === 1 ? `icon_${base}x${base}.png` : `icon_${base}x${base}@2x.png`;
        await writeFile(join(iconset, name), await render(window, size < 128 ? small : sources["icon.svg"], size));
      }
    }
    execFileSync("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", join(out, "Omni.icns")]);
    await rm(resolve(iconset, ".."), { recursive: true, force: true });
    console.log(`Built brand assets in ${out}`);
  } finally {
    window.destroy();
    app.quit();
  }
}
