import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { createAgentRequestsStore } from "../../src/main/agent-gateway/requests-store";
import { createOperationStore } from "../../src/main/operation-store";
import { createSkillOperationJournal } from "../../src/main/skill-management/journal";

// Fresh readers must preserve the complete persisted previews, effects and receipts.
export async function expectAgentStoresToReload(userDataPath: string): Promise<void> {
  const root = join(userDataPath, "omni");
  const path = join(root, "agent-requests.json");
  const before = await readFile(path, "utf8");
  const expected = JSON.parse(before) as { requests: unknown[] };
  expect(expected.requests.length).toBeGreaterThan(0);
  const reloaded = await createAgentRequestsStore(path).all();
  expect(JSON.parse(JSON.stringify(reloaded))).toEqual(expected.requests);
  expect(await readFile(path, "utf8")).toBe(before);
  expect((await readdir(root)).filter((name) => name.includes(".quarantine."))).toEqual([]);

  const files = await readdir(root);
  if (files.includes("operations.json")) {
    const receipts = JSON.parse(await readFile(join(root, "operations.json"), "utf8")).receipts;
    const loaded = await createOperationStore(join(root, "operations.json")).read();
    expect(loaded.status).toBe("ready");
    if (loaded.status !== "ready") throw new Error(loaded.diagnostic);
    expect(JSON.parse(JSON.stringify(loaded.receipts))).toEqual(receipts);
  }
  if (files.includes("skill-operations")) {
    const directory = join(root, "skill-operations");
    const journals = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
    const expectedRecords = await Promise.all(
      journals.map(async (name) => JSON.parse(await readFile(join(directory, name), "utf8"))),
    );
    const loaded = await createSkillOperationJournal(directory).list();
    expect(loaded.status).toBe("ready");
    if (loaded.status !== "ready") throw new Error(loaded.diagnostic);
    expect(JSON.parse(JSON.stringify(loaded.records))).toEqual(expectedRecords);
  }
}
