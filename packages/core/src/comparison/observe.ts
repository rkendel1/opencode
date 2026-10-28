export * as ComparisonObserve from "./observe.js"

import { DateTime } from "effect"
import type { Comparison } from "@opencode/schema/comparison"
import type { Model } from "@opencode/schema/model"
import type { SessionMessage } from "@opencode/schema/session-message"

// Keeps the live activity feed and the persisted report bounded however long a run gets.
const ACTIVITY_LIMIT = 200
const DETAIL_LIMIT = 240

const SHELL_TOOL = "shell"
const STACK_AGENT_TOOLS =
  "stack-agent runs its tools inside its own process; opencode receives only its text transcript"

/**
 * Folds a run's persisted Session messages, the same records the session view renders, into what can be stated
 * without trusting the agent's own words. Every metric names the record it counts; a metric the runtime cannot
 * expose is unavailable, never zero.
 */
export function observe(harness: Comparison.Harness, messages: readonly SessionMessage.Info[]) {
  const state = {
    error: undefined as string | undefined,
    startedAt: undefined as number | undefined,
    endedAt: undefined as number | undefined,
    models: [] as Model.Ref[],
    ...counters(),
    unrecovered: 0,
    claim: undefined as string | undefined,
    activity: [] as Comparison.Activity[],
  }
  const seen = new Set<string>()
  const push = (item: Comparison.Activity) =>
    state.activity.push({ ...item, detail: item.detail === undefined ? undefined : clip(item.detail) })
  const terminal = (item: Omit<Comparison.Activity, "kind">, exit: number | undefined) => {
    state.terminal++
    if (exit === undefined || exit === 0) {
      // A failure followed by a passing command counts as recovered, whichever command it was.
      state.recovered += state.unrecovered
      state.unrecovered = 0
      push({ ...item, kind: "terminal" })
      return
    }
    state.terminalFailures++
    state.unrecovered++
    push({ ...item, kind: "terminal-failed" })
  }

  for (const message of messages) {
    const at = DateTime.toEpochMillis(message.time.created)
    if (message.type === "shell") {
      terminal(
        {
          messageID: message.id,
          at,
          label: message.command,
          detail: message.exit === undefined ? message.status : `exit ${message.exit}`,
        },
        message.exit,
      )
      continue
    }
    if (message.type !== "assistant") continue
    state.steps++
    state.startedAt ??= at
    const completed = message.time.completed ? DateTime.toEpochMillis(message.time.completed) : at
    state.endedAt = Math.max(state.endedAt ?? at, completed)
    if (!state.models.some((model) => model.id === message.model.id && model.providerID === message.model.providerID))
      state.models.push(message.model)
    push({
      messageID: message.id,
      at,
      kind: "step",
      label: `Step ${state.steps}`,
      detail: `${message.model.providerID}/${message.model.id}`,
    })
    if (message.tokens) {
      state.tokens.input += message.tokens.input + message.tokens.cache.read + message.tokens.cache.write
      state.tokens.output += message.tokens.output + message.tokens.reasoning
      state.tokens.reported++
    }
    state.cost += message.cost ?? 0
    if (message.retry) {
      state.retries += message.retry.attempt
      push({
        messageID: message.id,
        at,
        kind: "retry",
        label: `Retried ${message.retry.attempt}×`,
        detail: message.retry.error.message,
      })
    }
    state.error = message.error ? `${message.error.type}: ${message.error.message}` : undefined
    if (message.error) {
      state.stepFailures++
      push({ messageID: message.id, at, kind: "tool-failed", label: "Step failed", detail: message.error.message })
    }
    for (const part of message.content) {
      if (part.type === "text") {
        if (part.text.trim()) state.claim = clip(part.text.trim(), 2000)
        continue
      }
      if (part.type !== "tool" || part.state.status === "streaming") continue
      const ref = { messageID: message.id, toolCallID: part.id, at: DateTime.toEpochMillis(part.time.created) }
      state.tools++
      const key = `${part.name}\0${stableJson(part.state.input)}`
      if (seen.has(key)) state.repeated++
      seen.add(key)
      const command = part.name === SHELL_TOOL ? stringField(part.state.input, "command") : undefined
      if (part.state.status === "error") {
        state.toolFailures++
        const type = part.state.error.type
        if (type.startsWith("tool.input") || type === "tool.unknown") state.invalidInput++
        if (type === "permission.rejected") state.denials++
        if (command !== undefined) {
          state.terminal++
          state.terminalFailures++
          state.unrecovered++
        }
        push({
          ...ref,
          kind: command === undefined ? "tool-failed" : "terminal-failed",
          label: command ?? part.name,
          detail: `${type}: ${part.state.error.message}`,
        })
        continue
      }
      if (command !== undefined) {
        const exit = part.state.status === "completed" ? numberField(part.state.metadata, "exit") : undefined
        terminal({ ...ref, label: command, detail: exit === undefined ? part.state.status : `exit ${exit}` }, exit)
        continue
      }
      push({ ...ref, kind: "tool", label: part.name, detail: summarize(part.state.input) })
    }
  }

  return {
    error: state.error,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    models: state.models,
    claim: state.claim,
    activity: state.activity.slice(-ACTIVITY_LIMIT),
    metrics: metrics(harness, state),
  } satisfies Comparison.Observation
}

