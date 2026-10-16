import type { AcademyKind } from "../../shared/academy-ipc";

export type AcademyContextLink = Readonly<{ kind: AcademyKind; slug: string }>;
export type AcademyEntityKind = "marketplace" | "plugin" | "project";
export type AcademyFindingKind =
  "availability" | "diagnostic" | "exact-duplicate" | "variant" | "unsupported-format" | "loose";

export const CONTEXT_LINKS: Readonly<{
  entityKind: Readonly<Record<AcademyEntityKind, AcademyContextLink>>;
  findingKind: Readonly<Record<AcademyFindingKind, AcademyContextLink>>;
}> = {
  entityKind: {
    marketplace: { kind: "tutorial", slug: "install-a-marketplace-by-hand" },
    plugin: { kind: "tutorial", slug: "install-a-marketplace-by-hand" },
    project: { kind: "tutorial", slug: "add-a-plugin-to-a-project" },
  },
  findingKind: {
    availability: { kind: "topic", slug: "marketplaces" },
    diagnostic: { kind: "topic", slug: "agents-at-work" },
    "exact-duplicate": { kind: "topic", slug: "skills" },
    variant: { kind: "topic", slug: "skills" },
    "unsupported-format": { kind: "topic", slug: "plugins" },
    loose: { kind: "topic", slug: "skills" },
  },
};

export function academyContextRoute(
  link: AcademyContextLink,
  lang?: "en" | "fr",
): { screen: "academy-lesson"; kind: AcademyKind; slug: string; lang?: "en" | "fr" } {
  return { screen: "academy-lesson", ...(lang ? { lang } : {}), ...link };
}

export function contextLinkForFinding(kind: string): AcademyContextLink | undefined {
  return CONTEXT_LINKS.findingKind[kind as AcademyFindingKind];
}
