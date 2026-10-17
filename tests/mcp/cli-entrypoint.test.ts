import { expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { isCliEntrypoint } from "../../packages/omni-mcp/src/cli";

it("starts the MCP runtime installed in an application path containing spaces", () => {
  const path = "/Users/example/Applications/Omni.app/Contents/Resources/app/omni-mcp.mjs";
  expect(isCliEntrypoint(pathToFileURL(path).href, path)).toBe(true);
});
it("does not start stdio when the CLI is imported as a module", () => {
  expect(isCliEntrypoint("file:///tmp/omni-mcp.mjs", "/tmp/consumer.mjs")).toBe(false);
});
