import { translateCount } from "../../i18n";
import type { OperationReceipt } from "../../../shared/operations-ipc";
import type { ResourceSnapshot } from "../../../domain/resource-catalogue";
import type { TranslationFunction } from "../../i18n";
import { operationLabel } from "../../review/CompletedOperations";
import { harnessLabel } from "../project-view-model";
import { receiptHarnessNames } from "../../agents/agent-utils";

function isAgentOperation(receipt: OperationReceipt): boolean {
  return ["install-agents", "disconnect-agents", "register-mcp", "write-harness-setting"].includes(receipt.kind);
}
function restoredAgentOperation(
  receipt: OperationReceipt,
  receipts: readonly OperationReceipt[],
): OperationReceipt | undefined {
  const original = receipt.restores
    ? receipts.find((candidate) => candidate.operationId === receipt.restores)
    : undefined;
  return original && isAgentOperation(original) ? original : undefined;
}
function agentOperationTitle(receipt: OperationReceipt, t: TranslationFunction, language: "en" | "fr"): string {
  const agents = receiptHarnessNames(receipt, language);
  if (receipt.kind === "write-harness-setting") return operationLabel(receipt, t, language);
  return t(
    receipt.agentSetup?.action === "update"
      ? "agentSettings.historyUpdate"
      : receipt.agentSetup?.action === "reinstall"
        ? "agentSettings.historyReinstall"
        : receipt.kind === "disconnect-agents" || receipt.mcpAction === "disable"
          ? "rail.operation.unregister"
          : "rail.operation.register",
    { agents, name: agents },
  );
}

