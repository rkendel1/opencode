import type {
  StackAgentRuntimeGeneration,
  StackAgentRuntimeResolved,
  StackAgentRuntimeStatus,
} from "@opencode/client/promise"
import { Badge } from "@opencode/ui/badge"
import { Button } from "@opencode/ui/button"
import { Loader } from "@opencode/ui/loader"
import { TextInput } from "@opencode/ui/text-input"
import { A } from "@solidjs/router"
import { createEffect, createResource, For, onCleanup, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { useServer } from "@/runtime/server/current"
import { formatServerError } from "@/runtime/server/errors"
import { improveHref, sessionHref } from "@/shell/routes/session"

// The runtime manager works in the background; the page refreshes its status while it is open.
const POLL_MS = 2000

/** Stack-Agent versions: what new tasks use, what is building, what is running, and how to switch or roll back. */
export function StackAgentRuntimeScreen() {
  const sdk = useServerSDK()
  const language = useLanguage()
  const [status, { refetch }] = createResource(() => sdk.api.stackAgent.status())
  const current = () => (status.state === "ready" || status.state === "refreshing" ? status.latest : undefined)
  const [store, setStore] = createStore<{ error?: string; busy: boolean }>({ busy: false })

  createEffect(() => {
    const timer = setInterval(() => void refetch(), POLL_MS)
    onCleanup(() => clearInterval(timer))
  })

  const act = async (run: () => Promise<object>) => {
    setStore({ busy: true, error: undefined })

    const result = await run().catch((cause: unknown) => {
      setStore("error", formatServerError(cause, language.t, language.t("common.requestFailed")))

      return undefined
    })

    setStore("busy", false)

    if (result !== undefined) void refetch()
  }

  return (
    <div
      data-component="stack-agent-runtime"
      class="flex min-h-0 flex-1 flex-col overflow-y-auto bg-v2-background-bg-base px-4 py-4 text-v2-text-text-base sm:px-6"
      data-scrollable
    >
      <div class="mx-auto flex w-full max-w-[1100px] flex-col gap-4">
        <h1 class="text-[18px] font-medium leading-[var(--line-height-base)]">{language.t("runtime.title")}</h1>
        <Show when={store.error}>{(error) => <p class="text-[13px] text-v2-state-fg-danger">{error()}</p>}</Show>
        <Show when={current()} fallback={<Loader class="size-4 text-v2-icon-icon-muted" />}>
          {(value) => (
            <>
              <Overview status={value()} busy={store.busy} act={act} />
              <Settings status={value()} act={act} />
              <Running status={value()} />
              <Generations status={value()} busy={store.busy} act={act} />
              <Events status={value()} />
            </>
          )}
        </Show>
      </div>
    </div>
  )
}

type Act = (run: () => Promise<object>) => Promise<void>

function Overview(props: { status: StackAgentRuntimeStatus; busy: boolean; act: Act }) {
  const sdk = useServerSDK()
  const language = useLanguage()
  const [store, setStore] = createStore({ revision: "", fetch: false })
  const active = () => props.status.generations.find((item) => item.id === props.status.state.active)
  const previous = () => props.status.state.previous[0]
  const check = () => props.status.state.lastCheck

  return (
    <Card title={language.t("runtime.current")}>
      <Show when={!props.status.settings.sourceDirectory}>
        <p class="text-[13px] text-v2-state-fg-warning">{language.t("runtime.unconfigured")}</p>
      </Show>
      <ResolvedLine resolved={props.status.current} />
      <Show when={props.status.current.executable}>
        {(executable) => <code class="truncate text-[12px] text-v2-text-text-faint">{executable()}</code>}
      </Show>
      <p class="text-[12px] text-v2-text-text-muted">
        {previous() ? language.t("runtime.previous", { generation: previous()! }) : language.t("runtime.previous.none")}
      </p>
      <Show
        when={check()}
        fallback={<p class="text-[12px] text-v2-text-text-faint">{language.t("runtime.tip.unknown")}</p>}
      >
        {(value) => (
          <p class="flex flex-wrap items-center gap-2 text-[12px]">
            <span>{language.t("runtime.tip", { branch: value().branch, tip: value().tip?.slice(0, 12) ?? "—" })}</span>
            <Show when={value().tip}>
              <Badge variant={value().tip === active()?.commit ? "subtle" : "accent"}>
                {language.t(value().tip === active()?.commit ? "runtime.tip.same" : "runtime.tip.differs")}
              </Badge>
            </Show>
            <Show when={value().error}>{(error) => <span class="text-v2-state-fg-danger">{error()}</span>}</Show>
          </p>
        )}
      </Show>
      <Show when={props.status.state.operation}>
        {(operation) => (
          <p class="flex items-center gap-2 text-[13px]">
            <Loader class="size-4 text-v2-icon-icon-muted" />
            {language.t("runtime.operation", { generation: operation().generation })}
          </p>
        )}
      </Show>
      <div class="flex flex-wrap items-end gap-2">
        <Button
          variant="outline"
          size="small"
          disabled={props.busy || !props.status.settings.sourceDirectory}
          onClick={() => void props.act(() => sdk.api.stackAgent.check({ fetch: store.fetch }))}
        >
          {language.t("runtime.check")}
        </Button>
        <Show when={props.status.settings.remote}>
          <label class="flex items-center gap-1 text-[12px] text-v2-text-text-muted">
            <input
              type="checkbox"
              checked={store.fetch}
              onChange={(event) => setStore("fetch", event.currentTarget.checked)}
            />
            {language.t("runtime.check.fetch")}
          </label>
        </Show>
        <div class="w-56">
          <TextInput
            aria-label={language.t("runtime.build.revision")}
            placeholder={props.status.settings.branch}
            value={store.revision}
            onInput={(event) => setStore("revision", event.currentTarget.value)}
          />
        </div>
        <Button
          variant="submit"
          size="small"
          disabled={props.busy || !props.status.settings.sourceDirectory || !!props.status.state.operation}
          onClick={() =>
            void props.act(() => sdk.api.stackAgent.build({ revision: store.revision.trim() || undefined }))
          }
        >
          {language.t("runtime.build")}
        </Button>
        <Button
          variant="ghost-danger"
          size="small"
          disabled={props.busy || !previous()}
          onClick={() => void props.act(() => sdk.api.stackAgent.rollback())}
        >
          {language.t("runtime.rollback")}
        </Button>
      </div>
      <p class="text-[12px] text-v2-text-text-faint">{language.t("runtime.activate.note")}</p>
    </Card>
  )
}

function ResolvedLine(props: { resolved: StackAgentRuntimeResolved }) {
  const language = useLanguage()

  return (
    <p class="flex flex-wrap items-center gap-2 text-[14px]">
      <span class="font-medium">
        {props.resolved.generation
          ? language.t("runtime.current.active", { generation: props.resolved.generation })
          : language.t("runtime.current.external")}
      </span>
      <Show when={props.resolved.version}>{(version) => <Badge>{version()}</Badge>}</Show>
      <Show when={props.resolved.commit}>
        {(commit) => <code class="text-[12px] text-v2-text-text-muted">{commit().slice(0, 12)}</code>}
      </Show>
    </p>
  )
}

function Settings(props: { status: StackAgentRuntimeStatus; act: Act }) {
  const sdk = useServerSDK()
  const language = useLanguage()

  const [store, setStore] = createStore({
    sourceDirectory: props.status.settings.sourceDirectory ?? "",
    branch: props.status.settings.branch,
    remote: props.status.settings.remote ?? "",
  })

  return (
    <Card title={language.t("runtime.settings")}>
      <div class="grid gap-2 sm:grid-cols-[2fr_1fr_1fr]">
        <Field label={language.t("runtime.settings.directory")}>
          <TextInput
            placeholder={language.t("runtime.settings.directory.placeholder")}
            value={store.sourceDirectory}
            onInput={(event) => setStore("sourceDirectory", event.currentTarget.value)}
          />
        </Field>
        <Field label={language.t("runtime.settings.branch")}>
          <TextInput value={store.branch} onInput={(event) => setStore("branch", event.currentTarget.value)} />
        </Field>
        <Field label={language.t("runtime.settings.remote")}>
          <TextInput value={store.remote} onInput={(event) => setStore("remote", event.currentTarget.value)} />
        </Field>
      </div>
      <p class="text-[12px] text-v2-text-text-muted">
        {language.t("runtime.settings.build")}: <code>{props.status.settings.buildCommand.join(" ")}</code>
      </p>
      <div>
        <Button
          variant="outline"
          size="small"
          onClick={() =>
            void props.act(() =>
              sdk.api.stackAgent.configure({
                sourceDirectory: store.sourceDirectory.trim() || undefined,
                branch: store.branch.trim() || undefined,
                remote: store.remote.trim() || undefined,
              }),
            )
          }
        >
          {language.t("runtime.settings.save")}
        </Button>
      </div>
    </Card>
  )
}

function Running(props: { status: StackAgentRuntimeStatus }) {
  const server = useServer()
  const language = useLanguage()

  return (
    <Card title={language.t("runtime.running")}>
      <Show
        when={props.status.running.length > 0}
        fallback={<p class="text-[12px] text-v2-text-text-faint">{language.t("runtime.running.empty")}</p>}
      >
        <ul class="flex flex-col gap-1 text-[13px]">
          <For each={props.status.running}>
            {(item) => (
              <li class="flex flex-wrap items-center gap-2">
                <A class="text-v2-text-text-accent underline" href={sessionHref(server.key, item.sessionID)}>
                  {item.sessionID}
                </A>
                <code class="text-[12px]">{item.resolved.generation ?? "unmanaged"}</code>
                <Show when={item.resolved.generation !== props.status.current.generation}>
                  <Badge variant="subtle">{language.t("runtime.running.older")}</Badge>
                </Show>
                <span class="text-[12px] text-v2-text-text-faint">{new Date(item.startedAt).toLocaleTimeString()}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </Card>
  )
}

function Generations(props: { status: StackAgentRuntimeStatus; busy: boolean; act: Act }) {
  const language = useLanguage()

  return (
    <Card title={language.t("runtime.generations")}>
      <ul class="flex flex-col gap-2">
        <For each={props.status.generations}>
          {(item) => <GenerationRow item={item} status={props.status} busy={props.busy} act={props.act} />}
        </For>
      </ul>
    </Card>
  )
}

function GenerationRow(props: {
  item: StackAgentRuntimeGeneration
  status: StackAgentRuntimeStatus
  busy: boolean
  act: Act
}) {
  const sdk = useServerSDK()
  const server = useServer()
  const language = useLanguage()
  const active = () => props.status.state.active === props.item.id

  return (
    <li
      class="flex flex-col gap-1 rounded-md bg-v2-background-bg-deep p-3 text-[13px]"
      data-component="stack-agent-generation"
    >
      <div class="flex flex-wrap items-center gap-2">
        <code class="font-medium">{props.item.id}</code>
        <Badge variant={props.item.status === "validated" ? "accent" : "subtle"}>
          {language.t(`runtime.generation.status.${props.item.status}`)}
        </Badge>
        <Show when={active()}>
          <Badge variant="accent">{language.t("runtime.generation.active")}</Badge>
        </Show>
        <Show when={props.item.version}>{(version) => <span>{version()}</span>}</Show>
        <code class="text-[12px] text-v2-text-text-muted">{props.item.commit.slice(0, 12)}</code>
        <span class="text-[12px] text-v2-text-text-faint">{new Date(props.item.createdAt).toLocaleString()}</span>
        <Show when={props.item.status === "validated" && !active()}>
          <Button
            class="ms-auto"
            variant="submit"
            size="small"
            disabled={props.busy}
            onClick={() => void props.act(() => sdk.api.stackAgent.activate({ generation: props.item.id }))}
          >
            {language.t("runtime.activate")}
          </Button>
        </Show>
      </div>
      <Show when={props.item.origin}>
        {(origin) => (
          <A
            class="text-[12px] text-v2-text-text-accent underline"
            href={improveHref(server.key, { id: origin().improvementID })}
          >
            {language.t("runtime.generation.origin", { id: origin().improvementID, purpose: origin().purpose })}
          </A>
        )}
      </Show>
      <Show when={props.item.error}>{(error) => <p class="text-[12px] text-v2-state-fg-danger">{error()}</p>}</Show>
      <Show when={props.item.smoke.length > 0}>
        <details class="text-[12px]">
          <summary class="cursor-pointer text-v2-text-text-muted">{language.t("runtime.generation.smoke")}</summary>
          <For each={props.item.smoke}>
            {(check) => (
              <div>
                <code
                  classList={{
                    "text-v2-state-fg-success": check.exitCode === 0,
                    "text-v2-state-fg-danger": check.exitCode !== 0,
                  }}
                >
                  $ {check.command} → {check.exitCode}
                </code>
                <pre
                  class="max-h-32 overflow-auto whitespace-pre-wrap font-mono text-v2-text-text-faint"
                  data-scrollable
                >
                  {check.output}
                </pre>
              </div>
            )}
          </For>
        </details>
      </Show>
      <Show when={props.item.build}>
        {(build) => (
          <details class="text-[12px]">
            <summary class="cursor-pointer text-v2-text-text-muted">
              {language.t("runtime.generation.build")} ·{" "}
              <code>
                $ {build().command} → {build().exitCode}
              </code>
            </summary>
            <pre class="max-h-48 overflow-auto whitespace-pre-wrap font-mono text-v2-text-text-faint" data-scrollable>
              {build().output}
            </pre>
          </details>
        )}
      </Show>
    </li>
  )
}

function Events(props: { status: StackAgentRuntimeStatus }) {
  const language = useLanguage()

  return (
    <Card title={language.t("runtime.events")}>
      <ul class="flex flex-col gap-0.5 text-[12px]">
        <For each={props.status.state.events}>
          {(item) => (
            <li class="flex flex-wrap gap-2">
              <span class="text-v2-text-text-faint">{new Date(item.at).toLocaleString()}</span>
              <span
                classList={{
                  "text-v2-state-fg-danger": item.kind.endsWith("failed") || item.kind === "interrupted",
                  "text-v2-state-fg-success": item.kind === "activated" || item.kind === "built",
                }}
              >
                {item.kind}
              </span>
              <span>{item.message}</span>
            </li>
          )}
        </For>
      </ul>
    </Card>
  )
}

function Card(props: { title: string; children: JSX.Element }) {
  return (
    <section class="flex flex-col gap-2 rounded-lg border border-v2-border-border-base p-4">
      <h2 class="text-[15px] font-medium">{props.title}</h2>
      {props.children}
    </section>
  )
}

function Field(props: { label: string; children: JSX.Element }) {
  return (
    <label class="flex flex-col gap-1">
      <span class="text-[12px] text-v2-text-text-muted">{props.label}</span>
      {props.children}
    </label>
  )
}
