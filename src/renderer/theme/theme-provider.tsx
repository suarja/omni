import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from "react";

export type ThemeMode = "light" | "dark";

export type ThemeContextValue = Readonly<{
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  toggleTheme: () => void;
}>;

const THEME_STORAGE_KEY = "omni.theme";
const ThemeContext = createContext<ThemeContextValue | null>(null);

function isThemeMode(value: string | null): value is ThemeMode {
  return value === "light" || value === "dark";
}

function readStoredMode(): ThemeMode {
  if (typeof window === "undefined") {
    return "light";
  }

  try {
    const storedMode = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(storedMode) ? storedMode : "light";
  } catch {
    return "light";
  }
}

function applyTheme(mode: ThemeMode): void {
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = mode;
  }
}

export function bootstrapTheme(): ThemeMode {
  const mode = readStoredMode();
  applyTheme(mode);
  return mode;
}

function persistMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Storage can be unavailable in restricted renderer contexts.
  }
}

export function ThemeProvider({ children }: { children: ReactNode }): ReactNode {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);

  useLayoutEffect(() => {
    applyTheme(mode);
  }, [mode]);

  const setMode = useCallback((nextMode: ThemeMode): void => {
    setModeState(nextMode);
    persistMode(nextMode);
  }, []);

  const toggleTheme = useCallback((): void => {
    setMode(mode === "light" ? "dark" : "light");
  }, [mode, setMode]);

  const value = useMemo<ThemeContextValue>(() => ({ mode, setMode, toggleTheme }), [mode, setMode, toggleTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider.");
  }

  return context;
}
