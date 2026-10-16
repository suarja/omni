import { readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';

async function normalizeFramework(framework) {
  const versions = join(framework, 'Versions');
  const candidates = (await readdir(versions)).filter((name) => name !== 'Current');
  if (candidates.length !== 1) throw new Error(`Cannot resolve the canonical framework version: ${framework}`);
  const canonical = candidates[0];
  const entries = await readdir(join(versions, canonical));
  await rm(join(versions, 'Current'), { recursive: true, force: true });
  await symlink(canonical, join(versions, 'Current'));
  for (const entry of entries) {
    await rm(join(framework, entry), { recursive: true, force: true });
    await symlink(`Versions/Current/${entry}`, join(framework, entry));
  }
}

// Some dependency copies expand Apple's versioned framework symlinks. Signing requires
// the original framework layout, so normalize every staged framework, never the toolchain.
export async function normalizeElectronFramework(appPath) {
  const root = join(appPath, 'Contents/Frameworks');
  for (const entry of await readdir(root)) {
    if (entry.endsWith('.framework')) await normalizeFramework(join(root, entry));
  }
}
