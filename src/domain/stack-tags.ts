/**
 * The one deterministic tag table for the stack profile (level 0: no model, no network).
 * Every rule proves a tag from files the inventory port read under a project's granted root —
 * `src/main/stack-profile-ipc.ts` walks the tree and feeds this table through
 * `detectStack` (`src/domain/stack-profile.ts`). Adding a technology means adding one row here.
 */

export type StackTagRule =
  | Readonly<{ kind: "dependency"; names: readonly string[] }>
  | Readonly<{ kind: "file"; paths: readonly string[] }>
  | Readonly<{ kind: "manifest"; path: string; keys?: readonly string[] }>
  | Readonly<{ kind: "script"; contains: readonly string[] }>;

export type StackTagDefinition = Readonly<{
  id: string;
  label: string;
  rules: readonly StackTagRule[];
  /** How much a match on this tag says about a fit: broad tags carried by most JS projects weigh less (default 1). */
  weight?: number;
}>;

export const STACK_TAGS: readonly StackTagDefinition[] = [
  {
    id: "next",
    label: "Next.js",
    rules: [
      { kind: "dependency", names: ["next"] },
      { kind: "file", paths: ["next.config.js", "next.config.mjs", "next.config.ts"] },
    ],
  },
  { id: "react", weight: 0.4, label: "React", rules: [{ kind: "dependency", names: ["react"] }] },
  { id: "react-native", label: "React Native", rules: [{ kind: "dependency", names: ["react-native"] }] },
  {
    id: "expo",
    label: "Expo",
    rules: [
      { kind: "dependency", names: ["expo"] },
      { kind: "manifest", path: "app.json", keys: ["expo"] },
      { kind: "file", paths: ["app.config.js", "app.config.ts"] },
    ],
  },
  { id: "vue", label: "Vue", rules: [{ kind: "dependency", names: ["vue"] }] },
  {
    id: "nuxt",
    label: "Nuxt",
    rules: [
      { kind: "dependency", names: ["nuxt"] },
      { kind: "file", paths: ["nuxt.config.ts", "nuxt.config.js"] },
    ],
  },
  {
    id: "svelte",
    label: "Svelte",
    rules: [
      { kind: "dependency", names: ["svelte"] },
      { kind: "file", paths: ["svelte.config.js"] },
    ],
  },
  {
    id: "astro",
    label: "Astro",
    rules: [
      { kind: "dependency", names: ["astro"] },
      { kind: "file", paths: ["astro.config.mjs", "astro.config.ts"] },
    ],
  },
  {
    id: "vite",
    label: "Vite",
    rules: [
      { kind: "dependency", names: ["vite"] },
      { kind: "file", paths: ["vite.config.ts", "vite.config.js", "vite.config.mjs"] },
    ],
  },
  {
    id: "electron",
    label: "Electron",
    rules: [
      { kind: "dependency", names: ["electron"] },
      { kind: "file", paths: ["electron.vite.config.ts", "electron.vite.config.js", "electron-builder.yml"] },
    ],
  },
  {
    id: "tailwind",
    label: "Tailwind CSS",
    rules: [
      { kind: "dependency", names: ["tailwindcss"] },
      { kind: "file", paths: ["tailwind.config.js", "tailwind.config.ts", "tailwind.config.cjs"] },
    ],
  },
  {
    id: "convex",
    label: "Convex",
    rules: [
      { kind: "dependency", names: ["convex"] },
      { kind: "file", paths: ["convex"] },
    ],
  },
  {
    id: "supabase",
    label: "Supabase",
    rules: [
      { kind: "dependency", names: ["@supabase/supabase-js"] },
      { kind: "file", paths: ["supabase/config.toml"] },
    ],
  },
  {
    id: "prisma",
    label: "Prisma",
    rules: [
      { kind: "dependency", names: ["prisma", "@prisma/client"] },
      { kind: "file", paths: ["prisma/schema.prisma"] },
    ],
  },
  {
    id: "drizzle",
    label: "Drizzle",
    rules: [
      { kind: "dependency", names: ["drizzle-orm"] },
      { kind: "file", paths: ["drizzle.config.ts"] },
    ],
  },
  {
    id: "postgres",
    label: "PostgreSQL",
    rules: [{ kind: "dependency", names: ["pg", "postgres", "@neondatabase/serverless"] }],
  },
  {
    id: "clerk",
    label: "Clerk",
    rules: [{ kind: "dependency", names: ["@clerk/nextjs", "@clerk/clerk-react", "@clerk/expo", "@clerk/backend"] }],
  },
  { id: "stripe", label: "Stripe", rules: [{ kind: "dependency", names: ["stripe", "@stripe/stripe-js"] }] },
  {
    id: "vitest",
    weight: 0.4,
    label: "Vitest",
    rules: [
      { kind: "dependency", names: ["vitest"] },
      { kind: "file", paths: ["vitest.config.ts", "vitest.config.js"] },
    ],
  },
  {
    id: "jest",
    weight: 0.4,
    label: "Jest",
    rules: [
      { kind: "dependency", names: ["jest"] },
      { kind: "file", paths: ["jest.config.js", "jest.config.ts"] },
    ],
  },
  {
    id: "playwright",
    label: "Playwright",
    rules: [
      { kind: "dependency", names: ["@playwright/test", "playwright"] },
      { kind: "file", paths: ["playwright.config.ts", "playwright.config.js"] },
    ],
  },
  {
    id: "cypress",
    label: "Cypress",
    rules: [
      { kind: "dependency", names: ["cypress"] },
      { kind: "file", paths: ["cypress.config.ts", "cypress.config.js"] },
    ],
  },
  {
    id: "typescript",
    weight: 0.4,
    label: "TypeScript",
    rules: [
      { kind: "dependency", names: ["typescript"] },
      { kind: "file", paths: ["tsconfig.json"] },
    ],
  },
  { id: "node", weight: 0.4, label: "Node.js", rules: [{ kind: "file", paths: ["package.json"] }] },
  { id: "bun", label: "Bun", rules: [{ kind: "file", paths: ["bun.lock", "bun.lockb"] }] },
  {
    id: "python",
    label: "Python",
    rules: [{ kind: "file", paths: ["pyproject.toml", "requirements.txt", "setup.py"] }],
  },
  {
    id: "django",
    label: "Django",
    rules: [
      { kind: "manifest", path: "requirements.txt", keys: ["django"] },
      { kind: "manifest", path: "pyproject.toml", keys: ["django"] },
    ],
  },
  {
    id: "fastapi",
    label: "FastAPI",
    rules: [
      { kind: "manifest", path: "requirements.txt", keys: ["fastapi"] },
      { kind: "manifest", path: "pyproject.toml", keys: ["fastapi"] },
    ],
  },
  { id: "rust", label: "Rust", rules: [{ kind: "file", paths: ["Cargo.toml"] }] },
  { id: "go", label: "Go", rules: [{ kind: "file", paths: ["go.mod"] }] },
  { id: "ruby", label: "Ruby", rules: [{ kind: "file", paths: ["Gemfile"] }] },
  { id: "rails", label: "Ruby on Rails", rules: [{ kind: "manifest", path: "Gemfile", keys: ["rails"] }] },
  {
    id: "docker",
    weight: 0.4,
    label: "Docker",
    rules: [
      {
        kind: "file",
        paths: ["Dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"],
      },
      { kind: "script", contains: ["docker"] },
    ],
  },
  {
    id: "github-actions",
    weight: 0.4,
    label: "GitHub Actions",
    rules: [{ kind: "file", paths: [".github/workflows"] }],
  },
  {
    id: "i18n",
    label: "Internationalization (i18n)",
    rules: [{ kind: "dependency", names: ["next-intl", "i18next", "react-i18next"] }],
  },
];

