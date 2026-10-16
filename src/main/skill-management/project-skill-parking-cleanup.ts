import { lstat, readdir, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import type { SkillOperationJournal } from "../../application/skill-management-journal";
import type { OperationStore } from "../operation-store";
import type { ProjectSkillParking } from "./project-skill-parking";
import { guardSkillPath, hashProjectSkillValue, pathExists } from "./project-skill-files";
import { readProjectSkillManifest } from "./project-skill-manifest";

type Dependencies = Readonly<{
  userDataPath: string;
  parking: ProjectSkillParking;
  journal: SkillOperationJournal;
  operationStore: OperationStore;
  now?: () => number;
}>;
type References = Readonly<{ indexed: Set<string>; pending: Set<string>; restorable: Set<string> }>;
const directoryOf = (path: string): string => path.slice(0, path.lastIndexOf("/"));

async function readParkingReferences(args: Dependencies): Promise<References | undefined> {
  const indexed = new Set((await args.parking.read()).map((entry) => directoryOf(entry.contentPath)));
  const journal = await args.journal.list();
  const history = await args.operationStore.read();
  if (journal.status !== "ready" || history.status !== "ready") return undefined;
  const references: References = { indexed, pending: new Set(), restorable: new Set() };
  for (const record of journal.records) {
    const evidence = record.effect?.steps.find((step) => step.projectSkillEvidence)?.projectSkillEvidence;
    if (!evidence) continue;
    const receipt = history.receipts.find((item) => item.operationId === record.intentId);
    if (receipt?.restored || record.result?.status === "restored") continue;
    const pending = !receipt || receipt.skillManagement?.status === "recovery-required";
    const manifest = await readProjectSkillManifest(args.userDataPath, record.intentId);
    if (!manifest) {
      if (pending && record.status !== "previewed") return undefined;
      continue;
    }
    const normalized = { ...manifest, steps: manifest.steps.map((step) => ({ ...step, status: "prepared" })) };
    if (hashProjectSkillValue(normalized) !== evidence.manifestHash) return undefined;
    if (manifest.expiresAt !== undefined && (args.now ?? Date.now)() >= manifest.expiresAt) continue;
    for (const step of manifest.steps) {
      if (step.status === "prepared") continue;
      for (const tree of step.trees.filter((tree) => tree.root === "omni")) {
        if (pending) references.pending.add(directoryOf(tree.path));
        else if (manifest.action !== "restore" && tree.afterHash) references.restorable.add(directoryOf(tree.path));
      }
    }
  }
  return references;
}

export async function purgeOrphanedProjectSkillParking(args: Dependencies): Promise<void> {
  const root = await guardSkillPath(args.userDataPath, "omni/parked");
  if (!(await pathExists(root))) return;
  const candidates = (await readdir(root)).filter((name) =>
    /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(name),
  );
  const references = await readParkingReferences(args);
  if (!references) {
    console.warn("Parked skill cleanup was withheld because operation recovery evidence is unavailable.");
    return;
  }
  for (const name of candidates) {
    const relativePath = `omni/parked/${name}`;
    const path = await guardSkillPath(args.userDataPath, relativePath);
    if (!(await pathExists(path)) || !(await lstat(path)).isDirectory() || (await lstat(path)).isSymbolicLink())
      continue;
    if (references.indexed.has(relativePath) || references.pending.has(relativePath)) continue;
    const entries = await readdir(path);
    if (!entries.length) {
      // A concurrent restore may recreate content after the scan; never remove it recursively here.
      try {
        await rmdir(path);
      } catch (error) {
        if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    } else if (!references.restorable.has(relativePath)) await rm(join(root, name), { recursive: true });
  }
}
