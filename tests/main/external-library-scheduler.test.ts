import { afterEach, describe, expect, it, vi } from "vitest";
import { createExternalLibraryScheduler } from "../../src/main/external-library/scheduler";
afterEach(() => vi.useRealTimers());
describe("external library scheduling", () => {
  it("runs once at launch, every 24 hours, on demand, and clears its timer on quit", async () => {
    vi.useFakeTimers();
    const check = vi.fn(async () => ({ result: "success" }) as never);
    const scheduler = createExternalLibraryScheduler({ check });
    const launch = scheduler.start();
    expect(scheduler.start()).toBe(launch);
    await launch;
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(check).toHaveBeenCalledTimes(2);
    await scheduler.checkNow();
    expect(check).toHaveBeenCalledTimes(3);
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(48 * 60 * 60 * 1000);
    expect(check).toHaveBeenCalledTimes(3);
  });
  it("serializes simultaneous passes and continues after a failed pass", async () => {
    vi.useFakeTimers();
    let release: () => void = () => undefined;
    const check = vi.fn(
      () =>
        new Promise<never>((resolve) => {
          release = () => resolve({ result: "partial" } as never);
        }),
    );
    const scheduler = createExternalLibraryScheduler({ check });
    const launch = scheduler.start(),
      requested = scheduler.checkNow();
    expect(check).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([launch, requested]);
    check.mockImplementation(async () => {
      throw new Error("Unavailable source");
    });
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(check).toHaveBeenCalledTimes(2);
    check.mockImplementation(async () => ({ result: "success" }) as never);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(check).toHaveBeenCalledTimes(3);
    scheduler.stop();
  });
});
