import { parsePublicationReceipt } from "./publication-operations-ipc";
import { parseExternalSkillEvidence } from "./external-skill-effects";
import { parseSkillCopyProvenance } from "./skill-copy-provenance";
import { parseAgentSetupReceipt } from "./agent-maintenance-ipc";
import {
  assertKeys,
  assertRecord,
  readByteLength,
  readDisplay,
  readDisplayPath,
  readHash,
  readOpaque,
  readRelativePath,
  readText,
} from "./operations-ipc-parser-utils";
import type {
  OperationAction,
  OperationActionReceipt,
  OperationActionKind,
  OperationReceipt,
  ListOperationsResponse,
  GitMode,
  ReceiptDiffRequest,
  ReceiptDiffResponse,
} from "./operations-ipc";
import { OPERATION_KINDS } from "./operations-ipc";
import { parseSkillResult } from "./skill-management-ipc";
import { parseBinding } from "./bindings-ipc";
import { assertSkillLinkReceipt, parseSkillLinkReceiptPointer } from "./skill-link-receipt-parser";
import { parseSkillDetachmentReceiptPointer } from "./skill-detachment-effects";
import { parseSkillPropagationReceiptPointer } from "./skill-propagation-ipc";
import { parseLegacyBindingBridgeReceipt } from "./legacy-binding-bridge-receipt";

export function parseOperationAction(value: unknown, receipt = false): OperationAction | OperationActionReceipt {
  const action = assertRecord(value, "Operation action");
  assertKeys(
    action,
    receipt
      ? ["kind", "relativePath", "byteLength", "beforeHash", "afterHash", "manifest", "diff", "status"]
      : ["kind", "relativePath", "byteLength", "beforeHash", "afterHash", "manifest", "diff"],
    "Operation action",
  );
  if (
    !["create-directory", "write-file", "delete-file", "delete-directory"].includes(action.kind as OperationActionKind)
  )
    throw new Error("Operation action kind is invalid.");
  if (action.manifest !== undefined && typeof action.manifest !== "boolean")
    throw new Error("Operation manifest flag is invalid.");
  if (
    action.diff !== undefined &&
    (typeof action.diff !== "string" || action.diff.length > 64 * 1024 || /[\u0000]/u.test(action.diff))
  )
    throw new Error("Operation diff is invalid.");
  const parsed = {
    kind: action.kind,
    relativePath: readRelativePath(action.relativePath),
    ...(readByteLength(action.byteLength) === undefined ? {} : { byteLength: readByteLength(action.byteLength) }),
    ...(action.beforeHash === undefined ? {} : { beforeHash: readHash(action.beforeHash, "Action before hash") }),
    ...(action.afterHash === undefined ? {} : { afterHash: readHash(action.afterHash, "Action after hash") }),
    ...(action.manifest === undefined ? {} : { manifest: action.manifest }),
    ...(action.diff === undefined ? {} : { diff: action.diff }),
  } as OperationAction;
  if (!receipt) return parsed;
  if (action.status !== "applied" && action.status !== "failed" && action.status !== "rolled-back")
    throw new Error("Operation action status is invalid.");
  return { ...parsed, status: action.status };
}

export function parseOperationGit(value: unknown): { mode: GitMode; warnings: readonly string[]; commit?: string } {
  const git = assertRecord(value, "Operation Git result");
  assertKeys(git, ["mode", "warnings", "commit"], "Operation Git result");
  if (
    git.mode !== "init-and-commit" &&
    git.mode !== "commit" &&
    git.mode !== "enclosing-repository" &&
    git.mode !== "unavailable" &&
    git.mode !== "not-a-repository" &&
    git.mode !== "disabled"
  )
    throw new Error("Operation Git mode is invalid.");
  if (
    !Array.isArray(git.warnings) ||
    git.warnings.some((warning) => typeof warning !== "string" || /[\r\n]/.test(warning))
  )
    throw new Error("Operation Git warnings are invalid.");
  if (git.commit !== undefined && (typeof git.commit !== "string" || !/^[0-9a-f]{7,64}$/.test(git.commit)))
    throw new Error("Operation Git commit is invalid.");
  return { mode: git.mode, warnings: git.warnings, ...(git.commit === undefined ? {} : { commit: git.commit }) };
}