function skillName(receipt: OperationReceipt): string {
  const actionPath = receipt.actions.find((action) => action.relativePath.includes("/skills/"))?.relativePath;
  const path =
    receipt.skillManagement?.propagation?.source.artifactPath ??
    receipt.source?.relativePath ??
    receipt.skillManagement?.targets[0]?.artifactPath ??
    receipt.bindings?.[0]?.binding?.artifactPath ??
    actionPath;
  if (path)
    return (
      path.match(/(?:^|\/)skills\/([^/]+)/)?.[1] ??
      path
        .replace(/\/SKILL\.md$/, "")
        .split("/")
        .at(-1) ??
      path
    );
  return receipt.displayTarget.split(" → ")[0]?.split("/").at(-1) ?? receipt.displayTarget;
}
export function historyTitle(
  receipt: OperationReceipt,
  t: TranslationFunction,
  language: "en" | "fr",
  snapshot?: ResourceSnapshot,
  receipts: readonly OperationReceipt[] = [],
): string {
  if (receipt.externalSkill) {
    const evidence = receipt.externalSkill;
    const action =
      evidence.direction === "restore"
        ? "restoreExternal"
        : evidence.kind === "install-external-skill"
          ? "installExternal"
          : evidence.kind === "merge-external-skill"
            ? "mergeExternal"
            : "updateExternal";
    return t(`rail.operation.${action}`, { source: evidence.sourceId });
  }
  if (receipt.kind === "publish-plugin" || receipt.kind === "create-storefront" || receipt.kind === "retry-push") {
    const storefront =
      snapshot?.registry.sources.find((source) => source.ref.id === receipt.publication?.storefrontId)?.displayName ??
      receipt.publication?.storefrontId ??
      receipt.displayTarget;
    return t(
      receipt.kind === "create-storefront"
        ? "storefronts.historyCreate"
        : receipt.kind === "retry-push"
          ? "storefronts.historyRetry"
          : "storefronts.historyPublish",
      { name: storefront, storefront, plugin: receipt.publication?.pluginId ?? receipt.displayTarget },
    );
  }
  const originalAgent = restoredAgentOperation(receipt, receipts);
  if (originalAgent) {
    const title = agentOperationTitle(originalAgent, t, language);
    const operation = title.startsWith("Omni ") ? title : title.charAt(0).toLocaleLowerCase(language) + title.slice(1);
    return t("agentSettings.historyRestore", { operation });
  }
  const original = receipt.restores
    ? receipts.find((candidate) => candidate.operationId === receipt.restores && !candidate.restores)
    : undefined;
  if (original) {
    const title = historyTitle(original, t, language, snapshot);
    return t("skillActions.historyRestore", {
      operation: title.charAt(0).toLocaleLowerCase(language) + title.slice(1),
    });
  }
  const name = skillName(receipt);
  if (receipt.kind === "describe-plugin")
    return t("skillActions.historyDescribe", {
      name: receipt.displayTarget.split("/").at(-1) ?? receipt.displayTarget,
    });
  const target =
    snapshot?.registry.projects.find((project) => project.ref.id === receipt.project?.id)?.displayName ??
    receipt.project?.id ??
    t("canvas.project");
  if (receipt.restores || receipt.kind.startsWith("restore-")) return t("rail.operation.restore", { name });
  if (isAgentOperation(receipt)) return agentOperationTitle(receipt, t, language);
  if (receipt.kind === "bridge-skill-uses")
    return t("rail.bridge", {
      count: receipt.legacyBridge?.uses.length ?? Number(receipt.displayTarget.match(/\d+/)?.[0] ?? 0),
    });
  if (receipt.kind === "skill-management") return managementTitle(receipt, t, language, snapshot, receipts);
  if (receipt.kind === "write-skill")
    return t(receipt.skillMode === "update" ? "rail.operation.updateMarketplace" : "rail.operation.addMarketplace", {
      name,
    });
  if (receipt.kind === "import-artifact" || receipt.kind === "capture-skill")
    return t("rail.operation.capture", { name });
  if (receipt.kind === "apply-plan" || receipt.kind === "resolve-skill")
    return t("rail.operation.updateProject", { name, target });
  if (receipt.kind === "remove-binding") return t("rail.operation.removeProject", { name, target });
  if (receipt.kind === "create-marketplace")
    return t("rail.operation.createMarketplace", { name: receipt.displayTarget });
  if (receipt.kind === "add-to-project")
    return t("rail.operation.addProject", { name, target: receipt.displayTarget.split(" → ")[2] ?? target });
  if (receipt.kind === "make-compatible")
    return t("rail.operation.compatible", {
      name: receipt.displayTarget.split("/").at(-1) ?? receipt.displayTarget,
      target: harnessLabel(receipt.harness ?? "claude-code"),
    });
  if (receipt.kind === "adopt-skill") return t("rail.operation.adopt", { name, target });
  if (receipt.kind === "detach-skill") return t("rail.operation.detach", { name, target });
  if (receipt.kind === "link-skill") return t("rail.operation.link", { name, target });
  if (receipt.kind === "propagate-skill") return t("rail.operation.propagate", { name });
  return t("rail.operation.other", { action: operationLabel(receipt, t, language), name: receipt.displayTarget });
}
function managementTitle(
  receipt: OperationReceipt,
  t: TranslationFunction,
  language: "en" | "fr",
  snapshot: ResourceSnapshot | undefined,
  receipts: readonly OperationReceipt[],
): string {
  const [action, ...parts] = receipt.displayTarget.split(" · ");
  const name = parts.join(" · ");
  if (action === "remove-agent" && name) return t("skillActions.historyRemove", { name });
  if (name && (action === "disable" || action === "enable" || action === "delete" || action === "install-agent"))
    return t(("rail.operation." + action) as Parameters<TranslationFunction>[0], { name });
  if (receipt.skillManagement?.propagation) return t("rail.operation.propagate", { name: skillName(receipt) });
  const children = receipts.filter(
    (child) => receipt.children?.includes(child.operationId) && child.kind !== "skill-management",
  );
  const external = children.find((child) => child.externalSkill);
  if (external) {
    const evidence = external.externalSkill!;
    const count = children.reduce((sum, child) => sum + (child.externalSkill?.copies ?? 0), 0);
    if (historyProvenance(receipt, receipts)?.approval === "automatic")
      return translateCount(t, "externalLibrary.autoHistory", count, { source: evidence.sourceId });
    if (evidence.kind === "install-external-skill")
      return t("externalLibrary.installHistory", {
        name: skillName(external),
        projects: children
          .map(
            (child) =>
              snapshot?.registry.projects.find((project) => project.ref.id === child.externalSkill?.projectId)
                ?.displayName ?? child.externalSkill?.projectId,
          )
          .join(", "),
      });
    return translateCount(t, "externalLibrary.updateHistory", count, { source: evidence.sourceId });
  }
  const failedExternalUpdate = receipt.displayTarget.match(/^Update external skills · (.+)$/u);
  if (receipt.status === "failed" && failedExternalUpdate)
    return t("rail.operation.failedExternalUpdate", { source: failedExternalUpdate[1]! });
  if (children.length === 1) return historyTitle(children[0]!, t, language, snapshot);
  const projects = [
    ...new Set(
      receipt.skillManagement?.targets.map(
        (target) =>
          snapshot?.registry.projects.find((project) => project.ref.id === target.projectId)?.displayName ??
          target.projectId,
      ),
    ),
  ];
  return projects.length
    ? t("rail.operation.updateProject", { name: skillName(receipt), target: projects.join(", ") })
    : t("rail.operation.manage", { name: skillName(receipt) });
}

