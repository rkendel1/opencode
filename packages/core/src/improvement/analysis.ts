export * as ImprovementAnalysis from "./analysis.js"

import type { Comparison } from "@opencode/schema/comparison"
import type { Improvement } from "@opencode/schema/improvement"
import { ImprovementStats } from "./stats.js"

/** Predefined thresholds. Findings are reported against these, never tuned per dataset. */
export const ALPHA = 0.1
const MIN_VERIFIED = 8
const MIN_GROUP = 3
const MIN_DISCORDANT = 5
const MIN_PAIRS = 5
const RECURRING_LOWER_BOUND = 0.4
const EVIDENCE_LIMIT = 12

const EDITING_CATEGORIES: readonly Comparison.Category[] = ["implementation", "bug-fix", "failure-recovery"]

const FEATURES: Record<string, { label: string; stage: string }> = {
  "tool-failures": { label: "failed tool calls", stage: "tool use" },
  "invalid-tool-input": { label: "invalid tool arguments", stage: "tool arguments" },
  "permission-denials": { label: "permission denials", stage: "permissions" },
  "repeated-tool-calls": { label: "repeated identical tool calls", stage: "context discovery" },
  "unrecovered-terminal-failure": { label: "terminal failures that were never recovered", stage: "recovery" },
  "step-failure": { label: "failed model steps", stage: "model/provider" },
  "provider-retries": { label: "provider retries", stage: "model/provider" },
  "no-file-changes": { label: "no file changes on an editing task", stage: "editing" },
}

/** Comparison runs that have finished, in the shared execution shape. Improvement-evaluation runs are excluded. */
export function records(infos: readonly Comparison.Info[]): Improvement.ExecutionRecord[] {
  return infos
    .filter((info) => !info.definition.origin)
    .flatMap((info) =>
      info.runs
        .filter((run) => run.status === "completed" || run.status === "cancelled")
        .map((run) => record(info.definition, run)),
    )
}

function record(definition: Comparison.Definition, run: Comparison.Run): Improvement.ExecutionRecord {
  const metrics = Object.fromEntries(
    [...(run.report?.metrics ?? []), ...(run.observation?.metrics ?? [])].flatMap((entry) =>
      entry.metric.available && entry.metric.value !== undefined ? [[entry.key, entry.metric.value]] : [],
    ),
  )
  const model = run.observation?.models[0]
  const value = (key: string) => metrics[key]
  const features = [
    `harness:${run.harness}`,
    `category:${definition.task.category}`,
    ...(model ? [`model:${model.providerID}/${model.id}`] : []),
    ...((value("toolFailures") ?? 0) > 0 ? ["tool-failures"] : []),
    ...((value("invalidToolInput") ?? 0) > 0 ? ["invalid-tool-input"] : []),
    ...((value("permissionDenials") ?? 0) > 0 ? ["permission-denials"] : []),
    ...((value("repeatedToolCalls") ?? 0) >= 2 ? ["repeated-tool-calls"] : []),
    ...((value("terminalFailures") ?? 0) > (value("recoveries") ?? 0) ? ["unrecovered-terminal-failure"] : []),
    ...((value("stepFailures") ?? 0) > 0 || run.observation?.execution === "failed" ? ["step-failure"] : []),
    ...((value("retries") ?? 0) > 0 ? ["provider-retries"] : []),
    ...(EDITING_CATEGORIES.includes(definition.task.category) && value("filesChanged") === 0
      ? ["no-file-changes"]
      : []),
  ]
  return {
    version: 1,
    id: `${definition.id}:${run.harness}`,
    comparisonID: definition.id,
    harness: run.harness,
    taskKey: definition.taskKey,
    title: definition.task.title,
    category: definition.task.category,
    revision: definition.repository.revision,
    createdAt: definition.createdAt,
    sessionID: run.sessionID,
    model: model ? `${model.providerID}/${model.id}` : undefined,
    outcome: run.report?.outcome,
    failedCriteria: (run.report?.criteria ?? [])
      .filter((item) => item.status === "failed")
      .map((item) => item.description),
    metrics,
    features,
  }
}

const verified = (record: Improvement.ExecutionRecord) =>
  record.outcome === "verified-success" || record.outcome === "partial" || record.outcome === "failed"
const failed = (record: Improvement.ExecutionRecord) => record.outcome === "partial" || record.outcome === "failed"

type History = ReadonlyMap<string, Improvement.Finding["history"]>

