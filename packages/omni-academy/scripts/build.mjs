#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");
const CONTENT_ROOT = join(PACKAGE_ROOT, "content");
const SNAPSHOT_PATH = join(PACKAGE_ROOT, "academy.json");
const LANGUAGES = ["en", "fr"];
const KINDS = ["course", "tutorial", "topic"];
const TOPICS = [
  "skills",
  "plugins",
  "marketplaces",
  "mcp",
  "claude-code",
  "codex",
  "projects",
  "git",
  "agents-at-work",
];
const PRODUCTS = ["claude-code", "codex"];
const ILLUSTRATIONS = [
  "marketplace",
  "plugin",
  "skill",
  "project",
  "agent",
  "receipt",
  "git",
  "terminal",
  "claude-code",
  "codex",
  "lesson",
  "course",
];
const MAX_LESSON_LINES = 150;

const { parseFrontmatter } = await import(
  pathToFileURL(join(REPO_ROOT, "src", "adapters", "inventory", "frontmatter.ts")).href
);
const { ACADEMY_CTA_ROUTES } = await import(pathToFileURL(join(REPO_ROOT, "src", "renderer", "navigation.ts")).href);

function fail(file, line, message) {
  throw new Error(`${relative(REPO_ROOT, file)}:${line}: ${message}`);
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  )
    return trimmed.slice(1, -1).replaceAll('\\"', '"').replaceAll("''", "'");
  return trimmed;
}

function splitInline(value) {
  const inner = value.trim().slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(",").map((item) => unquote(item));
}

function parseValue(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return splitInline(trimmed);
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const object = {};
    for (const pair of splitInline(`[${trimmed.slice(1, -1)}]`)) {
      const separator = pair.indexOf(":");
      if (separator < 1) return undefined;
      object[pair.slice(0, separator).trim()] = unquote(pair.slice(separator + 1));
    }
    return object;
  }
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return unquote(trimmed);
}

function readDocument(file, raw) {
  const lines = raw.replaceAll("\r\n", "\n").split("\n");
  if (!parseFrontmatter(raw, true).valid) fail(file, 1, "frontmatter is missing or malformed");
  const closing = lines.slice(1).findIndex((line) => line.trim() === "---");
  const end = closing + 1;
  const fields = new Map();
  for (let index = 1; index < end; index += 1) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(lines[index] ?? "");
    if (!match) fail(file, index + 1, "frontmatter fields must use key: value syntax");
    fields.set(match[1], { value: parseValue(match[2]), line: index + 1 });
  }
  return { fields, body: lines.slice(end + 1).join("\n"), lines };
}

function field(document, file, name) {
  const value = document.fields.get(name);
  if (!value || value.value === "" || value.value === undefined)
    fail(file, value?.line ?? 1, `missing required field "${name}"`);
  return value;
}

function textField(document, file, name) {
  const value = field(document, file, name);
  if (typeof value.value !== "string" || value.value.includes("\n"))
    fail(file, value.line, `field "${name}" must be one line`);
  return value.value;
}

function arrayField(document, file, name) {
  const value = field(document, file, name);
  if (!Array.isArray(value.value) || value.value.some((item) => typeof item !== "string" || !item))
    fail(file, value.line, `field "${name}" must be a non-empty string array`);
  return value.value;
}

async function validateLinks(file, body, lessonKeys) {
  const links = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g;
  for (const match of body.matchAll(links)) {
    const target = match[1];
    const academy = /^academy:\/\/(course|tutorial|topic)\/([a-z0-9-]+)$/u.exec(target);
    if (academy) {
      if (!lessonKeys.has(`${academy[1]}/${academy[2]}`)) fail(file, 1, `academy link does not resolve: ${target}`);
      continue;
    }
    if (/^(?:[a-z]+:|#|\/)/i.test(target)) continue;
    const targetPath = resolve(dirname(file), target.split("#")[0]);
    if (!targetPath.startsWith(CONTENT_ROOT + "/") || extname(targetPath) !== ".md")
      fail(file, 1, `internal link escapes content: ${target}`);
    try {
      await awaitRead(targetPath);
    } catch {
      fail(file, 1, `internal link does not resolve: ${target}`);
    }
  }
}

const fileCache = new Map();
function awaitRead(file) {
  if (!fileCache.has(file)) fileCache.set(file, readFile(file, "utf8"));
  return fileCache.get(file);
}

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else if (entry.isFile() && extname(entry.name) === ".md") files.push(path);
  }
  return files.sort();
}

