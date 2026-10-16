import type { CanvasProjectAttention, CanvasSession, CanvasViewState } from "./spatial-types";

export function createCanvasSession(): CanvasSession {
  const states = new Map<string, CanvasViewState>();
  const projectAttention = new Map<string, CanvasProjectAttention>();
  return {
    read(key: string): CanvasViewState | undefined {
      const state = states.get(key);
      return state ? structuredClone(state) : undefined;
    },
    write(key: string, state: CanvasViewState): void {
      states.set(key, structuredClone(state));
    },
    readProjectAttention(projectId: string): CanvasProjectAttention | undefined {
      const attention = projectAttention.get(projectId);
      return attention ? structuredClone(attention) : undefined;
    },
    writeProjectAttention(attention: CanvasProjectAttention): void {
      projectAttention.set(attention.projectId, structuredClone(attention));
    },
    listProjectAttention(): readonly CanvasProjectAttention[] {
      return structuredClone([...projectAttention.values()]);
    },
    retainProjectAttention(roots: readonly Readonly<{ projectId: string; rootKey: string }>[]): void {
      const activeRoots = new Map(roots.map(({ projectId, rootKey }) => [projectId, rootKey]));
      for (const [projectId, attention] of projectAttention) {
        if (activeRoots.get(projectId) !== attention.rootKey) projectAttention.delete(projectId);
      }
    },
  };
}
