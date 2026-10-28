export * as Improvement from "./improvement.js"

import path from "path"
import { Context, Effect, Layer, Schema, Scope } from "effect"
import { ChildProcess } from "effect/process"
import { Agent } from "@opencode/schema/agent"
import type { Comparison as ComparisonSchema } from "@opencode/schema/comparison"
import { Improvement } from "@opencode/schema/improvement"
import type { SessionMessage } from "@opencode/schema/session-message"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { AppProcess } from "@opencode/util/process"
import { Comparison } from "./comparison.js"
import { ComparisonCommand } from "./comparison/command.js"
import { ComparisonReport } from "./comparison/report.js"
import { ComparisonSettle } from "./comparison/settle.js"
import { KeyedMutex } from "./effect/keyed-mutex.js"
import { ImprovementAnalysis } from "./improvement/analysis.js"
import { ImprovementEvaluate } from "./improvement/evaluate.js"
import { ImprovementProposal } from "./improvement/proposal.js"
import { KV } from "./kv.js"
import { Project } from "./project.js"
import type { AbsolutePath } from "./schema.js"
import { Session } from "./session.js"
import { StackAgentRuntime } from "./stack-agent-runtime.js"
import { gitExecutable } from "./util/git-executable.js"
import { Worktree } from "./worktree.js"

export const ID = Improvement.ID
export type ID = Improvement.ID
export type Info = Improvement.Info

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Improvement.NotFoundError", {
  id: Schema.String,
}) {}

export class InvalidInputError extends Schema.TaggedError<InvalidInputError>()("Improvement.InvalidInputError", {
  message: Schema.String,
}) {}

export interface Interface {
  /** Runs the ML stage over this project's verified comparison history. */
  readonly analysis: (directory: AbsolutePath) => Effect.Effect<Improvement.Analysis>
  readonly list: () => Effect.Effect<Improvement.Summary[]>
  readonly get: (id: ID) => Effect.Effect<Info, NotFoundError>
  /** Snapshots a supported finding and starts an LLM investigation of it. */
  readonly create: (input: Improvement.CreateInput) => Effect.Effect<Info, InvalidInputError>
  /** Starts another investigation after an invalid or unsatisfying proposal. */
  readonly investigate: (id: ID) => Effect.Effect<Info, NotFoundError | InvalidInputError>
  /** The user's authorization: fixes the evaluation plan, then runs baseline, implementation and candidate. */
  readonly approve: (id: ID, input: Improvement.ApproveInput) => Effect.Effect<Info, NotFoundError | InvalidInputError>
  /** The reviewer's decision on an evaluated intervention. */
  readonly decide: (id: ID, input: Improvement.DecideInput) => Effect.Effect<Info, NotFoundError | InvalidInputError>
  /** What applying a Stack-Agent change would do now: target tip, drift and conflicts. Changes nothing. */
  readonly preview: (id: ID) => Effect.Effect<Improvement.ApplyPreview, NotFoundError | InvalidInputError>
  /** The user's explicit approval to apply the evaluated change to Stack-Agent as a new, reviewable branch. */
  readonly apply: (id: ID) => Effect.Effect<Info, NotFoundError | InvalidInputError>
  /** Builds and validates the applied commit as a runtime generation, ready to activate. */
  readonly stage: (id: ID) => Effect.Effect<Info, NotFoundError | InvalidInputError>
  /** Pushes the applied branch to the configured remote, only when asked. */
  readonly publish: (id: ID) => Effect.Effect<Info, NotFoundError | InvalidInputError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Improvement") {}

/** The predefined decision threshold for one-sided exact tests on verified success. */
const ALPHA = 0.1
const PATCH_LIMIT = 100_000
const COMPARISON_POLL = "1 second"
const COMMIT_IDENTITY = ["-c", "user.name=OpenCode Improvement Lab", "-c", "user.email=improvement-lab@opencode.local"]

const definitionKey = (id: string) => `improvement/def/${id}`
const stateKey = (id: string) => `improvement/state/${id}`
const decodeDefinition = Schema.decodeUnknownOption(Improvement.Definition)
const decodeState = Schema.decodeUnknownOption(Improvement.State)
const encodeDefinition = Schema.encodeSync(Improvement.Definition)
const encodeState = Schema.encodeSync(Improvement.State)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const kv = yield* KV.Service
    const sessions = yield* Session.Service
    const comparisons = yield* Comparison.Service
    const worktrees = yield* Worktree.Service
    const projects = yield* Project.Service
    const proc = yield* AppProcess.Service
    const runtime = yield* StackAgentRuntime.Service
    const scope = yield* Scope.Scope
    const locks = KeyedMutex.makeUnsafe<string>()
    const running = new Set<string>()

    const readDefinition = Effect.fnUntraced(function* (id: string) {
      const value = yield* kv.get(definitionKey(id))
      const decoded = value === undefined ? undefined : decodeDefinition(value)
      if (decoded?._tag !== "Some") return yield* new NotFoundError({ id })
      return decoded.value
    })

    const readState = Effect.fnUntraced(function* (id: string) {
      const value = yield* kv.get(stateKey(id))
      const decoded = value === undefined ? undefined : decodeState(value)
      if (decoded?._tag !== "Some") return yield* new NotFoundError({ id })
      return decoded.value
    })

