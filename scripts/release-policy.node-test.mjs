import assert from "node:assert/strict";
import { test } from "node:test";
import { assertCleanSnapshot, assertSafeDestination, inspectRuntimeImports } from "./release-policy.mjs";

test("a release refuses tracked changes while permitting build dependencies", () => {
  assert.doesNotThrow(() => assertCleanSnapshot("?? node_modules\n"));
  assert.throws(() => assertCleanSnapshot(" M src/main/index.ts\n"), /clean tracked/);
});
test("packaging refuses to overwrite an existing destination", () => {
  assert.throws(() => assertSafeDestination("/tmp/release", true), /already exists/);
  assert.doesNotThrow(() => assertSafeDestination("/tmp/release", false));
});
test("a standalone main bundle refuses dependencies outside the application", () => {
  assert.deepEqual(inspectRuntimeImports('require("electron"); require("node:fs"); require("./chunk.js");'), []);
  assert.deepEqual(inspectRuntimeImports('require("unbundled-library");'), ["unbundled-library"]);
});

import { mkdtemp, mkdir, writeFile, readFile, lstat, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeElectronFramework } from "./macos-framework.mjs";

test("packaging repairs flattened framework links without touching the canonical version", async () => {
  const app = await mkdtemp(join(tmpdir(), "omni-framework-test-"));
  const framework = join(app, "Contents/Frameworks/Electron Framework.framework");
  try {
    await mkdir(join(framework, "Versions/A/Resources"), { recursive: true });
    await mkdir(join(framework, "Versions/A/Helpers"));
    await mkdir(join(framework, "Versions/A/Libraries"));
    await writeFile(join(framework, "Versions/A/Electron Framework"), "canonical");
    await mkdir(join(framework, "Versions/Current"));
    await writeFile(join(framework, "Electron Framework"), "flattened");
    const reactive = join(app, "Contents/Frameworks/ReactiveObjC.framework");
    await mkdir(join(reactive, "Versions/A/Resources"), { recursive: true });
    await writeFile(join(reactive, "Versions/A/ReactiveObjC"), "canonical");
    await writeFile(join(reactive, "ReactiveObjC"), "flattened");
    await normalizeElectronFramework(app);
    assert.equal((await lstat(join(reactive, "ReactiveObjC"))).isSymbolicLink(), true);
    assert.equal((await lstat(join(framework, "Electron Framework"))).isSymbolicLink(), true);
    assert.equal(await readlink(join(framework, "Versions/Current")), "A");
  } finally {
    await rm(app, { recursive: true, force: true });
  }
});

import * as releasePolicy from "./release-policy.mjs";
import { artifactNames } from "./release/policy.mjs";

test("packaging installs the approved Omni icon and declares it in Info.plist", () => {
  assert.equal(typeof releasePolicy.applicationBrandingPlan, "function");
  const plan = releasePolicy.applicationBrandingPlan("/tmp/source", "/tmp/Omni.app");
  assert.deepEqual(plan, {
    iconSource: "/tmp/source/resources/brand/Omni.icns",
    iconDestination: "/tmp/Omni.app/Contents/Resources/Omni.icns",
    obsoleteIcon: "/tmp/Omni.app/Contents/Resources/electron.icns",
    assetsSource: "/tmp/source/resources/brand/Assets.car",
    assetsDestination: "/tmp/Omni.app/Contents/Resources/Assets.car",
    plistEntries: {
      CFBundleDisplayName: "Omni",
      CFBundleName: "Omni",
      CFBundleExecutable: "Omni",
      CFBundleIconFile: "Omni",
      CFBundleIconName: "Omni",
    },
  });
});

test("release artifacts use the Omni name for each supported architecture", () => {
  for (const arch of ["arm64", "x64", "universal"]) {
    assert.deepEqual(artifactNames("0.2.0", arch), {
      zip: `Omni-0.2.0-mac-${arch}.zip`,
      dmg: `Omni-0.2.0-${arch}.dmg`,
    });
  }
});

import { composerArtwork, composerDocument } from "./brand/composer-icon.mjs";
import { glyph, themes } from "./brand/artwork.mjs";
test("the system icon reuses the brand graph with light, dark and tinted artwork and no baked enclosure", () => {
  const document = composerDocument();
  const assets = composerArtwork();
  assert.equal(Object.keys(assets).length, 6);
  assert.ok(assets["graph-light.svg"].includes(glyph(themes.light)));
  assert.ok(assets["graph-dark.svg"].includes(glyph(themes.dark)));
  assert.equal(document["fill-specializations"].length, 3);
  for (const group of document.groups) {
    assert.equal(group.shadow.kind, "none");
    assert.ok(group.layers[0]["image-name"].startsWith("graph-"));
    assert.equal(group["hidden-specializations"].filter(({ value }) => !value).length, 1);
    for (const layer of group.layers) {
      assert.equal(layer.glass, false);
      assert.ok(assets[layer["image-name"]]);
    }
  }
  for (const source of Object.values(assets)) {
    assert.ok(!source.includes("feDropShadow"));
    assert.ok(!source.includes('rx="185"'));
  }
});

test("committed Icon Composer sources match the brand generator", async () => {
  const root = new URL("../resources/brand/Omni.icon/", import.meta.url);
  assert.deepEqual(JSON.parse(await readFile(new URL("icon.json", root), "utf8")), composerDocument());
  for (const [name, source] of Object.entries(composerArtwork()))
    assert.equal(await readFile(new URL(`Assets/${name}`, root), "utf8"), source);
});
