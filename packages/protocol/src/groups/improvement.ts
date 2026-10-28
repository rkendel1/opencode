import { Improvement } from "@opencode/schema/improvement"
import { AbsolutePath } from "@opencode/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { InvalidRequestError } from "../errors.js"

const root = "/api/improvement"

export class ImprovementNotFoundError extends Schema.TaggedError<ImprovementNotFoundError>()(
  "ImprovementNotFoundError",
  { improvementID: Schema.String, message: Schema.String },
  { httpApiStatus: 404 },
) {}

const params = { improvementID: Improvement.ID }

export const ImprovementGroup = HttpApiGroup.make("server.improvement")
  .add(
    HttpApiEndpoint.get("improvement.analysis", `${root}/analysis`, {
      query: Schema.Struct({ directory: AbsolutePath }),
      success: Improvement.Analysis,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "improvement.analysis",
        summary: "Analyze agent runs",
        description:
          "Run the statistical analysis over the project's verified comparison history and return structured findings, or explicit insufficient-data results.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("improvement.list", root, { success: Schema.Array(Improvement.Summary) }).annotateMerge(
      OpenApi.annotations({ identifier: "improvement.list", summary: "List improvements" }),
    ),
  )
  .add(
    HttpApiEndpoint.post("improvement.create", root, {
      payload: Improvement.CreateInput,
      success: Improvement.Info,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "improvement.create",
        summary: "Investigate a finding",
        description:
          "Snapshot a supported finding and start a read-only LLM investigation that must return a schema-valid, evidence-grounded proposal.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("improvement.get", `${root}/:improvementID`, {
      params,
      success: Improvement.Info,
      error: ImprovementNotFoundError,
    }).annotateMerge(OpenApi.annotations({ identifier: "improvement.get", summary: "Get an improvement" })),
  )
  .add(
    HttpApiEndpoint.post("improvement.investigate", `${root}/:improvementID/investigate`, {
      params,
      success: Improvement.Info,
      error: [ImprovementNotFoundError, InvalidRequestError],
    }).annotateMerge(
      OpenApi.annotations({ identifier: "improvement.investigate", summary: "Investigate a finding again" }),
    ),
  )
  .add(
    HttpApiEndpoint.post("improvement.approve", `${root}/:improvementID/approve`, {
      params,
      payload: Improvement.ApproveInput,
      success: Improvement.Info,
      error: [ImprovementNotFoundError, InvalidRequestError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "improvement.approve",
        summary: "Approve a proposal",
        description:
          "Fix the evaluation plan, then run the baseline, implement the proposal in an isolated worktree under the project's permissions, and evaluate the candidate.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("improvement.decide", `${root}/:improvementID/decide`, {
      params,
      payload: Improvement.DecideInput,
      success: Improvement.Info,
      error: [ImprovementNotFoundError, InvalidRequestError],
    }).annotateMerge(OpenApi.annotations({ identifier: "improvement.decide", summary: "Record a review decision" })),
  )
  .annotateMerge(
    OpenApi.annotations({ title: "improvement", description: "Evidence-driven agent improvement routes." }),
  )
