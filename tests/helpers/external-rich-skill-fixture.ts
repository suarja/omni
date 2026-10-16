import { chmod, cp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { externalOperationFixture } from "./external-operations-fixture";
import { folderHash } from "./external-library-fixture";
import { commit, git, write } from "./publication-fixture";

export async function externalRichSkillFixture(): ReturnType<typeof externalOperationFixture> {
  const f = await externalOperationFixture();
  const path = "skills/screenshots";
  await write(f.upstream, `${path}/SKILL.md`, "---\nname: screenshots\ndescription: Test a nested application.\n---\n");
  await write(f.upstream, `${path}/scripts/capture-iphone-duo.sh`, "#!/bin/sh\nexit 0\n");
  await chmod(join(f.upstream, path, "scripts/capture-iphone-duo.sh"), 0o755);
  await write(f.upstream, `${path}/template/.github/workflows/build.yml`, "name: build\n");
  await write(f.upstream, `${path}/template/.gitignore`, "node_modules\n");
  await write(f.upstream, `${path}/template/empty/.gitkeep`, "");
  await write(f.upstream, `${path}/template/one-byte/.gitkeep`, "\n");
  await write(f.upstream, `${path}/template/app/[filename]/a/b/c/d/page.ts`, "export default 1;\n");
  // A sibling suffix sorts before '/', while recursive capture visits the directory first.
  await write(f.upstream, `${path}/template/app.png`, new Uint8Array([137, 80, 78, 71, 0, 255]));
  for (let index = 0; index < 110; index++)
    await write(f.upstream, `${path}/template/files/file-${index}.txt`, `File ${index}\n`);
  for (let index = 0; index < 4; index++)
    await write(f.upstream, `${path}/template/public/image-${index}.png`, Buffer.alloc(850 * 1024, index));
  await commit(f.upstream, "Publish nested application skill");
  await cp(join(f.upstream, path), join(f.projectA, ".agents/skills/screenshots"), { recursive: true });
  const lock = JSON.parse(await readFile(join(f.projectA, "skills-lock.json"), "utf8"));
  lock.skills.screenshots = {
    source: "fixture/tools",
    sourceType: "github",
    skillPath: path,
    computedHash: await folderHash(f.upstream, path),
  };
  await write(f.projectA, "skills-lock.json", JSON.stringify(lock));
  await write(f.upstream, `${path}/template/new.txt`, "New upstream file\n");
  await commit(f.upstream, "Update nested application skill");
  await git(f.upstream, "push", f.origin, "main");
  await f.library.check();
  return f;
}
