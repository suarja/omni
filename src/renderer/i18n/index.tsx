import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

import { en, type Translations } from "./locales/en";
import { fr } from "./locales/fr";
import { fallbackLanguage, resolveAppLanguage, type AppLanguage } from "./language";

export { fallbackLanguage, resolveAppLanguage, supportedLanguages } from "./language";
export type { AppLanguage } from "./language";

type TranslationKeyPart<Value, Prefix extends string = ""> = {
  [Key in keyof Value & string]: Value[Key] extends string
    ? `${Prefix}${Key}`
    : Value[Key] extends object
      ? TranslationKeyPart<Value[Key], `${Prefix}${Key}.`>
      : never;
}[keyof Value & string];

export type TranslationKey = TranslationKeyPart<Translations>;

export type TranslationValue = string | number | boolean;
export type TranslationValues = Readonly<Record<string, TranslationValue | undefined>>;

export type TranslationFunction = {
  (key: TranslationKey): string;
  (key: TranslationKey, values: TranslationValues): string;
};

type TranslationTree = {
  readonly [key: string]: string | TranslationTree;
};

export type I18nContextValue = Readonly<{
  language: AppLanguage;
  setLanguage: (language: AppLanguage) => void;
  t: TranslationFunction;
}>;

const LANGUAGE_STORAGE_KEY = "omni.language";
const I18nContext = createContext<I18nContextValue | null>(null);

function readStoredLanguage(): AppLanguage {
  if (typeof window === "undefined") {
    return fallbackLanguage;
  }

  try {
    return resolveAppLanguage(window.localStorage.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    return fallbackLanguage;
  }
}

function persistLanguage(language: AppLanguage): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Storage can be unavailable in restricted renderer contexts.
  }
}

function getLocale(language: AppLanguage): TranslationTree {
  return language === "fr" ? fr : en;
}

/**
 * Replaces known `{placeholder}` tokens without changing dynamic values.
 * Missing or undefined values are kept as-is so incomplete data remains visible.
 */
export function interpolate(template: string, values?: TranslationValues): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9_.-]*)\}/g, (placeholder, name) => {
    const value = values && Object.prototype.hasOwnProperty.call(values, name) ? values[name] : undefined;
    return value === undefined ? placeholder : String(value);
  });
}

function findTranslation(key: TranslationKey, language: AppLanguage): string | undefined {
  let current: string | TranslationTree = getLocale(language);

  for (const segment of key.split(".")) {
    if (typeof current === "string") {
      return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return undefined;
    }
    const next: string | TranslationTree | undefined = current[segment];
    if (next === undefined) {
      return undefined;
    }
    current = next;
  }

  return typeof current === "string" ? current : undefined;
}

function getTranslation(key: TranslationKey, language: AppLanguage): string {
  return findTranslation(key, language) ?? findTranslation(key, fallbackLanguage) ?? key;
}

export function t(key: TranslationKey, language?: AppLanguage): string;
export function t(key: TranslationKey, values: TranslationValues, language?: AppLanguage): string;
export function t(
  key: TranslationKey,
  languageOrValues: AppLanguage | TranslationValues = fallbackLanguage,
  languageOverride?: AppLanguage,
): string {
  const language = typeof languageOrValues === "string" ? languageOrValues : (languageOverride ?? fallbackLanguage);
  const values = typeof languageOrValues === "string" ? undefined : languageOrValues;

  return interpolate(getTranslation(key, language), values);
}

/** English and French both distinguish only `one` (count === 1) from `other`. */
export type PluralCategory = "one" | "other";

export function selectPluralCategory(count: number): PluralCategory {
  return count === 1 ? "one" : "other";
}

/**
 * Resolves a count-aware translation from a `{ one, other }` pair of leaf keys nested under
 * `baseKey` (e.g. `review.message.loose.one` / `review.message.loose.other`), so callers never
 * have to hardcode a plural noun form for a template that includes `{count}`.
 */
export function tCount(
  baseKey: string,
  count: number,
  values: TranslationValues,
  language: AppLanguage = fallbackLanguage,
): string {
  const key = `${baseKey}.${selectPluralCategory(count)}` as TranslationKey;
  return t(key, { count, ...values }, language);
}

export function translateCount(
  translate: TranslationFunction,
  baseKey: string,
  count: number,
  values: TranslationValues = {},
): string {
  return translate(`${baseKey}.${selectPluralCategory(count)}` as TranslationKey, { count, ...values });
}

export function I18nProvider({
  children,
  initialLanguage,
}: {
  children: ReactNode;
  initialLanguage?: AppLanguage;
}): ReactNode {
  const [language, setLanguageState] = useState<AppLanguage>(() => initialLanguage ?? readStoredLanguage());
  const setLanguage = useCallback((nextLanguage: AppLanguage): void => {
    setLanguageState(nextLanguage);
    persistLanguage(nextLanguage);
  }, []);
  const translate: TranslationFunction = useCallback(
    (key: TranslationKey, values?: TranslationValues): string => t(key, values ?? {}, language),
    [language],
  );
  const value = useMemo<I18nContextValue>(
    () => ({ language, setLanguage, t: translate }),
    [language, setLanguage, translate],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within an I18nProvider.");
  }

  return context;
}
