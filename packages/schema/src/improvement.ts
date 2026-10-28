export * as Improvement from "./improvement.js"

import { Schema } from "effect"
import { Comparison } from "./comparison.js"
import { ascending } from "./identifier.js"
import { Project } from "./project.js"
import { AbsolutePath, NonNegativeInt, optional, statics } from "./schema.js"
import { SessionID } from "./session-id.js"

export const ID = Schema.String.check(Schema.isStartingWith("imp")).pipe(
  Schema.brand("Improvement.ID"),
  Schema.annotate({ identifier: "Improvement.ID" }),
  statics((schema) => ({
    create: () => schema.make("imp_" + ascending()),
  })),
)
export type ID = typeof ID.Type

/**
 * One agent execution in a runtime-neutral shape (version 1). Derived on demand from persisted comparison runs; it
 * is never stored separately. Metrics hold only measured values, so an absent key means unknown, not zero.
 */
export const ExecutionRecord = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  comparisonID: Comparison.ID,
  harness: Comparison.Harness,
  taskKey: Schema.String,
  title: Schema.String,
  category: Comparison.Category,
  revision: Schema.String,
  createdAt: Schema.Finite,
  sessionID: optional(SessionID),
  model: optional(Schema.String),
  /** Absent until the evaluator has scored the run. */
  outcome: optional(Comparison.Outcome),
  failedCriteria: Schema.Array(Schema.String),
  metrics: Schema.Record(Schema.String, Schema.Finite),
  /** Binary observations used by the analysis, such as `unrecovered-terminal-failure`. */
  features: Schema.Array(Schema.String),
}).annotate({ identifier: "Improvement.ExecutionRecord" })
export interface ExecutionRecord extends Schema.Schema.Type<typeof ExecutionRecord> {}

export const FindingKind = Schema.Literals([
  "failure-association",
  "success-association",
  "runtime-gap",
  "recurring-task-failure",
  "efficiency-gap",
]).annotate({ identifier: "Improvement.FindingKind" })
export type FindingKind = typeof FindingKind.Type

export const Disposition = Schema.Literals(["improved", "regressed", "inconclusive", "failed-to-implement"]).annotate({
  identifier: "Improvement.Disposition",
})
export type Disposition = typeof Disposition.Type

export const Decision = Schema.Literals(["accept", "reject", "inconclusive"]).annotate({
  identifier: "Improvement.Decision",
})
export type Decision = typeof Decision.Type

export const FindingEvidence = Schema.Struct({
  recordID: Schema.String,
  comparisonID: Comparison.ID,
  harness: Comparison.Harness,
  sessionID: optional(SessionID),
  taskKey: Schema.String,
  title: Schema.String,
  outcome: optional(Comparison.Outcome),
  note: Schema.String,
}).annotate({ identifier: "Improvement.FindingEvidence" })
export interface FindingEvidence extends Schema.Schema.Type<typeof FindingEvidence> {}

/** A structured ML finding. `statement` is the observed association; `interpretation` is inference, never proof. */
export const Finding = Schema.Struct({
  id: Schema.String,
  kind: FindingKind,
  title: Schema.String,
  statement: Schema.String,
  interpretation: Schema.String,
  scope: Schema.Struct({
    stage: Schema.String,
    feature: optional(Schema.String),
    harness: optional(Comparison.Harness),
    category: optional(Comparison.Category),
    taskKey: optional(Schema.String),
  }),
  /** Runs showing the condition. */
  frequency: NonNegativeInt,
  /** Verified runs the test considered. */
  sampleSize: NonNegativeInt,
  severity: Schema.Literals(["high", "medium", "low"]),
  effect: Schema.Struct({
    measure: Schema.String,
    estimate: Schema.Finite,
    low: optional(Schema.Finite),
    high: optional(Schema.Finite),
  }),
  comparisonGroup: Schema.String,
  pValue: optional(Schema.Finite),
  adjustedPValue: optional(Schema.Finite),
  /** supported: passes the predefined threshold after correction. tentative: suggestive only. */
  support: Schema.Literals(["supported", "tentative"]),
  needsMoreEvidence: Schema.Boolean,
  evidence: Schema.Array(FindingEvidence),
  taskKeys: Schema.Array(Schema.String),
  /** Earlier interventions on this finding and how they were judged. */
  history: Schema.Array(
    Schema.Struct({
      improvementID: Schema.String,
      verdict: optional(Disposition),
      decision: optional(Decision),
      validated: Schema.Boolean,
    }),
  ),
  method: Schema.String,
}).annotate({ identifier: "Improvement.Finding" })
export interface Finding extends Schema.Schema.Type<typeof Finding> {}

