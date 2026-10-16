import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { scanInventory } from "../../src/application/inventory";
import { parseInventorySnapshot } from "../../src/shared/inventory-dto";
import {
  InventoryFilesystemError,
  type InventoryDirectoryEntry,
  type InventoryFilesystemPort,
} from "../../src/ports/inventory";

type MemoryFiles = Readonly<Record<string, string>>;

function createMemoryFilesystem(files: MemoryFiles): InventoryFilesystemPort {
  const filePaths = new Set(Object.keys(files));
  const directoryPaths = new Set<string>([""]);
  for (const path of filePaths) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directoryPaths.add(segments.slice(0, index).join("/"));
    }
  }
  const missing = (operation: string, path: string): InventoryFilesystemError =>
    new InventoryFilesystemError(operation, path, "not-found", "path does not exist");
  const entries = (path: string): readonly InventoryDirectoryEntry[] => {
    const prefix = path ? `${path}/` : "";
    const names = new Map<string, InventoryDirectoryEntry>();
    for (const filePath of filePaths) {
      if (!filePath.startsWith(prefix)) continue;
      const remainder = filePath.slice(prefix.length);
      const name = remainder.split("/", 1)[0];
      names.set(name, { name, type: remainder.includes("/") ? "directory" : "file" });
    }
    for (const directoryPath of directoryPaths) {
      if (!directoryPath.startsWith(prefix)) continue;
      const remainder = directoryPath.slice(prefix.length);
      if (!remainder || remainder.includes("/")) continue;
      names.set(remainder, { name: remainder, type: "directory" });
    }
    return [...names.values()];
  };

  return {
    async lstat(path) {
      if (filePaths.has(path)) return { path, type: "file", size: Buffer.byteLength(files[path], "utf8") };
      if (directoryPaths.has(path)) return { path, type: "directory", size: 0 };
      throw missing("lstat", path);
    },
    async listDirectory(path) {
      if (!directoryPaths.has(path)) throw missing("listDirectory", path);
      return entries(path);
    },
    async readlink(path) {
      throw missing("readlink", path);
    },
    async realpathEvidence(path) {
      if (!filePaths.has(path) && !directoryPaths.has(path)) throw missing("realpath", path);
      return { path, status: "inside-root", realpath: path || "root" };
    },
    async readText(path) {
      if (!filePaths.has(path)) throw missing("readText", path);
      return files[path];
    },
    async readBytes(path) {
      if (!filePaths.has(path)) throw missing("readBytes", path);
      return Buffer.from(files[path]!, "utf8");
    },
    async hash(path) {
      if (!filePaths.has(path)) throw missing("hash", path);
      return createHash("sha256").update(files[path], "utf8").digest("hex");
    },
  };
}

describe("inventory application metadata composition", () => {
  it("preserves marketplace, package, and artifact descriptions through a source snapshot", async () => {
    const filesystem = createMemoryFilesystem({
      ".claude-plugin/marketplace.json": JSON.stringify({
        name: "Claude Plugins",
        description: "A local plugin marketplace",
        plugins: [
          {
            path: "./plugins/alpha",
            description: "Alpha plugin",
            version: "1.2.3",
          },
        ],
      }),
      "README.md": "# Claude Plugins\n",
      "plugins/alpha/README.md": "# Alpha\n",
      "plugins/alpha/.claude-plugin/plugin.json": JSON.stringify({ name: "Alpha" }),
      "plugins/alpha/skills/one/SKILL.md": "---\nname: one\ndescription: One skill\n---\n",
      "plugins/alpha/commands/go.md": "---\ndescription: Go command\n---\n",
    });
    const snapshot = await scanInventory(
      {
        approvedRoot: "/virtual/claude-plugins",
        rootHandle: "grant-source",
        displayRoot: "claude-plugins",
        scope: "source",
        observedAt: "2026-09-13T10:00:00.000Z",
      },
      {
        filesystem,
        git: {
          async collect() {
            return { scopes: [], diagnostics: [] };
          },
        },
      },
    );

    expect(snapshot.marketplace).toEqual({
      name: "Claude Plugins",
      description: "A local plugin marketplace",
      readmePath: "README.md",
      manifestPath: ".claude-plugin/marketplace.json",
    });
    expect(snapshot.packages).toEqual([
      expect.objectContaining({
        relativeRoot: "plugins/alpha",
        description: "Alpha plugin",
        version: "1.2.3",
        readmePath: "plugins/alpha/README.md",
      }),
    ]);
    expect(snapshot.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: "plugins/alpha/skills/one/SKILL.md", summary: "One skill" }),
        expect.objectContaining({ relativePath: "plugins/alpha/commands/go.md", summary: "Go command" }),
      ]),
    );
    expect(parseInventorySnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  });
});
