import type { SkillEffectBuild, SkillManagementService } from "../../application/skill-management";
import type { ProjectSkillIntent } from "../../shared/project-skills-ipc";
import type { createProjectSkillsAdapter } from "./project-skills";
import type { createSkillAssignmentAdapter } from "./assignment";
import type { createLegacyBindingBridge } from "./legacy-binding-bridge";
import type { createSkillPropagationAdapter } from "./propagation-composition";
import { withLegacyBindingBridge } from "./legacy-binding-service";
import { blockedRestore } from "./unbound-service-routes";

type Dependencies = Readonly<{
  projectSkills?: ReturnType<typeof createProjectSkillsAdapter>;
  assignment?: ReturnType<typeof createSkillAssignmentAdapter>;
  legacyBridge?: ReturnType<typeof createLegacyBindingBridge>;
  propagation?: ReturnType<typeof createSkillPropagationAdapter>;
}>;

export async function previewProjectSkillOperation(
  intent: ProjectSkillIntent,
  intentId: string,
  args: Dependencies,
): Promise<SkillEffectBuild> {
  if (!args.projectSkills)
    return blockedRestore(
      "Project skill management is unavailable.",
      "project-skills-unavailable",
      "Reconnect the project.",
    );
  try {
    const assignment = await args.projectSkills.assignmentFor(intent);
    if (assignment)
      return args.assignment
        ? args.assignment.preview(assignment, intentId)
        : blockedRestore("Assignment is unavailable.", "assignment-unavailable", "Reconnect the project.");
    return args.projectSkills.preview(intent, intentId);
  } catch (error) {
    return blockedRestore(
      error instanceof Error ? error.message : "The project skill cannot be previewed safely.",
      "project-skill-unavailable",
      "Refresh the project.",
    );
  }
}

export function composeProjectSkillService(
  service: SkillManagementService,
  args: Dependencies,
): SkillManagementService {
  const composed = withLegacyBindingBridge(service, args.legacyBridge, args.propagation, args.projectSkills);
  const projectSkills = args.projectSkills;
  if (!projectSkills) return composed;
  return {
    ...composed,
    initialize: async () => {
      await projectSkills.purgeExpired();
      await composed.initialize();
      await projectSkills.cleanupParking();
    },
    readProjectSkills: projectSkills.readProjectSkills,
  };
}
