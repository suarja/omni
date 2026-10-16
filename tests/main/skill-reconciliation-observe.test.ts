import { createHash } from "node:crypto";
import { expect, test } from "vitest";

import { observeCompleteSkillTree, type SkillScanBudget } from "../../src/main/skill-reconciliation/observe";
import {
  SkillObservationError,
  type SkillObservationFilesystem,
  type SkillObservationGrant,
} from "../../src/ports/skill-reconciliation";

type Node = { kind: "directory" | "file" | "symlink" | "other"; bytes?: Uint8Array; identity: string };
const grant: SkillObservationGrant = {
  root: "/registered/project",
  subject: { kind: "project", id: "project-one" },
  device: "1",
  inode: "2",
  expiresAt: Number.MAX_SAFE_INTEGER,
};
const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const folder = ".agents/skills/review";

function makeFilesystem(
  files: Readonly<Record<string, Uint8Array>> = {
    "SKILL.md": Buffer.from("skill\n"),
    "resources/data.bin": Buffer.from([0, 1, 2]),
  },
): {
  filesystem: SkillObservationFilesystem;
  nodes: Map<string, Node>;
  replace(path: string, node: Node): void;
} {
  const nodes = new Map<string, Node>();
  const putDirectory = (path: string, identity = `dir:${path}`): void => {
    nodes.set(path, { kind: "directory", identity });
  };
  putDirectory(folder);
  for (const path of Object.keys(files)) {
    let parent = folder;
    for (const segment of path.split("/").slice(0, -1)) {
      parent = `${parent}/${segment}`;
      if (!nodes.has(parent)) putDirectory(parent);
    }
    const fullPath = `${folder}/${path}`;
    nodes.set(fullPath, { kind: "file", bytes: files[path], identity: `file:${fullPath}:0` });
  }
  const filesystem: SkillObservationFilesystem = {
    async lstat(_grant, path) {
      const node = nodes.get(path);
      if (!node) throw new SkillObservationError("missing");
      return { kind: node.kind, byteLength: node.bytes?.byteLength ?? 0, identity: node.identity };
    },
    async listDirectory(_grant, path) {
      const node = nodes.get(path);
      if (!node) throw new SkillObservationError("missing");
      const prefix = `${path}/`;
      const names = new Set<string>();
      for (const child of nodes.keys()) {
        if (!child.startsWith(prefix)) continue;
        const remainder = child.slice(prefix.length);
        names.add(remainder.split("/")[0]!);
      }
      return [...names];
    },
    async readFile(_grant, path, expectedIdentity, maximumBytes) {
      const node = nodes.get(path);
      if (!node?.bytes) throw new SkillObservationError("io");
      if (node.identity !== expectedIdentity) throw new SkillObservationError("changed-during-read");
      if (node.bytes.byteLength > maximumBytes) throw new SkillObservationError("limit");
      return { bytes: node.bytes, identity: node.identity };
    },
  };
  return {
    filesystem,
    nodes,
    replace: (path, node) => {
      nodes.set(path, node);
    },
  };
}

function budget(remainingBytes = 32 * 1024 * 1024): SkillScanBudget {
  return { remainingBytes };
}

function rawRead(path = folder, fs = makeFilesystem(), scan = budget()) {
  return observeCompleteSkillTree(grant, path, scan, fs.filesystem, digest);
}

test("complete observation hashes support files using a literal stable tree revision", async () => {
  const first = await rawRead();
  expect(first).toEqual({
    status: "complete",
    revision: {
      algorithm: "omni-tree-v1",
      hash: "746bb27d1c58a0a417251b3f0390a2aa79ee6dd427da1069e471b8a7ddef862d",
      files: [
        {
          path: "resources/data.bin",
          hash: "ae4b3280e56e2faf83f414a6e3dabe9d5fbe18976544c05fed121accb85b53fc",
          byteLength: 3,
        },
        { path: "SKILL.md", hash: "3088e5b60779a95389e4ed08d2ecee6eaac2311c590dab3f2e4beb3090a54f00", byteLength: 6 },
      ],
    },
  });
});

test("a support-only change changes the complete revision", async () => {
  const tree = makeFilesystem();
  const first = await rawRead(folder, tree);
  tree.replace(`${folder}/resources/data.bin`, {
    kind: "file",
    bytes: Buffer.from([0, 1, 4]),
    identity: "file:changed",
  });
  const second = await rawRead(folder, tree);
  expect(first.status).toBe("complete");
  expect(second.status).toBe("complete");
  if (first.status === "complete" && second.status === "complete")
    expect(second.revision.hash).not.toBe(first.revision.hash);
});

test("added and deleted support files change the complete revision", async () => {
  const tree = makeFilesystem();
  const first = await rawRead(folder, tree);
  tree.replace(`${folder}/resources/new.bin`, { kind: "file", bytes: Buffer.from([9]), identity: "file:new" });
  const added = await rawRead(folder, tree);
  tree.nodes.delete(`${folder}/resources/new.bin`);
  const deleted = await rawRead(folder, tree);
  expect([first, added, deleted].every((read) => read.status === "complete")).toBe(true);
  if (first.status === "complete" && added.status === "complete" && deleted.status === "complete") {
    expect(added.revision.hash).not.toBe(first.revision.hash);
    expect(deleted.revision.hash).toBe(first.revision.hash);
  }
});

