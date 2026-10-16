import { build } from "esbuild";
import { mkdir, readdir, readFile, writeFile, cp } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outfile = resolve(root, "plugins/omni/runtime/omni-mcp.mjs");

// Keep installed and plugin skills on the same consent contract.
const consent = (await readFile(resolve(root, "packages/omni-skills/consent.md"), "utf8")).trim();
const skillsRoot = resolve(root, "packages/omni-skills/skills");
for (const entry of await readdir(skillsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const canonical = resolve(skillsRoot, entry.name, "SKILL.md");
  const content = await readFile(canonical, "utf8");
  const updated = content.replace(
    /(## Consent\n\n<!-- Generated from packages\/omni-skills\/consent.md\. -->\n)[\s\S]*?(?=\n## |$)/u,
    (_match, heading) => `${heading}\n${consent}\n`,
  );
  if (updated === content && !content.includes(consent)) throw new Error(`Missing consent section: ${entry.name}`);
  if (updated !== content) await writeFile(canonical, updated);
  const plugin = resolve(root, "plugins/omni/skills", entry.name, "SKILL.md");
  await mkdir(dirname(plugin), { recursive: true });
  await cp(resolve(skillsRoot, entry.name), dirname(plugin), { recursive: true });
}

await mkdir(dirname(outfile), { recursive: true });
await build({
  bundle: true,
  entryPoints: [resolve(root, "packages/omni-mcp/src/cli.ts")],
  format: "esm",
  minify: true,
  outfile,
  platform: "node",
  target: "node22",
  legalComments: "none",
});

console.log(`Built ${outfile}`);
