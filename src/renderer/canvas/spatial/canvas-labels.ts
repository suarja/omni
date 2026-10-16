export function displayGroupLabel(
  group: Readonly<{ label: string; labelKind?: "literal" }>,
  translate: (key: string) => string,
): string {
  return group.labelKind === "literal" ? group.label : translate(group.label);
}
