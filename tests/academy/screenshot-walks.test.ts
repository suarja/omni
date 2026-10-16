import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = join(process.cwd(), "scripts/academy-shots.mjs");
const { SCREENSHOT_WALKS, validateWalks } = await import(scriptPath);
type Action = { click?: string; clickFirst?: string; text?: string; key?: string };
type Walk = { name: string; language: string; walk: Action[] };
const walks = SCREENSHOT_WALKS as Walk[];

async function rendererSources(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  const sources = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? rendererSources(join(directory, entry.name))
        : entry.name.endsWith(".tsx")
          ? readFile(join(directory, entry.name), "utf8")
          : "",
    ),
  );
  return sources.join("\n");
}

function testIdPatterns(source: string): RegExp[] {
  const ids = [...source.matchAll(/(?:data-testid|testId|dataTestId)=(?:"([^"]+)"|\{[^{}]*`([^`]+)`)/g)].map(
    (match) => match[1] ?? match[2]!,
  );
  return ids.map((id) => {
    const parts = id.split(/\$\{[^}]+\}/g);
    return new RegExp(`^${parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".+")}$`);
  });
}

describe("Academy screenshot walks", () => {
  it("can be imported without connecting to an app and starts every English walk from Workspace", () => {
    expect(walks).toHaveLength(18);
    expect(new Set(walks.map((walk) => walk.name)).size).toBe(18);
    expect(() => validateWalks(walks)).not.toThrow();
    for (const entry of walks) {
      expect(entry.language).toBe("en");
      expect(entry.walk.slice(0, 5)).toEqual([
        { key: "Escape" },
        { key: "Escape" },
        { key: "Escape" },
        { click: "canvas-rail-home" },
        { text: "resource-canvas", containing: "Workspace" },
      ]);
      expect(entry.walk.at(-1)).toHaveProperty("text");
    }
  });

  it("rejects write confirmations and unsupported actions before a capture can connect", () => {
    for (const action of [
      { click: "restore-apply" },
      { click: "project-capture-add" },
      { click: "canvas-setup-connect-source" },
      { clickFirst: "settings-agent-" },
      { key: "Enter" },
      { click: "canvas-rail-home", key: "Enter" },
    ]) {
      expect(() => validateWalks([{ name: "unsafe", walk: [action] }])).toThrow();
    }
    expect(() => validateWalks([walks[0], walks[0]])).toThrow("Duplicate");
  });

  it("uses test IDs declared by the current renderer instead of retired sidebar controls", async () => {
    const source = await rendererSources(join(process.cwd(), "src/renderer"));
    const patterns = testIdPatterns(source);
    for (const entry of walks) {
      for (const action of entry.walk) {
        const selector = action.click ?? action.text ?? (action.clickFirst ? `${action.clickFirst}fixture` : null);
        if (selector)
          expect(
            patterns.some((pattern) => pattern.test(selector)) || source.includes(`"${selector}"`),
            `${entry.name}: ${selector}`,
          ).toBe(true);
      }
    }
  });
});
