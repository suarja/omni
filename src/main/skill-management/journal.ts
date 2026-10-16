import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import type {
  SkillJournalBackupReference,
  SkillJournalAction,
  SkillJournalList,
  SkillJournalRead,
  SkillJournalStatus,
  SkillJournalStep,
  SkillOperationJournal,
  SkillOperationJournalRecord,
} from "../../application/skill-management-journal";
import {
  parseSkillActor,
  parseSkillEffectDescriptor,
  parseSkillIntent,
  parseSkillResult,
  type SkillActor,
  type SkillIntent,
  type SkillResult,
} from "../../shared/skill-management-ipc";

const JOURNAL_LIMIT = 1024 * 1024;
const STATUSES: readonly SkillJournalStatus[] = [
  "previewed",
  "prepared",
  "applying",
  "verifying",
  "terminal",
  "recovery-required",
];
const STEP_STATUSES: readonly SkillJournalStep["status"][] = [
  "prepared",
  "applying",
  "verifying",
  "applied",
  "failed",
  "skipped",
  "recovery-required",
];

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} is invalid.`);
  return value as Record<string, unknown>;
}
function assertKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} has an unknown field.`);
}
function readText(value: unknown, label: string, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(value))
    throw new Error(`${label} is invalid.`);
  return value;
}
function readRelativePath(value: unknown, label: string): string {
  const path = readText(value, label, 2048).replaceAll("\\", "/");
  if (
    path.startsWith("/") ||
    /^[A-Za-z]:\//u.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error(`${label} must be relative.`);
  return path;
}
function readDate(value: unknown, label: string): string {
  const date = readText(value, label, 40);
  if (new Date(date).toISOString() !== date) throw new Error(`${label} is invalid.`);
  return date;
}
function readFingerprint(value: unknown): string {
  const fingerprint = readText(value, "Effect fingerprint", 64);
  if (!/^[a-f0-9]{64}$/u.test(fingerprint)) throw new Error("Effect fingerprint is invalid.");
  return fingerprint;
}
function parseStep(value: unknown): SkillJournalStep {
  const step = object(value, "Skill journal step");
  assertKeys(step, ["stepId", "status", "receiptId", "actions", "managementProgress"], "Skill journal step");
  if (!STEP_STATUSES.includes(step.status as SkillJournalStep["status"]))
    throw new Error("Skill journal step status is invalid.");
  const actions = step.actions === undefined ? undefined : parseJournalActions(step.actions);
  let managementProgress: SkillJournalStep["managementProgress"];
  if (step.managementProgress !== undefined) {
    const progress = object(step.managementProgress, "Skill management progress");
    assertKeys(progress, ["bindings", "uses"], "Skill management progress");
    if (
      (progress.bindings !== "pending" && progress.bindings !== "applied") ||
      (progress.uses !== "pending" && progress.uses !== "applied") ||
      (progress.uses === "applied" && progress.bindings !== "applied")
    ) {
      throw new Error("Skill management progress is invalid or out of order.");
    }
    managementProgress = { bindings: progress.bindings, uses: progress.uses };
  }
  return {
    stepId: readText(step.stepId, "Skill journal step id"),
    status: step.status as SkillJournalStep["status"],
    ...(step.receiptId === undefined ? {} : { receiptId: readText(step.receiptId, "Skill journal receipt id") }),
    ...(actions === undefined ? {} : { actions }),
    ...(managementProgress === undefined ? {} : { managementProgress }),
  };
}

function parseJournalActions(value: unknown): readonly SkillJournalAction[] {
  if (!Array.isArray(value) || value.length > 2048) throw new Error("Skill journal action states are invalid.");
  const actions = value.map((raw): SkillJournalAction => {
    const action = object(raw, "Skill journal action state");
    assertKeys(
      action,
      ["relativePath", "kind", "status", "beforeHash", "afterHash", "identity", "temporaryPath"],
      "Skill journal action state",
    );
    const kinds = [
      "create-directory",
      "write-file",
      "write-manifest",
      "delete-file",
      "restore-manifest",
      "remove-directory",
    ];
    const statuses = ["applying", "applied", "failed"];
    if (!kinds.includes(String(action.kind)) || !statuses.includes(String(action.status)))
      throw new Error("Skill journal action state is invalid.");
    const hash = (candidate: unknown, label: string) => {
      if (typeof candidate !== "string" || !/^[a-f0-9]{64}$/u.test(candidate)) throw new Error(`${label} is invalid.`);
      return candidate;
    };
    return {
      relativePath: readRelativePath(action.relativePath, "Skill journal action path"),
      kind: action.kind as SkillJournalAction["kind"],
      status: action.status as SkillJournalAction["status"],
      ...(action.beforeHash === undefined ? {} : { beforeHash: hash(action.beforeHash, "Skill journal before hash") }),
      ...(action.afterHash === undefined ? {} : { afterHash: hash(action.afterHash, "Skill journal after hash") }),
      ...(action.identity === undefined
        ? {}
        : { identity: readText(action.identity, "Skill journal action identity", 256) }),
      ...(action.temporaryPath === undefined
        ? {}
        : { temporaryPath: readRelativePath(action.temporaryPath, "Skill journal temporary path") }),
    };
  });
  if (new Set(actions.map(({ relativePath, kind }) => `${relativePath}\n${kind}`)).size !== actions.length)
    throw new Error("Skill journal action states are duplicated.");
  return actions;
}
function parseBackup(value: unknown): SkillJournalBackupReference {
  const backup = object(value, "Skill journal backup reference");
  assertKeys(backup, ["rootId", "path"], "Skill journal backup reference");
  return {
    rootId: readText(backup.rootId, "Skill journal root id"),
    path: readRelativePath(backup.path, "Skill journal backup path"),
  };
}
function parseResult(value: unknown): SkillResult {
  return parseSkillResult(value);
}
export function parseSkillOperationJournalRecord(value: unknown): SkillOperationJournalRecord {
  const record = object(value, "Skill journal record");
  assertKeys(
    record,
    [
      "version",
      "intentId",
      "actor",
      "intent",
      "status",
      "effectFingerprint",
      "effect",
      "backupReferences",
      "steps",
      "result",
      "createdAt",
      "updatedAt",
    ],
    "Skill journal record",
  );
  if (record.version !== 1 || !STATUSES.includes(record.status as SkillJournalStatus))
    throw new Error("Skill journal schema is unsupported.");
  if (!Array.isArray(record.backupReferences) || !Array.isArray(record.steps))
    throw new Error("Skill journal collections are invalid.");
  const effect = record.effect === undefined ? undefined : parseSkillEffectDescriptor(record.effect);
  const steps = record.steps.map(parseStep);
  if (new Set(steps.map((step) => step.stepId)).size !== steps.length)
    throw new Error("Skill journal step ids are duplicated.");
  for (const step of steps) {
    if (
      step.managementProgress &&
      !effect?.steps.some((candidate) => candidate.stepId === step.stepId && candidate.detachmentEvidence)
    ) {
      throw new Error("Skill management progress is permitted only for a saved detachment step.");
    }
  }
  return {
    version: 1,
    intentId: readText(record.intentId, "Skill intent id"),
    actor: parseSkillActor(record.actor),
    intent: parseSkillIntent(record.intent),
    status: record.status as SkillJournalStatus,
    effectFingerprint: readFingerprint(record.effectFingerprint),
    ...(effect === undefined ? {} : { effect }),
    backupReferences: record.backupReferences.map(parseBackup),
    steps,
    ...(record.result === undefined ? {} : { result: parseResult(record.result) }),
    createdAt: readDate(record.createdAt, "Skill journal created at"),
    updatedAt: readDate(record.updatedAt, "Skill journal updated at"),
  };
}

function recordPath(directory: string, intentId: string): string {
  const safe = readText(intentId, "Skill intent id", 128);
  if (/[\\/]/u.test(safe) || safe === "." || safe === "..") throw new Error("Skill intent id is invalid.");
  return join(directory, `${safe}.json`);
}
function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
async function readFileRecord(filePath: string): Promise<SkillJournalRead> {
  try {
    const details = await lstat(filePath);
    if (details.isSymbolicLink() || !details.isFile())
      return { status: "corrupt", diagnostic: "Skill journal must be a regular file." };
    if (details.size > JOURNAL_LIMIT)
      return { status: "corrupt", diagnostic: "Skill journal record exceeds the size limit." };
    const record = parseSkillOperationJournalRecord(JSON.parse(await readFile(filePath, "utf8")) as unknown);
    return { status: "ready", record };
  } catch (error: unknown) {
    if (isCode(error, "ENOENT")) return { status: "missing" };
    return {
      status: "corrupt",
      diagnostic: error instanceof Error ? error.message : "Skill journal could not be read safely.",
    };
  }
}

export function createSkillOperationJournal(directory: string): SkillOperationJournal {
  const root = resolve(directory);
  const read = (intentId: string): Promise<SkillJournalRead> => readFileRecord(recordPath(root, intentId));
  const list = async (): Promise<SkillJournalList> => {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (error: unknown) {
      if (isCode(error, "ENOENT")) return { status: "ready", records: [] };
      return {
        status: "corrupt",
        intentId: "unknown",
        diagnostic: "Skill journal directory could not be read safely.",
      };
    }
    const records: SkillOperationJournalRecord[] = [];
    for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
      const intentId = entry.slice(0, -5);
      const result = await read(intentId);
      if (result.status === "corrupt") return { status: "corrupt", intentId, diagnostic: result.diagnostic };
      if (result.status === "ready") records.push(result.record);
    }
    return { status: "ready", records };
  };
  const write = async (value: SkillOperationJournalRecord): Promise<void> => {
    const record = parseSkillOperationJournalRecord(value);
    const filePath = recordPath(root, record.intentId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = await lstat(root);
    if (directory.isSymbolicLink() || !directory.isDirectory())
      throw new Error("Skill journal directory must be a regular directory.");
    await chmod(root, 0o700);
    const temporary = join(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await chmod(temporary, 0o600);
      await rename(temporary, filePath);
      await chmod(filePath, 0o600);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  };
  const recoverInterrupted = async (): Promise<readonly SkillOperationJournalRecord[]> => {
    const current = await list();
    if (current.status !== "ready")
      throw new Error(`Skill journal is corrupt (${current.intentId}): ${current.diagnostic}`);
    const interrupted = current.records.filter((record) =>
      ["prepared", "applying", "verifying"].includes(record.status),
    );
    const recovered = interrupted.map((record) => ({
      ...record,
      status: "recovery-required" as const,
      updatedAt: new Date().toISOString(),
    }));
    for (const record of recovered) await write(record);
    return recovered;
  };
  return { read, list, write, recoverInterrupted };
}
