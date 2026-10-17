import type { AgentPlan } from "./agents-ipc";

function actionKey(action: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({
    kind: action.kind,
    relativePath: action.relativePath,
    beforeHash: action.beforeHash,
    afterHash: action.afterHash,
    byteLength: action.byteLength,
    diff: action.diff,
  });
}

export function samePlan(left: AgentPlan, right: AgentPlan): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "assign" && right.kind === "assign") {
    return (
      JSON.stringify(left.plans) === JSON.stringify(right.plans) &&
      JSON.stringify(left.bindings ?? []) === JSON.stringify(right.bindings ?? [])
    );
  }
  if (left.kind === "assign" || right.kind === "assign") return false;
  const publication =
    left.kind === "publish-plugin" ||
    left.kind === "create-storefront" ||
    left.kind === "retry-push" ||
    left.publication !== undefined ||
    right.publication !== undefined;
  if (
    publication &&
    (!left.publication?.approvalFingerprint ||
      left.publication.approvalFingerprint !== right.publication?.approvalFingerprint)
  )
    return false;
  return (
    JSON.stringify(left.storefrontLink) === JSON.stringify(right.storefrontLink) &&
    JSON.stringify(left.projectRegistration) === JSON.stringify(right.projectRegistration) &&
    left.kind === right.kind &&
    left.actions.length === right.actions.length &&
    left.actions.every((action, index) => actionKey(action) === actionKey(right.actions[index] ?? {}))
  );
}
