// The whole improvement loop on a deterministic fixture: observe → diagnose → investigate → propose → implement →
// evaluate → decide. The scripted model writes the right answer only when the workspace's AGENTS.md tells it to, so
// an AGENTS.md intervention has a real, measurable effect that the pipeline must detect on its own.
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { $ } from "bun"
import { Effect, Layer } from "effect"
import { LanguageModel } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols/openai-chat"
import { TestLLM } from "@opencode/ai/testing"
import { Comparison } from "@opencode/core/comparison"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Improvement } from "@opencode/core/improvement"
import { KV } from "@opencode/core/kv"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { Worktree } from "@opencode/core/worktree"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { tempGlobalLayer } from "./fixture/global"
import { initGit } from "./fixture/git"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const RULE = "Always write the answer as 42."
const TASK = {
  title: "Write the answer",
  prompt: "Create answer.txt containing the answer.",
  category: "implementation",
  criteria: [{ id: "value", description: "answer.txt is 42", command: "grep -qx 42 answer.txt" }],
} as const

const llmLayer = TestLLM.testLayer()
const it = testEffect(
  Layer.merge(
    llmLayer,
    AppNodeBuilder.build(
      LayerNode.group([
        Improvement.node,
        Comparison.node,
        Session.node,
        LocationServiceMap.node,
        KV.node,
        Worktree.node,
        Project.node,
        AppProcess.node,
      ]),
      [
        Global.node.replace(tempGlobalLayer),
        offlineModels,
        Watcher.node.replace(Watcher.configured({ enabled: false })),
        LayerNodePlatform.llmClient.replace(llmLayer),
        SessionRunnerModel.node.replace(
          Layer.succeed(SessionRunnerModel.Service, {
            resolve: () =>
              Effect.succeed(
                SessionRunnerModel.resolved(
                  LanguageModel.make({ id: "improve", provider: "test", route: OpenAIChat.route }),
                  {
                    capabilities: { tools: true, input: ["text"], output: ["text"] },
                    cost: [],
                    limit: { context: 200_000, output: 32_000 },
                  },
                ),
              ),
          }),
        ),
      ],
    ),
  ),
)

type Script = {
  proposal: (finding: { id: string; taskKey: string }) => unknown
  implementation: string | undefined
}

/** One responder for every Session the pipeline starts; it tells them apart by their prompt. */
const script = (finding: { id: string; taskKey: string }, behaviour: Script) =>
  TestLLM.Test.use((llm) =>
    llm.serve((request) => {
      const text = JSON.stringify(request)
      const tools = request.messages.filter((message) => message.role === "tool").length
      if (text.includes("You are investigating a weakness")) {
        if (tools === 0) return TestLLM.tool("read_1", "read", { path: "README.md" })
        return TestLLM.text("```json\n" + JSON.stringify(behaviour.proposal(finding)) + "\n```", "proposal")
      }
      if (text.includes("Implement this approved change")) {
        if (tools === 0 && behaviour.implementation !== undefined)
          return TestLLM.tool("write_1", "write", { path: "AGENTS.md", content: behaviour.implementation })
        return TestLLM.text("Done.", "implemented")
      }
      if (tools === 0)
        return TestLLM.tool("write_1", "write", { path: "answer.txt", content: text.includes(RULE) ? "42\n" : "41\n" })
      return TestLLM.text("I wrote answer.txt.", "done")
    }),
  )

const proposal = (finding: { id: string; taskKey: string }, trials = 3) => ({
  version: 1,
  findingID: finding.id,
  title: "State the expected answer in AGENTS.md",
  cause: "Every failing run wrote 41; nothing in the repository states the expected value.",
  hypothesis: "If AGENTS.md states the expected answer, verified success on this task rises.",
  mechanism: "AGENTS.md is loaded into every Session's instructions in this repository.",
  layer: "prompt-context",
  alternatives: ["The task prompt is ambiguous", "The model ignores repository instructions"],
  sourceLocations: [
    { path: "README.md", line: 1, reason: "The only project documentation; it does not state the answer" },
  ],
  changes: [{ path: "AGENTS.md", description: "Add the expected answer as an instruction" }],
  acceptanceCriteria: [{ id: "rule", description: "AGENTS.md states the answer", command: "grep -q 42 AGENTS.md" }],
  evaluation: { taskKeys: [finding.taskKey], trials, targetRuntimes: ["opencode"] },
  risks: ["The instruction could leak into unrelated tasks"],
  rollback: ["Verified success on the task does not rise"],
  requiredApprovals: ["Code owner review of AGENTS.md"],
})

