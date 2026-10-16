import { describe, expect, it } from "vitest";

import {
  parseAgentJobListResponse,
  parseAgentJobStartRequest,
  parseAgentJobStartResponse,
  parseAgentJobStopRequest,
  parseAgentJobStopResponse,
} from "../../src/shared/agent-jobs-ipc";

describe("agent job IPC", () => {
  it("parses the strict compose start request and response", () => {
    expect(parseAgentJobStartRequest({ job: "compose", projectId: "project-one", grantHandle: "grant-one" })).toEqual({
      job: "compose",
      projectId: "project-one",
      grantHandle: "grant-one",
    });
    expect(parseAgentJobStartResponse({ jobId: "job-one" })).toEqual({ jobId: "job-one" });
  });

  it("rejects unknown fields and malformed job rows", () => {
    expect(() =>
      parseAgentJobStartRequest({ job: "compose", projectId: "p", grantHandle: "g", extra: true }),
    ).toThrow();
    expect(() => parseAgentJobListResponse({ jobs: [{ jobId: "j", status: "running" }] })).toThrow();
  });

  it("parses stop and unavailable responses", () => {
    expect(parseAgentJobStopRequest({ jobId: "job-one" })).toEqual({ jobId: "job-one" });
    expect(parseAgentJobStopResponse({ status: "stopping" })).toEqual({ status: "stopping" });
    expect(parseAgentJobStartResponse({ status: "unavailable", reason: "Add a connection in Settings · AI." })).toEqual(
      {
        status: "unavailable",
        reason: "Add a connection in Settings · AI.",
      },
    );
  });
});
