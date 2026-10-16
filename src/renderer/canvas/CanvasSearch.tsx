import { useCanvasRail } from "./rail/rail-context";
import { usePageSearchChoices, type CanvasSearchChoice } from "./pages/page-search";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";

import type { ResourceRecord } from "../../domain/resource-catalogue";
import { SheetFrame } from "./SheetFrame";
import { Icon } from "../components/Icon";
import { useI18n } from "../i18n";

export function CanvasSearch(
  props: Readonly<{
    records: readonly ResourceRecord[];
    onClose: () => void;
    onSelect: (resource: ResourceRecord) => void;
  }>,
): ReactElement {
  const { t } = useI18n();
  const rail = useCanvasRail();
  const pages = usePageSearchChoices();
  const choices: readonly CanvasSearchChoice[] = [
    ...pages,
    ...props.records
      .filter(
        (record) =>
          !rail ||
          (record.kind !== "marketplace" &&
            record.kind !== "external-source" &&
            !(
              record.ref.entry.kind === "source" &&
              record.artifactKind === "skill" &&
              record.ref.entry.id === rail.personal.marketplace?.source.ref.id
            )),
      )
      .map((resource) => ({
        key: JSON.stringify([resource.ref, resource.relativePath ?? null]),
        label: resource.label,
        hint: resource.relativePath ?? resource.kind,
        kind: resource.kind,
        resource,
      })),
  ];
  function select(choice: CanvasSearchChoice): void {
    if (choice.route && rail) {
      props.onClose();
      rail.close();
      rail.canvas.onNavigate(choice.route);
    } else if (choice.resource) props.onSelect(choice.resource);
  }
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listId = useId();
  const list = useRef<HTMLDivElement>(null);
  const results = useMemo(
    () =>
      choices.filter((record) => {
        const needle = query.trim().toLocaleLowerCase();
        return !needle || `${record.label} ${record.hint}`.toLocaleLowerCase().includes(needle);
      }),
    [choices, query],
  );
  const activeIndex = Math.min(selectedIndex, Math.max(0, results.length - 1));
  const activeResult = results[activeIndex];
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex, query]);
  const selectWithKeyboard = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setSelectedIndex(Math.max(0, Math.min(results.length - 1, activeIndex + direction)));
    } else if (event.key === "Enter" && activeResult) {
      event.preventDefault();
      select(activeResult);
    }
  };
  return (
    <SheetFrame
      title={t("canvas.search")}
      kicker={t("canvas.search")}
      testId="canvas-search-sheet"
      className="canvas-search-sheet"
      onClose={props.onClose}
      focusClose={false}
    >
      <label className="canvas-search-input">
        <Icon name="search" size={18} />
        <input
          aria-activedescendant={activeResult ? `${listId}-${activeIndex}` : undefined}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded="true"
          aria-label={t("canvas.search")}
          autoFocus
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setSelectedIndex(0);
          }}
          onKeyDown={selectWithKeyboard}
          placeholder={t("canvas.searchHint")}
          role="combobox"
          value={query}
        />
      </label>
      <p className="canvas-search-scope">{t("canvas.searchScope")}</p>
      <div aria-label={t("canvas.search")} className="canvas-search-results" id={listId} ref={list} role="listbox">
        {results.length ? (
          results.map((resource, index) => (
            <button
              aria-selected={index === activeIndex}
              className="canvas-search-result"
              id={`${listId}-${index}`}
              key={resource.key}
              onClick={() => select(resource)}
              role="option"
              tabIndex={-1}
              type="button"
            >
              <Icon
                name={
                  resource.kind === "plugin"
                    ? "plugin"
                    : resource.kind === "project"
                      ? "folder"
                      : resource.kind === "marketplace" || resource.kind === "external-source"
                        ? "marketplace"
                        : "instruction"
                }
                size={18}
              />
              <span>
                <strong>{resource.label}</strong>
                <small>{resource.hint}</small>
              </span>
            </button>
          ))
        ) : (
          <p className="canvas-search-empty">{t("canvas.noMatches")}</p>
        )}
      </div>
    </SheetFrame>
  );
}