    const update = (id: string, change: (state: Improvement.State) => Improvement.State) =>
      locks.withLock(id)(
        Effect.gen(function* () {
          const next = change(yield* readState(id).pipe(Effect.orDie))
          yield* kv.set(stateKey(id), encodeState(next) as Schema.Json)
          return next
        }),
      )

    const info = (id: string) =>
      Effect.all({ definition: readDefinition(id), state: readState(id) }) satisfies Effect.Effect<Info, NotFoundError>

    const ids = Effect.gen(function* () {
      const result: string[] = []
      for (let after: string | undefined; ; ) {
        const page = yield* kv.scan({ prefix: "improvement/def/", after, limit: 1000 })
        result.push(...page.entries.map((entry) => entry.key.slice("improvement/def/".length)))
        if (!page.next) return result
        after = page.next
      }
    })

    const git = (cwd: string, args: string[]) =>
      proc
        .run(ChildProcess.make(gitExecutable(), args, { cwd, stdin: "ignore" }), { maxOutputBytes: 8 * 1024 * 1024 })
        .pipe(
          Effect.map((result) => ({
            exitCode: result.exitCode,
            stdout: result.stdout.toString("utf8"),
            stderr: result.stderr.toString("utf8"),
          })),
          // Callers branch on the exit status; a spawn failure is just another failed command.
          Effect.catch((error) => Effect.succeed({ exitCode: -1, stdout: "", stderr: error.message })),
        )

    const comparisonInfos = Effect.gen(function* () {
      const summaries = yield* comparisons.list()
      return yield* Effect.forEach(summaries, (summary) => comparisons.get(summary.id).pipe(Effect.option)).pipe(
        Effect.map((items) => items.flatMap((item) => (item._tag === "Some" ? [item.value] : []))),
      )
    })

    // Earlier interventions per finding, so a validated change becomes evidence for later diagnoses.
    const history = Effect.gen(function* () {
      const items = yield* Effect.forEach(yield* ids, (id) => info(id).pipe(Effect.option))
      const result = new Map<string, Improvement.Finding["history"][number][]>()
      for (const item of items) {
        if (item._tag === "None") continue
        const verdict = item.value.state.evaluation?.verdict
        const decision = item.value.state.decision?.decision
        const list = result.get(item.value.definition.finding.id) ?? []
        list.push({
          improvementID: item.value.definition.id,
          verdict,
          decision,
          validated: verdict === "improved" && decision === "accept",
        })
        result.set(item.value.definition.finding.id, list)
      }
      return result
    })

    const analysis = Effect.fn("Improvement.analysis")(function* (directory: AbsolutePath) {
      const project = yield* projects.resolve(directory)
      const infos = (yield* comparisonInfos).filter((item) => item.definition.repository.projectID === project.id)
      return ImprovementAnalysis.analyze(ImprovementAnalysis.records(infos), yield* history)
    })

    const sourceTask = Effect.fnUntraced(function* (projectID: string, taskKey: string) {
      const infos = yield* comparisonInfos
      return infos
        .filter(
          (item) =>
            !item.definition.origin &&
            item.definition.repository.projectID === projectID &&
            item.definition.taskKey === taskKey,
        )
        .toSorted((left, right) => right.definition.createdAt - left.definition.createdAt)[0]?.definition
    })

    const launch = (id: string, work: Effect.Effect<unknown, unknown>) =>
      Effect.suspend(() => {
        if (running.has(id)) return Effect.void
        running.add(id)
        return work.pipe(
          Effect.catchCause((cause) =>
            update(id, (state) => ({ ...state, error: `The pipeline stopped unexpectedly: ${String(cause)}` })),
          ),
          Effect.ensuring(Effect.sync(() => running.delete(id))),
          Effect.forkIn(scope, { startImmediately: true }),
          Effect.asVoid,
        )
      })

    const messages = (sessionID: Session.ID) =>
      sessions
        .messages({ sessionID, order: "asc", limit: 100_000 })
        .pipe(Effect.orElseSucceed((): SessionMessage.Info[] => []))

    // --- Investigate -------------------------------------------------------------------------------------------

    const investigation = Effect.fnUntraced(function* (definition: Improvement.Definition, attempt: number) {
      const record = (change: Partial<Improvement.Investigation>) =>
        update(definition.id, (state) => ({
          ...state,
          investigations: state.investigations.map((item) =>
            item.attempt === attempt ? { ...item, ...change } : item,
          ),
        }))
      const state = yield* readState(definition.id)
      const current = state.investigations.find((item) => item.attempt === attempt)
      if (!current || current.status !== "running") return
      const sessionID = current.sessionID ?? (yield* startInvestigation(definition, attempt))
      if (!sessionID) return
      yield* record({ sessionID })
      yield* ComparisonSettle.untilSettled(sessions, sessionID)
      const workspace = (yield* sessions.get(sessionID)).location.directory
      const result = ImprovementProposal.parse({
        text: ImprovementProposal.lastAnswer(yield* messages(sessionID)),
        finding: definition.finding,
        opened: ImprovementProposal.openedPaths(yield* messages(sessionID), workspace),
        exists: (file) => Bun.file(path.join(workspace, file)).exists(),
      })
      const parsed = yield* Effect.promise(() => result).pipe(
        Effect.map((parsed) =>
          definition.target === "stack-agent" &&
          parsed.proposal &&
          !parsed.proposal.evaluation.targetRuntimes.includes("stack-agent")
            ? { errors: ["A Stack-Agent change must list stack-agent among its target runtimes"] }
            : parsed,
        ),
      )
      yield* record(
        parsed.proposal
          ? { status: "valid", proposal: parsed.proposal, errors: [] }
          : { status: "invalid", errors: parsed.errors },
      )
      yield* update(definition.id, (state) => ({ ...state, stage: parsed.proposal ? "proposed" : "needs-proposal" }))
    })

