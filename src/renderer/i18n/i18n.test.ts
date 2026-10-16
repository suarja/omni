// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost"}

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fallbackLanguage,
  I18nProvider,
  interpolate,
  resolveAppLanguage,
  selectPluralCategory,
  supportedLanguages,
  t,
  tCount,
  useI18n,
  type TranslationKey,
  type TranslationValues,
} from "./index";
import { en } from "./locales/en";
import { fr } from "./locales/fr";

function collectLeafKeys(value: object, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const nextPrefix = prefix ? `${prefix}.${key}` : key;
    return typeof child === "string" ? [nextPrefix] : collectLeafKeys(child, nextPrefix);
  });
}

function I18nProbe({ onRender }: { onRender?: (language: string) => void }): ReactElement {
  const { language, setLanguage, t: translate } = useI18n();
  onRender?.(language);

  return createElement(
    "div",
    null,
    createElement("output", { "data-testid": "language" }, language),
    createElement("output", { "data-testid": "heading" }, translate("plugins.heading")),
    createElement("button", { type: "button", onClick: () => setLanguage("fr") }, "Français"),
  );
}

type RenderedProbe = { container: HTMLDivElement; root: Root };
const renderedProbes: RenderedProbe[] = [];

function renderProbe(onRender?: (language: string) => void): RenderedProbe {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(I18nProvider, null, createElement(I18nProbe, { onRender })));
  });
  const rendered = { container, root };
  renderedProbes.push(rendered);
  return rendered;
}

function click(button: HTMLButtonElement): void {
  act(() => {
    button.click();
  });
}

