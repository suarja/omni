import { describe, expect, it } from "vitest";

import {
  parseStackProfile,
  parseStackProfileRequest,
  parseStackProfileResponse,
  STACK_PROFILE_IPC_CHANNELS,
} from "../../src/shared/stack-profile-ipc";

const VALID_PROFILE = {
  tags: [{ id: "next", label: "Next.js", evidence: ["package.json dependency next@16.0.2"] }],
  languages: [{ id: "TypeScript", files: 312 }],
  harnesses: ["claude-code"],
  computedAt: "2026-09-14T12:00:00.000Z",
  treeHash: "a".repeat(64),
};

describe("stack profile IPC channel", () => {
  it("uses one stable channel name", () => {
    expect(STACK_PROFILE_IPC_CHANNELS.get).toBe("omni:projects:stack-profile");
  });
});

describe("parseStackProfileRequest", () => {
  it("accepts a minimal request and trims fields", () => {
    expect(parseStackProfileRequest({ projectId: " project-1 ", grantHandle: "grant-1" })).toEqual({
      projectId: "project-1",
      grantHandle: "grant-1",
    });
  });

  it("carries an explicit refresh flag through", () => {
    expect(parseStackProfileRequest({ projectId: "project-1", grantHandle: "grant-1", refresh: true })).toEqual({
      projectId: "project-1",
      grantHandle: "grant-1",
      refresh: true,
    });
  });

  it("rejects an unexpected field", () => {
    expect(() => parseStackProfileRequest({ projectId: "project-1", grantHandle: "grant-1", extra: true })).toThrow(
      /unexpected field/i,
    );
  });

  it("rejects a malformed project id", () => {
    expect(() => parseStackProfileRequest({ projectId: "../etc", grantHandle: "grant-1" })).toThrow(/malformed/i);
  });

  it("rejects a grant handle that is not opaque", () => {
    expect(() => parseStackProfileRequest({ projectId: "project-1", grantHandle: "../grant" })).toThrow(/opaque/i);
    expect(() => parseStackProfileRequest({ projectId: "project-1", grantHandle: "a/b" })).toThrow(/opaque/i);
  });

  it("rejects a non-boolean refresh flag", () => {
    expect(() => parseStackProfileRequest({ projectId: "project-1", grantHandle: "grant-1", refresh: "true" })).toThrow(
      /boolean/i,
    );
  });
});

describe("parseStackProfileResponse", () => {
  it("accepts a denied response", () => {
    expect(parseStackProfileResponse({ status: "denied" })).toEqual({ status: "denied" });
  });

  it("rejects a denied response with extra fields", () => {
    expect(() => parseStackProfileResponse({ status: "denied", reason: "x" })).toThrow(/unexpected field/i);
  });

  it("accepts an unavailable response with a safe reason", () => {
    expect(
      parseStackProfileResponse({ status: "unavailable", reason: "The project tree could not be observed." }),
    ).toEqual({
      status: "unavailable",
      reason: "The project tree could not be observed.",
    });
  });

  it("rejects an unavailable response whose reason leaks an absolute path", () => {
    expect(() => parseStackProfileResponse({ status: "unavailable", reason: "/Users/example/project" })).toThrow(
      /safe for ipc/i,
    );
  });

  it("accepts a ready response with a valid profile", () => {
    expect(parseStackProfileResponse({ status: "ready", profile: VALID_PROFILE, cached: true })).toEqual({
      status: "ready",
      profile: VALID_PROFILE,
      cached: true,
    });
  });

  it("rejects a ready response missing the cached flag", () => {
    expect(() => parseStackProfileResponse({ status: "ready", profile: VALID_PROFILE })).toThrow(
      /unexpected field|cached/i,
    );
  });

  it("rejects evidence that starts with a slash", () => {
    const profile = { ...VALID_PROFILE, tags: [{ id: "next", label: "Next.js", evidence: ["/etc/passwd"] }] };
    expect(() => parseStackProfileResponse({ status: "ready", profile, cached: false })).toThrow(/safe for ipc/i);
  });

  it("rejects a tag label containing an absolute path fragment", () => {
    const profile = { ...VALID_PROFILE, tags: [{ id: "next", label: "see /etc/passwd", evidence: [] }] };
    expect(() => parseStackProfileResponse({ status: "ready", profile, cached: false })).toThrow(/safe for ipc/i);
  });

  it("rejects a malformed tag id", () => {
    const profile = { ...VALID_PROFILE, tags: [{ id: "Next.js!", label: "Next.js", evidence: [] }] };
    expect(() => parseStackProfileResponse({ status: "ready", profile, cached: false })).toThrow(/malformed/i);
  });

  it("rejects an invalid harness", () => {
    const profile = { ...VALID_PROFILE, harnesses: ["copilot"] };
    expect(() => parseStackProfileResponse({ status: "ready", profile, cached: false })).toThrow(/harness is invalid/i);
  });

  it("rejects duplicate harnesses", () => {
    const profile = { ...VALID_PROFILE, harnesses: ["codex", "codex"] };
    expect(() => parseStackProfileResponse({ status: "ready", profile, cached: false })).toThrow(/unique/i);
  });

  it("rejects a computedAt that is not an ISO timestamp", () => {
    const profile = { ...VALID_PROFILE, computedAt: "yesterday" };
    expect(() => parseStackProfileResponse({ status: "ready", profile, cached: false })).toThrow(/iso 8601/i);
  });

  it("rejects a treeHash that is not a lowercase sha256 hex digest", () => {
    const profile = { ...VALID_PROFILE, treeHash: "ABCDEF" };
    expect(() => parseStackProfileResponse({ status: "ready", profile, cached: false })).toThrow(/sha-256/i);
  });

  it("rejects a negative language file count", () => {
    const profile = { ...VALID_PROFILE, languages: [{ id: "TypeScript", files: -1 }] };
    expect(() => parseStackProfileResponse({ status: "ready", profile, cached: false })).toThrow(/non-negative/i);
  });

  it("rejects an unknown response status", () => {
    expect(() => parseStackProfileResponse({ status: "pending" })).toThrow(/status is invalid/i);
  });
});

describe("parseStackProfile (shared with the cache store)", () => {
  it("round-trips a valid profile", () => {
    expect(parseStackProfile(VALID_PROFILE)).toEqual(VALID_PROFILE);
  });

  it("rejects a profile with an unexpected field", () => {
    expect(() => parseStackProfile({ ...VALID_PROFILE, extra: 1 })).toThrow(/unexpected field/i);
  });
});