    const startInvestigation = Effect.fnUntraced(function* (definition: Improvement.Definition, attempt: number) {
      const fail = (message: string) =>
        update(definition.id, (state) => ({
          ...state,
          stage: "needs-proposal",
          investigations: state.investigations.map((item) =>
            item.attempt === attempt ? { ...item, status: "failed", errors: [message] } : item,
          ),
        })).pipe(Effect.as(undefined))
      // A read-only copy at the base revision, so the investigation reads exactly what implementation will change.
      const workspace = yield* worktrees
        .create({
          projectID: site(definition).projectID,
          from: site(definition).directory,
          branch: site(definition).revision,
          name: `${definition.id}-investigate-${attempt}`,
        })
        .pipe(Effect.result)
      if (workspace._tag === "Failure")
        return yield* fail(`Workspace could not be created: ${describe(workspace.failure)}`)
      const traces = yield* Effect.forEach(definition.finding.evidence.slice(0, 6), (item) =>
        comparisons.get(item.comparisonID).pipe(
          Effect.map((found) => ({
            evidence: item,
            activity: found.runs.find((run) => run.harness === item.harness)?.observation?.activity.slice(-15) ?? [],
          })),
          Effect.orElseSucceed(() => ({ evidence: item, activity: [] })),
        ),
      )
      const session = yield* sessions.create({
        location: { directory: workspace.success.directory },
        agent: Agent.ID.make("plan"),
        title: `Investigate: ${definition.finding.title}`,
        metadata: { harness: "opencode", improvementID: definition.id },
      })
      const prompted = yield* sessions
        .prompt({
          sessionID: session.id,
          text: ImprovementProposal.prompt(definition.finding, traces, definition.target ?? "project"),
        })
        .pipe(Effect.result)
      if (prompted._tag === "Failure")
        return yield* fail(`The investigation could not start: ${describe(prompted.failure)}`)
      return session.id
    })

    // --- Evaluate (baseline and candidate) ---------------------------------------------------------------------

    const runVariant = Effect.fnUntraced(function* (
      definition: Improvement.Definition,
      plan: Improvement.Plan,
      variant: "baseline" | "candidate",
      revision: string,
      pin?: string,
    ) {
      for (const planned of plan.runs.filter((item) => item.variant === variant)) {
        const task = yield* sourceTask(definition.projectID, planned.taskKey)
        if (!task) return `No recorded task matches evaluation task ${planned.taskKey}`
        // The planned ID makes this idempotent: after a restart an already started comparison is adopted, not repeated.
        yield* comparisons
          .create({
            id: planned.comparisonID,
            revision,
            origin: { improvementID: definition.id, variant },
            directory: definition.directory,
            task: task.task,
            model: task.model,
            stackAgentModel: task.stackAgentModel,
            stackAgentGeneration: pin,
          })
          .pipe(Effect.orDie)
        while (true) {
          const current = yield* comparisons.get(planned.comparisonID).pipe(Effect.orDie)
          if (current.runs.every((run) => ["completed", "cancelled", "failed-to-start"].includes(run.status))) break
          yield* Effect.sleep(COMPARISON_POLL)
        }
      }
      return undefined
    })

    const results = Effect.fnUntraced(function* (plan: Improvement.Plan) {
      const runs = yield* Effect.forEach(plan.runs, (planned) =>
        comparisons.get(planned.comparisonID).pipe(
          Effect.map((found) => ({ variant: planned.variant, runs: found.runs })),
          Effect.orElseSucceed(() => ({ variant: planned.variant, runs: [] as ComparisonSchema.Run[] })),
        ),
      )
      return ImprovementEvaluate.compare(runs, plan)
    })

    // --- Implement ---------------------------------------------------------------------------------------------

