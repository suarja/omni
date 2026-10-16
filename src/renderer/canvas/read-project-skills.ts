import type { ResourceSnapshot } from "../../domain/resource-catalogue";
import { parseProjectSkills, type ProjectSkills } from "../../shared/project-skills-ipc";
import type { ResourceCanvasProps } from "./resource-canvas-types";

const reads = new WeakMap<object, Map<string, Promise<ProjectSkills>>>();

export function projectSkillsKey(snapshot: ResourceSnapshot, projectId: string): string {
  const project = snapshot.registry.projects.find((item) => item.ref.id === projectId);
  const evidence = snapshot.roots.find(
    (root) => root.entry.kind === "project" && root.entry.id === projectId,
  )?.evidence;
  return JSON.stringify([
    projectId,
    project?.displayRoot,
    project?.availability,
    project?.archivedAt,
    evidence?.status === "observed" ? evidence.observation.observedAt : evidence?.status,
  ]);
}

/** Share only unfinished reads. Later reads still acquire fresh access and observe current copies. */
export function readProjectSkills(canvas: ResourceCanvasProps, projectId: string): Promise<ProjectSkills> {
  const api = canvas.api;
  if (!api?.readProjectSkills) return Promise.reject(new Error("Project skills are unavailable in this session."));
  let requests = reads.get(api);
  if (!requests) {
    requests = new Map();
    reads.set(api, requests);
  }
  const key = projectSkillsKey(canvas.snapshot, projectId);
  const existing = requests.get(key);
  if (existing) return existing;
  const pending = Promise.resolve()
    .then(async () => {
      if (!(await canvas.onEnsureGrant({ kind: "project", id: projectId })))
        throw new Error(`Permission to observe project ${projectId} is unavailable. Reopen the project.`);
      const data = parseProjectSkills(await api.readProjectSkills!(projectId));
      if (data.projectId !== projectId)
        throw new Error(`The skill response does not belong to project ${projectId}. Refresh the project.`);
      return data;
    })
    .finally(() => requests.delete(key));
  requests.set(key, pending);
  return pending;
}
