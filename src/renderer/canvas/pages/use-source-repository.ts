import { useEffect, useState } from "react";
import type { ResourceCanvasProps } from "../resource-canvas-types";
import { parseExternalRepositoryOpened } from "../../../shared/external-library-ui-ipc";

export function useSourceRepository(
  api: ResourceCanvasProps["api"],
  sourceId: string | undefined,
): Readonly<{ error: string | null; open: () => Promise<void> }> {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [sourceId]);
  async function open(): Promise<void> {
    if (!sourceId) return;
    setError(null);
    try {
      if (!api?.openExternalSourceRepository)
        throw new Error(`Repository opening is unavailable for ${sourceId}. Reopen the library.`);
      const result = parseExternalRepositoryOpened(await api.openExternalSourceRepository({ sourceId }));
      if (result.status === "blocked") setError(result.message);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : `Repository ${sourceId} could not be opened. Retry from its source page.`,
      );
    }
  }
  return { error, open };
}