    const implement = Effect.fnUntraced(function* (definition: Improvement.Definition, plan: Improvement.Plan) {
      const proposal = (yield* readState(definition.id)).investigations.find(
        (item) => item.attempt === plan.attempt,
      )?.proposal
      if (!proposal) return yield* failImplementation(definition.id, "The approved proposal is missing")
      const existing = (yield* readState(definition.id)).implementation
      // Restart recovery: a workspace whose creation was interrupted cannot be adopted safely, so the attempt
      // fails visibly instead of creating a second workspace for the same approval.
      if (existing && !existing.directory)
        return yield* failImplementation(
          definition.id,
          "Interrupted while the implementation workspace was being created",
        )
      const directory = existing?.directory ?? (yield* prepareImplementation(definition, plan))
      if (!directory) return
      const sessionID = (yield* readState(definition.id)).implementation?.sessionID
      if (!sessionID) return
      yield* ComparisonSettle.untilSettled(sessions, sessionID)
      yield* setImplementation(definition.id, { status: "verifying" })
      const branch = `improvement/${definition.id}`
      const head = (yield* git(directory, ["rev-parse", "HEAD"])).stdout.trim()
      if (head === site(definition).revision) {
        yield* git(directory, ["switch", "-c", branch])
        yield* git(directory, ["add", "-A"])
        const staged = yield* git(directory, ["diff", "--cached", "--name-only"])
        if (!staged.stdout.trim()) return yield* failImplementation(definition.id, "The agent made no changes")
        const guard = ImprovementProposal.permissionChanges((yield* git(directory, ["diff", "--cached"])).stdout)
        if (guard.length > 0)
          return yield* failImplementation(
            definition.id,
            `The patch changes permission configuration (${guard.join(", ")}). Expanding permissions needs a manual review outside this pipeline, so it was not evaluated.`,
          )
        const committed = yield* git(directory, [
          ...COMMIT_IDENTITY,
          "commit",
          "-q",
          "-m",
          `improvement: ${proposal.title}\n\nImprovement ${definition.id}, finding ${definition.finding.id}.`,
        ])
        if (committed.exitCode !== 0)
          return yield* failImplementation(
            definition.id,
            `The change could not be committed: ${committed.stderr.trim()}`,
          )
      }
      const commit = (yield* git(directory, ["rev-parse", "HEAD"])).stdout.trim()
      const patch = (yield* git(directory, ["diff", site(definition).revision, commit])).stdout
      const changes = ComparisonReport.changes(
        (yield* git(directory, ["diff", "--numstat", "-z", "-M", site(definition).revision, commit])).stdout,
        "",
      )
      const checks = yield* Effect.forEach(proposal.acceptanceCriteria, (criterion) =>
        ComparisonCommand.run(proc, directory, criterion.command).pipe(
          Effect.map((result) => ({
            id: criterion.id,
            description: criterion.description,
            command: criterion.command,
            passed: result.exitCode === 0,
            exitCode: result.exitCode,
            output: result.output,
          })),
        ),
      )
      yield* setImplementation(definition.id, {
        branch,
        commit,
        patch: patch.slice(0, PATCH_LIMIT),
        patchTruncated: patch.length > PATCH_LIMIT,
        changes,
        checks,
      })
      const failing = checks.filter((check) => !check.passed)
      if (failing.length > 0)
        return yield* failImplementation(
          definition.id,
          `Acceptance checks failed: ${failing.map((check) => check.description || check.command).join("; ")}`,
        )
      if (definition.target === "stack-agent") {
        const generation = yield* candidateBuild(definition, commit)
        if (!generation) return
      }
      yield* setImplementation(definition.id, { status: "completed" })
      return commit
    })

    const prepareImplementation = Effect.fnUntraced(function* (
      definition: Improvement.Definition,
      plan: Improvement.Plan,
    ) {
      yield* update(definition.id, (state) => ({
        ...state,
        implementation: { status: "preparing", harness: plan.harness, patchTruncated: false, changes: [], checks: [] },
      }))
      const workspace = yield* worktrees
        .create({
          projectID: site(definition).projectID,
          from: site(definition).directory,
          branch: site(definition).revision,
          name: `${definition.id}-implement`,
        })
        .pipe(Effect.result)
      if (workspace._tag === "Failure")
        return yield* failImplementation(
          definition.id,
          `Workspace could not be created: ${describe(workspace.failure)}`,
        )
      const directory = workspace.success.directory
      yield* setImplementation(definition.id, { directory })
      const proposal = (yield* readState(definition.id)).investigations.find(
        (item) => item.attempt === plan.attempt,
      )?.proposal
      // Created with the project's own permission rules: the proposal has no way to widen them.
      const session = yield* sessions.create({
        location: { directory },
        title: `Implement: ${proposal?.title ?? definition.finding.title}`,
        metadata: { harness: plan.harness, improvementID: definition.id },
      })
      yield* setImplementation(definition.id, { sessionID: session.id, status: "running" })
      const prompted = yield* sessions
        .prompt({
          sessionID: session.id,
          text: ImprovementProposal.implementationPrompt(definition.finding, proposal!),
        })
        .pipe(Effect.result)
      if (prompted._tag === "Failure")
        return yield* failImplementation(
          definition.id,
          `The implementation could not start: ${describe(prompted.failure)}`,
        )
      return directory
    })

    const setImplementation = (id: string, change: Partial<Improvement.Implementation>) =>
      update(id, (state) => ({
        ...state,
        implementation: state.implementation ? { ...state.implementation, ...change } : state.implementation,
      }))

    const failImplementation = (id: string, error: string) =>
      setImplementation(id, { status: "failed", error }).pipe(Effect.as(undefined))

    // --- Stack-Agent target -------------------------------------------------------------------------------------

    const stackAgentSource = Effect.fnUntraced(function* () {
      const settings = (yield* runtime.status()).settings
      if (!settings.sourceDirectory)
        return yield* new InvalidInputError({ message: "Configure the Stack-Agent source repository first" })
      const project = yield* projects.resolve(settings.sourceDirectory)
      const revision = yield* git(settings.sourceDirectory, ["rev-parse", "--verify", `${settings.branch}^{commit}`])
      if (revision.exitCode !== 0)
        return yield* new InvalidInputError({
          message: `${settings.branch} is not a commit in ${settings.sourceDirectory}`,
        })
      return {
        directory: project.directory,
        projectID: project.id,
        branch: settings.branch,
        revision: revision.stdout.trim(),
      }
    })

