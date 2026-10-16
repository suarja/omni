import { posix } from "node:path";
import { manifestPath, parseManifest } from "./policy.mjs";

/** Mask policy declarations rather than dependencies. @returns {string} */
export function maskPolicyDeclarations(file, content) {
  if (file !== manifestPath) return content;
  parseManifest(content);
  return content.replace(/"exclusions"\s*:\s*\[[^\]]*\]/u, (value) => value.replace(/[^\r\n]/gu, " "));
}

/** @returns {boolean} */
export function hasExcludedReference(file, text, manifest) {
  const direct = manifest.exclusions
    .filter((path) => path.includes("/"))
    .some((path) => {
      const escaped = path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      return new RegExp(
        "(?:^|[\\s\x22\x27\x60=(:|])(?:\\./|/)?" + escaped + "(?=$|[/\\s\x22\x27\x60),;:<>])",
        "u",
      ).test(text);
    });
  if (direct) return true;
  const candidates = [
    ...[...text.matchAll(/["'`]([^"'`\r\n]+)["'`]/gu)].map((match) => match[1]),
    ...text.split(/[\s"'`<>(){}\[\],;=]+/u),
  ];
  return candidates.some((candidate) => {
    let path;
    try {
      path = decodeURIComponent(candidate).replace(/\\+/gu, "/").split(/[?#]/u)[0];
    } catch {
      return false;
    }
    if (!path.replace(/\/$/u, "").includes("/")) return false;
    if (/^[a-z][a-z\d+.-]*:/iu.test(path) || path.startsWith("//")) return false;
    const paths = [posix.normalize(path.replace(/^\//u, "")), posix.join(posix.dirname(file), path)];
    return paths.some((resolved) =>
      manifest.exclusions.some((excluded) => resolved === excluded || resolved.startsWith(`${excluded}/`)),
    );
  });
}
