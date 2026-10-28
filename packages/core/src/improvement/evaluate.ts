export * as ImprovementEvaluate from "./evaluate.js"

import type { Comparison } from "@opencode/schema/comparison"
import type { Improvement } from "@opencode/schema/improvement"
import { ImprovementStats } from "./stats.js"

const HARNESSES: readonly Comparison.Harness[] = ["opencode", "stack-agent"]
const METRICS = [
  ["duration", "Median duration (ms)"],
  ["toolCalls", "Median tool calls"],
  ["toolFailures", "Median failed tool calls"],
  ["terminalFailures", "Median failed terminal commands"],
  ["retries", "Median provider retries"],
  ["inputTokens", "Median input tokens"],
  ["outputTokens", "Median output tokens"],
  ["cost", "Median cost (USD)"],
] as const

type Variant = { variant: "baseline" | "candidate"; runs: readonly Comparison.Run[] }

/**
 * Compares candidate runs with baseline runs under the plan fixed at approval. Verified success decides; efficiency
 * metrics are reported but never decide. One-sided Fisher exact tests at the plan's alpha guard against calling
 * noise an improvement, so a small evaluation set is usually inconclusive rather than improved.
 */
export function compare(variants: readonly Variant[], plan: Improvement.Plan) {
  const results = HARNESSES.map((harness): Improvement.HarnessResult => {
    const pick = (variant: Variant["variant"]) =>
      variants
        .filter((item) => item.variant === variant)
        .flatMap((item) => item.runs.filter((run) => run.harness === harness))
    const baseline = pick("baseline")
    const candidate = pick("candidate")
    const before = rate(baseline)
    const after = rate(candidate)
    const evaluable = before.verified > 0 && after.verified > 0
    return {
      harness,
      target: plan.targetRuntimes.includes(harness),
      baseline: before,
      candidate: after,
      pImproved: evaluable ? fisher(after, before, "greater") : undefined,
      pRegressed: evaluable ? fisher(after, before, "less") : undefined,
      criterionRegressions: regressions(baseline, candidate),
      metrics: METRICS.map(([key, label]) => ({
        key,
        label,
        baseline: ImprovementStats.median(values(baseline, key)),
        candidate: ImprovementStats.median(values(candidate, key)),
      })),
    }
  })
  return { results, ...verdict(results, plan.alpha) }
}

function verdict(results: readonly Improvement.HarnessResult[], alpha: number) {
  const regressed = results.filter(
    (result) =>
      (result.pRegressed !== undefined && result.pRegressed <= alpha) || result.criterionRegressions.length > 0,
  )
  if (regressed.length > 0)
    return {
      verdict: "regressed" as const,
      reason: regressed
        .map((result) =>
          result.criterionRegressions.length > 0
            ? `${result.harness}: criteria that passed before now fail (${result.criterionRegressions.join("; ")})`
            : `${result.harness}: verified success fell from ${result.baseline.successes}/${result.baseline.verified} to ${result.candidate.successes}/${result.candidate.verified} (one-sided p = ${result.pRegressed?.toFixed(3)})`,
        )
        .join(". "),
    }
  const targets = results.filter((result) => result.target)
  if (targets.some((result) => result.pImproved === undefined))
    return {
      verdict: "inconclusive" as const,
      reason: "A target runtime has no verified baseline or candidate run to compare",
    }
  const improved = targets.filter((result) => (result.pImproved ?? 1) <= alpha)
  if (improved.length > 0)
    return {
      verdict: "improved" as const,
      reason: improved
        .map(
          (result) =>
            `${result.harness}: verified success rose from ${result.baseline.successes}/${result.baseline.verified} to ${result.candidate.successes}/${result.candidate.verified} (one-sided p = ${result.pImproved?.toFixed(3)} ≤ ${alpha}) with no regressed criteria`,
        )
        .join(". "),
    }
  return {
    verdict: "inconclusive" as const,
    reason: targets
      .map(
        (result) =>
          `${result.harness}: ${result.baseline.successes}/${result.baseline.verified} → ${result.candidate.successes}/${result.candidate.verified} verified successes (one-sided p = ${result.pImproved?.toFixed(3)} > ${alpha}); more trials are needed to separate this from noise`,
      )
      .join(". "),
  }
}

function rate(runs: readonly Comparison.Run[]) {
  const outcomes = runs.flatMap((run) => (run.report ? [run.report.outcome] : []))
  const verified = outcomes.filter(
    (outcome) => outcome === "verified-success" || outcome === "partial" || outcome === "failed",
  )
  return {
    runs: runs.length,
    verified: verified.length,
    successes: verified.filter((outcome) => outcome === "verified-success").length,
  }
}

function fisher(after: ReturnType<typeof rate>, before: ReturnType<typeof rate>, side: "greater" | "less") {
  return ImprovementStats.fisher(
    after.successes,
    after.verified - after.successes,
    before.successes,
    before.verified - before.successes,
    side,
  )
}

/** Criteria that passed in every baseline run that checked them and failed in every candidate run that did. */
function regressions(baseline: readonly Comparison.Run[], candidate: readonly Comparison.Run[]) {
  const statuses = (runs: readonly Comparison.Run[], description: string) =>
    runs.flatMap((run) =>
      (run.report?.criteria ?? [])
        .filter((item) => item.description === description && (item.status === "passed" || item.status === "failed"))
        .map((item) => item.status),
    )
  const descriptions = [
    ...new Set(baseline.flatMap((run) => (run.report?.criteria ?? []).map((item) => item.description))),
  ]
  return descriptions.filter((description) => {
    const before = statuses(baseline, description)
    const after = statuses(candidate, description)
    return (
      before.length > 0 && after.length > 0 && before.every((s) => s === "passed") && after.every((s) => s === "failed")
    )
  })
}

function values(runs: readonly Comparison.Run[], key: string) {
  return runs.flatMap((run) =>
    [...(run.report?.metrics ?? [])]
      .filter((entry) => entry.key === key && entry.metric.available && entry.metric.value !== undefined)
      .map((entry) => entry.metric.value!),
  )
}
