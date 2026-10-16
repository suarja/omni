import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTree } from "./check.mjs";

const roots = [];
const manifest = { exclusions: ["docs/private", "private-terms.txt"], imageAllowlist: ["approved.png"] };
async function tree(files) {
  const root = await mkdtemp(join(tmpdir(), "public-check-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it("accepts synthetic homes, example email and Git transports", async () => {
  const root = await tree({
    "README.md":
      "/Users/example/app /home/example/app ada@example.com git@github.com:acme/tools.git ssh://git@github.com/acme/tools https://token@github.com/acme/tools no-reply@company.io",
  });
  expect(await checkTree(root, manifest, ["private-project"])).toEqual([]);
});
it.each([
  ["private-project", "private-term"],
  ["PRIVATE-PROJECT", "private-term"],
  [["", "Users", "ada", "app"].join("/"), "home-path"],
  [["", "home", "ada"].join("/"), "home-path"],
  [["", "Users", "example-other", "app"].join("/"), "home-path"],
  [["ada", "company.io"].join("@"), "email"],
  [["ada", "example.org"].join("@"), "email"],
  ["![secret](docs/private/screen.png)", "excluded-link"],
  ["[secret](./docs/%70rivate/notes.md#section)", "excluded-link"],
  ['<img src="/docs/private/screen.png">', "excluded-link"],
  ["[secret]: docs/private/notes.md", "excluded-link"],
])("locates an unsafe literal on its physical line: %s", async (literal, rule) => {
  const root = await tree({ "README.md": `Safe\n${literal}\n` });
  expect(await checkTree(root, manifest, ["private-project"])).toContainEqual(
    expect.objectContaining({ file: "README.md", line: 2, rule }),
  );
});
it("resolves links against the containing page and catches root-relative links", async () => {
  const root = await tree({ "docs/guide/README.md": "[one](../private/a.md)\n[two](/docs/private/b.md)" });
  expect((await checkTree(root, manifest, [])).filter((f) => f.rule === "excluded-link")).toHaveLength(2);
});
it("checks names, binary strings, excluded files, unapproved images and size", async () => {
  const root = await tree({
    "private-project.txt": "safe",
    "data.bin": Buffer.from("\0PRIVATE-PROJECT"),
    "docs/private/notes.md": "safe",
    "shot.PNG": Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    "hidden.dat": Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    "large.bin": Buffer.alloc(5 * 1024 * 1024 + 1),
  });
  const findings = await checkTree(root, manifest, ["private-project"]);
  for (const rule of ["private-term", "excluded-path", "image", "size"])
    expect(findings.some((f) => f.rule === rule)).toBe(true);
  expect(findings.filter((f) => f.rule === "image")).toHaveLength(2);
  expect(findings.some((f) => f.file === "data.bin" && f.rule === "private-term")).toBe(true);
});
it("accepts only explicitly approved images", async () => {
  expect(
    await checkTree(await tree({ "approved.png": Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) }), manifest, []),
  ).toEqual([]);
});
it("refuses symbolic links without reading their destination", async () => {
  const root = await tree({ "safe.txt": "safe" });
  await symlink("safe.txt", join(root, "link"));
  expect(await checkTree(root, manifest, [])).toContainEqual(
    expect.objectContaining({ file: "link", rule: "file-type" }),
  );
});
it("finds excluded links containing spaces, HTML without quotes and encoded traversal", async () => {
  const policy = { exclusions: ["docs/private", "docs/Private boards"], imageAllowlist: [] };
  const root = await tree({
    "README.md":
      "[board](<docs/Private boards/a.html>)\n<img src=docs/private/a.png>\n[one](docs/guide/%2e%2e/private/a.md)",
  });
  expect((await checkTree(root, policy, [])).filter((f) => f.rule === "excluded-link")).toHaveLength(3);
});
it.each([
  ["code.ts", 'readFileSync("docs/private/input.html", "utf8")'],
  ["config.json", '{"input":"docs/private/input.html"}'],
  ["tool.sh", "cat docs/private/input.html"],
  ["nested/tool.mjs", 'const input = "../docs/private/input.html";'],
  ["tool.ts", "// Reference: docs/private/input.html"],
  ["tool.ts", 'const input = "./docs/guide/../private/input.html";'],
  ["tool.ts", 'const input = "docs/%70rivate/input.html";'],
  ["tool.ts", 'const input = "docs\\\\private\\\\input.html";'],
])("rejects excluded path strings in %s", async (file, literal) => {
  expect(await checkTree(await tree({ [file]: `Safe\n${literal}\n` }), manifest, [])).toContainEqual(
    expect.objectContaining({ file, line: 2, rule: "excluded-reference" }),
  );
});
it("allows policy declarations and similarly named public paths without exempting other JSON fields", async () => {
  const file = "scripts/public-tree/manifest.json";
  const policy = { exclusions: ["docs/private"], imageAllowlist: [] };
  expect(
    await checkTree(await tree({ [file]: JSON.stringify(policy), "ok.ts": '"docs/private-other/a"' }), policy, []),
  ).toEqual([]);
  expect(
    await checkTree(await tree({ [file]: JSON.stringify({ ...policy, input: "docs/private/a" }) }), policy, []),
  ).toContainEqual(expect.objectContaining({ file, rule: "excluded-reference" }));
});
it("finds paths containing spaces in prose and shell policy branches", async () => {
  const policy = { exclusions: ["docs/Private boards", "docs/private"], imageAllowlist: [] };
  const root = await tree({
    "tool.sh": "node_modules/*|docs/private/*)\n# See docs/Private boards/reference.html",
  });
  expect((await checkTree(root, policy, [])).filter((finding) => finding.rule === "excluded-reference")).toHaveLength(
    2,
  );
});
it("treats generic instruction filenames and directory ignore patterns as names", async () => {
  const policy = { exclusions: ["INSTRUCTIONS.md", ".branches"], imageAllowlist: [] };
  expect(
    await checkTree(
      await tree({ "safe.ts": 'const name = "INSTRUCTIONS.md";', ".gitignore": ".branches/" }),
      policy,
      [],
    ),
  ).toEqual([]);
  expect(
    await checkTree(
      await tree({ "unsafe.ts": 'readFile("./INSTRUCTIONS.md"); readFile(".branches/demo/file");' }),
      policy,
      [],
    ),
  ).toContainEqual(expect.objectContaining({ rule: "excluded-reference" }));
});
