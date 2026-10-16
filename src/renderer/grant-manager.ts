import { useReviewRevision } from "./review/use-review-revision";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";

import type { EntryRef } from "../domain/project-source-registry";
import type { Binding } from "../domain/assignment-plan";
import type { BindingSnapshot } from "../domain/resource-catalogue";
import type { DesktopApi } from "../shared/ipc";
import type { OpenEntryResponse } from "../shared/registry-ipc";

export const GRANT_REUSE_MS = 4 * 60 * 1000;
type GrantCacheEntry = Readonly<{ grantHandle: string; issuedAt: number }>;

function entryKey(ref: EntryRef): string {
  return `${ref.kind}:${ref.id}`;
}

function openedEntryMatches(opened: OpenEntryResponse, ref: EntryRef): boolean {
  return opened.status !== "corrupt" && opened.entry.ref.kind === ref.kind && opened.entry.ref.id === ref.id;
}

export function useGrantManager(
  api: DesktopApi | null,
  setOpenedEntry: Dispatch<SetStateAction<OpenEntryResponse | null>>,
): Readonly<{
  bindings: readonly Binding[];
  bindingsSnapshot: BindingSnapshot;
  ensureGrant: (ref: EntryRef) => Promise<string | null>;
  grantCache: MutableRefObject<Readonly<Record<string, GrantCacheEntry>>>;
  grantIssuedAt: MutableRefObject<number>;
  refreshBindings: () => Promise<void>;
  removeBinding: (bindingId: string) => void;
}> {
  const revision = useReviewRevision(api);
  const grantIssuedAt = useRef(0);
  const grantCache = useRef<Readonly<Record<string, GrantCacheEntry>>>({});
  const [bindings, setBindings] = useState<readonly Binding[]>([]);
  const [bindingsSnapshot, setBindingsSnapshot] = useState<BindingSnapshot>({ status: "loading" });
  const bindingsGeneration = useRef(0);

  useEffect(() => {
    let active = true;
    const generation = ++bindingsGeneration.current;
    if (!api?.listBindings) {
      setBindingsSnapshot({ status: "unavailable" });
      return () => {
        active = false;
      };
    }
    setBindingsSnapshot({ status: "loading" });
    void api
      .listBindings()
      .then((response) => {
        if (!active || generation !== bindingsGeneration.current) return;
        if (response.status === "ready") {
          setBindings(response.bindings);
          setBindingsSnapshot({ status: "ready", bindings: response.bindings });
        } else setBindingsSnapshot({ status: "unavailable" });
      })
      .catch(() => {
        if (active && generation === bindingsGeneration.current) setBindingsSnapshot({ status: "unavailable" });
      });
    return () => {
      active = false;
    };
  }, [api, revision]);

  const ensureGrant = useCallback(
    async (ref: EntryRef): Promise<string | null> => {
      if (!api) return null;
      try {
        const opened = await api.openEntry(ref);
        if (opened.status !== "granted" || !openedEntryMatches(opened, ref)) return null;
        const entry = { grantHandle: opened.grantHandle, issuedAt: Date.now() };
        grantCache.current = { ...grantCache.current, [entryKey(ref)]: entry };
        setOpenedEntry(opened);
        return opened.grantHandle;
      } catch {
        return null;
      }
    },
    [api, setOpenedEntry],
  );

  const refreshBindings = useCallback(async (): Promise<void> => {
    const generation = ++bindingsGeneration.current;
    if (!api?.listBindings) {
      setBindingsSnapshot({ status: "unavailable" });
      return;
    }
    setBindingsSnapshot({ status: "loading" });
    try {
      const response = await api.listBindings();
      if (generation !== bindingsGeneration.current) return;
      if (response.status === "ready") {
        setBindings(response.bindings);
        setBindingsSnapshot({ status: "ready", bindings: response.bindings });
      } else setBindingsSnapshot({ status: "unavailable" });
    } catch {
      if (generation === bindingsGeneration.current) setBindingsSnapshot({ status: "unavailable" });
    }
  }, [api]);

  const removeBinding = useCallback(
    (bindingId: string): void => {
      if (!api?.removeBinding) return;
      const generation = ++bindingsGeneration.current;
      void api
        .removeBinding({ bindingId })
        .then((response) => {
          if (generation !== bindingsGeneration.current) return;
          if (response.status === "ready") {
            setBindings(response.bindings);
            setBindingsSnapshot({ status: "ready", bindings: response.bindings });
          } else setBindingsSnapshot({ status: "unavailable" });
        })
        .catch(() => {
          if (generation === bindingsGeneration.current) setBindingsSnapshot({ status: "unavailable" });
        });
    },
    [api],
  );

  return { bindings, bindingsSnapshot, ensureGrant, grantCache, grantIssuedAt, refreshBindings, removeBinding };
}
