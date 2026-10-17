import type { ApprovalReason } from "../../../src/shared/agents-ipc.js";
import { summarizeOmniApproval } from "./approval-text.js";

type Action = Readonly<{
  kind?: unknown;
  diff?: unknown;
  state?: unknown;
  relativePath?: unknown;
  harnessId?: unknown;
}>;
type Plan = Readonly<{
  kind?: unknown;
  displayTarget?: unknown;
  actions?: readonly Action[];
  git?: Readonly<{ mode?: unknown }>;
  notes?: readonly string[];
  plans?: readonly Readonly<{ projectId?: unknown; actions?: readonly Action[] }>[];
}>;
type Approval = "conversation" | "omni";

function actionsOf(plan: Plan): readonly Action[] {
  if (Array.isArray(plan.actions)) return plan.actions;
  return (plan.plans ?? []).flatMap((item) => item.actions ?? []);
}

function plural(value: number, singular: string, pluralForm = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : pluralForm}`;
}

export function summarizePlan(plan: Plan, approval: Approval = "omni", reason?: ApprovalReason): string {
  const actions = actionsOf(plan);
  const assignments = (plan.plans ?? []).flatMap((item) => item.actions ?? []);
  const assignmentChanges = assignments.filter(
    (action) => action.state === "add" || action.state === "update" || action.state === "conflict",
  );
  const assignmentProjects = new Set(
    (plan.plans ?? [])
      .filter((item) =>
        (item.actions ?? []).some(
          (action) => action.state === "add" || action.state === "update" || action.state === "conflict",
        ),
      )
      .map((item) => item.projectId),
  ).size;
  const assignmentTargets = [
    ...new Set(
      assignmentChanges
        .map((action) =>
          [action.harnessId, action.relativePath]
            .filter((value): value is string => typeof value === "string")
            .join(" "),
        )
        .filter(Boolean),
    ),
  ].sort();
  const files = actions.filter((action) => action.kind === "write-file").length;
  const directories = uniqueActions(actions, "create-directory");
  const updates = actions.filter((action) => typeof action.diff === "string" && action.diff.length > 0).length;
  const gitMode = plan.git?.mode;
  const target = typeof plan.displayTarget === "string" ? plan.displayTarget.split("/").at(-1) : undefined;
  const parts: string[] = [];
  if (plan.kind === "assign") {
    parts.push(
      assignmentChanges.length
        ? `${plural(assignmentChanges.length, "binding change")} across ${plural(assignmentProjects, "project")}${assignmentTargets.length ? ` (${assignmentTargets.join("; ")})` : ""}`
        : "No binding changes",
    );
    const conflicts = assignments.filter((action) => action.state === "conflict").length;
    if (conflicts) parts.push(`${plural(conflicts, "conflict")} to review`);
  }
  if (
    (plan.kind === "link-storefront" ||
      plan.kind === "archive-storefront" ||
      plan.kind === "register-project" ||
      plan.kind === "import-artifact" ||
      plan.kind === "write-skill") &&
    plan.notes?.length
  )
    parts.push(...plan.notes);
  if (files) parts.push(`${plural(files, "file", "files")} to write`);
  if (directories) parts.push(`${plural(directories, "directory", "directories")} to create`);
  if (!parts.length) parts.push("No file or directory changes");
  if (updates > 0) parts.push(plural(updates, "update", "updates") + " to review");
  if (gitMode === "commit" || gitMode === "init-and-commit" || gitMode === "enclosing-repository")
    parts.push(`one commit${target ? ` in ${target}` : ""}`);
  return `${parts.join(", ")}. ${approval === "conversation" ? "— existing clear approval for this plan permits omni_apply; ask once only if approval is missing" : summarizeOmniApproval(reason)}`;
}

export function summarizeSkillPreview(
  value: Record<string, unknown>,
  approval: Approval = "omni",
  reason?: ApprovalReason,
): string {
  const steps = Array.isArray(value.steps) ? (value.steps as readonly Record<string, unknown>[]) : [];
  const files = steps.flatMap((step) =>
    Array.isArray(step.files) ? (step.files as readonly Record<string, unknown>[]) : [],
  );
  const added = files.filter((file) => file.change === "add").length;
  const changed = files.filter((file) => file.change === "change").length;
  const removed = files.filter((file) => file.change === "delete").length;
  const unchanged = files.filter((file) => file.change === "unchanged").length;
  const scope = typeof value.scope === "object" && value.scope !== null ? (value.scope as Record<string, unknown>) : {};
  const targets = Array.isArray(scope.targets) ? (scope.targets as readonly Record<string, unknown>[]) : [];
  const projects = new Set(
    targets.map((target) => target.projectId).filter((item): item is string => typeof item === "string"),
  );
  const bindings = new Set(
    targets.map((target) => target.bindingId).filter((item): item is string => typeof item === "string"),
  );
  const kinds = new Set(
    steps.map((step) => {
      const plan = typeof step.plan === "object" && step.plan !== null ? (step.plan as Record<string, unknown>) : {};
      return plan.kind;
    }),
  );
  const parts: string[] = [];
  if (!targets.length && typeof scope.sourceId === "string")
    parts.push("Source-only change; no project assignment occurred");
  if (kinds.has("apply-plan"))
    parts.push(
      `${plural(bindings.size || targets.length, "managed target")} across ${plural(projects.size, "project")}`,
    );
  if (kinds.has("remove-binding")) parts.push(`${plural(bindings.size || targets.length, "managed use")} to remove`);
  if (kinds.has("restore-apply") || kinds.has("restore-import"))
    parts.push(`${plural(files.length, "file", "files")} to restore`);
  if (added) parts.push(`${plural(added, "file", "files")} to add`);
  if (changed) parts.push(`${plural(changed, "file", "files")} to update`);
  if (removed) parts.push(`${plural(removed, "file", "files")} to remove`);
  if (unchanged) parts.push(`${plural(unchanged, "file", "files")} unchanged`);
  if (!parts.length) parts.push("No file or binding changes");
  const authorization =
    approval === "conversation"
      ? "Existing clear approval for this scope permits omni_apply; ask once only if approval is missing or scope changed."
      : summarizeOmniApproval(reason);
  return `${parts.join(", ")}. ${authorization}`;
}

export function summarizeSkillResult(value: Record<string, unknown>): string {
  const status = typeof value.status === "string" ? value.status : "unknown";
  const source =
    typeof value.source === "object" && value.source !== null ? (value.source as Record<string, unknown>) : {};
  const targets = Array.isArray(value.targets)
    ? value.targets.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    : [];
  const failures = targets.filter((target) =>
    ["failed", "cancelled", "skipped", "retained-local"].includes(String(target.status)),
  );
  const issues = Array.isArray(value.issues)
    ? value.issues.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    : [];
  const receiptIds = Array.isArray(value.receiptIds) ? value.receiptIds : [];
  const sourceStatus =
    typeof source.status === "string" && source.status !== "unchanged" ? `Source ${source.status}. ` : "";
  const targetDetails = failures.slice(0, 5).map((target) => {
    const targetId = typeof target.projectId === "string" ? target.projectId : "unknown project";
    const harnessId = typeof target.harnessId === "string" ? ` (${target.harnessId})` : "";
    const path = typeof target.artifactPath === "string" ? ` at ${target.artifactPath}` : "";
    const detail =
      typeof target.issue === "object" && target.issue !== null
        ? (target.issue as Record<string, unknown>).message
        : undefined;
    return `${targetId}${harnessId}${path}: ${String(target.status)}${typeof detail === "string" ? ` — ${detail}` : ""}`;
  });
  const issueDetails = issues
    .slice(0, 3)
    .map((issue) => (typeof issue.message === "string" ? issue.message : undefined))
    .filter(Boolean);
  const receipts = receiptIds.length ? ` ${plural(receiptIds.length, "receipt")} recorded.` : "";
  if (status === "no-op") return `${sourceStatus}No changes were needed.${receipts}`;
  if (status === "recovery-required")
    return `${sourceStatus}Recovery is required. Inspect the saved operation and receipts before retrying.${targetDetails.length ? ` Affected targets: ${targetDetails.join("; ")}.` : ""}${receipts}`;
  if (status === "failed" || status === "cancelled")
    return `${sourceStatus}Operation ${status}.${targetDetails.length ? ` Affected targets: ${targetDetails.join("; ")}.` : ""}${issueDetails.length ? ` ${issueDetails.join("; ")}` : ""}${receipts}`;
  if (status === "partial")
    return `${sourceStatus}Operation partially completed. ${plural(targets.filter((target) => target.status === "applied" || target.status === "removed" || target.status === "restored").length, "target")} completed; ${failures.length} did not complete.${targetDetails.length ? ` Affected targets: ${targetDetails.join("; ")}.` : ""}${receipts}`;
  if (status === "restored") return `${sourceStatus}Operation restored.${receipts}`;
  if (status === "applied")
    return `${sourceStatus}${targets.length ? `${plural(targets.length, "target")} processed.` : "Operation applied."}${receipts}`;
  return `Omni returned an unknown skill operation status.${issueDetails.length ? ` ${issueDetails.join("; ")}` : ""}`;
}

function uniqueActions(actions: readonly Action[], kind: string): number {
  return new Set(
    actions
      .filter((action) => action.kind === kind)
      .map((action) =>
        typeof action.relativePath === "string"
          ? `${kind}:${action.relativePath}`
          : `${kind}:${JSON.stringify(action)}`,
      ),
  ).size;
}

export function summarizeReceipt(receipt: Record<string, unknown>): string {
  const actions = Array.isArray(receipt.actions) ? receipt.actions : [];
  const files = actions.filter((action) => {
    const kind = typeof action === "object" && action !== null ? (action as { kind?: unknown }).kind : undefined;
    return kind === "write-file";
  }).length;
  const directoryActions: Action[] = actions.flatMap((action) => {
    if (typeof action !== "object" || action === null) return [];
    const candidate = action as { kind?: unknown; relativePath?: unknown };
    return candidate.kind === "create-directory"
      ? [{ kind: candidate.kind, relativePath: candidate.relativePath }]
      : [];
  });
  const directories = uniqueActions(directoryActions, "create-directory");
  const git = typeof receipt.git === "object" && receipt.git !== null ? (receipt.git as { commit?: unknown }) : {};
  const commit = typeof git.commit === "string" ? `, commit ${git.commit}` : "";
  const approval =
    typeof receipt.provenance === "object" && receipt.provenance !== null
      ? (receipt.provenance as { approval?: unknown }).approval
      : undefined;
  const approvalText = approval === "conversation" ? "Approved in conversation" : "Approved in Omni";
  const changes =
    [
      files ? `${plural(files, "file", "files")} written` : "",
      directories ? `${plural(directories, "directory", "directories")} created` : "",
    ]
      .filter(Boolean)
      .join(", ") || "no file changes";
  return `${approvalText}: ${changes}${commit}.`;
}

export function summarizeApply(value: Record<string, unknown>): string {
  if (typeof value.intentId === "string" && Array.isArray(value.targets)) return summarizeSkillResult(value);
  const receipts = Array.isArray(value.receipts)
    ? value.receipts.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    : [];
  if (value.status === "applied" && receipts.length)
    return `${plural(receipts.length, "receipt")} applied. ${receipts.map(summarizeReceipt).join(" ")}`;
  if (value.status === "applied" && typeof value.receipt === "object" && value.receipt !== null)
    return summarizeReceipt(value.receipt as Record<string, unknown>);
  if (value.status === "pending") return summarizeOmniApproval(value.approvalReason as ApprovalReason | undefined);
  if (value.status === "declined") return "Declined in Omni.";
  if (value.status === "expired") return "The Omni approval request expired.";
  if (value.status === "stale")
    return typeof value.message === "string" ? value.message : "The files changed; preview again.";
  if (value.status === "no-op") return "No changes were needed.";
  if (value.status === "restored") return "The operation was restored.";
  if (value.status === "partial" || value.status === "recovery-required" || value.status === "cancelled") {
    const detail = typeof value.message === "string" ? ` ${value.message}` : "";
    const receiptsText = receipts.length ? ` ${plural(receipts.length, "receipt")} recorded.` : "";
    const instruction =
      value.status === "recovery-required"
        ? " Inspect the saved operation before retrying."
        : value.status === "partial"
          ? " Review affected targets and receipts before retrying."
          : "";
    return `The operation ended with status ${value.status}.${receiptsText}${instruction}${detail}`;
  }
  if (value.status === "failed") {
    const receipt =
      typeof value.receipt === "object" && value.receipt !== null
        ? (value.receipt as Record<string, unknown>)
        : undefined;
    const detail = typeof value.message === "string" ? value.message : receipt?.diagnostic;
    const receiptSummary = receipts.length
      ? ` ${plural(receipts.length, "receipt")} recorded: ${receipts.map(summarizeReceipt).join(" ")}`
      : receipt
        ? ` ${summarizeReceipt(receipt)}`
        : "";
    return `Omni could not apply the approved operation.${receiptSummary}${typeof detail === "string" && detail ? ` ${detail}` : ""}`;
  }
  return "Omni returned an unknown apply status.";
}

type StackTagLike = Readonly<{ label?: unknown }>;

export function summarizeStackProfile(value: Record<string, unknown>): string {
  if (value.status !== "ready" || typeof value.profile !== "object" || value.profile === null)
    return "No stack profile is available for this project.";
  const tags = (value.profile as { tags?: readonly StackTagLike[] }).tags ?? [];
  const labels = tags.map((tag) => tag.label).filter((label): label is string => typeof label === "string");
  return labels.length ? `${plural(labels.length, "tag")} detected: ${labels.join(", ")}.` : "No stack detected yet.";
}

export function summarizeCatalogSearch(value: Record<string, unknown>): string {
  if (!Array.isArray(value.results)) return "The catalogue is unavailable.";
  return `${plural(value.results.length, "match", "matches")} in the catalogue.`;
}

export function summarizeSuggest(value: Record<string, unknown>): string {
  if (!Array.isArray(value.results)) return "No suggestions are available for this project.";
  const results = value.results as readonly Record<string, unknown>[];
  if (!results.length) return "No suggestions for this stack yet.";
  const why = [...new Set(results.flatMap((item) => (Array.isArray(item.why) ? (item.why as string[]) : [])))].slice(
    0,
    5,
  );
  return `${plural(results.length, "suggestion")} for this project${why.length ? ` (${why.join(", ")})` : ""}.`;
}

export function summarizeSession(value: Record<string, unknown>): string {
  if (value.status !== "found" || typeof value.session !== "object" || value.session === null)
    return "That session was not found.";
  const session = value.session as Record<string, unknown>;
  const label =
    typeof session.title === "string" && session.title
      ? session.title
      : typeof session.name === "string" && session.name
        ? session.name
        : "This session";
  const task = typeof session.task === "string" && session.task ? ` — ${session.task}` : "";
  return `${label}${task}.`;
}
