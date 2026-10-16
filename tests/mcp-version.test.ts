import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { RUNTIME_VERSION } from "../packages/omni-mcp/src/version";

it("the bundled MCP runtime identifies the same release version as Desktop", () => {
  const desktop = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(RUNTIME_VERSION).toBe(desktop.version);
});
