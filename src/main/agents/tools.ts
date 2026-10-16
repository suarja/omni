import { realpath, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { Type, type TSchema } from "typebox";

import type { AgentClient, AgentRouter } from "../agent-gateway/server";
import { readFileByteLimit } from "./context-budget";

export type JobGrants = Readonly<{
  projectId: string;
  projectRoot: string;
  marketplaceRoot: string;
  sourceId: string;
  packageId: string;
}>;

export type JobToolResult = Readonly<{
  content: readonly [{ type: "text"; text: string }];
  details?: unknown;
}>;
export type JobTool = Readonly<{
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  method?: string;
  execute(toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<JobToolResult>;
}>;
export type JobToolOptions = Readonly<{
  router: AgentRouter;
  grants: JobGrants;
  client: AgentClient;
  methods?: readonly string[];
  readFileBudgetTokens?: number;
}>;

const MAX_READ_BYTES = 64 * 1024;
const MAX_PATH_LENGTH = 512;
const MAX_QUERY_LENGTH = 200;
const EMPTY = Type.Object({}, { additionalProperties: false });
const PROJECT_ID = Type.String({ minLength: 1, maxLength: 128 });
const ROOT = Type.Union([Type.Literal("project"), Type.Literal("marketplace")]);

const METHOD_SCHEMAS: Readonly<Record<string, TSchema>> = {
  status: EMPTY,
  list_marketplace: EMPTY,
  skill_inventory: Type.Object(
    {
      projectIds: Type.Optional(Type.Array(PROJECT_ID, { maxItems: 64 })),
      includeMarketplace: Type.Optional(Type.Boolean()),
      cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    },
    { additionalProperties: false },
  ),
  find_skill: Type.Object({ query: Type.Optional(Type.String({ maxLength: 200 })) }, { additionalProperties: false }),
  list_project_assets: Type.Object({ projectId: PROJECT_ID }, { additionalProperties: false }),
  drift_report: Type.Object({ projectId: Type.Optional(PROJECT_ID) }, { additionalProperties: false }),
  receipt: Type.Object(
    {
      operationId: Type.Optional(Type.String({ maxLength: 128 })),
      requestId: Type.Optional(Type.String({ maxLength: 128 })),
    },
    { additionalProperties: false },
  ),
  stack_profile: Type.Object({ projectId: PROJECT_ID }, { additionalProperties: false }),
  catalog_search: Type.Object(
    {
      query: Type.Optional(Type.String({ maxLength: MAX_QUERY_LENGTH })),
      tags: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 20 })),
      projectId: Type.Optional(PROJECT_ID),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    },
    { additionalProperties: false },
  ),
  suggest: Type.Object(
    { projectId: PROJECT_ID, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) },
    { additionalProperties: false },
  ),
  session: Type.Object({ sessionId: Type.String({ minLength: 1, maxLength: 256 }) }, { additionalProperties: false }),
  preview_capture: Type.Object({}, { additionalProperties: false }),
  preview_assign: Type.Object({}, { additionalProperties: false }),
  preview_make_compatible: Type.Object({}, { additionalProperties: false }),
  preview_update_and_maintain_skill: Type.Object({}, { additionalProperties: false }),
  preview_maintain_current_skill: Type.Object({}, { additionalProperties: false }),
  apply: Type.Object({}, { additionalProperties: false }),
};

