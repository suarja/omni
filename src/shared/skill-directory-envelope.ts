export type SkillDirectoryEnvelope = readonly Readonly<{
  path: string;
  kind: "file" | "directory";
  identity: string;
}>[];