export function parseOperationReceipt(value: unknown): OperationReceipt {
  const receipt = assertRecord(value, "Operation receipt");
  assertKeys(
    receipt,
    [
      "operationId",
      "kind",
      "status",
      "appliedAt",
      "displayTarget",
      "packageId",
      "actions",
      "git",
      "registered",
      "source",
      "project",
      "bindings",
      "units",
      "restores",
      "files",
      "manifests",
      "provenance",
      "agentSetup",
      "skillMode",
      "mcpAction",
      "cliPath",
      "restored",
      "diagnostic",
      "harness",
      "createdDirectories",
      "harnessSetting",
      "signalAction",
      "nice",
      "children",
      "skillManagement",
      "failedStep",
      "adoption",
      "reconciliation",
      "capture",
      "link",
      "detachment",
      "skillPropagation",
      "legacyBridge",
      "publication",
      "externalSkill",
      "workshopPush",
      "pluginUpdates",
    ],
    "Operation receipt",
  );
  if (!isOperationKind(receipt.kind)) throw new Error("Operation receipt is invalid.");
  if (receipt.status !== "applied" && receipt.status !== "failed") throw new Error("Operation receipt is invalid.");
  if (!Array.isArray(receipt.actions)) throw new Error("Operation receipt actions must be an array.");
  const gitValue = assertRecord(receipt.git, "Operation Git result");
  assertKeys(gitValue, ["mode", "commit", "headBefore", "headAfter"], "Operation Git result");
  if (
    gitValue.mode !== "init-and-commit" &&
    gitValue.mode !== "commit" &&
    gitValue.mode !== "enclosing-repository" &&
    gitValue.mode !== "unavailable" &&
    gitValue.mode !== "not-a-repository" &&
    gitValue.mode !== "disabled"
  )
    throw new Error("Operation Git mode is invalid.");
  if (
    gitValue.commit !== undefined &&
    (typeof gitValue.commit !== "string" || !/^[0-9a-f]{7,64}$/.test(gitValue.commit))
  )
    throw new Error("Operation Git commit is invalid.");
  if (
    gitValue.headBefore !== undefined &&
    (typeof gitValue.headBefore !== "string" || !/^[0-9a-f]{7,64}$/.test(gitValue.headBefore))
  )
    throw new Error("Operation Git headBefore is invalid.");
  if (
    gitValue.headAfter !== undefined &&
    (typeof gitValue.headAfter !== "string" || !/^[0-9a-f]{7,64}$/.test(gitValue.headAfter))
  )
    throw new Error("Operation Git headAfter is invalid.");
  let registered: { sourceId: string } | null = null;
  if (receipt.registered !== null) {
    const source = assertRecord(receipt.registered, "Registered source");
    assertKeys(source, ["sourceId"], "Registered source");
    registered = { sourceId: readOpaque(source.sourceId, "Source id") };
  }
  const source = receipt.source === undefined ? undefined : parseReceiptSource(receipt.source);
  const project = receipt.project === undefined ? undefined : parseReceiptProject(receipt.project);
  const bindings = receipt.bindings === undefined ? undefined : parseReceiptBindings(receipt.bindings);
  const units = receipt.units === undefined ? undefined : parseReceiptUnits(receipt.units);
  const files = receipt.files === undefined ? undefined : parseReceiptFiles(receipt.files);
  const manifests = receipt.manifests === undefined ? undefined : parseReceiptManifests(receipt.manifests);
  const provenance = receipt.provenance === undefined ? undefined : parseProvenance(receipt.provenance);
  const createdDirectories =
    receipt.createdDirectories === undefined ? undefined : parseCreatedDirectories(receipt.createdDirectories);
  const harnessSetting = receipt.harnessSetting === undefined ? undefined : parseHarnessSetting(receipt.harnessSetting);
  const summary =
    receipt.skillManagement === undefined
      ? undefined
      : assertRecord(receipt.skillManagement, "Skill management receipt summary");
  if (summary?.receipts !== undefined)
    throw new Error("Aggregate receipts must link children without nesting receipts.");
  const skillManagement = summary ? parseSkillResult(summary) : undefined;
  if (
    skillManagement &&
    (receipt.kind !== "skill-management" ||
      receipt.actions.length ||
      skillManagement.operationId !== receipt.operationId)
  )
    throw new Error("Skill management aggregate scope is invalid.");
  const children = receipt.children === undefined ? undefined : parseChildren(receipt.children);
  const adoption = receipt.adoption === undefined ? undefined : parseAdoption(receipt.adoption);
  const reconciliation = receipt.reconciliation === undefined ? undefined : parseReconciliation(receipt.reconciliation);
  const capture = receipt.capture === undefined ? undefined : parseCapture(receipt.capture);
  const link = receipt.link === undefined ? undefined : parseSkillLinkReceiptPointer(receipt.link);
  const detachment =
    receipt.detachment === undefined ? undefined : parseSkillDetachmentReceiptPointer(receipt.detachment);
  const skillPropagation =
    receipt.skillPropagation === undefined ? undefined : parseSkillPropagationReceiptPointer(receipt.skillPropagation);
  const externalSkill =
    receipt.externalSkill === undefined ? undefined : parseExternalSkillEvidence(receipt.externalSkill);
  if (externalSkill?.refusal) throw new Error("A refused external target cannot produce an applied receipt.");
  if (externalSkill && (receipt.kind !== externalSkill.kind || project?.id !== externalSkill.projectId))
    throw new Error("External skill receipt exceeds its operation scope.");
  if (
    ["install-external-skill", "update-external-skills", "merge-external-skill"].includes(String(receipt.kind)) &&
    !externalSkill
  )
    throw new Error("External skill receipt requires saved recovery evidence.");
  const legacyBridge =
    receipt.legacyBridge === undefined ? undefined : parseLegacyBindingBridgeReceipt(receipt.legacyBridge);
  if (
    (receipt.kind === "bridge-skill-uses") !== Boolean(legacyBridge) ||
    (legacyBridge &&
      (receipt.actions.length ||
        registered !== null ||
        bindings ||
        files ||
        manifests ||
        source ||
        project ||
        children ||
        skillManagement ||
        [adoption, reconciliation, capture, link, detachment, skillPropagation].some(Boolean) ||
        (legacyBridge.phase === "applied") !== (receipt.status === "applied")))
  )
    throw new Error("Legacy Binding bridge receipts must describe one metadata-only operation.");
  assertSkillLinkReceipt({
    kind: receipt.kind,
    operationId: receipt.operationId,
    registered,
    bindings,
    project,
    actions: receipt.actions,
    ...(link ? { link } : {}),
  });
  if ([adoption, reconciliation, capture, link, detachment, skillPropagation].filter(Boolean).length > 1)
    throw new Error("A receipt cannot link multiple reconciliation effects.");
  if (adoption && receipt.kind !== "adopt-skill")
    throw new Error("Adoption links are only valid on adoption receipts.");
  if (reconciliation && receipt.kind !== "resolve-skill")
    throw new Error("Reconciliation links are only valid on managed resolution receipts.");
  if (capture && receipt.kind !== "capture-skill")
    throw new Error("Capture links are only valid on personal variant receipts.");
  if (detachment && receipt.kind !== "detach-skill")
    throw new Error("Detachment links are only valid on stop-management receipts.");
  if (skillPropagation && receipt.kind !== "propagate-skill")
    throw new Error("Propagation links are only valid on skill propagation receipts.");
  if (
    receipt.kind === "detach-skill" &&
    (!detachment ||
      detachment.stepId !== receipt.operationId ||
      receipt.actions.length !== 0 ||
      registered !== null ||
      bindings !== undefined ||
      files !== undefined ||
      manifests !== undefined ||
      !source ||
      !project)
  ) {
    throw new Error("Stop-management receipts must link one metadata-only project step without file effects.");
  }
  if (
    receipt.kind === "propagate-skill" &&
    (!skillPropagation || skillPropagation.stepId !== receipt.operationId || registered !== null || !project || !source)
  )
    throw new Error("Skill propagation receipts must link one exact target step.");
  if (
    receipt.kind === "adopt-skill" &&
    (!adoption ||
      adoption.stepId !== receipt.operationId ||
      receipt.actions.length !== 0 ||
      registered !== null ||
      bindings !== undefined ||
      files !== undefined ||
      manifests !== undefined)
  ) {
    throw new Error("Adoption receipts must link one metadata-only journal step without file snapshots.");
  }
  if (
    receipt.kind === "resolve-skill" &&
    (!reconciliation || reconciliation.stepId !== receipt.operationId || registered !== null || bindings !== undefined)
  ) {
    throw new Error("Managed resolution receipts must link their saved journal step without source registration.");
  }
  if (
    receipt.kind === "capture-skill" &&
    (!capture ||
      capture.stepId !== receipt.operationId ||
      registered !== null ||
      bindings !== undefined ||
      project !== undefined ||
      receipt.actions.some((action) => action.kind === "delete-file") ||
      receipt.actions.some(
        (action) =>
          action.kind === "write-file" && action.relativePath.endsWith("omni.plugin.json") && !action.manifest,
      ))
  ) {
    throw new Error(
      "Personal variant receipts must link one source-only capture step without project or Binding effects.",
    );
  }
  if (
    receipt.kind === "skill-management" &&
    (!skillManagement ||
      !children ||
      skillManagement.intentId !== receipt.operationId ||
      JSON.stringify(children) !== JSON.stringify(skillManagement.receiptIds))
  )
    throw new Error("Skill management aggregate result and child links must match exactly.");
  if (receipt.skillMode !== undefined && receipt.skillMode !== "create" && receipt.skillMode !== "update")
    throw new Error("Skill mode is invalid.");
  if (receipt.mcpAction !== undefined && receipt.mcpAction !== "enable" && receipt.mcpAction !== "disable")
    throw new Error("MCP action is invalid.");
  const cliPath = receipt.cliPath === undefined ? undefined : readText(receipt.cliPath, "MCP CLI path");
  if (cliPath !== undefined && /[\u0000-\u001f\u007f-\u009f\r\n]/u.test(cliPath))
    throw new Error("MCP CLI path is invalid.");
  if (receipt.restores !== undefined) readOpaque(receipt.restores, "Restored operation id");
  if (receipt.restored !== undefined && typeof receipt.restored !== "boolean")
    throw new Error("Restored flag is invalid.");
  if (receipt.harness !== undefined && receipt.harness !== "claude-code" && receipt.harness !== "codex")
    throw new Error("Receipt harness is invalid.");
  if (
    receipt.signalAction !== undefined &&
    receipt.signalAction !== "kill" &&
    receipt.signalAction !== "pause" &&
    receipt.signalAction !== "resume"
  )
    throw new Error("Receipt signal action is invalid.");
  if (receipt.nice !== undefined && receipt.nice !== 10 && receipt.nice !== 0)
    throw new Error("Receipt nice value is invalid.");
  if (receipt.failedStep !== undefined && receipt.failedStep !== "import" && receipt.failedStep !== "assign")
    throw new Error("Receipt failed step is invalid.");
  return {
    operationId: readOpaque(receipt.operationId, "Operation id"),
    ...(receipt.workshopPush === undefined ? {} : { workshopPush: workshopPushSchema.parse(receipt.workshopPush) }),
    ...(receipt.pluginUpdates === undefined
      ? {}
      : { pluginUpdates: pluginCommandResultSchema.array().parse(receipt.pluginUpdates) }),
    kind: receipt.kind,
    status: receipt.status,
    appliedAt: readText(receipt.appliedAt, "Applied at"),
    displayTarget: readDisplayPath(receipt.displayTarget, "Operation target"),
    ...(receipt.packageId === undefined ? {} : { packageId: readRelativePath(receipt.packageId) }),
    actions: receipt.actions.map((action) => parseOperationAction(action, true) as OperationActionReceipt),
    git: {
      mode: gitValue.mode,
      ...(gitValue.commit === undefined ? {} : { commit: gitValue.commit }),
      ...(gitValue.headBefore === undefined ? {} : { headBefore: gitValue.headBefore }),
      ...(gitValue.headAfter === undefined ? {} : { headAfter: gitValue.headAfter }),
    },
    registered,
    ...(source ? { source } : {}),
    ...(project ? { project } : {}),
    ...(bindings ? { bindings } : {}),
    ...(units ? { units } : {}),
    ...(receipt.restores === undefined ? {} : { restores: readOpaque(receipt.restores, "Restored operation id") }),
    ...(files ? { files } : {}),
    ...(manifests ? { manifests } : {}),
    ...(provenance ? { provenance } : {}),
    ...(receipt.agentSetup === undefined ? {} : { agentSetup: parseAgentSetupReceipt(receipt.agentSetup) }),
    ...(receipt.skillMode === undefined ? {} : { skillMode: receipt.skillMode }),
    ...(receipt.mcpAction === undefined ? {} : { mcpAction: receipt.mcpAction }),
    ...(cliPath === undefined ? {} : { cliPath }),
    ...(receipt.restored === undefined ? {} : { restored: receipt.restored }),
    ...(receipt.diagnostic === undefined ? {} : { diagnostic: readDisplay(receipt.diagnostic, "Receipt diagnostic") }),
    ...(receipt.harness === undefined ? {} : { harness: receipt.harness }),
    ...(createdDirectories ? { createdDirectories } : {}),
    ...(harnessSetting ? { harnessSetting } : {}),
    ...(receipt.signalAction === undefined ? {} : { signalAction: receipt.signalAction }),
    ...(receipt.nice === undefined ? {} : { nice: receipt.nice }),
    ...(children ? { children } : {}),
    ...(skillManagement ? { skillManagement } : {}),
    ...(adoption ? { adoption } : {}),
    ...(reconciliation ? { reconciliation } : {}),
    ...(capture ? { capture } : {}),
    ...(link ? { link } : {}),
    ...(detachment ? { detachment } : {}),
    ...(skillPropagation ? { skillPropagation } : {}),
    ...(externalSkill ? { externalSkill } : {}),
    ...(legacyBridge ? { legacyBridge } : {}),
    ...(receipt.publication === undefined ? {} : { publication: parsePublicationReceipt(receipt.publication) }),
    ...(receipt.failedStep === undefined ? {} : { failedStep: receipt.failedStep }),
  };
}

