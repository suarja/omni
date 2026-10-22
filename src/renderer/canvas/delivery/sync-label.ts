import type { WorkshopSyncState } from "../../../shared/workshop-delivery-ipc";
import { translateCount, type TranslationFunction } from "../../i18n";

export function workshopSyncLabel(state: WorkshopSyncState, t: TranslationFunction): string {
  if (state.status === "ahead") return translateCount(t, "delivery.ahead", state.ahead);
  return [
    t(`delivery.sync.${state.status}`),
    state.ahead ? translateCount(t, "delivery.ahead", state.ahead) : null,
    state.behind ? translateCount(t, "delivery.behindCommits", state.behind) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
