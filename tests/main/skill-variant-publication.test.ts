import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import type { RegistryGrant } from "../../src/main/registry-ipc";
import { strictSkillObservationFilesystem } from "../../src/main/skill-reconciliation/filesystem";
import {
  prepareVariantPayload,
  publishVariantCapture,
  verifyVariantAfterTree,
} from "../../src/main/skill-management/variant-publication";

const roots: string[] = [];
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const files = new Map<string, Uint8Array>([
  ["packages/tools/skills/captured-demo/SKILL.md", Buffer.from("# Captured\n")],
  ["packages/tools/skills/captured-demo/support/payload.bin", Buffer.from([0, 1, 255, 3])],
]);

async function fixture() {
  const rootDirectory = await mkdtemp(join(tmpdir(), "omni-variant-publication-root-"));
  const root = await realpath(rootDirectory);
  const userDataPath = await mkdtemp(join(tmpdir(), "omni-variant-publication-data-"));
  roots.push(rootDirectory, userDataPath);
  await mkdir(join(root, "packages/tools"), { recursive: true });
  const manifestPath = "packages/tools/omni.plugin.json";
  const manifestBefore = Buffer.from(
    `${JSON.stringify({ format: "omni.plugin/1", id: "tools", name: "Tools", version: "0.1.0", artifacts: [{ kind: "skill", path: "skills/existing" }] }, null, 2)}\n`,
  );
  const origin = {
    schemaVersion: 1,
    variantId: "123e4567-e89b-42d3-a456-426614174000",
    forkOf: "223e4567-e89b-42d3-a456-426614174000",
    capturedAt: "2026-10-09T10:00:00.000Z",
    capturedFrom: {
      location: { projectId: "project-one", harnessId: "codex", folderPath: ".agents/skills/demo" },
      revision: {
        algorithm: "omni-tree-v1",
        hash: "a".repeat(64),
        files: [...files].map(([path, bytes]) => ({
          path: path.slice("packages/tools/skills/captured-demo/".length),
          hash: sha256(bytes),
          byteLength: bytes.byteLength,
        })),
      },
    },
  };
  const manifestAfter = Buffer.from(
    `${JSON.stringify(
      {
        format: "omni.plugin/1",
        id: "tools",
        name: "Tools",
        version: "0.1.0",
        artifacts: [
          { kind: "skill", path: "skills/existing" },
          { kind: "skill", path: "skills/captured-demo", variantOrigin: origin },
        ],
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(join(root, manifestPath), manifestBefore);
  const details = await stat(root);
  const grant: RegistryGrant = {
    handle: "source-grant",
    subject: { kind: "source", id: "source-one" },
    root,
    device: String(details.dev),
    inode: String(details.ino),
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
  const payload = await prepareVariantPayload({
    userDataPath,
    intentId: "323e4567-e89b-42d3-a456-426614174000",
    files,
    directories: [
      "packages/tools/skills",
      "packages/tools/skills/captured-demo",
      "packages/tools/skills/captured-demo/support",
    ],
    manifestPath,
    manifestBefore,
    manifestAfter,
  });
  return { root, grant, payload, manifestPath, manifestBefore, manifestAfter };
}

afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

it("publishes and verifies binary support bytes and the exact per-skill origin", async () => {
  const current = await fixture();
  const receipt = await publishVariantCapture({
    grant: current.grant,
    filesystem: strictSkillObservationFilesystem,
    payload: current.payload,
    skillsDirectoryPresent: false,
    progress: async () => undefined,
  });

  expect(receipt.files.map(({ relativePath }) => relativePath)).toEqual([...files.keys()]);
  expect(await readFile(join(current.root, "packages/tools/skills/captured-demo/support/payload.bin"))).toEqual(
    Buffer.from([0, 1, 255, 3]),
  );
  expect(JSON.parse(await readFile(join(current.root, current.manifestPath), "utf8")).artifacts[1]).toMatchObject({
    kind: "skill",
    path: "skills/captured-demo",
    variantOrigin: {
      variantId: "123e4567-e89b-42d3-a456-426614174000",
      forkOf: "223e4567-e89b-42d3-a456-426614174000",
    },
  });
  await expect(
    verifyVariantAfterTree({
      grant: current.grant,
      filesystem: strictSkillObservationFilesystem,
      payload: current.payload,
      afterManifestHash: receipt.manifest.afterHash,
    }),
  ).resolves.toBe(true);
});

it("preserves a competing file inserted after review and leaves the manifest untouched", async () => {
  const current = await fixture();
  const target = "packages/tools/skills/captured-demo/SKILL.md";
  const competingBytes = Buffer.from("Human edit during publication.\n");
  let inserted = false;

  await expect(
    publishVariantCapture({
      grant: current.grant,
      filesystem: strictSkillObservationFilesystem,
      payload: current.payload,
      skillsDirectoryPresent: false,
      progress: async (actions) => {
        if (
          !inserted &&
          actions.some(
            (action) => action.kind === "write-file" && action.relativePath === target && action.status === "applying",
          )
        ) {
          inserted = true;
          await writeFile(join(current.root, target), competingBytes, { flag: "wx" });
        }
      },
    }),
  ).rejects.toThrow();

  expect(inserted).toBe(true);
  expect(await readFile(join(current.root, target))).toEqual(competingBytes);
  expect(await readFile(join(current.root, current.manifestPath))).toEqual(current.manifestBefore);
});

it("does not write through a captured folder replaced by a link inside the source", async () => {
  const current = await fixture();
  const folder = join(current.root, "packages/tools/skills/captured-demo");
  const other = join(current.root, "foreign-folder");
  await mkdir(other);
  let substituted = false;
  await expect(
    publishVariantCapture({
      grant: current.grant,
      filesystem: strictSkillObservationFilesystem,
      payload: current.payload,
      skillsDirectoryPresent: false,
      progress: async (actions) => {
        if (!substituted && actions.some((action) => action.kind === "write-file" && action.status === "applying")) {
          substituted = true;
          await rename(folder, folder + "-saved");
          await symlink(other, folder);
        }
      },
    }),
  ).rejects.toThrow();
  expect(substituted).toBe(true);
  await expect(readFile(join(other, "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(current.root, current.manifestPath))).toEqual(current.manifestBefore);
});
