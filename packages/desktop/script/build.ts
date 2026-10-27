#!/usr/bin/env bun
import { $ } from "bun"
import { copyFile, exists } from "node:fs/promises"
import path from "node:path"
import { copyBuiltCliToResources, downloadCliToResources, getCurrentCli, resolveChannel, windowsify } from "./utils"

// Prepares resources/ (icons, metainfo, the bundled CLI) for OPENCODE_CHANNEL and builds the app into out/.
// The CLI comes from ../cli/dist when it holds the target; otherwise dev downloads the published dev CLI,
// beta the beta CLI, and prod fails.
const dir = path.resolve(import.meta.dir, "..")

const cli = path.resolve(dir, "../cli/dist")

const channel = resolveChannel()

process.chdir(dir)

await $`bun ./script/copy-icons.ts ${channel}`

await $`bun ./script/copy-metainfo.ts ${channel}`

const built = await exists(path.join(cli, getCurrentCli().package.replace("@opencode/", "")))

if (channel === "prod" && !built)
  throw new Error(`Production desktop builds bundle the CLI from ${cli}; build it first`)

if (built) await copyBuiltCliToResources(cli)

if (!built) await downloadCliToResources(channel === "beta" ? "beta" : undefined)

// stack-agent runs every session. Build it with `cargo build --release --bin stack-agent` in its repository,
// or point STACK_AGENT_BINARY at a prebuilt executable for the target.
const stackAgent =
  process.env.STACK_AGENT_BINARY ?? path.resolve(dir, "../../../stack-agent/target/release/stack-agent")

if (await exists(stackAgent)) await copyFile(stackAgent, windowsify("resources/stack-agent"))
else if (channel === "prod")
  throw new Error(`Production desktop builds bundle stack-agent; build it first (${stackAgent})`)

await $`bunx electron-vite build`
