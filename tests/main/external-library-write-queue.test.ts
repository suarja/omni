import { expect, it } from "vitest";
import { serializeExternalProjectWrites } from "../../src/main/external-library/project-write-queue";

it("serializes agents sharing one project lock while allowing another project to proceed", async () => {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const calls: string[] = [];
  const first = serializeExternalProjectWrites("profile", ["project-a"], async () => {
    calls.push("codex");
    started();
    await gate;
    calls.push("done");
  });
  await entered;
  const second = serializeExternalProjectWrites("profile", ["project-a"], async () => {
    calls.push("claude");
  });
  await serializeExternalProjectWrites("profile", ["project-b"], async () => {
    calls.push("other-project");
  });
  expect(calls).toEqual(["codex", "other-project"]);
  release();
  await Promise.all([first, second]);
  expect(calls).toEqual(["codex", "other-project", "done", "claude"]);
});
it("releases a shared project after a failed writer", async () => {
  await expect(
    serializeExternalProjectWrites("profile", ["project"], async () => {
      throw new Error("Failed writer");
    }),
  ).rejects.toThrow("Failed writer");
  await expect(serializeExternalProjectWrites("profile", ["project"], async () => "next")).resolves.toBe("next");
});
