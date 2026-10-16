import type { ReactElement } from "react";

import type { SkillLocationKey } from "../../../domain/skill-reconciliation/types";
import type { EntryRef } from "../../../domain/project-source-registry";
import type { DesktopApi } from "../../../shared/ipc";
import { OperationChangesWorkbench, type OperationChangesWorkbenchProps } from "./OperationChangesWorkbench";
import { SkillCopyComparisonWorkbench } from "./SkillCopyComparisonWorkbench";
import type { SkillCopyComparisonPair } from "./use-skill-copy-comparison";
import { RouteChangesWorkbench, type RouteChangesWorkbenchProps } from "./RouteChangesWorkbench";

export type ChangesSourceChoice = OperationChangesWorkbenchProps["sources"][number];
export type ChangesPackageChoice = OperationChangesWorkbenchProps["packages"][number];
export type ChangesWorkbenchProps =
  | (RouteChangesWorkbenchProps & Readonly<{ mode: "route" }>)
  | (OperationChangesWorkbenchProps & Readonly<{ mode?: "operation" }>)
  | Readonly<{
      mode: "comparison";
      api: Pick<DesktopApi, "compareSkillCopies"> | null;
      projectId: string;
      skillId: string;
      locations: readonly SkillLocationKey[];
      initialLeft: SkillLocationKey;
      initialPair?: SkillCopyComparisonPair;
      onEnsureGrant: (entry: EntryRef) => Promise<string | null>;
      onBack: () => void;
      onClose: () => void;
    }>;

export function ChangesWorkbench(props: ChangesWorkbenchProps): ReactElement {
  if (props.mode === "route") return <RouteChangesWorkbench {...props} />;
  if (props.mode === "comparison") return <SkillCopyComparisonWorkbench {...props} />;
  return <OperationChangesWorkbench {...props} />;
}
