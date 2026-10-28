# Agent improvement loop

The Improvement Lab turns verified agent runs into tested interventions:

Observe → Diagnose → Investigate → Propose → Implement → Evaluate → Retain or reject.

It reuses the comparison bench (`specs/v2/agent-comparison.md`), Sessions, worktrees and the KV store. It adds no
runtime, workflow engine or database.

## Architecture and data flow

| Stage       | Where                                | What it reads and writes                                                                      |
| ----------- | ------------------------------------ | --------------------------------------------------------------------------------------------- |
| Observe     | `ImprovementAnalysis.records`        | Completed comparison runs → `ExecutionRecord` v1, derived on demand, never stored             |
| Diagnose    | `ImprovementAnalysis.analyze`        | Records → `Analysis` (findings plus explicit insufficient-data results)                       |
| Investigate | `Improvement.create` / `investigate` | A read-only `plan` Session in a worktree at the base revision                                 |
| Propose     | `ImprovementProposal.parse`          | The agent's JSON answer → schema-checked, grounded `Proposal` v1, or a list of errors         |
| Approve     | `Improvement.approve`                | Fixes the `Plan` (α, trials, tasks, comparison IDs) before anything runs                      |
| Evaluate    | `Comparison.create` with `revision`  | Baseline comparisons at the base revision                                                     |
| Implement   | Session in a fresh worktree          | Selected runtime and project permissions; commits to `improvement/<id>`, then runs the checks |
| Evaluate    | `Comparison.create` with `revision`  | Candidate comparisons at the implementation commit                                            |
| Verdict     | `ImprovementEvaluate.compare`        | Improved, regressed, inconclusive or failed to implement                                      |
| Retain      | `Improvement.decide`                 | Reviewer decision; accepted improvements become finding history                               |

Persistence lives in the existing KV store:

- `improvement/def/<id>` is written once. It holds the finding snapshot and the base revision.
- `improvement/state/<id>` holds the lifecycle: investigations, plan, implementation, evaluation and decision.

Baseline and candidate runs are ordinary comparisons tagged with `origin: { improvementID, variant }`. They never
overwrite the observed history, and the analysis leaves them out.

## Evidence

An `ExecutionRecord` keeps the comparison and Session IDs, task key, category, runtime, observed model, outcome,
failed criteria, and only the metrics that were measured. A missing metric means unknown. Binary features (for example
`unrecovered-terminal-failure`, `repeated-tool-calls`, `no-file-changes`) come from the comparison report and the
folded Session messages.

PAX remains Stack-Agent's own verifier on `PATH`, and opencode has no PAX contract to read. The evidence is
therefore the evaluator's verified outcome plus opencode's persisted Session records. Stack-Agent's internal tool
activity is unavailable, so features derived from it never fire for Stack-Agent runs. No prompts, environment or
credentials are copied into records or findings beyond task titles and failed criterion descriptions.

## ML method

Agent evaluation data here is tens of verified runs, so the stage uses exact small-sample statistics rather than a
trained model:

- **Feature association.** One-sided Fisher exact tests (with versus without a feature), Benjamini–Hochberg corrected
  across every feature and direction. A finding is _supported_ at q ≤ 0.1 and _tentative_ at raw p ≤ 0.1.
  Tentative findings are marked as needing more evidence and cannot be investigated.
- **Runtime gap.** Exact McNemar (sign) test on comparisons where both runtimes were verified. These are paired: same
  task, same revision.
- **Recurring task failure.** Wilson 95% interval; reported when the lower bound is ≥ 0.4.
- **Efficiency.** Sign test on paired durations, only where both runtimes verified success.

Only evaluator-verified outcomes (success, partial, failed) count; unverified and cancelled runs are excluded.
Below the minimum sample sizes the analysis returns an explicit insufficient-data result instead of a finding. Every
finding separates the observed `statement` from the inferred `interpretation`, and states its comparison group,
effect with interval, sample size and p-values.

## Proposal contract (v1)

The investigation answer must be one JSON object matching `Improvement.Proposal`:

- cause, hypothesis, mechanism, layer and alternatives
- source locations and changes
- acceptance criteria, each with a command
- evaluation (`taskKeys`, `trials` from 1 to 5, `targetRuntimes`)
- risks, rollback conditions and required approvals

It is rejected when any of these hold:

- it has fields outside the contract, so a proposal cannot request permissions;
- it addresses a different finding;
- it evaluates on tasks that are not the finding's;
- it cites or changes paths outside the repository;
- it cites files that do not exist at the base revision;
- none of its cited files was opened by a read tool during the investigation.

An invalid proposal never reaches approval; the user can start another investigation.

## Implementation contract

Approval is a user action and needs a valid proposal awaiting review. Implementation then works like this:

- It runs in its own worktree at the base revision, with the selected runtime and the project's own permission rules.
- The pipeline stages and commits the result to `improvement/<id>`; it never merges, pushes or touches the user's
  checkout.
- A patch that changes permission configuration (`opencode.json*`, `.opencode/`) is refused and not evaluated.
- An empty change, a failed commit or a failed acceptance check gives **failed to implement**.

## Evaluation

The plan is fixed at approval. The baseline runs before implementation, and the candidate runs the same tasks, with
the same criteria and models, at the candidate commit.

Per runtime, the evaluation runs one-sided Fisher exact tests on verified success at α = 0.1. It also checks whether
any criterion that passed in every baseline run now fails in every candidate run.

| Verdict             | Rule                                                               |
| ------------------- | ------------------------------------------------------------------ |
| Improved            | A target runtime rises with p ≤ α and nothing regresses            |
| Regressed           | Any runtime falls with p ≤ α, or a criterion regresses             |
| Inconclusive        | Anything else, including too few verified runs                     |
| Failed to implement | The change could not be made or did not pass its acceptance checks |

Efficiency medians are reported but never decide. Only an **Improved** verdict accepted by a reviewer is a
_validated intervention_. Validated interventions appear in the finding's history in later analyses, scoped to that
finding only.

## Recovery

Every stage resumes from persisted state after a restart:

- Evaluation comparisons have deterministic IDs and `Comparison.create` adopts an existing ID, so none is repeated.
- A recorded implementation Session is resumed rather than restarted.
- An already committed change is not committed again.
- An investigation or implementation interrupted before its Session existed is reported as failed rather than silently
  restarted.

Concurrent `git worktree add` calls in one repository raced and failed; `Git.worktree.create` and `remove` are now
serialized per repository.

## Known limits

- Project-target interventions are evaluated in-process. That works for prompt and context changes (`AGENTS.md`,
  skills, project config), which each Session loads from its own worktree. Stack-Agent-target interventions are built
  into a candidate runtime generation and measured against the baseline generation; see
  `specs/v2/stack-agent-runtime.md`. Changes to opencode's own code are not measurable here.
- Plain Sessions have no acceptance criteria, so only comparison runs enter outcome analysis.
- Small samples are usually inconclusive; three trials per arm is the smallest design where 0/3 → 3/3 can pass
  α = 0.1.

## Tests

From `packages/core`:

```bash
bun run script/test.ts test/improvement-analysis.test.ts test/improvement-proposal.test.ts test/improvement.test.ts test/comparison.test.ts
```

`improvement.test.ts` runs the whole loop on a deterministic fixture with a scripted model and a stub Stack-Agent. It
covers the improved, invalid-proposal, failed-implementation and resume cases. No paid inference is used.
