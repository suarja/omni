import { describe, expect, it } from "vitest";

import { remoteDisplayText } from "../../src/adapters/inventory/source-layout-utils";

describe("remote declarations from other people's manifests", () => {
  it("clips long descriptions and drops control characters instead of failing the observation", () => {
    const long = "a".repeat(250);
    expect(remoteDisplayText(long)).toHaveLength(200);
    expect(remoteDisplayText(long)?.endsWith("\u2026")).toBe(true);
    expect(remoteDisplayText("line\u0000break here")).toBe("linebreak here");
    expect(remoteDisplayText("   ")).toBeUndefined();
    expect(remoteDisplayText(42)).toBeUndefined();
  });
});
