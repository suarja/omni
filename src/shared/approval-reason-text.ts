import type { ApprovalReason } from "./agents-ipc";

// English reason shown to agents and in the system notification; the renderer uses its locales.
export function describeApprovalReason(reason?: ApprovalReason): string {
  switch (reason?.code) {
    case "public-publication":
      return "Publishing public content always requires approval in Omni";
    case "deletes-files":
      return `Deletes ${reason.count} ${reason.count === 1 ? "file" : "files"}`;
    case "not-owned-source":
      return "Marketplace you don't own";
    case "registry-unavailable":
      return "Omni could not confirm who owns this marketplace";
    case "asked-in-omni":
      return "The agent asked for approval in Omni";
    case "conflict":
      return "Conflict to resolve";
    case "projects-setting":
      return "Your settings ask for approval of project changes";
    case "marketplace-setting":
      return "Your settings ask for approval of marketplace changes";
    default:
      return "This request requires approval in Omni";
  }
}