export const Analysis = Schema.Struct({
  version: Schema.Literal(1),
  generatedAt: Schema.Finite,
  records: NonNegativeInt,
  /** Records with a verified outcome (success, partial or failed); only these enter outcome analysis. */
  verified: NonNegativeInt,
  findings: Schema.Array(Finding),
  /** Analyses that could not run, and why. */
  insufficient: Schema.Array(
    Schema.Struct({ analysis: Schema.String, have: NonNegativeInt, need: NonNegativeInt, reason: Schema.String }),
  ),
  method: Schema.String,
}).annotate({ identifier: "Improvement.Analysis" })
export interface Analysis extends Schema.Schema.Type<typeof Analysis> {}

export const Layer = Schema.Literals([
  "runtime",
  "prompt-context",
  "tool-integration",
  "capability-discovery",
  "recovery",
  "model-configuration",
  "verification",
  "other",
])

/**
 * The LLM's proposal contract, version 1. Unknown fields are rejected, so a proposal cannot carry instructions such
 * as permission changes that the pipeline would not honour anyway.
 */
export const Proposal = Schema.Struct({
  version: Schema.Literal(1),
  findingID: Schema.String,
  title: Schema.NonEmptyString,
  cause: Schema.NonEmptyString,
  hypothesis: Schema.NonEmptyString,
  mechanism: Schema.NonEmptyString,
  layer: Layer,
  alternatives: Schema.NonEmptyArray(Schema.String),
  sourceLocations: Schema.NonEmptyArray(
    Schema.Struct({ path: Schema.NonEmptyString, line: optional(NonNegativeInt), reason: Schema.String }),
  ),
  changes: Schema.NonEmptyArray(Schema.Struct({ path: Schema.NonEmptyString, description: Schema.String })),
  acceptanceCriteria: Schema.NonEmptyArray(
    Schema.Struct({ id: Schema.NonEmptyString, description: Schema.String, command: Schema.NonEmptyString }),
  ),
  evaluation: Schema.Struct({
    taskKeys: Schema.NonEmptyArray(Schema.String),
    trials: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
    targetRuntimes: Schema.NonEmptyArray(Comparison.Harness),
  }),
  risks: Schema.Array(Schema.String),
  rollback: Schema.NonEmptyArray(Schema.String),
  requiredApprovals: Schema.Array(Schema.String),
}).annotate({ identifier: "Improvement.Proposal" })
export interface Proposal extends Schema.Schema.Type<typeof Proposal> {}

export const Investigation = Schema.Struct({
  attempt: NonNegativeInt,
  status: Schema.Literals(["running", "valid", "invalid", "failed"]),
  sessionID: optional(SessionID),
  startedAt: Schema.Finite,
  proposal: optional(Proposal),
  errors: Schema.Array(Schema.String),
}).annotate({ identifier: "Improvement.Investigation" })
export interface Investigation extends Schema.Schema.Type<typeof Investigation> {}

/** What an intervention changes: the project under test, or the Stack-Agent runtime's own source. */
export const Target = Schema.Literals(["project", "stack-agent"]).annotate({ identifier: "Improvement.Target" })
export type Target = typeof Target.Type

/** A runtime version an evaluation arm was pinned to: a generation ID, or `external` for the unmanaged binary. */
export const RuntimeRef = Schema.Struct({
  pin: Schema.String,
  commit: optional(Schema.String),
  version: optional(Schema.String),
}).annotate({ identifier: "Improvement.RuntimeRef" })
export interface RuntimeRef extends Schema.Schema.Type<typeof RuntimeRef> {}

