import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import claudeMarketplaceFixture from "../fixtures/personal-marketplace/.claude-plugin/marketplace.json";
import codexMarketplaceFixture from "../fixtures/personal-marketplace/.agents/plugins/marketplace.json";
import { detectSourceLayout } from "../../src/adapters/inventory/source-layout";
import { createLocalInventoryPort } from "../../src/adapters/inventory/local-filesystem";
import { OPERATIONS_IPC_CHANNELS } from "../../src/shared/operations-ipc";
import { REGISTRY_IPC_CHANNELS } from "../../src/shared/registry-ipc";
import { invoke, setup } from "./operations-import-helpers";

// Real git repositories on temp roots: generous timeout so parallel workers never flake.
vi.setConfig({ testTimeout: 20000, hookTimeout: 20000 });
describe("import artifact operation", () => {
  it("births an Omni manifest in an existing dual-harness package without rewriting harness files", async () => {
    const fixture = await setup({ adopt: true });
    await mkdir(join(fixture.marketplace, "plugins", "pstack", "skills", "existing"), { recursive: true });
    await mkdir(join(fixture.marketplace, "plugins", "pstack", ".claude-plugin"), { recursive: true });
    await writeFile(
      join(fixture.marketplace, "plugins", "pstack", ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "pstack", version: "0.2.0", description: "Claude package." }),
      "utf8",
    );
    await mkdir(join(fixture.marketplace, "plugins", "pstack", ".codex-plugin"), { recursive: true });
    await writeFile(
      join(fixture.marketplace, "plugins", "pstack", ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "pstack", version: "0.2.0", description: "Codex package." }),
      "utf8",
    );
    await writeFile(
      join(fixture.marketplace, "plugins", "pstack", "skills", "existing", "SKILL.md"),
      "# Existing\n",
      "utf8",
    );
    const claudeMarketplace = { ...claudeMarketplaceFixture, plugins: [] };
    const codexMarketplace = { ...codexMarketplaceFixture, plugins: [] };
    const claudePath = join(fixture.marketplace, ".claude-plugin", "marketplace.json");
    const codexPath = join(fixture.marketplace, ".agents", "plugins", "marketplace.json");
    await mkdir(join(fixture.marketplace, ".claude-plugin"), { recursive: true });
    await mkdir(join(fixture.marketplace, ".agents", "plugins"), { recursive: true });
    await writeFile(claudePath, JSON.stringify(claudeMarketplace, null, 2).concat("\n"), "utf8");
    await writeFile(codexPath, JSON.stringify(codexMarketplace, null, 2).concat("\n"), "utf8");
    const beforeClaude = await readFile(claudePath, "utf8");
    const beforeCodex = await readFile(codexPath, "utf8");

    const preview = (await invoke(OPERATIONS_IPC_CHANNELS.preview, {
      kind: "import-artifact",
      source: { kind: "source", id: fixture.sourceId, grantHandle: fixture.grantHandle },
      relativePath: "skills/review/SKILL.md",
      target: { packageId: "plugins/pstack" },
    })) as { status: string; plan: { planId: string; actions: readonly Record<string, unknown>[] } };
    expect(preview.status).toBe("ready");
    expect(preview.plan).toMatchObject({ visibleIn: ["omni", "claude-code", "codex"] });
    expect(preview.plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: "plugins/pstack/omni.plugin.json", manifest: true }),
        expect.objectContaining({ relativePath: "plugins/pstack/skills/review/SKILL.md" }),
      ]),
    );
    expect(preview.plan.actions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: ".claude-plugin/marketplace.json" }),
        expect.objectContaining({ relativePath: ".agents/plugins/marketplace.json" }),
      ]),
    );

    const applied = (await invoke(OPERATIONS_IPC_CHANNELS.apply, { planId: preview.plan.planId })) as {
      status: string;
      receipt: { operationId: string };
    };
    expect(applied.status).toBe("applied");
    const packageManifest = JSON.parse(
      await readFile(join(fixture.marketplace, "plugins", "pstack", "omni.plugin.json"), "utf8"),
    ) as { artifacts: unknown[] };
    expect(packageManifest.artifacts).toEqual([
      { kind: "skill", path: "skills/existing" },
      expect.objectContaining({
        kind: "skill",
        path: "skills/review",
        provenance: expect.objectContaining({ contentHash: expect.any(String) }),
      }),
    ]);
    expect(await readFile(claudePath, "utf8")).toBe(beforeClaude);
    expect(await readFile(codexPath, "utf8")).toBe(beforeCodex);
    const observed = await detectSourceLayout(createLocalInventoryPort(fixture.marketplace), "source");
    expect(observed.packages).toEqual(
      expect.arrayContaining([expect.objectContaining({ relativeRoot: "plugins/pstack" })]),
    );
    expect(observed.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: "plugins/pstack/skills/review/SKILL.md", packageId: "plugins/pstack" }),
      ]),
    );

    // Restoring removes only what the import created: the pre-existing package folder and skills stay.
    const restorePreview = (await invoke(OPERATIONS_IPC_CHANNELS.preview, {
      kind: "restore-import",
      operationId: applied.receipt.operationId,
    })) as { status: string; plan: { planId: string; actions: readonly { kind: string; relativePath: string }[] } };
    expect(restorePreview.status).toBe("ready");
    expect(restorePreview.plan.actions.map((action) => `${action.kind} ${action.relativePath}`)).not.toContain(
      "delete-directory plugins/pstack",
    );
    const restored = (await invoke(OPERATIONS_IPC_CHANNELS.apply, { planId: restorePreview.plan.planId })) as {
      status: string;
      receipt: { git: { commit?: string } };
    };
    expect(restored.status).toBe("applied");
    expect(restored.receipt.git.commit).toMatch(/^[0-9a-f]{7,}/);
    await expect(
      stat(join(fixture.marketplace, "plugins", "pstack", "skills", "existing", "SKILL.md")),
    ).resolves.toBeDefined();
    await expect(stat(join(fixture.marketplace, "plugins", "pstack", "skills", "review"))).rejects.toThrow();
    await expect(stat(join(fixture.marketplace, "plugins", "pstack", "omni.plugin.json"))).rejects.toThrow();
    expect(await readFile(claudePath, "utf8")).toBe(beforeClaude);
  });

  it("projects a new package into both existing harness marketplaces and restores every projection", async () => {
    const fixture = await setup({ adopt: true });
    const claudePath = join(fixture.marketplace, ".claude-plugin", "marketplace.json");
    const codexPath = join(fixture.marketplace, ".agents", "plugins", "marketplace.json");
    await mkdir(join(fixture.marketplace, ".claude-plugin"), { recursive: true });
    await mkdir(join(fixture.marketplace, ".agents", "plugins"), { recursive: true });
    await writeFile(
      claudePath,
      JSON.stringify({ ...claudeMarketplaceFixture, plugins: [] }, null, 2).concat("\n"),
      "utf8",
    );
    await writeFile(
      codexPath,
      JSON.stringify({ ...codexMarketplaceFixture, plugins: [] }, null, 2).concat("\n"),
      "utf8",
    );
    const preview = (await invoke(OPERATIONS_IPC_CHANNELS.preview, {
      kind: "import-artifact",
      source: { kind: "source", id: fixture.sourceId, grantHandle: fixture.grantHandle },
      relativePath: "skills/review/SKILL.md",
      target: {
        newPackageName: "Review Tools",
        description: "Skills for reviewing changes.",
        projectTo: ["claude-code", "codex"],
      },
    })) as { status: string; plan: { planId: string; visibleIn?: readonly string[] } };
    expect(preview).toMatchObject({ status: "ready", plan: { visibleIn: ["omni", "claude-code", "codex"] } });
    await expect(invoke(OPERATIONS_IPC_CHANNELS.apply, { planId: preview.plan.planId })).resolves.toMatchObject({
      status: "applied",
      receipt: {
        manifests: expect.arrayContaining([
          expect.objectContaining({ relativePath: "packages/review-tools/.claude-plugin/plugin.json" }),
          expect.objectContaining({ relativePath: "packages/review-tools/.codex-plugin/plugin.json" }),
          expect.objectContaining({ relativePath: ".claude-plugin/marketplace.json" }),
          expect.objectContaining({ relativePath: ".agents/plugins/marketplace.json" }),
        ]),
      },
    });
    expect(
      JSON.parse(await readFile(join(fixture.marketplace, ".claude-plugin", "marketplace.json"), "utf8")).plugins,
    ).toEqual([expect.objectContaining({ name: "Review Tools", source: "./packages/review-tools" })]);
    expect(
      JSON.parse(await readFile(join(fixture.marketplace, ".agents", "plugins", "marketplace.json"), "utf8")).plugins,
    ).toEqual([
      expect.objectContaining({ name: "Review Tools", source: { source: "local", path: "./packages/review-tools" } }),
    ]);
    expect(
      JSON.parse(
        await readFile(join(fixture.marketplace, "packages", "review-tools", ".claude-plugin", "plugin.json"), "utf8"),
      ),
    ).toMatchObject({ name: "Review Tools", version: "0.1.0" });
    expect(
      JSON.parse(
        await readFile(join(fixture.marketplace, "packages", "review-tools", ".codex-plugin", "plugin.json"), "utf8"),
      ),
    ).toMatchObject({ name: "Review Tools", version: "0.1.0", skills: "./skills/" });

    const applied = (await invoke(OPERATIONS_IPC_CHANNELS.list)) as { receipts: readonly { operationId: string }[] };
    const restorePreview = (await invoke(OPERATIONS_IPC_CHANNELS.preview, {
      kind: "restore-import",
      operationId: applied.receipts[0]!.operationId,
    })) as { plan: { planId: string } };
    await expect(invoke(OPERATIONS_IPC_CHANNELS.apply, { planId: restorePreview.plan.planId })).resolves.toMatchObject({
      status: "applied",
    });
    expect(JSON.parse(await readFile(claudePath, "utf8")).plugins).toEqual([]);
    expect(JSON.parse(await readFile(codexPath, "utf8")).plugins).toEqual([]);
    await expect(stat(join(fixture.marketplace, "packages", "review-tools"))).rejects.toThrow();
  });

  it("blocks a requested projection when its root marketplace manifest is absent", async () => {
    const fixture = await setup({ adopt: true });
    await expect(
      invoke(OPERATIONS_IPC_CHANNELS.preview, {
        kind: "import-artifact",
        source: { kind: "source", id: fixture.sourceId, grantHandle: fixture.grantHandle },
        relativePath: "skills/review/SKILL.md",
        target: { newPackageName: "Review Tools", description: "Skills for reviewing changes.", projectTo: ["codex"] },
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      reason: "harness-marketplace-missing",
      diagnostic: expect.stringMatching(/Codex/i),
    });
  });

  it("previews a skill folder with every file, manifests, and repository commit mode", async () => {
    const fixture = await setup();
    const response = (await invoke(OPERATIONS_IPC_CHANNELS.preview, {
      kind: "import-artifact",
      source: { kind: "source", id: fixture.sourceId, grantHandle: fixture.grantHandle },
      relativePath: "skills/review/SKILL.md",
      target: { packageId: "tools" },
    })) as {
      status: string;
      plan?: { kind: string; git: { mode: string }; actions: readonly Record<string, unknown>[] };
    };
    expect(response.status).toBe("ready");
    expect(response.plan).toMatchObject({
      kind: "import-artifact",
      displayTarget: "packages/tools",
      git: { mode: "commit" },
    });
    expect(response.plan?.actions).toEqual(
      expect.arrayContaining([
        { kind: "create-directory", relativePath: "packages/tools/skills/review" },
        { kind: "write-file", relativePath: "packages/tools/skills/review/SKILL.md", byteLength: 9 },
        { kind: "write-file", relativePath: "packages/tools/skills/review/references/notes.md", byteLength: 6 },
        expect.objectContaining({
          kind: "write-file",
          relativePath: "packages/tools/omni.plugin.json",
          manifest: true,
        }),
        expect.objectContaining({ kind: "write-file", relativePath: "omni.marketplace.json", manifest: true }),
      ]),
    );
    expect(JSON.stringify(response)).not.toContain(fixture.marketplace);
  });

  it("captures a single-file skill into a folder in the marketplace", async () => {
    const fixture = await setup({ singleFile: true });
    const preview = (await invoke(OPERATIONS_IPC_CHANNELS.preview, {
      kind: "import-artifact",
      source: { kind: "source", id: fixture.sourceId, grantHandle: fixture.grantHandle },
      relativePath: "skills/review/SKILL.md",
      target: { packageId: "tools" },
    })) as { status: string; plan: { planId: string; actions: readonly { kind: string; relativePath: string }[] } };

    expect(preview.status).toBe("ready");
    expect(preview.plan.actions).toEqual(
      expect.arrayContaining([
        { kind: "create-directory", relativePath: "packages/tools/skills/review" },
        expect.objectContaining({ kind: "write-file", relativePath: "packages/tools/skills/review/SKILL.md" }),
      ]),
    );
    const applied = (await invoke(OPERATIONS_IPC_CHANNELS.apply, { planId: preview.plan.planId })) as {
      status: string;
      receipt: { operationId: string };
    };
    expect(applied.status).toBe("applied");
    await expect(stat(join(fixture.marketplace, "packages/tools/skills/review"))).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
    expect(await readFile(join(fixture.marketplace, "packages/tools/skills/review/SKILL.md"), "utf8")).toBe(
      "# Review\n",
    );
    const restore = (await invoke(OPERATIONS_IPC_CHANNELS.preview, {
      kind: "restore-import",
      operationId: applied.receipt.operationId,
    })) as { status: string; plan: { planId: string } };
    expect(restore.status).toBe("ready");
    await expect(invoke(OPERATIONS_IPC_CHANNELS.apply, { planId: restore.plan.planId })).resolves.toMatchObject({
      status: "applied",
    });
    await expect(stat(join(fixture.marketplace, "packages/tools/skills/review"))).rejects.toThrow();
  });

  it("applies an import, records hashes, and creates backups", async () => {
    const fixture = await setup();
    const preview = (await invoke(OPERATIONS_IPC_CHANNELS.preview, {
      kind: "import-artifact",
      source: { kind: "source", id: fixture.sourceId, grantHandle: fixture.grantHandle },
      relativePath: "skills/review/SKILL.md",
      target: { packageId: "tools" },
    })) as { plan: { planId: string } };
    const result = (await invoke(OPERATIONS_IPC_CHANNELS.apply, { planId: preview.plan.planId })) as {
      status: string;
      receipt: { operationId: string; files?: unknown[]; manifests?: unknown[]; git: { commit?: string } };
    };
    expect(result).toMatchObject({
      status: "applied",
      receipt: {
        git: { commit: expect.stringMatching(/^[0-9a-f]{40}$/) },
        files: expect.any(Array),
        manifests: expect.any(Array),
      },
    });
    expect(
      (await stat(join(fixture.marketplace, "packages", "tools", "skills", "review", "SKILL.md"))).mode & 0o777,
    ).toBe(0o644);
    expect(
      JSON.parse(await readFile(join(fixture.marketplace, "packages", "tools", "omni.plugin.json"), "utf8")),
    ).toMatchObject({ artifacts: [{ kind: "skill", path: "skills/review" }] });
    expect(
      JSON.parse(await readFile(join(fixture.marketplace, "packages", "tools", "omni.plugin.json"), "utf8")),
    ).toMatchObject({ artifacts: [{ provenance: { contentHash: expect.stringMatching(/^[0-9a-f]{64}$/) } }] });
    expect(
      await stat(join(fixture.userDataPath, "omni", "backups", result.receipt.operationId, "omni.marketplace.json")),
    ).toBeDefined();
  });

  it("previews and applies restore, then blocks a drifted import", async () => {
    const fixture = await setup();
    const preview = (await invoke(OPERATIONS_IPC_CHANNELS.preview, {
      kind: "import-artifact",
      source: { kind: "source", id: fixture.sourceId, grantHandle: fixture.grantHandle },
      relativePath: "skills/review/SKILL.md",
      target: { packageId: "tools" },
    })) as { plan: { planId: string } };
    const applied = (await invoke(OPERATIONS_IPC_CHANNELS.apply, { planId: preview.plan.planId })) as {
      receipt: { operationId: string };
    };
    const restore = (await invoke(OPERATIONS_IPC_CHANNELS.preview, {
      kind: "restore-import",
      operationId: applied.receipt.operationId,
    })) as { status: string; plan?: { planId: string } };
    expect(restore).toMatchObject({ status: "ready", plan: { kind: "restore-import" } });
    const restored = await invoke(OPERATIONS_IPC_CHANNELS.apply, { planId: restore.plan!.planId });
    expect(restored).toMatchObject({ status: "applied", receipt: { restores: applied.receipt.operationId } });
    await expect(stat(join(fixture.marketplace, "packages", "tools", "skills", "review"))).rejects.toThrow();
  });

  it("blocks restore when a created file has drifted", async () => {
    const fixture = await setup();
    const preview = (await invoke(OPERATIONS_IPC_CHANNELS.preview, {
      kind: "import-artifact",
      source: { kind: "source", id: fixture.sourceId, grantHandle: fixture.grantHandle },
      relativePath: "skills/review/SKILL.md",
      target: { packageId: "packages/tools" },
    })) as { plan: { planId: string } };
    const applied = (await invoke(OPERATIONS_IPC_CHANNELS.apply, { planId: preview.plan.planId })) as {
      receipt: { operationId: string };
    };
    await writeFile(
      join(fixture.marketplace, "packages", "tools", "skills", "review", "SKILL.md"),
      "drifted\n",
      "utf8",
    );
    await expect(
      invoke(OPERATIONS_IPC_CHANNELS.preview, { kind: "restore-import", operationId: applied.receipt.operationId }),
    ).resolves.toMatchObject({ status: "blocked", reason: "restore-drift" });
  });

  it("blocks escape paths and grant mismatches", async () => {
    const fixture = await setup();
    await expect(
      invoke(OPERATIONS_IPC_CHANNELS.preview, {
        kind: "import-artifact",
        source: { kind: "source", id: fixture.sourceId, grantHandle: fixture.grantHandle },
        relativePath: "../outside",
        target: { packageId: "tools" },
      }),
    ).resolves.toMatchObject({ status: "blocked", reason: "artifact-unavailable" });
    await expect(
      invoke(OPERATIONS_IPC_CHANNELS.preview, {
        kind: "import-artifact",
        source: { kind: "source", id: fixture.sourceId, grantHandle: "other-grant" },
        relativePath: "skills/review/SKILL.md",
        target: { packageId: "tools" },
      }),
    ).resolves.toMatchObject({ status: "blocked", reason: "source-grant-invalid" });
  });

  it("names a catalogue skill's real origin in the package manifest (Brief 34b provenance passthrough)", async () => {
    // What "Add to my marketplace..." from the Catalogue tab actually leaves behind
    // (`src/main/catalogue/cache.ts`'s `prepareCatalogueImportFiles`) alongside the fetched
    // SKILL.md: a sidecar `src/main/operations-import.ts` reads, read-only, to replace the cache
    // folder's basename with the skill's real skills.sh origin in the resulting manifest.
    const fixture = await setup();
    await writeFile(
      join(fixture.source, ".omni-catalogue-provenance.json"),
      JSON.stringify({
        source: "skills.sh",
        ownerRepo: "anthropics/skills",
        skill: "review",
        url: "https://raw.githubusercontent.com/anthropics/skills/HEAD/skills/review/SKILL.md",
        hash: "deadbeef",
      }),
      "utf8",
    );
    const preview = (await invoke(OPERATIONS_IPC_CHANNELS.preview, {
      kind: "import-artifact",
      source: { kind: "source", id: fixture.sourceId, grantHandle: fixture.grantHandle },
      relativePath: "skills/review/SKILL.md",
      target: { packageId: "tools" },
    })) as { status: string; plan: { planId: string } };
    expect(preview.status).toBe("ready");
    await expect(invoke(OPERATIONS_IPC_CHANNELS.apply, { planId: preview.plan.planId })).resolves.toMatchObject({
      status: "applied",
    });
    const manifest = JSON.parse(
      await readFile(join(fixture.marketplace, "packages", "tools", "omni.plugin.json"), "utf8"),
    );
    expect(manifest.artifacts[0].provenance.source).toBe("anthropics/skills");
    expect(manifest.artifacts[0].provenance.reason).toContain("anthropics/skills/review");
    expect(manifest.artifacts[0].provenance.reason).toContain(
      "https://raw.githubusercontent.com/anthropics/skills/HEAD/skills/review/SKILL.md",
    );
    expect(manifest.artifacts[0].provenance.reason).toContain("sha256:deadbeef");
  });

  it("ignores a malformed catalogue provenance marker instead of failing the import", async () => {
    const fixture = await setup();
    await writeFile(join(fixture.source, ".omni-catalogue-provenance.json"), "{ not json", "utf8");
    const preview = (await invoke(OPERATIONS_IPC_CHANNELS.preview, {
      kind: "import-artifact",
      source: { kind: "source", id: fixture.sourceId, grantHandle: fixture.grantHandle },
      relativePath: "skills/review/SKILL.md",
      target: { packageId: "tools" },
    })) as { status: string; plan: { planId: string } };
    expect(preview.status).toBe("ready");
    await expect(invoke(OPERATIONS_IPC_CHANNELS.apply, { planId: preview.plan.planId })).resolves.toMatchObject({
      status: "applied",
    });
    const manifest = JSON.parse(
      await readFile(join(fixture.marketplace, "packages", "tools", "omni.plugin.json"), "utf8"),
    );
    expect(manifest.artifacts[0].provenance.source).not.toContain("skills.sh");
    expect(manifest.artifacts[0].provenance.reason).toBeUndefined();
  });
});
