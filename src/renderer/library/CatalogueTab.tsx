import { useEffect, useRef, useState, type ReactElement } from "react";

import { STACK_TAGS } from "../../domain/stack-tags";
import type { CatalogueSearchResultView } from "../../shared/catalogue-ipc";
import type { DesktopApi } from "../../shared/ipc";
import { Badge } from "../components/ui/Badge";
import { EmptyState } from "../components/ui/EmptyState";
import { ItemList, ListItem } from "../components/ui/ItemList";
import { LoadingBoundary, LoadingSkeleton } from "../components/ui/Skeleton";
import { SearchField } from "../components/ui/SearchField";
import { useI18n } from "../i18n";
import type { Route } from "../navigation";
import { formatInstalls } from "./library-data";

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_LIMIT = 50;

export type CatalogueTabProps = Readonly<{
  api?: Pick<DesktopApi, "searchCatalogue"> | null;
  onNavigateToRoute: (route: Route) => void;
}>;

type SearchState = "loading" | Readonly<{ results: readonly CatalogueSearchResultView[] }> | "error";

function TagChip({
  label,
  onToggle,
  selected,
}: Readonly<{ label: string; onToggle: () => void; selected: boolean }>): ReactElement {
  return (
    <button aria-pressed={selected} className="catalogue-tag-chip-button" onClick={onToggle} type="button">
      <Badge tone={selected ? "ok" : "neutral"} variant="type">
        {label}
      </Badge>
    </button>
  );
}

function rowSub(
  entry: CatalogueSearchResultView["entry"],
  language: "en" | "fr",
  t: ReturnType<typeof useI18n>["t"],
): ReactElement {
  return (
    <>
      <code>{entry.ownerRepo}</code> ·{" "}
      {t("library.catalogue.installs", { count: formatInstalls(entry.installs, language) })}
      {entry.official ? ` · ${t("library.catalogue.official")}` : ""}
      {entry.tags.length ? ` · ${entry.tags.join(", ")}` : ""}
    </>
  );
}

export function CatalogueTab({ api, onNavigateToRoute }: CatalogueTabProps): ReactElement {
  const { language, t } = useI18n();
  const [query, setQuery] = useState("");
  const [selectedTags, setSelectedTags] = useState<readonly string[]>([]);
  const [state, setState] = useState<SearchState>("loading");
  const sequence = useRef(0);
  const previousSearch = useRef<string | undefined>(undefined);

  useEffect(() => {
    const searchCatalogue = api?.searchCatalogue;
    if (!searchCatalogue) {
      setState("error");
      return;
    }
    const run = sequence.current + 1;
    sequence.current = run;
    const searchKey = JSON.stringify([query, selectedTags]);
    if (previousSearch.current !== searchKey) setState("loading");
    previousSearch.current = searchKey;
    const timer = window.setTimeout(() => {
      void searchCatalogue({
        ...(query.trim() ? { query: query.trim() } : {}),
        ...(selectedTags.length ? { tags: selectedTags } : {}),
        limit: SEARCH_LIMIT,
      })
        .then((response) => {
          if (sequence.current === run) setState({ results: response.results });
        })
        .catch(() => {
          if (sequence.current === run) setState("error");
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [api, query, selectedTags]);

  const toggleTag = (id: string): void => {
    setSelectedTags((current) => (current.includes(id) ? current.filter((tag) => tag !== id) : [...current, id]));
  };

  return (
    <section data-testid="library-catalogue">
      <div className="catalogue-controls">
        <SearchField
          label={t("library.catalogue.searchPlaceholder")}
          onChange={setQuery}
          placeholder={t("library.catalogue.searchPlaceholder")}
          value={query}
        />
      </div>
      <div className="catalogue-tag-chip-list" data-testid="catalogue-tag-chips">
        {STACK_TAGS.map((tag) => (
          <TagChip
            key={tag.id}
            label={tag.label}
            onToggle={() => toggleTag(tag.id)}
            selected={selectedTags.includes(tag.id)}
          />
        ))}
      </div>
      <LoadingBoundary
        key={JSON.stringify([query, selectedTags])}
        loading={state === "loading"}
        label={t("canvas.loadingSurface", { surface: t("canvas.library") })}
        minHeight={216}
      >
        <ItemList>
          {state === "loading" ? (
            <LoadingSkeleton
              dataTestId="catalogue-loading"
              label={t("canvas.loadingSurface", { surface: t("canvas.library") })}
            />
          ) : state === "error" || state.results.length === 0 ? (
            state === "error" ? (
              <ListItem dim name={t("library.catalogue.noMatches")} />
            ) : (
              <EmptyState description="" title={t("library.catalogue.noMatches")} />
            )
          ) : (
            state.results.map(({ entry }) => (
              <ListItem
                badges={
                  entry.source === "marketplace" ? (
                    <Badge dotTone="ok" tone="ok" variant="status">
                      {t("library.catalogue.installedBadge")}
                    </Badge>
                  ) : null
                }
                dataTestId={`catalogue-row-${entry.ownerRepo}-${entry.skill}`}
                key={`${entry.ownerRepo}/${entry.skill}`}
                name={entry.name}
                onClick={() =>
                  onNavigateToRoute({
                    screen: "catalogue-entry",
                    ownerRepo: entry.ownerRepo,
                    skill: entry.skill,
                    returnTo: { screen: "library", tab: "catalogue" },
                  })
                }
                sub={rowSub(entry, language, t)}
              />
            ))
          )}
        </ItemList>
      </LoadingBoundary>
    </section>
  );
}
