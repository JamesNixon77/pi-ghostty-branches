# Concurrency guarding for writable branches

Writable Pi branches are separate processes. They have isolated conversations and session files, but currently share one working directory. Pi's built-in file mutation queue is process-local, so it cannot coordinate edits made by sibling branch processes.

This document evaluates guard designs. It does not claim that shared-workspace writes are safe today.

## Failure modes

1. Two agents read the same file and produce changes from the same old contents.
2. `write` replaces a complete file after another branch changed it.
3. `edit` usually fails when its exact `oldText` became stale, but broad or non-overlapping replacements can still produce an unintended combined result.
4. Shell commands can mutate arbitrary files outside the structured `edit` and `write` tools.
5. Git operations can contend on index/ref locks or commit unrelated changes from another branch.
6. Generators, formatters, package managers, dev servers, and tests can mutate shared caches or generated outputs.

## Options considered

### 1. Cross-process file locks only

Before `edit` or `write`, acquire an advisory lock under the extension state directory, keyed by the canonical target path. Release it after `tool_result`; reclaim stale locks when the owner PID is gone.

This serializes mutations but does not prevent stale decisions. An agent can read version A, wait for another branch to write version B, then acquire the lock and overwrite B using assumptions from A.

**Verdict:** useful as one layer, insufficient by itself.

### 2. Optimistic hash checks plus file locks

On every `read`, record a whole-file SHA-256 and file metadata for that session. Before `edit` or `write`:

1. canonicalize the path with `realpath` where possible;
2. acquire the cross-process path lock;
3. hash the current file;
4. require it to match the branch's last observed hash;
5. block the mutation if it changed and instruct the agent to reread/reconcile;
6. after success, record the new hash and release the lock.

For new files, the observation is an explicit “absent” version and creation fails if another branch created the path first. Process crashes are handled with PID-stamped leases and conservative stale-lock recovery.

This fits Pi's `tool_call`/`tool_result` extension hooks and improves `edit`/`write` substantially. It still cannot safely understand arbitrary mutating `bash` commands.

**Verdict:** recommended near-term guard for structured file tools, with an explicit warning that shell mutations remain unguarded.

### 3. Workspace-wide writer lease

Allow only one writable branch to own the shared workspace at a time. Other agents can reason/read in parallel but wait before any mutating turn.

This is simple and robust, including for shell commands if the lease covers the entire agent/tool batch. It also eliminates most useful parallel implementation work and can deadlock or starve without careful cancellation.

**Verdict:** viable optional strict mode, not a good default.

### 4. Git status/diff checkpoints

Capture HEAD, index state, and working-tree hashes at branch creation and before mutations. Detect drift and block or ask before proceeding.

This gives useful diagnostics and recovery, but does not isolate files. Untracked files, generated artifacts, and concurrent shell commands remain difficult. Automatically stashing or committing another process's work is unsafe.

**Verdict:** useful observability and recovery layer, not primary isolation.

### 5. Isolated workspaces/worktrees

Give every writable branch its own filesystem workspace and Git branch. Agents can edit, test, and commit independently; folding reports the commit/diff and the parent chooses how to integrate it.

This is the strongest design, but workspace creation must be environment-aware:

- ordinary Git repositories can use a dedicated `git worktree` adapter;
- `shop/world` must use `dev cd <area> -t <worktree>` and must never manipulate sparse checkout directly;
- non-Git directories need a copy/sandbox adapter or must fall back to shared-write warnings;
- dirty parent state requires an explicit policy because a new worktree starts from committed Git state and does not automatically contain uncommitted files.

**Verdict:** recommended long-term default for writable branches.

## Recommended implementation plan

### Phase 1: honest shared-write mode

- Make writable branches the requested default.
- Keep `/branch-ro` and `/branch-read` for safe investigation.
- Persist `access: "shared-write" | "read-only"` in branch metadata.
- Show a warning whenever a shared writable branch is created.
- Do not claim concurrency safety.

### Phase 2: structured mutation guard

- Add canonical-path lock files under `$PI_CODING_AGENT_DIR/ghostty-branches/locks/`.
- Record per-session observations under `observations/<session-id>/`.
- Intercept `read`, `edit`, and `write` with hash/precondition checks.
- Block stale writes with actionable reread guidance.
- Add lock timeout, cancellation, PID validation, symlink, new-file, and crash-recovery tests.
- Clearly mark `bash` as outside the guard unless it is disabled or sandboxed.

### Phase 3: workspace adapters

Define an adapter contract:

```ts
interface WorkspaceAdapter {
  detect(cwd: string): Promise<boolean>;
  createBranchWorkspace(input: {
    cwd: string;
    branchSessionId: string;
    label: string;
  }): Promise<{ cwd: string; integration?: { kind: string; ref: string } }>;
  disposeBranchWorkspace?(cwd: string): Promise<void>;
}
```

Implement:

1. `shop-world` adapter using `dev cd -t`;
2. ordinary Git worktree adapter;
3. shared-directory fallback requiring confirmation.

Workspace disposal and code integration must remain separate from context folding. Closing a Pi branch must not silently delete a worktree or Git branch, and folding must not silently merge code.

## Recommendation

Implement optimistic hashes and cross-process path locks next, but treat them as guardrails rather than full isolation. The feature should be considered concurrency-safe only after writable branches default to isolated workspace adapters. Until then, shared-write warnings and explicit read-only commands remain necessary.
