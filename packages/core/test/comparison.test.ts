// Runs both agent runtimes against one small deterministic repository and checks the comparison from the outside:
// workspaces, files and git state are read directly, never taken from what either agent reports.
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
import { KV } from "@opencode/core/kv"
import { Project } from "@opencode/core/project"
import { Worktree } from "@opencode/core/worktree"
import { AppProcess } from "@opencode/util/process"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { tempGlobalLayer } from "./fixture/global"
import { initGit } from "./fixture/git"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const PROMPT = "Create answer.txt containing the number 42."
const TASK = {
  title: "Write the answer",
  prompt: PROMPT,
  category: "implementation",
  criteria: [
    { id: "exists", description: "answer.txt exists", command: "test -f answer.txt" },
    { id: "value", description: "answer.txt contains 42", command: "grep -q 42 answer.txt" },
    { id: "readme", description: "README.md is kept", command: "test -f README.md" },
  ],
} as const

const llmLayer = TestLLM.testLayer()
const it = testEffect(
  Layer.merge(
    llmLayer,
    AppNodeBuilder.build(
      LayerNode.group([
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
                  LanguageModel.make({ id: "compare", provider: "test", route: OpenAIChat.route }),
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

/** The native agent writes the file through the write tool once, then reports completion. */
const scriptNative = (content: string) =>
  TestLLM.Test.use((llm) =>
    llm.serve((request) =>
      request.messages.some((message) => message.role === "tool")
        ? TestLLM.text("I wrote answer.txt.", "done")
        : TestLLM.tool("call_1", "write", { path: "answer.txt", content }),
    ),
  )

const fixture = Effect.gen(function* () {
  const tmp = yield* tmpdirScoped()
  const repo = path.join(tmp.path, "repo")
  yield* Effect.promise(async () => {
    await fs.mkdir(repo)
    await initGit(repo)
    await Bun.write(path.join(repo, "README.md"), "fixture\n")
    await $`git add README.md && git commit -m init`.cwd(repo).quiet()
    // A user's uncommitted work that neither run may touch or receive.
    await Bun.write(path.join(repo, "notes.txt"), "user work in progress\n")
  })
  const bin = path.join(tmp.path, "stack-agent")
  const write = (script: string) =>
    Effect.promise(async () => {
      await Bun.write(
        bin,
        `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "stack-agent 0.0.0-test"; exit 0; fi\n${script}\n`,
      )
      await fs.chmod(bin, 0o755)
    })
  yield* write(`echo "42 from stack-agent" > answer.txt\necho "stack-agent: done"`)
  // The runs read the binary in the background after create returns, so it stays configured for the whole test.
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
  return { repo: AbsolutePath.make(repo), bin, write }
})

const settled = (id: Comparison.ID) =>
  Effect.gen(function* () {
    const comparisons = yield* Comparison.Service
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline) {
      const info = yield* comparisons.get(id)
      if (info.runs.every((run) => ["completed", "cancelled", "failed-to-start"].includes(run.status))) return info
      yield* Effect.promise(() => Bun.sleep(50))
    }
    const last = yield* comparisons.get(id)
    return yield* Effect.die(
      new Error(
        `comparison did not settle: ${JSON.stringify(last.runs.map((item) => ({ ...item, observation: item.observation?.activity })))}`,
      ),
    )
  })

const run = (info: Comparison.Info, harness: "opencode" | "stack-agent") => {
  const found = info.runs.find((item) => item.harness === harness)
  if (!found) throw new Error(`missing ${harness} run`)
  return found
}

const metric = (item: ReturnType<typeof run>, key: string) =>
  [...(item.report?.metrics ?? []), ...(item.observation?.metrics ?? [])].find((entry) => entry.key === key)?.metric

describe("Comparison", () => {
  it.live("runs both runtimes in isolated workspaces and verifies results independently", () =>
    Effect.gen(function* () {
      const repo = yield* fixture
      yield* scriptNative("42 from opencode\n")
      const comparisons = yield* Comparison.Service
      const sessions = yield* Session.Service
      const revision = (yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(repo.repo).text())).trim()

      const created = yield* comparisons.create({ directory: repo.repo, task: TASK })
      expect(created.definition.repository.revision).toBe(revision)
      expect(created.definition.repository.dirty).toBe(true)
      const info = yield* settled(created.definition.id)
      const native = run(info, "opencode")
      const stack = run(info, "stack-agent")

      // Independent workspaces from one revision, neither of them the user's checkout.
      expect(native.directory).toBeDefined()
      expect(stack.directory).toBeDefined()
      expect(native.directory).not.toBe(stack.directory)
      for (const item of [native, stack]) {
        expect(item.directory).not.toBe(repo.repo)
        const head = yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(item.directory!).text())
        expect(head.trim()).toBe(revision)
        expect(yield* Effect.promise(() => Bun.file(path.join(item.directory!, "notes.txt")).exists())).toBe(false)
      }

      // Each agent wrote only into its own workspace; the user's checkout is unchanged.
      expect(yield* Effect.promise(() => Bun.file(path.join(native.directory!, "answer.txt")).text())).toBe(
        "42 from opencode\n",
      )
      expect(yield* Effect.promise(() => Bun.file(path.join(stack.directory!, "answer.txt")).text())).toBe(
        "42 from stack-agent\n",
      )
      expect(yield* Effect.promise(() => Bun.file(path.join(repo.repo, "answer.txt")).exists())).toBe(false)
      expect(yield* Effect.promise(() => Bun.file(path.join(repo.repo, "notes.txt")).text())).toBe(
        "user work in progress\n",
      )

      // Both Sessions received the identical task text and their own harness.
      for (const item of [native, stack]) {
        const session = yield* sessions.get(item.sessionID!)
        expect(session.metadata?.harness).toBe(item.harness)
        expect(session.metadata?.comparisonID).toBe(created.definition.id)
        const context = yield* sessions.context(item.sessionID!)
        expect(context.find((message) => message.type === "user")?.text).toBe(PROMPT)
      }

      // Outcomes come from the evaluator's own command runs.
      for (const item of [native, stack]) {
        expect(item.status).toBe("completed")
        expect(item.report?.outcome).toBe("verified-success")
        expect(item.report?.criteria.map((criterion) => criterion.status)).toEqual(["passed", "passed", "passed"])
        expect(item.report?.criteria.map((criterion) => criterion.baseline)).toEqual(["failed", "failed", "passed"])
        expect(item.report?.criteria[0].evidence[0]).toMatchObject({ command: "test -f answer.txt", exitCode: 0 })
        expect(item.report?.changes).toEqual([{ path: "answer.txt", status: "untracked", additions: 1, deletions: 0 }])
      }

      // Tool activity is attributed to the run whose Session produced it; stack-agent's tools are not observable.
      expect(metric(native, "toolCalls")).toMatchObject({ available: true, value: 1 })
      expect(metric(stack, "toolCalls")).toMatchObject({ available: false })
      expect(metric(stack, "toolCalls")?.value).toBeUndefined()
      expect(metric(native, "cost")).toMatchObject({ available: false })
      expect(native.observation?.activity.some((item) => item.kind === "tool" && item.label === "write")).toBe(true)
      expect(stack.observation?.activity.some((item) => item.kind === "tool")).toBe(false)
      expect(stack.observation?.claim).toContain("stack-agent: done")
      expect(stack.environment.find((fact) => fact.key === "stack-agent version")?.value).toBe("stack-agent 0.0.0-test")

      expect(info.trials.find((trial) => trial.harness === "opencode")).toMatchObject({
        runs: 1,
        outcomes: [{ outcome: "verified-success", count: 1 }],
      })
      expect((yield* comparisons.list()).map((summary) => summary.id)).toContain(created.definition.id)
    }),
  )

  it.live("reports a failed run, a cancelled run and a startup failure separately", () =>
    Effect.gen(function* () {
      const repo = yield* fixture
      // The native agent writes the wrong value, so its file exists but the value check fails.
      yield* scriptNative("41\n")
      yield* repo.write(`sleep 20`)
      const comparisons = yield* Comparison.Service
      const created = yield* comparisons.create({ directory: repo.repo, task: TASK })
      const id = created.definition.id
      const deadline = Date.now() + 20_000
      while (
        (yield* comparisons.get(id)).runs.some((item) => item.harness === "stack-agent" && item.status !== "running")
      ) {
        if (Date.now() > deadline) return yield* Effect.die(new Error("stack-agent never started"))
        yield* Effect.promise(() => Bun.sleep(50))
      }
      yield* comparisons.cancel(id, { harness: "stack-agent" })
      const info = yield* settled(id)

      expect(run(info, "opencode").report).toMatchObject({ outcome: "partial" })
      expect(run(info, "opencode").report?.criteria.find((item) => item.id === "value")?.status).toBe("failed")
      expect(run(info, "stack-agent").status).toBe("cancelled")
      expect(run(info, "stack-agent").report?.outcome).toBe("cancelled")
      expect(run(info, "stack-agent").report?.criteria.every((item) => item.status === "not-run")).toBe(true)

      yield* Effect.promise(() => fs.rm(repo.bin))
      const missing = yield* comparisons.create({ directory: repo.repo, task: TASK })
      const failed = yield* settled(missing.definition.id)
      expect(run(failed, "stack-agent").status).toBe("failed-to-start")
      expect(run(failed, "stack-agent").error).toContain("stack-agent binary not found")
      expect(run(failed, "opencode").status).toBe("completed")
    }),
  )

  it.live("records a provider failure without crediting the agent", () =>
    Effect.gen(function* () {
      const repo = yield* fixture
      const llm = yield* TestLLM.Test
      yield* llm.serve(() => TestLLM.failAfter(new Error("provider exploded") as never))
      const comparisons = yield* Comparison.Service
      const created = yield* comparisons.create({
        directory: repo.repo,
        task: { ...TASK, criteria: [{ id: "manual", description: "Explanation is accurate" }] },
      })
      const info = yield* settled(created.definition.id)
      const native = run(info, "opencode")
      expect(native.observation?.execution).toBe("failed")
      expect(native.report?.outcome).toBe("unverified")
      expect(native.report?.criteria[0].status).toBe("unverified")
    }),
  )

  it.live("rejects a directory that is not a Git repository", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const comparisons = yield* Comparison.Service
      const error = yield* comparisons.create({ directory: AbsolutePath.make(tmp.path), task: TASK }).pipe(Effect.flip)
      expect(error._tag).toBe("Comparison.InvalidInputError")
    }),
  )

  it.live("reopens persisted comparisons in a new service and recovers interrupted preparation", () =>
    Effect.gen(function* () {
      const repo = yield* fixture
      yield* scriptNative("42\n")
      const comparisons = yield* Comparison.Service
      const created = yield* comparisons.create({ directory: repo.repo, task: TASK })
      const before = yield* settled(created.definition.id)
      const kv = yield* KV.Service
      // A run the previous process left preparing cannot be resumed safely.
      const pending = run(before, "opencode")
      yield* kv.set(`comparison/run/${created.definition.id}/opencode`, {
        harness: "opencode",
        status: "preparing",
        environment: [],
        baseline: [],
        cancelRequested: false,
        createdAt: pending.createdAt,
      })

      const restarted = yield* Effect.scoped(
        Layer.build(Layer.fresh(Comparison.layer)).pipe(
          Effect.flatMap((context) =>
            Effect.gen(function* () {
              const fresh = yield* Comparison.Service
              const deadline = Date.now() + 10_000
              while (Date.now() < deadline) {
                const info = yield* fresh.get(created.definition.id)
                if (run(info, "opencode").status === "failed-to-start") return info
                yield* Effect.promise(() => Bun.sleep(20))
              }
              return yield* fresh.get(created.definition.id)
            }).pipe(Effect.provide(context)),
          ),
        ),
      )
      expect(restarted.definition).toEqual(before.definition)
      expect(run(restarted, "stack-agent").report).toEqual(run(before, "stack-agent").report)
      expect(run(restarted, "opencode").status).toBe("failed-to-start")
    }),
  )
})
