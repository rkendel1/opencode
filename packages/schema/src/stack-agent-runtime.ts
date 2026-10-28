export * as StackAgentRuntime from "./stack-agent-runtime.js"

import { Schema } from "effect"
import { AbsolutePath, NonNegativeInt, optional } from "./schema.js"
import { SessionID } from "./session-id.js"

/** Where Stack-Agent source comes from and how a revision becomes an executable. */
export const Settings = Schema.Struct({
  /** A local Git checkout of the Stack-Agent repository. Builds never modify it; they use worktrees. */
  sourceDirectory: optional(AbsolutePath),
  /** The branch new revisions and applied improvements are based on. */
  branch: Schema.String,
  /** Run in the build worktree. `$CARGO_TARGET_DIR` is a shared, managed build cache. */
  buildCommand: Schema.Array(Schema.String),
  /** The built executable, relative to the build worktree or under `$CARGO_TARGET_DIR`. */
  artifact: Schema.String,
  /** Argument lists the candidate must run with exit status 0 before it can be activated. */
  smoke: Schema.Array(Schema.Array(Schema.String)),
  /** Checks run on an applied improvement branch before it is offered for review. */
  checks: Schema.Array(Schema.Array(Schema.String)),
  /** A Git remote that applied branches may be pushed to, only on explicit request. */
  remote: optional(Schema.String),
}).annotate({ identifier: "StackAgentRuntime.Settings" })
export interface Settings extends Schema.Schema.Type<typeof Settings> {}

export const SettingsInput = Schema.Struct({
  sourceDirectory: optional(AbsolutePath),
  branch: optional(Schema.String),
  buildCommand: optional(Schema.Array(Schema.String)),
  artifact: optional(Schema.String),
  smoke: optional(Schema.Array(Schema.Array(Schema.String))),
  checks: optional(Schema.Array(Schema.Array(Schema.String))),
  remote: optional(Schema.String),
}).annotate({ identifier: "StackAgentRuntime.SettingsInput" })
export interface SettingsInput extends Schema.Schema.Type<typeof SettingsInput> {}

export const CommandResult = Schema.Struct({
  command: Schema.String,
  exitCode: Schema.Finite,
  output: Schema.String,
  durationMs: NonNegativeInt,
}).annotate({ identifier: "StackAgentRuntime.CommandResult" })
export interface CommandResult extends Schema.Schema.Type<typeof CommandResult> {}

export const GenerationStatus = Schema.Literals(["building", "validating", "validated", "failed"]).annotate({
  identifier: "StackAgentRuntime.GenerationStatus",
})
export type GenerationStatus = typeof GenerationStatus.Type

/** One build of one source revision, stored at its own immutable path. Never overwritten once built. */
export const Generation = Schema.Struct({
  id: Schema.String,
  commit: Schema.String,
  /** The source tree hash: two commits with the same tree produce the same build input. */
  tree: Schema.String,
  sourceDirectory: AbsolutePath,
  createdAt: Schema.Finite,
  status: GenerationStatus,
  executable: optional(AbsolutePath),
  sha256: optional(Schema.String),
  /** What `stack-agent --version` printed. */
  version: optional(Schema.String),
  build: optional(CommandResult),
  smoke: Schema.Array(CommandResult),
  error: optional(Schema.String),
  origin: optional(Schema.Struct({ improvementID: Schema.String, purpose: Schema.String })),
}).annotate({ identifier: "StackAgentRuntime.Generation" })
export interface Generation extends Schema.Schema.Type<typeof Generation> {}

/** What a task actually ran: a managed generation, or the unmanaged executable from STACK_AGENT_BIN or PATH. */
export const Resolved = Schema.Struct({
  generation: optional(Schema.String),
  commit: optional(Schema.String),
  version: optional(Schema.String),
  executable: Schema.String,
  /** pinned: the Session asked for this generation. active: the runtime's active one. external: fallback. */
  source: Schema.Literals(["pinned", "active", "external"]),
}).annotate({ identifier: "StackAgentRuntime.Resolved" })
export interface Resolved extends Schema.Schema.Type<typeof Resolved> {}

export const Usage = Schema.Struct({
  sessionID: SessionID,
  runs: Schema.Array(
    Schema.Struct({
      ...Resolved.fields,
      startedAt: Schema.Finite,
      endedAt: optional(Schema.Finite),
      exitCode: optional(Schema.Finite),
    }),
  ),
}).annotate({ identifier: "StackAgentRuntime.Usage" })
export interface Usage extends Schema.Schema.Type<typeof Usage> {}

export const Event = Schema.Struct({
  at: Schema.Finite,
  kind: Schema.Literals(["built", "build-failed", "activated", "activation-failed", "rolled-back", "interrupted"]),
  generation: optional(Schema.String),
  previous: optional(Schema.String),
  message: Schema.String,
}).annotate({ identifier: "StackAgentRuntime.Event" })
export interface Event extends Schema.Schema.Type<typeof Event> {}

export const State = Schema.Struct({
  active: optional(Schema.String),
  /** Earlier active generations, newest first: the rollback chain. */
  previous: Schema.Array(Schema.String),
  operation: optional(
    Schema.Struct({ kind: Schema.Literals(["build"]), generation: Schema.String, startedAt: Schema.Finite }),
  ),
  lastCheck: optional(
    Schema.Struct({
      at: Schema.Finite,
      branch: Schema.String,
      tip: optional(Schema.String),
      error: optional(Schema.String),
    }),
  ),
  events: Schema.Array(Event),
}).annotate({ identifier: "StackAgentRuntime.State" })
export interface State extends Schema.Schema.Type<typeof State> {}

export const Status = Schema.Struct({
  settings: Settings,
  state: State,
  generations: Schema.Array(Generation),
  /** The executable new tasks would use right now. */
  current: Resolved,
  /** Tasks running now, and the generation each one started with. */
  running: Schema.Array(Schema.Struct({ sessionID: SessionID, startedAt: Schema.Finite, resolved: Resolved })),
}).annotate({ identifier: "StackAgentRuntime.Status" })
export interface Status extends Schema.Schema.Type<typeof Status> {}

export const BuildInput = Schema.Struct({
  /** A commit, tag or branch in the source repository. Omitted, the configured branch's tip. */
  revision: optional(Schema.String),
}).annotate({ identifier: "StackAgentRuntime.BuildInput" })
export interface BuildInput extends Schema.Schema.Type<typeof BuildInput> {}

export const CheckInput = Schema.Struct({
  /** Fetch the configured remote first. Off by default: a local checkout needs no network. */
  fetch: optional(Schema.Boolean),
}).annotate({ identifier: "StackAgentRuntime.CheckInput" })
export interface CheckInput extends Schema.Schema.Type<typeof CheckInput> {}
