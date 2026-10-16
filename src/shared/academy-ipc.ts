export const ACADEMY_IPC_CHANNELS = {
  list: "omni:academy:list",
  lesson: "omni:academy:lesson",
  screenshot: "omni:academy:screenshot",
  firstLaunch: "omni:academy:first-launch",
} as const;

export type AcademyLanguage = "en" | "fr";
export type AcademyKind = "course" | "tutorial" | "topic";
export type AcademyProduct = "claude-code" | "codex";
export type AcademyTopic =
  "skills" | "plugins" | "marketplaces" | "mcp" | "claude-code" | "codex" | "projects" | "git" | "agents-at-work";
export type AcademyIllustration =
  | "marketplace"
  | "plugin"
  | "skill"
  | "project"
  | "agent"
  | "receipt"
  | "git"
  | "terminal"
  | "claude-code"
  | "codex"
  | "lesson"
  | "course";
export type AcademyCtaRoute = "library-add" | "agents-setup" | "projects" | "review" | "library";

export type AcademyCta = Readonly<{ route: AcademyCtaRoute; label: string }>;

export type AcademyLessonSummary = Readonly<{
  lang: AcademyLanguage;
  kind: AcademyKind;
  slug: string;
  title: string;
  summary: string;
  minutes?: number;
  products: readonly AcademyProduct[];
  illustration: AcademyIllustration;
  topic: AcademyTopic;
  cta?: AcademyCta;
  steps?: readonly string[];
}>;

export type AcademyLesson = AcademyLessonSummary & Readonly<{ body: string }>;
export type AcademySnapshot = Readonly<{ builtAt: string; hash: string; lessons: readonly AcademyLesson[] }>;

export type AcademyListRequest = Readonly<{ lang: AcademyLanguage }>;
export type AcademyLessonRequest = Readonly<{ lang: AcademyLanguage; kind: AcademyKind; slug: string }>;
export type AcademyScreenshotRequest = Readonly<{ name: string }>;
export type AcademyListResponse = Readonly<{ lessons: readonly AcademyLessonSummary[] }>;
export type AcademyLessonResponse =
  Readonly<{ status: "ready"; lesson: AcademyLesson }> | Readonly<{ status: "not-found" }>;
export type AcademyFirstLaunchResponse = Readonly<{ installedAt: string }>;
export type AcademyScreenshotResponse = Readonly<{ dataUrl: string }> | Readonly<{ status: "missing" }>;

export interface AcademyDesktopApi {
  listAcademyLessons(request: AcademyListRequest): Promise<AcademyListResponse>;
  getAcademyLesson(request: AcademyLessonRequest): Promise<AcademyLessonResponse>;
  getAcademyScreenshot(request: AcademyScreenshotRequest): Promise<AcademyScreenshotResponse>;
  getAcademyFirstLaunch(): Promise<AcademyFirstLaunchResponse>;
}

type RecordValue = Record<string, unknown>;

function record(value: unknown, label: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as RecordValue;
}

function keys(value: RecordValue, allowed: readonly string[], label: string): void {
  const set = new Set(allowed);
  for (const key of Object.keys(value))
    if (!set.has(key)) throw new Error(`${label} has an unexpected field "${key}".`);
}

function text(value: unknown, label: string, maxLength = 4000): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength || /[\r\n]/.test(value))
    throw new Error(`${label} must be a safe non-empty string.`);
  return value;
}

function body(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 500_000)
    throw new Error("Academy body is invalid.");
  return value;
}

function language(value: unknown): AcademyLanguage {
  if (value !== "en" && value !== "fr") throw new Error("Academy language is invalid.");
  return value;
}

function kind(value: unknown): AcademyKind {
  if (value !== "course" && value !== "tutorial" && value !== "topic") throw new Error("Academy kind is invalid.");
  return value;
}

function slug(value: unknown): string {
  const result = text(value, "Academy slug", 120);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result)) throw new Error("Academy slug is malformed.");
  return result;
}

