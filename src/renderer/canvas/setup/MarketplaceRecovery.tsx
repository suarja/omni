import { useEffect, useRef, useState, type ReactElement } from "react";
import { activeWorkshop } from "../../../domain/source-roles";
import type { OperationPlan, OperationReceipt } from "../../../shared/operations-ipc";
import { parseApplyOperationResponse, parsePreviewMarketplaceResponse } from "../../../shared/operations-ipc";
import { useI18n } from "../../i18n";
import { useOptionalCanvasToast } from "../CanvasToast";
import { useCanvasRail } from "../rail/rail-context";

type Offer = Readonly<{ name: string; plan: OperationPlan }>;
export function MarketplaceRecovery({
  sourceId,
  onOfferChange,
}: Readonly<{ sourceId?: string; onOfferChange?: (available: boolean) => void }>): ReactElement | null {
  const rail = useCanvasRail()!;
  const { t } = useI18n();
  const toast = useOptionalCanvasToast();
  const api = rail.canvas.api;
  const registry = rail.canvas.snapshot.registry;
  const [offers, setOffers] = useState<readonly Offer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const mounted = useRef(false);
  const workshop = activeWorkshop(registry);
  const hasOffer = !workshop && offers.length > 0;
  useEffect(() => {
    onOfferChange?.(hasOffer);
  }, [hasOffer, onOfferChange]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let current = true;
    setOffers([]);
    setError(null);
    if (workshop || !api?.previewOperation) return;
    const sources = registry.sources.filter(
      (source) =>
        !source.archivedAt && source.ownership === "external" && (!sourceId || `folder:${source.ref.id}` === sourceId),
    );
    void Promise.all(
      sources.map(async (source) => {
        const result = parsePreviewMarketplaceResponse(
          await api.previewOperation!({ kind: "connect-marketplace", sourceId: source.ref.id }),
        );
        if (result.status === "ready") return { name: source.displayName, plan: result.plan };
        if (sourceId && current) setError(result.diagnostic);
        return null;
      }),
    )
      .then((results) => {
        if (current)
          setOffers(results.filter((offer): offer is Offer => Boolean(offer)).slice(0, sourceId ? undefined : 1));
      })
      .catch((failure) => {
        if (current) setError(failure instanceof Error ? failure.message : t("canvasSetup.actionFailed"));
      });
    return () => {
      current = false;
    };
  }, [api, registry.revision, sourceId, workshop?.ref.id, t]);
  async function refresh(): Promise<void> {
    const result = await rail.canvas.setup?.commands.refreshRegistry();
    if (result && result.status !== "ready") throw Error(t("canvasSetup.refreshFailed"));
    if (!rail.canvas.setup) rail.canvas.onRefresh();
    await rail.externalLibrary.reload();
  }
  async function undo(receipt: OperationReceipt): Promise<void> {
    if (locked.current || !api?.previewOperation || !api.applyOperation) return;
    locked.current = true;
    try {
      const preview = parsePreviewMarketplaceResponse(
        await api.previewOperation({ kind: "restore-import", operationId: receipt.operationId }),
      );
      if (preview.status !== "ready") throw Error(preview.diagnostic);
      const result = parseApplyOperationResponse(await api.applyOperation({ planId: preview.plan.planId }));
      if (result.status !== "applied") throw Error(result.receipt.diagnostic ?? t("canvasSetup.actionFailed"));
      await refresh();
      toast?.show({ message: t("canvasSetup.marketplaceUndone") });
    } catch (failure) {
      toast?.show({ message: failure instanceof Error ? failure.message : t("canvasSetup.actionFailed") });
    } finally {
      locked.current = false;
    }
  }
  async function apply(offer: Offer): Promise<void> {
    if (locked.current || !api?.applyOperation) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    let receipt: OperationReceipt | undefined;
    let failureMessage: string | undefined;
    try {
      const result = parseApplyOperationResponse(await api.applyOperation({ planId: offer.plan.planId }));
      if (result.status !== "applied") throw Error(result.receipt.diagnostic ?? t("canvasSetup.actionFailed"));
      receipt = result.receipt;
      await refresh();
      if (sourceId) rail.canvas.onNavigate({ screen: "resource-canvas", context: { kind: "workspace" } });
    } catch (failure) {
      failureMessage = failure instanceof Error ? failure.message : t("canvasSetup.actionFailed");
      if (mounted.current) setError(failureMessage);
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
      // Show Undo only once it can run. Keep the saved receipt recoverable after a refresh failure.
      if (receipt) {
        const appliedReceipt = receipt;
        toast?.show({
          message: failureMessage ?? t("canvasSetup.marketplaceConnected", { name: offer.name }),
          undo: () => undo(appliedReceipt),
        });
      }
    }
  }
  if (workshop || (!offers.length && !error)) return null;
  return (
    <div className="marketplace-recovery">
      {offers.map((offer) => (
        <div key={offer.plan.planId}>
          <p className="workspace-setup-place-copy">{t("canvasSetup.marketplaceRecovery", { name: offer.name })}</p>
          <button
            type="button"
            className="canvas-secondary-button is-primary"
            data-testid="workspace-use-marketplace"
            disabled={busy}
            onClick={() => void apply(offer)}
          >
            {t("canvasSetup.useAsMarketplace")}
          </button>
        </div>
      ))}
      {error ? (
        <p className="skill-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
