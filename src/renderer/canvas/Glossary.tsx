import { Icon } from "../components/Icon";
import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import { useI18n } from "../i18n";
import type { en } from "../i18n/locales/en";

export type GlossaryKey = keyof typeof en.projectView.glossary;
export function Glossary({
  concept,
  appearance = "inline",
}: Readonly<{ concept: GlossaryKey; appearance?: "inline" | "node" }>): ReactElement {
  const { t } = useI18n();
  const id = useId();
  const [open, setOpen] = useState(false);
  const keyboardFocus = useRef(false);
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      keyboardFocus.current = event.type === "keydown" && event.key === "Tab";
    };
    const pointer = (): void => {
      keyboardFocus.current = false;
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("keyup", key, true);
    document.addEventListener("pointerdown", pointer, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("keyup", key, true);
      document.removeEventListener("pointerdown", pointer, true);
    };
  }, []);
  return (
    <span className="canvas-glossary" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        data-glossary={concept}
        className={appearance === "node" ? "canvas-node-info" : "canvas-glossary-trigger"}
        aria-label={t("projectView.glossaryLabel", { name: t(`projectView.glossary.${concept}.title`) })}
        aria-describedby={open ? id : undefined}
        onFocus={(event) => {
          setOpen(keyboardFocus.current && event.currentTarget.matches(":focus-visible"));
          keyboardFocus.current = false;
        }}
        onClick={appearance === "node" ? () => setOpen(true) : undefined}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.stopPropagation();
            setOpen(false);
          }
        }}
      >
        {appearance === "node" ? <Icon name="info" size={14} /> : "i"}
      </button>
      {open ? (
        <span className="canvas-glossary-tooltip" role="tooltip" id={id}>
          <strong>{t(`projectView.glossary.${concept}.title`)}</strong>
          {t(`projectView.glossary.${concept}.text`)}
        </span>
      ) : null}
    </span>
  );
}
