import { createHash } from "node:crypto";
import { readFileSync, watch } from "node:fs";
import { join } from "node:path";

const REVIEW_FILES = new Set([
  "agent-requests.json",
  "operations.json",
  "bindings.json",
  "project-source-registry.json",
]);

function fingerprint(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "missing";
    throw error;
  }
}

/** Watch durable content: permission repairs and identical store rewrites are not new state. */
export function watchReviewChanges(userDataPath: string, publish: () => void): () => void {
  const root = join(userDataPath, "omni");
  const fingerprints = new Map([...REVIEW_FILES].map((name) => [name, fingerprint(join(root, name))]));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reportError = (error: unknown): void => {
    console.error("Review change notifications are unavailable; return to the app to refresh.", error);
  };
  const watcher = watch(root, (_event, filename) => {
    if (filename !== null && !REVIEW_FILES.has(filename.toString())) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        let changed = false;
        for (const name of REVIEW_FILES) {
          const current = fingerprint(join(root, name));
          if (fingerprints.get(name) !== current) changed = true;
          fingerprints.set(name, current);
        }
        if (changed) publish();
      } catch (error: unknown) {
        reportError(error);
      }
    }, 25);
  });
  watcher.on("error", reportError);
  return () => {
    if (timer) clearTimeout(timer);
    watcher.close();
  };
}
