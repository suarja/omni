import { z } from "zod";
import { parseBinding } from "../../shared/bindings-ipc";
import { parseSkillUseEffect } from "../../shared/skill-adoption-effects";
import { projectSkillRowSchema } from "../../shared/project-skills-ipc";
import { parseLogicalSkillRecord, parseSkillLocationKey } from "../../domain/skill-reconciliation/validation";
import type { ProjectSkillManifest } from "./project-skill-plan";
import { parkedProjectSkillSchema } from "./project-skill-parking";
import { projectSkillManifestPath } from "./project-skill-plan";
import { readProjectSkillJson } from "./project-skill-files";

const optional = <T>(parse: (value: unknown) => T) => z.unknown().transform(parse).optional();
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const uuid = z.string().uuid();
const treeSchema = z
  .object({
    root: z.enum(["project", "omni"]),
    path: z.string(),
    beforeHash: hash.optional(),
    afterHash: hash.optional(),
    beforeBackup: z.string().optional(),
    afterBackup: z.string().optional(),
  })
  .strict();
const schema = z
  .object({
    version: z.literal(1),
    intentId: uuid,
    row: projectSkillRowSchema,
    action: z.enum(["disable", "enable", "delete", "install-agent", "remove-agent", "restore"]),
    expiresAt: z.number().int().nonnegative().optional(),
    restores: uuid.optional(),
    steps: z
      .array(
        z
          .object({
            stepId: uuid,
            location: z.unknown().transform(parseSkillLocationKey),
            rootIdentity: hash,
            trees: z.array(treeSchema).max(3),
            parking: z
              .array(
                z
                  .object({ before: parkedProjectSkillSchema.optional(), after: parkedProjectSkillSchema.optional() })
                  .strict(),
              )
              .max(1),
            uses: z.array(z.unknown().transform(parseSkillUseEffect)).max(1),
            records: z
              .array(
                z
                  .object({
                    skillId: uuid,
                    before: optional(parseLogicalSkillRecord),
                    after: optional(parseLogicalSkillRecord),
                  })
                  .strict(),
              )
              .max(1),
            bindings: z
              .array(
                z
                  .object({ bindingId: z.string(), before: optional(parseBinding), after: optional(parseBinding) })
                  .strict(),
              )
              .max(1),
            status: z.enum(["prepared", "applying", "applied"]),
            readChecks: z
              .array(z.object({ folderPath: z.string(), hash }).strict())
              .max(1)
              .optional(),
          })
          .strict(),
      )
      .max(2),
  })
  .strict();

export async function readProjectSkillManifest(
  root: string,
  intentId: string,
): Promise<ProjectSkillManifest | undefined> {
  uuid.parse(intentId);
  const value = await readProjectSkillJson(root, projectSkillManifestPath(intentId));
  if (value === undefined) return undefined;
  const parsed = schema.parse(value);
  if (parsed.intentId !== intentId) throw new Error("Project skill backup identity is invalid.");
  for (const step of parsed.steps) {
    for (const check of step.readChecks ?? []) {
      parseSkillLocationKey({
        projectId: step.location.projectId,
        harnessId: check.folderPath.startsWith(".agents/") ? "codex" : "claude-code",
        folderPath: check.folderPath,
      });
    }
    for (const tree of step.trees) {
      if (
        tree.root === "project"
          ? tree.path !== step.location.folderPath &&
            !(
              ["disable", "remove-agent", "restore"].includes(parsed.action) &&
              tree.beforeHash &&
              tree.afterHash &&
              Object.values(parsed.row.agents).some(
                (agent) => agent.state === "installed" && agent.folderPath === tree.path,
              )
            )
          : !/^omni\/parked\/[a-f0-9-]+\/content$/u.test(tree.path)
      )
        throw new Error("Project skill backup effect path is invalid.");
      for (const path of [tree.beforeBackup, tree.afterBackup].filter((path): path is string => Boolean(path))) {
        const allowed = [intentId, parsed.restores].filter(Boolean);
        if (
          !allowed.some((id) => path.startsWith(`omni/backups/project-skills/${id}/`)) ||
          !/^omni\/backups\/project-skills\/[a-f0-9-]+\/[a-f0-9-]+\/\d+\/(before|after)$/u.test(path)
        )
          throw new Error("Project skill backup content path is invalid.");
      }
      if (
        Boolean(tree.beforeHash) !== Boolean(tree.beforeBackup) ||
        Boolean(tree.afterHash) !== Boolean(tree.afterBackup)
      )
        throw new Error("Project skill backup lacks its exact content references.");
    }
  }
  return parsed as ProjectSkillManifest;
}
