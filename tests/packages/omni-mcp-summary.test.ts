import { describe, expect, it } from "vitest";

import {
  summarizeApply,
  summarizePlan,
  summarizeReceipt,
  summarizeSkillPreview,
  summarizeSkillResult,
} from "../../packages/omni-mcp/src/summary";

describe("MCP plan summaries", () => {
  it("keeps partial assignment receipts and failure diagnostics visible", () => {
    const detail = "Project B failed. Earlier project applies remain recorded: A (receipt receipt-a).";
    expect(summarizeApply({ status: "failed", message: detail })).toContain(detail);
    expect(
      summarizeApply({
        status: "failed",
        receipts: [
          { actions: [{ kind: "write-file" }], provenance: { approval: "conversation" } },
          { actions: [], provenance: { approval: "conversation" } },
        ],
        message: detail,
      }),
    ).toMatch(/2 receipts recorded.*Project B failed/s);
    expect(
      summarizeApply({
        status: "applied",
        receipts: [{ actions: [{ kind: "write-file" }] }, { actions: [{ kind: "write-file" }] }],
      }),
    ).toMatch(/2 receipts applied/);
    expect(summarizeApply({ status: "failed", receipt: { diagnostic: "Source changed; preview again." } })).toContain(
      "Source changed; preview again.",
    );
  });

  it("counts skill files and directories separately and describes conversation approval", () => {
    expect(
      summarizePlan(
        {
          kind: "write-skill",
          actions: [
            { kind: "create-directory", relativePath: "skills/example" },
            { kind: "create-directory", relativePath: "skills/example" },
            { kind: "write-file", relativePath: "skills/example/SKILL.md" },
          ],
        },
        "conversation",
      ),
    ).toContain("1 file to write, 1 directory to create");
    expect(summarizePlan({ kind: "write-skill", actions: [] }, "conversation")).toContain(
      "No file or directory changes",
    );
    expect(summarizePlan({ kind: "write-skill", actions: [] }, "conversation")).toContain(
      "existing clear approval for this plan permits omni_apply",
    );
  });

  it("describes assignment changes and conflicts from project plans", () => {
    const summary = summarizePlan({
      kind: "assign",
      plans: [
        {
          projectId: "project-1",
          actions: [
            { state: "add", relativePath: "skills/example" },
            { state: "conflict", relativePath: "skills/example" },
          ],
        },
      ],
    });
    expect(summary).toContain("2 binding changes across 1 project");
    expect(summary).toContain("1 conflict to review");
    expect(summary).not.toContain("0 files");
  });

  it("summarizes receipt file, directory, and approval provenance accurately", () => {
    expect(
      summarizeReceipt({
        actions: [
          { kind: "write-file" },
          { kind: "create-directory", relativePath: "skills/example" },
          { kind: "create-directory", relativePath: "skills/example" },
        ],
        provenance: { approval: "conversation" },
      }),
    ).toBe("Approved in conversation: 1 file written, 1 directory created.");
  });

  it("summarizes source-only previews without implying assignment", () => {
    const summary = summarizeSkillPreview(
      {
        scope: { sourceId: "personal", targets: [] },
        steps: [{ plan: { kind: "write-skill" }, files: [{ change: "add" }] }],
      },
      "conversation",
    );
    expect(summary).toContain("Source-only change; no project assignment occurred");
    expect(summary).toContain("1 file to add");
  });

  it("summarizes failed and partial managed targets with a safe recovery instruction", () => {
    expect(
      summarizeSkillResult({
        intentId: "intent",
        status: "recovery-required",
        targets: [{ projectId: "project-a", harnessId: "codex", artifactPath: "skills/demo", status: "failed" }],
        issues: [{ message: "The write could not be verified." }],
        receiptIds: ["receipt-a"],
      }),
    ).toMatch(/Recovery is required.*before retrying.*project-a.*receipt/s);
    expect(
      summarizeSkillResult({
        intentId: "intent",
        status: "partial",
        targets: [
          { projectId: "project-a", harnessId: "codex", status: "applied" },
          {
            projectId: "project-b",
            harnessId: "claude-code",
            status: "failed",
            issue: { message: "Target unavailable." },
          },
        ],
        receiptIds: ["receipt-a"],
      }),
    ).toMatch(/partially completed.*project-b.*Target unavailable/s);
  });
});

it("explains Omni approval and pending retry with the reason", () => {
  const reason = { code: "deletes-files", count: 2 } as const;
  expect(summarizePlan({ actions: [] }, "omni", reason)).toContain("Approval happens in Omni: Deletes 2 files.");
  expect(summarizeSkillPreview({}, "omni", reason)).toContain("call omni_apply");
  expect(summarizeApply({ status: "pending", requestId: "request", approvalReason: reason })).toMatch(
    /Deletes 2 files.*same requestId.*does not expire.*omni_receipt/s,
  );
});
