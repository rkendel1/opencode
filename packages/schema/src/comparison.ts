export * as Comparison from "./comparison.js"

import { Schema } from "effect"
import { ascending } from "./identifier.js"
import { Model } from "./model.js"
import { Project } from "./project.js"
import { AbsolutePath, NonNegativeInt, optional, statics } from "./schema.js"
import { SessionID } from "./session-id.js"

export const ID = Schema.String.check(Schema.isStartingWith("cmp")).pipe(
  Schema.brand("Comparison.ID"),
  Schema.annotate({ identifier: "Comparison.ID" }),
  statics((schema) => ({
    create: () => schema.make("cmp_" + ascending()),
  })),
)
export type ID = typeof ID.Type

/** The agent runtime a run uses; it is stored on the run's Session as `metadata.harness`. */
export const Harness = Schema.Literals(["opencode", "stack-agent"]).annotate({ identifier: "Comparison.Harness" })
export type Harness = typeof Harness.Type

export const Category = Schema.Literals([
  "investigation",
  "implementation",
  "bug-fix",
  "failure-recovery",
  "terminal-workflow",
]).annotate({ identifier: "Comparison.Category" })
export type Category = typeof Category.Type

/**
 * One acceptance criterion. A criterion with a command is verified by running it in the run's workspace after the
 * agent stops; exit status 0 passes. A criterion without one cannot be verified automatically and stays unverified.
 */
export const Criterion = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  command: optional(Schema.String),
}).annotate({ identifier: "Comparison.Criterion" })
export interface Criterion extends Schema.Schema.Type<typeof Criterion> {}

export const Task = Schema.Struct({
  title: Schema.String,
  prompt: Schema.String,
  category: Category,
  criteria: Schema.Array(Criterion),
}).annotate({ identifier: "Comparison.Task" })
export interface Task extends Schema.Schema.Type<typeof Task> {}

export const CreateInput = Schema.Struct({
  directory: AbsolutePath,
  task: Task,
  /** Both runs use this model. Omitted, each Session resolves the default model. */
  model: optional(Model.Ref),
  /** Overrides the model for the stack-agent run only, to compare models rather than runtimes. */
  stackAgentModel: optional(Model.Ref),
  rerunOf: optional(ID),
}).annotate({ identifier: "Comparison.CreateInput" })
export interface CreateInput extends Schema.Schema.Type<typeof CreateInput> {}

/** A measured value with where it came from. An unavailable metric has no value; it is never reported as zero. */
export const Metric = Schema.Struct({
  label: Schema.String,
  value: optional(Schema.Finite),
  unit: optional(Schema.String),
  available: Schema.Boolean,
  /** observed: counted directly from records. inferred: derived from observed records by a stated rule. */
  kind: Schema.Literals(["observed", "inferred"]),
  source: Schema.String,
  method: Schema.String,
}).annotate({ identifier: "Comparison.Metric" })
export interface Metric extends Schema.Schema.Type<typeof Metric> {}

/** A verification command the evaluator ran itself, with its exit status and the tail of its output. */
export const Evidence = Schema.Struct({
  label: Schema.String,
  command: optional(Schema.String),
  exitCode: optional(Schema.Finite),
  output: optional(Schema.String),
}).annotate({ identifier: "Comparison.Evidence" })
export interface Evidence extends Schema.Schema.Type<typeof Evidence> {}

export const CriterionStatus = Schema.Literals(["passed", "failed", "unverified", "not-run"])
export type CriterionStatus = typeof CriterionStatus.Type

export const CriterionResult = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  status: CriterionStatus,
  /** The same command run in the workspace before the agent started. */
  baseline: optional(CriterionStatus),
  /** Passed before the agent started and fails after it stopped. */
  regression: Schema.Boolean,
  evidence: Schema.Array(Evidence),
}).annotate({ identifier: "Comparison.CriterionResult" })
export interface CriterionResult extends Schema.Schema.Type<typeof CriterionResult> {}

export const Outcome = Schema.Literals(["verified-success", "partial", "failed", "unverified", "cancelled"]).annotate({
  identifier: "Comparison.Outcome",
})
export type Outcome = typeof Outcome.Type

export const FileChange = Schema.Struct({
  path: Schema.String,
  status: Schema.Literals(["modified", "added", "deleted", "renamed", "untracked"]),
  additions: optional(NonNegativeInt),
  deletions: optional(NonNegativeInt),
}).annotate({ identifier: "Comparison.FileChange" })
export interface FileChange extends Schema.Schema.Type<typeof FileChange> {}

/** One entry of a run's activity feed; `messageID` and `toolCallID` locate the persisted record it came from. */
export const Activity = Schema.Struct({
  messageID: Schema.String,
  toolCallID: optional(Schema.String),
  at: Schema.Finite,
  kind: Schema.Literals(["step", "tool", "tool-failed", "terminal", "terminal-failed", "retry"]),
  label: Schema.String,
  detail: optional(Schema.String),
}).annotate({ identifier: "Comparison.Activity" })
export interface Activity extends Schema.Schema.Type<typeof Activity> {}

