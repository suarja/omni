import type { TranslationFunction } from "../i18n";
import { pluginSelectionReady, type PluginSelection } from "./PluginPicker";
import type { PersonalPlugin } from "./personal-marketplace";
import type { WriteSkillRequest } from "../../shared/operations-write-skill-ipc";

export type NewSkillDraft = Readonly<{ name: string; description: string; body: string; selection: PluginSelection }>;
export function checkNewSkill(
  draft: NewSkillDraft,
  plugins: readonly PersonalPlugin[],
  observed: boolean,
): readonly boolean[] {
  const selection = draft.selection;
  return [
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(draft.name) && draft.name.length <= 64,
    observed &&
      Boolean(draft.name) &&
      !plugins.some((plugin) => plugin.skillNames.some((name) => name.toLowerCase() === draft.name.toLowerCase())),
    /use when/iu.test(draft.description),
    draft.description.length > 0 &&
      draft.description.length <= 1024 &&
      !/[\u0000\u007f-\u009f]/u.test(draft.description),
    observed &&
      pluginSelectionReady(selection) &&
      (selection.kind === "new"
        ? !plugins.some((plugin) => plugin.name === selection.name)
        : selection.kind === "existing" && plugins.some((plugin) => plugin.id === selection.packageId)),
  ];
}
export function newSkillPrompt(
  draft: NewSkillDraft,
  plugins: readonly PersonalPlugin[],
  projects: readonly string[],
  t: TranslationFunction,
): string {
  const selected = draft.selection;
  const plugin =
    selected.kind === "new"
      ? t("newSkill.promptNewPlugin", {
          name: selected.name || t("newSkill.promptPluginName"),
          description: selected.description || t("newSkill.promptPluginDescription"),
        })
      : selected.kind === "existing"
        ? t("newSkill.promptPlugin", {
            name:
              plugins.find((plugin) => plugin.id === selected.packageId)?.name ?? selected.packageId.split("/").at(-1)!,
          })
        : t("newSkill.promptAnyPlugin");
  return t("newSkill.prompt", {
    name: draft.name || t("newSkill.promptName"),
    description: draft.description.trim().replace(/\.$/u, "") || t("newSkill.promptDescription"),
    plugin,
    installation: projects.length ? t("newSkill.promptInstall", { projects: projects.join(", ") }) : "",
  });
}
export function newSkillRequest(draft: NewSkillDraft, sourceId: string): WriteSkillRequest {
  const selection = draft.selection;
  if (selection.kind === "none") throw new Error("Choose a plugin before creating the skill.");
  return {
    kind: "write-skill",
    sourceId,
    mode: "create",
    folderName: draft.name,
    ...(selection.kind === "existing"
      ? { packageId: selection.packageId }
      : { newPackage: { name: selection.name, description: selection.description } }),
    files: [
      {
        path: "SKILL.md",
        content: `---\nname: ${JSON.stringify(draft.name)}\ndescription: ${JSON.stringify(draft.description)}\n---\n\n${draft.body}\n`,
      },
    ],
  };
}
