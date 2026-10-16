import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { Runtime } from "../application/runtime";
import type { RegistryGrantStore } from "./registry-ipc";
import type { RegisterProjectResponse, RegisterSourceResponse } from "../shared/registry-ipc";
import {
  parseProjectGrantRequest,
  parseProjectInspectionResponse,
  type ProjectInspectionResponse,
} from "../shared/project-inspection-ipc";
import { displayProjectRoot } from "./registry-display";

type Identity = Readonly<{ canonicalPath: string; device: string; inode: string }>;
export function createProjectInspection(
  options: Readonly<{
    grants: RegistryGrantStore;
    runtime: Runtime;
    pickDirectory: () => Promise<Identity | undefined>;
    readIdentity: (path: string) => Promise<Identity>;
    register: (kind: "project", path: string) => Promise<RegisterProjectResponse | RegisterSourceResponse>;
  }>,
): Readonly<{
  inspect(): Promise<ProjectInspectionResponse>;
  register(raw: unknown): Promise<RegisterProjectResponse>;
}> {
  const inspected = new Set<string>();
  const assertIdentity = async (handle: string): Promise<string> => {
    const grant = options.grants.get(handle);
    if (!grant || !inspected.has(handle))
      throw new Error("Invalid or expired project inspection grant. Choose the folder again.");
    const current = await options.readIdentity(grant.root);
    if (current.canonicalPath !== grant.root || current.device !== grant.device || current.inode !== grant.inode)
      throw new Error("The inspected project root changed. Choose the folder again.");
    return grant.root;
  };
  return {
    async inspect() {
      const selected = await options.pickDirectory();
      if (!selected) return { status: "cancelled" };
      const grantHandle = options.grants.issue({
        subject: { kind: "project", id: randomUUID() },
        root: selected.canonicalPath,
        device: selected.device,
        inode: selected.inode,
      });
      inspected.add(grantHandle);
      const name = basename(selected.canonicalPath) || "Selected project";
      const inventory = await options.runtime.scanInventory({
        approvedRoot: selected.canonicalPath,
        rootHandle: grantHandle,
        displayRoot: name,
        scope: "project",
      });
      await assertIdentity(grantHandle);
      return parseProjectInspectionResponse({
        status: "inspected",
        grantHandle,
        displayName: name,
        displayRoot: displayProjectRoot(selected.canonicalPath),
        inventory,
      });
    },
    async register(raw) {
      const { grantHandle } = parseProjectGrantRequest(raw);
      const root = await assertIdentity(grantHandle);
      const result = (await options.register("project", root)) as RegisterProjectResponse;
      if (result.status === "ready") inspected.delete(grantHandle);
      return result;
    },
  };
}