export function historyAttribution(
  receipt: OperationReceipt,
  receipts: readonly OperationReceipt[],
  t: TranslationFunction,
): string {
  const provenance = historyProvenance(receipt, receipts);
  const agent = provenance?.agent;
  const who = agent
    ? t("rail.requestedBy", { name: [harnessLabel(agent.harness), agent.sessionName].filter(Boolean).join(" · ") })
    : t("rail.desktop");
  const approval = provenance?.approval;
  if (
    approval === "automatic" &&
    (receipt.externalSkill ||
      /^Update external skills · /u.test(receipt.displayTarget) ||
      receipts.some((child) => receipt.children?.includes(child.operationId) && child.externalSkill))
  )
    return who + " · " + t("rail.automatic");
  if (approval === "automatic") return who + " · " + t("agentSettings.automatic");
  return approval
    ? who + " · " + t(approval === "omni" ? "rail.omni" : "rail.conversation").toLocaleLowerCase()
    : agent
      ? who + " · " + t("rail.unknownApproval").toLocaleLowerCase()
      : who;
}
export function historyDay(appliedAt: string, t: TranslationFunction, language: "en" | "fr", now = new Date()): string {
  const date = new Date(appliedAt);
  if (!Number.isFinite(date.getTime())) return t("rail.timeUnknown");
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === now.toDateString()) return t("rail.dayToday");
  if (date.toDateString() === yesterday.toDateString()) return t("rail.dayYesterday");
  return date.toLocaleDateString(language === "fr" ? "fr-FR" : "en-GB");
}
export function historyTime(appliedAt: string, t: TranslationFunction, language: "en" | "fr"): string {
  const date = new Date(appliedAt);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString(language === "fr" ? "fr-FR" : "en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : t("rail.timeUnknown");
}
export function historyLocation(
  receipt: OperationReceipt,
  snapshot: ResourceSnapshot,
  language: "en" | "fr",
  receipts: readonly OperationReceipt[] = [],
): string {
  const originalAgent = restoredAgentOperation(receipt, receipts);
  if (originalAgent) return receiptHarnessNames(originalAgent, language);
  if (receipt.agentSetup?.version) return receipt.agentSetup.version;
  if (isAgentOperation(receipt)) return receiptHarnessNames(receipt, language);
  const targets = receipt.skillManagement?.targets;
  if (targets?.length) {
    const join = (names: readonly string[]): string =>
      new Intl.ListFormat(language, { style: "long", type: "conjunction" }).format([...new Set(names)]);
    const projects = targets.map(
      (target) =>
        snapshot.registry.projects.find((project) => project.ref.id === target.projectId)?.displayName ??
        target.projectId,
    );
    const agents = targets.map((target) => harnessLabel(target.harnessId));
    return `${join(projects)} · ${join(agents)}`;
  }
  const sourceId = receipt.skillManagement?.source.sourceId ?? receipt.source?.id ?? receipt.registered?.sourceId;
  const project = snapshot.registry.projects.find((project) => project.ref.id === receipt.project?.id);
  const source = snapshot.registry.sources.find((source) => source.ref.id === sourceId);
  return (
    project?.displayName ?? source?.displayName ?? receipt.displayTarget.split("/").at(-1) ?? receipt.displayTarget
  );
}
export function historyProvenance(
  receipt: OperationReceipt,
  receipts: readonly OperationReceipt[],
): OperationReceipt["provenance"] {
  if (receipt.provenance) return receipt.provenance;
  const children = receipts.filter(
    (candidate) => receipt.children?.includes(candidate.operationId) && candidate.provenance?.agent,
  );
  const first = children[0]?.provenance;
  return first && children.every((child) => JSON.stringify(child.provenance) === JSON.stringify(first))
    ? first
    : undefined;
}
