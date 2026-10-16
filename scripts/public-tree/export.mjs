import { execFileSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readdir, realpath, rm, readFile, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { checkTree, isExcluded } from "./check.mjs";
import { manifestPath, parseManifest, parseTerms, termsPath } from "./policy.mjs";

function git(repo, args, options = {}) {
  return execFileSync(
    "git",
    ["--literal-pathspecs", "-C", repo, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
    {
      maxBuffer: 16 * 1024 * 1024,
      ...options,
    },
  );
}

async function canonicalTarget(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return join(await canonicalTarget(dirname(path)), path.slice(dirname(path).length + 1));
  }
}

async function prepareTarget(repo, target) {
  try {
    if ((await lstat(resolve(target))).isSymbolicLink())
      throw new Error("Public export refuses a symbolic destination.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const canonical = await canonicalTarget(resolve(target));
  const root = await realpath(repo);
  const inside = relative(root, canonical);
  if (!isAbsolute(inside) && inside !== ".." && !inside.startsWith("../"))
    throw new Error("Public export destination must be outside the checkout.");
  await mkdir(canonical, { recursive: true });
  if ((await readdir(canonical)).length)
    throw new Error("Public export destination must be an empty directory; choose a new scratch directory.");
  return canonical;
}

// Archive attributes may omit or substitute files. Restore the exact selected blobs from
// the same commit without filters, instead of trusting local or committed attributes.
async function restoreCommittedBytes(repo, tree, selected) {
  const hashes = selected.map((entry) => entry.metadata.split(" ")[2]);
  const output = git(repo, ["cat-file", "--batch"], { input: hashes.join("\n") + "\n", maxBuffer: 128 * 1024 * 1024 });
  let offset = 0;
  for (const entry of selected) {
    const end = output.indexOf(10, offset);
    const header = output.subarray(offset, end).toString("utf8").split(" ");
    const size = Number(header[2]);
    if (end < 0 || header[1] !== "blob" || !Number.isSafeInteger(size) || size < 0)
      throw new Error(`Cannot read committed blob for ${entry.path}.`);
    const bytes = output.subarray(end + 1, end + 1 + size);
    if (bytes.length !== size) throw new Error(`Incomplete committed blob for ${entry.path}.`);
    offset = end + 1 + size + 1;
    const path = join(tree, entry.path);
    await mkdir(dirname(path), { recursive: true });
    let current;
    try {
      current = await readFile(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!current?.equals(bytes)) await writeFile(path, bytes);
    await chmod(path, entry.metadata.startsWith("100755") ? 0o755 : 0o644);
  }
}

/**
 * Export one immutable commit. Failed checks never populate the destination.
 * @returns {Promise<{fileCount: number, findings: Array<{file: string, line: number, rule: string, message: string}>}>}
 */
export async function exportPublicTree(repo, target) {
  const destination = await prepareTarget(repo, target);
  const commit = git(repo, ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const manifest = parseManifest(git(repo, ["show", `${commit}:${manifestPath}`], { encoding: "utf8" }));
  const tracked = git(repo, ["ls-tree", "-rz", "--full-tree", commit], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  const selected = tracked
    .map((entry) => {
      const separator = entry.indexOf("\t");
      const metadata = entry.slice(0, separator);
      const path = entry.slice(separator + 1);
      return { metadata, path };
    })
    .filter((entry) => !isExcluded(entry.path, manifest));
  for (const entry of selected)
    if (!/^100(?:644|755) blob /u.test(entry.metadata))
      throw new Error(`Public export refuses non-regular tracked entry: ${entry.path}.`);
  const hasTerms = tracked.some((entry) => entry.endsWith(`\t${termsPath}`));
  const terms = hasTerms ? parseTerms(git(repo, ["show", `${commit}:${termsPath}`], { encoding: "utf8" })) : [];
  const scratch = await mkdtemp(join(tmpdir(), "omni-public-"));
  try {
    const tar = join(scratch, "snapshot.tar");
    const tree = join(scratch, "tree");
    await mkdir(tree);
    git(repo, [
      "-c",
      "core.attributesFile=/dev/null",
      "archive",
      "--format=tar",
      `--output=${tar}`,
      commit,
      "--",
      ...selected.map((entry) => entry.path),
    ]);
    execFileSync("tar", ["-xf", tar, "-C", tree]);
    await restoreCommittedBytes(repo, tree, selected);
    const findings = await checkTree(tree, manifest, terms);
    if (!findings.length) {
      if ((await readdir(destination)).length)
        throw new Error("Public export destination changed; refusing to overwrite it.");
      for (const entry of await readdir(tree))
        await cp(join(tree, entry), join(destination, entry), { recursive: true, force: false, errorOnExist: true });
    }
    return { fileCount: selected.length, findings };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
