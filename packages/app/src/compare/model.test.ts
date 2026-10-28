import { describe, expect, test } from "bun:test"
import type { ComparisonInfo, ComparisonMetric } from "@opencode/client/promise"
import { formatMetric, metricRows } from "./model"

const metric = (value: number | undefined, unit?: string): ComparisonMetric => ({
  label: "Tool calls",
  value,
  unit,
  available: value !== undefined,
  kind: "observed",
  source: "assistant tool parts",
  method: "Count",
})

describe("compare model", () => {
  test("renders unavailable metrics as unknown, never as zero", () => {
    expect(formatMetric(metric(undefined))).toBeUndefined()
    expect(formatMetric(undefined)).toBeUndefined()
    expect(formatMetric(metric(0))).toBe("0")
    expect(formatMetric(metric(83_000, "ms"))).toBe("1m 23s")
  })

  test("aligns metrics by key when one run lacks a metric", () => {
    const run = (harness: "opencode" | "stack-agent", metrics: { key: string; metric: ComparisonMetric }[]) => ({
      harness,
      status: "running" as const,
      environment: [],
      baseline: [],
      cancelRequested: false,
      createdAt: 0,
      observation: { models: [], metrics, activity: [] },
    })

    // SAFETY: metricRows reads only `runs`; the rest of the record is irrelevant to alignment.
    const info = {
      runs: [
        run("opencode", [{ key: "toolCalls", metric: metric(3) }]),
        run("stack-agent", [{ key: "duration", metric: metric(10, "ms") }]),
      ],
    } as unknown as ComparisonInfo

    expect(metricRows(info).map((row) => [row.key, row.values.map((value) => value?.value)])).toEqual([
      ["toolCalls", [3, undefined]],
      ["duration", [undefined, 10]],
    ])
  })
})
