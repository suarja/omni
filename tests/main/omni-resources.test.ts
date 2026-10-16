import { describe, expect, it } from "vitest";

import { resolveResource } from "../../src/main/omni-resources";

describe("packaged Omni resources", () => {
  it("loads default packaged resources from the application directory", () => {
    expect(
      resolveResource("packages/omni-skills/skills", {
        isPackaged: true,
        resourcesPath: "/Applications/Omni Desktop.app/Contents/Resources",
      }),
    ).toBe("/Applications/Omni Desktop.app/Contents/Resources/app/packages/omni-skills/skills");
  });
  it("resolves bundled assets from the packaged app path when supplied", () => {
    expect(
      resolveResource("plugins/omni/runtime/omni-mcp.mjs", {
        isPackaged: true,
        appPath: "/Applications/Omni Desktop.app/Contents/Resources/app.asar",
        resourcesPath: "/Applications/Omni Desktop.app/Contents/Resources",
      }),
    ).toBe("/Applications/Omni Desktop.app/Contents/Resources/app.asar/plugins/omni/runtime/omni-mcp.mjs");
  });
});
