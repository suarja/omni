import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSettingsStore } from "../../src/main/settings-store";
import { DEFAULT_AI_SETTINGS, DEFAULT_FEATURES, parseSettingsSetRequest } from "../../src/shared/settings-ipc";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("settings IPC contract", () => {
  it("migrates v3 intelligence to v4 AI settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "omni-settings-ipc-v3-"));
    roots.push(root);
    const filePath = join(root, "omni", "settings.json");
    await mkdir(join(root, "omni"), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({
        schemaVersion: 3,
        git: { commitChanges: false },
        agents: { approval: { personalMarketplace: "conversation", projects: "omni" } },
        intelligence: { provider: "api-key", apiKeyProvider: "anthropic", ...DEFAULT_AI_SETTINGS },
      }),
    );
    await expect(createSettingsStore(filePath).read()).resolves.toMatchObject({
      schemaVersion: 8,
      ai: { connection: { preset: "anthropic" } },
      features: DEFAULT_FEATURES,
      agents: { guard: { warnProjectIds: [] } },
    });
  });

  it("accepts strict v7 fields and rejects unknown fields", () => {
    const request = {
      commitChanges: true,
      agents: {
        approval: { personalMarketplace: "omni" as const, projects: "conversation" as const },
        guard: { warnProjectIds: [] },
      },
      ai: DEFAULT_AI_SETTINGS,
      features: DEFAULT_FEATURES,
      externalLibrary: { updates: "auto" as const },
    };
    expect(parseSettingsSetRequest(request)).toEqual(request);
    expect(() => parseSettingsSetRequest({ ...request, ai: { ...request.ai, unexpected: true } })).toThrow();
    expect(() =>
      parseSettingsSetRequest({ ...request, features: { ...request.features, unexpected: true } }),
    ).toThrow();
    expect(() => parseSettingsSetRequest({ ...request, extra: true })).toThrow();
  });

  it("accepts an explicit model route with provider-style slashes", () => {
    const request = parseSettingsSetRequest({
      commitChanges: true,
      agents: { approval: { personalMarketplace: "omni", projects: "conversation" }, guard: { warnProjectIds: [] } },
      ai: {
        ...DEFAULT_AI_SETTINGS,
        functions: { ...DEFAULT_AI_SETTINGS.functions, explain: { modelId: "openrouter/anthropic/claude-sonnet-5" } },
      },
      features: DEFAULT_FEATURES,
      externalLibrary: { updates: "auto" },
    });
    expect(request.ai.functions.explain).toEqual({ modelId: "openrouter/anthropic/claude-sonnet-5" });
  });
});
