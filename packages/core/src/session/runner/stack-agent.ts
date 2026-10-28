export * as SessionRunnerStackAgent from "./stack-agent.js"

import { LLMClient } from "@opencode/ai/effect"
import { Money } from "@opencode/schema/money"
import { Effect, Layer, Stream } from "effect"
import { Pty } from "../../pty.js"
import { Bus } from "../../bus.js"
import { Database } from "../../database/database.js"
import { llmClient } from "../../effect/app-node-platform.js"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { SessionContext } from "../context.js"
import { StepFailedError } from "../error.js"
import { SessionEvent } from "../event.js"
import { InstructionState } from "../instruction-state.js"
import { SessionInbox } from "../inbox.js"
import { SessionMessage } from "../message.js"
import { SessionUsage } from "../usage.js"
import { StackAgentRuntime } from "../../stack-agent-runtime.js"
import { StackAgentGateway } from "./stack-agent-gateway.js"
import { SessionRunnerLLM } from "./llm.js"
import { DrainResult, Service, type Interface } from "./index.js"

// stack-agent refuses a goal over 2000 bytes.
const MAX_GOAL_BYTES = 2000

/**
 * Runs a Session prompt through the stack-agent binary instead of opencode's own LLM loop.
 *
 * stack-agent owns the agent loop, decisions, tools and verification. Inference goes through a loopback
 * OpenAI-compatible gateway backed by the Session's resolved model, so every opencode provider works
 * even though the binary natively speaks only OpenAI-compatible and Anthropic endpoints.
 */
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const context = yield* SessionContext.Service
    const db = (yield* Database.Service).db
    const llm = yield* LLMClient.Service
    const services = yield* Effect.context<never>()
    const native = yield* SessionRunnerLLM.make
    const pty = yield* Pty.Service
    const runtime = yield* StackAgentRuntime.Service

    const drain = Effect.fn("SessionRunnerStackAgent.drain")(function* (input: Parameters<Interface["drain"]>[0]) {
      const sessionID = input.sessionID
      const selected = yield* context.select(sessionID)
      // The session's harness decides who runs it; Plan and Build are modes both harnesses understand.
      if (selected.session.metadata?.harness === "opencode") return yield* native.drain(input)
      if (!input.force && !(yield* SessionInbox.nextPromotable(db, sessionID, "input"))) return DrainResult.Complete()

      // Loading history reads the instruction baseline, which the runner records first.
      yield* InstructionState.prepare(db, bus, selected.instructions, sessionID)
      const promoted = yield* SessionInbox.promote(db, bus, sessionID, input.promotable ?? "input")
      if (promoted === undefined) return DrainResult.Complete()
      const loaded = yield* context.load(selected)
      const request = lastUserText(loaded.messages)
      if (request === undefined) return DrainResult.Complete()
      // Plan mode is read-only, which is what stack-agent's inspect kind is; Build can change files and verifies them.
      const planning = loaded.agent.id === "plan"
      const goal = withTerminal(
        planning ? `Plan only, do not change any files. ${request}` : request,
        yield* terminalOutput(pty),
      )

      const assistantMessageID = SessionMessage.ID.create()
      const started = Date.now()
      yield* bus.publish(SessionEvent.Step.Started, {
        sessionID,
        agent: loaded.agent.id,
        model: loaded.model.ref,
        assistantMessageID,
        started,
      })
      yield* bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 0 })

      const token = crypto.randomUUID()
      const totals: StackAgentGateway.Totals = { tokens: SessionUsage.tokens(undefined), cost: Money.USD.zero }
      const gateway = yield* Effect.acquireRelease(
        Effect.sync(() =>
          StackAgentGateway.serve({ token, model: loaded.model, llm, totals, run: Effect.runPromiseWith(services) }),
        ),
        (server) => Effect.promise(() => server.stop(true)),
      )

      // Resolved per drain: an activation reaches the next task, while a task already running keeps the executable
      // it started, which is never overwritten.
      const resolved = yield* runtime
        .resolve(pinned(selected.session.metadata?.[StackAgentRuntime.PIN]))
        .pipe(
          Effect.mapError(
            (error) => new StepFailedError({ error: { type: "stack-agent.unavailable", message: error.message } }),
          ),
        )

      const output = { text: "" }
      const emit = (delta: string) =>
        Effect.suspend(() => {
          output.text += delta
          return bus.publish(SessionEvent.Text.Delta, { sessionID, assistantMessageID, ordinal: 0, delta })
        })

      const finished = yield* runtime.track(sessionID, resolved)
      const exit = yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          Bun.spawn(
            [resolved.executable, "work", goal, "--kind", !planning && Bun.which("pax") ? "change" : "inspect"],
            {
              cwd: loaded.session.location.directory,
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
              env: {
                ...process.env,
                CHIP_PROVIDER: "openai-compatible",
                CHIP_ENDPOINT: `http://127.0.0.1:${gateway.port}/v1/chat/completions`,
                CHIP_MODEL: loaded.model.ref.id,
                CHIP_API_KEY: token,
                // The gateway forwards to whatever provider the Session selected, which may not honor response_format.
                CHIP_STRUCTURED_OUTPUT: "none",
                CHIP_TOKEN_LIMIT_FIELD: "max_tokens",
                CHIP_CALL_TIMEOUT_SECS: "600",
              },
            },
          ),
        ),
        (child) =>
          Effect.gen(function* () {
            // Progress lines arrive on stderr while the report arrives on stdout; both belong in the transcript.
            yield* Effect.all([forward(child.stderr, emit), forward(child.stdout, emit)], {
              concurrency: "unbounded",
              discard: true,
            })
            return yield* Effect.promise(() => child.exited)
          }),
        (child) => Effect.sync(() => child.kill()),
      ).pipe(Effect.onExit((result) => finished(result._tag === "Success" ? result.value : undefined)))

      yield* bus.publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID, ordinal: 0, text: output.text })
      // 0 means verified, 1 means it ran correctly but could not verify the work; the report explains either way.
      if (exit > 1)
        return yield* new StepFailedError({
          error: { type: "stack-agent.failed", message: `stack-agent exited with status ${exit}` },
        })
      yield* bus.publish(SessionEvent.Step.Ended, {
        sessionID,
        assistantMessageID,
        finish: "stop",
        ...totals,
      })
      return DrainResult.Complete()
    })

    return Service.of({ drain: (input) => drain(input).pipe(Effect.scoped) })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    ...SessionRunnerLLM.deps,
    Pty.node,
    Bus.node,
    SessionContext.node,
    Database.node,
    llmClient,
    StackAgentRuntime.node,
  ],
})

