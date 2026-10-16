import { parseFrontmatter } from "../adapters/inventory/frontmatter";

export type SkillCheckFile = Readonly<{ path: string; content: string }>;
export type SkillFinding = Readonly<{
  severity: "error" | "warning";
  code: string;
  message: string;
  fix: string;
}>;
export type SkillCheckInput = Readonly<{
  folderName: string;
  files: readonly SkillCheckFile[];
  marketplace: Readonly<{ skillNames: readonly string[] }>;
}>;

const TRIGGERS = ["use when", "use this when", "utiliser quand"] as const;
const KNOWN_EXTENSIONS = /\.(?:md|mdx|json|ya?ml|toml|ts|tsx|js|jsx|sh|txt|png|jpe?g|gif|svg)$/iu;

function finding(severity: SkillFinding["severity"], code: string, message: string, fix: string): SkillFinding {
  return { severity, code, message, fix };
}

function unsafePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  );
}

function frontmatterFields(content: string): Readonly<{ valid: boolean; fields: ReadonlyMap<string, string> }> {
  const lines = content.split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") return { valid: false, fields: new Map() };
  const closing = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (closing < 0) return { valid: false, fields: new Map() };
  const fields = new Map<string, string>();
  let blockField: string | undefined;
  let blockValue = "";
  for (const line of lines.slice(1, closing + 1)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/u);
    if (field) {
      if (blockField) fields.set(blockField, blockValue.trim());
      const value = field[2]!.trim();
      blockField = /^[>|][+-]?$/u.test(value) ? field[1] : undefined;
      blockValue = blockField ? "" : value.replace(/^("|')(.*)\1$/u, "$2");
      if (!blockField) fields.set(field[1]!, blockValue);
      continue;
    }
    if (blockField && /^\s+/u.test(line)) blockValue += `${line.trim()} `;
  }
  if (blockField) fields.set(blockField, blockValue.trim());
  return { valid: true, fields };
}

function referencedPaths(content: string, files: ReadonlyMap<string, string>): readonly string[] {
  const paths = new Set<string>();
  const folders = new Set([...files.keys()].filter((path) => path.includes("/")).map((path) => path.split("/")[0]!));
  for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) paths.add(match[1]!.trim());
  for (const match of content.matchAll(/`([^`\r\n]+)`/gu)) {
    const path = match[1]!.trim().replaceAll("\\", "/");
    if (KNOWN_EXTENSIONS.test(path) && (path.startsWith("./") || folders.has(path.split("/")[0]!))) paths.add(path);
  }
  return [...paths];
}

function relativeReference(path: string): string | undefined {
  const value = path.replaceAll("\\", "/").split(/[?#]/u, 1)[0]!.trim();
  if (!value || value.startsWith("#") || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) return undefined;
  return value.replace(/^\.\//u, "");
}

export function checkSkill(input: SkillCheckInput): readonly SkillFinding[] {
  const findings: SkillFinding[] = [];
  const files = new Map<string, string>();
  for (const file of input.files) {
    const path = file.path.replaceAll("\\", "/");
    if (unsafePath(path)) {
      findings.push(
        finding(
          "error",
          "file-path-unsafe",
          `Skill file path is outside the skill folder: ${file.path}.`,
          "Use a safe relative path inside the skill folder.",
        ),
      );
      continue;
    }
    if (files.has(path))
      findings.push(
        finding(
          "error",
          "file-path-duplicate",
          `Skill file path is repeated: ${path}.`,
          "Keep one file for each relative path.",
        ),
      );
    files.set(path, file.content);
  }

  const skill = files.get("SKILL.md");
  if (skill === undefined) {
    findings.push(
      finding(
        "error",
        "skill-file-missing",
        "SKILL.md is missing at the root of the skill folder.",
        "Add SKILL.md directly inside the skill folder.",
      ),
    );
  } else {
    const parsed = parseFrontmatter(skill, true);
    const fields = frontmatterFields(skill);
    if (skill.split(/\r?\n/u)[0]?.trim() !== "---")
      findings.push(
        finding(
          "error",
          "frontmatter-missing",
          "SKILL.md has no frontmatter block.",
          "Add a YAML frontmatter block delimited by --- lines.",
        ),
      );
    else if (!parsed.valid || !fields.valid)
      findings.push(
        finding(
          "error",
          "frontmatter-invalid",
          "SKILL.md frontmatter is not parseable.",
          "Fix the YAML frontmatter and keep it delimited by --- lines.",
        ),
      );
    else {
      const name = fields.fields.get("name")?.trim();
      const description = parsed.description?.trim() ?? fields.fields.get("description")?.trim();
      if (!name)
        findings.push(
          finding(
            "error",
            "name-missing",
            "Skill frontmatter must include name.",
            "Set name to the skill folder name.",
          ),
        );
      else {
        if (name !== input.folderName)
          findings.push(
            finding(
              "error",
              "name-folder-mismatch",
              `Skill name must equal folder name (${input.folderName}).`,
              "Set frontmatter name to the folder name.",
            ),
          );
        if (name.length > 64)
          findings.push(
            finding(
              "error",
              "name-too-long",
              "Skill name must be at most 64 characters.",
              "Shorten the skill name to 64 characters or fewer.",
            ),
          );
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name))
          findings.push(
            finding(
              "error",
              "name-not-kebab-case",
              "Skill name must use kebab-case.",
              "Use lowercase words separated by single hyphens.",
            ),
          );
        if (input.marketplace.skillNames.some((candidate) => candidate.toLowerCase() === name.toLowerCase()))
          findings.push(
            finding(
              "error",
              "duplicate-skill-name",
              `Skill name is already used in this marketplace: ${name}.`,
              "Choose a new skill name or update the existing skill.",
            ),
          );
      }
      if (!description)
        findings.push(
          finding(
            "error",
            "description-missing",
            "Skill frontmatter must include description.",
            "Add a concise description that says when the skill applies.",
          ),
        );
      else {
        if (description.length > 1024)
          findings.push(
            finding(
              "error",
              "description-too-long",
              "Skill description must be at most 1024 characters.",
              "Shorten the description to 1024 characters or fewer.",
            ),
          );
        if (!TRIGGERS.some((trigger) => description.toLocaleLowerCase().includes(trigger)))
          findings.push(
            finding(
              "warning",
              "description-trigger",
              "Skill description does not contain a trigger phrase.",
              "Add “Use when”, “Use this when”, or “Utiliser quand” to the description.",
            ),
          );
      }
    }
    if (skill.split(/\r?\n/u).length > 500)
      findings.push(
        finding(
          "warning",
          "skill-too-long",
          "SKILL.md is longer than 500 lines.",
          "Move detailed material into focused reference files.",
        ),
      );
    for (const reference of referencedPaths(skill, files)) {
      const relative = relativeReference(reference);
      if (!relative) continue;
      if (unsafePath(relative) || !files.has(relative))
        findings.push(
          finding(
            "error",
            "referenced-file-missing",
            `Referenced skill file does not exist: ${reference}.`,
            "Add the referenced file to the skill folder or remove the reference.",
          ),
        );
    }
  }

  if (input.files.some((file) => /(?:TODO|lorem|<your-|\{\{)/iu.test(file.content)))
    findings.push(
      finding(
        "error",
        "placeholder-text",
        "Skill files contain placeholder text.",
        "Replace TODO, lorem, <your-…>, or {{…}} placeholders with final content.",
      ),
    );
  return findings;
}