test("oversized children, 513 files and folders over 16 MiB return no partial revision", async () => {
  const oversized = makeFilesystem({ "SKILL.md": Buffer.from("ok"), "large.bin": new Uint8Array(1024 * 1024 + 1) });
  const tooManyFiles: Record<string, Uint8Array> = { "SKILL.md": new Uint8Array(0) };
  for (let index = 0; index < 512; index += 1) tooManyFiles[`f${index}.bin`] = new Uint8Array(0);
  const tooMany = makeFilesystem(tooManyFiles);
  const tooLargeFolderFiles: Record<string, Uint8Array> = {};
  for (let index = 0; index < 17; index += 1) tooLargeFolderFiles[`f${index}.bin`] = new Uint8Array(1024 * 1024);
  const tooLargeFolder = makeFilesystem(tooLargeFolderFiles);

  for (const tree of [oversized, tooMany, tooLargeFolder]) {
    const result = await rawRead(folder, tree);
    expect(result).toEqual({ status: "unavailable", reason: "limit" });
  }
});

test("the 32 MiB scan budget is shared across folder observations", async () => {
  const tree = makeFilesystem(
    Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`f${index}.bin`, new Uint8Array(1024 * 1024)])),
  );
  const sharedBudget = budget();
  const first = await rawRead(folder, tree, sharedBudget);
  const second = await rawRead(folder, tree, sharedBudget);
  const third = await rawRead(folder, tree, sharedBudget);
  expect(first.status).toBe("complete");
  expect(second.status).toBe("complete");
  expect(third).toEqual({ status: "unavailable", reason: "limit" });
});

test("failed folder reads still consume the shared scan budget", async () => {
  const tree = makeFilesystem(
    Object.fromEntries([
      ...Array.from({ length: 16 }, (_, index) => [`f${index}.bin`, new Uint8Array(1024 * 1024)] as const),
      ["z.bin", new Uint8Array(0)] as const,
    ]),
  );
  const originalRead = tree.filesystem.readFile;
  let reads = 0;
  tree.filesystem.readFile = async (...args) => {
    reads += 1;
    if (reads % 17 === 0) throw new SkillObservationError("io");
    return originalRead(...args);
  };
  const sharedBudget = budget();

  expect(await rawRead(folder, tree, sharedBudget)).toEqual({ status: "unavailable", reason: "io" });
  expect(await rawRead(folder, tree, sharedBudget)).toEqual({ status: "unavailable", reason: "io" });
  expect(await rawRead(folder, tree, sharedBudget)).toEqual({ status: "unavailable", reason: "limit" });
  expect(reads).toBe(34);
});

test("symlinks, special entries, unreadable children and a mid-read mutation fail closed", async () => {
  const rootSymlink = makeFilesystem();
  rootSymlink.replace(folder, { kind: "symlink", identity: "root-link" });
  const symlink = makeFilesystem();
  symlink.replace(`${folder}/resources/alias`, { kind: "symlink", identity: "link" });
  const special = makeFilesystem();
  special.replace(`${folder}/resources/socket`, { kind: "other", identity: "socket" });
  const unreadable = makeFilesystem();
  unreadable.filesystem.readFile = async (_grant, path) => {
    if (path.endsWith("data.bin")) throw new SkillObservationError("denied");
    const node = unreadable.nodes.get(path);
    return { bytes: node?.bytes ?? new Uint8Array(), identity: node?.identity ?? "" };
  };
  const changed = makeFilesystem();
  const originalRead = changed.filesystem.readFile;
  changed.filesystem.readFile = async (...args) => {
    const result = await originalRead(...args);
    const path = args[1];
    if (path.endsWith("data.bin"))
      changed.replace(path, { kind: "file", bytes: Buffer.from([9]), identity: "file:mutated" });
    return result;
  };

  expect(await rawRead(folder, symlink)).toEqual({ status: "unavailable", reason: "unsafe-tree" });
  expect(await rawRead(folder, rootSymlink)).toEqual({ status: "unavailable", reason: "unsafe-tree" });
  expect(await rawRead(folder, special)).toEqual({ status: "unavailable", reason: "unsafe-tree" });
  expect(await rawRead(folder, unreadable)).toEqual({ status: "unavailable", reason: "denied" });
  expect(await rawRead(folder, changed)).toEqual({ status: "unavailable", reason: "changed-during-read" });
});

test("missing and traversal paths return no digest", async () => {
  expect(await rawRead(".agents/skills/missing")).toEqual({ status: "unavailable", reason: "missing" });
  expect(await rawRead("../escape")).toEqual({ status: "unavailable", reason: "unsafe-tree" });
});
