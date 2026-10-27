import { For } from "solid-js"

/** Whether the main area shows the conversation or the command line. */
export function ModePill(props: { cli: boolean; onCli: (value: boolean) => void }) {
  return (
    <div
      role="group"
      aria-label="Conversation mode"
      data-slot="session-cli-toggle"
      class="absolute end-3 bottom-3 z-30 flex gap-0.5 rounded-lg border border-v2-border-border-base bg-v2-background-bg-base p-0.5 text-12-medium"
    >
      <For each={[false, true]}>
        {(mode) => (
          <button
            type="button"
            aria-pressed={props.cli === mode}
            class="rounded-md px-2 py-1"
            classList={{ "bg-surface-base": props.cli === mode, "text-text-weak": props.cli !== mode }}
            onClick={() => props.onCli(mode)}
          >
            {mode ? "CLI" : "Chat"}
          </button>
        )}
      </For>
    </div>
  )
}