export const PlannedRun = Schema.Struct({
  variant: Schema.Literals(["baseline", "candidate"]),
  taskKey: Schema.String,
  trial: NonNegativeInt,
  comparisonID: Comparison.ID,
}).annotate({ identifier: "Improvement.PlannedRun" })
export interface PlannedRun extends Schema.Schema.Type<typeof PlannedRun> {}

/** Fixed at approval, before the baseline runs, so the decision rule cannot be tuned to the result. */
export const Plan = Schema.Struct({
  attempt: NonNegativeInt,
  harness: Comparison.Harness,
  approvedAt: Schema.Finite,
  alpha: Schema.Finite,
  trials: NonNegativeInt,
  taskKeys: Schema.Array(Schema.String),
  targetRuntimes: Schema.Array(Comparison.Harness),
  runs: Schema.Array(PlannedRun),
  /** For a Stack-Agent target: the runtime the baseline arm is pinned to. */
  baselineRuntime: optional(RuntimeRef),
}).annotate({ identifier: "Improvement.Plan" })
export interface Plan extends Schema.Schema.Type<typeof Plan> {}

export const Check = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  command: Schema.String,
  passed: Schema.Boolean,
  exitCode: Schema.Finite,
  output: Schema.String,
}).annotate({ identifier: "Improvement.Check" })
export interface Check extends Schema.Schema.Type<typeof Check> {}

export const Implementation = Schema.Struct({
  status: Schema.Literals(["preparing", "running", "verifying", "completed", "failed"]),
  harness: Comparison.Harness,
  directory: optional(AbsolutePath),
  branch: optional(Schema.String),
  sessionID: optional(SessionID),
  commit: optional(Schema.String),
  patch: optional(Schema.String),
  patchTruncated: Schema.Boolean,
  changes: Schema.Array(Comparison.FileChange),
  checks: Schema.Array(Check),
  error: optional(Schema.String),
  /** For a Stack-Agent target: the validated build of the implementation commit the candidate arm runs. */
  generation: optional(Schema.String),
}).annotate({ identifier: "Improvement.Implementation" })
export interface Implementation extends Schema.Schema.Type<typeof Implementation> {}

export const Rate = Schema.Struct({ runs: NonNegativeInt, verified: NonNegativeInt, successes: NonNegativeInt })

export const HarnessResult = Schema.Struct({
  harness: Comparison.Harness,
  target: Schema.Boolean,
  baseline: Rate,
  candidate: Rate,
  pImproved: optional(Schema.Finite),
  pRegressed: optional(Schema.Finite),
  criterionRegressions: Schema.Array(Schema.String),
  metrics: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      label: Schema.String,
      baseline: optional(Schema.Finite),
      candidate: optional(Schema.Finite),
    }),
  ),
}).annotate({ identifier: "Improvement.HarnessResult" })
export interface HarnessResult extends Schema.Schema.Type<typeof HarnessResult> {}

export const Evaluation = Schema.Struct({
  status: Schema.Literals(["baseline", "candidate", "completed"]),
  results: Schema.Array(HarnessResult),
  verdict: optional(Disposition),
  reason: optional(Schema.String),
  runtime: optional(Schema.Struct({ baseline: optional(RuntimeRef), candidate: optional(RuntimeRef) })),
}).annotate({ identifier: "Improvement.Evaluation" })
export interface Evaluation extends Schema.Schema.Type<typeof Evaluation> {}