function parseChildren(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new Error("Receipt children must be an array.");
  const children = value.map((item) => readOpaque(item, "Child operation id"));
  if (new Set(children).size !== children.length) throw new Error("Receipt children must be unique.");
  return children;
}

function parseAdoption(value: unknown): NonNullable<OperationReceipt["adoption"]> {
  const adoption = assertRecord(value, "Adoption journal link");
  assertKeys(adoption, ["intentId", "stepId"], "Adoption journal link");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  const intentId = readOpaque(adoption.intentId, "Adoption intent id");
  const stepId = readOpaque(adoption.stepId, "Adoption step id");
  if (!uuid.test(intentId) || !uuid.test(stepId)) throw new Error("Adoption journal identifiers must be UUIDs.");
  return { intentId, stepId };
}

function parseReconciliation(value: unknown): NonNullable<OperationReceipt["reconciliation"]> {
  const link = assertRecord(value, "Reconciliation journal link");
  assertKeys(link, ["intentId", "stepId"], "Reconciliation journal link");
  return {
    intentId: readOpaque(link.intentId, "Reconciliation intent id"),
    stepId: readOpaque(link.stepId, "Reconciliation step id"),
  };
}

function parseCapture(value: unknown): NonNullable<OperationReceipt["capture"]> {
  const link = assertRecord(value, "Personal variant journal link");
  assertKeys(link, ["intentId", "stepId"], "Personal variant journal link");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  const intentId = readOpaque(link.intentId, "Capture intent id");
  const stepId = readOpaque(link.stepId, "Capture step id");
  if (!uuid.test(intentId) || !uuid.test(stepId)) throw new Error("Capture journal identifiers must be UUIDs.");
  return { intentId, stepId };
}

