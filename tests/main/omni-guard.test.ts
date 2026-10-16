import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { decide, DENY_REASON } from "../../resources/guard/omni-guard.mjs";

// /private/tmp, not /tmp: on macOS /tmp is itself a symlink to /private/tmp, and canonicalize()
// (item 5) would otherwise resolve every target built from this constant one level further than
// a root configured with the same literal string, breaking every test below that is not itself
// about that resolution. The dedicated symlink-resolution test further down uses /tmp on purpose.
const CWD = "/private/tmp/omni-guard-project";

function edit(filePath: string, cwd = CWD) {
  return { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: filePath }, cwd };
}
function write(filePath: string, cwd = CWD) {
  return { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: filePath }, cwd };
}
function bash(command: string, cwd = CWD) {
  return { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd };
}
function applyPatch(command: string, cwd = CWD) {
  return { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command }, cwd };
}

describe("omni-guard decide()", () => {
  it("denies every managed static pattern", () => {
    const paths = [
      `${CWD}/.claude/skills/a/SKILL.md`,
      `${CWD}/.agents/skills/a/SKILL.md`,
      join(homedir(), ".claude/skills/a/SKILL.md"),
      join(homedir(), ".codex/skills/a/SKILL.md"),
      `${CWD}/.claude-plugin/plugin.json`,
      `${CWD}/.codex-plugin/plugin.json`,
      `${CWD}/packages/x/omni.plugin.json`,
      `${CWD}/omni.marketplace.json`,
      `${CWD}/.agents/plugins/marketplace.json`,
    ];
    for (const path of paths) {
      expect(decide(edit(path)), path).toEqual({ decision: "deny", reason: DENY_REASON });
    }
  });

  it("leaves CLAUDE.md, AGENTS.md and .mcp.json editable", () => {
    for (const name of ["CLAUDE.md", "AGENTS.md", ".mcp.json"]) {
      expect(decide(edit(`${CWD}/${name}`)), name).toEqual({ decision: "allow" });
    }
  });

  it("resolves a relative file_path against the hook's cwd", () => {
    expect(decide(edit(".claude/skills/a/SKILL.md", CWD))).toEqual({ decision: "deny", reason: DENY_REASON });
    expect(decide(edit("notes/plan.md", CWD))).toEqual({ decision: "allow" });
  });

  it("expands a ~ path against the real home directory", () => {
    expect(decide(edit("~/.claude/skills/a/SKILL.md"))).toEqual({ decision: "deny", reason: DENY_REASON });
    expect(decide(edit("~/notes.md"))).toEqual({ decision: "allow" });
  });

  it("denies anything under a personal marketplace root from guard.json", () => {
    const config = { marketplaceRoots: ["/Users/example/omni-marketplace"] };
    expect(decide(edit("/Users/example/omni-marketplace/skills/x/SKILL.md"), config)).toEqual({
      decision: "deny",
      reason: DENY_REASON,
    });
    expect(decide(edit("/Users/example/other-folder/x.md"), config)).toEqual({ decision: "allow" });
  });

  it("denies apply_patch when any named file is managed", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: notes/plan.md",
      `*** Update File: ${CWD}/.claude/skills/a/SKILL.md`,
      "*** End Patch",
    ].join("\n");
    expect(decide(applyPatch(patch))).toEqual({ decision: "deny", reason: DENY_REASON });
  });

  it("allows apply_patch when every named file is unmanaged", () => {
    const patch = ["*** Begin Patch", "*** Add File: notes/plan.md", "*** End Patch"].join("\n");
    expect(decide(applyPatch(patch))).toEqual({ decision: "allow" });
  });

  it("denies a shell write into a managed path and allows a shell read", () => {
    const target = `${CWD}/.claude/skills/a/SKILL.md`;
    for (const command of [
      `echo hi > ${target}`,
      `echo hi >> ${target}`,
      `sed -i 's/a/b/' ${target}`,
      `perl -i -pe 's/a/b/' ${target}`,
      `rm ${target}`,
      `mv ${target} /tmp/out.md`,
      `mv /tmp/in.md ${target}`,
      `cp /tmp/in.md ${target}`,
      `rsync /tmp/in.md ${target}`,
      `install /tmp/in.md ${target}`,
      `touch ${target}`,
      `mkdir -p ${target}`,
      `ln -s /tmp/in.md ${target}`,
      `chmod 644 ${target}`,
      `truncate -s 0 ${target}`,
      `git checkout -- ${target}`,
      `git restore ${target}`,
      `tee ${target}`,
    ]) {
      expect(decide(bash(command)), command).toEqual({ decision: "deny", reason: DENY_REASON });
    }
    for (const command of [
      `cat ${target}`,
      `sed -n '1,5p' ${target}`,
      `rg foo ${target}`,
      `grep foo ${target}`,
      `ls ${target}`,
      `head ${target}`,
      `git diff ${target}`,
    ]) {
      expect(decide(bash(command)), command).toEqual({ decision: "allow" });
    }
  });

  it("does not flag cp/rsync/install when the managed path is only the source", () => {
    const source = `${CWD}/.claude/skills/a/SKILL.md`;
    expect(decide(bash(`cp ${source} /tmp/backup.md`))).toEqual({ decision: "allow" });
  });

  it("allows a command with stderr duplication after changing into a marketplace", () => {
    const marketplace = `${CWD}/marketplace`;
    expect(
      decide(bash(`cd ${marketplace} && git push origin main 2>&1 | tail -2`), { marketplaceRoots: [marketplace] }),
    ).toEqual({ decision: "allow" });
  });

  it.each([">&1", "2>&1", "1>&2", ">&-", "2>&-", "<&1", "2<&1", "1<&2", "<&-", "2<&-", "2>& 1", "2<& -"])(
    "allows file-descriptor duplication or closing with %s inside a marketplace",
    (redirect) => {
      const marketplace = `${CWD}/marketplace`;
      expect(decide(bash(`cmd ${redirect}`, marketplace), { marketplaceRoots: [marketplace] })).toEqual({
        decision: "allow",
      });
    },
  );

  it.each(["echo x > skills/a/SKILL.md", "cmd &> f", "cmd &>f", "cmd >f", "cmd 2>&1 > f"])(
    "blocks a real marketplace write with %s",
    (command) => {
      const marketplace = `${CWD}/marketplace`;
      expect(decide(bash(command, marketplace), { marketplaceRoots: [marketplace] })).toEqual({
        decision: "deny",
        reason: DENY_REASON,
      });
    },
  );

  it("warns instead of denying inside a project listed in guard.json warnProjects", () => {
    const config = { warnProjects: [CWD] };
    expect(decide(edit(`${CWD}/.claude/skills/a/SKILL.md`), config)).toEqual({ decision: "warn", reason: DENY_REASON });
    expect(decide(write(`/elsewhere/.claude/skills/a/SKILL.md`, "/elsewhere"), config)).toEqual({
      decision: "deny",
      reason: DENY_REASON,
    });
  });

  it("allows on malformed input instead of throwing", () => {
    expect(decide(null)).toMatchObject({ decision: "allow" });
    expect(decide("not-an-object")).toMatchObject({ decision: "allow", internalError: expect.any(String) });
    expect(decide(42)).toMatchObject({ decision: "allow" });
  });

  it("allows when guard.json is absent or malformed, static patterns still apply", () => {
    expect(decide(edit(`${CWD}/.claude/skills/a/SKILL.md`), undefined)).toEqual({
      decision: "deny",
      reason: DENY_REASON,
    });
    expect(decide(edit(`${CWD}/.claude/skills/a/SKILL.md`), "not-an-object" as never)).toEqual({
      decision: "deny",
      reason: DENY_REASON,
    });
    expect(decide(edit(`${CWD}/notes.md`), "not-an-object" as never)).toEqual({ decision: "allow" });
  });

  it("expands $HOME and ${HOME} in shell tokens, like ~", () => {
    expect(decide(bash("echo hi > $HOME/.claude/skills/a/SKILL.md"))).toEqual({
      decision: "deny",
      reason: DENY_REASON,
    });
    expect(decide(bash("echo hi > ${HOME}/.claude/skills/a/SKILL.md"))).toEqual({
      decision: "deny",
      reason: DENY_REASON,
    });
    expect(decide(bash("echo hi > $HOME/notes.md"))).toEqual({ decision: "allow" });
  });

  it("uses a cd segment's target as the base directory for the segments that follow it", () => {
    expect(decide(bash(`cd ${CWD} && echo hi > .claude/skills/a/SKILL.md`, "/elsewhere"))).toEqual({
      decision: "deny",
      reason: DENY_REASON,
    });
    expect(decide(bash(`cd ${CWD}/notes && echo hi > report.md`, "/elsewhere"))).toEqual({ decision: "allow" });
  });

  it("extracts apply_patch paths from a patch heredoc sent through Bash", () => {
    const command = [
      "apply_patch <<'EOF'",
      "*** Begin Patch",
      `*** Update File: ${CWD}/.claude/skills/a/SKILL.md`,
      "*** End Patch",
      "EOF",
    ].join("\n");
    expect(decide(bash(command))).toEqual({ decision: "deny", reason: DENY_REASON });
    const unmanaged = [
      "apply_patch <<'EOF'",
      "*** Begin Patch",
      "*** Add File: notes/plan.md",
      "*** End Patch",
      "EOF",
    ].join("\n");
    expect(decide(bash(unmanaged))).toEqual({ decision: "allow" });
  });

  it("canonicalizes the target before matching marketplace roots and warn projects", () => {
    // macOS: /tmp is a symlink to /private/tmp. guard.json stores canonical roots (item 5 of the
    // review); a target reached through the /tmp alias must still match one registered as
    // /private/tmp/....
    const marketplaceConfig = { marketplaceRoots: ["/private/tmp/omni-guard-marketplace"] };
    expect(decide(edit("/tmp/omni-guard-marketplace/skills/x/SKILL.md"), marketplaceConfig)).toEqual({
      decision: "deny",
      reason: DENY_REASON,
    });
    expect(decide(edit("/tmp/omni-guard-marketplace-other/skills/x/SKILL.md"), marketplaceConfig)).toEqual({
      decision: "allow",
    });
    const warnConfig = { warnProjects: ["/private/tmp/omni-guard-warn-project"] };
    expect(decide(edit("/tmp/omni-guard-warn-project/.claude/skills/a/SKILL.md"), warnConfig)).toEqual({
      decision: "warn",
      reason: DENY_REASON,
    });
  });
});
