import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSettingsStore } from "../../src/main/settings-store";
import { DEFAULT_AI_SETTINGS, DEFAULT_FEATURES } from "../../src/shared/settings-ipc";

const roots: string[] = [];
const legacyAi = {
  provider: "none",
  dataCategories: { marketplaceContent: true, stackFiles: true, transcripts: false, processCommands: false },
  commands: { suggest: true, explain: true, summarize: true },
};
const defaultGuard = { warnProjectIds: [] };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("settings store", () => {
  it("defaults to schema v8 and atomically persists AI, guard and library settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-settings-"));
    roots.push(root);
    const filePath = join(root, "omni", "settings.json");
    const store = createSettingsStore(filePath);
    await expect(store.read()).resolves.toEqual({
      schemaVersion: 8,
      git: { commitChanges: true },
      agents: { approval: { personalMarketplace: "conversation", projects: "conversation" }, guard: defaultGuard },
      ai: DEFAULT_AI_SETTINGS,
      features: DEFAULT_FEATURES,
      externalLibrary: { updates: "auto" },
    });
    const updatedAi = {
      connection: { preset: "openrouter" as const, displayName: "OpenRouter" },
      ...DEFAULT_AI_SETTINGS,
      dataCategories: { ...DEFAULT_AI_SETTINGS.dataCategories, stackFiles: false },
    };
    const updatedFeatures = { ...DEFAULT_FEATURES, learn: true };
    const updatedGuard = { warnProjectIds: ["project-1", "project-2"] };
    const next = await store.set({
      commitChanges: false,
      agents: { approval: { personalMarketplace: "omni", projects: "conversation" }, guard: updatedGuard },
      ai: updatedAi,
      features: updatedFeatures,
      externalLibrary: { updates: "auto" },
    });
    expect(next).toEqual({
      schemaVersion: 8,
      git: { commitChanges: false },
      agents: { approval: { personalMarketplace: "omni", projects: "conversation" }, guard: updatedGuard },
      ai: updatedAi,
      features: updatedFeatures,
      externalLibrary: { updates: "auto" },
    });
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(next);
    expect(JSON.parse(await readFile(`${filePath}.bak`, "utf8"))).toEqual(next);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it.each([
    ["none", undefined],
    ["api-key", { preset: "anthropic", displayName: "Anthropic" }],
    ["agent", undefined],
    ["local", undefined],
    ["omni-cloud", undefined],
    ["future-provider", undefined],
  ] as const)("migrates v3 provider %s to the v8 connection and defaults", async (provider, connection) => {
    const root = await mkdtemp(join(tmpdir(), `omni-settings-v3-${provider}-`));
    roots.push(root);
    const filePath = join(root, "omni", "settings.json");
    await mkdir(join(root, "omni"), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({
        schemaVersion: 3,
        git: { commitChanges: false },
        agents: { approval: { personalMarketplace: "omni", projects: "conversation" } },
        intelligence: { ...legacyAi, provider, apiKeyProvider: "anthropic" },
      }),
    );
    await expect(createSettingsStore(filePath).read()).resolves.toEqual({
      schemaVersion: 8,
      git: { commitChanges: false },
      agents: { approval: { personalMarketplace: "omni", projects: "conversation" }, guard: defaultGuard },
      ai: { ...(connection ? { connection } : {}), ...DEFAULT_AI_SETTINGS },
      features: DEFAULT_FEATURES,
      externalLibrary: { updates: "auto" },
    });
  });

  it("migrates v1 and v2 to v7 defaults, including the guard switch", async () => {
    for (const version of [1, 2]) {
      const root = await mkdtemp(join(tmpdir(), `omni-settings-v${version}-`));
      roots.push(root);
      const filePath = join(root, "omni", "settings.json");
      await mkdir(join(root, "omni"), { recursive: true });
      await writeFile(
        filePath,
        JSON.stringify({
          schemaVersion: version,
          git: { commitChanges: false },
          ...(version === 2 ? { agents: { approval: { personalMarketplace: "omni", projects: "omni" } } } : {}),
        }),
      );
      await expect(createSettingsStore(filePath).read()).resolves.toMatchObject({
        schemaVersion: 8,
        ai: DEFAULT_AI_SETTINGS,
        features: DEFAULT_FEATURES,
        agents: { guard: defaultGuard },
      });
    }
  });

  it("migrates v4 to v6 with every feature off and the guard switch defaulted, keeping the AI connection intact, and rejects an unknown or missing v6 feature key", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-settings-v4-"));
    roots.push(root);
    const filePath = join(root, "omni", "settings.json");
    await mkdir(join(root, "omni"), { recursive: true });
    const v4Ai = { ...DEFAULT_AI_SETTINGS, connection: { preset: "openrouter" as const, displayName: "OpenRouter" } };
    await writeFile(
      filePath,
      JSON.stringify({
        schemaVersion: 4,
        git: { commitChanges: true },
        agents: { approval: { personalMarketplace: "conversation", projects: "omni" } },
        ai: v4Ai,
      }),
    );
    await expect(createSettingsStore(filePath).read()).resolves.toEqual({
      schemaVersion: 8,
      git: { commitChanges: true },
      agents: { approval: { personalMarketplace: "conversation", projects: "omni" }, guard: defaultGuard },
      ai: v4Ai,
      features: DEFAULT_FEATURES,
      externalLibrary: { updates: "auto" },
    });

    const invalidFeatureRoot = await mkdtemp(join(tmpdir(), "omni-settings-v6-invalid-feature-"));
    roots.push(invalidFeatureRoot);
    const invalidFeatureFilePath = join(invalidFeatureRoot, "omni", "settings.json");
    await mkdir(join(invalidFeatureRoot, "omni"), { recursive: true });
    await writeFile(
      invalidFeatureFilePath,
      JSON.stringify({
        schemaVersion: 6,
        git: { commitChanges: true },
        agents: { approval: { personalMarketplace: "conversation", projects: "omni" }, guard: defaultGuard },
        ai: DEFAULT_AI_SETTINGS,
        features: { ...DEFAULT_FEATURES, notAFeature: true },
      }),
    );
    await expect(createSettingsStore(invalidFeatureFilePath).read()).rejects.toThrow();

    const missingFeatureRoot = await mkdtemp(join(tmpdir(), "omni-settings-v6-missing-feature-"));
    roots.push(missingFeatureRoot);
    const missingFeatureFilePath = join(missingFeatureRoot, "omni", "settings.json");
    await mkdir(join(missingFeatureRoot, "omni"), { recursive: true });
    const { learn: _learn, ...featuresMissingLearn } = DEFAULT_FEATURES;
    await writeFile(
      missingFeatureFilePath,
      JSON.stringify({
        schemaVersion: 6,
        git: { commitChanges: true },
        agents: { approval: { personalMarketplace: "conversation", projects: "omni" }, guard: defaultGuard },
        ai: DEFAULT_AI_SETTINGS,
        features: featuresMissingLearn,
      }),
    );
    await expect(createSettingsStore(missingFeatureFilePath).read()).rejects.toThrow();
  });

  it("migrates v5 to v6, defaulting the guard switch while keeping features intact", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-settings-v5-"));
    roots.push(root);
    const filePath = join(root, "omni", "settings.json");
    await mkdir(join(root, "omni"), { recursive: true });
    const v5Features = { ...DEFAULT_FEATURES, compose: true };
    await writeFile(
      filePath,
      JSON.stringify({
        schemaVersion: 5,
        git: { commitChanges: true },
        agents: { approval: { personalMarketplace: "conversation", projects: "omni" } },
        ai: DEFAULT_AI_SETTINGS,
        features: v5Features,
      }),
    );
    await expect(createSettingsStore(filePath).read()).resolves.toEqual({
      schemaVersion: 8,
      git: { commitChanges: true },
      agents: { approval: { personalMarketplace: "conversation", projects: "omni" }, guard: defaultGuard },
      ai: DEFAULT_AI_SETTINGS,
      features: v5Features,
      externalLibrary: { updates: "auto" },
    });
  });

  it("keeps an explicit v6 guard warn list as-is and rejects an unknown guard field", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-settings-v6-guard-"));
    roots.push(root);
    const filePath = join(root, "omni", "settings.json");
    await mkdir(join(root, "omni"), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({
        schemaVersion: 6,
        git: { commitChanges: true },
        agents: {
          approval: { personalMarketplace: "conversation", projects: "omni" },
          guard: { warnProjectIds: ["project-9"] },
        },
        ai: DEFAULT_AI_SETTINGS,
        features: DEFAULT_FEATURES,
      }),
    );
    await expect(createSettingsStore(filePath).read()).resolves.toMatchObject({
      agents: { guard: { warnProjectIds: ["project-9"] } },
    });

    const invalidRoot = await mkdtemp(join(tmpdir(), "omni-settings-v6-guard-invalid-"));
    roots.push(invalidRoot);
    const invalidFilePath = join(invalidRoot, "omni", "settings.json");
    await mkdir(join(invalidRoot, "omni"), { recursive: true });
    await writeFile(
      invalidFilePath,
      JSON.stringify({
        schemaVersion: 6,
        git: { commitChanges: true },
        agents: {
          approval: { personalMarketplace: "conversation", projects: "omni" },
          guard: { warnProjectIds: [], extra: true },
        },
        ai: DEFAULT_AI_SETTINGS,
        features: DEFAULT_FEATURES,
      }),
    );
    await expect(createSettingsStore(invalidFilePath).read()).rejects.toThrow();
  });

  it("rejects unknown settings and unknown v6 AI fields without writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-settings-invalid-"));
    roots.push(root);
    const store = createSettingsStore(join(root, "omni", "settings.json"));
    await expect(
      store.set({
        commitChanges: true,
        agents: { approval: { personalMarketplace: "conversation", projects: "omni" }, guard: defaultGuard },
        ai: DEFAULT_AI_SETTINGS,
        features: DEFAULT_FEATURES,
        extra: true,
        externalLibrary: { updates: "auto" },
      } as never),
    ).rejects.toThrow();
    await expect(
      store.set({
        commitChanges: true,
        agents: { approval: { personalMarketplace: "conversation", projects: "omni" }, guard: defaultGuard },
        ai: { ...DEFAULT_AI_SETTINGS, extra: true },
        features: DEFAULT_FEATURES,
        externalLibrary: { updates: "auto" },
      } as never),
    ).rejects.toThrow();
  });
});