function parseHarnessSettingValue(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error(`${label} is invalid.`);
  return value;
}

function parseHarnessSetting(value: unknown): NonNullable<OperationReceipt["harnessSetting"]> {
  const setting = assertRecord(value, "Operation harness setting");
  assertKeys(setting, ["harness", "key", "value", "previousValue"], "Operation harness setting");
  if (setting.harness !== "claude-code") throw new Error("Operation harness setting harness is invalid.");
  return {
    harness: setting.harness,
    key: readText(setting.key, "Operation harness setting key"),
    value: parseHarnessSettingValue(setting.value, "Operation harness setting value"),
    previousValue: parseHarnessSettingValue(setting.previousValue, "Operation harness setting previous value"),
  };
}

export function parseListOperationsResponse(value: unknown): ListOperationsResponse {
  const response = assertRecord(value, "Operations list response");
  assertKeys(response, ["status", "receipts"], "Operations list response");
  if (response.status !== "ready" || !Array.isArray(response.receipts))
    throw new Error("Operations list response is invalid.");
  return { status: "ready", receipts: response.receipts.map(parseOperationReceipt) };
}

export function parseReceiptDiffRequest(value: unknown): ReceiptDiffRequest {
  const request = assertRecord(value, "Receipt diff request");
  assertKeys(request, ["operationId", "relativePath"], "Receipt diff request");
  return {
    operationId: readOpaque(request.operationId, "Operation id"),
    relativePath: readRelativePath(request.relativePath),
  };
}

