import { checkSkill, type SkillCheckFile, type SkillFinding } from "./skill-checks";

export type PublishFinding = Omit<SkillFinding, "severity"> &
  Readonly<{ severity: "error"; file: string; line: number; excerpt: string }>;
export type PublicationCheckFile = SkillCheckFile & Readonly<{ binary?: boolean }>;
type Input = Readonly<{ files: readonly PublicationCheckFile[]; hasLicense: boolean; homeDirectory: string }>;
const PERSONAL =
  /(?:\/Users\/[^/\s]+\/|\/home\/[^/\s]+\/|[A-Za-z]:\\Users\\[^\\\s]+\\|~\/[^\s/`'"<>])[^\s`'"<>)}\],;]*/giu;
const KNOWN_AGENT_HOME = /~\/(?:\.claude|\.codex|\.agents|\.config\/opencode)(?=\/|[\s`'"\)\]]|$)/gu;
const SECRET =
  /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[bp]-[A-Za-z0-9-]{16,}|AKIA[A-Z0-9]{16})\b|["']?\b(?:api[_-]?key|token|secret)["']?\s*[:=]\s*["'](?:[^"'\r\n]{16,})["']|\b(?:api[_-]?key|token|secret)\s*[:=]\s*[A-Za-z0-9_-]{16,}\b/iu;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu;
const FRENCH = new Set(
  "le la les des du une un dans pour avec sur vous nous sont est cette ces aux que qui pas par votre vos leur leurs et en ce ses se être sans".split(
    " ",
  ),
);

function finding(code: string, file: string, line: number, excerpt: string, message: string): PublishFinding {
  return {
    severity: "error",
    code,
    file,
    line,
    excerpt: (SECRET.test(excerpt) ? "[redacted secret literal]" : excerpt)
      .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
      .slice(0, 120),
    message: SECRET.test(message) ? "A skill validity check found unsafe content." : message,
    fix: "Fix the workshop content and preview publication again.",
  };
}
function englishFindings(file: SkillCheckFile): PublishFinding[] {
  const results: PublishFinding[] = [];
  let fence: string | undefined;
  let paragraph: string[] = [];
  let start = 1;
  const flush = (): void => {
    const text = paragraph
      .join(" ")
      .replace(/`[^`]*`/gu, "")
      .replace(/https?:\/\/\S+/gu, "");
    const words = text.toLowerCase().match(/[\p{L}]+/gu) ?? [];
    const letters = text.match(/\p{L}/gu) ?? [];
    const stops = words.filter((word) => FRENCH.has(word)).length;
    const accents = (text.match(/[àâçéèêëîïôùûüÿœ]/giu) ?? []).length;
    if (
      words.length >= 6 &&
      ((stops >= 3 && stops / words.length >= 0.18) || (accents >= 3 && accents / letters.length >= 0.04))
    )
      results.push(
        finding(
          "non-english",
          file.path,
          start,
          paragraph.join(" "),
          "Markdown prose appears to be French. Publish English prose.",
        ),
      );
    paragraph = [];
  };
  file.content.split(/\r?\n/u).forEach((line, index) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker) {
      flush();
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && /^\s*(?:`+|~+)\s*$/u.test(line))
        fence = undefined;
      return;
    }
    if (fence) return;
    if (!line.trim()) {
      flush();
      return;
    }
    if (!paragraph.length) start = index + 1;
    paragraph.push(line);
  });
  flush();
  return results;
}
function skillFindings(files: readonly PublicationCheckFile[]): PublishFinding[] {
  const folders = [
    ...new Set(files.flatMap((file) => /^(?:plugins\/[^/]+\/)?skills\/[^/]+\//u.exec(file.path)?.[0] ?? [])),
  ];
  return folders.flatMap((prefix) => {
    const folderName = prefix.split("/").at(-2)!;
    const skillFiles = files
      .filter((file) => file.path.startsWith(prefix))
      .map((file) => ({ path: file.path.slice(prefix.length), content: file.binary ? "" : file.content }));
    return checkSkill({ folderName, files: skillFiles, marketplace: { skillNames: [] } })
      .filter((item) => item.severity === "error")
      .map((item) =>
        finding(
          "skill-invalid",
          `${prefix}SKILL.md`,
          1,
          skillFiles.find((file) => file.path === "SKILL.md")?.content.split("\n")[0] ?? "Missing SKILL.md",
          `${item.code}: ${item.message}`,
        ),
      );
  });
}
export function checkPublication(input: Input): readonly PublishFinding[] {
  const findings: PublishFinding[] = [];
  for (const file of input.files) {
    file.content.split(/\r?\n/u).forEach((text, index) => {
      // Sensitive literals are checked even in fenced examples. Never echo a secret into a plan.
      const secret = SECRET.test(text);
      const excerpt = secret ? "[redacted secret literal]" : text;
      const paths = new Set(
        [...text.replace(KNOWN_AGENT_HOME, "").matchAll(PERSONAL)].map((match) => match[0].replace(/[.!?]+$/u, "")),
      );
      if (input.homeDirectory) {
        const escapedHome = input.homeDirectory.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        for (const match of text.matchAll(new RegExp(`${escapedHome}[^\\s\x60'\"<>)}\\],;]*`, "gu")))
          paths.add(match[0].replace(/[.!?]+$/u, ""));
      }
      for (const path of paths)
        findings.push(
          finding(
            "personal-path",
            file.path,
            index + 1,
            secret ? excerpt : path,
            "A personal filesystem path would be published.",
          ),
        );
      if (secret)
        findings.push(finding("secret", file.path, index + 1, excerpt, "A secret literal would be published."));
      for (const match of text.matchAll(EMAIL)) {
        const [local, domain] = match[0].toLowerCase().split("@");
        if (
          /^(?:no-?reply)$/u.test(local!) ||
          /^(?:example\.(?:com|org|net))$/u.test(domain!) ||
          /\.(?:invalid|test)$/u.test(domain!)
        )
          continue;
        findings.push(
          finding(
            "email",
            file.path,
            index + 1,
            secret ? excerpt : match[0],
            "A personal email address would be published.",
          ),
        );
      }
    });
    if (!file.binary && /\.mdx?$/iu.test(file.path)) findings.push(...englishFindings(file));
  }
  if (!input.hasLicense)
    findings.push(finding("license-missing", "LICENSE", 1, "Missing LICENSE", "The storefront needs a LICENSE file."));
  return [...findings, ...skillFindings(input.files)];
}
