export * as StackAgentGateway from "./stack-agent-gateway.js"

import { LLM, Message, type LLMClientShape } from "@opencode/ai/effect"
import { Money } from "@opencode/schema/money"
import type { TokenUsage } from "@opencode/schema/token-usage"
import { Cause, Effect, Schema } from "effect"
import { SessionUsage } from "../usage.js"
import type { SessionRunnerModel } from "./model.js"

const Body = Schema.Struct({
  messages: Schema.Array(
    Schema.Struct({
      role: Schema.Literals(["system", "user", "assistant"]),
      content: Schema.String,
    }),
  ),
  max_tokens: Schema.optional(Schema.Number),
  temperature: Schema.optional(Schema.Number),
})
const decodeBody = Schema.decodeUnknownEffect(Schema.fromJsonString(Body))

/** Usage and cost accumulated across every model call a stack-agent run makes. */
export type Totals = { tokens: TokenUsage.Info; cost: Money.USD }

/**
 * Serves `POST /v1/chat/completions` on loopback for one stack-agent run. The request is answered by the
 * Session's resolved model, so the binary reaches any provider opencode supports without holding its credentials.
 */
export function serve(input: {
  readonly token: string
  readonly model: SessionRunnerModel.Resolved
  readonly llm: LLMClientShape
  readonly totals: Totals
  readonly run: <A>(effect: Effect.Effect<A>) => Promise<A>
}) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 255,
    fetch: async (request) => {
      if (request.headers.get("authorization") !== `Bearer ${input.token}`)
        return Response.json({ error: { message: "unauthorized" } }, { status: 401 })
      if (new URL(request.url).pathname !== "/v1/chat/completions" || request.method !== "POST")
        return Response.json({ error: { message: "not found" } }, { status: 404 })
      return input.run(complete(input, await request.text()))
    },
  })
}

const complete = (input: Parameters<typeof serve>[0], raw: string) =>
  Effect.gen(function* () {
    const body = yield* decodeBody(raw)
    const system = body.messages.filter((message) => message.role === "system").map((message) => message.content)
    const response = yield* input.llm.generate(
      LLM.request({
        model: input.model.model,
        system: system.join("\n\n"),
        messages: body.messages.flatMap((message) =>
          message.role === "system" ? [] : [Message.make({ role: message.role, content: message.content })],
        ),
        generation: { maxTokens: body.max_tokens, temperature: body.temperature },
      }),
    )
    const recorded = SessionUsage.record(response.usage, input.model.cost)
    input.totals.tokens = {
      input: input.totals.tokens.input + recorded.tokens.input,
      output: input.totals.tokens.output + recorded.tokens.output,
      reasoning: input.totals.tokens.reasoning + recorded.tokens.reasoning,
      cache: {
        read: input.totals.tokens.cache.read + recorded.tokens.cache.read,
        write: input.totals.tokens.cache.write + recorded.tokens.cache.write,
      },
    }
    input.totals.cost = Money.USD.make(input.totals.cost + recorded.cost)
    const usage = {
      prompt_tokens: recorded.tokens.input + recorded.tokens.cache.read + recorded.tokens.cache.write,
      completion_tokens: recorded.tokens.output + recorded.tokens.reasoning,
    }
    const chunk = (choice: object, extra: object = {}) => ({
      object: "chat.completion.chunk",
      model: input.model.ref.id,
      choices: [choice],
      ...extra,
    })
    // stack-agent only accepts an event stream, so the finished completion is replayed as one.
    const events = [
      chunk({ index: 0, delta: { role: "assistant", content: response.text }, finish_reason: null }),
      chunk({ index: 0, delta: {}, finish_reason: "stop" }, { usage }),
    ]
    return new Response([...events.map((event) => `data: ${JSON.stringify(event)}\n\n`), "data: [DONE]\n\n"].join(""), {
      headers: { "content-type": "text/event-stream" },
    })
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.succeed(
        Response.json(
          {
            error: {
              message:
                Cause.squash(cause) instanceof Error ? (Cause.squash(cause) as Error).message : Cause.pretty(cause),
            },
          },
          { status: 502 },
        ),
      ),
    ),
  )
