import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { I18nProvider } from "./i18n";
import { bootstrapTheme, ThemeProvider } from "./theme/theme-provider";
import "./theme/tokens.css";
import "./components/ui/ui.css";
import "./destination.css";
import "./operations/import-page.css";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Renderer root element is missing.");
}

bootstrapTheme();

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <I18nProvider>
        <App />
      </I18nProvider>
    </ThemeProvider>
  </StrictMode>,
);
