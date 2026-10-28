export * as StackAgentRuntime from "./stack-agent-runtime.js"

import fs from "fs/promises"
import path from "path"
import { Context, Duration, Effect, Layer, Schema, Scope } from "effect"
import { ChildProcess } from "effect/process"
import { StackAgentRuntime } from "@opencode/schema/stack-agent-runtime"
import { Identifier } from "@opencode/schema/identifier"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { KeyedMutex } from "./effect/keyed-mutex.js"
import { Git } from "./git.js"
import { KV } from "./kv.js"
import { AbsolutePath } from "./schema.js"
import type { Session } from "./session.js"
import { gitExecutable } from "./util/git-executable.js"

export type Settings = StackAgentRuntime.Settings
export type Generation = StackAgentRuntime.Generation
export type Resolved = StackAgentRuntime.Resolved
export type Status = StackAgentRuntime.Status

/** Session metadata key that pins a Session's Stack-Agent runs to one generation, or to `external`. */
export const PIN = "stackAgentGeneration"

export class InvalidInputError extends Schema.TaggedError<InvalidInputError>()("StackAgentRuntime.InvalidInputError", {
  message: Schema.String,
}) {}

export class BusyError extends Schema.TaggedError<BusyError>()("StackAgentRuntime.BusyError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly status: () => Effect.Effect<Status>
  readonly configure: (input: StackAgentRuntime.SettingsInput) => Effect.Effect<Settings>
  /** Compares the configured branch with the active generation. Never changes the active runtime. */
  readonly check: (input: StackAgentRuntime.CheckInput) => Effect.Effect<Status, InvalidInputError>
  /**
   * Builds and validates a revision into a new generation, in the background. Returns at once with the generation
   * record; an already validated build of the same source tree is reused instead of rebuilt.
   */
  readonly build: (
    input: StackAgentRuntime.BuildInput & { readonly origin?: Generation["origin"] },
  ) => Effect.Effect<Generation, InvalidInputError | BusyError>
  readonly generation: (id: string) => Effect.Effect<Generation | undefined>
  /** Waits until a generation is validated or failed. */
  readonly settled: (id: string) => Effect.Effect<Generation | undefined>
  /** Makes a validated generation the one new tasks use. Running tasks keep their executable. */
  readonly activate: (id: string) => Effect.Effect<Status, InvalidInputError>
  /** Restores the previous known-good generation for new tasks. */
  readonly rollback: () => Effect.Effect<Status, InvalidInputError>
  /** The executable a new run uses: the Session's pinned generation, else the active one, else the fallback. */
  readonly resolve: (pin?: string) => Effect.Effect<Resolved, InvalidInputError>
  /** Records which executable a Session's run used, for as long as the run lasts. */
  readonly track: (
    sessionID: Session.ID,
    resolved: Resolved,
  ) => Effect.Effect<(exitCode: number | undefined) => Effect.Effect<void>>
  readonly usage: (sessionID: Session.ID) => Effect.Effect<StackAgentRuntime.Usage | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/StackAgentRuntime") {}

export const DEFAULT_SETTINGS: Settings = {
  branch: "main",
  buildCommand: ["cargo", "build", "--release", "--bin", "stack-agent"],
  artifact: "$CARGO_TARGET_DIR/release/stack-agent",
  // `--test` is Stack-Agent's offline self-test with its built-in provider: no model or network.
  smoke: [["--version"], ["--test"]],
  checks: [
    ["cargo", "fmt", "--all", "--check"],
    ["cargo", "test", "--workspace"],
  ],
}

const SETTINGS_KEY = "stack-agent/settings"
const STATE_KEY = "stack-agent/state"
const generationKey = (id: string) => `stack-agent/generation/${id}`
const usageKey = (sessionID: string) => `stack-agent/usage/${sessionID}`
const BUILD_TIMEOUT = "60 minutes"
const SMOKE_TIMEOUT = "2 minutes"
const OUTPUT_TAIL = 8000
const EVENT_LIMIT = 50
const USAGE_LIMIT = 50
const POLL = "500 millis"

const decodeSettings = Schema.decodeUnknownOption(StackAgentRuntime.Settings)
const decodeState = Schema.decodeUnknownOption(StackAgentRuntime.State)
const decodeGeneration = Schema.decodeUnknownOption(StackAgentRuntime.Generation)
const decodeUsage = Schema.decodeUnknownOption(StackAgentRuntime.Usage)
const json = <A>(schema: Schema.Codec<A, unknown>) => Schema.encodeSync(schema) as (value: A) => Schema.Json

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const kv = yield* KV.Service
    const git = yield* Git.Service
    const proc = yield* AppProcess.Service
    const global = yield* Global.Service
    const scope = yield* Scope.Scope
    const locks = KeyedMutex.makeUnsafe<string>()
    const root = path.join(global.data, "stack-agent")
    const running = new Map<number, { sessionID: Session.ID; startedAt: number; resolved: Resolved }>()
    let sequence = 0
    let building = false

    const settings = Effect.gen(function* () {
      const stored = yield* kv.get(SETTINGS_KEY)
      const decoded = stored === undefined ? undefined : decodeSettings(stored)
      return decoded?._tag === "Some" ? decoded.value : DEFAULT_SETTINGS
    })

    const state = Effect.gen(function* () {
      const stored = yield* kv.get(STATE_KEY)
      const decoded = stored === undefined ? undefined : decodeState(stored)
      return decoded?._tag === "Some" ? decoded.value : { previous: [], events: [] }
    })

    // Every pointer change goes through this one lock, so activation, rollback and build bookkeeping never race.
    const updateState = (change: (current: StackAgentRuntime.State) => StackAgentRuntime.State) =>
      locks.withLock("state")(
        Effect.gen(function* () {
          const next = change(yield* state)
          yield* kv.set(STATE_KEY, json(StackAgentRuntime.State)(next))
          return next
        }),
      )

    const event = (item: Omit<StackAgentRuntime.Event, "at">) =>
      updateState((current) => ({
        ...current,
        events: [{ at: Date.now(), ...item }, ...current.events].slice(0, EVENT_LIMIT),
      }))

    const generation = Effect.fn("StackAgentRuntime.generation")(function* (id: string) {
      const stored = yield* kv.get(generationKey(id))
      const decoded = stored === undefined ? undefined : decodeGeneration(stored)
      return decoded?._tag === "Some" ? decoded.value : undefined
    })

    const saveGeneration = (item: Generation) =>
      kv.set(generationKey(item.id), json(StackAgentRuntime.Generation)(item))

    const generations = Effect.gen(function* () {
      const result: Generation[] = []
      for (let after: string | undefined; ; ) {
        const page = yield* kv.scan({ prefix: "stack-agent/generation/", after, limit: 1000 })
        for (const entry of page.entries) {
          const decoded = decodeGeneration(entry.value)
          if (decoded._tag === "Some") result.push(decoded.value)
        }
        if (!page.next) return result.toSorted((left, right) => right.createdAt - left.createdAt)
        after = page.next
      }
    })

    const run = (command: readonly string[], cwd: string, env: Record<string, string>, timeout: Duration.Input) =>
      Effect.gen(function* () {
        const started = Date.now()
        const result = yield* proc
          .run(ChildProcess.make(command[0], command.slice(1), { cwd, env, extendEnv: true, stdin: "ignore" }), {
            combineOutput: true,
            timeout,
            maxOutputBytes: 4 * 1024 * 1024,
          })
          .pipe(
            Effect.map((result) => ({
              exitCode: result.exitCode,
              output: (result.output ?? result.stdout).toString("utf8"),
            })),
            Effect.catch((error) => Effect.succeed({ exitCode: -1, output: error.message })),
          )
        return {
          command: command.join(" "),
          exitCode: result.exitCode,
          output: result.output.slice(-OUTPUT_TAIL),
          durationMs: Date.now() - started,
        } satisfies StackAgentRuntime.CommandResult
      })

    const gitText = (cwd: string, args: string[]) =>
      proc.run(ChildProcess.make(gitExecutable(), args, { cwd, stdin: "ignore" })).pipe(
        Effect.map((result) => (result.exitCode === 0 ? result.stdout.toString("utf8").trim() : undefined)),
        Effect.orElseSucceed(() => undefined),
      )

    const usable = (item: Generation | undefined) =>
      Effect.promise(async () =>
        item?.status === "validated" && item.executable && (await Bun.file(item.executable).exists())
          ? item
          : undefined,
      )

    const external = (): Resolved => {
      const executable = process.env.STACK_AGENT_BIN ?? "stack-agent"
      return { executable: Bun.which(executable) ?? executable, source: "external" }
    }

    const resolve = Effect.fn("StackAgentRuntime.resolve")(function* (pin?: string) {
      if (pin === "external") return external()
      if (pin) {
        const pinned = yield* usable(yield* generation(pin))
        if (!pinned)
          return yield* new InvalidInputError({
            message: `Pinned Stack-Agent generation ${pin} is not a validated build`,
          })
        return describe(pinned, "pinned")
      }
      const active = yield* usable(yield* generation((yield* state).active ?? ""))
      return active ? describe(active, "active") : external()
    })

    const sha256 = (file: string) =>
      Effect.promise(async () => {
        const hasher = new Bun.CryptoHasher("sha256")
        hasher.update(await Bun.file(file).arrayBuffer())
        return hasher.digest("hex")
      })

    const smoke = Effect.fnUntraced(function* (executable: string, checks: Settings["smoke"], cwd: string) {
      const results: StackAgentRuntime.CommandResult[] = []
      for (const args of checks) {
        const result = yield* run([executable, ...args], cwd, {}, SMOKE_TIMEOUT)
        results.push(result)
        if (result.exitCode !== 0) break
      }
      return results
    })

    /** The background build: worktree → build → copy to an immutable path → hash → smoke checks. */
    const produce = Effect.fnUntraced(function* (item: Generation, config: Settings) {
      const workspace = AbsolutePath.make(path.join(root, "build", item.id))
      const repository = yield* git.repo.discover(item.sourceDirectory)
      const fail = (error: string, extra: Partial<Generation> = {}) =>
        Effect.gen(function* () {
          yield* saveGeneration({ ...item, ...extra, status: "failed", error })
          yield* event({ kind: "build-failed", generation: item.id, message: error })
        })
      if (!repository) return yield* fail(`${item.sourceDirectory} is not a Git repository`)
      const created = yield* git.worktree
        .create({ repository, directory: workspace, ref: item.commit })
        .pipe(Effect.result)
      if (created._tag === "Failure")
        return yield* fail(`The build workspace could not be created: ${created.failure.message}`)
      const target = path.join(root, "target")
      const build = yield* run(config.buildCommand, workspace, { CARGO_TARGET_DIR: target }, BUILD_TIMEOUT)
      const artifact = config.artifact.replace("$CARGO_TARGET_DIR", target)
      const source = path.isAbsolute(artifact) ? artifact : path.join(workspace, artifact)
      const finish = git.worktree.remove({ repository, directory: workspace, force: true }).pipe(Effect.ignore)
      if (build.exitCode !== 0) {
        yield* finish
        return yield* fail(`The build command exited with status ${build.exitCode}`, { build })
      }
      if (!(yield* Effect.promise(() => Bun.file(source).exists()))) {
        yield* finish
        return yield* fail(`The build produced no executable at ${source}`, { build })
      }
      // A new directory per generation: the executable a running task loaded is never replaced or truncated.
      const directory = path.join(root, "versions", item.id)
      const executable = AbsolutePath.make(path.join(directory, path.basename(source)))
      yield* Effect.promise(async () => {
        await fs.mkdir(directory, { recursive: true })
        await fs.copyFile(source, executable, fs.constants.COPYFILE_EXCL)
        await fs.chmod(executable, 0o755)
      })
      yield* finish
      const digest = yield* sha256(executable)
      yield* saveGeneration({ ...item, status: "validating", build, executable, sha256: digest })
      const checks = yield* smoke(executable, config.smoke, directory)
      const failed = checks.find((check) => check.exitCode !== 0)
      const version = checks
        .find((check) => check.command.endsWith(" --version"))
        ?.output.trim()
        .split("\n")[0]
      if (failed || checks.length < config.smoke.length)
        return yield* fail(`Smoke check failed: ${failed?.command ?? "not run"} exited with ${failed?.exitCode}`, {
          build,
          executable,
          sha256: digest,
          smoke: checks,
          version,
        })
      yield* saveGeneration({ ...item, status: "validated", build, executable, sha256: digest, smoke: checks, version })
      yield* event({ kind: "built", generation: item.id, message: `Built and validated ${item.commit.slice(0, 12)}` })
    })

    const build = Effect.fn("StackAgentRuntime.build")(function* (
      input: StackAgentRuntime.BuildInput & { readonly origin?: Generation["origin"] },
    ) {
      const config = yield* settings
      if (!config.sourceDirectory)
        return yield* new InvalidInputError({ message: "No Stack-Agent source directory is configured" })
      const revision = input.revision ?? config.branch
      const commit = yield* gitText(config.sourceDirectory, ["rev-parse", "--verify", `${revision}^{commit}`])
      const tree = yield* gitText(config.sourceDirectory, ["rev-parse", "--verify", `${revision}^{tree}`])
      if (!commit || !tree)
        return yield* new InvalidInputError({ message: `${revision} is not a commit in ${config.sourceDirectory}` })
      // Same source tree, same build: reuse it rather than rebuilding (retries and repeated requests are safe).
      const reusable = (yield* generations).find((item) => item.tree === tree && item.status === "validated")
      if (reusable && (yield* usable(reusable))) return reusable
      if (building) return yield* new BusyError({ message: "Another Stack-Agent build is in progress" })
      building = true
      const item: Generation = {
        id: `sag_${commit.slice(0, 8)}_${Identifier.ascending().slice(0, 12)}`,
        commit,
        tree,
        sourceDirectory: config.sourceDirectory,
        createdAt: Date.now(),
        status: "building",
        smoke: [],
        origin: input.origin,
      }
      yield* saveGeneration(item)
      yield* updateState((current) => ({
        ...current,
        operation: { kind: "build", generation: item.id, startedAt: item.createdAt },
      }))
      yield* produce(item, config).pipe(
        Effect.catchCause((cause) =>
          saveGeneration({ ...item, status: "failed", error: `The build stopped unexpectedly: ${String(cause)}` }),
        ),
        Effect.ensuring(
          updateState((current) => ({ ...current, operation: undefined })).pipe(
            Effect.ensuring(Effect.sync(() => (building = false))),
          ),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      return item
    })

    const activate = Effect.fn("StackAgentRuntime.activate")(function* (id: string) {
      const item = yield* generation(id)
      const failed = (message: string) =>
        event({ kind: "activation-failed", generation: id, message }).pipe(
          Effect.andThen(Effect.fail(new InvalidInputError({ message }))),
        )
      if (!(yield* usable(item))) return yield* failed(`${id} is not a validated build`)
      // Artifact identity: the file must still be the one that passed validation.
      if ((yield* sha256(item!.executable!)) !== item!.sha256)
        return yield* failed(`The executable for ${id} no longer matches its validated hash`)
      const health = yield* run([item!.executable!, "--version"], path.dirname(item!.executable!), {}, SMOKE_TIMEOUT)
      if (health.exitCode !== 0) return yield* failed(`Health check failed: --version exited with ${health.exitCode}`)
      yield* updateState((current) => ({
        ...current,
        active: id,
        previous:
          current.active && current.active !== id
            ? [current.active, ...current.previous.filter((item) => item !== id)].slice(0, 10)
            : current.previous,
      }))
      yield* event({
        kind: "activated",
        generation: id,
        message: `New Stack-Agent tasks now use ${item!.version ?? id}`,
      })
      return yield* status()
    })

    const rollback = Effect.fn("StackAgentRuntime.rollback")(function* () {
      const current = yield* state
      for (const candidate of current.previous) {
        const item = yield* usable(yield* generation(candidate))
        if (!item || (yield* sha256(item.executable!)) !== item.sha256) continue
        yield* updateState((latest) => ({
          ...latest,
          active: candidate,
          previous: latest.previous.filter((id) => id !== candidate),
        }))
        yield* event({
          kind: "rolled-back",
          generation: candidate,
          previous: current.active,
          message: `Rolled back from ${current.active ?? "the fallback executable"} to ${item.version ?? candidate}`,
        })
        return yield* status()
      }
      return yield* new InvalidInputError({ message: "No earlier validated Stack-Agent generation to roll back to" })
    })

    const status = Effect.fn("StackAgentRuntime.status")(function* () {
      return {
        settings: yield* settings,
        state: yield* state,
        generations: (yield* generations).slice(0, 20),
        current: yield* resolve().pipe(Effect.orElseSucceed(external)),
        running: [...running.values()],
      } satisfies Status
    })

    const check = Effect.fn("StackAgentRuntime.check")(function* (input: StackAgentRuntime.CheckInput) {
      const config = yield* settings
      if (!config.sourceDirectory)
        return yield* new InvalidInputError({ message: "No Stack-Agent source directory is configured" })
      const fetched =
        input.fetch && config.remote
          ? yield* run(["git", "fetch", config.remote, config.branch], config.sourceDirectory, {}, "5 minutes")
          : undefined
      const ref = input.fetch && config.remote ? `${config.remote}/${config.branch}` : config.branch
      const tip = yield* gitText(config.sourceDirectory, ["rev-parse", "--verify", `${ref}^{commit}`])
      yield* updateState((current) => ({
        ...current,
        lastCheck: {
          at: Date.now(),
          branch: ref,
          tip,
          error: fetched && fetched.exitCode !== 0 ? fetched.output : tip ? undefined : `${ref} was not found`,
        },
      }))
      return yield* status()
    })

    // A build the previous process left running never finished: record it as failed so nothing waits on it.
    const recover = Effect.gen(function* () {
      const current = yield* state
      if (!current.operation) return
      const item = yield* generation(current.operation.generation)
      if (item && item.status !== "validated")
        yield* saveGeneration({
          ...item,
          status: "failed",
          error: "Interrupted: the application stopped during the build",
        })
      yield* updateState((latest) => ({ ...latest, operation: undefined }))
      yield* event({
        kind: "interrupted",
        generation: current.operation.generation,
        message: "A build was interrupted by a restart; the active runtime was not changed",
      })
      const repository = item ? yield* git.repo.discover(item.sourceDirectory) : undefined
      if (repository)
        yield* git.worktree
          .remove({
            repository,
            directory: AbsolutePath.make(path.join(root, "build", current.operation.generation)),
            force: true,
          })
          .pipe(Effect.ignore)
    })
    yield* recover.pipe(Effect.ignore)

    return Service.of({
      status,
      configure: Effect.fn("StackAgentRuntime.configure")(function* (input) {
        const next = {
          ...(yield* settings),
          ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
        }
        yield* kv.set(SETTINGS_KEY, json(StackAgentRuntime.Settings)(next))
        return next
      }),
      check,
      build,
      generation,
      settled: Effect.fn("StackAgentRuntime.settled")(function* (id) {
        while (true) {
          const item = yield* generation(id)
          if (!item || item.status === "validated" || item.status === "failed") return item
          yield* Effect.sleep(POLL)
        }
      }),
      activate,
      rollback,
      resolve,
      track: Effect.fn("StackAgentRuntime.track")(function* (sessionID, resolved) {
        const token = ++sequence
        const startedAt = Date.now()
        running.set(token, { sessionID, startedAt, resolved })
        const append = (change: (runs: StackAgentRuntime.Usage["runs"]) => StackAgentRuntime.Usage["runs"]) =>
          locks.withLock(usageKey(sessionID))(
            Effect.gen(function* () {
              const stored = yield* kv.get(usageKey(sessionID))
              const decoded = stored === undefined ? undefined : decodeUsage(stored)
              const runs = decoded?._tag === "Some" ? decoded.value.runs : []
              yield* kv.set(
                usageKey(sessionID),
                json(StackAgentRuntime.Usage)({ sessionID, runs: change(runs).slice(-USAGE_LIMIT) }),
              )
            }),
          )
        yield* append((runs) => [...runs, { ...resolved, startedAt }])
        return (exitCode) =>
          Effect.suspend(() => {
            running.delete(token)
            return append((runs) =>
              runs.map((item) => (item.startedAt === startedAt ? { ...item, endedAt: Date.now(), exitCode } : item)),
            )
          })
      }),
      usage: Effect.fn("StackAgentRuntime.usage")(function* (sessionID) {
        const stored = yield* kv.get(usageKey(sessionID))
        const decoded = stored === undefined ? undefined : decodeUsage(stored)
        return decoded?._tag === "Some" ? decoded.value : undefined
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [KV.node, Git.node, AppProcess.node, Global.node],
})

function describe(item: Generation, source: Resolved["source"]): Resolved {
  return { generation: item.id, commit: item.commit, version: item.version, executable: item.executable!, source }
}
