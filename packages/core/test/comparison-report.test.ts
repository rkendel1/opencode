import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import type { Comparison } from "@opencode/schema/comparison"
import { SessionMessage } from "@opencode/schema/session-message"
import { ComparisonObserve } from "@opencode/core/comparison/observe"
import { ComparisonReport } from "@opencode/core/comparison/report"

const criterion = (status: Comparison.CriterionStatus, regression = false): Comparison.CriterionResult => ({
  id: status,
  description: status,
  status,
  regression,
  evidence: [],
})

describe("ComparisonReport.classify", () => {
  test("never credits success without verification evidence", () => {
    expect(ComparisonReport.classify({ cancelled: false, criteria: [] }).outcome).toBe("unverified")
    expect(ComparisonReport.classify({ cancelled: false, criteria: [criterion("unverified")] }).outcome).toBe(
      "unverified",
    )
    expect(
      ComparisonReport.classify({ cancelled: false, criteria: [criterion("passed"), criterion("unverified")] }).outcome,
    ).toBe("unverified")
  })

  test("separates success, partial, failure, regression and cancellation", () => {
    const classify = (criteria: Comparison.CriterionResult[], cancelled = false) =>
      ComparisonReport.classify({ cancelled, criteria }).outcome
    expect(classify([criterion("passed"), criterion("passed")])).toBe("verified-success")
    expect(classify([criterion("passed"), criterion("failed")])).toBe("partial")
    expect(classify([criterion("failed"), criterion("failed")])).toBe("failed")
    expect(classify([criterion("passed"), criterion("failed", true)])).toBe("failed")
    expect(classify([criterion("passed")], true)).toBe("cancelled")
  })
})

describe("ComparisonReport.changes", () => {
  test("merges numstat with status, keeping binary line counts unknown", () => {
    const numstat = ["3\t1\tsrc/a.ts", "-\t-\timage.png", "2\t0\tcommitted.ts", ""].join("\0")
    const status = [" M src/a.ts", "A  image.png", "?? new.txt", ""].join("\0")
    expect(ComparisonReport.changes(numstat, status)).toEqual([
      { path: "committed.ts", status: "modified", additions: 2, deletions: 0 },
      { path: "image.png", status: "added", additions: undefined, deletions: undefined },
      { path: "new.txt", status: "untracked", additions: undefined, deletions: undefined },
      { path: "src/a.ts", status: "modified", additions: 3, deletions: 1 },
    ])
  })

  test("reads renames from both formats", () => {
    const numstat = ["1\t1\t", "old.ts", "new.ts", ""].join("\0")
    const status = ["R  new.ts", "old.ts", ""].join("\0")
    expect(ComparisonReport.changes(numstat, status)).toEqual([
      { path: "new.ts", status: "renamed", additions: 1, deletions: 1 },
    ])
  })
})

describe("ComparisonObserve.observe", () => {
  const time = { created: DateTime.makeUnsafe(1_000) }
  const tool = (
    id: string,
    name: string,
    state: SessionMessage.AssistantTool["state"],
  ): SessionMessage.AssistantTool => ({
    type: "tool",
    id,
    name,
    state,
    time,
  })
  const assistant: SessionMessage.Assistant = {
    id: SessionMessage.ID.make("msg_1"),
    type: "assistant",
    agent: "build" as SessionMessage.Assistant["agent"],
    model: { id: "m", providerID: "p" } as SessionMessage.Assistant["model"],
    content: [
      tool("t1", "shell", {
        status: "completed",
        input: { command: "bun test" },
        content: [{ type: "text", text: "x" }],
        metadata: { exit: 1 },
      }),
      tool("t2", "shell", {
        status: "completed",
        input: { command: "bun test" },
        content: [{ type: "text", text: "x" }],
        metadata: { exit: 0 },
      }),
      tool("t3", "edit", { status: "error", input: {}, error: { type: "permission.rejected", message: "no" } }),
      tool("t4", "write", { status: "error", input: {}, error: { type: "tool.input-json", message: "bad" } }),
      { type: "text", text: "All done, tests pass." },
    ],
    snapshot: {},
    time,
  }

  test("counts native tool, terminal and recovery activity with record references", () => {
    const observation = ComparisonObserve.observe("opencode", [assistant])
    const value = (key: string) => observation.metrics.find((item) => item.key === key)?.metric
    expect(value("toolCalls")?.value).toBe(4)
    expect(value("terminalCommands")?.value).toBe(2)
    expect(value("terminalFailures")?.value).toBe(1)
    expect(value("recoveries")).toMatchObject({ value: 1, kind: "inferred" })
    expect(value("repeatedToolCalls")?.value).toBe(1)
    expect(value("permissionDenials")?.value).toBe(1)
    expect(value("invalidToolInput")?.value).toBe(1)
    expect(value("inputTokens")).toMatchObject({ available: false })
    expect(value("inputTokens")?.value).toBeUndefined()
    expect(observation.claim).toBe("All done, tests pass.")
    expect(observation.activity.find((item) => item.toolCallID === "t1")).toMatchObject({
      messageID: "msg_1",
      kind: "terminal-failed",
      label: "bun test",
    })
  })

  test("reports stack-agent tool metrics as unavailable rather than zero", () => {
    const observation = ComparisonObserve.observe("stack-agent", [{ ...assistant, content: [] }])
    for (const key of ["toolCalls", "terminalCommands", "modelRequests", "permissionDenials"]) {
      const metric = observation.metrics.find((item) => item.key === key)?.metric
      expect(metric?.available).toBe(false)
      expect(metric?.value).toBeUndefined()
    }
  })
})
