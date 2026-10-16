import { expect, it } from "vitest";
import { summarizeTests, requirePassingTests } from "./test-results.mjs";

const task = (state = "pass") => ({ type: "test", result: { state } });
const file = (tasks, state = "pass") => ({ name: "example.test.ts", type: "suite", tasks, result: { state } });
it("counts nested tests, skipped tests, files and unhandled errors separately", () => {
  expect(summarizeTests([file([task(), { type: "suite", tasks: [task("skip"), task("todo")] }])], [])).toEqual({
    files: 1,
    tests: 3,
    passed: 1,
    skipped: 2,
    failed: 0,
    failedFiles: [],
    emptyFiles: [],
    unhandledErrors: 0,
  });
});
it.each([
  [[], [], /no test files/i],
  [[file([])], [], /zero tests.*example.test.ts/i],
  [[file([task("fail")], "fail")], [], /failed/i],
  [[file([task()])], [new Error("late rejection")], /unhandled/i],
])("refuses an incomplete or unsafe test run", (files, errors, message) => {
  expect(() => requirePassingTests(summarizeTests(files, errors))).toThrow(message);
});
it("accepts collected skipped tests while preserving their count", () => {
  const summary = summarizeTests([file([task(), task("skip")])], []);
  expect(() => requirePassingTests(summary)).not.toThrow();
  expect(summary.skipped).toBe(1);
});
