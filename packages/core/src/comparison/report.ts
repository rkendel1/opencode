export * as ComparisonReport from "./report.js"

import type { Comparison } from "@opencode/schema/comparison"

/**
 * Classifies a run from evaluator evidence only. The agent's own claim of completion is never an input.
 *
 * - cancelled: the user stopped the run before evaluation.
 * - failed: a criterion that passed before the agent started now fails (a verified regression), or every
 *   verifiable criterion fails.
 * - partial: some verifiable criteria pass and others fail.
 * - unverified: nothing could be verified, or every verifiable criterion passes but others need manual review.
 * - verified-success: every criterion has a command and every command passes.
 */
export function classify(input: { cancelled: boolean; criteria: readonly Comparison.CriterionResult[] }) {
  if (input.cancelled) return outcome("cancelled", "The run was cancelled before evaluation completed")
  const verifiable = input.criteria.filter((item) => item.status === "passed" || item.status === "failed")
  const passed = verifiable.filter((item) => item.status === "passed").length
  const manual = input.criteria.length - verifiable.length
  const regressions = input.criteria.filter((item) => item.regression)
  if (regressions.length > 0)
    return outcome("failed", `Verified regression: ${regressions.map((item) => item.description).join("; ")}`)
  if (verifiable.length === 0)
    return outcome(
      "unverified",
      input.criteria.length === 0
        ? "No acceptance criteria were defined"
        : "No acceptance criterion has a verification command",
    )
  if (passed === 0) return outcome("failed", `All ${verifiable.length} verifiable criteria failed`)
  if (passed < verifiable.length)
    return outcome("partial", `${passed} of ${verifiable.length} verifiable criteria passed`)
  if (manual > 0) return outcome("unverified", `All ${passed} verifiable criteria passed; ${manual} need manual review`)
  return outcome("verified-success", `All ${passed} criteria passed their verification commands`)
}

const outcome = (value: Comparison.Outcome, reason: string) => ({ outcome: value, reason })

/** Parses `git diff --numstat -z <revision>` and `git status --porcelain=v1 -z` into per-file changes. */
export function changes(numstat: string, status: string): Comparison.FileChange[] {
  const counted = parseNumstat(numstat)
  const entries = status.split("\0").filter(Boolean)
  const result: Comparison.FileChange[] = []
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    const code = entry.slice(0, 2)
    const path = entry.slice(3)
    // Renames and copies carry the original path as the next NUL-separated field.
    if (code.includes("R") || code.includes("C")) index++
    const stats = counted.get(path)
    result.push({
      path,
      status:
        code === "??"
          ? "untracked"
          : code.includes("R")
            ? "renamed"
            : code.includes("D")
              ? "deleted"
              : code.includes("A")
                ? "added"
                : "modified",
      additions: stats?.additions,
      deletions: stats?.deletions,
    })
    counted.delete(path)
  }
  // Committed changes are clean in status but still differ from the starting revision.
  for (const [path, stats] of counted) result.push({ path, status: "modified", ...stats })
  return result.toSorted((left, right) => left.path.localeCompare(right.path))
}

function parseNumstat(text: string) {
  const fields = text.split("\0")
  const result = new Map<string, { additions?: number; deletions?: number }>()
  for (let index = 0; index < fields.length; index++) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(fields[index])
    if (!match) continue
    // A rename's numstat leaves the path empty and puts source and destination in the next two fields.
    const path = match[3] === "" ? fields[(index += 2)] : match[3]
    if (path === undefined) continue
    // Binary files report "-": their line counts are unknown, not zero.
    result.set(path, {
      additions: match[1] === "-" ? undefined : Number(match[1]),
      deletions: match[2] === "-" ? undefined : Number(match[2]),
    })
  }
  return result
}

/** The grouping key for repeated trials: the same prompt and criteria in the same repository. */
export function taskKey(projectID: string, task: Comparison.Task) {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(
    JSON.stringify([projectID, task.prompt, task.criteria.map((item) => [item.description, item.command ?? null])]),
  )
  return hasher.digest("hex").slice(0, 16)
}
