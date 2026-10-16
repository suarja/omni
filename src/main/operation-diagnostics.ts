import { readDisplay } from "../shared/operations-ipc-parser-utils";

export function receiptDiagnostic(error: unknown, fallback: string): string {
  try {
    return readDisplay(error instanceof Error ? error.message : error, "Operation diagnostic");
  } catch {
    return fallback;
  }
}
