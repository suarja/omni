import { writeFile } from "node:fs/promises";
import { summarizeTests } from "./test-results.mjs";

export default class PublicTestReporter {
  /** @returns {Promise<void>} */
  async onFinished(files = [], errors = []) {
    if (!process.env.OMNI_PUBLIC_TEST_REPORT) throw new Error("Public test reporter requires OMNI_PUBLIC_TEST_REPORT.");
    await writeFile(process.env.OMNI_PUBLIC_TEST_REPORT, JSON.stringify(summarizeTests(files, errors)) + "\n");
  }
}
