import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";

export const manifestPath = "scripts/public-tree/manifest.json";
export const termsPath = manifestPath.replace("manifest.json", "private-terms.txt");

/** @returns {{exclusions: string[], imageAllowlist: string[]}} */
export function parseManifest(content) {
  const manifest = JSON.parse(content);
  const validPaths = (value) =>
    Array.isArray(value) &&
    value.every(
      (path) =>
        typeof path === "string" &&
        path.length > 0 &&
        !path.startsWith("/") &&
        !path.includes("\\") &&
        !/[\x00-\x1f]/u.test(path) &&
        path !== "." &&
        path !== ".." &&
        !path.startsWith("../") &&
        posix.normalize(path) === path,
    );
  if (!validPaths(manifest.exclusions) || !validPaths(manifest.imageAllowlist))
    throw new Error(
      "Invalid public-tree manifest: exclusions and imageAllowlist must contain normalized relative paths.",
    );
  return manifest;
}

/** @returns {string[]} */
export function parseTerms(content) {
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

/** @returns {Promise<{manifest: {exclusions: string[], imageAllowlist: string[]}, terms: string[]}>} */
export async function readPolicy(root) {
  const manifest = parseManifest(await readFile(join(root, manifestPath), "utf8"));
  let terms = [];
  try {
    terms = parseTerms(await readFile(join(root, termsPath), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { manifest, terms };
}
