export * as ComparisonCommand from "./command.js"

import { Effect } from "effect"
import { ChildProcess } from "effect/process"
import type { AppProcess } from "@opencode/util/process"

// Verification commands are the evaluator's own; a hung test suite must not hold a report forever.
const TIMEOUT = "10 minutes"
const OUTPUT_TAIL = 4000

/** Runs a verification command through the login shell in `cwd`, keeping the exit status and the output's tail. */
export const run = (proc: AppProcess.Interface, cwd: string, command: string) =>
  Effect.gen(function* () {
    const started = Date.now()
    const windows = process.platform === "win32"
    const result = yield* proc
      .run(
        ChildProcess.make(windows ? command : "bash", windows ? [] : ["-lc", command], {
          cwd,
          stdin: "ignore",
          shell: windows,
          extendEnv: true,
        }),
        { combineOutput: true, timeout: TIMEOUT, maxOutputBytes: 1024 * 1024 },
      )
      .pipe(
        Effect.map((result) => ({
          exitCode: result.exitCode,
          output: (result.output ?? result.stdout).toString("utf8"),
        })),
        Effect.catch((error) => Effect.succeed({ exitCode: -1, output: error.message })),
      )
    return { ...result, output: result.output.slice(-OUTPUT_TAIL), durationMs: Date.now() - started }
  })