export function parseReceiptDiffResponse(value: unknown): ReceiptDiffResponse {
  const response = assertRecord(value, "Receipt diff response");
  if (response.status === "unavailable") {
    assertKeys(response, ["status", "reason"], "Receipt diff response");
    return { status: "unavailable", reason: readDisplay(response.reason, "Receipt diff reason") };
  }
  assertKeys(response, ["status", "diff", "before", "after"], "Receipt diff response");
  if (response.status !== "ready") throw new Error("Receipt diff status is invalid.");
  const diff = assertRecord(response.diff, "Receipt diff");
  assertKeys(diff, ["kind", "text", "truncated"], "Receipt diff");
  if (diff.kind !== "unified" || typeof diff.text !== "string" || diff.text.length > 64 * 1024)
    throw new Error("Receipt diff is invalid.");
  if (typeof diff.truncated !== "boolean") throw new Error("Receipt diff truncation is invalid.");
  const before = parseDiffByteLength(response.before, "Receipt diff before");
  const after = response.after === undefined ? undefined : parseDiffAfter(response.after);
  return {
    status: "ready",
    diff: { kind: "unified", text: diff.text, truncated: diff.truncated },
    before,
    ...(after ? { after } : {}),
  };
}

function parseDiffByteLength(value: unknown, label: string): { byteLength: number } {
  const item = assertRecord(value, label);
  assertKeys(item, ["byteLength"], label);
  const byteLength = readByteLength(item.byteLength);
  if (byteLength === undefined) throw new Error(`${label} byte length is invalid.`);
  return { byteLength };
}