/**
 * The basenames the main process must read the content of: `package.json` (dependency and
 * script rules need its `dependencies`/`devDependencies`/`scripts`) plus every path named by a
 * `manifest` rule above. Derived from `STACK_TAGS` so the read allowlist never drifts from the
 * table it serves.
 */
export const MANIFEST_BASENAMES: ReadonlySet<string> = new Set([
  "package.json",
  ...STACK_TAGS.flatMap((tag) => tag.rules).flatMap((rule) => (rule.kind === "manifest" ? [rule.path] : [])),
]);

/** One table: file extension (lowercase, no dot) → the language it counts toward. */
export const EXTENSION_LANGUAGES: Readonly<Record<string, string>> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  rs: "Rust",
  go: "Go",
  rb: "Ruby",
  java: "Java",
  kt: "Kotlin",
  kts: "Kotlin",
  swift: "Swift",
  c: "C",
  h: "C",
  cc: "C++",
  cpp: "C++",
  cxx: "C++",
  hpp: "C++",
  cs: "C#",
  php: "PHP",
  css: "CSS",
  scss: "SCSS",
  sass: "SCSS",
  html: "HTML",
  htm: "HTML",
  json: "JSON",
  md: "Markdown",
  mdx: "Markdown",
  yml: "YAML",
  yaml: "YAML",
  sql: "SQL",
  sh: "Shell",
  bash: "Shell",
  vue: "Vue",
  svelte: "Svelte",
  toml: "TOML",
};

/**
 * The keywords `tagsForText` matches against free text: the tag's own id and label, every
 * `dependency` rule's package names, and every `manifest` rule's keys (`django`, `fastapi`,
 * `rails`, …). File-only and script-only rules add no extra keyword — "Docker" and "GitHub
 * Actions" already match through their label.
 */
function keywordsForTag(definition: StackTagDefinition): readonly string[] {
  const keywords = new Set<string>([definition.id.toLowerCase(), definition.label.toLowerCase()]);
  for (const rule of definition.rules) {
    if (rule.kind === "dependency") for (const name of rule.names) keywords.add(name.toLowerCase());
    if (rule.kind === "manifest") for (const key of rule.keys ?? []) keywords.add(key.toLowerCase());
  }
  return [...keywords].filter((keyword) => keyword.length > 0);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pure keyword tagger shared by the catalogue index (`src/main/catalogue/index.ts`) and the
 * catalogue build script (`packages/omni-catalogue/scripts/build.mjs`, Brief 34b, imported
 * directly — Node strips this file's type annotations at load time, see the build script's
 * header comment): every `STACK_TAGS` id whose id, label, or one of its dependency/manifest
 * keywords appears in `text` as a whole token (case-insensitive, no word-character neighbour on
 * either side — so `react` does not match `reactive`). No file IO, no network. `STACK_TAGS`
 * above is the one table of record; there is no copy left to drift.
 */
export function tagsForText(text: string): readonly string[] {
  const matches: string[] = [];
  for (const definition of STACK_TAGS) {
    const found = keywordsForTag(definition).some((keyword) =>
      new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(keyword)}(?![A-Za-z0-9])`, "iu").test(text),
    );
    if (found) matches.push(definition.id);
  }
  return matches;
}
