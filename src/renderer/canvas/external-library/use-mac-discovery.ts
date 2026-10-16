import { useEffect, useState } from "react";
import type { DesktopApi } from "../../../shared/ipc";
import type { ExternalMacSources } from "../../../shared/external-library-ipc";
import { parseExternalDiscovery, type ExternalDiscovery } from "../../../shared/external-library-ui-ipc";

type Api = Partial<DesktopApi>;
type Mac = ExternalMacSources | null | undefined;
const revisions = new WeakMap<Api, { key: string; reads: Map<string, Promise<ExternalDiscovery>> }>();
function macKey(mac: Mac): string {
  return JSON.stringify(mac?.marketplaces ?? []);
}

/** Share pending and successful discoveries. A later explicit opening can retry a failure. */
export function discoverMacSource(api: Api, mac: Mac, repository: string): Promise<ExternalDiscovery> {
  const key = macKey(mac);
  let revision = revisions.get(api);
  if (!revision || revision.key !== key) {
    revision = { key, reads: new Map() };
    revisions.set(api, revision);
  }
  const previous = revision.reads.get(repository);
  if (previous) return previous;
  const pending = Promise.resolve()
    .then(async () => {
      if (!api.discoverExternalSource) throw new Error("Mac source discovery is unavailable. Reopen Add source.");
      return parseExternalDiscovery(await api.discoverExternalSource({ repository }));
    })
    .catch((): ExternalDiscovery => ({
      status: "failed",
      error: { type: "other", message: "This Mac source could not be inspected. Retry discovery." },
    }))
    .then((result) => {
      if (result.status === "failed" && revision.reads.get(repository) === pending) revision.reads.delete(repository);
      return result;
    });
  revision.reads.set(repository, pending);
  return pending;
}
export function useMacDiscovery(api: Api | null | undefined, mac: Mac): ReadonlyMap<string, ExternalDiscovery> {
  const [details, setDetails] = useState<ReadonlyMap<string, ExternalDiscovery>>(new Map());
  const key = macKey(mac);
  useEffect(() => {
    let active = true;
    setDetails(new Map());
    if (!api?.discoverExternalSource) return;
    const entries = mac?.marketplaces ?? [];
    let index = 0;
    async function worker(): Promise<void> {
      while (index < entries.length) {
        const item = entries[index++]!;
        const result = await discoverMacSource(api!, mac, item.repo);
        if (active) setDetails((current) => new Map(current).set(item.repo, result));
      }
    }
    void Promise.all([worker(), worker(), worker()]);
    return () => {
      active = false;
    };
  }, [api, key]);
  return details;
}