describe("typed i18n foundation", () => {
  let rendered: { container: HTMLDivElement; root: Root } | undefined;
  let localStorageDescriptor: PropertyDescriptor | undefined;
  let actEnvironmentDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    actEnvironmentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorageDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        clear: () => values.clear(),
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      } satisfies Pick<Storage, "clear" | "getItem" | "setItem">,
    });
    window.localStorage.clear();
    document.body.replaceChildren();
  });

  afterEach(() => {
    act(() => {
      renderedProbes.forEach(({ root }) => root.unmount());
    });
    renderedProbes.forEach(({ container }) => container.remove());
    renderedProbes.length = 0;
    rendered = undefined;
    vi.restoreAllMocks();
    if (localStorageDescriptor) {
      Object.defineProperty(window, "localStorage", localStorageDescriptor);
    }
    localStorageDescriptor = undefined;
    if (actEnvironmentDescriptor) {
      Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironmentDescriptor);
    } else {
      delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    }
    actEnvironmentDescriptor = undefined;
  });

  it("keeps English and French leaf keys in recursive parity", () => {
    expect(collectLeafKeys(fr)).toEqual(collectLeafKeys(en));
    expect(collectLeafKeys(fr).length).toBeGreaterThan(20);
    expect(Object.values(fr.plugins).every((value) => typeof value === "string")).toBe(true);
  });

  it("normalizes supported regional languages and falls back for unsupported values", () => {
    expect(supportedLanguages).toEqual(["en", "fr"]);
    expect(fallbackLanguage).toBe("en");
    expect(resolveAppLanguage("fr-FR")).toBe("fr");
    expect(resolveAppLanguage(" en-US ")).toBe("en");
    expect(resolveAppLanguage("de-DE")).toBe("en");
    expect(resolveAppLanguage(undefined)).toBe("en");
  });

  it("returns translated strings through the typed key surface", () => {
    const key: TranslationKey = "changeReview.applyChange";

    expect(t(key, "en")).toBe("Apply change");
    expect(t("plugins.heading", "fr")).toBe("Plugins");
    expect(t("changeReview.applyChange", "fr")).toBe("Appliquer la modification");
  });

  it("returns a visible fallback for malformed runtime translation keys", () => {
    const malformedKey = "plugins.missingAtRuntime" as TranslationKey;

    expect(t(malformedKey, "fr")).toBe(malformedKey);
  });

  it("does not resolve inherited translation-tree properties", () => {
    const malformedKey = "constructor.name" as TranslationKey;

    expect(t(malformedKey, "fr")).toBe(malformedKey);
  });

  it("exports the supported language tuple and interpolates dynamic values verbatim", () => {
    expect(supportedLanguages).toEqual(["en", "fr"]);
    expect(t("plugins.available", { count: 3 })).toBe("3 available");
    expect(
      t("plugins.skillsAndHooks", {
        skills: "provider-skill-id",
        hooks: "/tmp/provider-hook",
      }),
    ).toBe("provider-skill-id skills · /tmp/provider-hook provider hooks");
    expect(t("plugins.sourceRevision", { revision: "rev-001" }, "fr")).toBe("Révision de la source : rev-001");
    expect(interpolate("Keep {missing} and use {label}.", { label: "Provider ID" })).toBe(
      "Keep {missing} and use Provider ID.",
    );
  });

  it("does not interpolate inherited values", () => {
    const inheritedValues = Object.create({ label: "inherited value" }) as TranslationValues;

    expect(interpolate("Value: {label}", inheritedValues)).toBe("Value: {label}");
  });

  it("keeps French dynamic empty states grammatical for plugin and skill labels", () => {
    expect(t("plugins.noPersonal", { label: "Plugins" }, "fr")).toBe(
      "Plugins : aucun élément personnel pour le moment",
    );
    expect(t("plugins.noMatch", { label: "Skills" }, "fr")).toBe("Skills : aucun résultat pour cette recherche");
  });

  it("exposes semantic theme, risk, and provider display keys in both locales", () => {
    expect(t("theme.toggleToLight", "en")).toBe("Switch to light theme");
    expect(t("theme.toggleToDark", "fr")).toBe("Passer au thème sombre");
    expect(t("changeReview.riskLow", "en")).toBe("Low");
    expect(t("changeReview.riskMedium", "fr")).toBe("Moyen");
    expect(t("changeReview.riskHigh", "fr")).toBe("Élevé");
    expect(t("changeReview.cursorMarketplace", "en")).toBe("Cursor marketplace");
    expect(t("changeReview.cursorMarketplace", "fr")).toBe("Marketplace Cursor");
  });

  it("selects the singular plural category only for a count of exactly one", () => {
    expect(selectPluralCategory(1)).toBe("one");
    expect(selectPluralCategory(0)).toBe("other");
    expect(selectPluralCategory(2)).toBe("other");
    expect(selectPluralCategory(-1)).toBe("other");
  });

  it("resolves a count-aware translation from its one/other leaf keys, never a bare '1 artefacts'", () => {
    expect(tCount("review.message.loose", 1, { root: "Source A" }, "en")).toBe(
      "1 artifact outside any package in Source A",
    );
    expect(tCount("review.message.loose", 3, { root: "Source A" }, "en")).toBe(
      "3 artifacts outside any package in Source A",
    );
    expect(tCount("review.message.loose", 1, { root: "Source A" }, "fr")).toBe("1 artefact hors paquet dans Source A");
    expect(tCount("review.message.loose", 1, { root: "Source A" }, "fr")).not.toContain("1 artefacts");
    expect(tCount("review.message.loose", 2, { root: "Source A" }, "fr")).toBe("2 artefacts hors paquet dans Source A");
  });

  it("defaults to English and persists an explicit language selection", () => {
    rendered = renderProbe();

    expect(rendered.container.querySelector("[data-testid=language]")?.textContent).toBe("en");
    expect(rendered.container.querySelector("[data-testid=heading]")?.textContent).toBe("Plugins");
    expect(window.localStorage.getItem("omni.language")).toBeNull();

    click(rendered.container.querySelector("button") as HTMLButtonElement);

    expect(rendered.container.querySelector("[data-testid=language]")?.textContent).toBe("fr");
    expect(window.localStorage.getItem("omni.language")).toBe("fr");
  });

  it("normalizes a stored regional language and ignores an unsupported stored value", () => {
    window.localStorage.setItem("omni.language", "fr-FR");
    rendered = renderProbe();
    expect(rendered.container.querySelector("[data-testid=language]")?.textContent).toBe("fr");

    window.localStorage.setItem("omni.language", "ja-JP");
    rendered = renderProbe();
    expect(rendered.container.querySelector("[data-testid=language]")?.textContent).toBe("en");
  });

  it("reads a stored language on the first render without a flash", () => {
    window.localStorage.setItem("omni.language", "fr-FR");
    const languages: string[] = [];
    rendered = renderProbe((language) => languages.push(language));

    expect(languages).toEqual(["fr"]);
  });

  it("keeps English when reading storage fails and keeps the change when writing fails", () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("localStorage unavailable");
    });
    rendered = renderProbe();
    expect(rendered.container.querySelector("[data-testid=language]")?.textContent).toBe("en");

    vi.restoreAllMocks();
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("localStorage unavailable");
    });
    click(rendered.container.querySelector("button") as HTMLButtonElement);

    expect(rendered.container.querySelector("[data-testid=language]")?.textContent).toBe("fr");
  });
});