export function academyScreenshotName(value: unknown): string {
  const result = text(value, "Academy screenshot name", 80);
  if (!/^[a-z0-9-]+$/.test(result)) throw new Error("Academy screenshot name is malformed.");
  return result;
}

function product(value: unknown): AcademyProduct {
  if (value !== "claude-code" && value !== "codex") throw new Error("Academy product is invalid.");
  return value;
}

function products(value: unknown): readonly AcademyProduct[] {
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length)
    throw new Error("Academy products are invalid.");
  return value.map(product);
}

function topic(value: unknown): AcademyTopic {
  const topics: readonly AcademyTopic[] = [
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
  if (!topics.includes(value as AcademyTopic)) throw new Error("Academy topic is invalid.");
  return value as AcademyTopic;
}

export const ACADEMY_ILLUSTRATIONS: readonly AcademyIllustration[] = [
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

export function isAcademyIllustration(value: unknown): value is AcademyIllustration {
  return ACADEMY_ILLUSTRATIONS.includes(value as AcademyIllustration);
}

function illustration(value: unknown): AcademyIllustration {
  if (!isAcademyIllustration(value)) throw new Error("Academy illustration is invalid.");
  return value;
}

/**
 * A lesson body alternates Markdown with `[illustration:<id>]` lines — the place where a real
 * screenshot will go, rendered as the pictogram tile until then. Unknown ids stay as text so
 * the reader sees the mistake.
 */
export function splitLessonBody(
  body: string,
): readonly (
  | Readonly<{ kind: "markdown"; source: string }>
  | Readonly<{ kind: "illustration"; id: AcademyIllustration }>
  | Readonly<{ kind: "screenshot"; name: string }>
)[] {
  const blocks: (
    | Readonly<{ kind: "markdown"; source: string }>
    | Readonly<{ kind: "illustration"; id: AcademyIllustration }>
    | Readonly<{ kind: "screenshot"; name: string }>
  )[] = [];
  let pending: string[] = [];
  const flush = (): void => {
    if (pending.join("\n").trim()) blocks.push({ kind: "markdown", source: pending.join("\n") });
    pending = [];
  };
  for (const line of body.split("\n")) {
    const screenshot = /^\[screenshot:([a-z0-9-]+)\]\s*$/u.exec(line);
    if (screenshot && screenshot[1]) {
      flush();
      blocks.push({ kind: "screenshot", name: academyScreenshotName(screenshot[1]) });
      continue;
    }
    const match = /^\[illustration:([a-z-]+)\]\s*$/u.exec(line);
    if (match && isAcademyIllustration(match[1])) {
      flush();
      blocks.push({ kind: "illustration", id: match[1] });
    } else pending.push(line);
  }
  flush();
  return blocks;
}

export function parseAcademyScreenshotRequest(value: unknown): AcademyScreenshotRequest {
  const source = record(value, "Academy screenshot request");
  keys(source, ["name"], "Academy screenshot request");
  return { name: academyScreenshotName(source.name) };
}

export function parseAcademyScreenshotResponse(value: unknown): AcademyScreenshotResponse {
  const source = record(value, "Academy screenshot response");
  if (source.status === "missing") {
    keys(source, ["status"], "Academy screenshot response");
    return { status: "missing" };
  }
  keys(source, ["dataUrl"], "Academy screenshot response");
  if (typeof source.dataUrl !== "string" || !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(source.dataUrl))
    throw new Error("Academy screenshot data URL must be a PNG.");
  if (source.dataUrl.length > 2_100_000) throw new Error("Academy screenshot data URL exceeds the size limit.");
  return { dataUrl: source.dataUrl };
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 60)
    throw new Error(`${label} is invalid.`);
  return value;
}

function optionalStrings(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array.`);
  return value.map((item) => text(item, label, 240));
}

function cta(value: unknown): AcademyCta | undefined {
  if (value === undefined) return undefined;
  const source = record(value, "Academy CTA");
  keys(source, ["route", "label"], "Academy CTA");
  const routes: readonly AcademyCtaRoute[] = ["library-add", "agents-setup", "projects", "review", "library"];
  if (!routes.includes(source.route as AcademyCtaRoute)) throw new Error("Academy CTA route is invalid.");
  return { route: source.route as AcademyCtaRoute, label: text(source.label, "Academy CTA label", 160) };
}

export function parseAcademyListRequest(value: unknown): AcademyListRequest {
  const source = record(value, "Academy list request");
  keys(source, ["lang"], "Academy list request");
  return { lang: language(source.lang) };
}

export function parseAcademyLessonRequest(value: unknown): AcademyLessonRequest {
  const source = record(value, "Academy lesson request");
  keys(source, ["lang", "kind", "slug"], "Academy lesson request");
  return { lang: language(source.lang), kind: kind(source.kind), slug: slug(source.slug) };
}

function parseLesson(value: unknown, includeBody: boolean): AcademyLesson {
  const source = record(value, "Academy lesson");
  keys(
    source,
    [
      "lang",
      "kind",
      "slug",
      "title",
      "summary",
      "minutes",
      "products",
      "illustration",
      "topic",
      "cta",
      "steps",
      ...(includeBody ? ["body"] : []),
    ],
    "Academy lesson",
  );
  const lesson = {
    lang: language(source.lang),
    kind: kind(source.kind),
    slug: slug(source.slug),
    title: text(source.title, "Academy title"),
    summary: text(source.summary, "Academy summary", 600),
    ...(source.minutes === undefined ? {} : { minutes: optionalNumber(source.minutes, "Academy minutes") }),
    products: products(source.products),
    illustration: illustration(source.illustration),
    topic: topic(source.topic),
    ...(source.cta === undefined ? {} : { cta: cta(source.cta) }),
    ...(source.steps === undefined ? {} : { steps: optionalStrings(source.steps, "Academy steps") }),
  } as AcademyLessonSummary;
  if (!includeBody) return lesson as AcademyLesson;
  return { ...lesson, body: body(source.body) };
}

export function parseAcademyListResponse(value: unknown): AcademyListResponse {
  const source = record(value, "Academy list response");
  keys(source, ["lessons"], "Academy list response");
  if (!Array.isArray(source.lessons)) throw new Error("Academy lessons must be an array.");
  return { lessons: source.lessons.map((item) => parseLesson(item, false)) };
}

export function parseAcademyLessonResponse(value: unknown): AcademyLessonResponse {
  const source = record(value, "Academy lesson response");
  if (source.status === "not-found") {
    keys(source, ["status"], "Academy lesson response");
    return { status: "not-found" };
  }
  if (source.status !== "ready") throw new Error("Academy lesson response status is invalid.");
  keys(source, ["status", "lesson"], "Academy lesson response");
  return { status: "ready", lesson: parseLesson(source.lesson, true) };
}

export function parseAcademySnapshot(value: unknown): AcademySnapshot {
  const source = record(value, "Academy snapshot");
  keys(source, ["builtAt", "hash", "lessons"], "Academy snapshot");
  const builtAt = text(source.builtAt, "Academy builtAt", 80);
  if (!Number.isFinite(Date.parse(builtAt))) throw new Error("Academy builtAt is invalid.");
  const hash = text(source.hash, "Academy hash", 128);
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Academy hash is invalid.");
  if (!Array.isArray(source.lessons)) throw new Error("Academy lessons must be an array.");
  return { builtAt, hash, lessons: source.lessons.map((item) => parseLesson(item, true)) };
}

export function parseAcademyFirstLaunchRequest(value: unknown): void {
  const source = record(value, "Academy first-launch request");
  keys(source, [], "Academy first-launch request");
}

export function parseAcademyFirstLaunchResponse(value: unknown): AcademyFirstLaunchResponse {
  const source = record(value, "Academy first-launch response");
  keys(source, ["installedAt"], "Academy first-launch response");
  const installedAt = text(source.installedAt, "Academy installedAt", 80);
  if (!Number.isFinite(Date.parse(installedAt))) throw new Error("Academy installedAt is invalid.");
  return { installedAt };
}
