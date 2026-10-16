import { describe, expect, it } from "vitest";

import { describeProcess } from "../../src/domain/process-names";

describe("process names", () => {
  it.each([
    ["node /repo/node_modules/vitest/vitest.mjs --pool=workers", "vitest workers"],
    ["node (vitest 1)", "vitest workers"],
    ["pnpm vitest", "vitest"],
    ["vitest run", "vitest"],
    ["vite --host 127.0.0.1", "Vite dev server"],
    ["electron-vite dev", "electron-vite"],
    ["tsc --noEmit", "TypeScript check"],
    ["eslint src", "ESLint"],
    ["node -e console.log(1)", "Node script"],
    ["node scripts/check.js", "Node script"],
    ["pnpm run test", "pnpm test"],
    ["npm run build", "npm build"],
    ["electron /repo/omni-desktop/out/main/index.js", "Electron (Omni)"],
    ["claude --output-format stream-json", "Claude Code session"],
    ["codex exec --brief", "Codex agent"],
    ["codex app-server", "Codex app"],
    ["codex sandbox", "Codex sandbox"],
    ["zsh -c echo test", "shell"],
    ["git worktree list", "Git"],
    ["unknown-tool --flag", "unknown-tool"],
  ])("describes %s as %s", (command, expected) => {
    expect(describeProcess(command)).toBe(expected);
  });
});

describe("process names — real shapes seen on the owner's machine", () => {
  it("names node scripts after their package, Codex commands behind -c options, and MCP servers", () => {
    expect(
      describeProcess("/opt/homebrew/bin/node /x/mobile/node_modules/jest-worker/build/workers/processChild.js"),
    ).toBe("Jest workers");
    expect(describeProcess("node /x/node_modules/.bin/expo start")).toBe("Expo");
    expect(describeProcess("node /x/node_modules/@scope/tool/dist/cli.js")).toBe("@scope/tool (Node)");
    expect(
      describeProcess("/Applications/ChatGPT.app/Contents/Resources/codex -c features.code_mode_host=true app-server"),
    ).toBe("Codex app");
    expect(describeProcess("/Users/example/.pencil/mcp/out/mcp-server-darwin-arm64 --app visual_studio_code")).toBe(
      "MCP server",
    );
  });
});
