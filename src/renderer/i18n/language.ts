export const supportedLanguages = ["en", "fr"] as const;
export type AppLanguage = (typeof supportedLanguages)[number];
export const fallbackLanguage: AppLanguage = "en";

export function resolveAppLanguage(value: string | null | undefined): AppLanguage {
  const normalized = value?.trim().toLowerCase().split(/[-_]/, 1)[0];
  return normalized === "fr" || normalized === "en" ? normalized : fallbackLanguage;
}