function validateLesson(file, document) {
  const parts = relative(CONTENT_ROOT, file).split("/");
  const [lang, kind, filename] = parts;
  const slug = filename?.replace(/\.md$/, "");
  if (!LANGUAGES.includes(lang)) fail(file, 1, `language must be ${LANGUAGES.join(" or ")}`);
  if (!KINDS.includes(kind)) fail(file, 1, `kind directory must be ${KINDS.join(", ")}`);
  if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) fail(file, 1, "filename must be a kebab-case slug");
  const title = textField(document, file, "title");
  const summary = textField(document, file, "summary");
  const declaredKind = textField(document, file, "kind");
  if (declaredKind !== kind) fail(file, document.fields.get("kind").line, `kind must be "${kind}"`);
  const products = arrayField(document, file, "products");
  if (products.some((product) => !PRODUCTS.includes(product)) || new Set(products).size !== products.length)
    fail(file, document.fields.get("products").line, `products must use ${PRODUCTS.join(" and ")}`);
  const illustration = textField(document, file, "illustration");
  if (!ILLUSTRATIONS.includes(illustration))
    fail(file, document.fields.get("illustration").line, `illustration must be one of ${ILLUSTRATIONS.join(", ")}`);
  const topic = textField(document, file, "topic");
  if (!TOPICS.includes(topic))
    fail(file, document.fields.get("topic").line, `topic must be one of ${TOPICS.join(", ")}`);
  const minutes = document.fields.get("minutes")?.value;
  if (kind === "tutorial" && (!Number.isInteger(minutes) || minutes < 1))
    fail(file, document.fields.get("minutes")?.line ?? 1, "tutorials require positive integer minutes");
  if (kind !== "tutorial" && minutes !== undefined)
    fail(file, document.fields.get("minutes").line, "only tutorials may declare minutes");
  const cta = document.fields.get("cta")?.value;
  if (
    cta !== undefined &&
    (typeof cta !== "object" || !ACADEMY_CTA_ROUTES.includes(cta.route) || typeof cta.label !== "string" || !cta.label)
  )
    fail(file, document.fields.get("cta").line, "cta must contain an approved route and label");
  const steps = document.fields.get("steps")?.value;
  const headings = [...document.body.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  if (kind === "tutorial" && (!Array.isArray(steps) || steps.length === 0))
    fail(file, document.fields.get("steps")?.line ?? 1, "tutorials require steps");
  if (kind === "tutorial" && JSON.stringify(steps) !== JSON.stringify(headings))
    fail(file, document.fields.get("steps").line, "steps must match the body's H2 titles");
  if (kind !== "tutorial" && steps !== undefined)
    fail(file, document.fields.get("steps").line, "only tutorials may declare steps");
  if (document.lines.length > MAX_LESSON_LINES) fail(file, 1, `lesson exceeds ${MAX_LESSON_LINES} lines`);
  if (kind === "tutorial") {
    const bodyLines = document.body.split("\n");
    for (let index = 0; index < headings.length; index += 1) {
      const start = bodyLines.indexOf(`## ${headings[index]}`);
      const next = index + 1 < headings.length ? bodyLines.indexOf(`## ${headings[index + 1]}`) : bodyLines.length;
      const section = bodyLines.slice(start, next).join("\n");
      if (!/(?:What you will see|Ce que vous verrez)/u.test(section))
        fail(file, start + 1, "each tutorial step needs a what-you-will-see sentence");
      if ([...section.matchAll(/\[(?:illustration|screenshot):[a-z0-9-]+\]/gu)].length !== 1)
        fail(file, start + 1, "each tutorial step needs exactly one visual marker");
    }
    const nextParagraph = document.body.match(/(?:^|\n)(?:Next|Et ensuite)\b[\s\S]*$/u)?.[0] ?? "";
    const nextLinks = [...nextParagraph.matchAll(/academy:\/(\/)(course|tutorial|topic)\/([a-z0-9-]+)/gu)];
    if (
      nextLinks.length < 2 ||
      !nextLinks.some((match) => match[2] === "topic") ||
      !nextLinks.some((match) => match[2] === "tutorial")
    )
      fail(file, 1, "tutorials must close with one topic and one other tutorial academy link");
  }
  return {
    lang,
    kind,
    slug,
    title,
    summary,
    ...(minutes === undefined ? {} : { minutes }),
    products,
    illustration,
    topic,
    ...(cta === undefined ? {} : { cta }),
    ...(steps === undefined ? {} : { steps }),
    body: document.body.trim() + "\n",
  };
}

async function build() {
  const files = await filesUnder(CONTENT_ROOT);
  if (files.length !== 36) throw new Error(`content:1: expected 36 Markdown lessons, found ${files.length}`);
  const lessonKeys = new Set(
    files.map((file) => {
      const [_, kind, filename] = relative(CONTENT_ROOT, file).split("/");
      return `${kind}/${filename?.replace(/\.md$/, "")}`;
    }),
  );
  const lessons = [];
  for (const file of files) {
    const raw = await readFile(file, "utf8");
    const document = readDocument(file, raw);
    await validateLinks(file, document.body, lessonKeys);
    lessons.push(validateLesson(file, document));
  }
  const keys = new Set();
  for (const lesson of lessons) {
    const key = `${lesson.lang}/${lesson.kind}/${lesson.slug}`;
    if (keys.has(key)) throw new Error(`content:1: duplicate lesson ${key}`);
    keys.add(key);
  }
  const normalized = lessons.sort((left, right) =>
    `${left.lang}/${left.kind}/${left.slug}`.localeCompare(`${right.lang}/${right.kind}/${right.slug}`),
  );
  const hash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  const snapshot = { builtAt: new Date().toISOString(), hash, lessons: normalized };
  await writeFile(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  const shotCheck = spawnSync(process.execPath, [join(REPO_ROOT, "scripts", "academy-shots.mjs"), "--check"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (shotCheck.status !== 0) {
    process.stdout.write(
      `Warning: Academy screenshots are incomplete.\n${shotCheck.stdout ?? ""}${shotCheck.stderr ?? ""}`,
    );
  }
  process.stdout.write(`Wrote ${SNAPSHOT_PATH}\nLessons: ${normalized.length}\nHash: ${hash}\n`);
}

build().catch((error) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
