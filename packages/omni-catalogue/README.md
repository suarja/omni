# Omni catalogue

`catalogue.json`: a snapshot of the public [skills.sh](https://skills.sh) leaderboard — the
open directory of agent skills — that Omni Desktop ships and reads at level 0 (no account, no
network at run time). It feeds the
**Catalogue** tab in the Library (`src/main/catalogue/`) alongside the personal and
external marketplaces the app already observes.

## What it contains

Each entry:

```json
{
  "source": "skills.sh",
  "ownerRepo": "anthropics/skills",
  "skill": "frontend-design",
  "name": "frontend-design",
  "description": "Guidance for distinctive, intentional visual design …",
  "path": "SKILL.md",
  "url": "https://raw.githubusercontent.com/anthropics/skills/HEAD/SKILL.md",
  "tags": ["react", "tailwind"],
  "installs": 886327,
  "weeklyInstalls": [24780, 26152, "…"],
  "official": true,
  "fetchedAt": "2026-09-14T21:00:00.000Z",
  "hash": "sha256…"
}
```

`path`/`url`/`hash` are absent when the skill's `SKILL.md` could not be found under any of the
[`skills` CLI](https://github.com/vercel-labs/skills) convention paths — the entry is still
listed with the leaderboard's install count and the skill page's JSON-LD description.

## Building the snapshot

```bash
pnpm --filter @omni/catalogue build   # or: pnpm build:catalogue, from the repo root
```

`scripts/build.mjs` is plain Node, **>= 23** (see "Node version" below), no dependencies beyond
the runtime:

1. Fetches `https://skills.sh/` and extracts the `initialSkills` array embedded in its React
   Server Components payload (fails loudly if it finds fewer than 200 entries — the page shape
   changed and the extractor needs updating, not a silently empty catalogue).
2. For each skill, fetches its own `skills.sh/<owner>/<repo>/<skill>` page for the
   `SoftwareApplication` JSON-LD description and the `npx skills add …` install command (the
   repository's `owner/repo`).
3. Resolves the `SKILL.md` path in two stages:
   - **Stage 1**: probes six convention locations (`SKILL.md`, `skills/<skill>/SKILL.md`,
     `.claude/skills/<skill>/SKILL.md`, `.agents/…`, `.codex/…`, `.cursor/…`) against
     `raw.githubusercontent.com` with `HEAD` requests (unauthenticated; at most 4 concurrent,
     30 s timeout, retried with backoff on `429`/`5xx`).
   - **Stage 2** (when stage 1 misses): fetches the repository's whole file tree once via the Git
     Trees API (`GET /repos/<owner>/<repo>/git/trees/HEAD?recursive=1`, cached per repo under
     `.cache/trees/`) and matches every `SKILL.md` blob whose parent folder is named `<skill>`
     (`**/<skill>/SKILL.md`, shallowest path wins), plus a root `SKILL.md` when `<skill>` equals
     the repo name — this is what finds categorised layouts like
     `skills/<category>/<skill>/SKILL.md` that stage 1's fixed paths can't guess. GitHub's
     unauthenticated API allows 60 requests/hour; a run that gets `403`/`429` from a repo's tree
     leaves that repo's resolution cache unwritten (rather than caching a permanent "not found")
     and reports `N repos skipped by rate limit, rerun later` instead of failing the build.
4. Reads the resolved file's frontmatter `description` via
   `src/adapters/inventory/frontmatter.ts`'s `parseFrontmatter` and tags the entry with
   `src/domain/stack-tags.ts`'s `tagsForText` — both imported directly (see "Node version" below),
   not copied.

Every fetched page, repo tree, and resolved path is cached under `.cache/` (git-ignored): a
re-run reuses what is already there, so an interrupted build — or one cut short by a GitHub rate
limit — can just be started again.

An optional `GITHUB_TOKEN` environment variable, if set, is sent to both `raw.githubusercontent.com`
and `api.github.com` to raise their anonymous rate limits — it is never required and never sent to
skills.sh. Reading it is the build script's only environment access.

### Node version

The build script imports `../../src/domain/stack-tags.ts` and
`../../src/adapters/inventory/frontmatter.ts` directly, by relative path, rather than keeping
copies in sync — Node strips their type annotations at load time. This needs **Node >= 23**
(type stripping shipped unflagged in 23.6; on 22.6–23.5 it works only behind
`--experimental-strip-types`). Both files use only erasable TypeScript syntax (type aliases,
typed parameters — no enums, namespaces, or decorators), so no build step or transpilation is
needed.

## Runtime scope

The snapshot is read locally. Rebuilding it needs network access; launching Omni does not.
