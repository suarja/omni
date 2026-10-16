import { describe, expect, it } from "vitest";

import { parsePreviewOperationRequest } from "../../src/shared/operations-ipc";
import { parseWriteSkillRequest } from "../../src/shared/operations-write-skill-ipc";

describe("write-skill operation IPC", () => {
  it("parses bounded create and update requests", () => {
    expect(
      parseWriteSkillRequest({
        kind: "write-skill",
        sourceId: "personal-source",
        packageId: "packages/pstack",
        mode: "create",
        folderName: "lesson-capture",
        files: [{ path: "SKILL.md", content: "---\nname: lesson-capture\n---\n" }],
        reason: "Capture the lesson from the session.",
      }),
    ).toMatchObject({ mode: "create", folderName: "lesson-capture" });
    expect(
      parsePreviewOperationRequest({
        kind: "write-skill",
        sourceId: "personal-source",
        packageId: "packages/pstack",
        mode: "update",
        folderName: "lesson-capture",
        files: [{ path: "SKILL.md", content: "updated" }],
        replaceFolder: true,
      }),
    ).toMatchObject({ kind: "write-skill", mode: "update", replaceFolder: true });
  });

  it("rejects unsafe paths, duplicate files, and oversized requests", () => {
    expect(() =>
      parseWriteSkillRequest({
        kind: "write-skill",
        sourceId: "source",
        packageId: "packages/pstack",
        mode: "create",
        folderName: "lesson-capture",
        files: [{ path: "../escape.md", content: "bad" }],
      }),
    ).toThrow();
    expect(() =>
      parseWriteSkillRequest({
        kind: "write-skill",
        sourceId: "source",
        packageId: "packages/pstack",
        mode: "create",
        folderName: "lesson-capture",
        files: [
          { path: "SKILL.md", content: "one" },
          { path: "SKILL.md", content: "two" },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseWriteSkillRequest({
        kind: "write-skill",
        sourceId: "source",
        packageId: "packages/pstack",
        mode: "create",
        folderName: "lesson-capture",
        files: [{ path: "SKILL.md", content: "x".repeat(256 * 1024 + 1) }],
      }),
    ).toThrow();
  });

  it("accepts canonical bounded binary deltas while keeping legacy UTF-8 files unchanged", () => {
    const binary = Buffer.from([0, 255, 17, 128]).toString("base64");
    const request = parseWriteSkillRequest({
      kind: "write-skill",
      sourceId: "source",
      packageId: "packages/tools",
      mode: "update",
      folderName: "lesson-capture",
      files: [
        { path: "SKILL.md", content: "---\nname: lesson-capture\n---\n" },
        { path: "assets/icon.bin", contentBase64: binary },
      ],
    });

    expect(request.files[0]).toEqual({ path: "SKILL.md", content: "---\nname: lesson-capture\n---\n" });
    expect(request.files[1]).toEqual({ path: "assets/icon.bin", content: binary, encoding: "base64" });
    expect(Buffer.from(request.files[1]!.content, "base64")).toEqual(Buffer.from([0, 255, 17, 128]));
    expect(() =>
      parseWriteSkillRequest({
        kind: "write-skill",
        sourceId: "source",
        packageId: "packages/tools",
        mode: "update",
        folderName: "lesson-capture",
        files: [{ path: "assets/icon.bin", contentBase64: "AQ" }],
      }),
    ).toThrow(/canonical base64/u);
    expect(() =>
      parseWriteSkillRequest({
        kind: "write-skill",
        sourceId: "source",
        packageId: "packages/tools",
        mode: "update",
        folderName: "lesson-capture",
        files: [{ path: "assets/icon.bin", contentBase64: Buffer.alloc(256 * 1024 + 1).toString("base64") }],
      }),
    ).toThrow(/too large/u);
  });
});
