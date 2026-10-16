/** @returns {{files: number, tests: number, passed: number, skipped: number, failed: number, failedFiles: string[], emptyFiles: string[], unhandledErrors: number}} */
export function summarizeTests(files, errors) {
  const summary = {
    files: files.length,
    tests: 0,
    passed: 0,
    skipped: 0,
    failed: 0,
    failedFiles: [],
    emptyFiles: [],
    unhandledErrors: errors.length,
  };
  function count(task) {
    if (task.type === "suite") {
      for (const child of task.tasks ?? []) count(child);
      return;
    }
    summary.tests++;
    const state = task.result?.state ?? task.mode;
    if (state === "pass") summary.passed++;
    else if (state === "skip" || state === "todo") summary.skipped++;
    else summary.failed++;
  }
  for (const file of files) {
    const before = summary.tests;
    count(file);
    if (summary.tests === before) summary.emptyFiles.push(file.name);
    if (file.result?.state === "fail" || file.result?.errors?.length) summary.failedFiles.push(file.name);
  }
  return summary;
}

/** @returns {void} */
export function requirePassingTests(summary) {
  if (!summary.files) throw new Error("Public verification collected no test files.");
  if (summary.emptyFiles.length)
    throw new Error(`Public verification collected zero tests in: ${summary.emptyFiles.join(", ")}.`);
  if (summary.unhandledErrors)
    throw new Error(`Public verification found ${summary.unhandledErrors} unhandled errors.`);
  if (summary.failed || summary.failedFiles.length)
    throw new Error(`Public verification has failed tests or files: ${summary.failedFiles.join(", ")}.`);
}