const CREATE_SKILL_SCHEMA = Type.Object(
  {
    sourceId: Type.String({ minLength: 1, maxLength: 128 }),
    packageId: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    newPackage: Type.Optional(
      Type.Object(
        {
          name: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
          description: Type.String({ minLength: 1, maxLength: 1024 }),
        },
        { additionalProperties: false },
      ),
    ),
    name: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
    description: Type.String({ minLength: 1, maxLength: 1024 }),
    body: Type.String({ minLength: 1, maxLength: 256 * 1024 }),
    files: Type.Optional(Type.Array(Type.Object({ path: Type.String(), content: Type.String() }))),
    reason: Type.Optional(Type.String({ maxLength: 1024 })),
    askInOmni: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
const UPDATE_SKILL_SCHEMA = Type.Object(
  {
    sourceId: Type.String({ minLength: 1, maxLength: 128 }),
    packageId: Type.String({ minLength: 1, maxLength: 512 }),
    folderName: Type.String({ minLength: 1, maxLength: 64 }),
    body: Type.Optional(Type.String({ minLength: 1, maxLength: 256 * 1024 })),
    files: Type.Optional(
      Type.Array(Type.Object({ path: Type.String(), content: Type.String() }, { additionalProperties: false }), {
        minItems: 1,
        maxItems: 32,
      }),
    ),
    replaceFolder: Type.Optional(Type.Boolean()),
    sourceOnly: Type.Optional(Type.Boolean()),
    reason: Type.Optional(Type.String({ maxLength: 1024 })),
    askInOmni: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
const PROPAGATION_SOURCE = Type.Object(
  {
    sourceId: Type.String({ minLength: 1, maxLength: 128 }),
    packageId: Type.String({ minLength: 1, maxLength: 512 }),
    artifactPath: Type.String({ minLength: 1, maxLength: 512 }),
  },
  { additionalProperties: false },
);
const PROPAGATION_LOCATION = Type.Object(
  {
    projectId: Type.String({ minLength: 1, maxLength: 128 }),
    harnessId: Type.Union([Type.Literal("claude-code"), Type.Literal("codex"), Type.Literal("cursor")]),
    folderPath: Type.String({ minLength: 1, maxLength: 512 }),
  },
  { additionalProperties: false },
);
const PROPAGATION_FILE = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: 512 }),
    content: Type.Optional(Type.String({ maxLength: 256 * 1024 })),
    contentBase64: Type.Optional(Type.String({ maxLength: 349528 })),
    encoding: Type.Optional(Type.Literal("base64")),
  },
  { additionalProperties: false },
);
const UPDATE_AND_MAINTAIN_SCHEMA = Type.Object(
  {
    source: PROPAGATION_SOURCE,
    request: Type.Object(
      {
        kind: Type.Literal("write-skill"),
        sourceId: Type.String({ minLength: 1, maxLength: 128 }),
        packageId: Type.String({ minLength: 1, maxLength: 512 }),
        mode: Type.Literal("update"),
        folderName: Type.String({ minLength: 1, maxLength: 64 }),
        files: Type.Array(PROPAGATION_FILE, { minItems: 1, maxItems: 32 }),
        replaceFolder: Type.Optional(Type.Boolean()),
        reason: Type.Optional(Type.String({ maxLength: 1024 })),
      },
      { additionalProperties: false },
    ),
    locations: Type.Optional(Type.Array(PROPAGATION_LOCATION, { minItems: 1, maxItems: 64 })),
    askInOmni: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
const MAINTAIN_CURRENT_SCHEMA = Type.Object(
  {
    source: PROPAGATION_SOURCE,
    locations: Type.Optional(Type.Array(PROPAGATION_LOCATION, { minItems: 1, maxItems: 64 })),
    retryOf: Type.Optional(Type.String({ maxLength: 128 })),
    askInOmni: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
Object.assign(METHOD_SCHEMAS as Record<string, TSchema>, {
  preview_update_and_maintain_skill: UPDATE_AND_MAINTAIN_SCHEMA,
  preview_maintain_current_skill: MAINTAIN_CURRENT_SCHEMA,
  preview_sync_skill: Type.Object(
    {
      sourceId: Type.String({ minLength: 1, maxLength: 128 }),
      packageId: Type.String({ minLength: 1, maxLength: 512 }),
      artifactPath: Type.String({ minLength: 1, maxLength: 512 }),
      projectIds: Type.Optional(Type.Array(PROJECT_ID, { minItems: 1, maxItems: 64 })),
      askInOmni: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
});

function jsonText(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

function textResult(text: string, details?: unknown): JobToolResult {
  return { content: [{ type: "text", text }], ...(details === undefined ? {} : { details }) };
}

function safeRelativePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_LENGTH)
    throw new Error("The read path is invalid.");
  const normalized = value.replaceAll("\\", "/");
  if (
    isAbsolute(normalized) ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..") ||
    normalized.split("/").some((part) => part === ".git" || part === "node_modules")
  )
    throw new Error("The read path must stay inside the granted tree.");
  return normalized;
}

function rootFor(grants: JobGrants, root: unknown): string {
  if (root === "project") return grants.projectRoot;
  if (root === "marketplace") return grants.marketplaceRoot;
  throw new Error('Read root must be "project" or "marketplace".');
}

async function boundedRead(
  grants: JobGrants,
  params: Record<string, unknown>,
  budgetTokens: number | undefined,
): Promise<string> {
  const root = rootFor(grants, params.root);
  const path = safeRelativePath(params.path);
  const rootPath = await realpath(root);
  const filePath = resolve(rootPath, path);
  const actualPath = await realpath(filePath);
  const distance = relative(rootPath, actualPath);
  if (distance.startsWith("..") || isAbsolute(distance)) throw new Error("The read path is outside the grant.");
  const bytes = await readFile(actualPath);
  if (bytes.includes(0)) throw new Error("The file is not a bounded text file.");
  const text = bytes.toString("utf8");
  if (Buffer.from(text, "utf8").compare(bytes) !== 0) throw new Error("The file is not valid UTF-8 text.");
  const maxBytes = budgetTokens === undefined ? MAX_READ_BYTES : readFileByteLimit(budgetTokens);
  if (bytes.byteLength <= maxBytes) return text;
  const marker = `\n\n(file cut to ${maxBytes} of ${bytes.byteLength} bytes)`;
  const available = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  return `${Buffer.from(text, "utf8").subarray(0, available).toString("utf8")}${marker}`;
}

function inventoryStrings(value: unknown, root: "project" | "marketplace", output: string[]): void {
  if (Array.isArray(value)) return value.forEach((item) => inventoryStrings(item, root, output));
  if (typeof value !== "object" || value === null) return;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" && /(?:path|name|skill|artifact|display)/iu.test(key)) output.push(`${root}:${item}`);
    else inventoryStrings(item, root, output);
  }
}

async function boundedSearch(options: JobToolOptions, params: Record<string, unknown>): Promise<readonly string[]> {
  if (typeof params.query !== "string" || params.query.length === 0 || params.query.length > MAX_QUERY_LENGTH)
    throw new Error("The search query is invalid.");
  const limit = params.limit === undefined ? 20 : params.limit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50)
    throw new Error("The search limit must be between 1 and 50.");
  const root = params.root === "project" || params.root === "marketplace" ? params.root : undefined;
  const method = root === "project" ? "list_project_assets" : root === "marketplace" ? "list_marketplace" : undefined;
  if (!root || !method) throw new Error('Search root must be "project" or "marketplace".');
  const response = await options.router.handle(
    method,
    method === "list_project_assets" ? { projectId: options.grants.projectId } : {},
    options.client,
  );
  const strings: string[] = [];
  inventoryStrings(response, root, strings);
  const query = params.query.toLowerCase();
  return strings
    .filter((item, index) => item.toLowerCase().includes(query) && strings.indexOf(item) === index)
    .slice(0, limit)
    .map((item) => item);
}

function assertSkillSize(params: Record<string, unknown>): void {
  const bodies = [
    params.body,
    ...((params.files as readonly { content?: unknown }[] | undefined) ?? []).map((file) => file.content),
  ];
  if (bodies.some((body) => typeof body === "string" && body.split(/\r?\n/u).length > 120))
    throw new Error("Every composed skill must be at most 120 lines.");
}

async function invoke(
  options: JobToolOptions,
  method: string,
  params: Record<string, unknown>,
): Promise<JobToolResult> {
  if (
    method === "skill_inventory" &&
    params.projectIds !== undefined &&
    (!Array.isArray(params.projectIds) || params.projectIds.some((id) => id !== options.grants.projectId))
  )
    throw new Error("Skill inventory must stay within the granted project.");
  const value =
    method === "preview_create_skill"
      ? { ...params, askInOmni: true }
      : method === "skill_inventory"
        ? { ...params, projectIds: params.projectIds ?? [options.grants.projectId] }
        : params;
  if (method === "preview_create_skill") assertSkillSize(value);
  const result = await options.router.handle(method, value, options.client);
  if (method.startsWith("preview_")) {
    if (
      typeof result !== "object" ||
      result === null ||
      typeof (result as { requestId?: unknown }).requestId !== "string"
    )
      throw new Error("The preview did not return a request id.");
    const requestId = (result as { requestId: string }).requestId;
    return textResult(requestId, { requestId });
  }
  return textResult(jsonText(result), result);
}

export function createJobTools(options: JobToolOptions): readonly JobTool[] {
  const methods = options.methods ?? [
    "stack_profile",
    "list_project_assets",
    "skill_inventory",
    "list_marketplace",
    "catalog_search",
    "suggest",
  ];
  const tools: JobTool[] = methods
    .filter(
      (method) =>
        METHOD_SCHEMAS[method] &&
        method !== "preview_update_and_maintain_skill" &&
        method !== "preview_maintain_current_skill",
    )
    .map((method) => ({
      name: `omni_${method}`,
      label: `Omni ${method}`,
      description: `Read the Omni ${method.replaceAll("_", " ")} surface.`,
      parameters: METHOD_SCHEMAS[method]!,
      method,
      execute: async (_toolCallId, params) => invoke(options, method, params),
    }));
  if (methods.includes("read_file"))
    tools.push({
      name: "read_file",
      label: "Read file",
      description: "Read one bounded UTF-8 text file inside the granted project or marketplace root.",
      parameters: Type.Object(
        { root: ROOT, path: Type.String({ minLength: 1, maxLength: MAX_PATH_LENGTH }) },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, params) =>
        textResult(await boundedRead(options.grants, params, options.readFileBudgetTokens)),
    });
  if (methods.includes("search"))
    tools.push({
      name: "search",
      label: "Search inventory",
      description: "Search observed paths and skill names without reading file content.",
      parameters: Type.Object(
        {
          root: ROOT,
          query: Type.String({ minLength: 1, maxLength: MAX_QUERY_LENGTH }),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, params) => textResult(jsonText(await boundedSearch(options, params))),
    });
  if (methods.includes("preview_create_skill"))
    tools.push({
      name: "omni_preview_create_skill",
      label: "Preview skill creation",
      description: "Create one skill preview in Omni Review; this always asks in Omni.",
      parameters: CREATE_SKILL_SCHEMA,
      method: "preview_create_skill",
      execute: async (_toolCallId, params) => invoke(options, "preview_create_skill", params),
    });
  if (methods.includes("preview_update_skill"))
    tools.push({
      name: "omni_preview_update_skill",
      label: "Preview skill update",
      description:
        "Preview an owned skill update including eligible linked copies. Use sourceOnly to update only the marketplace.",
      parameters: UPDATE_SKILL_SCHEMA,
      method: "preview_update_skill",
      execute: async (_toolCallId, params) => invoke(options, "preview_update_skill", params),
    });
  if (methods.includes("preview_update_and_maintain_skill"))
    tools.push({
      name: "omni_preview_update_and_maintain_skill",
      label: "Preview skill update and linked copies",
      description: "Review one owned skill update and its selected linked project copies together.",
      parameters: UPDATE_AND_MAINTAIN_SCHEMA,
      method: "preview_update_and_maintain_skill",
      execute: async (_toolCallId, params) => invoke(options, "preview_update_and_maintain_skill", params),
    });
  if (methods.includes("preview_maintain_current_skill"))
    tools.push({
      name: "omni_preview_maintain_current_skill",
      label: "Preview linked skill maintenance",
      description: "Review maintenance from the current owned skill without changing its source.",
      parameters: MAINTAIN_CURRENT_SCHEMA,
      method: "preview_maintain_current_skill",
      execute: async (_toolCallId, params) => invoke(options, "preview_maintain_current_skill", params),
    });
  return tools;
}

export { METHOD_SCHEMAS };
