import { buildPiRequest } from "./providers/pi";
import type { InferenceCall } from "./provider";

export type DryRunResult = Readonly<{
  modelId: string;
  provider: string;
  system: string;
  userContent: string;
  toolSchema: Readonly<Record<string, unknown>>;
}>;

export function buildDryRunRequest(call: InferenceCall<unknown>): DryRunResult {
  return buildPiRequest(call);
}