/**
 * Finds recurring weaknesses in verified runs. Only runs the evaluator scored enter outcome tests: an unverified
 * run's completion is unknown, so it is neither a success nor a failure.
 */
export function analyze(
  all: readonly Improvement.ExecutionRecord[],
  history: History = new Map(),
  generatedAt = Date.now(),
): Improvement.Analysis {
  const scored = all.filter(verified)
  const insufficient: Improvement.Analysis["insufficient"][number][] = []
  const findings = [
    ...associations(scored, insufficient),
    ...runtimeGaps(scored, insufficient),
    ...recurring(scored),
    ...efficiency(scored, insufficient),
  ].map((finding) => ({ ...finding, history: history.get(finding.id) ?? [] }))
  return {
    version: 1,
    generatedAt,
    records: all.length,
    verified: scored.length,
    findings: findings.toSorted(
      (left, right) =>
        Number(left.needsMoreEvidence) - Number(right.needsMoreEvidence) ||
        rank(right.severity) - rank(left.severity) ||
        (left.adjustedPValue ?? left.pValue ?? 1) - (right.adjustedPValue ?? right.pValue ?? 1),
    ),
    insufficient,
    method: [
      `Feature association: one-sided Fisher exact tests per run feature, Benjamini–Hochberg corrected; supported at q ≤ ${ALPHA}, tentative at raw p ≤ ${ALPHA}.`,
      "Runtime gap: exact McNemar (sign) test on comparisons where both runtimes were verified.",
      `Recurring task failure: Wilson 95% lower bound of a task's failure rate ≥ ${RECURRING_LOWER_BOUND}.`,
      "Efficiency: sign test on paired durations where both runtimes verified success.",
      "Only evaluator-verified outcomes count; unverified and cancelled runs are excluded from outcome tests.",
    ].join(" "),
  }
}

type Draft = Omit<Improvement.Finding, "history">

function associations(
  scored: readonly Improvement.ExecutionRecord[],
  insufficient: Improvement.Analysis["insufficient"][number][],
): Draft[] {
  if (scored.length < MIN_VERIFIED) {
    insufficient.push({
      analysis: "Feature association",
      have: scored.length,
      need: MIN_VERIFIED,
      reason: "Too few evaluator-verified runs to compare runs with and without a feature",
    })
    return []
  }
  const candidates = [...new Set(scored.flatMap((record) => record.features))].filter(
    (feature) => !feature.startsWith("harness:"),
  )
  const tests = candidates.flatMap((feature) => {
    const with_ = scored.filter((record) => record.features.includes(feature))
    const without = scored.filter((record) => !record.features.includes(feature))
    if (with_.length < MIN_GROUP || without.length < MIN_GROUP) return []
    const a = with_.filter(failed).length
    const c = without.filter(failed).length
    const table = { a, b: with_.length - a, c, d: without.length - c }
    return (["greater", "less"] as const).map((side) => ({
      feature,
      side,
      with_,
      without,
      table,
      p: ImprovementStats.fisher(table.a, table.b, table.c, table.d, side),
    }))
  })
  const adjusted = ImprovementStats.benjaminiHochberg(tests.map((test) => test.p))
  return tests.flatMap((test, index): Draft[] => {
    if (test.p > ALPHA) return []
    const supported = adjusted[index] <= ALPHA
    const effect = ImprovementStats.differenceInterval(
      test.table.a,
      test.with_.length,
      test.table.c,
      test.without.length,
    )
    const meta = describe(test.feature)
    const failure = test.side === "greater"
    const affected = failure ? test.with_.filter(failed) : test.with_.filter((record) => !failed(record))
    return [
      {
        id: `${failure ? "failure" : "success"}-association:${test.feature}`,
        kind: failure ? "failure-association" : "success-association",
        title: failure ? `Runs with ${meta.label} fail more often` : `Runs with ${meta.label} succeed more often`,
        statement: `${test.table.a} of ${test.with_.length} runs with ${meta.label} failed verification, against ${test.table.c} of ${test.without.length} runs without.`,
        interpretation: failure
          ? `An association only: ${meta.label} may be a symptom of harder tasks rather than the cause of failure. An intervention at the ${meta.stage} stage is a hypothesis to test.`
          : `An association only: runs with ${meta.label} succeeded more often. The pattern may be reusable, or may reflect easier tasks.`,
        scope: {
          stage: meta.stage,
          feature: test.feature,
          category: test.feature.startsWith("category:") ? (test.feature.slice(9) as Comparison.Category) : undefined,
        },
        frequency: test.with_.length,
        sampleSize: test.with_.length + test.without.length,
        severity: severity(Math.abs(effect.estimate), affected.length),
        effect: { measure: "Difference in verified failure rate (with − without)", ...effect },
        comparisonGroup: `Verified runs without ${meta.label} (n = ${test.without.length})`,
        pValue: test.p,
        adjustedPValue: adjusted[index],
        support: supported ? "supported" : "tentative",
        needsMoreEvidence: !supported,
        evidence: evidence(affected),
        taskKeys: unique(affected.map((record) => record.taskKey)),
        method: "One-sided Fisher exact test, Benjamini–Hochberg corrected across every feature and direction tested.",
      },
    ]
  })
}

