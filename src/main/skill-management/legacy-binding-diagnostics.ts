import type { Binding } from "../../domain/assignment-plan";
import { legacyBindingLocation } from "../../domain/skill-reconciliation/legacy-binding-bridge";
import type {
  LegacyBindingBridgeDiagnostic,
  LegacyBridgeIssue,
  LegacyBridgeSkippedLocation,
} from "../../shared/legacy-binding-bridge-diagnostic";

export function bridgeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Legacy Binding bridge could not inspect this location safely.";
}

export class LegacyBridgeDiagnostics {
  linkedCopies = 0;
  alreadyManagedLocations = 0;
  duplicateBindings = 0;
  private readonly skipped: LegacyBridgeSkippedLocation[] = [];
  private readonly issues: LegacyBridgeIssue[] = [];

  skip(bindings: readonly Binding[], code: string, message: string): void {
    const location = bindings[0] && legacyBindingLocation(bindings[0]);
    const existing =
      location &&
      this.skipped.findIndex(
        (entry) => entry.code === code && JSON.stringify(entry.location) === JSON.stringify(location),
      );
    const bindingIds = bindings.map(({ bindingId }) => bindingId);
    if (typeof existing === "number" && existing >= 0) {
      const previous = this.skipped[existing]!;
      this.skipped[existing] = { ...previous, bindingIds: [...new Set([...previous.bindingIds, ...bindingIds])] };
    } else this.skipped.push({ ...(location ? { location } : {}), bindingIds, code, message });
  }

  issue(code: string, message: string): void {
    this.issues.push({ code, message });
  }

  snapshot(now: () => number): LegacyBindingBridgeDiagnostic {
    return {
      completedAt: new Date(now()).toISOString(),
      linkedCopies: this.linkedCopies,
      alreadyManagedLocations: this.alreadyManagedLocations,
      duplicateBindings: this.duplicateBindings,
      skippedLocations: structuredClone(this.skipped),
      issues: structuredClone(this.issues),
    };
  }
}
