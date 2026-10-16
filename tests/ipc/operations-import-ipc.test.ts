import { describe, expect, it } from "vitest";

import {
  parsePathsResponse,
  parsePreviewImportRequest,
  parsePreviewRestoreRequest,
} from "../../src/shared/operations-import-ipc";

describe("import operation IPC boundary", () => {
  it("parses an import request and rejects unexpected fields", () => {
    expect(
      parsePreviewImportRequest({
        kind: "import-artifact",
        source: { kind: "project", id: "project-one", grantHandle: "grant-one" },
        relativePath: ".agents/skills/review/SKILL.md",
        target: { newPackageName: "Review Tools", description: "Skills for reviewing changes." },
      }),
    ).toEqual({
      kind: "import-artifact",
      source: { kind: "project", id: "project-one", grantHandle: "grant-one" },
      relativePath: ".agents/skills/review/SKILL.md",
      target: { newPackageName: "Review Tools", description: "Skills for reviewing changes." },
    });
    expect(() =>
      parsePreviewImportRequest({
        kind: "import-artifact",
        source: { kind: "project", id: "project-one", grantHandle: "grant-one" },
        relativePath: "review.md",
        target: { packageId: "tools" },
        extra: true,
      }),
    ).toThrow(/unexpected field/i);
    expect(
      parsePreviewImportRequest({
        kind: "import-artifact",
        source: { kind: "source", id: "source-one", grantHandle: "grant-one" },
        relativePath: "skills/review/SKILL.md",
        target: { packageId: "plugins/pstack" },
      }).target,
    ).toEqual({ packageId: "plugins/pstack" });
    expect(
      parsePreviewImportRequest({
        kind: "import-artifact",
        source: { kind: "source", id: "source-one", grantHandle: "grant-one" },
        relativePath: "skills/review/SKILL.md",
        target: {
          newPackageName: "Review Tools",
          description: "Skills for reviewing changes.",
          projectTo: ["claude-code", "codex"],
        },
      }).target,
    ).toEqual({
      newPackageName: "Review Tools",
      description: "Skills for reviewing changes.",
      projectTo: ["claude-code", "codex"],
    });
  });

  it("parses restore requests and home-relative paths", () => {
    expect(parsePreviewRestoreRequest({ kind: "restore-import", operationId: "operation-one" })).toEqual({
      kind: "restore-import",
      operationId: "operation-one",
    });
    expect(
      parsePathsResponse({
        marketplace: { displayRoot: "~/Market" },
        store: { displayRoot: "~/.config/omni/operations.json" },
      }),
    ).toEqual({
      marketplace: { displayRoot: "~/Market" },
      store: { displayRoot: "~/.config/omni/operations.json" },
    });
  });

  it.each(["/private/tmp/demo/acme-skills", "/"])("preserves the absolute display path %s", (path) => {
    expect(
      parsePathsResponse({ marketplace: { displayRoot: path }, store: { displayRoot: "~/operations.json" } }),
    ).toMatchObject({ marketplace: { displayRoot: path } });
  });

  it.each([
    "relative/path",
    "~other/path",
    "/tmp/../secret",
    "/tmp/./skills",
    "/tmp//skills",
    "/tmp/skills\nfile",
    "/tmp/skills\\file",
  ])("rejects a malformed operation display path %j", (path) => {
    expect(() => parsePathsResponse({ store: { displayRoot: path } })).toThrow();
  });
});
