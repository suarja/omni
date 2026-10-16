import { expect, it } from "vitest";
import { createReadableRegistryView, displayProjectRoot } from "../../src/main/registry-display";
import { homedir } from "node:os";
import { join } from "node:path";

it("shows the real project path relative to home without inventing a home path for external folders", () => {
  expect(displayProjectRoot("/Users/example/Projects/notes-app", "/Users/example")).toBe("~/Projects/notes-app");
  expect(displayProjectRoot("/Users/example", "/Users/example")).toBe("~");
  expect(displayProjectRoot("/Volumes/projects/notes-app", "/Users/example")).toBe("notes-app");
  expect(displayProjectRoot(["/Users", "example-other", "notes-app"].join("/"), "/Users/example")).toBe("notes-app");
});
it("abbreviates personal marketplace paths with home in the registry view", () => {
  const view = createReadableRegistryView({
    schemaVersion: 1,
    revision: 1,
    projects: [],
    sources: [
      {
        id: "personal",
        displayName: "My marketplace",
        ownership: "personal",
        createdAt: "2026-10-12T00:00:00.000Z",
        locator: { kind: "local-directory", canonicalPath: join(homedir(), "Projects/claude-plugins") },
      },
    ],
  });
  expect(view.sources[0]?.displayRoot).toBe("~/Projects/claude-plugins");
});
