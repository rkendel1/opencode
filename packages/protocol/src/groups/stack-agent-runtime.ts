import { SessionID } from "@opencode/schema/session-id"
import { StackAgentRuntime } from "@opencode/schema/stack-agent-runtime"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { ConflictError, InvalidRequestError } from "../errors.js"

const root = "/api/stack-agent"

export const StackAgentRuntimeGroup = HttpApiGroup.make("server.stackAgentRuntime")
  .add(
    HttpApiEndpoint.get("stackAgentRuntime.status", root, { success: StackAgentRuntime.Status }).annotateMerge(
      OpenApi.annotations({
        identifier: "stackAgentRuntime.status",
        summary: "Stack-Agent runtime status",
        description:
          "The active and previous generations, recent builds, the executable new tasks would use, and the tasks running now with the generation each started on.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.patch("stackAgentRuntime.configure", `${root}/settings`, {
      payload: StackAgentRuntime.SettingsInput,
      success: StackAgentRuntime.Settings,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "stackAgentRuntime.configure", summary: "Configure the source" }),
    ),
  )
  .add(
    HttpApiEndpoint.post("stackAgentRuntime.check", `${root}/check`, {
      payload: StackAgentRuntime.CheckInput,
      success: StackAgentRuntime.Status,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "stackAgentRuntime.check",
        summary: "Check for updates",
        description: "Compare the configured branch with the active generation. Never changes the active runtime.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("stackAgentRuntime.build", `${root}/build`, {
      payload: StackAgentRuntime.BuildInput,
      success: StackAgentRuntime.Generation,
      error: [InvalidRequestError, ConflictError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "stackAgentRuntime.build",
        summary: "Build and stage",
        description:
          "Build a revision in an isolated worktree into a new versioned executable and validate it. Does not activate it.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("stackAgentRuntime.activate", `${root}/activate`, {
      payload: Schema.Struct({ generation: Schema.String }),
      success: StackAgentRuntime.Status,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "stackAgentRuntime.activate",
        summary: "Activate a validated build",
        description: "New Stack-Agent tasks use the generation; running tasks finish on the executable they started.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("stackAgentRuntime.rollback", `${root}/rollback`, {
      success: StackAgentRuntime.Status,
      error: InvalidRequestError,
    }).annotateMerge(OpenApi.annotations({ identifier: "stackAgentRuntime.rollback", summary: "Roll back" })),
  )
  .add(
    HttpApiEndpoint.get("stackAgentRuntime.usage", `${root}/usage/:sessionID`, {
      params: { sessionID: SessionID },
      success: Schema.NullOr(StackAgentRuntime.Usage),
    }).annotateMerge(
      OpenApi.annotations({ identifier: "stackAgentRuntime.usage", summary: "Runtime versions a Session used" }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({ title: "stack-agent", description: "Versioned Stack-Agent runtime management." }),
  )
