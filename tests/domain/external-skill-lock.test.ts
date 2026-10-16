import { describe, expect, it } from "vitest";
import { editExternalSkillsLock, restoreExternalSkillsLock } from "../../src/domain/external-skill-lock";

const entry = {
  source: "fixture/tools",
  sourceType: "github" as const,
  skillPath: "skills/demo",
  computedHash: "a".repeat(64),
};
describe("external skill lock edits", () => {
  it("preserves unrelated bytes and existing key order and CRLF indentation", () => {
    const original =
      '{\r\n\t"version": 1,\r\n\t"skills": {\r\n\t\t"other": { "custom": true },\r\n\t\t"demo": {"source":"old/tools","computedHash":"old"}\r\n\t}\r\n}\r\n';
    const result = editExternalSkillsLock(original, new Map([["demo", entry]]));
    expect(result).toContain('\t\t"other": { "custom": true },\r\n');
    expect(Object.keys(JSON.parse(result).skills)).toEqual(["other", "demo"]);
    expect(result).toContain('\r\n\t\t\t"source": "fixture/tools"');
    expect(result.endsWith("\r\n")).toBe(true);
  });
  it.each(["__proto__", "constructor", "prototype"])("adds and replaces %s without changing any prototype", (name) => {
    const installed = editExternalSkillsLock(
      '{"version":1,"skills":{"unrelated":{"keep":1}}}',
      new Map([[name, entry]]),
    );
    const updated = editExternalSkillsLock(installed, new Map([[name, { ...entry, computedHash: "b".repeat(64) }]]));
    expect(Object.entries(JSON.parse(updated).skills)).toEqual([
      ["unrelated", { keep: 1 }],
      [name, { ...entry, computedHash: "b".repeat(64) }],
    ]);
    expect(Object.getPrototypeOf(entry)).toBe(Object.prototype);
  });
  it("creates a lock when absent", () => {
    expect(JSON.parse(editExternalSkillsLock(undefined, new Map([["demo", entry]])))).toEqual({
      version: 1,
      skills: { demo: entry },
    });
  });
  it("refuses malformed and ambiguous lock objects", () => {
    for (const text of ["{}", '{"skills":[]}', '{"skills":{},"skills":{}}', '{"skills":{"demo":{},"demo":{}}}'])
      expect(() => editExternalSkillsLock(text, new Map([["demo", entry]]))).toThrow();
  });
  it("restores its own lock entry while preserving later changes to another source", () => {
    const before = '{"version":1,"skills":{"demo":{"source":"old/tools"},"other":{"keep":1}}}';
    const after = editExternalSkillsLock(before, new Map([["demo", entry]]));
    const current = editExternalSkillsLock(after, new Map([["other", { ...entry, source: "other/tools" }]]));
    expect(JSON.parse(restoreExternalSkillsLock(current, before, after)!).skills).toEqual({
      demo: { source: "old/tools" },
      other: JSON.parse(current).skills.other,
    });
  });
  it("removes its added entry without removing an unrelated later installation", () => {
    const after = editExternalSkillsLock(undefined, new Map([["__proto__", entry]]));
    const current = editExternalSkillsLock(after, new Map([["other", entry]]));
    expect(Object.keys(JSON.parse(restoreExternalSkillsLock(current, undefined, after)!).skills)).toEqual(["other"]);
  });
  it("refuses restoring a lock entry that the owner subsequently edited", () => {
    const before = '{"version":1,"skills":{}}',
      after = editExternalSkillsLock(before, new Map([["demo", entry]]));
    const current = editExternalSkillsLock(after, new Map([["demo", { ...entry, source: "owner/tools" }]]));
    expect(() => restoreExternalSkillsLock(current, before, after)).toThrow(/changed/u);
  });
});
