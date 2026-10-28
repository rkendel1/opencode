// The Stack-Agent runtime manager against a real Git source repository whose build script produces a small stub
// executable. Exercises build, validation, activation, rollback, failure, concurrency, recovery and rolling
// activation with live Sessions. The build command is configurable; production uses cargo.
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { $ } from "bun"
import { Effect, Layer } from "effect"
import { LanguageModel } from "@opencode/ai/effect"
import { OpenAIChat } from "@opencode/ai/protocols/openai-chat"
import { TestLLM } from "@opencode/ai/testing"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode/core/effect/app-node-platform"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { KV } from "@opencode/core/kv"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { ComparisonSettle } from "@opencode/core/comparison/settle"
import { StackAgentRuntime } from "@opencode/core/stack-agent-runtime"
import { Git } from "@opencode/core/git"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { tempGlobalLayer } from "./fixture/global"
import { initGit } from "./fixture/git"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const llmLayer = TestLLM.testLayer({ fallback: TestLLM.text("unused", "unused") })
const it = testEffect(
  Layer.merge(
    llmLayer,
    AppNodeBuilder.build(
      LayerNode.group([
        StackAgentRuntime.node,
        Session.node,
        LocationServiceMap.node,
        KV.node,
        Git.node,
        AppProcess.node,
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
                  LanguageModel.make({ id: "runtime", provider: "test", route: OpenAIChat.route }),
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

/** The build script turns `behavior.txt` into an executable; `broken` fails the offline self-test. */
const BUILD = `#!/bin/sh
set -e
[ -f fail-build ] && { echo "error[E0308]: mismatched types" >&2; exit 101; }
B=$(cat behavior.txt)
mkdir -p out
cat > out/stack-agent <<EOS
#!/bin/sh
if [ "\\$1" = "--version" ]; then echo "stack-agent 1.0.0+$B"; exit 0; fi
if [ "\\$1" = "--test" ]; then [ "$B" = broken ] && exit 1; echo "self-test ok"; exit 0; fi
sleep \\$(cat .work-delay 2>/dev/null || echo 0)
echo "$B" > answer.txt
echo "work done by $B"
EOS
chmod +x out/stack-agent
`

const fixture = Effect.gen(function* () {
  const tmp = yield* tmpdirScoped()
  const source = AbsolutePath.make(path.join(tmp.path, "stack-agent"))
  const project = AbsolutePath.make(path.join(tmp.path, "project"))
  yield* Effect.promise(async () => {
    await fs.mkdir(source)
    await initGit(source)
    await Bun.write(path.join(source, "build.sh"), BUILD)
    await Bun.write(path.join(source, "behavior.txt"), "v1\n")
    await $`git add -A && git commit -m v1`.cwd(source).quiet()
    await fs.mkdir(project)
    await initGit(project)
    await Bun.write(path.join(project, "README.md"), "project\n")
    await $`git add -A && git commit -m init`.cwd(project).quiet()
  })
  const runtime = yield* StackAgentRuntime.Service
  yield* runtime.configure({
    sourceDirectory: source,
    branch: "HEAD",
    buildCommand: ["sh", "build.sh"],
    artifact: "out/stack-agent",
    smoke: [["--version"], ["--test"]],
    checks: [["sh", "-c", "test -f behavior.txt"]],
  })
  const commit = (behavior: string, extra?: (dir: string) => Promise<unknown>) =>
    Effect.promise(async () => {
      await Bun.write(path.join(source, "behavior.txt"), `${behavior}\n`)
      await extra?.(source)
      await $`git add -A && git commit -m ${behavior}`.cwd(source).quiet()
      return (await $`git rev-parse HEAD`.cwd(source).text()).trim()
    })
  return { source, project, commit }
})

const built = (revision?: string) =>
  Effect.gen(function* () {
    const runtime = yield* StackAgentRuntime.Service
    const started = yield* runtime.build({ revision })
    return (yield* runtime.settled(started.id))!
  })

describe("StackAgentRuntime", () => {
  it.live("builds into an immutable versioned path, validates, activates and rolls back", () =>
    Effect.gen(function* () {
      const repo = yield* fixture
      const runtime = yield* StackAgentRuntime.Service
      expect((yield* runtime.resolve()).source).toBe("external")

      const first = yield* built()
      expect(first).toMatchObject({ status: "validated", version: "stack-agent 1.0.0+v1" })
      expect(first.executable).not.toContain(repo.source)
      expect(first.smoke.map((check) => check.exitCode)).toEqual([0, 0])
      // The user's checkout is never built in.
      expect(yield* Effect.promise(() => Bun.file(path.join(repo.source, "out/stack-agent")).exists())).toBe(false)
      // Building the same source tree again reuses the validated generation.
      expect((yield* runtime.build({})).id).toBe(first.id)

      yield* runtime.activate(first.id)
      expect(yield* runtime.resolve()).toMatchObject({ generation: first.id, source: "active", commit: first.commit })

      yield* repo.commit("v2")
      const second = yield* built()
      expect(second.version).toBe("stack-agent 1.0.0+v2")
      // Staged, not active, until the user activates it.
      expect((yield* runtime.resolve()).generation).toBe(first.id)
      const activated = yield* runtime.activate(second.id)
      expect(activated.state).toMatchObject({ active: second.id, previous: [first.id] })
      expect(yield* Effect.promise(() => Bun.file(first.executable!).exists())).toBe(true)

      const rolled = yield* runtime.rollback()
      expect(rolled.current).toMatchObject({ generation: first.id, source: "active" })
      expect(rolled.state.events.map((item) => item.kind).slice(0, 2)).toEqual(["rolled-back", "activated"])
      expect((yield* runtime.generation(second.id))?.status).toBe("validated")
      // A pinned generation wins over the active one.
      expect((yield* runtime.resolve(second.id)).generation).toBe(second.id)
    }),
  )

  it.live("keeps the active runtime when a build, a validation or an activation fails", () =>
    Effect.gen(function* () {
      const repo = yield* fixture
      const runtime = yield* StackAgentRuntime.Service
      const good = yield* built()
      yield* runtime.activate(good.id)

      yield* repo.commit("v3", (dir) => Bun.write(path.join(dir, "fail-build"), "yes"))
      const failedBuild = yield* built()
      expect(failedBuild).toMatchObject({ status: "failed", error: "The build command exited with status 101" })
      expect(failedBuild.build?.output).toContain("mismatched types")

      yield* repo.commit("broken", (dir) => fs.rm(path.join(dir, "fail-build")))
      const failedSmoke = yield* built()
      expect(failedSmoke.status).toBe("failed")
      expect(failedSmoke.smoke.at(-1)).toMatchObject({ exitCode: 1 })
      expect(failedSmoke.error).toContain("Smoke check failed")

      expect((yield* runtime.activate(failedSmoke.id).pipe(Effect.flip)).message).toContain("not a validated build")
      expect((yield* runtime.resolve()).generation).toBe(good.id)
      expect((yield* runtime.resolve(failedSmoke.id).pipe(Effect.flip))._tag).toBe(
        "StackAgentRuntime.InvalidInputError",
      )
    }),
  )

  it.live("rejects a concurrent build and refuses an executable that changed after validation", () =>
    Effect.gen(function* () {
      const repo = yield* fixture
      const runtime = yield* StackAgentRuntime.Service
      yield* Effect.promise(() =>
        Bun.write(path.join(repo.source, "build.sh"), BUILD.replace("set -e", "set -e\nsleep 1")),
      )
      yield* repo.commit("slow")
      const first = yield* runtime.build({})
      yield* repo.commit("other")
      expect((yield* runtime.build({}).pipe(Effect.flip))._tag).toBe("StackAgentRuntime.BusyError")
      const done = (yield* runtime.settled(first.id))!
      expect(done.status).toBe("validated")

      yield* Effect.promise(() => Bun.write(done.executable!, "#!/bin/sh\necho tampered\n"))
      expect((yield* runtime.activate(done.id).pipe(Effect.flip)).message).toContain("no longer matches")
      expect((yield* runtime.status()).state.active).toBeUndefined()
    }),
  )

  it.live("records a build interrupted by a restart as failed and leaves the active runtime alone", () =>
    Effect.gen(function* () {
      yield* fixture
      const runtime = yield* StackAgentRuntime.Service
      const kv = yield* KV.Service
      const good = yield* built()
      yield* runtime.activate(good.id)
      const state = (yield* runtime.status()).state
      yield* kv.set(`stack-agent/generation/sag_crashed`, {
        ...(JSON.parse(JSON.stringify(good)) as object),
        id: "sag_crashed",
        tree: "other",
        status: "building",
        executable: undefined,
        sha256: undefined,
      } as never)
      yield* kv.set("stack-agent/state", {
        ...(JSON.parse(JSON.stringify(state)) as object),
        operation: { kind: "build", generation: "sag_crashed", startedAt: 0 },
      } as never)

      const after = yield* Effect.scoped(
        Layer.build(Layer.fresh(StackAgentRuntime.layer)).pipe(
          Effect.flatMap((context) =>
            Effect.gen(function* () {
              const fresh = yield* StackAgentRuntime.Service
              return { status: yield* fresh.status(), crashed: yield* fresh.generation("sag_crashed") }
            }).pipe(Effect.provide(context)),
          ),
        ),
      )
      expect(after.crashed?.status).toBe("failed")
      expect(after.status.state.operation).toBeUndefined()
      expect(after.status.state.active).toBe(good.id)
      expect(after.status.state.events[0].kind).toBe("interrupted")
    }),
  )

  it.live(
    "routes new tasks to an activated generation while a running task finishes on its own",
    () =>
      Effect.gen(function* () {
        const repo = yield* fixture
        const runtime = yield* StackAgentRuntime.Service
        const sessions = yield* Session.Service
        const v1 = yield* built()
        yield* runtime.activate(v1.id)
        yield* repo.commit("v2")
        const v2 = yield* built()
        // The first task runs for two seconds; the update lands while it is still running.
        yield* Effect.promise(() => Bun.write(path.join(repo.project, ".work-delay"), "2"))

        const start = (title: string) =>
          Effect.gen(function* () {
            const session = yield* sessions.create({
              location: { directory: repo.project },
              title,
              metadata: { harness: "stack-agent" },
            })
            yield* sessions.prompt({ sessionID: session.id, text: "Write the answer" })
            return session.id
          })
        const first = yield* start("before the update")
        yield* Effect.promise(async () => {
          for (let i = 0; i < 100 && !(await Bun.file(path.join(repo.project, ".started")).exists()); i++) {
            const status = await Effect.runPromise(runtime.status())
            if (status.running.length > 0) return
            await Bun.sleep(50)
          }
        })
        expect((yield* runtime.status()).running.map((item) => item.resolved.generation)).toEqual([v1.id])
        yield* runtime.activate(v2.id)
        yield* Effect.promise(() => fs.rm(path.join(repo.project, ".work-delay")))
        const second = yield* start("after the update")
        yield* ComparisonSettle.untilSettled(sessions, second)
        yield* ComparisonSettle.untilSettled(sessions, first)

        const firstUsage = yield* runtime.usage(first)
        const secondUsage = yield* runtime.usage(second)
        expect(firstUsage?.runs).toMatchObject([{ generation: v1.id, source: "active", exitCode: 0 }])
        expect(secondUsage?.runs).toMatchObject([{ generation: v2.id, source: "active", exitCode: 0 }])
        expect(firstUsage?.runs[0].endedAt).toBeGreaterThan(secondUsage!.runs[0].startedAt)
        expect((yield* runtime.status()).running).toEqual([])
      }),
    { timeout: 60_000 },
  )
})
