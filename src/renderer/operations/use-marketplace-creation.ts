import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { slugify } from "../../domain/marketplace-format";
import type { DesktopApi } from "../../shared/ipc";
import type { OperationPlan, OperationReceipt, PreviewMarketplaceResponse } from "../../shared/operations-ipc";
import { useI18n } from "../i18n";

type ParentSelection = Readonly<{ token: string; display: string }>;
type PreviewState =
  | Readonly<{ kind: "ready"; plan: OperationPlan; parentToken: string; name: string }>
  | Readonly<{
      kind: "blocked";
      reason: string;
      diagnostic: string;
      parentToken: string;
      name: string;
    }>;

export type MarketplaceCreationApi = Pick<
  DesktopApi,
  "pickOperationParent" | "previewOperation" | "applyOperation"
> | null;

export type MarketplaceCreationState = Readonly<{
  parent: ParentSelection | null;
  name: string;
  slug: string;
  validName: boolean;
  validation: string | null;
  preview: PreviewState | null;
  lastPlan: OperationPlan | null;
  receipt: OperationReceipt | null;
  registered: boolean;
  diagnostic: string | null;
  busy: boolean;
  applying: boolean;
}>;

export type MarketplaceCreationActions = Readonly<{
  chooseParent: () => Promise<void>;
  setName: (value: string) => void;
  preview: () => Promise<void>;
  changePreview: () => void;
  apply: () => Promise<void>;
}>;

