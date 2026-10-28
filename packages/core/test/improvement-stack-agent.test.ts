// A Stack-Agent improvement end to end: the runtime's own source is changed, rebuilt into a candidate generation and
// measured against the active generation on the same project tasks; then applied to Stack-Agent as a reviewable
// branch, built, activated for new tasks and rolled back. The fixture's "Stack-Agent" is a small Git repository whose
// build script bakes `behavior.txt` into the executable, so the source change has a real, measurable effect.
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
import { Git } from "@opencode/core/git"
import { Improvement } from "@opencode/core/improvement"
import { KV } from "@opencode/core/kv"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { StackAgentRuntime } from "@opencode/core/stack-agent-runtime"
import { Worktree } from "@opencode/core/worktree"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { tempGlobalLayer } from "./fixture/global"
import { initGit } from "./fixture/git"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const TASK = {
  title: "Write the answer",
  prompt: "Create answer.txt containing the answer.",
  category: "implementation",
  criteria: [{ id: "value", description: "answer.txt is 42", command: "grep -qx 42 answer.txt" }],
} as const

const BUILD = `#!/bin/sh
set -e
B=$(cat behavior.txt)
mkdir -p out
cat > out/stack-agent <<EOS
#!/bin/sh
if [ "\\$1" = "--version" ]; then echo "stack-agent 1.0.0+answer-$B"; exit 0; fi
if [ "\\$1" = "--test" ]; then echo "self-test ok"; exit 0; fi
echo "$B" > answer.txt
echo "wrote $B"
EOS
chmod +x out/stack-agent
`

