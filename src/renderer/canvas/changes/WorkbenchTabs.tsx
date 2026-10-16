import type { KeyboardEvent, ReactElement } from "react";
import type { TranslationFunction } from "../../i18n";
type Tab = "diff" | "targets" | "result";
export function WorkbenchTabs({
  tab,
  propagation,
  hasResult,
  hasPreview,
  restoreMode,
  onChange,
  labels,
  t,
}: Readonly<{
  tab: Tab;
  propagation: boolean;
  hasResult: boolean;
  hasPreview: boolean;
  restoreMode: boolean;
  onChange: (tab: Tab) => void;
  labels?: Readonly<Record<Tab, string>>;
  t: TranslationFunction;
}>): ReactElement {
  const keyTabs = (event: KeyboardEvent<HTMLElement>): void => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=tab]:not(:disabled)")];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const index =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    event.preventDefault();
    buttons[index]?.click();
    buttons[index]?.focus();
  };
  return (
    <nav aria-label={t("skillManagement.title")} className="changes-tabs" onKeyDown={keyTabs} role="tablist">
      {(["diff", "targets", "result"] as const).map((name) => (
        <button
          aria-controls={`changes-panel-${name}`}
          aria-selected={tab === name}
          disabled={
            name === "result" ? !hasResult : propagation ? Boolean(hasResult) : Boolean(hasResult) && !hasPreview
          }
          id={`changes-tab-${name}`}
          key={name}
          onClick={() => onChange(name)}
          role="tab"
          tabIndex={tab === name ? 0 : -1}
          type="button"
        >
          {labels?.[name] ??
            t(
              propagation && name !== "result" && !restoreMode
                ? name === "diff"
                  ? "skillManagement.propagationCompare"
                  : "skillManagement.propagationProjects"
                : `skillManagement.${name}`,
            )}
        </button>
      ))}
    </nav>
  );
}
