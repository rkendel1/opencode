import { describe, expect, test } from "bun:test"
import type { Comparison } from "@opencode/schema/comparison"
import type { Improvement } from "@opencode/schema/improvement"
import { ImprovementAnalysis } from "@opencode/core/improvement/analysis"
import { ImprovementStats } from "@opencode/core/improvement/stats"

let sequence = 0
const make = (input: {
  harness?: Comparison.Harness
  outcome?: Comparison.Outcome
  features?: string[]
  taskKey?: string
  comparisonID?: string
  duration?: number
}): Improvement.ExecutionRecord => {
  const harness = input.harness ?? "opencode"
  const comparisonID = (input.comparisonID ?? `cmp_${++sequence}`) as Comparison.ID
  return {
    version: 1,
    id: `${comparisonID}:${harness}`,
    comparisonID,
    harness,
    taskKey: input.taskKey ?? "task-a",
    title: input.taskKey ?? "task-a",
    category: "bug-fix",
    revision: "abc",
    createdAt: 0,
    outcome: input.outcome,
    failedCriteria: input.outcome === "failed" ? ["tests pass"] : [],
    metrics: input.duration === undefined ? {} : { duration: input.duration },
    features: [`harness:${harness}`, "category:bug-fix", ...(input.features ?? [])],
  }
}
const times = (count: number, factory: () => Improvement.ExecutionRecord) => Array.from({ length: count }, factory)

describe("ImprovementStats", () => {
  test("matches reference values for exact tests and intervals", () => {
    // Lady tasting tea: 3 of 4 correct each way, one-sided p = 17/70.
    expect(ImprovementStats.fisher(3, 1, 1, 3, "greater")).toBeCloseTo(17 / 70, 10)
    expect(ImprovementStats.signTest(0, 6)).toBeCloseTo(2 / 64, 10)
    const interval = ImprovementStats.wilson(0, 10)
    expect(interval.low).toBe(0)
    expect(interval.high).toBeCloseTo(0.2775, 3)
    expect(ImprovementStats.benjaminiHochberg([0.01, 0.04, 0.03])).toEqual([0.03, 0.04, 0.04])
  })
})

describe("ImprovementAnalysis.analyze", () => {
  test("identifies a planted weakness and traces it to the runs that show it", () => {
    const weak = [
      ...times(7, () => make({ outcome: "failed", features: ["unrecovered-terminal-failure"] })),
      make({ outcome: "verified-success", features: ["unrecovered-terminal-failure"] }),
    ]
    const rest = [
      ...times(10, () => make({ outcome: "verified-success" })),
      ...times(2, () => make({ outcome: "failed" })),
    ]
    // Unverified runs carry no outcome and must not count as failures.
    const unverified = times(5, () => make({ outcome: "unverified", features: ["unrecovered-terminal-failure"] }))
    const analysis = ImprovementAnalysis.analyze([...weak, ...rest, ...unverified])

    expect(analysis.records).toBe(25)
    expect(analysis.verified).toBe(20)
    const finding = analysis.findings.find((item) => item.id === "failure-association:unrecovered-terminal-failure")
    expect(finding).toMatchObject({
      support: "supported",
      needsMoreEvidence: false,
      frequency: 8,
      sampleSize: 20,
      scope: { stage: "recovery" },
    })
    expect(finding?.statement).toBe(
      "7 of 8 runs with terminal failures that were never recovered failed verification, against 2 of 12 runs without.",
    )
    expect(finding?.adjustedPValue).toBeLessThanOrEqual(ImprovementAnalysis.ALPHA)
    expect(finding?.evidence.map((item) => item.recordID)).toEqual(weak.slice(0, 7).map((record) => record.id))
    expect(finding?.interpretation).toContain("association only")
    expect(finding?.effect.estimate).toBeCloseTo(7 / 8 - 2 / 12, 10)
  })

  test("reports insufficient data instead of a diagnosis", () => {
    const analysis = ImprovementAnalysis.analyze([
      ...times(3, () => make({ outcome: "failed", features: ["tool-failures"] })),
      make({ outcome: "verified-success" }),
    ])
    expect(analysis.findings).toEqual([])
    expect(analysis.insufficient.map((item) => [item.analysis, item.have, item.need])).toEqual([
      ["Feature association", 4, 8],
      ["Runtime gap", 0, 5],
      ["Efficiency for equal verified outcomes", 0, 5],
    ])
  })

  test("finds nothing when a feature is unrelated to the outcome", () => {
    const analysis = ImprovementAnalysis.analyze([
      ...times(5, () => make({ outcome: "failed", features: ["tool-failures"] })),
      ...times(5, () => make({ outcome: "verified-success", features: ["tool-failures"] })),
      ...times(5, () => make({ outcome: "failed" })),
      ...times(5, () => make({ outcome: "verified-success" })),
    ])
    expect(analysis.findings.filter((item) => item.kind.endsWith("association"))).toEqual([])
  })

  test("compares runtimes on paired comparisons and keeps the claim associational", () => {
    const pairs = Array.from({ length: 6 }, (_, index) => [
      make({
        comparisonID: `cmp_pair${index}`,
        harness: "opencode",
        outcome: "verified-success",
        taskKey: `t${index}`,
      }),
      make({ comparisonID: `cmp_pair${index}`, harness: "stack-agent", outcome: "failed", taskKey: `t${index}` }),
    ]).flat()
    const finding = ImprovementAnalysis.analyze(pairs).findings.find((item) => item.kind === "runtime-gap")
    expect(finding).toMatchObject({ id: "runtime-gap:stack-agent", scope: { harness: "stack-agent" }, frequency: 6 })
    expect(finding?.pValue).toBeCloseTo(2 / 64, 10)
    expect(finding?.interpretation).toContain("does not show which component causes it")
  })

  test("attaches earlier intervention outcomes to the finding they addressed", () => {
    const records = [
      ...times(7, () => make({ outcome: "failed", features: ["unrecovered-terminal-failure"] })),
      ...times(10, () => make({ outcome: "verified-success" })),
    ]
    const id = "failure-association:unrecovered-terminal-failure"
    const history = new Map([
      [id, [{ improvementID: "imp_1", verdict: "improved" as const, decision: "accept" as const, validated: true }]],
    ])
    expect(ImprovementAnalysis.analyze(records, history).findings.find((item) => item.id === id)?.history).toEqual(
      history.get(id),
    )
  })
})

