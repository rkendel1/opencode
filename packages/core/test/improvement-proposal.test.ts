import { describe, expect, test } from "bun:test"
import type { Comparison } from "@opencode/schema/comparison"
import type { Improvement } from "@opencode/schema/improvement"
import { ImprovementEvaluate } from "@opencode/core/improvement/evaluate"
import { ImprovementProposal } from "@opencode/core/improvement/proposal"

const finding = {
  id: "failure-association:unrecovered-terminal-failure",
  taskKeys: ["task-a"],
} as unknown as Improvement.Finding

const proposal = {
  version: 1,
  findingID: finding.id,
  title: "Retry failed checks",
  cause: "Runs stop after the first failing command",
  hypothesis: "If the agent is told to rerun failed checks, verified success rises",
  mechanism: "Recovery after a failure",
  layer: "prompt-context",
  alternatives: ["The tasks are harder"],
  sourceLocations: [{ path: "src/agent.ts", line: 3, reason: "Builds the prompt" }],
  changes: [{ path: "AGENTS.md", description: "Add a recovery rule" }],
  acceptanceCriteria: [{ id: "rule", description: "Rule present", command: "grep -q rerun AGENTS.md" }],
  evaluation: { taskKeys: ["task-a"], trials: 3, targetRuntimes: ["opencode"] },
  risks: ["Longer runs"],
  rollback: ["Verified success does not rise"],
  requiredApprovals: [],
}

const parse = (value: unknown, opened = ["src/agent.ts"], existing = ["src/agent.ts"]) =>
  ImprovementProposal.parse({
    text: `Investigation done.\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``,
    finding,
    opened: new Set(opened),
    exists: async (file) => existing.includes(file),
  })

describe("ImprovementProposal.parse", () => {
  test("accepts a grounded proposal", async () => {
    const result = await parse(proposal)
    expect(result.errors).toEqual([])
    expect(result.proposal?.title).toBe("Retry failed checks")
  })

  test("rejects fields outside the contract, such as a permission request", async () => {
    const result = await parse({ ...proposal, permissions: [{ action: "*", resource: "*", effect: "allow" }] })
    expect(result.proposal).toBeUndefined()
    expect(result.errors[0]).toContain("does not match the schema")
  })

  test("rejects proposals that are not traceable to the finding and the repository", async () => {
    const result = await parse(
      {
        ...proposal,
        findingID: "other",
        evaluation: { ...proposal.evaluation, taskKeys: ["task-z"] },
        changes: [{ path: "../outside.txt", description: "" }],
        sourceLocations: [{ path: "src/missing.ts", reason: "" }],
      },
      [],
      [],
    )
    expect(result.errors).toEqual([
      `The proposal addresses other, not ${finding.id}`,
      "Evaluation task task-z is not one of the finding's tasks",
      "../outside.txt is outside the repository",
      "Cited source src/missing.ts does not exist at the base revision",
      "None of the cited source locations was opened during the investigation",
    ])
  })

  test("rejects an answer without JSON or with an invalid trial count", async () => {
    expect(
      (
        await ImprovementProposal.parse({
          text: "I think it is fine.",
          finding,
          opened: new Set(),
          exists: async () => true,
        })
      ).errors,
    ).toEqual(["The answer contains no JSON object"])
    expect((await parse({ ...proposal, evaluation: { ...proposal.evaluation, trials: 50 } })).proposal).toBeUndefined()
  })
})

describe("ImprovementProposal.permissionChanges", () => {
  test("flags patches that change permission configuration", () => {
    const diff = [
      "diff --git a/opencode.json b/opencode.json",
      "+++ b/opencode.json",
      '+  "permission": { "*": "allow" }',
      "diff --git a/AGENTS.md b/AGENTS.md",
      "+Mention permission prompts in prose",
    ].join("\n")
    expect(ImprovementProposal.permissionChanges(diff)).toEqual(["opencode.json"])
  })
})

describe("ImprovementEvaluate.compare", () => {
  const plan = { alpha: 0.1, targetRuntimes: ["opencode"] } as unknown as Improvement.Plan
  const run = (outcome: Comparison.Outcome, criteria: Comparison.CriterionStatus[] = []): Comparison.Run => ({
    harness: "opencode",
    status: "completed",
    environment: [],
    baseline: [],
    cancelRequested: false,
    createdAt: 0,
    report: {
      outcome,
      reason: "",
      evaluatedAt: 0,
      changes: [],
      metrics: [],
      criteria: criteria.map((status, index) => ({
        id: `c${index}`,
        description: `criterion ${index}`,
        status,
        regression: false,
        evidence: [],
      })),
    },
  })
  const evaluate = (baseline: Comparison.Run[], candidate: Comparison.Run[]) =>
    ImprovementEvaluate.compare(
      [
        { variant: "baseline", runs: baseline },
        { variant: "candidate", runs: candidate },
      ],
      plan,
    )

  test("calls a clear rise in verified success an improvement", () => {
    const result = evaluate(
      [run("failed"), run("failed"), run("failed")],
      [run("verified-success"), run("verified-success"), run("verified-success")],
    )
    expect(result.verdict).toBe("improved")
    expect(result.results[0].pImproved).toBeCloseTo(0.05, 10)
  })

  test("keeps a small or noisy difference inconclusive", () => {
    expect(evaluate([run("failed")], [run("verified-success")]).verdict).toBe("inconclusive")
    expect(evaluate([run("unverified")], [run("unverified")]).verdict).toBe("inconclusive")
  })

  test("detects a regression in the success rate or in a criterion that used to pass", () => {
    expect(
      evaluate(
        [run("verified-success"), run("verified-success"), run("verified-success")],
        [run("failed"), run("failed"), run("failed")],
      ).verdict,
    ).toBe("regressed")
    const criterion = evaluate([run("partial", ["passed", "failed"])], [run("partial", ["failed", "passed"])])
    expect(criterion.verdict).toBe("regressed")
    expect(criterion.results[0].criterionRegressions).toEqual(["criterion 0"])
  })
})
