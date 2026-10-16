import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import {
  collectLocalGitEvidence,
  createGitCommandRunner,
  type GitCommandRequest,
  type GitCommandResult,
  type GitPathResolver,
  type GitProcessOptions,
} from "../../src/adapters/inventory/local-git";

const identityPathResolver: GitPathResolver = async (path) => path;

function collectSyntheticGitEvidence(
  request: Parameters<typeof collectLocalGitEvidence>[0],
  runner: Parameters<typeof collectLocalGitEvidence>[1],
) {
  return collectLocalGitEvidence(request, runner, identityPathResolver);
}

async function withEnvironmentCanaries<T>(callback: () => Promise<T>): Promise<T> {
  const keys = ["API_KEY", "ACCESS_TOKEN", "GIT_CREDENTIAL_HELPER", "AWS_SECRET_ACCESS_KEY"];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) process.env[key] = `canary-${key}`;
  try {
    return await callback();
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function successfulGitRunner(
  responses: Readonly<Record<string, GitCommandResult | Error>>,
  calls: GitCommandRequest[],
) {
  return async (request: GitCommandRequest): Promise<GitCommandResult> => {
    calls.push(request);
    const commandStart = request.args.findIndex((argument) => argument === "rev-parse" || argument === "status");
    const command = request.args.slice(commandStart).join(" ");
    const response = responses[command];
    if (response instanceof Error) throw response;
    if (!response) throw new Error(`Unexpected test command: ${command}`);
    return response;
  };
}

describe("local Git inventory adapter", () => {
  it.each(["main", "feature/project-view", "HEAD", "bad\nbranch", "/private/project"])(
    "observes a safe branch independently from commit and dirty status: %s",
    async (branch) => {
      const evidence = await collectSyntheticGitEvidence(
        { approvedRoot: "/private/project" },
        successfulGitRunner(
          {
            "rev-parse --show-toplevel": { stdout: "/private/project\n" },
            "rev-parse --verify HEAD": { stdout: "a".repeat(40) },
            "status --porcelain=v1 -uno": { stdout: " M tracked.txt\n" },
            "rev-parse --abbrev-ref HEAD": { stdout: branch },
          },
          [],
        ),
      );
      expect(evidence.scopes[0]).toMatchObject({ head: "a".repeat(40), dirty: true });
      if (branch === "main" || branch === "feature/project-view") expect(evidence.scopes[0].branch).toBe(branch);
      else expect(evidence.scopes[0]).not.toHaveProperty("branch");
    },
  );
  it("uses only the allowlisted read commands with exact safe arguments and environment", async () => {
    const calls: GitCommandRequest[] = [];
    const runner = successfulGitRunner(
      {
        "rev-parse --show-toplevel": { stdout: "/private/project\n" },
        "rev-parse --verify HEAD": { stdout: "0123456789abcdef\n" },
        "status --porcelain=v1 -uno": { stdout: "" },
        "rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
      },
      calls,
    );

    await withEnvironmentCanaries(() =>
      collectSyntheticGitEvidence(
        {
          approvedRoot: "/private/project",
          scopes: [{ path: "/private/project", relativeRoot: "project" }],
          timeoutMs: 3210,
        },
        runner,
      ),
    );

    expect(calls.map(({ args }) => args)).toEqual([
      [
        "--no-optional-locks",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "rev-parse",
        "--show-toplevel",
      ],
      [
        "--no-optional-locks",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "rev-parse",
        "--verify",
        "HEAD",
      ],
      [
        "--no-optional-locks",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "status",
        "--porcelain=v1",
        "-uno",
      ],
      [
        "--no-optional-locks",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ],
    ]);
    for (const call of calls) {
      expect(call.cwd).toBe("/private/project");
      expect(call.timeoutMs).toBe(3210);
      expect(call.env).toMatchObject({
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      });
      expect(call.env).not.toHaveProperty("API_KEY");
      expect(call.env).not.toHaveProperty("ACCESS_TOKEN");
      expect(call.env).not.toHaveProperty("GIT_CREDENTIAL_HELPER");
      expect(call.env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
      expect(call.args).not.toEqual(expect.arrayContaining(["fetch", "diff", "credential"]));
    }
  });

  it.each([
    ["dirty", " M tracked.txt\n", true],
    ["clean", "", false],
  ])("parses %s status and HEAD/root evidence", async (_label, status, dirty) => {
    const calls: GitCommandRequest[] = [];
    const runner = successfulGitRunner(
      {
        "rev-parse --show-toplevel": { stdout: "/private/project\n" },
        "rev-parse --verify HEAD": { stdout: "abcdef1234567890\n" },
        "status --porcelain=v1 -uno": { stdout: status },
      },
      calls,
    );

    const evidence = await collectSyntheticGitEvidence(
      {
        approvedRoot: "/private/project",
        scopes: [{ path: "/private/project", relativeRoot: "project" }],
      },
      runner,
    );

    expect(evidence).toEqual({
      scopes: [{ id: "git-project", relativeRoot: "project", head: "abcdef1234567890", dirty }],
      diagnostics: [],
    });
  });

  it("keeps a usable scope when HEAD observation fails and reports a redacted diagnostic", async () => {
    const calls: GitCommandRequest[] = [];
    const runner = successfulGitRunner(
      {
        "rev-parse --show-toplevel": { stdout: "/private/project\n" },
        "rev-parse --verify HEAD": new Error("fatal: /private/project has no HEAD"),
        "status --porcelain=v1 -uno": { stdout: "" },
      },
      calls,
    );

    const evidence = await collectSyntheticGitEvidence(
      {
        approvedRoot: "/private/project",
        scopes: [{ path: "/private/project", relativeRoot: "project" }],
      },
      runner,
    );

    expect(evidence.scopes).toEqual([{ id: "git-project", relativeRoot: "project", dirty: false }]);
    expect(evidence.diagnostics).toEqual([expect.objectContaining({ code: "git-unavailable", location: "project" })]);
    expect(JSON.stringify(evidence)).not.toContain("/private/project");
  });

  it("supports clean, dirty, nested-worktree, and explicit non-Git scopes independently", async () => {
    const calls: GitCommandRequest[] = [];
    const runner = async (request: GitCommandRequest): Promise<GitCommandResult> => {
      calls.push(request);
      const commandStart = request.args.findIndex((argument) => argument === "rev-parse" || argument === "status");
      const command = request.args.slice(commandStart).join(" ");
      if (request.cwd === "/private/project/non-git") throw new Error("not a repository");
      if (command === "rev-parse --show-toplevel") {
        return { stdout: `${request.cwd}\n` };
      }
      if (command === "rev-parse --verify HEAD") {
        return { stdout: "1234567890abcdef\n" };
      }
      return { stdout: request.cwd === "/private/project/packages/tool" ? " M tool.ts\n" : "" };
    };

    const evidence = await collectSyntheticGitEvidence(
      {
        approvedRoot: "/private/project",
        scopes: [
          { path: "/private/project/non-git", relativeRoot: "non-git" },
          { path: "/private/project/packages/tool", relativeRoot: "project/packages/tool" },
          { path: "/private/project", relativeRoot: "project" },
        ],
      },
      runner,
    );

    expect(evidence.scopes).toEqual([
      { id: "git-non-git", relativeRoot: "non-git", dirty: "unknown" },
      { id: "git-project", relativeRoot: "project", head: "1234567890abcdef", dirty: false },
      {
        id: "git-project/packages/tool",
        relativeRoot: "project/packages/tool",
        head: "1234567890abcdef",
        dirty: true,
      },
    ]);
    expect(evidence.diagnostics).toEqual([expect.objectContaining({ code: "git-unavailable", location: "non-git" })]);
    expect(calls.map((call) => call.cwd)).toContain("/private/project/non-git");
  });

  it("turns timeout and command failures into safe diagnostics without invoking writes or network commands", async () => {
    const calls: GitCommandRequest[] = [];
    const timeout = Object.assign(new Error("timeout /private/project"), { code: "ETIMEDOUT" });
    const runner = successfulGitRunner(
      {
        "rev-parse --show-toplevel": timeout,
      },
      calls,
    );

    const evidence = await collectSyntheticGitEvidence(
      {
        approvedRoot: "/private/project",
        scopes: [{ path: "/private/project", relativeRoot: "project" }],
      },
      runner,
    );

    expect(evidence.scopes).toEqual([]);
    expect(evidence.diagnostics).toEqual([expect.objectContaining({ code: "git-unavailable", location: "project" })]);
    expect(JSON.stringify(evidence)).not.toContain("/private/project");
    expect(calls.flatMap(({ args }) => args)).not.toEqual(expect.arrayContaining(["fetch", "diff", "credential"]));
  });

  it("keeps explicit non-Git roots as redacted unknown scopes and allocates collision-safe ids", async () => {
    const runner = async (): Promise<GitCommandResult> => {
      throw new Error("not a repository at /private/non-git");
    };

    const evidence = await collectSyntheticGitEvidence(
      {
        approvedRoot: "/private/project",
        scopes: [
          { path: "/private/non-git-a", relativeRoot: "non-git" },
          { path: "/private/non-git-b", relativeRoot: "non-git" },
        ],
      },
      runner,
    );

    expect(evidence.scopes).toEqual([
      { id: "git-non-git", relativeRoot: "non-git", dirty: "unknown" },
      { id: "git-non-git-2", relativeRoot: "non-git", dirty: "unknown" },
    ]);
    expect(evidence.diagnostics).toHaveLength(2);
    expect(evidence.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "git-unavailable", location: "non-git" })]),
    );
    expect(JSON.stringify(evidence)).not.toContain("/private/");
  });

  it("makes the production execFile timeout contract testable through an injected executor", async () => {
    const calls: Array<{
      file: string;
      args: readonly string[];
      options: GitProcessOptions;
    }> = [];
    const executor = async (
      file: string,
      args: readonly string[],
      options: GitProcessOptions,
    ): Promise<GitCommandResult> => {
      calls.push({ file, args, options });
      await new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(Object.assign(new Error("executor terminated the hung command"), { code: "ETIMEDOUT" })),
          options.timeout,
        );
      });
      throw new Error("unreachable");
    };

    const evidence = await collectSyntheticGitEvidence(
      {
        approvedRoot: "/private/project",
        scopes: [{ path: "/private/project", relativeRoot: "project" }],
        timeoutMs: 7,
      },
      createGitCommandRunner(executor),
    );

    expect(evidence.scopes).toEqual([]);
    expect(evidence.diagnostics).toEqual([expect.objectContaining({ code: "git-unavailable", location: "project" })]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      file: "git",
      options: {
        shell: false,
        timeout: 7,
      },
    });
    expect(calls[0].args).toEqual([
      "--no-optional-locks",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "rev-parse",
      "--show-toplevel",
    ]);
  });

  it("rejects outside and symlink-escaping scope paths before invoking Git", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "omni-git-boundary-"));
    const approvedRoot = join(temporaryRoot, "approved");
    const outsideRoot = join(temporaryRoot, "outside");
    const escapingScope = join(approvedRoot, "escape");
    await mkdir(approvedRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await symlink(outsideRoot, escapingScope);
    const calls: GitCommandRequest[] = [];

    try {
      const evidence = await collectLocalGitEvidence(
        {
          approvedRoot,
          scopes: [
            { path: outsideRoot, relativeRoot: "outside" },
            { path: escapingScope, relativeRoot: "escape" },
          ],
        },
        async (request) => {
          calls.push(request);
          throw new Error("Git must not be called for a rejected scope.");
        },
      );

      expect(calls).toEqual([]);
      expect(evidence.scopes).toEqual([
        { id: "git-escape", relativeRoot: "escape", dirty: "unknown" },
        { id: "git-outside", relativeRoot: "outside", dirty: "unknown" },
      ]);
      expect(evidence.diagnostics).toHaveLength(2);
      expect(JSON.stringify(evidence)).not.toContain(temporaryRoot);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("rejects a Git root reported outside the approved root after root evidence", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "omni-git-root-boundary-"));
    const approvedRoot = join(temporaryRoot, "approved");
    const outsideRoot = join(temporaryRoot, "outside-repository");
    await mkdir(approvedRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    const calls: GitCommandRequest[] = [];

    try {
      const evidence = await collectLocalGitEvidence(
        {
          approvedRoot,
          scopes: [{ path: approvedRoot, relativeRoot: "project" }],
        },
        async (request) => {
          calls.push(request);
          const commandStart = request.args.findIndex((argument) => argument === "rev-parse" || argument === "status");
          const command = request.args.slice(commandStart).join(" ");
          if (command === "rev-parse --show-toplevel") return { stdout: `${outsideRoot}\n` };
          if (command === "rev-parse --verify HEAD") return { stdout: "abcdef1234567890\n" };
          return { stdout: "" };
        },
      );

      expect(calls).toHaveLength(1);
      expect(evidence.scopes).toEqual([{ id: "git-project", relativeRoot: "project", dirty: "unknown" }]);
      expect(evidence.diagnostics).toEqual([expect.objectContaining({ code: "git-unavailable", location: "project" })]);
      expect(JSON.stringify(evidence)).not.toContain(outsideRoot);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("redacts invalid relative roots, UNC paths, drive paths, and paths with spaces without erasing other scopes", async () => {
    const evidence = await collectSyntheticGitEvidence(
      {
        approvedRoot: "/private/project",
        scopes: [
          { path: "/private/project", relativeRoot: "../outside" },
          { path: "/private/project", relativeRoot: "." },
          { path: "/private/project", relativeRoot: "/Users/example/My Project" },
          { path: "/private/project", relativeRoot: "C:\\Users\\example\\My Project" },
          { path: "/private/project", relativeRoot: "\\\\server\\share\\My Project" },
          { path: "/private/project", relativeRoot: "safe/project" },
        ],
      },
      successfulGitRunner(
        {
          "rev-parse --show-toplevel": { stdout: "/private/project\n" },
          "rev-parse --verify HEAD": { stdout: "abcdef1234567890\n" },
          "status --porcelain=v1 -uno": { stdout: "" },
        },
        [],
      ),
    );

    expect(evidence.scopes).toEqual([
      { id: "git-safe/project", relativeRoot: "safe/project", head: "abcdef1234567890", dirty: false },
      { id: "git-scope", relativeRoot: "scope", head: "abcdef1234567890", dirty: false },
      { id: "git-scope-2", relativeRoot: "scope", head: "abcdef1234567890", dirty: false },
      { id: "git-scope-3", relativeRoot: "scope", head: "abcdef1234567890", dirty: false },
      { id: "git-scope-4", relativeRoot: "scope", head: "abcdef1234567890", dirty: false },
      { id: "git-scope-5", relativeRoot: "scope", head: "abcdef1234567890", dirty: false },
    ]);
    expect(evidence.diagnostics).toHaveLength(5);
    expect(evidence.diagnostics.every((diagnostic) => diagnostic.location === "scope")).toBe(true);
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("/Users/example");
    expect(serialized).not.toContain("My Project");
    expect(serialized).not.toContain("server");
    expect(serialized).not.toContain("share");
  });
});