describe("ImprovementAnalysis.records", () => {
  test("derives features from comparison reports and skips improvement evaluation runs", () => {
    const metric = (value: number) => ({
      label: "",
      value,
      available: true,
      kind: "observed" as const,
      source: "",
      method: "",
    })
    const run = (harness: Comparison.Harness): Comparison.Run => ({
      harness,
      status: "completed",
      sessionID: "ses_1" as Comparison.Run["sessionID"],
      environment: [],
      baseline: [],
      cancelRequested: false,
      createdAt: 0,
      observation: { models: [{ id: "m", providerID: "p" } as never], metrics: [], activity: [] },
      report: {
        outcome: "failed",
        reason: "",
        evaluatedAt: 0,
        changes: [],
        criteria: [{ id: "c", description: "tests pass", status: "failed", regression: false, evidence: [] }],
        metrics: [
          { key: "terminalFailures", metric: metric(2) },
          { key: "recoveries", metric: metric(1) },
          { key: "filesChanged", metric: metric(0) },
          { key: "toolCalls", metric: { ...metric(0), available: false, value: undefined } },
        ],
      },
    })
    const definition = (id: string, origin?: Comparison.Origin) =>
      ({
        id,
        createdAt: 0,
        task: { title: "Fix", prompt: "Fix", category: "bug-fix", criteria: [] },
        taskKey: "key",
        repository: { projectID: "p", directory: "/r", revision: "abc", dirty: false },
        harnesses: ["opencode"],
        origin,
      }) as unknown as Comparison.Definition
    const [record, ...rest] = ImprovementAnalysis.records([
      { definition: definition("cmp_a"), runs: [run("opencode")], qualifications: [], trials: [] },
      {
        definition: definition("cmp_b", { improvementID: "imp_1", variant: "candidate" }),
        runs: [run("opencode")],
        qualifications: [],
        trials: [],
      },
    ])
    expect(rest).toEqual([])
    expect(record.features).toEqual([
      "harness:opencode",
      "category:bug-fix",
      "model:p/m",
      "unrecovered-terminal-failure",
      "no-file-changes",
    ])
    expect(record.metrics).toEqual({ terminalFailures: 2, recoveries: 1, filesChanged: 0 })
    expect(record.failedCriteria).toEqual(["tests pass"])
  })
})