    /** Builds and validates the implementation commit; the candidate arm runs exactly this executable. */
    const candidateBuild = Effect.fnUntraced(function* (definition: Improvement.Definition, commit: string) {
      const recorded = (yield* readState(definition.id)).implementation?.generation
      const deadline = Date.now() + 2 * 60 * 60 * 1000
      const started = recorded
        ? recorded
        : yield* Effect.gen(function* () {
            // Builds are one at a time; wait for another to finish rather than failing this improvement.
            while (true) {
              const attempt = yield* runtime
                .build({ revision: commit, origin: { improvementID: definition.id, purpose: "candidate" } })
                .pipe(Effect.result)
              if (attempt._tag === "Success") return attempt.success.id
              if (attempt.failure._tag !== "StackAgentRuntime.BusyError" || Date.now() > deadline)
                return yield* failImplementation(
                  definition.id,
                  `The candidate could not be built: ${attempt.failure.message}`,
                )
              yield* Effect.sleep("2 seconds")
            }
          })
      if (!started) return undefined
      yield* setImplementation(definition.id, { generation: started })
      const built = yield* runtime.settled(started)
      if (built?.status !== "validated")
        return yield* failImplementation(
          definition.id,
          `The candidate build did not validate: ${built?.error ?? "the build record is missing"}`,
        )
      return built.id
    })

