import { useDialog } from "@opencode/ui/context/dialog"
import { useSettingsCommand } from "@/settings/command"
import { useCommand } from "@/shell/commands/command"
import { useLanguage } from "@/runtime/i18n/language"
import { projectSearchCommand } from "@/shell/titlebar/titlebar"

export function useNewSessionCommands(input: {
  restoreFocus: () => void
  project: {
    empty: () => boolean
    open: () => void
  }
  workspace: {
    enabled: () => boolean
    cycle: () => void
  }
  /** Opens the Compare Agents workspace for the draft's repository. */
  compare: () => void
  /** Opens the Improvement Lab for the draft's repository. */
  improve: () => void
  /** Opens the Stack-Agent runtime page. */
  runtime: () => void
}) {
  const command = useCommand()
  const dialog = useDialog()
  const language = useLanguage()

  useSettingsCommand()
  command.register("palette", () => [
    {
      id: "command.palette",
      title: language.t("command.palette"),
      hidden: true,
      onSelect: async () => {
        const { DialogCommandPalette } = await import("@/shell/commands/dialog")
        void dialog.show(() => <DialogCommandPalette />)
      },
    },
  ])
  command.register("new-session", () => [
    {
      id: "input.focus",
      title: language.t("command.input.focus"),
      category: language.t("command.category.view"),
      keybind: "ctrl+l",
      onSelect: input.restoreFocus,
    },
    {
      id: "session.location.cycle",
      title: language.t("command.session.location.cycle"),
      category: language.t("command.category.workspace"),
      keybind: "mod+alt+l",
      disabled: !input.workspace.enabled(),
      onSelect: input.workspace.cycle,
    },
    {
      id: "compare.open",
      title: language.t("compare.command"),
      description: language.t("compare.command.description"),
      category: language.t("command.category.workspace"),
      onSelect: input.compare,
    },
    {
      id: "improve.open",
      title: language.t("improve.command"),
      description: language.t("improve.command.description"),
      category: language.t("command.category.workspace"),
      onSelect: input.improve,
    },
    {
      id: "runtime.open",
      title: language.t("runtime.command"),
      description: language.t("runtime.command.description"),
      category: language.t("command.category.workspace"),
      onSelect: input.runtime,
    },
  ])
  // Shadows the titlebar's command of the same key while the draft is mounted, so it searches projects in place.
  command.register(projectSearchCommand.id, () => [
    {
      ...projectSearchCommand,
      title: language.t("session.new.project.search"),
      category: language.t("command.category.project"),
      disabled: input.project.empty(),
      onSelect: input.project.open,
    },
  ])
}
