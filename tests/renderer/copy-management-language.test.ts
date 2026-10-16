import { expect, test } from "vitest";
import { t, tCount, type AppLanguage } from "../../src/renderer/i18n";

test.each<Readonly<{ language: AppLanguage; title: string; count: string; summary: string }>>([
  { language: "en", title: "Manage demo", count: "2 changed files", summary: "2 changed files · 3 files compared" },
  {
    language: "fr",
    title: "Gérer demo",
    count: "2 fichiers modifiés",
    summary: "2 fichiers modifiés · 3 fichiers comparés",
  },
])(
  "copy management shows names and file counts without template braces in $language",
  ({ language, title, count, summary }) => {
    expect(t("skillManagement.copyManagementTitle", { name: "demo" }, language)).toBe(title);
    expect(tCount("skillManagement.copyChangedFileCount", 2, {}, language)).toBe(count);
    expect(
      t(
        "skillManagement.copyDifferencesSummary",
        {
          changed: tCount("skillManagement.copyChangedFileCount", 2, {}, language),
          total: tCount("skillManagement.copyComparedFileCount", 3, {}, language),
        },
        language,
      ),
    ).toBe(summary);
  },
);

test.each(["en", "fr"] as const)("copy counts use singular forms for one file in %s", (language) => {
  expect(tCount("skillManagement.copyChangedFileCount", 1, {}, language)).toBe(
    language === "en" ? "1 changed file" : "1 fichier modifié",
  );
  expect(tCount("skillManagement.copyComparedFileCount", 1, {}, language)).toBe(
    language === "en" ? "1 file compared" : "1 fichier comparé",
  );
});
