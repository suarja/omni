import type { ReactElement, ReactNode } from "react";

import { ListItem } from "./ItemList";

type LoadingItemProps = Readonly<{
  dataTestId?: string;
  label?: ReactNode;
}>;

/**
 * The one loading row (D2): a dim `ListItem` with a subtle pulse on its name, no spinner.
 * Every list host renders this until its first data arrives, and shows its empty copy only
 * once the observation has completed and is empty. Callers pass the localized copy
 * (`t("destinations.loading")`) so this primitive stays free of i18n coupling.
 */
export function LoadingItem({ dataTestId = "loading-item", label = "Loading…" }: LoadingItemProps): ReactElement {
  return <ListItem className="ui-loading-item" dataTestId={dataTestId} dim name={label} />;
}
