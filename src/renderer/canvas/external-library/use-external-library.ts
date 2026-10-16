import { useCallback, useEffect, useRef, useState } from "react";
import type { ResourceCanvasProps } from "../resource-canvas-types";
import { useReviewRevision } from "../../review/use-review-revision";
import {
  parseExternalLibraryList,
  parseExternalSourceDetails,
  parseExternalMacSources,
  type ExternalLibraryList,
  type ExternalSourceDetails,
  type ExternalMacSources,
} from "../../../shared/external-library-ipc";
import { useCoalescedReload } from "../use-coalesced-reload";
import { externalReviewItems } from "./presentation";

export type ExternalLibraryState = Readonly<{
  list: ExternalLibraryList | null;
  details: ReadonlyMap<string, ExternalSourceDetails>;
  mac: ExternalMacSources | null;
  mode: "auto" | "ask";
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  check: () => Promise<void>;
  checking: boolean;
  review: ReturnType<typeof externalReviewItems>;
}>;
export function useExternalLibrary(canvas: ResourceCanvasProps): ExternalLibraryState {
  const api = canvas.api;
  const revision = useReviewRevision(api);
  const [list, setList] = useState<ExternalLibraryList | null>(null);
  const [details, setDetails] = useState<ReadonlyMap<string, ExternalSourceDetails>>(new Map());
  const [mac, setMac] = useState<ExternalMacSources | null>(null);
  const [mode, setMode] = useState<"auto" | "ask">("auto");
  const [loading, setLoading] = useState(Boolean(api?.listExternalSources));
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ticket = useRef(0);
  const checkLock = useRef(false);
  const read = useCallback(async (): Promise<void> => {
    if (!api?.listExternalSources) return;
    const current = ++ticket.current;
    setLoading(true);
    setError(null);
    try {
      const result = parseExternalLibraryList(await api.listExternalSources());
      const reads = await Promise.allSettled([
        api.listExternalSourcesOnMac?.().then(parseExternalMacSources),
        api.getSettings?.(),
        ...result.sources.map(async (source) => {
          if (!api.readExternalSource) throw new Error("Source reading is unavailable. Reopen the library.");
          const details = parseExternalSourceDetails(await api.readExternalSource({ sourceId: source.id }));
          if (details.source && details.source.id !== source.id)
            throw new Error("Source response does not match the requested repository.");
          return details;
        }),
      ]);
      if (ticket.current !== current) return;
      setList(result);
      const onMac = reads[0];
      setMac(onMac.status === "fulfilled" ? ((onMac.value as ExternalMacSources) ?? null) : null);
      const settings = reads[1];
      if (settings.status === "fulfilled" && settings.value && "externalLibrary" in settings.value)
        setMode(settings.value.externalLibrary.updates);
      const next = new Map<string, ExternalSourceDetails>();
      reads.slice(2).forEach((read, index) => {
        if (read.status === "fulfilled" && read.value && "skills" in read.value)
          next.set(result.sources[index]!.id, read.value as ExternalSourceDetails);
        else setError("An external source could not be read. Check the library again.");
      });
      setDetails(next);
      if (onMac.status === "rejected" || settings.status === "rejected")
        setError("Library settings or Mac sources could not be read. Check the library again.");
    } catch (failure) {
      if (ticket.current === current)
        setError(failure instanceof Error ? failure.message : "External library reading failed.");
    } finally {
      if (ticket.current === current) setLoading(false);
    }
  }, [api]);
  const reload = useCoalescedReload(read);
  useEffect(() => {
    void reload();
    return () => {
      ticket.current++;
    };
  }, [read, reload, revision, canvas.snapshot.registry.revision]);
  const check = useCallback(async (): Promise<void> => {
    if (checkLock.current || !api?.checkExternalLibrary) return;
    checkLock.current = true;
    setChecking(true);
    try {
      await api.checkExternalLibrary();
      await reload();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "External library check failed.");
    } finally {
      checkLock.current = false;
      setChecking(false);
    }
  }, [api, reload]);
  return {
    list,
    details,
    mac,
    mode,
    loading,
    error,
    checking: checking || Boolean(list?.checking),
    reload,
    check,
    review: externalReviewItems([...details.values()], mode),
  };
}
