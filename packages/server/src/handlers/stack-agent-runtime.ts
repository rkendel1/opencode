import { StackAgentRuntime } from "@opencode/core/stack-agent-runtime"
import { ConflictError, InvalidRequestError } from "@opencode/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"

export const StackAgentRuntimeHandler = HttpApiBuilder.group(Api, "server.stackAgentRuntime", (handlers) =>
  Effect.gen(function* () {
    const runtime = yield* StackAgentRuntime.Service
    return handlers
      .handle("stackAgentRuntime.status", () => runtime.status())
      .handle("stackAgentRuntime.configure", (ctx) => runtime.configure(ctx.payload))
      .handle("stackAgentRuntime.check", (ctx) => runtime.check(ctx.payload).pipe(Effect.mapError(invalid)))
      .handle("stackAgentRuntime.build", (ctx) =>
        runtime
          .build(ctx.payload)
          .pipe(
            Effect.mapError((error) =>
              error._tag === "StackAgentRuntime.BusyError"
                ? new ConflictError({ message: error.message, resource: "stack-agent" })
                : invalid(error),
            ),
          ),
      )
      .handle("stackAgentRuntime.activate", (ctx) =>
        runtime.activate(ctx.payload.generation).pipe(Effect.mapError(invalid)),
      )
      .handle("stackAgentRuntime.rollback", () => runtime.rollback().pipe(Effect.mapError(invalid)))
      .handle("stackAgentRuntime.usage", (ctx) =>
        runtime.usage(ctx.params.sessionID).pipe(Effect.map((usage) => usage ?? null)),
      )
  }),
)

function invalid(error: StackAgentRuntime.InvalidInputError) {
  return new InvalidRequestError({ message: error.message })
}
