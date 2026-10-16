import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

describe("release workflow safety", () => {
  it.each(["ci", "release"])("parses %s with immutable actions and mandatory validation", async (name) => {
    const source = await readFile(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8");
    const document = parseDocument(source, { uniqueKeys: true });
    expect(document.errors).toEqual([]);
    const workflow = document.toJS();
    expect(workflow.on).toBeDefined();
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps) if (step.uses) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
    }
    for (const check of ["typecheck", "lint", "test", "check:public"]) expect(source).toContain(`pnpm ${check}`);
  });
  it("keeps public export verification in the private repository only", async () => {
    const source = await readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
    const job = parseDocument(source).toJS().jobs["verify-public"];
    expect(job.if).toContain("github.event.repository.private");
    expect(job.steps.some((step) => step.run?.includes("pnpm verify:public"))).toBe(true);
  });
  it("cleans temporary credentials unconditionally and only creates draft releases", async () => {
    const source = await readFile(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
    const workflow = parseDocument(source).toJS();
    expect(workflow.on.push.tags).toEqual(["v*"]);
    const steps = workflow.jobs.release.steps;
    const cleanup = steps.find((step) => step.name === "Delete temporary signing material");
    expect(cleanup.if).toBe("always()");
    expect(cleanup.run).toContain("delete-keychain");
    expect(cleanup.run).toContain("AuthKey.p8");
    expect(source).toContain("--draft");
    expect(source).toContain("--prerelease");
    expect(source).not.toContain("set -x");
    for (const key of [
      "MACOS_CERT_P12_BASE64",
      "MACOS_CERT_PASSWORD",
      "ASC_KEY_P8_BASE64",
      "ASC_KEY_ID",
      "ASC_ISSUER_ID",
    ])
      expect(source).toContain(`secrets.${key}`);
  });
});
