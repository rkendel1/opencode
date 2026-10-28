import type {
  ComparisonHarness,
  ComparisonInfo,
  ComparisonMetric,
  ComparisonRun,
  ComparisonRunStatus,
} from "@opencode/client/promise"

export const HARNESSES: readonly ComparisonHarness[] = ["opencode", "stack-agent"]

const SETTLED: readonly ComparisonRunStatus[] = ["completed", "cancelled", "failed-to-start"]

export const settled = (run: ComparisonRun) => SETTLED.includes(run.status)

/** A comparison is live until both runs have a final status; only then does polling stop. */
export const live = (info: ComparisonInfo | undefined) => !info || info.runs.some((run) => !settled(run))

export const runFor = (info: ComparisonInfo, harness: ComparisonHarness) =>
  info.runs.find((run) => run.harness === harness)

/** A run's metrics: the final report when evaluated, otherwise the live observation. */
export function runMetrics(run: ComparisonRun | undefined) {
  if (!run) return []

  return run.report?.metrics ?? run.observation?.metrics ?? []
}

/** One row per metric key in first-seen order, so both runs line up even when one lacks a metric. */
export function metricRows(info: ComparisonInfo) {
  const columns = HARNESSES.map(
    (harness) => new Map(runMetrics(runFor(info, harness)).map((item) => [item.key, item.metric])),
  )

  const keys = [...new Set(columns.flatMap((column) => [...column.keys()]))]

  return keys.map((key) => ({
    key,
    label: columns.map((column) => column.get(key)?.label).find(Boolean) ?? key,
    values: columns.map((column) => column.get(key)),
  }))
}

/** Unknown values stay visibly unknown; they are never rendered as zero. */
export function formatMetric(metric: ComparisonMetric | undefined) {
  if (!metric?.available || metric.value === undefined) return undefined

  if (metric.unit === "ms") return formatDuration(metric.value)

  if (metric.unit === "USD") return `$${metric.value.toFixed(4)}`

  return metric.value.toLocaleString()
}

export function formatDuration(ms: number) {
  const seconds = Math.round(ms / 1000)

  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)

  if (minutes < 60) return `${minutes}m ${seconds % 60}s`

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