function parseDiffAfter(value: unknown): { byteLength: number; changedSince: boolean } {
  const item = assertRecord(value, "Receipt diff after");
  assertKeys(item, ["byteLength", "changedSince"], "Receipt diff after");
  const byteLength = readByteLength(item.byteLength);
  if (byteLength === undefined) throw new Error("Receipt diff after byte length is invalid.");
  if (typeof item.changedSince !== "boolean") throw new Error("Receipt diff changed-since flag is invalid.");
  return { byteLength, changedSince: item.changedSince };
}

function parseCreatedDirectories(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim()))
    throw new Error("Created directories are invalid.");
  if (new Set(value).size !== value.length) throw new Error("Created directories must be unique.");
  return value.map((item) => readRelativePath(item));
}

function parseProvenance(value: unknown): NonNullable<OperationReceipt["provenance"]> {
  const provenance = assertRecord(value, "Operation provenance");
  assertKeys(provenance, ["agent", "approval", "reason", "copiedFrom"], "Operation provenance");
  const agent = provenance.agent === undefined ? undefined : assertRecord(provenance.agent, "Agent provenance");
  if (agent) {
    assertKeys(agent, ["harness", "sessionName", "requestedAt"], "Agent provenance");
    if (agent.harness !== "claude-code" && agent.harness !== "codex") throw new Error("Agent provenance is invalid.");
  }
  if (
    provenance.approval !== undefined &&
    provenance.approval !== "conversation" &&
    provenance.approval !== "omni" &&
    provenance.approval !== "automatic"
  )
    throw new Error("Operation approval is invalid.");
  return {
    ...(agent
      ? {
          agent: {
            harness: agent.harness as "claude-code" | "codex",
            ...(agent.sessionName === undefined ? {} : { sessionName: readText(agent.sessionName, "Session name") }),
            requestedAt: readText(agent.requestedAt, "Requested at"),
          },
        }
      : {}),
    ...(provenance.copiedFrom === undefined ? {} : { copiedFrom: parseSkillCopyProvenance(provenance.copiedFrom) }),
    ...(provenance.approval === undefined ? {} : { approval: provenance.approval }),
    ...(provenance.reason === undefined ? {} : { reason: readText(provenance.reason, "Operation reason") }),
  };
}