/** Everything folded from a run's persisted Session messages; recomputed while the run is live. */
export const Observation = Schema.Struct({
  /** The Session's recorded outcome of its last execution; absent while it runs. */
  execution: optional(Schema.Literals(["succeeded", "failed", "interrupted"])),
  /** The last step's error, when the agent stopped on one. */
  error: optional(Schema.String),
  startedAt: optional(Schema.Finite),
  endedAt: optional(Schema.Finite),
  models: Schema.Array(Model.Ref),
  metrics: Schema.Array(Schema.Struct({ key: Schema.String, metric: Metric })),
  activity: Schema.Array(Activity),
  /** The last assistant text: what the agent says it did. Never used to decide the outcome. */
  claim: optional(Schema.String),
}).annotate({ identifier: "Comparison.Observation" })
export interface Observation extends Schema.Schema.Type<typeof Observation> {}

export const Report = Schema.Struct({
  outcome: Outcome,
  reason: Schema.String,
  criteria: Schema.Array(CriterionResult),
  changes: Schema.Array(FileChange),
  metrics: Schema.Array(Schema.Struct({ key: Schema.String, metric: Metric })),
  evaluatedAt: Schema.Finite,
}).annotate({ identifier: "Comparison.Report" })
export interface Report extends Schema.Schema.Type<typeof Report> {}

export const Fact = Schema.Struct({
  key: Schema.String,
  value: optional(Schema.String),
  source: Schema.String,
}).annotate({ identifier: "Comparison.Fact" })
export interface Fact extends Schema.Schema.Type<typeof Fact> {}

export const RunStatus = Schema.Literals([
  "preparing",
  "running",
  "evaluating",
  "completed",
  "failed-to-start",
  "cancelled",
]).annotate({ identifier: "Comparison.RunStatus" })
export type RunStatus = typeof RunStatus.Type

/** The mutable state of one run. Its definition lives on the immutable comparison record. */
export const Run = Schema.Struct({
  harness: Harness,
  status: RunStatus,
  sessionID: optional(SessionID),
  directory: optional(AbsolutePath),
  /** Agent implementation, version, permissions and other environment identity, each with its source. */
  environment: Schema.Array(Fact),
  baseline: Schema.Array(
    Schema.Struct({ id: Schema.String, status: CriterionStatus, exitCode: optional(Schema.Finite) }),
  ),
  cancelRequested: Schema.Boolean,
  error: optional(Schema.String),
  createdAt: Schema.Finite,
  observation: optional(Observation),
  report: optional(Report),
}).annotate({ identifier: "Comparison.Run" })
export interface Run extends Schema.Schema.Type<typeof Run> {}

/** Written once when the comparison is created and never rewritten. */
export const Definition = Schema.Struct({
  id: ID,
  createdAt: Schema.Finite,
  task: Task,
  /** Stable across reruns of the same task and criteria, so repeated trials can be grouped. */
  taskKey: Schema.String,
  repository: Schema.Struct({
    projectID: Project.ID,
    directory: AbsolutePath,
    revision: Schema.String,
    branch: optional(Schema.String),
    /** Uncommitted changes in the source directory; they are not copied into either workspace. */
    dirty: Schema.Boolean,
  }),
  model: optional(Model.Ref),
  stackAgentModel: optional(Model.Ref),
  harnesses: Schema.Array(Harness),
  rerunOf: optional(ID),
}).annotate({ identifier: "Comparison.Definition" })
export interface Definition extends Schema.Schema.Type<typeof Definition> {}

export const Trial = Schema.Struct({
  harness: Harness,
  runs: NonNegativeInt,
  outcomes: Schema.Array(Schema.Struct({ outcome: Outcome, count: NonNegativeInt })),
}).annotate({ identifier: "Comparison.Trial" })
export interface Trial extends Schema.Schema.Type<typeof Trial> {}

export const Info = Schema.Struct({
  definition: Definition,
  runs: Schema.Array(Run),
  /** Reasons the two runs are not a controlled comparison. Empty means no known difference beyond the runtime. */
  qualifications: Schema.Array(Schema.String),
  /** Evaluated runs of comparisons sharing this task key, this one included. */
  trials: Schema.Array(Trial),
}).annotate({ identifier: "Comparison.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const Summary = Schema.Struct({
  id: ID,
  title: Schema.String,
  createdAt: Schema.Finite,
  directory: AbsolutePath,
  runs: Schema.Array(Schema.Struct({ harness: Harness, status: RunStatus, outcome: optional(Outcome) })),
}).annotate({ identifier: "Comparison.Summary" })
export interface Summary extends Schema.Schema.Type<typeof Summary> {}

export const CancelInput = Schema.Struct({ harness: optional(Harness) }).annotate({
  identifier: "Comparison.CancelInput",
})
export interface CancelInput extends Schema.Schema.Type<typeof CancelInput> {}
