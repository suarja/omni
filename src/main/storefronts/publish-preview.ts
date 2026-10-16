import { randomUUID } from "node:crypto";
import { checkPublication } from "../../domain/publish-checks";
import { createUnifiedDiff } from "../../domain/unified-diff";
import type { OperationAction, OperationPlan } from "../../shared/operations-ipc";
import { hashContent } from "../marketplace-manifests";
import type { PublicationEdit } from "./publish-content";

export function previewPublicationActions(
  edits: readonly PublicationEdit[],
  originPath: string,
  homeDirectory: string,
): readonly OperationAction[] {
  return edits.map(({ view, before, after }) => {
    const sensitive = checkPublication({
      files: [
        {
          path: view.relativePath,
          content: Buffer.from(before ?? []).toString("utf8") + "\n" + Buffer.from(after ?? []).toString("utf8"),
        },
      ],
      hasLicense: true,
      homeDirectory,
    }).some((item) => item.code === "secret");
    if (sensitive) return { ...view, diff: "[redacted secret literal]" };
    if (view.relativePath !== originPath || !after) return view;
    // Approval binds the operation's content and destination, not the eventual calendar day.
    const intent = Buffer.from(after)
      .toString("utf8")
      .replace(/^(- Published: )\d{4}-\d{2}-\d{2}$/mu, "$1on apply");
    return {
      ...view,
      afterHash: hashContent(intent),
      diff: createUnifiedDiff(`${view.relativePath} (current)`, `${view.relativePath} (proposed)`, before ?? "", intent)
        .text,
    };
  });
}
export function receiptPublicationActions(
  edits: readonly PublicationEdit[],
  preview: readonly OperationAction[],
): readonly OperationAction[] {
  return edits.map(({ view }) => ({
    ...view,
    ...(preview.find((action) => action.relativePath === view.relativePath)?.diff === "[redacted secret literal]"
      ? { diff: "[redacted secret literal]" }
      : {}),
  }));
}

export function buildPublicationPreview(
  pluginId: string,
  actions: readonly OperationAction[],
  files: NonNullable<OperationPlan["publication"]>["files"],
  conflicts: readonly string[],
  findings: ReturnType<typeof checkPublication>,
  approvalFingerprint: string,
): OperationPlan {
  return {
    planId: randomUUID(),
    kind: "publish-plugin",
    displayTarget: `plugins/${pluginId}`,
    actions,
    git: { mode: "commit", warnings: [] },
    publication: {
      approvalFingerprint,
      files,
      conflicts: [...conflicts],
      findings: [...findings],
    },
    findings: findings.map(({ severity, code, message, fix, file, line }) => ({
      severity,
      code,
      message: `${file}:${line}: ${message}`,
      fix,
    })),
    notes: ["Commit the publication in the storefront, then push origin."],
  };
}