function parseReceiptProject(value: unknown): NonNullable<OperationReceipt["project"]> {
  const project = assertRecord(value, "Operation receipt project");
  assertKeys(project, ["id"], "Operation receipt project");
  return { id: readOpaque(project.id, "Project id") };
}

function parseReceiptBindings(value: unknown): NonNullable<OperationReceipt["bindings"]> {
  if (!Array.isArray(value)) throw new Error("Operation receipt bindings must be an array.");
  return value.map((item) => {
    const binding = assertRecord(item, "Operation receipt binding");
    assertKeys(binding, ["bindingId", "previousOwnedHash", "binding", "before", "after"], "Operation receipt binding");
    const savedBinding = binding.binding === undefined ? undefined : parseBinding(binding.binding);
    const before = binding.before === undefined ? undefined : parseBinding(binding.before);
    const after = binding.after === undefined ? undefined : parseBinding(binding.after);
    return {
      bindingId: readOpaque(binding.bindingId, "Binding id"),
      ...(binding.previousOwnedHash === undefined
        ? {}
        : { previousOwnedHash: readHash(binding.previousOwnedHash, "Previous owned hash") }),
      ...(savedBinding ? { binding: savedBinding } : {}),
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
    };
  });
}

function parseReceiptUnits(value: unknown): NonNullable<OperationReceipt["units"]> {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error("Operation receipt units must be an array of strings.");
  const units = value.map((item) => readOpaque(item, "Operation receipt unit"));
  if (new Set(units).size !== units.length) throw new Error("Operation receipt units must be unique.");
  return units;
}

function parseReceiptSource(value: unknown): NonNullable<OperationReceipt["source"]> {
  const source = assertRecord(value, "Operation receipt source");
  assertKeys(source, ["kind", "id", "relativePath"], "Operation receipt source");
  if (source.kind !== "project" && source.kind !== "source")
    throw new Error("Operation receipt source kind is invalid.");
  return {
    kind: source.kind,
    id: readOpaque(source.id, "Source id"),
    relativePath: readRelativePath(source.relativePath),
  };
}

function parseReceiptFiles(value: unknown): NonNullable<OperationReceipt["files"]> {
  if (!Array.isArray(value)) throw new Error("Operation receipt files must be an array.");
  return value.map((item) => {
    const file = assertRecord(item, "Operation receipt file");
    assertKeys(file, ["relativePath", "contentHash", "previousHash", "modified"], "Operation receipt file");
    if (file.modified !== undefined && typeof file.modified !== "boolean")
      throw new Error("Operation file modified flag is invalid.");
    return {
      relativePath: readRelativePath(file.relativePath),
      contentHash: readHash(file.contentHash, "Content hash"),
      ...(file.previousHash === undefined ? {} : { previousHash: readHash(file.previousHash, "Previous hash") }),
      ...(file.modified === undefined ? {} : { modified: file.modified }),
    };
  });
}

function parseReceiptManifests(value: unknown): NonNullable<OperationReceipt["manifests"]> {
  if (!Array.isArray(value)) throw new Error("Operation receipt manifests must be an array.");
  return value.map((item) => {
    const manifest = assertRecord(item, "Operation receipt manifest");
    assertKeys(manifest, ["relativePath", "beforeHash", "afterHash"], "Operation receipt manifest");
    return {
      relativePath: readRelativePath(manifest.relativePath),
      ...(manifest.beforeHash === undefined
        ? {}
        : { beforeHash: readHash(manifest.beforeHash, "Manifest before hash") }),
      afterHash: readHash(manifest.afterHash, "Manifest after hash"),
    };
  });
}
function isOperationKind(value: unknown): value is OperationReceipt["kind"] {
  return typeof value === "string" && (OPERATION_KINDS as readonly string[]).includes(value);
}
import { workshopPushSchema, pluginCommandResultSchema } from "./workshop-delivery-ipc";