const counters = () => ({
  steps: 0,
  stepFailures: 0,
  tokens: { input: 0, output: 0, reported: 0 },
  cost: 0,
  tools: 0,
  toolFailures: 0,
  invalidInput: 0,
  denials: 0,
  retries: 0,
  repeated: 0,
  terminal: 0,
  terminalFailures: 0,
  recovered: 0,
})

function metrics(harness: Comparison.Harness, state: ReturnType<typeof counters>) {
  const native = harness === "opencode"
  const tool = (
    label: string,
    value: number,
    source: string,
    method: string,
    kind: Comparison.Metric["kind"] = "observed",
  ) => (native ? metric(label, value, source, method, kind) : unavailable(label, STACK_AGENT_TOOLS))
  const tokens = (label: string, value: number) =>
    // A run whose steps reported no usage at all leaves token counts unknown rather than zero.
    state.tokens.reported === 0
      ? unavailable(label, "No step reported token usage")
      : metric(label, value, "assistant message tokens", "Sum of provider-reported usage across steps")
  return [
    {
      key: "modelRequests",
      metric: native
        ? metric("Model requests", state.steps, "assistant messages", "One assistant message per LLM call")
        : unavailable(
            "Model requests",
            "stack-agent's gateway forwards each call to the Session model but records only the run total, not a call count",
          ),
    },
    { key: "inputTokens", metric: tokens("Input tokens", state.tokens.input) },
    { key: "outputTokens", metric: tokens("Output tokens", state.tokens.output) },
    {
      key: "cost",
      metric:
        state.cost > 0
          ? {
              ...metric(
                "Estimated cost",
                state.cost,
                "assistant message cost",
                "Provider usage priced by the model catalog",
              ),
              unit: "USD",
            }
          : unavailable("Estimated cost", "No priced usage was recorded; the model may have no catalog pricing"),
    },
    {
      key: "stepFailures",
      metric: metric("Failed steps", state.stepFailures, "assistant message error", "Steps that ended in an error"),
    },
    {
      key: "retries",
      metric: metric(
        "Provider retries",
        state.retries,
        "assistant message retry",
        "Sum of each step's final retry attempt",
      ),
    },
    { key: "toolCalls", metric: tool("Tool calls", state.tools, "assistant tool parts", "Count of tool calls") },
    {
      key: "toolFailures",
      metric: tool("Failed tool calls", state.toolFailures, "tool parts in error state", "Count of failed tool calls"),
    },
    {
      key: "invalidToolInput",
      metric: tool(
        "Invalid tool arguments",
        state.invalidInput,
        "tool parts in error state",
        "Errors typed tool.input-* or tool.unknown",
      ),
    },
    {
      key: "permissionDenials",
      metric: tool(
        "Permission denials",
        state.denials,
        "tool parts in error state",
        "Errors typed permission.rejected",
      ),
    },
    {
      key: "repeatedToolCalls",
      metric: tool(
        "Repeated tool calls",
        state.repeated,
        "assistant tool parts",
        "Calls whose tool and input exactly match an earlier call",
        "inferred",
      ),
    },
    {
      key: "terminalCommands",
      metric: tool(
        "Terminal commands",
        state.terminal,
        "shell tool parts and shell messages",
        "Agent shell calls and Session shell commands",
      ),
    },
    {
      key: "terminalFailures",
      metric: tool(
        "Failed terminal commands",
        state.terminalFailures,
        "shell exit metadata",
        "Non-zero exit or failed shell call",
      ),
    },
    {
      key: "recoveries",
      metric: tool(
        "Recovered command failures",
        state.recovered,
        "shell exit metadata",
        "Failed commands later followed by a passing command",
        "inferred",
      ),
    },
  ]
}

export function metric(
  label: string,
  value: number,
  source: string,
  method: string,
  kind: Comparison.Metric["kind"] = "observed",
): Comparison.Metric {
  return { label, value, available: true, kind, source, method }
}

export function unavailable(label: string, method: string): Comparison.Metric {
  return { label, available: false, kind: "observed", source: "unavailable", method }
}

function stringField(input: Record<string, unknown>, key: string) {
  const value = input[key]
  return typeof value === "string" ? value : undefined
}

function numberField(input: Record<string, unknown> | undefined, key: string) {
  const value = input?.[key]
  return typeof value === "number" ? value : undefined
}

function summarize(input: Record<string, unknown>) {
  return (
    stringField(input, "path") ??
    stringField(input, "filePath") ??
    stringField(input, "pattern") ??
    clip(JSON.stringify(input))
  )
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}

function clip(text: string, limit = DETAIL_LIMIT) {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}
