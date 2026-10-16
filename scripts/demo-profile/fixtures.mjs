const plugins = [
  ["web-quality", "Review web changes before release.", ["review-accessibility", "check-web-tests"]],
  ["writing", "Keep project documentation clear.", ["write-release-notes"]],
  ["project-care", "Maintain small local projects.", ["review-dependencies"]],
  ["delivery", "Prepare a verifiable local delivery.", ["prepare-checkpoint"]],
];

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
function skill(name, instruction) {
  return `---\nname: ${name}\ndescription: Use when asked to ${name.replaceAll("-", " ")}.\n---\n\n# ${name.replaceAll("-", " ")}\n\n${instruction}\n\nRead the relevant project files. Report the observed evidence, changed paths and\nremaining checks. Ask before publishing or changing files outside this project.\n`;
}

/** @returns {Record<string, string>} */
export function projectFiles(name) {
  return {
    "README.md": `# ${name}\n\nA tiny synthetic project for the Acme demo.\n\nRun \`npm test\` to check the example module.\n`,
    "package.json": json({ name, version: "1.0.0", private: true, type: "module", scripts: { test: "node --test" } }),
    "AGENTS.md": "# Project instructions\n\nThis is a synthetic local demo. Keep changes small and run npm test.\n",
    "CLAUDE.md": "# Project context\n\nRead AGENTS.md before editing. Keep the example dependency-free.\n",
    "src/greeting.js": "export function greeting(name) { return `Hello, ${name}!`; }\n",
    "src/greeting.test.js":
      'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { greeting } from "./greeting.js";\ntest("greets the reader", () => assert.equal(greeting("Ada"), "Hello, Ada!"));\n',
    ".agents/skills/review-project/SKILL.md": skill(
      "review-project",
      "Check the small example module and run npm test before suggesting changes.",
    ),
    ".claude/skills/document-project/SKILL.md": skill(
      "document-project",
      "Explain the project's purpose, test command and module entry point using the README.",
    ),
  };
}

/** @returns {Record<string, string>} */
export function marketplaceFiles() {
  const files = {
    "README.md":
      "# Acme skills\n\nA personal marketplace of synthetic skills for web reviews, writing and local delivery.\n",
    "omni.marketplace.json": json({
      format: "omni.marketplace/1",
      id: "acme-skills",
      name: "acme-skills",
      visibility: "private",
      createdAt: "2026-10-16T00:00:00.000Z",
      createdBy: "Ada Example",
      packages: plugins.map(([name]) => ({ path: `packages/${name}` })),
    }),
  };
  for (const [name, description, skills] of plugins) {
    const base = `packages/${name}`;
    files[`${base}/omni.plugin.json`] = json({
      format: "omni.plugin/1",
      id: name,
      name,
      version: "1.0.0",
      description,
      license: "MIT",
      artifacts: skills.map((name) => ({ kind: "skill", path: `skills/${name}` })),
    });
    files[`${base}/README.md`] = `# ${name}\n\n${description}\n`;
    files[`${base}/.claude-plugin/plugin.json`] = json({ name, version: "1.0.0", description });
    files[`${base}/.codex-plugin/plugin.json`] = json({ name, version: "1.0.0", description, skills: "./skills/" });
    for (const name of skills) files[`${base}/skills/${name}/SKILL.md`] = skill(name, description);
  }
  return files;
}

/** @returns {Record<string, string>} */
export function homeFiles() {
  return {
    ".gitconfig":
      "[user]\n\tname = Ada Example\n\temail = ada@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n",
    ".claude.json": json({ mcpServers: {} }),
    ".claude/settings.json": json({}),
    ".codex/config.toml": "# Synthetic demo configuration. Omni setup adds its MCP registration.\n",
    ".codex/hooks.json": json({}),
    ".config/opencode/opencode.json": json({}),
    ".cursor/mcp.json": json({ mcpServers: {} }),
  };
}
