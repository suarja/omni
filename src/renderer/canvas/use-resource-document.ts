import { useCallback, useEffect, useRef, useState } from "react";

import type { EntryRef } from "../../domain/project-source-registry";
import type { ReadArtifactResponse } from "../../shared/artifact-ipc";
import type { DesktopApi } from "../../shared/ipc";

export type ResourceDocument = Readonly<{ relativePath: string; response: ReadArtifactResponse }>;
export type ResourceDocumentState =
  Readonly<{ status: "idle" | "loading" }> | Readonly<{ status: "result"; document: ResourceDocument }>;

export function useResourceDocument(
  input: Readonly<{
    api: Pick<DesktopApi, "readArtifact"> | null;
    onEnsureGrant: (entry: EntryRef) => Promise<string | null>;
  }>,
): Readonly<{
  state: ResourceDocumentState;
  read: (entry: EntryRef, relativePath: string) => void;
  cancel: () => void;
}> {
  const generation = useRef(0);
  const [state, setState] = useState<ResourceDocumentState>({ status: "idle" });
  const cancel = useCallback((): void => {
    generation.current += 1;
    setState({ status: "idle" });
  }, []);
  const read = useCallback(
    (entry: EntryRef, relativePath: string): void => {
      const requestId = ++generation.current;
      setState({ status: "loading" });
      void (async () => {
        const readArtifact = input.api?.readArtifact;
        if (!readArtifact) {
          if (generation.current === requestId)
            setState({
              status: "result",
              document: {
                relativePath,
                response: { status: "unavailable", diagnostic: "Artifact reading is unavailable." },
              },
            });
          return;
        }
        try {
          let grantHandle = await input.onEnsureGrant(entry);
          if (generation.current !== requestId) return;
          if (!grantHandle) {
            setState({ status: "result", document: { relativePath, response: { status: "denied" } } });
            return;
          }
          let response = await readArtifact({ ...entry, grantHandle, relativePath });
          if (generation.current !== requestId) return;
          if (response.status === "denied") {
            grantHandle = await input.onEnsureGrant(entry);
            if (generation.current !== requestId) return;
            response = grantHandle ? await readArtifact({ ...entry, grantHandle, relativePath }) : { status: "denied" };
          }
          if (generation.current === requestId) setState({ status: "result", document: { relativePath, response } });
        } catch {
          if (generation.current === requestId)
            setState({
              status: "result",
              document: {
                relativePath,
                response: { status: "unavailable", diagnostic: "The artifact cannot be read." },
              },
            });
        }
      })();
    },
    [input.api, input.onEnsureGrant],
  );
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  return { state, read, cancel };
}
