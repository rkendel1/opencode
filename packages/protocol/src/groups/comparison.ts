import { Comparison } from "@opencode/schema/comparison"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { InvalidRequestError } from "../errors.js"

const root = "/api/comparison"

export class ComparisonNotFoundError extends Schema.TaggedError<ComparisonNotFoundError>()(
  "ComparisonNotFoundError",
  { comparisonID: Schema.String, message: Schema.String },
  { httpApiStatus: 404 },
) {}

export const ComparisonGroup = HttpApiGroup.make("server.comparison")
  .add(
    HttpApiEndpoint.get("comparison.list", root, {
      success: Schema.Array(Comparison.Summary),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "comparison.list",
        summary: "List agent comparisons",
        description: "Return every recorded agent comparison, newest first, with each run's status and outcome.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("comparison.create", root, {
      payload: Comparison.CreateInput,
      success: Comparison.Info,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "comparison.create",
        summary: "Start an agent comparison",
        description:
          "Record an immutable comparison of one task, then run it through the opencode and stack-agent runtimes in separate worktrees created from the repository's current commit. Returns once the record exists; the runs continue in the background.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("comparison.get", `${root}/:comparisonID`, {
      params: { comparisonID: Comparison.ID },
      success: Comparison.Info,
      error: ComparisonNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "comparison.get",
        summary: "Get an agent comparison",
        description:
          "Return the comparison record, each run's live observation or final report, qualifications, and the outcome distribution across reruns of the same task.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("comparison.cancel", `${root}/:comparisonID/cancel`, {
      params: { comparisonID: Comparison.ID },
      payload: Comparison.CancelInput,
      success: Comparison.Info,
      error: ComparisonNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "comparison.cancel",
        summary: "Cancel an agent comparison run",
        description: "Interrupt one run, or both when no harness is given. Finished runs are left unchanged.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("comparison.rerun", `${root}/:comparisonID/rerun`, {
      params: { comparisonID: Comparison.ID },
      success: Comparison.Info,
      error: [ComparisonNotFoundError, InvalidRequestError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "comparison.rerun",
        summary: "Rerun an agent comparison",
        description:
          "Start a new comparison with the same task, acceptance criteria and models at the repository's current commit.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({ title: "comparison", description: "Side-by-side agent runtime comparison routes." }),
  )