function runtimeGaps(
  scored: readonly Improvement.ExecutionRecord[],
  insufficient: Improvement.Analysis["insufficient"][number][],
): Draft[] {
  const pairs = paired(scored)
  const nativeOnly = pairs.filter(([native, stack]) => !failed(native) && failed(stack))
  const stackOnly = pairs.filter(([native, stack]) => failed(native) && !failed(stack))
  const discordant = nativeOnly.length + stackOnly.length
  if (discordant < MIN_DISCORDANT) {
    insufficient.push({
      analysis: "Runtime gap",
      have: discordant,
      need: MIN_DISCORDANT,
      reason: "Too few comparisons where exactly one runtime passed verification",
    })
    return []
  }
  const p = ImprovementStats.signTest(nativeOnly.length, discordant)
  if (p > ALPHA) return []
  const worse: Comparison.Harness = nativeOnly.length > stackOnly.length ? "stack-agent" : "opencode"
  const losing = worse === "stack-agent" ? nativeOnly : stackOnly
  const effect = ImprovementStats.differenceInterval(losing.length, discordant, discordant - losing.length, discordant)
  return [
    {
      id: `runtime-gap:${worse}`,
      kind: "runtime-gap" as const,
      title: `${worse === "opencode" ? "OpenCode Agent" : "Stack-Agent"} loses more paired comparisons`,
      statement: `Of ${discordant} comparisons where exactly one runtime passed, ${worse} failed in ${losing.length}.`,
      interpretation:
        "Both runtimes received the same task in the same revision, so the difference is between runtime configurations as run, including their models; it does not show which component causes it.",
      scope: { stage: "runtime", harness: worse },
      frequency: losing.length,
      sampleSize: pairs.length,
      severity: severity(losing.length / discordant - 0.5, losing.length),
      effect: { measure: "Share of discordant pairs lost minus share won", ...effect },
      comparisonGroup: `The other runtime on the same ${pairs.length} paired comparisons`,
      pValue: p,
      support: "supported" as const,
      needsMoreEvidence: false,
      evidence: evidence(losing.map((pair) => (worse === "opencode" ? pair[0] : pair[1]))),
      taskKeys: unique(losing.map((pair) => pair[0].taskKey)),
      method: "Exact McNemar test (two-sided sign test on discordant pairs).",
    },
  ]
}

function recurring(scored: readonly Improvement.ExecutionRecord[]): Draft[] {
  const groups = Map.groupBy(scored, (record) => record.taskKey)
  return [...groups].flatMap(([taskKey, items]): Draft[] => {
    const failures = items.filter(failed)
    if (items.length < MIN_GROUP) return []
    const interval = ImprovementStats.wilson(failures.length, items.length)
    if (interval.low < RECURRING_LOWER_BOUND) return []
    return [
      {
        id: `recurring-task-failure:${taskKey}`,
        kind: "recurring-task-failure",
        title: `“${items[0].title}” keeps failing verification`,
        statement: `${failures.length} of ${items.length} verified runs of this task failed.`,
        interpretation:
          "Descriptive only: the task may be harder than others, under-specified, or exercise a weak agent capability.",
        scope: { stage: "task", taskKey, category: items[0].category },
        frequency: failures.length,
        sampleSize: items.length,
        severity: severity(failures.length / items.length, failures.length),
        effect: { measure: "Verified failure rate", estimate: failures.length / items.length, ...interval },
        comparisonGroup: "No comparison group; rate against the 95% Wilson lower bound threshold",
        support: "supported",
        needsMoreEvidence: items.length < MIN_VERIFIED,
        evidence: evidence(failures),
        taskKeys: [taskKey],
        method: `Wilson 95% interval of the failure rate; reported when its lower bound is ≥ ${RECURRING_LOWER_BOUND}.`,
      },
    ]
  })
}

