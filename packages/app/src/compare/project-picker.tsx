import { A } from "@solidjs/router"
import { For, Show } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { useServer } from "@/runtime/server/current"

/** Lists the server's projects so Compare agents and the Improvement Lab can start without an open project. */
export function ProjectPicker(props: { href: (directory: string) => string }) {
  const server = useServer()
  const language = useLanguage()

  return (
    <div data-component="agent-lab-project-picker" class="flex max-w-[880px] flex-col gap-2">
      <p class="text-[13px] text-v2-text-text-muted">{language.t("agentLab.project.choose")}</p>
      <Show
        when={server.ctx.projects.unique().length > 0}
        fallback={<p class="text-[13px] text-v2-text-text-faint">{language.t("agentLab.project.none")}</p>}
      >
        <div class="flex flex-col gap-1">
          <For each={server.ctx.projects.unique()}>
            {(project) => (
              <A
                href={props.href(project.worktree)}
                class="flex min-w-0 flex-col rounded-lg border border-v2-border-border-base bg-v2-background-bg-deep px-3 py-2 hover:border-v2-border-border-strong"
              >
                <span class="truncate text-[13px] text-v2-text-text-base">
                  {project.name || project.worktree.split(/[\\/]/).findLast(Boolean)}
                </span>
                <code class="truncate text-[12px] text-v2-text-text-faint">{project.worktree}</code>
              </A>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