// Leaves the request most of the goal budget; terminal output is context for it, not a replacement.
const TERMINAL_BUDGET = 1000

/** The tail of the newest running terminal, which is where the user's command line work happens. */
const terminalOutput = (pty: Pty.Interface) =>
  Effect.gen(function* () {
    const running = (yield* pty.list()).filter((info) => info.status === "running")
    const newest = running.at(-1)
    if (!newest) return undefined
    const text = yield* pty.tail(newest.id, TERMINAL_BUDGET).pipe(Effect.orElseSucceed(() => ""))
    return text ? { title: newest.title, text } : undefined
  })

function withTerminal(request: string, terminal: { title: string; text: string } | undefined) {
  if (!terminal) return request
  const context = `\n\n[Terminal "${terminal.title}", latest output]\n${terminal.text}`
  const room = MAX_GOAL_BYTES - Buffer.byteLength(request)
  if (room <= 0) return request
  const bytes = Buffer.from(context)
  return request + (bytes.length <= room ? context : "\n\n" + bytes.subarray(bytes.length - room + 2).toString())
}

// Session metadata is open JSON; only a string names a generation.
const pinned = (value: unknown) => (typeof value === "string" ? value : undefined)

function lastUserText(messages: SessionContext.Loaded["messages"]) {
  const text = messages.findLast((message) => message.type === "user")?.text
  if (text === undefined) return undefined
  return Buffer.from(text).subarray(0, MAX_GOAL_BYTES).toString()
}

const forward = (stream: ReadableStream<Uint8Array>, emit: (delta: string) => Effect.Effect<void>) =>
  Stream.fromReadableStream({ evaluate: () => stream, onError: (cause) => cause }).pipe(
    Stream.decodeText(),
    Stream.runForEach(emit),
    Effect.orDie,
  )