function efficiency(
  scored: readonly Improvement.ExecutionRecord[],
  insufficient: Improvement.Analysis["insufficient"][number][],
): Draft[] {
  const pairs = paired(scored).filter(
    ([native, stack]) =>
      native.outcome === "verified-success" &&
      stack.outcome === "verified-success" &&
      native.metrics.duration !== undefined &&
      stack.metrics.duration !== undefined,
  )
  if (pairs.length < MIN_PAIRS) {
    insufficient.push({
      analysis: "Efficiency for equal verified outcomes",
      have: pairs.length,
      need: MIN_PAIRS,
      reason: "Too few comparisons where both runtimes verified success with a measured duration",
    })
    return []
  }
  const nativeSlower = pairs.filter(([native, stack]) => native.metrics.duration > stack.metrics.duration)
  const p = ImprovementStats.signTest(nativeSlower.length, pairs.length)
  if (p > ALPHA) return []
  const slower: Comparison.Harness = nativeSlower.length * 2 > pairs.length ? "opencode" : "stack-agent"
  const ratios = pairs.map(([native, stack]) =>
    slower === "opencode"
      ? native.metrics.duration / Math.max(1, stack.metrics.duration)
      : stack.metrics.duration / Math.max(1, native.metrics.duration),
  )
  const ratio = ImprovementStats.median(ratios) ?? 1
  return [
    {
      id: `efficiency-gap:${slower}`,
      kind: "efficiency-gap" as const,
      title: `${slower === "opencode" ? "OpenCode Agent" : "Stack-Agent"} takes longer for the same verified result`,
      statement: `In ${pairs.length} comparisons where both runtimes verified success, ${slower} was slower in ${slower === "opencode" ? nativeSlower.length : pairs.length - nativeSlower.length}; median duration ratio ${ratio.toFixed(2)}×.`,
      interpretation: "Speed matters only among equally verified outcomes; this says nothing about correctness.",
      scope: { stage: "efficiency", harness: slower },
      frequency: pairs.length,
      sampleSize: pairs.length,
      severity: ratio >= 2 ? "medium" : "low",
      effect: { measure: "Median duration ratio (slower ÷ faster)", estimate: ratio },
      comparisonGroup: "The other runtime on the same paired comparisons",
      pValue: p,
      support: "supported" as const,
      needsMoreEvidence: false,
      evidence: evidence(pairs.map((pair) => (slower === "opencode" ? pair[0] : pair[1]))),
      taskKeys: unique(pairs.map((pair) => pair[0].taskKey)),
      method: "Two-sided sign test on paired durations.",
    },
  ]
}

function paired(scored: readonly Improvement.ExecutionRecord[]) {
  return [...Map.groupBy(scored, (record) => record.comparisonID).values()].flatMap((items) => {
    const native = items.find((record) => record.harness === "opencode")
    const stack = items.find((record) => record.harness === "stack-agent")
    return native && stack ? [[native, stack] as const] : []
  })
}

function describe(feature: string) {
  if (FEATURES[feature]) return FEATURES[feature]
  if (feature.startsWith("model:")) return { label: `model ${feature.slice(6)}`, stage: "model configuration" }
  if (feature.startsWith("category:")) return { label: `${feature.slice(9)} tasks`, stage: "task type" }
  return { label: feature, stage: "other" }
}

function evidence(items: readonly Improvement.ExecutionRecord[]): Improvement.FindingEvidence[] {
  return items.slice(0, EVIDENCE_LIMIT).map((record) => ({
    recordID: record.id,
    comparisonID: record.comparisonID,
    harness: record.harness,
    sessionID: record.sessionID,
    taskKey: record.taskKey,
    title: record.title,
    outcome: record.outcome,
    note: record.failedCriteria.length
      ? `Failed: ${record.failedCriteria.join("; ")}`
      : `Outcome: ${record.outcome ?? "not evaluated"}`,
  }))
}

function severity(effect: number, affected: number): Improvement.Finding["severity"] {
  if (effect >= 0.4 && affected >= 5) return "high"
  if (effect >= 0.2) return "medium"
  return "low"
}

const rank = (value: Improvement.Finding["severity"]) => (value === "high" ? 2 : value === "medium" ? 1 : 0)
const unique = (values: readonly string[]) => [...new Set(values)]
