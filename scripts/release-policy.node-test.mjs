import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertCleanSnapshot, assertSafeDestination, inspectRuntimeImports } from './release-policy.mjs';

test('a release refuses tracked changes while permitting build dependencies', () => {
  assert.doesNotThrow(() => assertCleanSnapshot('?? node_modules\n'));
  assert.throws(() => assertCleanSnapshot(' M src/main/index.ts\n'), /clean tracked/);
});
test('packaging refuses to overwrite an existing destination', () => {
  assert.throws(() => assertSafeDestination('/tmp/release', true), /already exists/);
  assert.doesNotThrow(() => assertSafeDestination('/tmp/release', false));
});
test('a standalone main bundle refuses dependencies outside the application', () => {
  assert.deepEqual(inspectRuntimeImports('require("electron"); require("node:fs"); require("./chunk.js");'), []);
  assert.deepEqual(inspectRuntimeImports('require("unbundled-library");'), ['unbundled-library']);
});

import { mkdtemp, mkdir, writeFile, lstat, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeElectronFramework } from './macos-framework.mjs';

test('packaging repairs flattened framework links without touching the canonical version', async () => {
  const app = await mkdtemp(join(tmpdir(), 'omni-framework-test-'));
  const framework = join(app, 'Contents/Frameworks/Electron Framework.framework');
  try {
    await mkdir(join(framework, 'Versions/A/Resources'), { recursive: true });
    await mkdir(join(framework, 'Versions/A/Helpers'));
    await mkdir(join(framework, 'Versions/A/Libraries'));
    await writeFile(join(framework, 'Versions/A/Electron Framework'), 'canonical');
    await mkdir(join(framework, 'Versions/Current'));
    await writeFile(join(framework, 'Electron Framework'), 'flattened');
    const reactive = join(app, 'Contents/Frameworks/ReactiveObjC.framework');
    await mkdir(join(reactive, 'Versions/A/Resources'), { recursive: true });
    await writeFile(join(reactive, 'Versions/A/ReactiveObjC'), 'canonical');
    await writeFile(join(reactive, 'ReactiveObjC'), 'flattened');
    await normalizeElectronFramework(app);
    assert.equal((await lstat(join(reactive, 'ReactiveObjC'))).isSymbolicLink(), true);
    assert.equal((await lstat(join(framework, 'Electron Framework'))).isSymbolicLink(), true);
    assert.equal(await readlink(join(framework, 'Versions/Current')), 'A');
  } finally { await rm(app, { recursive: true, force: true }); }
});
