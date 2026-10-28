import type {
  ComparisonActivity,
  ComparisonCategory,
  ComparisonHarness,
  ComparisonInfo,
  ComparisonRun,
} from "@opencode/client/promise"
import { Badge } from "@opencode/ui/badge"
import { Button } from "@opencode/ui/button"
import { Loader } from "@opencode/ui/loader"
import { Select } from "@opencode/ui/select"
import { TextInput } from "@opencode/ui/text-input"
import { A, useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { createEffect, createMemo, createResource, For, Index, onCleanup, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { useServer } from "@/runtime/server/current"
import { compareHref, improveHref, sessionHref } from "@/shell/routes/session"
import { formatServerError } from "@/runtime/server/errors"
import { formatMetric, HARNESSES, live, metricRows, runFor, settled } from "./model"

const CATEGORIES: readonly ComparisonCategory[] = [
  "implementation",
  "bug-fix",
  "investigation",
  "failure-recovery",
  "terminal-workflow",
]

// Live comparisons poll their server record; agents report through their own Sessions, so there is no push channel.
const POLL_MS = 2000

/** The Compare Agents workspace: a shared task editor, or one persisted comparison with both runs side by side. */
export function CompareScreen() {
  const params = useParams<{ id?: string }>()
  const [search] = useSearchParams<{ directory?: string }>()
  const sdk = useServerSDK()
  const language = useLanguage()

  const [history, { refetch: refetchHistory }] = createResource(() => sdk.api.comparison.list())
  const directory = () => search.directory ?? (history.state === "ready" ? history.latest?.[0]?.directory : undefined)

  return (
    <div
      data-component="compare-workspace"
      class="flex min-h-0 flex-1 flex-col overflow-y-auto bg-v2-background-bg-base px-4 py-4 text-v2-text-text-base sm:px-6"
      data-scrollable
    >
      <div class="mx-auto flex w-full max-w-[1600px] flex-col gap-4">
        <header class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex min-w-0 max-w-full flex-col">
            <h1 class="text-[18px] font-medium leading-[var(--line-height-base)]">{language.t("compare.title")}</h1>
            <Show when={directory()}>
              {(value) => (
                <code class="truncate text-[13px] leading-[var(--line-height-compact)] text-v2-text-text-muted">
                  {value()}
                </code>
              )}
            </Show>
          </div>
          <History
            items={history.state === "ready" ? (history.latest ?? []) : []}
            current={params.id}
            directory={directory()}
          />
        </header>
        <Show
          when={params.id}
          keyed
          fallback={<TaskEditor directory={directory()} onCreated={() => void refetchHistory()} />}
        >
          {(id) => <ComparisonView id={id} onChanged={() => void refetchHistory()} />}
        </Show>
      </div>
    </div>
  )
}

function History(props: {
  items: readonly { id: string; title: string; createdAt: number; directory: string }[]
  current?: string
  directory?: string
}) {
  const server = useServer()
  const language = useLanguage()
  const navigate = useNavigate()
  const options = () => props.items.map((item) => item.id)

  return (
    <div class="flex min-w-0 max-w-full flex-wrap items-center gap-2">
      <Show when={props.directory}>
        {(directory) => (
          <A
            class="text-[13px] text-v2-text-text-accent underline"
            href={improveHref(server.key, { directory: directory() })}
          >
            {language.t("improve.title")}
          </A>
        )}
      </Show>
      <Show when={props.current}>
        <Button
          variant="outline"
          size="small"
          onClick={() => navigate(compareHref(server.key, { directory: props.directory }))}
        >
          {language.t("compare.new")}
        </Button>
      </Show>
      <Show
        when={props.items.length > 0}
        fallback={<span class="text-[13px] text-v2-text-text-faint">{language.t("compare.history.empty")}</span>}
      >
        <Select
          data-action="compare-history"
          class="min-w-0 max-w-full"
          options={options()}
          current={props.current}
          placeholder={language.t("compare.history")}
          placement="bottom-end"
          gutter={6}
          label={(id) => {
            const item = props.items.find((entry) => entry.id === id)

            return item ? `${item.title} · ${new Date(item.createdAt).toLocaleString()}` : id
          }}
          onSelect={(id) => id && navigate(compareHref(server.key, { id }))}
        />
      </Show>
    </div>
  )
}

function TaskEditor(props: { directory?: string; onCreated: () => void }) {
  const sdk = useServerSDK()
  const server = useServer()
  const language = useLanguage()
  const navigate = useNavigate()

  const [store, setStore] = createStore<{
    title: string
    prompt: string
    category: ComparisonCategory
    criteria: { description: string; command: string }[]
    submitting: boolean
    error?: string
  }>({
    title: "",
    prompt: "",
    category: "implementation",
    criteria: [{ description: "", command: "" }],
    submitting: false,
  })

  const start = async () => {
    const directory = props.directory

    if (!directory || !store.prompt.trim()) return
    setStore({ submitting: true, error: undefined })

    const created = await sdk.api.comparison
      .create({
        directory,
        task: {
          title: store.title.trim() || store.prompt.trim().slice(0, 60),
          prompt: store.prompt,
          category: store.category,
          criteria: store.criteria.map((item, index) => ({
            id: `criterion-${index + 1}`,
            description: item.description,
            command: item.command.trim() || undefined,
          })),
        },
      })
      .catch((cause: unknown) => {
        setStore({ submitting: false, error: formatServerError(cause, language.t, language.t("common.requestFailed")) })

        return undefined
      })

    if (!created) return
    props.onCreated()
    navigate(compareHref(server.key, { id: created.definition.id }))
  }

  return (
    <Show
      when={props.directory}
      fallback={<p class="text-[13px] text-v2-text-text-muted">{language.t("compare.directory.missing")}</p>}
    >
      <form
        data-component="compare-task-editor"
        class="flex max-w-[880px] flex-col gap-4 rounded-lg border border-v2-border-border-base bg-v2-background-bg-deep p-4"
        onSubmit={(event) => {
          event.preventDefault()
          void start()
        }}
      >
        <div class="grid gap-3 sm:grid-cols-[1fr_auto]">
          <Field label={language.t("compare.task.title")}>
            <TextInput
              value={store.title}
              placeholder={language.t("compare.task.title.placeholder")}
              onInput={(event) => setStore("title", event.currentTarget.value)}
            />
          </Field>
          <Field label={language.t("compare.task.category")}>
            <Select
              data-action="compare-category"
              options={[...CATEGORIES]}
              current={store.category}
              gutter={6}
              label={(category) => language.t(`compare.category.${category}`)}
              onSelect={(category) => category && setStore("category", category)}
            />
          </Field>
        </div>
        <Field label={language.t("compare.task.prompt")}>
          <textarea
            class="min-h-32 w-full resize-y rounded-md border border-v2-border-border-base bg-v2-background-bg-base p-2 text-[13px] leading-[var(--line-height-base)]"
            value={store.prompt}
            placeholder={language.t("compare.task.prompt.placeholder")}
            onInput={(event) => setStore("prompt", event.currentTarget.value)}
          />
        </Field>
        <div class="flex flex-col gap-2">
          <div class="flex flex-col">
            <span class="text-[13px] font-medium">{language.t("compare.criteria")}</span>
            <span class="text-[12px] leading-[var(--line-height-compact)] text-v2-text-text-muted">
              {language.t("compare.criteria.hint")}
            </span>
          </div>
          <Index each={store.criteria}>
            {(item, index) => (
              <div class="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <TextInput
                  aria-label={language.t("compare.criteria.description")}
                  placeholder={language.t("compare.criteria.description")}
                  value={item().description}
                  onInput={(event) => setStore("criteria", index, "description", event.currentTarget.value)}
                />
                <TextInput
                  class="font-mono"
                  aria-label={language.t("compare.criteria.command")}
                  placeholder={language.t("compare.criteria.command")}
                  value={item().command}
                  onInput={(event) => setStore("criteria", index, "command", event.currentTarget.value)}
                />
                <Button
                  type="button"
                  variant="ghost-muted"
                  size="small"
                  aria-label={language.t("compare.criteria.remove")}
                  disabled={store.criteria.length === 1}
                  onClick={() => setStore("criteria", (list) => list.filter((_, position) => position !== index))}
                >
                  {language.t("compare.criteria.remove")}
                </Button>
              </div>
            )}
          </Index>
          <div>
            <Button
              type="button"
              variant="ghost"
              size="small"
              onClick={() => setStore("criteria", (list) => [...list, { description: "", command: "" }])}
            >
              {language.t("compare.criteria.add")}
            </Button>
          </div>
        </div>
        <p class="text-[12px] leading-[var(--line-height-compact)] text-v2-text-text-muted">
          {language.t("compare.isolation")}
        </p>
        <Show when={store.error}>{(error) => <p class="text-[13px] text-v2-state-fg-danger">{error()}</p>}</Show>
        <div>
          <Button type="submit" variant="submit" disabled={store.submitting || !store.prompt.trim()}>
            {store.submitting ? language.t("compare.starting") : language.t("compare.start")}
          </Button>
        </div>
      </form>
    </Show>
  )
}

function ComparisonView(props: { id: string; onChanged: () => void }) {
  const sdk = useServerSDK()
  const server = useServer()
  const navigate = useNavigate()

  const [info, { refetch, mutate }] = createResource(
    () => props.id,
    (comparisonID) => sdk.api.comparison.get({ comparisonID }),
  )

  // Show what we already have while a poll refreshes; only the first load waits.
  const current = () => (info.state === "ready" || info.state === "refreshing" ? info.latest : undefined)

  createEffect(() => {
    if (!live(current())) return
    const timer = setInterval(() => void refetch(), POLL_MS)
    onCleanup(() => clearInterval(timer))
  })

  const cancel = async (harness?: ComparisonHarness) =>
    mutate(await sdk.api.comparison.cancel({ comparisonID: props.id, harness }))

  const rerun = async () => {
    const next = await sdk.api.comparison.rerun({ comparisonID: props.id })
    props.onChanged()
    navigate(compareHref(server.key, { id: next.definition.id }))
  }

  return (
    <Show when={current()} fallback={<Loader class="size-4 text-v2-icon-icon-muted" />}>
      {(value) => (
        <div class="flex flex-col gap-4">
          <Summary info={value()} onCancel={() => void cancel()} onRerun={() => void rerun()} />
          <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <For each={HARNESSES}>
              {(harness) => (
                <Show when={runFor(value(), harness)}>
                  {(run) => <RunPane run={run()} info={value()} onCancel={() => void cancel(harness)} />}
                </Show>
              )}
            </For>
          </div>
          <Report info={value()} />
        </div>
      )}
    </Show>
  )
}

function Summary(props: { info: ComparisonInfo; onCancel: () => void; onRerun: () => void }) {
  const language = useLanguage()
  const definition = () => props.info.definition

  return (
    <section class="flex flex-col gap-2 rounded-lg border border-v2-border-border-base bg-v2-background-bg-deep p-4">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="flex min-w-0 flex-col gap-1">
          <div class="flex flex-wrap items-center gap-2">
            <h2 class="text-[15px] font-medium">{definition().task.title}</h2>
            <Badge>{language.t(`compare.category.${definition().task.category}`)}</Badge>
          </div>
          <code class="text-[12px] text-v2-text-text-muted">
            {language.t("compare.revision", { revision: definition().repository.revision.slice(0, 12) })}
            {definition().repository.branch ? ` · ${definition().repository.branch}` : ""}
          </code>
        </div>
        <div class="flex gap-2">
          <Show when={live(props.info)}>
            <Button variant="ghost-danger" size="small" onClick={props.onCancel}>
              {language.t("compare.cancelAll")}
            </Button>
          </Show>
          <Button variant="outline" size="small" onClick={props.onRerun}>
            {language.t("compare.rerun")}
          </Button>
        </div>
      </div>
      <p class="whitespace-pre-wrap text-[13px] leading-[var(--line-height-base)]">{definition().task.prompt}</p>
      <Show when={definition().repository.dirty}>
        <p class="text-[12px] text-v2-text-text-muted">{language.t("compare.dirty")}</p>
      </Show>
      <Show
        when={props.info.qualifications.length > 0}
        fallback={<p class="text-[12px] text-v2-state-fg-success">{language.t("compare.controlled")}</p>}
      >
        <div class="flex flex-col gap-1 text-[12px] text-v2-state-fg-warning">
          <span class="font-medium">{language.t("compare.qualified")}</span>
          <ul class="list-disc ps-5">
            <For each={props.info.qualifications}>{(item) => <li>{item}</li>}</For>
          </ul>
        </div>
      </Show>
    </section>
  )
}

function RunPane(props: { run: ComparisonRun; info: ComparisonInfo; onCancel: () => void }) {
  const server = useServer()
  const language = useLanguage()
  const activity = () => props.run.observation?.activity ?? []
  const terminal = createMemo(() => activity().filter((item) => item.kind.startsWith("terminal")))
  const criteria = () => props.run.report?.criteria

  return (
    <section
      data-component="compare-run"
      data-harness={props.run.harness}
      class="flex min-w-0 flex-col gap-3 rounded-lg border border-v2-border-border-base p-4"
    >
      <header class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex min-w-0 items-center gap-2">
          <Show when={!settled(props.run)}>
            <Loader class="size-4 text-v2-icon-icon-muted" />
          </Show>
          <h3 class="text-[15px] font-medium">{language.t(`compare.harness.${props.run.harness}`)}</h3>
          <Badge variant="subtle">{language.t(`compare.status.${props.run.status}`)}</Badge>
          <Show when={props.run.report?.outcome}>{(outcome) => <Outcome value={outcome()} />}</Show>
        </div>
        <div class="flex gap-2">
          <Show when={props.run.sessionID}>
            {(sessionID) => (
              <A class="text-[13px] text-v2-text-text-accent underline" href={sessionHref(server.key, sessionID())}>
                {language.t("compare.openSession")}
              </A>
            )}
          </Show>
          <Show when={props.run.status === "preparing" || props.run.status === "running"}>
            <Button variant="ghost-danger" size="small" onClick={props.onCancel}>
              {language.t("compare.cancel")}
            </Button>
          </Show>
        </div>
      </header>
      <Show when={props.run.directory}>
        {(directory) => <code class="truncate text-[12px] text-v2-text-text-faint">{directory()}</code>}
      </Show>
      <Show when={props.run.error}>{(error) => <p class="text-[13px] text-v2-state-fg-danger">{error()}</p>}</Show>
      <Show when={props.run.report}>
        {(report) => <p class="text-[13px] text-v2-text-text-muted">{report().reason}</p>}
      </Show>

      <Section title={language.t("compare.section.criteria")}>
        <Show when={criteria()} fallback={<Empty text={language.t("compare.criteria.pending")} />}>
          {(items) => (
            <ul class="flex flex-col gap-2">
              <For each={items()}>
                {(item) => (
                  <li class="flex flex-col gap-1 rounded-md bg-v2-background-bg-deep p-2">
                    <div class="flex flex-wrap items-center gap-2 text-[13px]">
                      <CriterionMark status={item.status} />
                      <span class="min-w-0 flex-1">{item.description}</span>
                      <Show when={item.regression}>
                        <span class="text-[12px] text-v2-state-fg-danger">
                          {language.t("compare.criterion.regression")}
                        </span>
                      </Show>
                    </div>
                    <Show when={item.baseline}>
                      {(baseline) => (
                        <span class="text-[12px] text-v2-text-text-faint">
                          {language.t("compare.criterion.baseline", {
                            status: language.t(`compare.criterion.${baseline()}`),
                          })}
                        </span>
                      )}
                    </Show>
                    <For each={item.evidence}>
                      {(evidence) => (
                        <details class="text-[12px]">
                          <summary class="cursor-pointer text-v2-text-text-muted">
                            <Show when={evidence.command} fallback={evidence.label}>
                              <code>
                                $ {evidence.command} → {evidence.exitCode}
                              </code>
                            </Show>
                          </summary>
                          <p class="text-v2-text-text-faint">{evidence.label}</p>
                          <Show when={evidence.output}>
                            <pre
                              class="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-v2-background-bg-base p-2 font-mono"
                              data-scrollable
                            >
                              {evidence.output}
                            </pre>
                          </Show>
                        </details>
                      )}
                    </For>
                  </li>
                )}
              </For>
            </ul>
          )}
        </Show>
      </Section>

      <Section title={language.t("compare.section.activity")}>
        <ActivityList items={activity()} empty={language.t("compare.activity.empty")} />
      </Section>

      <Section title={language.t("compare.section.terminal")}>
        <ActivityList items={terminal()} empty={language.t("compare.terminal.empty")} />
      </Section>

      <Section title={language.t("compare.section.changes")}>
        <Show
          when={(props.run.report?.changes.length ?? 0) > 0}
          fallback={
            <Empty text={language.t(props.run.report ? "compare.changes.empty" : "compare.criteria.pending")} />
          }
        >
          <ul class="flex flex-col font-mono text-[12px]">
            <For each={props.run.report?.changes}>
              {(change) => (
                <li class="flex gap-2">
                  <span class="w-20 shrink-0 text-v2-text-text-faint">{change.status}</span>
                  <span class="min-w-0 flex-1 truncate">{change.path}</span>
                  <span class="text-v2-state-fg-success">
                    {change.additions === undefined ? "" : `+${change.additions}`}
                  </span>
                  <span class="text-v2-state-fg-danger">
                    {change.deletions === undefined ? "" : `-${change.deletions}`}
                  </span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Section>

      <Show when={props.run.observation?.claim}>
        {(claim) => (
          <Section title={language.t("compare.section.claim")}>
            <p class="max-h-40 overflow-y-auto whitespace-pre-wrap text-[12px] text-v2-text-text-muted" data-scrollable>
              {claim()}
            </p>
          </Section>
        )}
      </Show>

      <Section title={language.t("compare.section.environment")}>
        <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
          <For each={props.run.environment}>
            {(fact) => (
              <>
                <dt class="text-v2-text-text-muted" title={fact.source}>
                  {fact.key}
                </dt>
                <dd class="min-w-0 truncate font-mono" title={fact.source}>
                  {fact.value ?? language.t("compare.unavailable")}
                </dd>
              </>
            )}
          </For>
        </dl>
      </Section>
    </section>
  )
}

function Report(props: { info: ComparisonInfo }) {
  const language = useLanguage()
  const rows = createMemo(() => metricRows(props.info))

  return (
    <section class="flex flex-col gap-3 rounded-lg border border-v2-border-border-base p-4">
      <div class="flex flex-col">
        <h2 class="text-[15px] font-medium">{language.t("compare.section.report")}</h2>
        <span class="text-[12px] text-v2-text-text-muted">{language.t("compare.report.correctnessFirst")}</span>
      </div>
      <div class="overflow-x-auto" data-scrollable>
        <table class="w-full min-w-[640px] text-left text-[13px]">
          <thead class="text-[12px] text-v2-text-text-muted">
            <tr>
              <th class="py-1 pe-3 font-medium">{language.t("compare.metric.column")}</th>
              <For each={HARNESSES}>
                {(harness) => <th class="py-1 pe-3 font-medium">{language.t(`compare.harness.${harness}`)}</th>}
              </For>
              <th class="py-1 font-medium">{language.t("compare.metric.source")}</th>
            </tr>
          </thead>
          <tbody>
            <tr class="border-t border-v2-border-border-muted">
              <td class="py-1 pe-3">{language.t("compare.section.criteria")}</td>
              <For each={HARNESSES}>
                {(harness) => (
                  <td class="py-1 pe-3">
                    <Show when={runFor(props.info, harness)?.report?.outcome} fallback="—">
                      {(outcome) => <Outcome value={outcome()} />}
                    </Show>
                  </td>
                )}
              </For>
              <td class="py-1 text-[12px] text-v2-text-text-faint" />
            </tr>
            <For each={rows()}>
              {(row) => (
                <tr class="border-t border-v2-border-border-muted">
                  <td class="py-1 pe-3">{row.label}</td>
                  <For each={row.values}>
                    {(metric) => (
                      <td class="py-1 pe-3 tabular-nums">
                        <Show
                          when={formatMetric(metric)}
                          fallback={
                            <span class="text-v2-text-text-faint" title={metric?.method}>
                              {language.t("compare.unavailable")}
                            </span>
                          }
                        >
                          {(value) => (
                            <span title={metric?.method}>
                              {value()}
                              <Show when={metric?.kind === "inferred"}>
                                <span class="ms-1 text-[11px] text-v2-text-text-faint">
                                  {language.t("compare.metric.inferred")}
                                </span>
                              </Show>
                            </span>
                          )}
                        </Show>
                      </td>
                    )}
                  </For>
                  <td class="py-1 text-[12px] text-v2-text-text-faint">
                    {row.values.find((metric) => metric?.available)?.source ?? row.values[0]?.method}
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <div class="flex flex-col gap-1 text-[12px]">
        <span class="font-medium">{language.t("compare.section.trials")}</span>
        <For each={props.info.trials}>
          {(trial) => (
            <span class="text-v2-text-text-muted">
              {language.t(`compare.harness.${trial.harness}`)}: {language.plural("compare.trials.runs", trial.runs)}
              <For each={trial.outcomes}>
                {(item) => ` · ${language.t(`compare.outcome.${item.outcome}`)} ${item.count}`}
              </For>
            </span>
          )}
        </For>
        <Show when={props.info.trials.every((trial) => trial.runs <= 1)}>
          <span class="text-v2-text-text-faint">{language.t("compare.trials.single")}</span>
        </Show>
      </div>
    </section>
  )
}

function ActivityList(props: { items: readonly ComparisonActivity[]; empty: string }) {
  return (
    <Show when={props.items.length > 0} fallback={<Empty text={props.empty} />}>
      <ol class="flex max-h-56 flex-col gap-0.5 overflow-y-auto font-mono text-[12px]" data-scrollable>
        <For each={props.items}>
          {(item) => (
            <li class="flex gap-2" title={`${item.messageID}${item.toolCallID ? ` · ${item.toolCallID}` : ""}`}>
              <span class="shrink-0 text-v2-text-text-faint">{new Date(item.at).toLocaleTimeString()}</span>
              <span
                classList={{
                  "text-v2-state-fg-danger": item.kind.endsWith("failed"),
                  "text-v2-text-text-muted": item.kind === "step",
                }}
              >
                {item.label}
              </span>
              <Show when={item.detail}>
                <span class="min-w-0 truncate text-v2-text-text-faint">{item.detail}</span>
              </Show>
            </li>
          )}
        </For>
      </ol>
    </Show>
  )
}

function Outcome(props: { value: NonNullable<ComparisonRun["report"]>["outcome"] }) {
  const language = useLanguage()

  return (
    <span
      class="text-[13px] font-medium"
      classList={{
        "text-v2-state-fg-success": props.value === "verified-success",
        "text-v2-state-fg-warning": props.value === "partial" || props.value === "unverified",
        "text-v2-state-fg-danger": props.value === "failed",
        "text-v2-text-text-muted": props.value === "cancelled",
      }}
    >
      {language.t(`compare.outcome.${props.value}`)}
    </span>
  )
}

function CriterionMark(props: { status: "passed" | "failed" | "unverified" | "not-run" }) {
  const language = useLanguage()

  return (
    <span
      class="w-24 shrink-0 text-[12px] font-medium"
      classList={{
        "text-v2-state-fg-success": props.status === "passed",
        "text-v2-state-fg-danger": props.status === "failed",
        "text-v2-state-fg-warning": props.status === "unverified",
        "text-v2-text-text-faint": props.status === "not-run",
      }}
    >
      {language.t(`compare.criterion.${props.status}`)}
    </span>
  )
}

function Section(props: { title: string; children: JSX.Element }) {
  return (
    <div class="flex flex-col gap-1.5">
      <h4 class="text-[12px] font-medium uppercase tracking-wide text-v2-text-text-muted">{props.title}</h4>
      {props.children}
    </div>
  )
}

function Field(props: { label: string; children: JSX.Element }) {
  return (
    <label class="flex flex-col gap-1">
      <span class="text-[13px] font-medium">{props.label}</span>
      {props.children}
    </label>
  )
}

function Empty(props: { text: string }) {
  return <p class="text-[12px] text-v2-text-text-faint">{props.text}</p>
}
