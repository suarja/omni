export type ElapsedLanguage = "en" | "fr";

// Units follow the interface language: days are "d" in English and "j" in French.
export function formatElapsed(seconds: number, language: ElapsedLanguage = "en"): string {
  const rounded = Math.max(0, Math.floor(seconds));
  if (rounded < 60) return `${rounded} s`;
  if (rounded < 3_600) return `${Math.floor(rounded / 60)} min`;
  if (rounded < 86_400) return `${Math.floor(rounded / 3_600)} h`;
  return `${Math.floor(rounded / 86_400)} ${language === "fr" ? "j" : "d"}`;
}

export function formatSize(rssMb: number): string {
  if (rssMb < 1_024) return `${Math.round(rssMb)} MB`;
  return `${(rssMb / 1_024).toFixed(1)} GB`;
}

export function formatSince(
  timestamp: number | undefined,
  language: ElapsedLanguage = "en",
  now = Date.now(),
): string | undefined {
  if (timestamp === undefined) return undefined;
  return formatElapsed((now - timestamp) / 1_000, language);
}
