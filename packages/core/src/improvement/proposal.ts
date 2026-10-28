export * as ImprovementProposal from "./proposal.js"

import path from "path"
import { Schema } from "effect"
import type { Comparison } from "@opencode/schema/comparison"
import { Improvement } from "@opencode/schema/improvement"
import type { SessionMessage } from "@opencode/schema/session-message"

const decode = Schema.decodeUnknownExit(Improvement.Proposal)
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const READ_TOOLS = new Set(["read", "grep", "glob", "list"])

const EXAMPLE = {
  version: 1,
  findingID: "<the finding id>",
  title: "Short imperative title",
  cause: "What most likely causes the problem, citing the evidence",
  hypothesis: "If <change>, then <measurable effect on verified outcomes>",
  mechanism: "Why the change should produce that effect",
  layer: "prompt-context",
  alternatives: ["Other explanations the evidence does not rule out"],
  sourceLocations: [{ path: "relative/path/you/opened", line: 12, reason: "Why this code matters" }],
  changes: [{ path: "relative/path/to/change", description: "The smallest change" }],
  acceptanceCriteria: [
    { id: "tests", description: "Focused check", command: "a shell command run from the repository root" },
  ],
  evaluation: { taskKeys: ["<one of the finding's task keys>"], trials: 3, targetRuntimes: ["opencode"] },
  risks: ["Regressions or security risks"],
  rollback: ["Condition under which the change must be reverted"],
  requiredApprovals: ["Approvals a reviewer must give"],
}

/** The investigation prompt. The agent is in read-only Plan mode inside a worktree at the base revision. */
export function prompt(
  finding: Improvement.Finding,
  traces: readonly { evidence: Improvement.FindingEvidence; activity: readonly Comparison.Activity[] }[],
) {
  return [
    "You are investigating a weakness that statistical analysis found in this project's recorded agent runs.",
    "Investigate the repository before proposing anything. Open the files that matter; cite only files you opened.",
    "The finding is an association, not a proven cause. Treat your own explanation as a hypothesis, list alternatives, and design a test that could refute it.",
    "Prefer the smallest change. Do not propose changes to permission settings; the pipeline will not evaluate them.",
    "",
    "## Finding",
    "```json",
    JSON.stringify(
      {
        id: finding.id,
        title: finding.title,
        statement: finding.statement,
        interpretation: finding.interpretation,
        scope: finding.scope,
        effect: finding.effect,
        comparisonGroup: finding.comparisonGroup,
        sampleSize: finding.sampleSize,
        taskKeys: finding.taskKeys,
      },
      null,
      2,
    ),
    "```",
    "",
    "## Affected executions (most recent activity)",
    ...traces.flatMap((trace) => [
      `- ${trace.evidence.title} (${trace.evidence.harness}, ${trace.evidence.outcome ?? "not evaluated"}): ${trace.evidence.note}`,
      ...trace.activity.map((item) => `  - ${item.kind}: ${item.label}${item.detail ? ` — ${item.detail}` : ""}`),
    ]),
    "",
    "## Answer",
    "When your investigation is complete, reply with exactly one JSON object in a ```json block, matching this shape. Extra fields are rejected. `evaluation.taskKeys` must come from the finding's taskKeys; `evaluation.trials` is 1–5; acceptance commands must pass after a correct change.",
    "```json",
    JSON.stringify(EXAMPLE, null, 2),
    "```",
  ].join("\n")
}

export function implementationPrompt(finding: Improvement.Finding, proposal: Improvement.Proposal) {
  return [
    `Implement this approved change. It addresses: ${finding.title} (${finding.statement})`,
    "",
    `Hypothesis: ${proposal.hypothesis}`,
    "",
    "Changes:",
    ...proposal.changes.map((change) => `- ${change.path}: ${change.description}`),
    "",
    "These commands must pass when you are done:",
    ...proposal.acceptanceCriteria.map((criterion) => `- ${criterion.command}  (${criterion.description})`),
    "",
    "Keep the change minimal and limited to the files above unless one is genuinely required. Do not change permission settings. Do not commit; the pipeline commits and records your work.",
  ].join("\n")
}

