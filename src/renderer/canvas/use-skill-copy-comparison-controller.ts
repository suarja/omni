import { useCallback, useEffect, useRef, useState } from "react";

import type { SkillLocationKey } from "../../domain/skill-reconciliation/types";

type SkillSelection = Readonly<{
  skillId: string;
  locations: readonly SkillLocationKey[];
}>;
export type SkillCopyComparisonSelection = SkillSelection &
  Readonly<{
    contextKey: string;
    projectId: string;
    initialLeft: SkillLocationKey;
  }>;
type ControllerInput = Readonly<{
  viewKey: string;
  projectId?: string;
  rootKey?: string;
  observationKey?: string;
  skill: SkillSelection | null;
}>;

export function useSkillCopyComparisonController(input: ControllerInput): Readonly<{
  selection: SkillCopyComparisonSelection | null;
  isOpen: boolean;
  open(initialLeft: SkillLocationKey, opener: HTMLButtonElement): void;
  back(): void;
  clear(): void;
}> {
  const [savedSelection, setSavedSelection] = useState<SkillCopyComparisonSelection | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const currentInput = useRef(input);
  currentInput.current = input;
  const contextKey = JSON.stringify([
    input.viewKey,
    input.projectId ?? null,
    input.rootKey ?? null,
    input.observationKey ?? null,
    input.skill?.skillId ?? null,
    input.skill?.locations ?? null,
  ]);
  const selection = savedSelection?.contextKey === contextKey ? savedSelection : null;

  useEffect(() => {
    if (savedSelection && !selection) setSavedSelection(null);
  }, [savedSelection, selection]);

  const open = useCallback((initialLeft: SkillLocationKey, button: HTMLButtonElement): void => {
    const current = currentInput.current;
    if (!current.projectId || !current.skill) return;
    opener.current = button;
    const currentContextKey = JSON.stringify([
      current.viewKey,
      current.projectId ?? null,
      current.rootKey ?? null,
      current.observationKey ?? null,
      current.skill.skillId,
      current.skill.locations,
    ]);
    setSavedSelection({
      contextKey: currentContextKey,
      projectId: current.projectId,
      skillId: current.skill.skillId,
      locations: current.skill.locations,
      initialLeft,
    });
  }, []);
  const back = useCallback((): void => {
    setSavedSelection(null);
    requestAnimationFrame(() => opener.current?.focus());
  }, []);
  const clear = useCallback((): void => setSavedSelection(null), []);

  return { selection, isOpen: Boolean(selection), open, back, clear };
}
