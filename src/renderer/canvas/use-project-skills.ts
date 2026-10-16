import { useCanvasRail } from "./rail/rail-context";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectSkills } from "../../shared/project-skills-ipc";
import { useCoalescedReload } from "./use-coalesced-reload";
import { readProjectSkills, projectSkillsKey } from "./read-project-skills";
import type { ResourceCanvasProps } from "./resource-canvas-types";

export function useProjectSkills(
  props: ResourceCanvasProps,
  projectId: string,
): Readonly<{ data: ProjectSkills | null; error: string | null; reload: () => Promise<void> }> {
  const rail = useCanvasRail();
  const [data, setData] = useState<ProjectSkills | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputs = useRef(props);
  inputs.current = props;
  const revision = useRef(0);
  const read = useCallback(async (): Promise<void> => {
    const ticket = ++revision.current;
    setError(null);
    try {
      const next = await readProjectSkills(inputs.current, projectId);
      if (ticket === revision.current) {
        setData(next);
        setError(null);
      }
    } catch (failure) {
      if (ticket === revision.current) {
        setData(null);
        setError(failure instanceof Error ? failure.message : "Project skills could not be read. Refresh the project.");
      }
    }
  }, [props.api, projectId]);
  const reload = useCoalescedReload(read);
  const observationKey = projectSkillsKey(props.snapshot, projectId);
  useEffect(() => {
    void reload();
    return () => {
      revision.current += 1;
    };
  }, [read, reload, observationKey]);
  useEffect(() => {
    if (data) rail?.rememberSkills(data);
  }, [data, rail?.rememberSkills]);
  return { data, error, reload };
}
