export * as Comparison from "./comparison.js"

import path from "path"
import { Cause, Context, DateTime, Effect, Layer, Schema, Scope } from "effect"
import { ChildProcess } from "effect/process"
import { Comparison } from "@opencode/schema/comparison"
import type { SessionMessage } from "@opencode/schema/session-message"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { AppProcess } from "@opencode/util/process"
import { App } from "./app.js"
import { ComparisonCommand } from "./comparison/command.js"
import { ComparisonObserve } from "./comparison/observe.js"
import { ComparisonReport } from "./comparison/report.js"
import { ComparisonSettle } from "./comparison/settle.js"
import { KV } from "./kv.js"
import { Project } from "./project.js"
import { Session } from "./session.js"
import { StackAgentRuntime } from "./stack-agent-runtime.js"
import { gitExecutable } from "./util/git-executable.js"
import { Worktree } from "./worktree.js"

export const ID = Comparison.ID
export type ID = Comparison.ID
export type Info = Comparison.Info
export type Summary = Comparison.Summary
export type CreateInput = Comparison.CreateInput

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Comparison.NotFoundError", {
  id: Schema.String,
}) {}

export class InvalidInputError extends Schema.TaggedError<InvalidInputError>()("Comparison.InvalidInputError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly list: () => Effect.Effect<Summary[]>
  readonly get: (id: ID) => Effect.Effect<Info, NotFoundError>
  /** Records the comparison and starts both runs in the background; returns once the record exists. */
  readonly create: (input: CreateInput) => Effect.Effect<Info, InvalidInputError>
  /** Cancels one run, or both when no harness is given. Runs that already finished are left as they are. */
  readonly cancel: (id: ID, input: Comparison.CancelInput) => Effect.Effect<Info, NotFoundError>
  /** Starts a new comparison from the same task, criteria and models, at the repository's current revision. */
  readonly rerun: (id: ID) => Effect.Effect<Info, NotFoundError | InvalidInputError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Comparison") {}

const HARNESSES: readonly Comparison.Harness[] = ["opencode", "stack-agent"]
const UNTRACKED_LINE_LIMIT = 1_000_000
const MESSAGE_LIMIT = 100_000

const definitionKey = (id: string) => `comparison/def/${id}`
const runKey = (id: string, harness: Comparison.Harness) => `comparison/run/${id}/${harness}`

const decodeDefinition = Schema.decodeUnknownOption(Comparison.Definition)
const decodeRun = Schema.decodeUnknownOption(Comparison.Run)
const encodeDefinition = Schema.encodeSync(Comparison.Definition)
const encodeRun = Schema.encodeSync(Comparison.Run)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const kv = yield* KV.Service
    const sessions = yield* Session.Service
    const worktrees = yield* Worktree.Service
    const projects = yield* Project.Service
    const proc = yield* AppProcess.Service
    const app = yield* App.Metadata
    const runtime = yield* StackAgentRuntime.Service
    const scope = yield* Scope.Scope

    const readDefinition = Effect.fnUntraced(function* (id: string) {
      const value = yield* kv.get(definitionKey(id))
      const decoded = value === undefined ? undefined : decodeDefinition(value)
      if (decoded === undefined || decoded._tag === "None") return yield* new NotFoundError({ id })
      return decoded.value
    })

    const readRun = Effect.fnUntraced(function* (id: string, harness: Comparison.Harness) {
      const value = yield* kv.get(runKey(id, harness))
      const decoded = value === undefined ? undefined : decodeRun(value)
      return decoded?._tag === "Some" ? decoded.value : undefined
    })

    const writeRun = (id: string, run: Comparison.Run) => kv.set(runKey(id, run.harness), encodeRun(run) as Schema.Json)

    // Each read-modify-write of a run happens on that run's own fiber, except cancellation, which only sets a flag
    // the run fiber re-reads before it acts.
    const updateRun = Effect.fnUntraced(function* (
      id: string,
      harness: Comparison.Harness,
      update: (run: Comparison.Run) => Comparison.Run,
    ) {
      const run = yield* readRun(id, harness)
      if (!run) return undefined
      const next = update(run)
      yield* writeRun(id, next)
      return next
    })

    const git = (cwd: string, args: string[]) =>
      proc
        .run(ChildProcess.make(gitExecutable(), args, { cwd, stdin: "ignore" }), { maxOutputBytes: 8 * 1024 * 1024 })
        .pipe(Effect.map((result) => ({ exitCode: result.exitCode, stdout: result.stdout.toString("utf8") })))

    const shell = (cwd: string, command: string) => ComparisonCommand.run(proc, cwd, command)

    // The persisted message projection, not the raw event log: the server only keeps durable events when
    // configured to, while projections are always stored.
    const sessionMessages = (sessionID: Session.ID) =>
      sessions
        .messages({ sessionID, order: "asc", limit: MESSAGE_LIMIT })
        .pipe(Effect.orElseSucceed((): SessionMessage.Info[] => []))

    const observeSession = Effect.fnUntraced(function* (
      harness: Comparison.Harness,
      sessionID: Session.ID,
    ): Effect.fn.Return<Comparison.Observation> {
      const session = yield* sessions.get(sessionID).pipe(Effect.option)
      const observation = ComparisonObserve.observe(harness, yield* sessionMessages(sessionID))
      if (session._tag === "None") return observation
      return {
        ...observation,
        execution: session.value.outcome,
        endedAt: session.value.time.idle ? DateTime.toEpochMillis(session.value.time.idle) : observation.endedAt,
      }
    })

    const observeRun = Effect.fnUntraced(function* (run: Comparison.Run) {
      if (!run.sessionID) return run
      if (run.report) return run
      return { ...run, observation: yield* observeSession(run.harness, run.sessionID) }
    })

    const info = Effect.fnUntraced(function* (definition: Comparison.Definition) {
      const runs = yield* Effect.forEach(definition.harnesses, (harness) =>
        readRun(definition.id, harness).pipe(Effect.flatMap((run) => (run ? observeRun(run) : Effect.undefined))),
      ).pipe(Effect.map((runs) => runs.filter((run): run is Comparison.Run => run !== undefined)))
      return {
        definition,
        runs,
        qualifications: qualifications(definition, runs),
        trials: yield* trials(definition.taskKey),
      } satisfies Comparison.Info
    })

    const definitions = Effect.fnUntraced(function* () {
      const result: Comparison.Definition[] = []
      for (let after: string | undefined; ; ) {
        const page = yield* kv.scan({ prefix: "comparison/def/", after, limit: 1000 })
        for (const entry of page.entries) {
          const decoded = decodeDefinition(entry.value)
          if (decoded._tag === "Some") result.push(decoded.value)
        }
        if (!page.next) return result
        after = page.next
      }
    })

    const trials = Effect.fnUntraced(function* (key: string) {
      const related = (yield* definitions()).filter((definition) => definition.taskKey === key)
      const reports = yield* Effect.forEach(related, (definition) =>
        Effect.forEach(definition.harnesses, (harness) => readRun(definition.id, harness)),
      )
      return HARNESSES.map((harness) => {
        const outcomes = reports
          .flat()
          .flatMap((run) => (run?.harness === harness && run.report ? [run.report.outcome] : []))
        return {
          harness,
          runs: outcomes.length,
          outcomes: Comparison.Outcome.literals
            .map((outcome) => ({ outcome, count: outcomes.filter((item) => item === outcome).length }))
            .filter((item) => item.count > 0),
        }
      })
    })

    const environment = Effect.fnUntraced(function* (
      definition: Comparison.Definition,
      harness: Comparison.Harness,
      directory: string,
    ) {
      const model = harness === "stack-agent" ? (definition.stackAgentModel ?? definition.model) : definition.model
      const facts: Comparison.Fact[] = [
        { key: "Agent runtime", value: harness, source: "Session metadata.harness" },
        {
          key: "Requested model",
          value: model ? `${model.providerID}/${model.id}` : "Session default",
          source: "Comparison definition",
        },
        { key: "opencode version", value: app.version, source: "App metadata" },
        { key: "Starting revision", value: definition.repository.revision, source: "git rev-parse HEAD" },
        { key: "Agent", value: "Session default agent", source: "Session.create without an agent override" },
        { key: "Permissions", value: "Project defaults", source: "Session.create without a permission override" },
      ]
      if (harness === "opencode") return facts
      const resolved = yield* runtime.resolve(definition.stackAgentGeneration).pipe(Effect.option)
      const executable =
        resolved._tag === "Some" && (yield* Effect.promise(() => Bun.file(resolved.value.executable).exists()))
          ? resolved.value
          : undefined
      const version =
        executable?.version ??
        (executable
          ? yield* proc
              .run(ChildProcess.make(executable.executable, ["--version"], { cwd: directory, stdin: "ignore" }), {
                timeout: "5 seconds",
              })
              .pipe(
                Effect.map((result) => (result.exitCode === 0 ? result.stdout.toString("utf8").trim() : undefined)),
                Effect.orElseSucceed(() => undefined),
              )
          : undefined)
      const pax = Bun.which("pax")
      return [
        ...facts,
        {
          key: "stack-agent binary",
          value: executable?.executable,
          source: "Stack-Agent runtime manager (pinned, active, or STACK_AGENT_BIN / PATH fallback)",
        },
        {
          key: "stack-agent generation",
          value: executable ? (executable.generation ?? "unmanaged") : undefined,
          source: executable?.source ? `Resolved as ${executable.source}` : "Stack-Agent runtime manager",
        },
        { key: "stack-agent commit", value: executable?.commit, source: "Build record of the generation" },
        { key: "stack-agent version", value: version, source: "stack-agent --version" },
        {
          key: "PAX",
          value: pax ?? undefined,
          source: "PATH lookup; stack-agent uses PAX to verify changes and runs read-only without it",
        },
      ]
    })

    const baseline = (directory: string, task: Comparison.Task) =>
      Effect.forEach(
        task.criteria,
        (criterion): Effect.Effect<Comparison.Run["baseline"][number]> =>
          criterion.command === undefined
            ? Effect.succeed({ id: criterion.id, status: "not-run" })
            : shell(directory, criterion.command).pipe(
                Effect.map((result) => ({
                  id: criterion.id,
                  status: result.exitCode === 0 ? "passed" : "failed",
                  exitCode: result.exitCode,
                })),
              ),
      )

    const start = Effect.fnUntraced(function* (definition: Comparison.Definition, harness: Comparison.Harness) {
      const fail = (error: string) =>
        updateRun(definition.id, harness, (run) => ({ ...run, status: "failed-to-start", error }))
      const cancelled = Effect.gen(function* () {
        const run = yield* readRun(definition.id, harness)
        if (!run?.cancelRequested) return false
        yield* updateRun(definition.id, harness, (run) => ({ ...run, status: "cancelled" }))
        return true
      })

      const workspace = yield* worktrees
        .create({
          projectID: definition.repository.projectID,
          from: definition.repository.directory,
          branch: definition.repository.revision,
          name: `${definition.id}-${harness}`,
        })
        .pipe(Effect.result)
      if (workspace._tag === "Failure")
        return yield* fail(`Workspace could not be created: ${describe(workspace.failure)}`)
      const directory = workspace.success.directory
      const facts = yield* environment(definition, harness, directory)
      yield* updateRun(definition.id, harness, (run) => ({ ...run, directory, environment: facts }))
      if (harness === "stack-agent" && !facts.find((fact) => fact.key === "stack-agent binary")?.value)
        return yield* fail("stack-agent binary not found (set STACK_AGENT_BIN or add stack-agent to PATH)")

      const before = yield* baseline(directory, definition.task)
      yield* updateRun(definition.id, harness, (run) => ({ ...run, baseline: before }))
      if (yield* cancelled) return

      const model = harness === "stack-agent" ? (definition.stackAgentModel ?? definition.model) : definition.model
      const session = yield* sessions.create({
        location: { directory },
        title: `${definition.task.title} · ${harness}`,
        model,
        metadata: {
          harness,
          comparisonID: definition.id,
          ...(harness === "stack-agent" && definition.stackAgentGeneration
            ? { [StackAgentRuntime.PIN]: definition.stackAgentGeneration }
            : {}),
        },
      })
      yield* updateRun(definition.id, harness, (run) => ({ ...run, sessionID: session.id, status: "running" }))
      if (yield* cancelled) return
      const prompted = yield* sessions
        .prompt({ sessionID: session.id, text: definition.task.prompt })
        .pipe(Effect.result)
      if (prompted._tag === "Failure")
        return yield* fail(`The task could not be submitted: ${describe(prompted.failure)}`)
      yield* watch(definition, harness)
    })

    /** Waits until the run's Session settles, then evaluates it. */
    const watch = Effect.fnUntraced(function* (definition: Comparison.Definition, harness: Comparison.Harness) {
      const run = yield* readRun(definition.id, harness)
      if (!run?.sessionID) return
      yield* ComparisonSettle.untilSettled(sessions, run.sessionID)
      yield* evaluate(definition, harness)
    })

    const changes = Effect.fnUntraced(function* (directory: string, revision: string) {
      const numstat = yield* git(directory, ["diff", "--numstat", "-z", "-M", revision])
      const status = yield* git(directory, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
      const parsed = ComparisonReport.changes(numstat.stdout, status.stdout)
      return yield* Effect.forEach(parsed, (change) =>
        change.status !== "untracked"
          ? Effect.succeed(change)
          : Effect.promise(async () => {
              const file = Bun.file(path.join(directory, change.path))
              if (file.size > UNTRACKED_LINE_LIMIT) return change
              const text = await file.text().catch(() => undefined)
              if (text === undefined || text.includes("\0")) return change
              return { ...change, additions: text.split("\n").length - (text.endsWith("\n") ? 1 : 0), deletions: 0 }
            }),
      )
    })

    const evaluate = Effect.fnUntraced(function* (definition: Comparison.Definition, harness: Comparison.Harness) {
      const run = yield* updateRun(definition.id, harness, (run) => ({ ...run, status: "evaluating" }))
      if (!run?.sessionID || !run.directory) return
      const directory = run.directory
      const observation = yield* observeSession(harness, run.sessionID)
      const cancelled = run.cancelRequested
      const criteria = yield* Effect.forEach(definition.task.criteria, (criterion) =>
        Effect.gen(function* () {
          const before = run.baseline.find((item) => item.id === criterion.id)?.status
          const base = { id: criterion.id, description: criterion.description, baseline: before }
          if (cancelled) return { ...base, status: "not-run" as const, regression: false, evidence: [] }
          if (criterion.command === undefined)
            return {
              ...base,
              status: "unverified" as const,
              regression: false,
              evidence: [{ label: "No verification command; needs manual review" }],
            }
          const result = yield* shell(directory, criterion.command)
          const status = result.exitCode === 0 ? ("passed" as const) : ("failed" as const)
          return {
            ...base,
            status,
            regression: before === "passed" && status === "failed",
            evidence: [
              {
                label: `Evaluator ran the command in ${directory} (${result.durationMs} ms)`,
                command: criterion.command,
                exitCode: result.exitCode,
                output: result.output,
              },
            ],
          }
        }),
      )
      const changed = yield* changes(directory, definition.repository.revision)
      const lines = (key: "additions" | "deletions") =>
        changed.every((change) => change[key] !== undefined)
          ? ComparisonObserve.metric(
              key === "additions" ? "Lines added" : "Lines removed",
              changed.reduce((sum, change) => sum + (change[key] ?? 0), 0),
              "git diff --numstat against the starting revision",
              "Sum over changed files, untracked files counted by line",
            )
          : ComparisonObserve.unavailable(
              key === "additions" ? "Lines added" : "Lines removed",
              "At least one changed file is binary, so its line counts are unknown",
            )
      const classified = ComparisonReport.classify({ cancelled, criteria })
      const stopped =
        observation.execution === "failed" && !cancelled
          ? `; the agent's execution ended in failure${observation.error ? ` (${observation.error})` : ""}`
          : ""
      const verified = criteria.filter((item) => item.status === "passed" || item.status === "failed").length
      const report: Comparison.Report = {
        outcome: classified.outcome,
        reason: classified.reason + stopped,
        criteria,
        changes: changed,
        evaluatedAt: Date.now(),
        metrics: [
          {
            key: "duration",
            metric:
              observation.startedAt !== undefined && observation.endedAt !== undefined
                ? {
                    ...ComparisonObserve.metric(
                      "Wall-clock duration",
                      observation.endedAt - observation.startedAt,
                      "First assistant message → Session time.idle",
                      "Difference of persisted timestamps",
                    ),
                    unit: "ms",
                  }
                : ComparisonObserve.unavailable(
                    "Wall-clock duration",
                    "The Session never recorded an execution start and end",
                  ),
          },
          {
            key: "verificationCommands",
            metric: ComparisonObserve.metric(
              "Independently verified criteria",
              verified,
              "Evaluator command runs",
              "Criteria whose command the evaluator ran after the agent stopped",
            ),
          },
          {
            key: "filesChanged",
            metric: ComparisonObserve.metric(
              "Files changed",
              changed.length,
              "git diff --numstat and git status against the starting revision",
              "Count of changed, added, deleted and untracked files",
            ),
          },
          { key: "linesAdded", metric: lines("additions") },
          { key: "linesRemoved", metric: lines("deletions") },
          ...observation.metrics,
        ],
      }
      // What actually executed, which can differ from the resolution at start if a generation was activated between.
      const used = harness === "stack-agent" ? yield* runtime.usage(run.sessionID) : undefined
      const executed = [...new Set((used?.runs ?? []).map((item) => item.generation ?? `unmanaged ${item.executable}`))]
      yield* updateRun(definition.id, harness, (run) => ({
        ...run,
        environment:
          executed.length > 0
            ? [
                ...run.environment.filter((fact) => fact.key !== "Executed by"),
                { key: "Executed by", value: executed.join(", "), source: "Stack-Agent runtime usage record" },
              ]
            : run.environment,
        status: cancelled ? "cancelled" : "completed",
        error: run.error ?? observation.error,
        observation,
        report,
      }))
    })

    const launch = (
      definition: Comparison.Definition,
      harness: Comparison.Harness,
      work: Effect.Effect<unknown, unknown>,
    ) =>
      work.pipe(
        Effect.catchCause((cause) =>
          // Shutdown interrupts the fiber; recovery resumes the run on the next start.
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : updateRun(definition.id, harness, (run) => ({
                ...run,
                status: run.sessionID ? "completed" : "failed-to-start",
                error: run.error ?? `Comparison run stopped unexpectedly: ${Cause.pretty(cause)}`,
              })).pipe(Effect.asVoid),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
        Effect.asVoid,
      )

    const create = Effect.fn("Comparison.create")(function* (input: CreateInput) {
      const task = normalize(input.task)
      if (!task.prompt.trim()) return yield* new InvalidInputError({ message: "The task prompt is empty" })
      if (input.id) {
        const existing = yield* readDefinition(input.id).pipe(Effect.option)
        if (existing._tag === "Some") return yield* info(existing.value)
      }
      const project = yield* projects.resolve(input.directory)
      const head = yield* git(input.directory, ["rev-parse", "--verify", `${input.revision ?? "HEAD"}^{commit}`]).pipe(
        Effect.orElseSucceed(() => ({ exitCode: 1, stdout: "" })),
      )
      if (head.exitCode !== 0)
        return yield* new InvalidInputError({
          message: input.revision
            ? `Revision ${input.revision} is not a commit in this repository`
            : "Comparisons need a Git repository with at least one commit, so both workspaces share a revision",
        })
      const branch = yield* git(input.directory, ["rev-parse", "--abbrev-ref", "HEAD"]).pipe(Effect.option)
      const status = yield* git(input.directory, ["status", "--porcelain"]).pipe(Effect.option)
      const id = input.id ?? Comparison.ID.create()
      const definition: Comparison.Definition = {
        id,
        createdAt: Date.now(),
        task,
        taskKey: ComparisonReport.taskKey(project.id, task),
        repository: {
          projectID: project.id,
          directory: project.directory,
          revision: head.stdout.trim(),
          branch:
            !input.revision && branch._tag === "Some" && branch.value.exitCode === 0
              ? branch.value.stdout.trim()
              : undefined,
          dirty: status._tag === "Some" && status.value.stdout.trim() !== "",
        },
        model: input.model,
        stackAgentModel: input.stackAgentModel,
        harnesses: HARNESSES,
        rerunOf: input.rerunOf,
        origin: input.origin,
        stackAgentGeneration: input.stackAgentGeneration,
      }
      yield* kv.set(definitionKey(id), encodeDefinition(definition) as Schema.Json)
      yield* Effect.forEach(HARNESSES, (harness) =>
        writeRun(id, {
          harness,
          status: "preparing",
          environment: [],
          baseline: [],
          cancelRequested: false,
          createdAt: Date.now(),
        }),
      )
      yield* Effect.forEach(HARNESSES, (harness) => launch(definition, harness, start(definition, harness)))
      return yield* info(definition)
    })

    const cancel = Effect.fn("Comparison.cancel")(function* (id: ID, input: Comparison.CancelInput) {
      const definition = yield* readDefinition(id)
      yield* Effect.forEach(input.harness ? [input.harness] : definition.harnesses, (harness) =>
        Effect.gen(function* () {
          const run = yield* readRun(id, harness)
          if (!run || !["preparing", "running"].includes(run.status)) return
          yield* writeRun(id, { ...run, cancelRequested: true })
          // The watcher sees the Session go idle and evaluates the run as cancelled.
          if (run.sessionID) yield* sessions.interrupt(run.sessionID)
        }),
      )
      return yield* info(definition)
    })

    // Resume runs a previous process left mid-flight. Session recovery restarts the agents themselves.
    const recover = Effect.gen(function* () {
      for (const definition of yield* definitions()) {
        for (const harness of definition.harnesses) {
          const run = yield* readRun(definition.id, harness)
          if (run?.status === "running") yield* launch(definition, harness, watch(definition, harness))
          if (run?.status === "evaluating") yield* launch(definition, harness, evaluate(definition, harness))
          if (run?.status === "preparing")
            yield* writeRun(definition.id, {
              ...run,
              status: "failed-to-start",
              error: "The application stopped while this run's workspace was being prepared",
            })
        }
      }
    })
    yield* recover.pipe(Effect.forkIn(scope))

    return Service.of({
      list: Effect.fn("Comparison.list")(function* () {
        const all = yield* definitions()
        const summaries = yield* Effect.forEach(all, (definition) =>
          Effect.forEach(definition.harnesses, (harness) => readRun(definition.id, harness)).pipe(
            Effect.map((runs) => ({
              id: definition.id,
              title: definition.task.title,
              createdAt: definition.createdAt,
              directory: definition.repository.directory,
              origin: definition.origin,
              runs: runs
                .filter((run): run is Comparison.Run => run !== undefined)
                .map((run) => ({ harness: run.harness, status: run.status, outcome: run.report?.outcome })),
            })),
          ),
        )
        return summaries.toSorted((left, right) => right.createdAt - left.createdAt)
      }),
      get: Effect.fn("Comparison.get")(function* (id) {
        return yield* info(yield* readDefinition(id))
      }),
      create,
      cancel,
      rerun: Effect.fn("Comparison.rerun")(function* (id) {
        const definition = yield* readDefinition(id)
        return yield* create({
          directory: definition.repository.directory,
          task: definition.task,
          model: definition.model,
          stackAgentModel: definition.stackAgentModel,
          rerunOf: definition.id,
          stackAgentGeneration: definition.stackAgentGeneration,
        })
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [KV.node, Session.node, Worktree.node, Project.node, AppProcess.node, App.node, StackAgentRuntime.node],
})

function normalize(task: Comparison.Task): Comparison.Task {
  return {
    ...task,
    criteria: task.criteria
      .filter((criterion) => criterion.description.trim() || criterion.command?.trim())
      .map((criterion, index) => ({
        id: criterion.id.trim() || `criterion-${index + 1}`,
        description: criterion.description.trim() || (criterion.command ?? "").trim(),
        command: criterion.command?.trim() || undefined,
      })),
  }
}

/** Why these two runs are not a controlled comparison of agent runtimes alone. */
function qualifications(definition: Comparison.Definition, runs: readonly Comparison.Run[]) {
  const result: string[] = []
  if (definition.stackAgentModel)
    result.push("The runs use different requested models, so outcome differences mix model and runtime effects")
  const observed = runs.map((run) =>
    (run.observation?.models ?? []).map((model) => `${model.providerID}/${model.id}`).join(","),
  )
  if (observed.every(Boolean) && new Set(observed).size > 1)
    result.push(`The runs observed different models (${observed.join(" vs ")})`)
  const baselines = runs.map((run) => JSON.stringify(run.baseline.map((item) => [item.id, item.status])))
  if (runs.every((run) => run.baseline.length > 0) && new Set(baselines).size > 1)
    result.push("Acceptance commands gave different results in the two workspaces before either agent started")
  const stack = runs.find((run) => run.harness === "stack-agent")
  if (stack && stack.environment.length > 0 && !stack.environment.find((fact) => fact.key === "PAX")?.value)
    result.push("PAX is not on PATH, so stack-agent ran in read-only inspect mode and could not change files")
  if (stack)
    result.push(
      "stack-agent executes its own tools outside opencode's permission prompts; the opencode run is subject to them",
    )
  return result
}

function describe(error: unknown) {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string")
    return error.message
  if (error && typeof error === "object" && "_tag" in error) return String(error._tag)
  return String(error)
}