const llmLayer = TestLLM.testLayer()
const it = testEffect(
  Layer.merge(
    llmLayer,
    AppNodeBuilder.build(
      LayerNode.group([
        Improvement.node,
        Comparison.node,
        StackAgentRuntime.node,
        Session.node,
        LocationServiceMap.node,
        KV.node,
        Worktree.node,
        Project.node,
        AppProcess.node,
        Git.node,
        Global.node,
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

/** The native agent always writes 41; the investigation reads Stack-Agent's source and proposes the fix. */
const script = (finding: { id: string; taskKey: string }) =>
  TestLLM.Test.use((llm) =>
    llm.serve((request) => {
      const text = JSON.stringify(request)
      const tools = request.messages.filter((message) => message.role === "tool").length
      if (text.includes("You are investigating a weakness")) {
        if (tools === 0) return TestLLM.tool("read_1", "read", { path: "behavior.txt" })
        return TestLLM.text(
          "```json\n" +
            JSON.stringify({
              version: 1,
              findingID: finding.id,
              title: "Answer 42 instead of 41",
              cause: "Stack-Agent's behaviour file hard-codes 41, which every failing run wrote.",
              hypothesis: "If Stack-Agent writes 42, its verified success on this task rises.",
              mechanism: "The build bakes behavior.txt into the executable.",
              layer: "runtime",
              alternatives: ["The task itself is mis-specified"],
              sourceLocations: [{ path: "behavior.txt", line: 1, reason: "The value Stack-Agent writes" }],
              changes: [{ path: "behavior.txt", description: "Write 42" }],
              acceptanceCriteria: [{ id: "value", description: "behavior is 42", command: "grep -qx 42 behavior.txt" }],
              evaluation: { taskKeys: [finding.taskKey], trials: 3, targetRuntimes: ["stack-agent"] },
              risks: ["Other tasks may expect 41"],
              rollback: ["Stack-Agent verified success does not rise"],
              requiredApprovals: ["Stack-Agent maintainer review"],
            }) +
            "\n```",
          "proposal",
        )
      }
      if (text.includes("Implement this approved change")) {
        if (tools === 0) return TestLLM.tool("write_1", "write", { path: "behavior.txt", content: "42\n" })
        return TestLLM.text("Changed behavior.txt.", "implemented")
      }
      if (tools === 0) return TestLLM.tool("write_1", "write", { path: "answer.txt", content: "41\n" })
      return TestLLM.text("Done.", "done")
    }),
  )

const fixture = Effect.gen(function* () {
  const tmp = yield* tmpdirScoped()
  const source = AbsolutePath.make(path.join(tmp.path, "stack-agent"))
  const project = AbsolutePath.make(path.join(tmp.path, "project"))
  const remote = path.join(tmp.path, "remote.git")
  yield* Effect.promise(async () => {
    await fs.mkdir(source)
    await initGit(source)
    await Bun.write(path.join(source, "build.sh"), BUILD)
    await Bun.write(path.join(source, "behavior.txt"), "41\n")
    await $`git add -A && git commit -m v1 && git branch -M main`.cwd(source).quiet()
    await fs.mkdir(project)
    await initGit(project)
    await Bun.write(path.join(project, "README.md"), "project\n")
    await $`git add -A && git commit -m init`.cwd(project).quiet()
    await $`git init -q --bare ${remote}`.quiet()
    await $`git remote add origin ${remote}`.cwd(source).quiet()
  })
  const runtime = yield* StackAgentRuntime.Service
  yield* runtime.configure({
    sourceDirectory: source,
    branch: "main",
    buildCommand: ["sh", "build.sh"],
    artifact: "out/stack-agent",
    smoke: [["--version"], ["--test"]],
    checks: [["sh", "-c", "test -s behavior.txt"]],
    remote: "origin",
  })
  const started = yield* runtime.build({})
  const current = (yield* runtime.settled(started.id))!
  yield* runtime.activate(current.id)
  return { source, project, remote, current }
})

const until = <A, R>(read: Effect.Effect<A, unknown, R>, done: (value: A) => boolean, seconds = 180) =>
  Effect.gen(function* () {
    const deadline = Date.now() + seconds * 1000
    while (Date.now() < deadline) {
      const value = yield* read
      if (done(value)) return value
      yield* Effect.promise(() => Bun.sleep(100))
    }
    return yield* Effect.die(new Error(`timed out: ${JSON.stringify(yield* read).slice(0, 3000)}`))
  })

const settledComparison = (id: Comparison.ID) =>
  until(
    Comparison.Service.use((service) => service.get(id)),
    (info) => info.runs.every((run) => ["completed", "cancelled", "failed-to-start"].includes(run.status)),
  )

const improvement = (id: Improvement.ID, done: (info: Improvement.Info) => boolean, seconds?: number) =>
  until(
    Improvement.Service.use((service) => service.get(id)),
    done,
    seconds,
  )

/** Observe four failing comparisons, diagnose, investigate with a Stack-Agent target, approve and evaluate. */
const evaluated = Effect.gen(function* () {
  const repo = yield* fixture
  const comparisons = yield* Comparison.Service
  const improvements = yield* Improvement.Service
  const created = yield* Effect.forEach(Array.from({ length: 4 }), () =>
    comparisons.create({ directory: repo.project, task: TASK }),
  )
  yield* Effect.forEach(created, (item) => settledComparison(item.definition.id))
  const finding = (yield* improvements.analysis(repo.project)).findings.find(
    (item) => item.kind === "recurring-task-failure",
  )!
  yield* script({ id: finding.id, taskKey: finding.taskKeys[0] })
  const started = yield* improvements.create({ directory: repo.project, findingID: finding.id, target: "stack-agent" })
  const id = started.definition.id
  yield* improvement(id, (info) => info.state.stage === "proposed" || info.state.stage === "needs-proposal")
  yield* improvements.approve(id, { attempt: 0, harness: "opencode" })
  const done = yield* improvement(id, (info) => info.state.stage === "evaluated", 300)
  return { repo, id, done }
})

describe("Improvement of Stack-Agent", () => {
  it.live(
    "measures a rebuilt Stack-Agent against the active one, applies it as a branch, activates and rolls back",
    () =>
      Effect.gen(function* () {
        const { repo, id, done } = yield* evaluated
        const improvements = yield* Improvement.Service
        const runtime = yield* StackAgentRuntime.Service
        const comparisons = yield* Comparison.Service

        // Investigation and implementation happened in Stack-Agent's source, not the project.
        expect(done.definition).toMatchObject({
          target: "stack-agent",
          source: { directory: repo.source, branch: "main" },
        })
        expect(done.state.implementation).toMatchObject({ status: "completed", changes: [{ path: "behavior.txt" }] })
        const candidate = (yield* runtime.generation(done.state.implementation!.generation!))!
        expect(candidate).toMatchObject({ status: "validated", version: "stack-agent 1.0.0+answer-42" })
        expect((yield* runtime.status()).state.active).toBe(repo.current.id)

        // Pinned arms: the baseline ran the active build, the candidate the new build; only the runtime differed.
        expect(done.state.evaluation).toMatchObject({
          verdict: "improved",
          runtime: {
            baseline: { pin: repo.current.id, commit: repo.current.commit },
            candidate: { pin: candidate.id, commit: candidate.commit },
          },
        })
        const stack = done.state.evaluation!.results.find((result) => result.harness === "stack-agent")!
        expect(stack).toMatchObject({
          target: true,
          baseline: { successes: 0, verified: 3 },
          candidate: { successes: 3 },
        })
        for (const planned of done.state.plan!.runs) {
          const info = yield* comparisons.get(planned.comparisonID)
          const run = info.runs.find((item) => item.harness === "stack-agent")!
          const executed = run.environment.find((fact) => fact.key === "Executed by")?.value
          expect(executed).toBe(planned.variant === "baseline" ? repo.current.id : candidate.id)
        }

        // Apply: previewed first, then a new branch on the target tip; the user's branch and checkout stay put.
        const preview = yield* improvements.preview(id)
        expect(preview).toMatchObject({ drift: false, conflicts: [], files: ["behavior.txt"], blocker: undefined })
        const mainBefore = (yield* Effect.promise(() => $`git rev-parse main`.cwd(repo.source).text())).trim()
        yield* improvements.apply(id)
        const applied = yield* improvement(id, (info) => info.state.application?.status !== "applying")
        expect(applied.state.application).toMatchObject({
          status: "applied",
          branch: `stack-agent-improvement/${id}`,
          sameSource: true,
          drift: false,
        })
        expect(applied.state.application?.diff).toContain("+42")
        expect(applied.state.application?.checks.every((check) => check.passed)).toBe(true)
        expect((yield* Effect.promise(() => $`git rev-parse main`.cwd(repo.source).text())).trim()).toBe(mainBefore)
        expect((yield* Effect.promise(() => $`git status --porcelain`.cwd(repo.source).text())).trim()).toBe("")
        expect(yield* Effect.promise(() => Bun.file(path.join(repo.source, "behavior.txt")).text())).toBe("41\n")
        const message = yield* Effect.promise(() =>
          $`git log -1 --format=%B ${applied.state.application!.commit!}`.cwd(repo.source).text(),
        )
        expect(message).toContain(`Improvement: ${id}`)

        // Applying again is a no-op: the same commit, never a second one.
        yield* improvements.apply(id)
        const again = yield* improvement(id, (info) => info.state.application?.status !== "applying")
        expect(again.state.application?.commit).toBe(applied.state.application!.commit)
        const count = yield* Effect.promise(() =>
          $`git rev-list --count main..stack-agent-improvement/${id}`.cwd(repo.source).text(),
        )
        expect(count.trim()).toBe("1")

        // Nothing is pushed until asked; then only the applied branch.
        expect((yield* Effect.promise(() => $`git branch --list`.cwd(repo.remote).text())).trim()).toBe("")
        yield* improvements.publish(id)
        expect(yield* Effect.promise(() => $`git branch --list`.cwd(repo.remote).text())).toContain(
          `stack-agent-improvement/${id}`,
        )

        // Build the applied commit: same source tree as the evaluated candidate, so the validated build is reused.
        const staged = yield* improvements.stage(id)
        expect(staged.state.application?.build).toBe(candidate.id)
        yield* runtime.activate(candidate.id)

        // New tasks use the activated runtime and now pass; rollback restores the previous build.
        const after = yield* comparisons.create({ directory: repo.project, task: TASK })
        const afterInfo = yield* settledComparison(after.definition.id)
        const stackRun = afterInfo.runs.find((run) => run.harness === "stack-agent")!
        expect(stackRun.report?.outcome).toBe("verified-success")
        expect(stackRun.environment.find((fact) => fact.key === "Executed by")?.value).toBe(candidate.id)
        const rolled = yield* runtime.rollback()
        expect(rolled.current.generation).toBe(repo.current.id)
      }),
    { timeout: 300_000 },
  )

  it.live(
    "stops for review when the Stack-Agent branch changed the same lines after evaluation",
    () =>
      Effect.gen(function* () {
        const { repo, id } = yield* evaluated
        const improvements = yield* Improvement.Service
        yield* Effect.promise(async () => {
          await Bun.write(path.join(repo.source, "behavior.txt"), "43\n")
          await $`git commit -qam upstream`.cwd(repo.source).quiet()
        })
        const tip = (yield* Effect.promise(() => $`git rev-parse main`.cwd(repo.source).text())).trim()
        const preview = yield* improvements.preview(id)
        expect(preview).toMatchObject({ drift: true, tip, conflicts: ["behavior.txt"] })

        yield* improvements.apply(id)
        const stopped = yield* improvement(id, (info) => info.state.application?.status !== "applying")
        expect(stopped.state.application).toMatchObject({
          status: "conflict",
          conflicts: ["behavior.txt"],
          drift: true,
        })
        expect(stopped.state.application?.commit).toBeUndefined()
        expect((yield* Effect.promise(() => $`git rev-parse main`.cwd(repo.source).text())).trim()).toBe(tip)
        const branches = yield* Effect.promise(() =>
          $`git branch --list ${"stack-agent-improvement/*"}`.cwd(repo.source).text(),
        )
        expect(branches.trim()).toBe("")
        expect((yield* improvements.stage(id).pipe(Effect.flip))._tag).toBe("Improvement.InvalidInputError")
      }),
    { timeout: 300_000 },
  )
})