/** Applying an evaluated Stack-Agent change to its source repository as a reviewable branch. */
export const Application = Schema.Struct({
  status: Schema.Literals(["applying", "applied", "conflict", "failed"]),
  sourceDirectory: AbsolutePath,
  /** The branch the change is based on; it is never modified. */
  targetBranch: Schema.String,
  /** That branch's tip when the change was applied. */
  tip: Schema.String,
  /** The revision the change was implemented and evaluated against. */
  tested: Schema.String,
  /** The target moved since the change was tested. */
  drift: Schema.Boolean,
  conflicts: Schema.Array(Schema.String),
  directory: optional(AbsolutePath),
  branch: optional(Schema.String),
  commit: optional(Schema.String),
  /** The applied commit's source tree equals the evaluated implementation's. */
  sameSource: optional(Schema.Boolean),
  diff: optional(Schema.String),
  diffTruncated: Schema.Boolean,
  checks: Schema.Array(Check),
  error: optional(Schema.String),
  appliedAt: optional(Schema.Finite),
  /** The generation built from the applied commit, ready to activate. */
  build: optional(Schema.String),
  published: optional(Schema.Struct({ remote: Schema.String, at: Schema.Finite, output: Schema.String })),
}).annotate({ identifier: "Improvement.Application" })
export interface Application extends Schema.Schema.Type<typeof Application> {}

/** What applying would do right now, computed without touching any branch or worktree. */
export const ApplyPreview = Schema.Struct({
  sourceDirectory: AbsolutePath,
  targetBranch: Schema.String,
  tip: optional(Schema.String),
  tested: Schema.String,
  drift: Schema.Boolean,
  conflicts: Schema.Array(Schema.String),
  files: Schema.Array(Schema.String),
  remote: optional(Schema.String),
  blocker: optional(Schema.String),
}).annotate({ identifier: "Improvement.ApplyPreview" })
export interface ApplyPreview extends Schema.Schema.Type<typeof ApplyPreview> {}

export const Stage = Schema.Literals([
  "investigating",
  "proposed",
  "needs-proposal",
  "baseline",
  "implementing",
  "candidate",
  "evaluated",
  "decided",
]).annotate({ identifier: "Improvement.Stage" })
export type Stage = typeof Stage.Type

/** Written once at creation: the finding exactly as it stood, and the revision every later stage starts from. */
export const Definition = Schema.Struct({
  id: ID,
  createdAt: Schema.Finite,
  directory: AbsolutePath,
  projectID: Project.ID,
  baseRevision: Schema.String,
  finding: Finding,
  target: optional(Target),
  /** For a Stack-Agent target: the source repository and the revision investigation and implementation start from. */
  source: optional(
    Schema.Struct({ directory: AbsolutePath, projectID: Project.ID, branch: Schema.String, revision: Schema.String }),
  ),
}).annotate({ identifier: "Improvement.Definition" })
export interface Definition extends Schema.Schema.Type<typeof Definition> {}

export const State = Schema.Struct({
  stage: Stage,
  investigations: Schema.Array(Investigation),
  plan: optional(Plan),
  implementation: optional(Implementation),
  evaluation: optional(Evaluation),
  decision: optional(Schema.Struct({ decision: Decision, at: Schema.Finite, note: optional(Schema.String) })),
  application: optional(Application),
  error: optional(Schema.String),
}).annotate({ identifier: "Improvement.State" })
export interface State extends Schema.Schema.Type<typeof State> {}

export const Info = Schema.Struct({ definition: Definition, state: State }).annotate({
  identifier: "Improvement.Info",
})
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const Summary = Schema.Struct({
  id: ID,
  title: Schema.String,
  findingID: Schema.String,
  createdAt: Schema.Finite,
  stage: Stage,
  verdict: optional(Disposition),
  decision: optional(Decision),
}).annotate({ identifier: "Improvement.Summary" })
export interface Summary extends Schema.Schema.Type<typeof Summary> {}

export const CreateInput = Schema.Struct({
  directory: AbsolutePath,
  findingID: Schema.String,
  target: optional(Target),
}).annotate({
  identifier: "Improvement.CreateInput",
})
export interface CreateInput extends Schema.Schema.Type<typeof CreateInput> {}

export const ApproveInput = Schema.Struct({ attempt: NonNegativeInt, harness: Comparison.Harness }).annotate({
  identifier: "Improvement.ApproveInput",
})
export interface ApproveInput extends Schema.Schema.Type<typeof ApproveInput> {}

export const DecideInput = Schema.Struct({ decision: Decision, note: optional(Schema.String) }).annotate({
  identifier: "Improvement.DecideInput",
})
export interface DecideInput extends Schema.Schema.Type<typeof DecideInput> {}