const fixture = Effect.gen(function* () {
  const tmp = yield* tmpdirScoped()
  const repo = path.join(tmp.path, "repo")
  const bin = path.join(tmp.path, "stack-agent")
  yield* Effect.promise(async () => {
    await fs.mkdir(repo)
    await initGit(repo)
    await Bun.write(path.join(repo, "README.md"), "Answer fixture\n")
    await $`git add README.md && git commit -m init`.cwd(repo).quiet()
    // The Stack-Agent stub follows the same AGENTS.md rule, so both runtimes respond to the intervention.
    await Bun.write(
      bin,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo stub; exit 0; fi\nif grep -q 42 AGENTS.md 2>/dev/null; then echo 42 > answer.txt; else echo 41 > answer.txt; fi\necho done\n`,
    )
    await fs.chmod(bin, 0o755)
  })
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env.STACK_AGENT_BIN
      process.env.STACK_AGENT_BIN = bin
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env.STACK_AGENT_BIN
        else process.env.STACK_AGENT_BIN = previous
      }),
  )
  return AbsolutePath.make(repo)
})

const until = <A, R>(read: Effect.Effect<A, unknown, R>, done: (value: A) => boolean, seconds = 120) =>
  Effect.gen(function* () {
    const deadline = Date.now() + seconds * 1000
    while (Date.now() < deadline) {
      const value = yield* read
      if (done(value)) return value
      yield* Effect.promise(() => Bun.sleep(100))
    }
    return yield* Effect.die(new Error(`timed out: ${JSON.stringify(yield* read).slice(0, 2000)}`))
  })

/** Four failing comparisons give 8 verified failures of one task: a supported recurring-failure finding. */
const observe = (repo: AbsolutePath) =>
  Effect.gen(function* () {
    const comparisons = yield* Comparison.Service
    const improvements = yield* Improvement.Service
    const created = yield* Effect.forEach(Array.from({ length: 4 }), () =>
      comparisons.create({ directory: repo, task: TASK }),
    )
    const settled = yield* Effect.forEach(created, (item) =>
      until(comparisons.get(item.definition.id), (info) =>
        info.runs.every((run) => ["completed", "cancelled", "failed-to-start"].includes(run.status)),
      ),
    )
    expect(settled.flatMap((info) => info.runs.map((run) => run.error ?? run.status))).toEqual(
      Array.from({ length: 8 }, () => "completed"),
    )
    const analysis = yield* improvements.analysis(repo)
    const finding = analysis.findings.find((item) => item.kind === "recurring-task-failure")
    if (!finding) throw new Error(`no finding: ${JSON.stringify(analysis)}`)
    return { analysis, finding: { id: finding.id, taskKey: finding.taskKeys[0] }, full: finding }
  })

const stage = (id: Improvement.ID, stages: string[], seconds?: number) =>
  until(
    Improvement.Service.use((service) => service.get(id)),
    (info) => stages.includes(info.state.stage),
    seconds,
  )

describe("Improvement", () => {
  it.live(
    "diagnoses a weakness, implements an approved fix in isolation and verifies that it improves outcomes",
    () =>
      Effect.gen(function* () {
        const repo = yield* fixture
        const improvements = yield* Improvement.Service
        const comparisons = yield* Comparison.Service
        const observed = yield* observe(repo)
        expect(observed.full).toMatchObject({ support: "supported", needsMoreEvidence: false, frequency: 8 })
        expect(observed.full.evidence).toHaveLength(8)
        yield* script(observed.finding, { proposal: (finding) => proposal(finding), implementation: `${RULE}\n` })

        const created = yield* improvements.create({ directory: repo, findingID: observed.finding.id })
        expect(created.definition.finding).toEqual(observed.full)
        const proposed = yield* stage(created.definition.id, ["proposed", "needs-proposal"])
        expect(proposed.state.investigations[0]).toMatchObject({ status: "valid", errors: [] })
        expect(proposed.state.investigations[0].proposal?.layer).toBe("prompt-context")
        const sessions = yield* Session.Service
        const investigation = yield* sessions.get(proposed.state.investigations[0].sessionID!)
        expect(String(investigation.agent)).toBe("plan")

        // Approval is the only way forward, and only for a valid proposal.
        expect(
          (yield* improvements.approve(created.definition.id, { attempt: 7, harness: "opencode" }).pipe(Effect.flip))
            ._tag,
        ).toBe("Improvement.InvalidInputError")
        yield* improvements.approve(created.definition.id, { attempt: 0, harness: "opencode" })
        const evaluated = yield* stage(created.definition.id, ["evaluated"], 240)

        const implementation = evaluated.state.implementation!
        expect(implementation).toMatchObject({ status: "completed", branch: `improvement/${created.definition.id}` })
        expect(implementation.patch).toContain(`+${RULE}`)
        expect(implementation.changes.map((change) => change.path)).toEqual(["AGENTS.md"])
        expect(implementation.checks.every((check) => check.passed)).toBe(true)
        expect((yield* sessions.get(implementation.sessionID!)).permissions).toEqual(
          (yield* sessions.get(proposed.state.investigations[0].sessionID!)).permissions,
        )
        // The user's checkout is untouched; the change lives on a reviewable branch.
        expect(yield* Effect.promise(() => Bun.file(path.join(repo, "AGENTS.md")).exists())).toBe(false)
        const branch = yield* Effect.promise(() =>
          $`git rev-parse improvement/${created.definition.id}`.cwd(repo).text(),
        )
        expect(branch.trim()).toBe(implementation.commit!)

        expect(evaluated.state.evaluation).toMatchObject({ status: "completed", verdict: "improved" })
        const native = evaluated.state.evaluation!.results.find((result) => result.harness === "opencode")!
        expect(native).toMatchObject({
          target: true,
          baseline: { verified: 3, successes: 0 },
          candidate: { verified: 3, successes: 3 },
        })
        expect(native.pImproved).toBeCloseTo(0.05, 10)
        expect(evaluated.state.evaluation!.results.find((result) => result.harness === "stack-agent")).toMatchObject({
          baseline: { successes: 0 },
          candidate: { successes: 3 },
        })

        // Baseline and candidate are separate records, tagged so they never pollute the observed history.
        const tagged = (yield* comparisons.list()).filter(
          (item) => item.origin?.improvementID === created.definition.id,
        )
        expect(tagged.map((item) => item.origin?.variant).toSorted()).toEqual([
          "baseline",
          "baseline",
          "baseline",
          "candidate",
          "candidate",
          "candidate",
        ])
        const after = yield* improvements.analysis(repo)
        expect(after.records).toBe(observed.analysis.records)

        // Not validated until a reviewer accepts it; then it becomes evidence for the next diagnosis.
        expect(after.findings.find((item) => item.id === observed.finding.id)?.history).toEqual([
          { improvementID: created.definition.id, verdict: "improved", decision: undefined, validated: false },
        ])
        yield* improvements.decide(created.definition.id, { decision: "accept", note: "Reviewed the patch" })
        const decided = yield* improvements.analysis(repo)
        expect(decided.findings.find((item) => item.id === observed.finding.id)?.history[0].validated).toBe(true)
      }),
    { timeout: 300_000 },
  )

  it.live(
    "rejects an invalid proposal, recovers with a new investigation and reports a failed implementation",
    () =>
      Effect.gen(function* () {
        const repo = yield* fixture
        const improvements = yield* Improvement.Service
        const observed = yield* observe(repo)
        let attempts = 0
        yield* script(observed.finding, {
          proposal: (finding) =>
            attempts++ === 0 ? { ...proposal(finding, 1), permissions: ["*"] } : proposal(finding, 1),
          implementation: undefined,
        })
        const created = yield* improvements.create({ directory: repo, findingID: observed.finding.id })
        const invalid = yield* stage(created.definition.id, ["proposed", "needs-proposal"])
        expect(invalid.state.stage).toBe("needs-proposal")
        expect(invalid.state.investigations[0].status).toBe("invalid")
        expect(invalid.state.investigations[0].errors[0]).toContain("does not match the schema")
        expect(
          (yield* improvements.approve(created.definition.id, { attempt: 0, harness: "opencode" }).pipe(Effect.flip))
            ._tag,
        ).toBe("Improvement.InvalidInputError")

        yield* improvements.investigate(created.definition.id)
        const valid = yield* stage(created.definition.id, ["proposed", "needs-proposal"])
        expect(valid.state.investigations.map((item) => item.status)).toEqual(["invalid", "valid"])

        // Stack-Agent implements this one. Its change misses the proposal's acceptance check, so the intervention fails
        // to implement and is never evaluated as an improvement.
        yield* improvements.approve(created.definition.id, { attempt: 1, harness: "stack-agent" })
        const evaluated = yield* stage(created.definition.id, ["evaluated"], 240)
        expect(evaluated.state.evaluation).toMatchObject({
          verdict: "failed-to-implement",
          reason: "Acceptance checks failed: AGENTS.md states the answer",
        })
        expect(evaluated.state.implementation).toMatchObject({ status: "failed", harness: "stack-agent" })
        expect(evaluated.state.implementation?.checks).toMatchObject([{ id: "rule", passed: false }])
        expect(evaluated.state.implementation?.changes.map((change) => change.path)).toEqual(["answer.txt"])
        expect(evaluated.state.evaluation?.results.find((result) => result.harness === "opencode")?.baseline.runs).toBe(
          1,
        )
      }),
    { timeout: 300_000 },
  )

  it.live(
    "resumes an interrupted pipeline without repeating completed side effects",
    () =>
      Effect.gen(function* () {
        const repo = yield* fixture
        const improvements = yield* Improvement.Service
        const comparisons = yield* Comparison.Service
        const worktrees = yield* Worktree.Service
        const kv = yield* KV.Service
        const observed = yield* observe(repo)
        yield* script(observed.finding, { proposal: (finding) => proposal(finding, 1), implementation: `${RULE}\n` })
        const created = yield* improvements.create({ directory: repo, findingID: observed.finding.id })
        const id = created.definition.id
        yield* stage(id, ["proposed"])
        yield* improvements.approve(id, { attempt: 0, harness: "opencode" })
        const done = yield* stage(id, ["evaluated"], 240)
        const project = created.definition.projectID
        const before = {
          comparisons: (yield* comparisons.list()).length,
          worktrees: (yield* worktrees.list({ projectID: project })).length,
        }

        // Simulate a crash after the candidate runs were started but before the verdict was written.
        yield* kv.set(`improvement/state/${id}`, {
          ...(JSON.parse(JSON.stringify(done.state)) as object),
          stage: "implementing",
          evaluation: { status: "baseline", results: [] },
        } as never)
        const resumed = yield* Effect.scoped(
          Layer.build(Layer.fresh(Improvement.layer)).pipe(
            Effect.flatMap((context) =>
              until(
                Improvement.Service.use((service) => service.get(id)),
                (info) => info.state.stage === "evaluated",
              ).pipe(Effect.provide(context)),
            ),
          ),
        )
        expect(resumed.state.evaluation?.verdict).toBe(done.state.evaluation?.verdict)
        expect(resumed.state.implementation?.commit).toBe(done.state.implementation?.commit)
        expect((yield* comparisons.list()).length).toBe(before.comparisons)
        expect((yield* worktrees.list({ projectID: project })).length).toBe(before.worktrees)
      }),
    { timeout: 300_000 },
  )
})
