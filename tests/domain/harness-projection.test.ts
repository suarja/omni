import { describe, expect, it } from "vitest";

import claudeMarketplace from "../fixtures/personal-marketplace/.claude-plugin/marketplace.json";
import codexMarketplace from "../fixtures/personal-marketplace/.agents/plugins/marketplace.json";
import { projectMarketplaceEntry, projectPluginManifest } from "../../src/domain/harness-projection";
import { createPackageManifest } from "../../src/domain/marketplace-format";

const packageManifest = createPackageManifest({
  id: "pstack",
  name: "pstack",
  version: "0.2.0",
  description: "A portable toolkit.",
  artifacts: [{ kind: "skill", path: "skills/review" }],
});

describe("harness projections", () => {
  it("projects Claude Code plugin and marketplace fields", () => {
    expect(projectPluginManifest(packageManifest, "claude-code")).toEqual({
      name: "pstack",
      version: "0.2.0",
      description: "A portable toolkit.",
    });
    expect(projectMarketplaceEntry(packageManifest, "plugins/pstack", "claude-code")).toEqual({
      name: "pstack",
      version: "0.2.0",
      description: "A portable toolkit.",
      source: "./plugins/pstack",
    });
    expect(claudeMarketplace.plugins[0]).toMatchObject({ source: "./plugins/pstack" });
  });

  it("projects Codex defaults and the skills directory", () => {
    expect(projectPluginManifest(packageManifest, "codex")).toEqual({
      name: "pstack",
      version: "0.2.0",
      description: "A portable toolkit.",
      skills: "./skills/",
    });
    expect(projectMarketplaceEntry(packageManifest, "plugins/pstack", "codex")).toEqual({
      name: "pstack",
      version: "0.2.0",
      description: "A portable toolkit.",
      source: { source: "local", path: "./plugins/pstack" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Developer Tools",
    });
    expect(codexMarketplace.plugins[0]).toMatchObject({
      source: { source: "local", path: "./plugins/pstack" },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    });
  });

  it("omits the Codex skills field when a package has no skills", () => {
    const manifest = createPackageManifest({ id: "docs", name: "Docs" });
    expect(projectPluginManifest(manifest, "codex")).toEqual({ name: "Docs", version: "0.1.0" });
  });
});
