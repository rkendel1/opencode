import { createSignal } from "solid-js"

export type Harness = "stack-agent" | "opencode"

// Chosen before a session exists, so the new-session screen and the session screen share one selection. A session
// stores its own harness once created; a new one starts from this.
const [harness, setHarness] = createSignal<Harness>("stack-agent")
const [cli, setCli] = createSignal(false)

export const sessionHarness = { harness, setHarness, cli, setCli }

export const toHarness = (value: string | undefined): Harness => (value === "opencode" ? "opencode" : "stack-agent")
