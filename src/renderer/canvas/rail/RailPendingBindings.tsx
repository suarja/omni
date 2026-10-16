import type { ReactElement } from "react";
import type { Route } from "../../navigation";
import { useI18n } from "../../i18n";
import { PendingApproval } from "../../review/ReviewSections";
import { useBindingPreviews } from "../../review/binding-previews";
import type { ResourceCanvasProps } from "../resource-canvas-types";

const noBindings = [] as const;

// The legacy preview grants stay behind an explicit expansion, as in the existing review journey.
export function RailPendingBindings(
  props: Readonly<{ canvas: ResourceCanvasProps; onNavigate: (route: Route) => void }>,
): ReactElement {
  const { t } = useI18n();
  const { canvas } = props;
  const saved = canvas.railServices?.bindingPreviews ?? [];
  const bindings = saved.length || canvas.snapshot.uses.status !== "ready" ? noBindings : canvas.snapshot.uses.bindings;
  const loaded = useBindingPreviews(canvas.railServices?.api, bindings, canvas.onEnsureGrant);
  return (
    <PendingApproval
      bindingPreviews={saved.length ? saved : loaded}
      registry={canvas.snapshot.registry}
      requests={[]}
      requestsError={false}
      requestsLoading={false}
      onNavigateToRoute={props.onNavigate}
      t={t}
    />
  );
}
