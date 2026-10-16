import { describe, expect, it } from "vitest";

import { createActivitySnapshotReader } from "../../src/main/activity-snapshot";
import { createPlatformStub } from "./platform-stub";

describe("activity snapshot reader", () => {
  it("coalesces only overlapping builds and does not cache completed evidence", async () => {
    let releaseList!: () => void;
    let listCalls = 0;
    const waitForList = new Promise<void>((resolve) => (releaseList = resolve));
    const platform = createPlatformStub({
      processes: [],
    });
    const reader = createActivitySnapshotReader({
      userDataPath: "/fixture/profile",
      omniPid: 999,
      platform: {
        ...platform,
        processes: {
          ...platform.processes,
          list: async () => {
            listCalls += 1;
            await waitForList;
            return [];
          },
        },
      },
      projectRoots: async () => [],
      evidenceIo: {
        homeDir: "/fixture/home",
        now: Date.now,
        readText: async () => null,
        readDir: async () => [],
        stat: async () => null,
      },
    });

    const first = reader();
    const second = reader();
    expect(second).toBe(first);
    expect(listCalls).toBe(1);
    releaseList();
    await Promise.all([first, second]);

    await reader();
    expect(listCalls).toBe(2);
  });
});