export function useMarketplaceCreation(
  input: Readonly<{
    api: MarketplaceCreationApi;
    onApplied: (receipt: OperationReceipt) => void;
    onReceipt?: (receipt: OperationReceipt) => void;
  }>,
): Readonly<{ state: MarketplaceCreationState; actions: MarketplaceCreationActions }> {
  const { t } = useI18n();
  const [parent, setParent] = useState<ParentSelection | null>(null);
  const [name, setNameState] = useState("my-marketplace");
  const [previewState, setPreviewState] = useState<PreviewState | null>(null);
  const [lastPlan, setLastPlan] = useState<OperationPlan | null>(null);
  const [receipt, setReceipt] = useState<OperationReceipt | null>(null);
  const [diagnostic, setDiagnostic] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const mounted = useRef(true);
  const parentRef = useRef<ParentSelection | null>(null);
  const nameRef = useRef("my-marketplace");
  const intentRevision = useRef(0);
  const previewRevision = useRef(0);
  const previewRef = useRef<PreviewState | null>(null);
  const applyInFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      intentRevision.current += 1;
      previewRevision.current += 1;
    };
  }, []);

  const slug = useMemo(() => slugify(name), [name]);
  const validName = name.trim().length > 0 && slug.length > 0 && !/[\\/]/u.test(name) && !name.includes("..");
  const validation =
    name.trim() === "" ? t("marketplaceFlow.nameRequired") : validName ? null : t("marketplaceFlow.nameInvalid");

  const invalidateIntent = useCallback((): void => {
    intentRevision.current += 1;
    previewRevision.current += 1;
    previewRef.current = null;
    setPreviewState(null);
    setLastPlan(null);
    setReceipt(null);
    setDiagnostic(null);
    if (!applyInFlight.current) setBusy(false);
  }, []);

  const chooseParent = useCallback(async (): Promise<void> => {
    if (applyInFlight.current) return;
    if (!input.api?.pickOperationParent) {
      setDiagnostic(t("marketplaceFlow.noApi"));
      return;
    }
    setBusy(true);
    setDiagnostic(null);
    try {
      const result = await input.api.pickOperationParent();
      if (!mounted.current) return;
      if (result.status === "picked") {
        const nextParent = { token: result.parentToken, display: result.displayParent };
        parentRef.current = nextParent;
        setParent(nextParent);
        invalidateIntent();
      }
    } catch {
      if (mounted.current) setDiagnostic(t("marketplaceFlow.noApi"));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [input.api, invalidateIntent, t]);

  const setName = useCallback(
    (value: string): void => {
      if (applyInFlight.current) return;
      nameRef.current = value;
      setNameState(value);
      invalidateIntent();
    },
    [invalidateIntent],
  );

  const preview = useCallback(async (): Promise<void> => {
    if (!input.api?.previewOperation) {
      setDiagnostic(t("marketplaceFlow.noApi"));
      return;
    }
    const currentParent = parentRef.current;
    const currentName = nameRef.current;
    if (!currentParent) {
      setDiagnostic(t("marketplaceFlow.pickParentFirst"));
      return;
    }
    const currentSlug = slugify(currentName);
    const currentNameIsValid =
      currentName.trim().length > 0 &&
      currentSlug.length > 0 &&
      !/[\\/]/u.test(currentName) &&
      !currentName.includes("..");
    if (!currentNameIsValid) {
      setDiagnostic(currentName.trim() ? t("marketplaceFlow.nameInvalid") : t("marketplaceFlow.nameRequired"));
      return;
    }
    const requestRevision = ++previewRevision.current;
    const requestIntent = intentRevision.current;
    setBusy(true);
    setDiagnostic(null);
    setReceipt(null);
    try {
      const result: PreviewMarketplaceResponse = await input.api.previewOperation({
        kind: "create-marketplace",
        parentToken: currentParent.token,
        name: currentName,
      });
      if (
        !mounted.current ||
        requestRevision !== previewRevision.current ||
        requestIntent !== intentRevision.current ||
        parentRef.current?.token !== currentParent.token ||
        nameRef.current !== currentName
      )
        return;
      const nextPreview: PreviewState =
        result.status === "ready"
          ? { kind: "ready", plan: result.plan, parentToken: currentParent.token, name: currentName }
          : {
              kind: "blocked",
              reason: result.reason,
              diagnostic: result.diagnostic,
              parentToken: currentParent.token,
              name: currentName,
            };
      previewRef.current = nextPreview;
      setPreviewState(nextPreview);
      setLastPlan(result.status === "ready" ? result.plan : null);
    } catch {
      if (mounted.current && requestRevision === previewRevision.current) setDiagnostic(t("marketplaceFlow.noApi"));
    } finally {
      if (mounted.current && requestRevision === previewRevision.current) setBusy(false);
    }
  }, [input.api, t]);

  const changePreview = useCallback((): void => {
    if (applyInFlight.current) return;
    previewRevision.current += 1;
    previewRef.current = null;
    setPreviewState(null);
    setDiagnostic(null);
  }, []);

  const apply = useCallback(async (): Promise<void> => {
    const displayed = previewRef.current;
    const currentParent = parentRef.current;
    const currentName = nameRef.current;
    if (
      applyInFlight.current ||
      !input.api?.applyOperation ||
      displayed?.kind !== "ready" ||
      displayed.plan.kind !== "create-marketplace" ||
      displayed.parentToken !== currentParent?.token ||
      displayed.name !== currentName
    )
      return;

    applyInFlight.current = true;
    setBusy(true);
    setApplying(true);
    setDiagnostic(null);
    try {
      const result = await input.api.applyOperation({ planId: displayed.plan.planId });
      if (!mounted.current) return;
      setReceipt(result.receipt);
      previewRef.current = null;
      setPreviewState(null);
      input.onReceipt?.(result.receipt);
      if (result.receipt.status === "failed" || result.status !== "applied") {
        setDiagnostic(result.receipt.diagnostic ?? t("marketplaceFlow.failed"));
      } else if (!result.receipt.registered?.sourceId) {
        setDiagnostic(t("registry.registrationFailed"));
      } else {
        setDiagnostic(null);
        input.onApplied(result.receipt);
      }
    } catch {
      if (mounted.current) setDiagnostic(t("marketplaceFlow.noApi"));
    } finally {
      applyInFlight.current = false;
      if (mounted.current) {
        setBusy(false);
        setApplying(false);
      }
    }
  }, [input.api, input.onApplied, input.onReceipt, t]);

  return {
    state: {
      parent,
      name,
      slug,
      validName,
      validation,
      preview: previewState,
      lastPlan,
      receipt,
      registered: Boolean(receipt?.status === "applied" && receipt.registered?.sourceId),
      diagnostic,
      busy,
      applying,
    },
    actions: { chooseParent, setName, preview, changePreview, apply },
  };
}
