// The only provider that exists in this brief (Brief 35a): refuses every call with an honest
// "no intelligence provider is enabled" — never a fabricated suggestion, never a network call.
// Every command's deterministic result is unchanged when this is the active provider.

import type { InferenceProvider } from "../provider";

const UNAVAILABLE_REASON = "No intelligence provider is enabled.";

export function createNoneProvider(): InferenceProvider {
  return {
    id: "none",
    scope: "local",
    capabilities: { maxInputChars: 0, structuredOutput: false, streaming: false },
    complete: async () => ({ status: "unavailable", reason: UNAVAILABLE_REASON }),
  };
}
