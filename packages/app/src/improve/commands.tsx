import { useNavigate } from "@solidjs/router"
import { useLanguage } from "@/runtime/i18n/language"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { useCommand } from "@/shell/commands/command"
import { compareHref, improveHref, runtimeHref } from "@/shell/routes/session"
import { useCurrentRoute, useLayout } from "@/shell/state/layout"
import { type DraftTab, useTabs } from "@/shell/tabs/tabs"

/**
 * Compare agents, the Improvement Lab and the Stack-Agent runtime, registered for the whole shell so they are reachable
 * from Home, sessions and drafts alike. A draft or Home's selected project is passed along; elsewhere the screens offer a project picker.
 */
export function useAgentLabCommands() {
  const command = useCommand()
  const language = useLanguage()
  const navigate = useNavigate()
  const servers = useServers()
  const tabs = useTabs()
  const layout = useLayout()
  const route = useCurrentRoute()

  const target = () => {
    const current = route()
    const draft =
      current.type === "draft"
        ? tabs.store.find((tab): tab is DraftTab => tab.type === "draft" && tab.draftID === current.draftID)
        : undefined

    if (draft) return { server: draft.server, directory: draft.directory }
    const home = current.type === "home" ? layout.home.selection() : undefined
    const homeServer = home?.server
    if (homeServer && servers.visible.some((item) => ServerConnection.key(item) === homeServer))
      return { server: homeServer, directory: home.directory }
    if ("server" in current) return { server: current.server }
    const conn = servers.visible.find((item) => servers.current(item)) ?? servers.visible[0]

    return conn ? { server: ServerConnection.key(conn) } : undefined
  }

  const open = (href: (input: { server: ServerConnection.Key; directory?: string }) => string) => () => {
    const next = target()

    if (next) navigate(href(next))
  }

  command.register("agent-lab", () => [
    {
      id: "compare.open",
      title: language.t("compare.command"),
      description: language.t("compare.command.description"),
      category: language.t("command.category.workspace"),
      onSelect: open((input) => compareHref(input.server, { directory: input.directory })),
    },
    {
      id: "improve.open",
      title: language.t("improve.command"),
      description: language.t("improve.command.description"),
      category: language.t("command.category.workspace"),
      onSelect: open((input) => improveHref(input.server, { directory: input.directory })),
    },
    {
      id: "runtime.open",
      title: language.t("runtime.command"),
      description: language.t("runtime.command.description"),
      category: language.t("command.category.workspace"),
      onSelect: open((input) => runtimeHref(input.server)),
    },
  ])
}
