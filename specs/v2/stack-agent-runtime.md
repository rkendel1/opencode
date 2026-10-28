# Stack-Agent runtime updates

An improvement measured in the Improvement Lab (`specs/v2/agent-improvement.md`) can be applied to the Stack-Agent source,
built, staged and activated without restarting the desktop:

Diagnose → Propose → Implement → Verify → Apply → Build → Stage → Activate → Measure.

All state lives in the existing KV store. There is no new database, service or paid dependency.

## Architecture and data flow

| Step      | Where                                    | What happens                                                                                                                                                                               |
| --------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Implement | `Improvement` (target `stack-agent`)     | Worktree in the Stack-Agent source repo at the configured branch tip; commit on `improvement/<id>`                                                                                         |
| Verify    | `StackAgentRuntime.build` + `Comparison` | The candidate commit is built into its own generation; baseline runs pin the generation active at approval, candidate runs pin the candidate generation, both at the same project revision |
| Apply     | `Improvement.preview` / `apply`          | Preview, explicit confirmation, then a cherry-pick onto the current tip in a dedicated worktree                                                                                            |
| Publish   | `Improvement.publish`                    | `git push <remote> stack-agent-improvement/<id>`, only when the user presses Push                                                                                                          |
| Build     | `StackAgentRuntime.build`                | Build command in a detached worktree at the commit; artifact copied into a new generation directory                                                                                        |
| Stage     | same                                     | sha256 recorded, smoke checks run; only a generation that passes them is `validated`                                                                                                       |
| Activate  | `StackAgentRuntime.activate`             | Re-verifies file, sha256 and `--version`, then moves the active pointer                                                                                                                    |
| Run       | `session/runner/stack-agent.ts`          | Each drain resolves an executable: pinned generation, else active, else `STACK_AGENT_BIN` / `PATH`                                                                                         |
| Measure   | `Comparison` environment facts           | Every run records the generation, commit, version and source it was executed by                                                                                                            |

KV keys:

- `stack-agent/settings` holds the source directory, branch, remote, build command, artifact path, smoke commands and
  repository checks.
- `stack-agent/state` holds the active generation, previous generations (the rollback stack), the in-flight operation,
  the last update check and an event history.
- `stack-agent/generation/<id>` holds one build record: commit, status, executable, sha256, version, build output,
  smoke results and origin (for example the improvement that produced it).
- `stack-agent/usage/<sessionID>` holds the generations a Session's drains ran on, with start, end and exit code.

Applications are recorded on the improvement (`improvement/state/<id>.application`).

## Versioned builds

Each generation lives under `<data>/stack-agent/versions/<id>/` and is never overwritten. A failed build writes a
`failed` record and leaves the active pointer alone. Builds share `CARGO_TARGET_DIR` (`<data>/stack-agent/target`) so
incremental builds stay fast. A build of a tree that already has a validated generation reuses it.

Activation refuses a generation that is not `validated`, whose file is missing, whose sha256 changed since staging, or
whose `--version` probe fails. The state pointer is the only thing that changes, under a lock, so a partially written
executable can never become active. Rollback pops the previous validated generation. A build or activation
interrupted by a restart is marked failed on startup and the active pointer is unchanged.

## Live updates without a restart

The stack-agent runner spawns a child process per drain and resolves the executable at spawn time. Activating a new
generation therefore affects only tasks that start afterwards. Running children keep the file they started with,
which stays on disk because generations are immutable. The runtime page lists running tasks and marks those still on
an earlier version. No task is stopped to install an update.

A Session can be pinned with metadata `stackAgentGeneration`. Comparisons use this to evaluate a specific build.

## Apply safety

- Apply needs an implemented, evaluated improvement and explicit confirmation in the preview.
- The preview shows the finding and evidence, files, checks, target directory and branch, the tested revision, the
  current tip, drift, conflicts (`git merge-tree --write-tree`) and the evaluation verdict with runtime versions.
- The user's checkout and branch are never touched. The change is committed on `stack-agent-improvement/<id>` in a
  `<id>-apply` worktree, with an `Improvement: <id>` trailer.
- Retrying reuses a branch that already carries the trailer, so the same commit is never created twice.
- Conflicts stop the apply and are listed.
- The repository checks and the proposal's acceptance criteria run on the applied commit. Failing checks block push
  and build.
- `sameSource` reports whether the applied tree is identical to the evaluated one. When the branch drifted, the applied
  build is a different tree from the one that was measured; the UI says so, and it should be re-measured before it is
  trusted.
- Nothing is pushed, merged or activated automatically. Model output can propose a change but cannot authorize apply,
  push or activation; each of those is a separate user action.

## Measurement

Improvement verdicts compare baseline and candidate generations at the same project revision and record both
(`evaluation.runtime`). Success is classified only from verified acceptance criteria, never from a successful build or
activation. After activation, ordinary comparisons record `Executed by` from the usage record, so before and after
results can be told apart.

## Known limits

- PAX is reported as unavailable: Stack-Agent exposes no API contract for it.
- There is no prebuilt-artifact source; every generation is built from source.
- Publishing pushes a branch; opening a PR or merging is left to the user.

## Tests

From `packages/core`:

```bash
bun run script/test.ts test/stack-agent-runtime.test.ts test/improvement-stack-agent.test.ts
```

They use a git fixture with a shell build script instead of cargo and cover the following:

- Build, activate and rollback.
- Failed builds and failed smoke checks.
- Busy and tampered generations.
- Recovery from an interrupted build.
- Rolling activation with a live task.
- The full flow: diagnose, evaluate on pinned generations, apply, push, stage and activate.
- Conflicts and drift.
