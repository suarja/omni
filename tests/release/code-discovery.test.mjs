import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { discoverCode } from "../../scripts/release/signing.mjs";

it("discovers every Mach-O once and seals bundles after their children without following aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "omni-code-discovery-"));
  const app = join(root, "Example.app");
  const helper = join(app, "Contents/Frameworks/Example Helper.app");
  const library = join(app, "Contents/Frameworks/Example.framework/Versions/A/Example");
  const launcher = join(app, "Contents/Resources/omni-mcp");
  const main = join(app, "Contents/MacOS/Example");
  const helperMain = join(helper, "Contents/MacOS/Example Helper");
  const crash = join(helper, "Contents/Helpers/crash-handler");
  try {
    for (const path of [library, launcher, main, helperMain, crash]) {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, Buffer.from("cffaedfe00000000", "hex"));
    }
    await writeFile(join(app, "Contents/Resources/document.txt"), "fictional content");
    await symlink("Versions/A/Example", join(app, "Contents/Frameworks/Example.framework/Example"));
    const { targets, binaries } = await discoverCode(app);
    expect(binaries.sort()).toEqual([library, launcher, main, helperMain, crash].sort());
    expect(targets.at(-1)).toBe(app);
    expect(targets.indexOf(crash)).toBeLessThan(targets.indexOf(helper));
    expect(targets.indexOf(library)).toBeLessThan(targets.indexOf(join(app, "Contents/Frameworks/Example.framework")));
    expect(targets).not.toContain(main);
    expect(targets).not.toContain(helperMain);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
