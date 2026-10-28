import { Improvement } from "@opencode/core/improvement"
import { InvalidRequestError } from "@opencode/protocol/errors"
import { ImprovementNotFoundError } from "@opencode/protocol/groups/improvement"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"

export const ImprovementHandler = HttpApiBuilder.group(Api, "server.improvement", (handlers) =>
  Effect.gen(function* () {
    const improvements = yield* Improvement.Service
    return handlers
      .handle("improvement.analysis", (ctx) => improvements.analysis(ctx.query.directory))
      .handle("improvement.list", () => improvements.list())
      .handle("improvement.create", (ctx) => improvements.create(ctx.payload).pipe(Effect.mapError(invalid)))
      .handle("improvement.get", (ctx) => improvements.get(ctx.params.improvementID).pipe(Effect.mapError(missing)))
      .handle("improvement.investigate", (ctx) =>
        improvements.investigate(ctx.params.improvementID).pipe(Effect.mapError(either)),
      )
      .handle("improvement.approve", (ctx) =>
        improvements.approve(ctx.params.improvementID, ctx.payload).pipe(Effect.mapError(either)),
      )
      .handle("improvement.decide", (ctx) =>
        improvements.decide(ctx.params.improvementID, ctx.payload).pipe(Effect.mapError(either)),
      )
      .handle("improvement.preview", (ctx) =>
        improvements.preview(ctx.params.improvementID).pipe(Effect.mapError(either)),
      )
      .handle("improvement.apply", (ctx) => improvements.apply(ctx.params.improvementID).pipe(Effect.mapError(either)))
      .handle("improvement.stage", (ctx) => improvements.stage(ctx.params.improvementID).pipe(Effect.mapError(either)))
      .handle("improvement.publish", (ctx) =>
        improvements.publish(ctx.params.improvementID).pipe(Effect.mapError(either)),
      )
  }),
)

function either(error: Improvement.NotFoundError | Improvement.InvalidInputError) {
  return error._tag === "Improvement.NotFoundError" ? missing(error) : invalid(error)
}

function missing(error: Improvement.NotFoundError) {
  return new ImprovementNotFoundError({ improvementID: error.id, message: `Improvement not found: ${error.id}` })
}

function invalid(error: Improvement.InvalidInputError) {
  return new InvalidRequestError({ message: error.message })
}
