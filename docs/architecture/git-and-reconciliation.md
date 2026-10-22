# Git and reconciliation

Git writes belong to approved local operations.

## Reconciliation flow

```text
select explicit roots
  → observe projects, sources, and provider state
    → refresh and normalize selected sources
      → load desired bindings
        → compare desired and observed state
          → produce a deterministic plan
            → approve
              → apply bounded actions
                → re-observe and verify final state
```

The plan is the unit the user reviews. Re-running the same plan against the same state
must produce no additional changes.

## Git read contract

Omni may inspect repository identity, current branch, HEAD, refs, status, diffs, and
requested source revisions. Git is a transport and revision layer, not a hidden write
channel.

The approved V1 deterministic write may commit the exact paths Omni writes when the
user's commit setting is enabled. Repository initialization is also an explicit previewed
operation. An approved operation that commits in the active workshop also pushes its branch
to its configured upstream, including earlier unpushed commits. Its preview discloses that
effect. Push results are recorded separately from the local write in the receipt. A failed
push preserves committed files and offers a newly previewed Retry. Diverged or behind history
requires manual reconciliation. Omni never force-pushes, merges, rebases, creates branches,
or resolves conflicts implicitly. Project and storefront commits keep their own policies.
Every Git write belongs to an approved operation with a result record.

Omni disables repository and global Git hooks and configured filesystem-monitor
executables for its Git commands. Hooks can execute
unreviewed code, modify previewed bytes, or alter unrelated staged work; they are outside
the approved static-file operation. Existing hook configuration remains unchanged.
The commit contains only the operation's paths and leaves unrelated staged edits intact.

Read-only observation may record repository identity, worktree boundaries, HEAD, and dirty status as read-only
provenance. A project without Git remains a valid inventory root. Nested repositories and
worktrees are separate observed scopes rather than implicit duplicates.

## File ownership

Omni can remove or update only a file it owns through an installation record or a user
approved explicit target. A locally modified owned file is `drifted`; an unmanaged target
is a conflict or requires explicit adoption. No write silently overwrites local work.

## Idempotency and recovery

- Plans use resolved revisions and content hashes.
- File writes are bounded to approved roots.
- Destructive changes create a backup or recovery reference.
- Partial failure records completed and failed actions separately.
- A second run observes the result before deciding whether work remains.

## Provider actions

Provider caches, plugin indexes, and hook activation are provider-owned. Omni may inspect
them and emit `install`, `update`, `uninstall`, `activate`, or `deactivate` actions. The
provider adapter performs those actions only after explicit approval. Omni never deletes
a provider cache directly when an official provider operation exists.
