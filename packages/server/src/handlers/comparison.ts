import { Comparison } from "@opencode/core/comparison"
import { InvalidRequestError } from "@opencode/protocol/errors"
import { ComparisonNotFoundError } from "@opencode/protocol/groups/comparison"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"

export const ComparisonHandler = HttpApiBuilder.group(Api, "server.comparison", (handlers) =>
  Effect.gen(function* () {
    const comparisons = yield* Comparison.Service
    return handlers
      .handle("comparison.list", () => comparisons.list())
      .handle("comparison.create", (ctx) => comparisons.create(ctx.payload).pipe(Effect.mapError(invalid)))
      .handle("comparison.get", (ctx) => comparisons.get(ctx.params.comparisonID).pipe(Effect.mapError(missing)))
      .handle("comparison.cancel", (ctx) =>
        comparisons.cancel(ctx.params.comparisonID, ctx.payload).pipe(Effect.mapError(missing)),
      )
      .handle("comparison.rerun", (ctx) =>
        comparisons
          .rerun(ctx.params.comparisonID)
          .pipe(
            Effect.mapError((error) => (error._tag === "Comparison.NotFoundError" ? missing(error) : invalid(error))),
          ),
      )
  }),
)

function missing(error: Comparison.NotFoundError) {
  return new ComparisonNotFoundError({ comparisonID: error.id, message: `Comparison not found: ${error.id}` })
}

function invalid(error: Comparison.InvalidInputError) {
  return new InvalidRequestError({ message: error.message })
}
