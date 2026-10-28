# Agent comparison

Compare Agents runs one task through the native OpenCode agent and through Stack-Agent, side by side, and reports
which result is better supported by evidence. It is an evaluation layer over the existing harness toggle
(`session.metadata.harness`), not another agent runtime.

## Running a comparison

1. Open a Git repository in the desktop app and start a new session draft.
2. Choose **Compare agents** (the button at the bottom-left of the new-session screen, or the command palette).
3. Enter a title, a category, the task exactly as you would give it to a single agent, and acceptance criteria.
   - A criterion with a **verification command** is checked by running that command in the agent's workspace after
     the agent stops; exit status 0 passes. Commands run through `bash -lc` with a 10 minute limit.
   - A criterion without a command is shown as **Needs review**; it is never counted as passed.
4. Select **Start comparison**. Each pane shows its run's status, live activity, terminal commands, changes,
   acceptance criteria and environment. **Open session** opens the run's real Session, including its terminal and
   full diff. **Cancel** stops one run; **Cancel both** stops both.
5. The URL (`/server/<server>/compare/<id>`) is a persistent link to the report. **Rerun** starts a new comparison
   with the same task and criteria at the repository's current commit.

Comparisons are stored by the server and reopen after the app or server restarts.

## What happens on start

- An immutable definition is written first: task, criteria, project, starting revision (`git rev-parse HEAD`),
  branch, whether the checkout had uncommitted changes, requested models, and harnesses.
- Each run gets its own Git worktree created with the existing `Worktree.create` (detached at the starting revision,
  then the project's start command, if any). Your checkout is never modified, and uncommitted changes in it are not
  copied into either workspace. Workspaces are not removed automatically.
- Before either agent starts, every verification command runs once in each workspace. That baseline lets the report
  show regressions (passed before, fails after) and reveals environments that differ.
- Each run is an ordinary Session in its workspace with `metadata.harness` set to `opencode` or `stack-agent`, the
  same default agent, the same project permission rules, and the same prompt text.
- When a run's Session has no execution and no queued input left, the evaluator runs the criteria, reads
  `git diff --numstat` and `git status` against the starting revision, and folds the Session's persisted messages
  into metrics.

## Reading the report

Outcomes are decided only by evaluator evidence, never by what the agent says:

| Outcome          | Meaning                                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------- |
| Verified success | Every criterion has a command and every command passed                                   |
| Partial          | Some verifiable criteria passed, others failed                                           |
| Failed           | Every verifiable criterion failed, or a criterion that passed before the agent now fails |
| Unverified       | Nothing could be verified, or verifiable criteria passed but others need manual review   |
| Cancelled        | The run was cancelled before evaluation; criteria are not run                            |

The agent's own final message is shown separately as "Agent's own summary (not used for scoring)".

Every metric carries its source and method (hover a value). **Unavailable** means the value could not be observed,
not zero. **Inferred** marks metrics derived by a rule (repeated tool calls, recovered command failures) rather than
counted directly. Faster runs, fewer tool calls and smaller diffs are not wins by themselves; the outcome row comes
first.

**Repeated trials** lists the outcome distribution of every evaluated run of the same task and criteria in the same
project. One run is one observation, not a statistical result.

A comparison is **qualified** when something other than the agent runtime differs, for example a different model for
Stack-Agent, different baseline results between the two workspaces, PAX missing (Stack-Agent then runs in read-only
`inspect` mode), or Stack-Agent running its tools outside opencode's permission prompts.

## Evidence and known gaps

- **Durable record.** Metrics are folded from the Session message projection, which the server always stores. Raw
  durable events are only persisted when the server is configured with `events.persist`, so the comparison does not
  depend on the event log. Each activity entry carries its message ID and tool call ID.
- **PAX.** PAX is Stack-Agent's own test runner, found on `PATH`; opencode has no PAX API or event contract. The
  comparison records whether PAX is available and what Stack-Agent printed, but cannot import PAX's evidence. Any
  Stack-Agent claim of verification is shown as its summary only; the evaluator re-runs the criteria itself.
- **Stack-Agent internals.** Stack-Agent executes tools in its own process and reaches the model through a loopback
  gateway that records only the run's token and cost totals. Its tool calls, terminal commands, permission denials
  and model request count are therefore reported as unavailable.
- **Cost** is shown only when the model catalog priced the recorded usage.
- **Restart.** Runs that were preparing their workspace when the server stopped are marked failed to start. Running
  runs resume watching their Session after restart; Session recovery resumes the agent itself.
- **Permissions.** The OpenCode run asks for permissions as usual; answer them in its Session (**Open session**).

## API

`/api/comparison` (`list`, `create`), `/api/comparison/:id` (`get`), `/api/comparison/:id/cancel`,
`/api/comparison/:id/rerun`. Schemas live in `packages/schema/src/comparison.ts`; the service is
`packages/core/src/comparison.ts`.

## Tests

From `packages/core`: `bun run script/test.ts test/comparison.test.ts test/comparison-report.test.ts`. The
integration test builds a deterministic fixture repository, drives the native runtime with a scripted test model and
Stack-Agent with a stub binary, and checks workspaces, files and git state directly. No paid inference is used.