    const quote = (value: string) => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`)

    const preview = Effect.fn("Improvement.preview")(function* (id: string) {
      const definition = yield* readDefinition(id)
      const state = yield* readState(id)
      if (definition.target !== "stack-agent" || !definition.source)
        return yield* new InvalidInputError({ message: "Only a Stack-Agent improvement can be applied to Stack-Agent" })
      const settings = (yield* runtime.status()).settings
      const commit = state.implementation?.commit
      const tip = yield* git(definition.source.directory, [
        "rev-parse",
        "--verify",
        `${definition.source.branch}^{commit}`,
      ])
      const files = commit
        ? (yield* git(definition.source.directory, ["diff", "--name-only", `${commit}^`, commit])).stdout
            .split("\n")
            .filter(Boolean)
        : []
      const blocker = !commit
        ? "There is no implemented change to apply"
        : state.implementation?.status !== "completed"
          ? "The implementation did not complete"
          : state.evaluation?.status !== "completed"
            ? "Apply becomes available once the change has been evaluated"
            : tip.exitCode !== 0
              ? `${definition.source.branch} was not found`
              : undefined
      const conflicts =
        commit && tip.exitCode === 0
          ? yield* git(definition.source.directory, [
              "merge-tree",
              "--write-tree",
              "--name-only",
              `--merge-base=${commit}^`,
              tip.stdout.trim(),
              commit,
            ]).pipe(
              Effect.map((result) =>
                result.exitCode === 1
                  ? (result.stdout.split("\n\n")[0] ?? "").split("\n").slice(1).filter(Boolean)
                  : [],
              ),
            )
          : []
      return {
        sourceDirectory: definition.source.directory,
        targetBranch: definition.source.branch,
        tip: tip.exitCode === 0 ? tip.stdout.trim() : undefined,
        tested: definition.source.revision,
        drift: tip.exitCode === 0 && tip.stdout.trim() !== definition.source.revision,
        conflicts,
        files,
        remote: settings.remote,
        blocker,
      } satisfies Improvement.ApplyPreview
    })

    const setApplication = (id: string, change: Partial<Improvement.Application>) =>
      update(id, (state) => ({
        ...state,
        application: state.application ? { ...state.application, ...change } : state.application,
      }))

    /**
     * Applies the evaluated commit on top of the target branch's current tip, in a dedicated worktree and on a new
     * branch. The user's checkout and branch are untouched; conflicts stop the operation. Safe to repeat: a branch
     * that already carries this improvement's commit is reused.
     */
    const applyChange = Effect.fnUntraced(function* (id: string) {
      const definition = yield* readDefinition(id)
      const state = yield* readState(id)
      const application = state.application!
      const source = definition.source!
      const commit = state.implementation!.commit!
      const proposal = state.investigations.find((item) => item.attempt === state.plan?.attempt)?.proposal
      const branch = `stack-agent-improvement/${id}`
      const trailer = `Improvement: ${id}`
      const existing = yield* git(source.directory, ["rev-parse", "--verify", `refs/heads/${branch}`])
      const carried =
        existing.exitCode === 0 &&
        (yield* git(source.directory, ["log", "-1", "--format=%B", existing.stdout.trim()])).stdout.includes(trailer)
      if (!carried) {
        const conflicts = (yield* preview(id)).conflicts
        if (conflicts.length > 0) return yield* setApplication(id, { status: "conflict", conflicts })
      }
      const directory =
        application.directory ??
        (yield* worktrees
          .create({
            projectID: source.projectID,
            from: source.directory,
            branch: application.tip,
            name: `${id}-apply`,
          })
          .pipe(
            Effect.map((created) => created.directory),
            Effect.catch((error) =>
              setApplication(id, {
                status: "failed",
                error: `Workspace could not be created: ${describe(error)}`,
              }).pipe(Effect.as(undefined)),
            ),
          ))
      if (!directory) return
      yield* setApplication(id, { directory })
      if (carried) yield* git(directory, ["checkout", "-q", branch])
      if (!carried) {
        // The dedicated worktree may hold a half-finished attempt from before a restart; start it over from the tip.
        yield* git(directory, ["cherry-pick", "--abort"])
        yield* git(directory, ["checkout", "-q", "-B", branch, application.tip])
        const picked = yield* git(directory, ["cherry-pick", "--no-commit", commit])
        if (picked.exitCode !== 0) {
          const conflicted = (yield* git(directory, ["diff", "--name-only", "--diff-filter=U"])).stdout
            .split("\n")
            .filter(Boolean)
          yield* git(directory, ["cherry-pick", "--abort"])
          yield* git(directory, ["reset", "-q", "--hard", application.tip])
          return yield* setApplication(id, { status: "conflict", conflicts: conflicted })
        }
        const message = [
          proposal?.title ?? definition.finding.title,
          "",
          `Applies improvement ${id} for finding ${definition.finding.id}.`,
          `Implemented and evaluated against ${source.revision}; verdict: ${state.evaluation?.verdict ?? "not evaluated"}.`,
          `Evidence: ${definition.finding.evidence.map((item) => item.comparisonID).join(", ")}`,
          "",
          trailer,
        ].join("\n")
        const committed = yield* git(directory, [...COMMIT_IDENTITY, "commit", "-q", "-m", message])
        if (committed.exitCode !== 0)
          return yield* setApplication(id, {
            status: "failed",
            error: `The change could not be committed: ${committed.stderr.trim()}`,
          })
      }
      const head = (yield* git(directory, ["rev-parse", "HEAD"])).stdout.trim()
      const diff = (yield* git(directory, ["diff", application.tip, head])).stdout
      const sameSource =
        (yield* git(directory, ["rev-parse", `${head}^{tree}`])).stdout.trim() ===
        (yield* git(directory, ["rev-parse", `${commit}^{tree}`])).stdout.trim()
      const settings = (yield* runtime.status()).settings
      const commands = [
        ...settings.checks.map((args) => ({
          id: args.join(" "),
          description: "Repository check",
          command: args.map(quote).join(" "),
        })),
        ...(proposal?.acceptanceCriteria ?? []),
      ]
      const checks = yield* Effect.forEach(commands, (item) =>
        ComparisonCommand.run(proc, directory, item.command).pipe(
          Effect.map((result) => ({
            id: item.id,
            description: item.description,
            command: item.command,
            passed: result.exitCode === 0,
            exitCode: result.exitCode,
            output: result.output,
          })),
        ),
      )
      const failing = checks.filter((check) => !check.passed)
      yield* setApplication(id, {
        status: failing.length > 0 ? "failed" : "applied",
        branch,
        commit: head,
        diff: diff.slice(0, PATCH_LIMIT),
        diffTruncated: diff.length > PATCH_LIMIT,
        sameSource,
        checks,
        conflicts: [],
        appliedAt: Date.now(),
        error:
          failing.length > 0
            ? `Checks failed on the applied change: ${failing.map((check) => check.command).join("; ")}`
            : undefined,
      })
    })

    // --- Pipeline ----------------------------------------------------------------------------------------------

    /** Advances an approved improvement from its persisted stage; every step is safe to repeat after a restart. */
    const proceed = Effect.fnUntraced(function* (id: string) {
      const definition = yield* readDefinition(id)
      const plan = (yield* readState(id)).plan
      if (!plan) return
      if ((yield* readState(id)).stage === "baseline") {
        const blocked = yield* runVariant(
          definition,
          plan,
          "baseline",
          definition.baseRevision,
          plan.baselineRuntime?.pin,
        )
        if (blocked) return yield* finish(id, plan, "failed-to-implement", blocked)
        yield* update(id, (state) => ({
          ...state,
          stage: "implementing",
          evaluation: { status: "baseline", results: [] },
        }))
      }
      if ((yield* readState(id)).stage === "implementing") {
        const implemented = yield* implement(definition, plan)
        const implementation = (yield* readState(id)).implementation
        if (!implemented || implementation?.status !== "completed")
          return yield* finish(
            id,
            plan,
            "failed-to-implement",
            implementation?.error ?? "The implementation did not complete",
          )
        yield* update(id, (state) => ({ ...state, stage: "candidate" }))
      }
      if ((yield* readState(id)).stage === "candidate") {
        const implementation = (yield* readState(id)).implementation
        if (!implementation?.commit)
          return yield* finish(id, plan, "failed-to-implement", "The candidate commit is missing")
        // A project change is evaluated at its commit; a Stack-Agent change at the same project revision with the
        // candidate runtime build pinned, so the runtime is the only thing that differs.
        const blocked =
          definition.target === "stack-agent"
            ? yield* runVariant(definition, plan, "candidate", definition.baseRevision, implementation.generation)
            : yield* runVariant(definition, plan, "candidate", implementation.commit)
        if (blocked) return yield* finish(id, plan, "failed-to-implement", blocked)
        const evaluated = yield* results(plan)
        yield* finish(id, plan, evaluated.verdict, evaluated.reason, evaluated.results)
      }
    })

    const finish = (
      id: string,
      plan: Improvement.Plan,
      verdict: Improvement.Disposition,
      reason: string,
      computed?: readonly Improvement.HarnessResult[],
    ) =>
      Effect.gen(function* () {
        const resultsNow = computed ?? (yield* results(plan)).results
        const candidate = (yield* readState(id)).implementation?.generation
        const built = candidate ? yield* runtime.generation(candidate) : undefined
        yield* update(id, (state) => ({
          ...state,
          stage: "evaluated",
          evaluation: {
            status: "completed",
            results: resultsNow,
            verdict,
            reason,
            runtime: plan.baselineRuntime
              ? {
                  baseline: plan.baselineRuntime,
                  candidate: built ? { pin: built.id, commit: built.commit, version: built.version } : undefined,
                }
              : undefined,
          },
        }))
      })

    const create = Effect.fn("Improvement.create")(function* (input: Improvement.CreateInput) {
      const current = yield* analysis(input.directory)
      const finding = current.findings.find((item) => item.id === input.findingID)
      if (!finding) return yield* new InvalidInputError({ message: `No current finding ${input.findingID}` })
      if (finding.needsMoreEvidence)
        return yield* new InvalidInputError({
          message: "This finding needs more evidence before an intervention can be designed for it",
        })
      if (finding.taskKeys.length === 0)
        return yield* new InvalidInputError({
          message: "This finding has no recorded tasks to evaluate an intervention on",
        })
      const project = yield* projects.resolve(input.directory)
      const head = yield* git(input.directory, ["rev-parse", "--verify", "HEAD^{commit}"])
      if (head.exitCode !== 0) return yield* new InvalidInputError({ message: "The directory has no Git commit" })
      const source = input.target === "stack-agent" ? yield* stackAgentSource() : undefined
      const definition: Improvement.Definition = {
        id: Improvement.ID.create(),
        createdAt: Date.now(),
        directory: project.directory,
        projectID: project.id,
        baseRevision: head.stdout.trim(),
        finding,
        target: input.target ?? "project",
        source,
      }
      yield* kv.set(definitionKey(definition.id), encodeDefinition(definition) as Schema.Json)
      yield* kv.set(
        stateKey(definition.id),
        encodeState({
          stage: "investigating",
          investigations: [{ attempt: 0, status: "running", startedAt: Date.now(), errors: [] }],
        }) as Schema.Json,
      )
      yield* launch(definition.id, investigation(definition, 0))
      return yield* info(definition.id).pipe(Effect.orDie)
    })

    // Resume what a previous process left mid-flight. Session recovery resumes the agents themselves.
    const recover = Effect.gen(function* () {
      for (const id of yield* ids) {
        const found = yield* info(id).pipe(Effect.option)
        if (found._tag === "None") continue
        const { definition, state } = found.value
        if (state.stage === "investigating") {
          const last = state.investigations.at(-1)
          if (last?.status === "running" && last.sessionID) yield* launch(id, investigation(definition, last.attempt))
          if (last?.status === "running" && !last.sessionID)
            yield* update(id, (current) => ({
              ...current,
              stage: "needs-proposal",
              investigations: current.investigations.map((item) =>
                item.attempt === last.attempt
                  ? { ...item, status: "failed", errors: ["Interrupted before the investigation started; retry it"] }
                  : item,
              ),
            }))
        }
        if (state.stage === "baseline" || state.stage === "implementing" || state.stage === "candidate")
          yield* launch(id, proceed(id))
        if (state.application?.status === "applying") yield* launch(id, applyChange(id))
      }
    })
    yield* recover.pipe(Effect.forkIn(scope))

    return Service.of({
      analysis,
      list: Effect.fn("Improvement.list")(function* () {
        const items = yield* Effect.forEach(yield* ids, (id) => info(id).pipe(Effect.option))
        return items
          .flatMap((item) => (item._tag === "Some" ? [item.value] : []))
          .map((item) => ({
            id: item.definition.id,
            title: item.definition.finding.title,
            findingID: item.definition.finding.id,
            createdAt: item.definition.createdAt,
            stage: item.state.stage,
            verdict: item.state.evaluation?.verdict,
            decision: item.state.decision?.decision,
          }))
          .toSorted((left, right) => right.createdAt - left.createdAt)
      }),
      get: Effect.fn("Improvement.get")(function* (id) {
        return yield* info(id)
      }),
      create,
      investigate: Effect.fn("Improvement.investigate")(function* (id) {
        const definition = yield* readDefinition(id)
        const state = yield* readState(id)
        if (state.stage !== "proposed" && state.stage !== "needs-proposal")
          return yield* new InvalidInputError({ message: `Cannot investigate again while ${state.stage}` })
        const attempt = state.investigations.length
        yield* update(id, (current) => ({
          ...current,
          stage: "investigating",
          investigations: [
            ...current.investigations,
            { attempt, status: "running", startedAt: Date.now(), errors: [] },
          ],
        }))
        yield* launch(id, investigation(definition, attempt))
        return yield* info(id)
      }),
      approve: Effect.fn("Improvement.approve")(function* (id, input) {
        const definition = yield* readDefinition(id)
        const state = yield* readState(id)
        const proposal = state.investigations.find((item) => item.attempt === input.attempt)
        if (state.stage !== "proposed" || proposal?.status !== "valid" || !proposal.proposal)
          return yield* new InvalidInputError({ message: "Only a valid proposal awaiting review can be approved" })
        const evaluation = proposal.proposal.evaluation
        const plan: Improvement.Plan = {
          attempt: input.attempt,
          harness: input.harness,
          approvedAt: Date.now(),
          alpha: ALPHA,
          trials: evaluation.trials,
          taskKeys: [...evaluation.taskKeys],
          targetRuntimes: [...evaluation.targetRuntimes],
          runs: (["baseline", "candidate"] as const).flatMap((variant) =>
            evaluation.taskKeys.flatMap((taskKey, task) =>
              Array.from({ length: evaluation.trials }, (_, trial) => ({
                variant,
                taskKey,
                trial,
                comparisonID: Comparison.ID.make(`cmp_${id}_${variant}_${task}_${trial}`),
              })),
            ),
          ),
        }
        // A Stack-Agent change compares runtimes: the baseline arm is pinned to what runs today.
        const baselineRuntime =
          definition.target === "stack-agent"
            ? yield* runtime.resolve().pipe(
                Effect.map((resolved) => ({
                  pin: resolved.generation ?? "external",
                  commit: resolved.commit,
                  version: resolved.version,
                })),
                Effect.orElseSucceed(() => ({ pin: "external" })),
              )
            : undefined
        yield* update(id, (current) => ({ ...current, stage: "baseline", plan: { ...plan, baselineRuntime } }))
        yield* launch(id, proceed(definition.id))
        return yield* info(id)
      }),
      preview,
      apply: Effect.fn("Improvement.apply")(function* (id) {
        const definition = yield* readDefinition(id)
        const state = yield* readState(id)
        const current = yield* preview(id)
        if (current.blocker) return yield* new InvalidInputError({ message: current.blocker })
        if (state.application?.status === "applying") return yield* info(id)
        // Re-applying after an earlier attempt reuses its branch, so the same commit is never created twice.
        yield* update(id, (latest) => ({
          ...latest,
          application: {
            status: "applying",
            sourceDirectory: definition.source!.directory,
            targetBranch: definition.source!.branch,
            tip: latest.application?.status === "applied" ? latest.application.tip : current.tip!,
            tested: current.tested,
            drift: current.drift,
            conflicts: current.conflicts,
            directory: latest.application?.directory,
            diffTruncated: false,
            checks: [],
          },
        }))
        yield* launch(id, applyChange(id))
        return yield* info(id)
      }),
      stage: Effect.fn("Improvement.stage")(function* (id) {
        const state = yield* readState(id)
        if (state.application?.status !== "applied" || !state.application.commit)
          return yield* new InvalidInputError({ message: "Apply the change and pass its checks before building it" })
        const built = yield* runtime
          .build({ revision: state.application.commit, origin: { improvementID: id, purpose: "applied" } })
          .pipe(Effect.mapError((error) => new InvalidInputError({ message: error.message })))
        yield* setApplication(id, { build: built.id })
        return yield* info(id)
      }),
      publish: Effect.fn("Improvement.publish")(function* (id) {
        const state = yield* readState(id)
        const remote = (yield* runtime.status()).settings.remote
        if (state.application?.status !== "applied" || !state.application.branch)
          return yield* new InvalidInputError({
            message: "Only an applied change that passed its checks can be pushed",
          })
        if (!remote) return yield* new InvalidInputError({ message: "No Stack-Agent remote is configured" })
        const pushed = yield* git(state.application.sourceDirectory, ["push", remote, state.application.branch])
        if (pushed.exitCode !== 0)
          return yield* new InvalidInputError({
            message: `Push failed: ${pushed.stderr.trim() || pushed.stdout.trim()}`,
          })
        yield* setApplication(id, {
          published: { remote, at: Date.now(), output: (pushed.stderr + pushed.stdout).trim().slice(-2000) },
        })
        return yield* info(id)
      }),
      decide: Effect.fn("Improvement.decide")(function* (id, input) {
        const state = yield* readState(id)
        if (state.stage !== "evaluated" && state.stage !== "decided")
          return yield* new InvalidInputError({ message: "Only an evaluated improvement can be decided" })
        // Accepting is a review decision; only an evaluated improvement accepted by a reviewer counts as validated.
        yield* update(id, (current) => ({
          ...current,
          stage: "decided",
          decision: { decision: input.decision, at: Date.now(), note: input.note },
        }))
        return yield* info(id)
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [KV.node, Session.node, Comparison.node, Worktree.node, Project.node, AppProcess.node, StackAgentRuntime.node],
})

/** Where a change is made: the project itself, or the Stack-Agent source repository. */
function site(definition: Improvement.Definition) {
  return definition.target === "stack-agent" && definition.source
    ? definition.source
    : { projectID: definition.projectID, directory: definition.directory, revision: definition.baseRevision }
}

function describe(error: unknown) {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string")
    return error.message
  if (error && typeof error === "object" && "_tag" in error) return String(error._tag)
  return String(error)
}
