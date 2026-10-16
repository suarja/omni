import { z } from "zod";

import type { AgentClient, AgentRouter } from "../../agent-gateway/server";
import { budgetSections, type ContextSection } from "../context-budget";

export const composeOutputSchema = z.object({
  requestIds: z.array(z.string()).max(3),
  summary: z.string().max(400),
});

export type ComposeJobContext = Readonly<{ router: AgentRouter; client: AgentClient; contextBudget?: number }>;
export type ComposeJob = Readonly<{
  id: "compose";
  tools: readonly string[];
  system: string;
  input(projectId: string, context: ComposeJobContext): Promise<string>;
  writeBudget: 3;
  output: typeof composeOutputSchema;
}>;

const READ_METHODS = ["stack_profile", "list_project_assets", "list_marketplace", "suggest"] as const;

async function read(context: ComposeJobContext, method: string, params: Record<string, unknown>): Promise<unknown> {
  return context.router.handle(method, params, context.client);
}

function listCount(value: unknown, keys: readonly string[]): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const count = keys.reduce((total, key) => total + (Array.isArray(record[key]) ? record[key].length : 0), 0);
  return count || undefined;
}

export function composeContextSections(
  system: string,
  projectId: string,
  stack: unknown,
  assets: unknown,
  marketplace: unknown,
  suggestions: unknown,
): readonly ContextSection[] {
  return [
    { name: "system prompt", content: system, priority: 6 },
    { name: "stack profile", content: JSON.stringify({ projectId, stack }), priority: 5 },
    {
      name: "project conventions excerpt",
      content: JSON.stringify({ instruction: "Read CLAUDE.md or AGENTS.md with read_file before drafting.", assets }),
      priority: 4,
      itemCount: listCount(assets, ["managed", "unmanaged"]),
    },
    {
      name: "project assets",
      content: JSON.stringify(assets),
      priority: 3,
      itemCount: listCount(assets, ["managed", "unmanaged"]),
    },
    {
      name: "marketplace skills",
      content: JSON.stringify(marketplace),
      priority: 2,
      itemCount: listCount(marketplace, ["packages", "artifacts"]),
    },
    {
      name: "suggestions",
      content: JSON.stringify(suggestions),
      priority: 1,
      itemCount: listCount(suggestions, ["results", "suggestions"]),
    },
  ];
}

export const composeJob: ComposeJob = {
  id: "compose",
  tools: [...READ_METHODS, "catalog_search", "read_file", "search", "preview_create_skill"],
  writeBudget: 3,
  output: composeOutputSchema,
  system: [
    "You are Omni's bounded Compose job.",
    "Compose one small skill set for the requested project as one plugin, with at most three skills.",
    "Read the project's CLAUDE.md or AGENTS.md conventions with read_file before drafting.",
    "Use only tool names and Omni data that you actually read; never invent tools.",
    "Every skill must be at most 120 lines. Call omni_preview_create_skill once per proposed skill.",
    "The app forces askInOmni=true. Never call apply. Return no factual prose that is not represented by a preview.",
  ].join("\n"),
  async input(projectId, context): Promise<string> {
    const [stack, assets, marketplace, suggestions] = await Promise.all([
      read(context, "stack_profile", { projectId }),
      read(context, "list_project_assets", { projectId }),
      read(context, "list_marketplace", {}),
      read(context, "suggest", { projectId, limit: 8 }),
    ]);
    const sections = composeContextSections(composeJob.system, projectId, stack, assets, marketplace, suggestions);
    return budgetSections(sections, context.contextBudget ?? 80_000).prompt;
  },
};

export const COMPOSE_READ_METHODS = READ_METHODS;
