import { lstat, readFile, readdir } from "node:fs/promises";
import { posix, join } from "node:path";
import { hasExcludedReference, maskPolicyDeclarations } from "./references.mjs";

const HOME = /\/(?:Users|home)\/([^/\s`'"<>()[\]{},;:!?\\]+)/giu;
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/gu;
const IMAGE = /\.(?:png|jpe?g|gif|webp|svg|ico|icns|bmp|tiff?|avif|heic|heif)$/iu;
const MAX_BYTES = 5 * 1024 * 1024;

/** @returns {boolean} */
export function isExcluded(path, manifest) {
  return manifest.exclusions.some((excluded) => path === excluded || path.startsWith(`${excluded}/`));
}

function isImage(path, bytes) {
  const start = bytes.subarray(0, 256).toString("latin1");
  return (
    IMAGE.test(path) ||
    /^(?:\x89PNG\r\n\x1a\n|\xff\xd8\xff|GIF8[79]a|BM|icns|II\x2a\x00|MM\x00\x2a)/u.test(start) ||
    /^RIFF[\s\S]{4}WEBP/u.test(start) ||
    /<svg[\s>]/iu.test(start) ||
    /ftyp(?:avif|heic|heix|mif1)/u.test(start)
  );
}

function isTransport(text, match) {
  const before = text.slice(0, match.index);
  const after = text.slice(match.index + match[0].length);
  return (
    /(?:[a-z]+:\/\/[^\s]*|https?:\/\/[^\s]*)$/iu.test(before) ||
    (/^(?:git|ssh)$/iu.test(match[0].split("@")[0]) && /^[:/]/u.test(after))
  );
}

function linkTargets(text) {
  const patterns = [
    /\]\(\s*(?:<([^>]+)>|([^\s)>]+))/gu,
    /^\s{0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|([^\s>]+))/gu,
    /(?:href|src)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/giu,
    /<((?:\.{0,2}\/)?docs\/[^>]+)>/gu,
  ];
  return [
    ...new Set(
      patterns.flatMap((pattern) =>
        [...text.matchAll(pattern)].map((match) => match.slice(1).find((value) => value !== undefined)),
      ),
    ),
  ];
}

function excludedLink(file, target, manifest) {
  let decoded;
  try {
    decoded = decodeURIComponent(target).replaceAll("\\", "/").split(/[?#]/u)[0];
  } catch {
    return false;
  }
  if (/^[a-z][a-z\d+.-]*:/iu.test(decoded) || decoded.startsWith("//")) return false;
  const resolved = decoded.startsWith("/")
    ? posix.normalize(decoded.slice(1))
    : posix.join(posix.dirname(file), decoded);
  return isExcluded(resolved, manifest);
}

function scanText(file, content, manifest, terms, references = content) {
  const findings = [];
  const referenceLines = references.split(/\r?\n/u);
  content.split(/\r?\n/u).forEach((text, index) => {
    const add = (rule, message) => findings.push({ file, line: index + 1, rule, message });
    for (const term of terms)
      if (text.toLowerCase().includes(term.toLowerCase())) add("private-term", "Private term found.");
    for (const match of text.matchAll(HOME))
      if (match[1] !== "example") add("home-path", "Use the synthetic example home.");
    for (const match of text.matchAll(EMAIL)) {
      const local = match[0].split("@")[0].toLowerCase();
      const domain = match[1].toLowerCase();
      if (
        domain === "example.com" ||
        /^(?:no-?reply)$/u.test(local) ||
        /^(?:[a-z\d-]+\.)*noreply\.[a-z.]+$/u.test(domain) ||
        isTransport(text, match)
      )
        continue;
      add("email", "Use example.com or a noreply address.");
    }
    if (hasExcludedReference(file, referenceLines[index], manifest))
      add("excluded-reference", "String path points into an excluded tree.");
    for (const target of linkTargets(text))
      if (excludedLink(file, target, manifest)) add("excluded-link", "Link points into an excluded path.");
  });
  return findings;
}

/**
 * Inspect every entry without following symlinks or trusting binary extensions.
 * @returns {Promise<Array<{file: string, line: number, rule: string, message: string}>>}
 */
export async function checkTree(root, manifest, terms) {
  const findings = [];
  async function visit(relative) {
    const path = join(root, relative);
    const stat = await lstat(path);
    const add = (rule, message) => findings.push({ file: relative, line: 1, rule, message });
    if (isExcluded(relative, manifest)) add("excluded-path", "Excluded entry is present.");
    findings.push(...scanText(relative, relative, manifest, terms));
    if (stat.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) await visit(posix.join(relative, entry));
      return;
    }
    if (!stat.isFile()) {
      add("file-type", "Only regular files and directories are allowed.");
      return;
    }
    if (stat.size > MAX_BYTES) {
      add("size", "File exceeds 5 MiB.");
      return;
    }
    const bytes = await readFile(path);
    if (isImage(relative, bytes) && !manifest.imageAllowlist.includes(relative))
      add("image", "Image requires explicit visual approval in the manifest.");
    const content = bytes.toString("utf8");
    findings.push(...scanText(relative, content, manifest, terms, maskPolicyDeclarations(relative, content)));
  }
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Check requires a real directory.");
  for (const entry of (await readdir(root)).sort()) await visit(entry);
  return findings;
}
