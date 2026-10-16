import { describe, expect, it } from "vitest";
import { checkPublication } from "../../src/domain/publish-checks";

function check(content: string, path = "README.md", license = true) {
  return checkPublication({ files: [{ path, content }], hasLicense: license, homeDirectory: "/opt/owner-home" });
}
describe("publication checks", () => {
  it.each([
    "/Users/example/project",
    "/home/example/project",
    "C:\\Users\\alice\\project",
    "~/project",
    "~/.ssh/id_rsa",
    "~/.claude-other/skills",
    "/opt/owner-home/project",
  ])("blocks personal path %s with its location", (text) => {
    expect(check(`Safe introduction.\n${text}`)).toMatchObject([
      { code: "personal-path", file: "README.md", line: 2, excerpt: expect.any(String) },
    ]);
  });
  it.each([
    "-----BEGIN RSA PRIVATE KEY-----",
    "sk-abcdefghijklmnopqrstuvwxyz",
    "ghp_abcdefghijklmnopqrstuvwxyz",
    "github_pat_abcdefghijklmnopqrstuvwxyz",
    "xoxb-12345678901234567890",
    "xoxp-12345678901234567890",
    "AKIA1234567890ABCDEF",
    'api_key = "abcdefghijklmnop"',
    'token: "abcdefghijklmnop"',
    'secret="abcdefghijklmnop"',
    "token=abcdefghijklmnop1234",
  ])("blocks secret %s without exposing it", (text) => {
    const findings = check(text);
    expect(findings[0]).toMatchObject({ code: "secret", line: 1 });
    expect(findings[0]?.excerpt).not.toContain(text);
  });
  it("blocks a personal email", () =>
    expect(check(`Write to ${["ada", "company.example"].join("@")} .`)).toMatchObject([{ code: "email" }]));
  it.each([
    "alice@example.com",
    ["ada", "example.org"].join("@"),
    ["ada", "example.net"].join("@"),
    ["ada", "foo.invalid"].join("@"),
    ["ada", "foo.test"].join("@"),
    "noreply@company.io",
    "no-reply@company.io",
  ])("allows documented email %s", (text) => expect(check(text)).toEqual([]));
  it("names the French paragraph outside a fence", () =>
    expect(
      check(
        "# Guide\n\nLes fichiers sont dans le projet et vous pouvez les modifier.\nCette étape présente les règles du projet.",
      ),
    ).toMatchObject([{ code: "non-english", line: 3 }]));
  it("allows English prose, generic fenced paths and known agent dot folders", () => {
    expect(
      check(
        "# Guide\n\nUse the project files to test the application.\n\n```tsx\nsrc/app/page.tsx\nLes fichiers sont dans le projet et vous pouvez les modifier.\n```\n\nUse `~/.claude/skills` and `~/.codex/skills`, `~/.agents/skills`, `~/.config/opencode/skills`.",
      ),
    ).toEqual([]);
  });
  it("still blocks private paths and secrets in code fences", () =>
    expect(check("```sh\n/home/example/code\n```")).toMatchObject([{ code: "personal-path", line: 2 }]));
  it("blocks missing license", () =>
    expect(check("Guide", "README.md", false)).toMatchObject([{ code: "license-missing", file: "LICENSE", line: 1 }]));
  it("blocks invalid skill folders", () =>
    expect(check("# Missing frontmatter", "skills/demo/SKILL.md")).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "skill-invalid", file: "skills/demo/SKILL.md" })]),
    ));
  it("checks supporting files and missing skill roots", () =>
    expect(check("Example", "skills/demo/notes.md")).toMatchObject([{ code: "skill-invalid" }]));
});

it("redacts a secret from other findings in the same Markdown paragraph", () => {
  const secret = "sk-abcdefghijklmnopqrstuvwxyz";
  const findings = check(`Les fichiers sont dans le projet et vous pouvez les modifier. ${secret}`);
  expect(findings.some((finding) => finding.code === "non-english")).toBe(true);
  expect(JSON.stringify(findings)).not.toContain(secret);
});

it("shows only matched personal paths, one finding per literal", () => {
  const findings = check("Write to /Users/example/private/assets and `~/private/output`.");
  expect(findings.map(({ excerpt }) => excerpt)).toEqual(["/Users/example/private/assets", "~/private/output"]);
});
it("shows only a matched personal email and keeps secrets redacted in mixed findings", () => {
  expect(check(`Contact ${["ada", "company.example"].join("@")} for access.`)[0]?.excerpt).toBe(
    ["ada", "company.example"].join("@"),
  );
  expect(JSON.stringify(check("Use /Users/example/private with sk-abcdefghijklmnopqrstuvwxyz"))).not.toContain(
    "sk-abcdefghijklmnopqrstuvwxyz",
  );
});
