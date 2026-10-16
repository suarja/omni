import type { SkillLockEntry, SkillLockResult } from "./types";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const HASH = /^[0-9a-f]{64}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeText(value: unknown, maximum = 240): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= maximum && !CONTROL_CHARACTERS.test(text) ? text : undefined;
}

function safeRelativePath(value: unknown): string | undefined {
  const text = safeText(value);
  if (!text) return undefined;
  const normalized = text.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return undefined;
  }
  return normalized;
}

function githubLocator(value: unknown): string | undefined {
  const locator = safeText(value, 201);
  if (!locator) return undefined;
  const segments = locator.split("/");
  if (segments.length !== 2 || segments.some((segment) => !SAFE_SEGMENT.test(segment))) return undefined;
  return segments.map((segment) => segment.toLocaleLowerCase("en-US")).join("/");
}

type EntryParseResult = Readonly<{ entry: SkillLockEntry }> | Readonly<{ issue: "malformed" | "unsupported" }>;

function parseEntry(skillKey: string, value: unknown): EntryParseResult {
  if (
    (!SAFE_SEGMENT.test(skillKey) && skillKey !== "__proto__") ||
    skillKey === "." ||
    skillKey === ".." ||
    !isRecord(value)
  ) {
    return { issue: "malformed" };
  }
  if (value.sourceType !== "github") return { issue: "unsupported" };
  const locator = githubLocator(value.source);
  const hash = safeText(value.computedHash, 64);
  if (!locator || !hash || !HASH.test(hash)) return { issue: "malformed" };

  const sourceSkillPath = value.skillPath === undefined ? undefined : safeRelativePath(value.skillPath);
  const reference = value.ref === undefined ? undefined : safeText(value.ref);
  if (value.skillPath !== undefined && !sourceSkillPath) return { issue: "malformed" };
  if (
    value.ref !== undefined &&
    (!reference || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(reference) || reference.includes("@"))
  ) {
    return { issue: "malformed" };
  }

  return {
    entry: {
      skillKey,
      source: { kind: "github", locator },
      ...(sourceSkillPath ? { sourceSkillPath } : {}),
      ...(reference ? { reference } : {}),
      recordedHash: hash.toLocaleLowerCase("en-US"),
    },
  };
}

export function parseSkillsLock(value: unknown): SkillLockResult {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.skills)) {
    return {
      entries: [],
      issues: [
        {
          code: "unsupported",
          message: "The project skills lockfile is missing or uses an unsupported structure.",
        },
      ],
    };
  }

  const entries: SkillLockEntry[] = [];
  const issues: SkillLockResult["issues"][number][] = [];
  for (const [skillKey, rawEntry] of Object.entries(value.skills)) {
    const result = parseEntry(skillKey, rawEntry);
    if ("entry" in result) entries.push(result.entry);
    else if (result.issue === "unsupported") {
      issues.push({ code: "unsupported", message: "A skills-lock entry uses an unsupported source type." });
    } else {
      issues.push({ code: "malformed", message: "A skills-lock entry is malformed." });
    }
  }
  entries.sort((left, right) => left.skillKey.localeCompare(right.skillKey));
  return { entries, issues };
}