/** The text of the last assistant message: the agent's answer. */
export function lastAnswer(messages: readonly SessionMessage.Info[]) {
  const last = messages.findLast(
    (message) => message.type === "assistant" && message.content.some((part) => part.type === "text"),
  )
  if (last?.type !== "assistant") return ""
  return last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
}

/** Workspace-relative paths the agent opened with a read-only tool, for the grounding check. */
export function openedPaths(messages: readonly SessionMessage.Info[], workspace: string) {
  return new Set(
    messages.flatMap((message) =>
      message.type !== "assistant"
        ? []
        : message.content.flatMap((part) => {
            if (part.type !== "tool" || !READ_TOOLS.has(part.name) || part.state.status !== "completed") return []
            const value = part.state.input.path ?? part.state.input.filePath
            if (typeof value !== "string") return []
            return [normalize(path.isAbsolute(value) ? path.relative(workspace, value) : value)]
          }),
    ),
  )
}

/**
 * Validates an answer against the proposal schema and against the evidence: it must address this finding, evaluate
 * on the finding's own tasks, cite files that exist and that the agent opened, and stay inside the repository.
 */
export async function parse(input: {
  text: string
  finding: Improvement.Finding
  opened: ReadonlySet<string>
  exists: (file: string) => Promise<boolean>
}): Promise<{ proposal?: Improvement.Proposal; errors: string[] }> {
  const json = extractJson(input.text)
  if (json === undefined) return { errors: ["The answer contains no JSON object"] }
  const decoded = decode(json, { errors: "all", onExcessProperty: "error" })
  if (decoded._tag === "Failure")
    return { errors: [`The proposal does not match the schema: ${String(decoded.cause)}`] }
  const proposal = decoded.value
  const errors = [
    ...(proposal.findingID === input.finding.id
      ? []
      : [`The proposal addresses ${proposal.findingID}, not ${input.finding.id}`]),
    ...proposal.evaluation.taskKeys
      .filter((key) => !input.finding.taskKeys.includes(key))
      .map((key) => `Evaluation task ${key} is not one of the finding's tasks`),
    ...[...proposal.sourceLocations.map((item) => item.path), ...proposal.changes.map((item) => item.path)]
      .filter((file) => !inside(file))
      .map((file) => `${file} is outside the repository`),
  ]
  const cited = proposal.sourceLocations.map((item) => normalize(item.path)).filter(inside)
  const missing = (
    await Promise.all(cited.map(async (file) => ((await input.exists(file)) ? undefined : file)))
  ).filter((file): file is string => file !== undefined)
  errors.push(...missing.map((file) => `Cited source ${file} does not exist at the base revision`))
  if (!cited.some((file) => input.opened.has(file)))
    errors.push("None of the cited source locations was opened during the investigation")
  return errors.length > 0 ? { errors } : { proposal, errors: [] }
}

/** Files whose permission configuration a patch changes; such patches are never evaluated automatically. */
export function permissionChanges(diff: string) {
  const files = new Set<string>()
  let current = ""
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) current = line.split(" b/")[1] ?? ""
    const config = /(^|\/)(opencode\.jsonc?|\.opencode\/)/.test(current)
    if (config && /^[+-](?![+-]{2})/.test(line) && /permission/i.test(line)) files.add(current)
  }
  return [...files]
}

function extractJson(text: string) {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((match) => match[1]).at(-1)
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)
  const parsed = decodeJson(candidate)
  return parsed._tag === "Some" ? parsed.value : undefined
}

const normalize = (file: string) => path.posix.normalize(file.replaceAll("\\", "/")).replace(/^\.\//, "")
const inside = (file: string) => !path.isAbsolute(file) && !normalize(file).startsWith("..")
