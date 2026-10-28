import { describe, expect, test } from "bun:test"
import type { ImprovementInfo } from "@opencode/client/promise"
import { lifecycle, live, validated } from "./model"

const info = (state: Partial<ImprovementInfo["state"]>): ImprovementInfo =>
  // SAFETY: lifecycle and validated read only `state`.
  ({ state: { stage: "investigating", investigations: [], ...state } }) as unknown as ImprovementInfo

const statuses = (value: ImprovementInfo) => lifecycle(value).map((step) => `${step.key}:${step.status}`)

describe("improvement lifecycle", () => {
  test("keeps implemented and verified apart, and a failed implementation never reads as verified", () => {
    expect(statuses(info({}))).toEqual([
      "observed:done",
      "inferred:done",
      "proposed:active",
      "implemented:pending",
      "verified:pending",
    ])

    const failed = info({
      stage: "evaluated",
      investigations: [{ attempt: 0, status: "valid", startedAt: 0, errors: [] }],
      evaluation: { status: "completed", results: [], verdict: "failed-to-implement" },
    })

    expect(statuses(failed).slice(2)).toEqual(["proposed:done", "implemented:failed", "verified:pending"])
  })

  test("keeps polling while a Stack-Agent change is being applied after evaluation", () => {
    expect(live(info({ stage: "evaluated" }))).toBe(false)
    expect(
      live(
        info({
          stage: "evaluated",
          application: { status: "applying" } as ImprovementInfo["state"]["application"],
        }),
      ),
    ).toBe(true)
  })

  test("validates only an improved verdict that a reviewer accepted", () => {
    const evaluated = {
      stage: "decided" as const,
      evaluation: { status: "completed" as const, results: [], verdict: "improved" as const },
    }

    expect(validated(info(evaluated))).toBe(false)
    expect(validated(info({ ...evaluated, decision: { decision: "accept", at: 0 } }))).toBe(true)
    expect(
      validated(
        info({
          ...evaluated,
          evaluation: { ...evaluated.evaluation, verdict: "inconclusive" },
          decision: { decision: "accept", at: 0 },
        }),
      ),
    ).toBe(false)
  })
})
