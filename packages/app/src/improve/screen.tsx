import type {
  ComparisonHarness,
  ImprovementAnalysis,
  ImprovementDecision,
  ImprovementFinding,
  ImprovementInfo,
  ImprovementInvestigation,
  ImprovementProposal,
  ImprovementTarget,
} from "@opencode/client/promise"
import { Badge } from "@opencode/ui/badge"
import { Button } from "@opencode/ui/button"
import { Loader } from "@opencode/ui/loader"
import { Select } from "@opencode/ui/select"
import { A, useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { createEffect, createResource, For, onCleanup, Show, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { useServer } from "@/runtime/server/current"
import { formatServerError } from "@/runtime/server/errors"
import { compareHref, improveHref, runtimeHref, sessionHref } from "@/shell/routes/session"
import { ProjectPicker } from "@/compare/project-picker"
import { lifecycle, live, validated } from "./model"

// The pipeline runs on the server; the page polls its record while a stage is in progress.
const POLL_MS = 2000

const RUNTIMES: ComparisonHarness[] = ["opencode", "stack-agent"]

const TARGETS: ImprovementTarget[] = ["project", "stack-agent"]

const DECISIONS: ImprovementDecision[] = ["accept", "reject", "inconclusive"]

const DECISION_VARIANTS: Record<ImprovementDecision, "submit" | "ghost-danger" | "outline"> = {
  accept: "submit",
  reject: "ghost-danger",
  inconclusive: "outline",
}

/** The Improvement Lab: ML findings for a project, or one improvement's full lifecycle. */
export function ImproveScreen() {
  const params = useParams<{ id?: string }>()
  const [search] = useSearchParams<{ directory?: string }>()
  const sdk = useServerSDK()
  const server = useServer()
  const language = useLanguage()
  const navigate = useNavigate()
  const [history, { refetch }] = createResource(() => sdk.api.improvement.list())
  const items = () => (history.state === "ready" || history.state === "refreshing" ? (history.latest ?? []) : [])

  return (
    <div
      data-component="improvement-lab"
      class="flex min-h-0 flex-1 flex-col overflow-y-auto bg-v2-background-bg-base px-4 py-4 text-v2-text-text-base sm:px-6"
      data-scrollable
    >
      <div class="mx-auto flex w-full max-w-[1200px] flex-col gap-4">
        <header class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex min-w-0 max-w-full flex-col">
            <h1 class="text-[18px] font-medium leading-[var(--line-height-base)]">{language.t("improve.title")}</h1>
            <Show when={search.directory}>
              {(directory) => (
                <code class="truncate text-[13px] leading-[var(--line-height-compact)] text-v2-text-text-muted">
                  {directory()}
                </code>
              )}
            </Show>
          </div>
          <div class="flex min-w-0 max-w-full flex-wrap items-center gap-2">
            <Show when={params.id}>
              <Button
                variant="outline"
                size="small"
                onClick={() => navigate(improveHref(server.key, { directory: search.directory }))}
              >
                {language.t("improve.findings")}
              </Button>
            </Show>
            <Show when={search.directory}>
              {(directory) => (
                <A
                  class="text-[13px] text-v2-text-text-accent underline"
                  href={compareHref(server.key, { directory: directory() })}
                >
                  {language.t("compare.title")}
                </A>
              )}
            </Show>
            <A class="text-[13px] text-v2-text-text-accent underline" href={runtimeHref(server.key)}>
              {language.t("runtime.title")}
            </A>
            <Show when={items().length > 0}>
              <Select
                data-action="improvement-history"
                class="min-w-0 max-w-full"
                options={items().map((item) => item.id)}
                current={params.id}
                placeholder={language.t("improve.history")}
                placement="bottom-end"
                gutter={6}
                label={(id) => {
                  const item = items().find((entry) => entry.id === id)

                  return item ? `${item.title} · ${language.t(`improve.stage.${item.stage}`)}` : id
                }}
                onSelect={(id) => id && navigate(improveHref(server.key, { id, directory: search.directory }))}
              />
            </Show>
          </div>
        </header>
        <Show
          when={params.id}
          keyed
          fallback={<Findings directory={search.directory} onCreated={() => void refetch()} />}
        >
          {(id) => <ImprovementView id={id} onChanged={() => void refetch()} />}
        </Show>
      </div>
    </div>
  )
}

function Findings(props: { directory?: string; onCreated: () => void }) {
  const sdk = useServerSDK()
  const server = useServer()
  const language = useLanguage()

  const [analysis] = createResource(
    () => props.directory,
    (directory) => sdk.api.improvement.analysis({ directory }),
  )

  const current = () => (analysis.state === "ready" ? analysis.latest : undefined)

  return (
    <Show
      when={props.directory}
      fallback={<ProjectPicker href={(directory) => improveHref(server.key, { directory })} />}
    >
      <Show
        when={current()}
        fallback={
          <div class="flex items-center gap-2 text-[13px] text-v2-text-text-muted">
            <Loader class="size-4" />
            {language.t("improve.analysis.loading")}
          </div>
        }
      >
        {(value) => <AnalysisView analysis={value()} directory={props.directory!} onCreated={props.onCreated} />}
      </Show>
    </Show>
  )
}

function AnalysisView(props: { analysis: ImprovementAnalysis; directory: string; onCreated: () => void }) {
  const language = useLanguage()

  return (
    <div class="flex flex-col gap-4">
      <section class="flex flex-col gap-1 rounded-lg border border-v2-border-border-base bg-v2-background-bg-deep p-4">
        <span class="text-[13px] font-medium">
          {language.t("improve.analysis.summary", {
            records: props.analysis.records,
            verified: props.analysis.verified,
          })}
        </span>
        <details class="text-[12px] text-v2-text-text-muted">
          <summary class="cursor-pointer">{language.t("improve.analysis.method")}</summary>
          <p class="mt-1 leading-[var(--line-height-base)]">{props.analysis.method}</p>
        </details>
        <Show when={props.analysis.insufficient.length > 0}>
          <div class="mt-1 flex flex-col gap-0.5 text-[12px] text-v2-state-fg-warning">
            <span class="font-medium">{language.t("improve.insufficient")}</span>
            <For each={props.analysis.insufficient}>
              {(item) => (
                <span>
                  {language.t("improve.insufficient.item", {
                    analysis: item.analysis,
                    have: item.have,
                    need: item.need,
                    reason: item.reason,
                  })}
                </span>
              )}
            </For>
          </div>
        </Show>
      </section>
      <Show
        when={props.analysis.findings.length > 0}
        fallback={<p class="text-[13px] text-v2-text-text-muted">{language.t("improve.analysis.empty")}</p>}
      >
        <For each={props.analysis.findings}>
          {(finding) => <FindingCard finding={finding} directory={props.directory} onCreated={props.onCreated} />}
        </For>
      </Show>
    </div>
  )
}

function FindingCard(props: {
  finding: ImprovementFinding
  directory?: string
  onCreated?: () => void
  snapshot?: boolean
}) {
  const sdk = useServerSDK()
  const server = useServer()
  const language = useLanguage()
  const navigate = useNavigate()

  const [store, setStore] = createStore<{ busy: boolean; error?: string; target: ImprovementTarget }>({
    busy: false,
    target: "project",
  })

  const finding = () => props.finding

  const investigate = async () => {
    if (!props.directory) return
    setStore({ busy: true, error: undefined })

    const created = await sdk.api.improvement
      .create({ directory: props.directory, findingID: finding().id, target: store.target })
      .catch((cause: unknown) => {
        setStore({ busy: false, error: formatServerError(cause, language.t, language.t("common.requestFailed")) })

        return undefined
      })

    if (!created) return
    props.onCreated?.()
    navigate(improveHref(server.key, { id: created.definition.id, directory: props.directory }))
  }

  return (
    <section
      data-component="improvement-finding"
      class="flex flex-col gap-3 rounded-lg border border-v2-border-border-base p-4"
    >
      <header class="flex flex-wrap items-start justify-between gap-2">
        <div class="flex min-w-0 flex-col gap-1">
          <h2 class="text-[15px] font-medium">{finding().title}</h2>
          <div class="flex flex-wrap gap-1.5">
            <Badge>{finding().kind}</Badge>
            <Badge variant="subtle">{language.t(`improve.severity.${finding().severity}`)}</Badge>
            <Badge variant={finding().support === "supported" ? "accent" : "subtle"}>
              {language.t(`improve.support.${finding().support}`)}
            </Badge>
            <Badge variant="subtle">{finding().scope.stage}</Badge>
          </div>
        </div>
        <Show when={!props.snapshot}>
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-[12px] text-v2-text-text-muted">{language.t("improve.target")}</span>
            <Select
              data-action="improvement-target"
              options={TARGETS}
              current={store.target}
              gutter={6}
              label={(target) => language.t(`improve.target.${target}`)}
              onSelect={(target) => target && setStore("target", target)}
            />
            <Button
              variant="submit"
              size="small"
              disabled={store.busy || finding().needsMoreEvidence}
              title={finding().needsMoreEvidence ? language.t("improve.investigate.blocked") : undefined}
              onClick={() => void investigate()}
            >
              {language.t("improve.investigate")}
            </Button>
          </div>
        </Show>
      </header>
      <Labeled state="observed">{finding().statement}</Labeled>
      <Labeled state="inferred">{finding().interpretation}</Labeled>
      <dl class="grid grid-cols-1 gap-x-4 gap-y-1 text-[12px] sm:grid-cols-[auto_1fr]">
        <dt class="text-v2-text-text-muted">{language.t("improve.effect")}</dt>
        <dd>
          {finding().effect.measure}: {finding().effect.estimate.toFixed(2)}
          <Show when={finding().effect.low !== undefined && finding().effect.high !== undefined}>
            {` (95% CI ${finding().effect.low!.toFixed(2)} to ${finding().effect.high!.toFixed(2)})`}
          </Show>
        </dd>
        <dt class="text-v2-text-text-muted">{language.t("improve.comparisonGroup")}</dt>
        <dd>{finding().comparisonGroup}</dd>
        <dt />
        <dd class="text-v2-text-text-muted">
          {language.t("improve.sample", { frequency: finding().frequency, sample: finding().sampleSize })}
          <Show when={finding().pValue !== undefined}>
            {" · "}
            {language.t("improve.pValue", { p: finding().pValue!.toFixed(4) })}
          </Show>
          <Show when={finding().adjustedPValue !== undefined}>
            {" · "}
            {language.t("improve.adjustedPValue", { p: finding().adjustedPValue!.toFixed(4) })}
          </Show>
        </dd>
      </dl>
      <p class="text-[12px] text-v2-text-text-faint">{finding().method}</p>
      <Show when={finding().needsMoreEvidence}>
        <p class="text-[12px] text-v2-state-fg-warning">{language.t("improve.investigate.blocked")}</p>
      </Show>
      <For each={finding().history}>
        {(item) => (
          <p class="text-[12px] text-v2-text-text-muted">
            {language.t("improve.history.item", {
              id: item.improvementID,
              verdict: item.verdict ? language.t(`improve.verdict.${item.verdict}`) : "—",
            })}
            <Show when={item.validated}>{` · ${language.t("improve.history.validated")}`}</Show>
          </p>
        )}
      </For>
      <details class="text-[12px]">
        <summary class="cursor-pointer text-v2-text-text-muted">
          {language.t("improve.evidence")} ({finding().evidence.length})
        </summary>
        <ul class="mt-1 flex flex-col gap-1">
          <For each={finding().evidence}>
            {(item) => (
              <li class="flex flex-wrap items-center gap-2">
                <span class="font-medium">{item.title}</span>
                <span class="text-v2-text-text-muted">{item.harness}</span>
                <span class="text-v2-text-text-muted">{item.note}</span>
                <A class="text-v2-text-text-accent underline" href={compareHref(server.key, { id: item.comparisonID })}>
                  {language.t("improve.evidence.comparison")}
                </A>
                <Show when={item.sessionID}>
                  {(sessionID) => (
                    <A class="text-v2-text-text-accent underline" href={sessionHref(server.key, sessionID())}>
                      {language.t("improve.evidence.session")}
                    </A>
                  )}
                </Show>
              </li>
            )}
          </For>
        </ul>
      </details>
      <Show when={store.error}>{(error) => <p class="text-[13px] text-v2-state-fg-danger">{error()}</p>}</Show>
    </section>
  )
}

function ImprovementView(props: { id: string; onChanged: () => void }) {
  const sdk = useServerSDK()
  const language = useLanguage()

  const [info, { refetch, mutate }] = createResource(
    () => props.id,
    (improvementID) => sdk.api.improvement.get({ improvementID }),
  )

  const current = () => (info.state === "ready" || info.state === "refreshing" ? info.latest : undefined)
  const [store, setStore] = createStore<{ harness: ComparisonHarness; error?: string }>({ harness: "opencode" })

  createEffect(() => {
    if (!live(current())) return
    const timer = setInterval(() => void refetch(), POLL_MS)
    onCleanup(() => clearInterval(timer))
  })

  const act = async (run: () => Promise<ImprovementInfo>) => {
    setStore("error", undefined)

    const next = await run().catch((cause: unknown) => {
      setStore("error", formatServerError(cause, language.t, language.t("common.requestFailed")))

      return undefined
    })

    if (!next) return
    mutate(next)
    props.onChanged()
  }

  return (
    <Show when={current()} fallback={<Loader class="size-4 text-v2-icon-icon-muted" />}>
      {(value) => (
        <div class="flex flex-col gap-4">
          <Stepper info={value()} />
          <Show when={value().state.error}>
            {(error) => (
              <p class="text-[13px] text-v2-state-fg-danger">
                {language.t("improve.error")}: {error()}
              </p>
            )}
          </Show>
          <Show when={store.error}>{(error) => <p class="text-[13px] text-v2-state-fg-danger">{error()}</p>}</Show>
          <FindingCard finding={value().definition.finding} snapshot />
          <For each={value().state.investigations}>
            {(investigation) => (
              <Investigation
                investigation={investigation}
                info={value()}
                harness={store.harness}
                onHarness={(harness) => setStore("harness", harness)}
                onApprove={() =>
                  void act(() =>
                    sdk.api.improvement.approve({
                      improvementID: props.id,
                      attempt: investigation.attempt,
                      harness: store.harness,
                    }),
                  )
                }
              />
            )}
          </For>
          <Show when={value().state.stage === "proposed" || value().state.stage === "needs-proposal"}>
            <div>
              <Button
                variant="outline"
                size="small"
                onClick={() => void act(() => sdk.api.improvement.investigate({ improvementID: props.id }))}
              >
                {language.t("improve.investigate.again")}
              </Button>
            </div>
          </Show>
          <Show when={value().state.plan}>{(plan) => <PlanView plan={plan()} />}</Show>
          <Show when={value().state.implementation}>
            {(implementation) => <ImplementationView implementation={implementation()} />}
          </Show>
          <Show when={value().state.evaluation}>
            <EvaluationView info={value()} />
          </Show>
          <Show when={value().definition.target === "stack-agent" && value().state.evaluation?.status === "completed"}>
            <ApplyPanel info={value()} onChanged={(next) => mutate(next)} act={act} />
          </Show>
          <Show when={value().state.stage === "evaluated" || value().state.stage === "decided"}>
            <Decision
              info={value()}
              onDecide={(decision) => void act(() => sdk.api.improvement.decide({ improvementID: props.id, decision }))}
            />
          </Show>
        </div>
      )}
    </Show>
  )
}

function runtimeLabel(ref?: { pin: string; commit?: string; version?: string }) {
  if (!ref) return "—"

  return [ref.version ?? ref.pin, ref.commit?.slice(0, 12)].filter(Boolean).join(" @ ")
}

function ApplyPanel(props: {
  info: ImprovementInfo
  onChanged: (next: ImprovementInfo) => void
  act: (run: () => Promise<ImprovementInfo>) => Promise<void>
}) {
  const sdk = useServerSDK()
  const server = useServer()
  const language = useLanguage()
  const id = () => props.info.definition.id
  const application = () => props.info.state.application

  const [preview, { refetch }] = createResource(
    () => `${id()}:${application()?.status ?? "none"}`,
    () => sdk.api.improvement.preview({ improvementID: id() }),
  )

  const [runtime, { refetch: refetchRuntime }] = createResource(() => sdk.api.stackAgent.status())
  const [store, setStore] = createStore({ confirmed: false })
  const current = () => (preview.state === "ready" || preview.state === "refreshing" ? preview.latest : undefined)

  const build = () =>
    runtime.state === "ready" || runtime.state === "refreshing"
      ? runtime.latest?.generations.find((item) => item.id === application()?.build)
      : undefined

  const active = () =>
    (runtime.state === "ready" || runtime.state === "refreshing") &&
    runtime.latest?.state.active === application()?.build

  createEffect(() => {
    if (!application()?.build || build()?.status === "validated" || build()?.status === "failed") return
    const timer = setInterval(() => void refetchRuntime(), POLL_MS)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <Panel
      title={language.t("apply.title")}
      state="implemented"
      aside={
        <Show when={application()}>
          {(value) => <Badge variant="subtle">{language.t(`apply.status.${value().status}`)}</Badge>}
        </Show>
      }
    >
      <Show when={current()}>
        {(value) => (
          <div class="flex flex-col gap-1 text-[13px]" data-component="apply-preview">
            <p>
              {language.t("apply.repository")}: <code class="text-[12px]">{value().sourceDirectory}</code>
            </p>
            <p>
              {language.t("apply.branch", { branch: value().targetBranch, tip: value().tip?.slice(0, 12) ?? "—" })}
              {" · "}
              {language.t("apply.tested", { tested: value().tested.slice(0, 12) })}
            </p>
            <p classList={{ "text-v2-state-fg-warning": value().drift, "text-v2-text-text-muted": !value().drift }}>
              {language.t(value().drift ? "apply.drift" : "apply.noDrift")}
            </p>
            <Show when={value().conflicts.length > 0}>
              <p class="text-v2-state-fg-danger">
                {language.t("apply.conflicts", { files: value().conflicts.join(", ") })}
              </p>
            </Show>
            <p>
              {language.t("apply.files")}: <code class="text-[12px]">{value().files.join(", ")}</code>
            </p>
            <p>
              {language.t("apply.verdict", {
                verdict: language.t(`improve.verdict.${props.info.state.evaluation?.verdict ?? "inconclusive"}`),
              })}
            </p>
            <Show when={value().blocker}>{(blocker) => <p class="text-v2-state-fg-warning">{blocker()}</p>}</Show>
          </div>
        )}
      </Show>
      <Show when={!application() || application()!.status === "conflict" || application()!.status === "failed"}>
        <div class="flex flex-col gap-2 rounded-md bg-v2-background-bg-deep p-3">
          <label class="flex items-start gap-2 text-[12px]">
            <input
              type="checkbox"
              checked={store.confirmed}
              onChange={(event) => setStore("confirmed", event.currentTarget.checked)}
            />
            {language.t("apply.confirm")}
          </label>
          <div>
            <Button
              variant="submit"
              size="small"
              disabled={!store.confirmed || !!current()?.blocker || (current()?.conflicts.length ?? 0) > 0}
              onClick={() =>
                void props.act(() => sdk.api.improvement.apply({ improvementID: id() })).then(() => refetch())
              }
            >
              {language.t("apply.action")}
            </Button>
          </div>
        </div>
      </Show>
      <Show when={application()?.status === "applying"}>
        <p class="flex items-center gap-2 text-[13px] text-v2-text-text-muted">
          <Loader class="size-4" />
          {language.t("apply.applying")}
        </p>
      </Show>
      <Show when={application()?.error}>{(error) => <p class="text-[13px] text-v2-state-fg-danger">{error()}</p>}</Show>
      <Show when={application()?.commit}>
        {(commit) => (
          <div class="flex flex-col gap-2 text-[13px]">
            <code class="text-[12px] text-v2-text-text-muted">
              {language.t("apply.result", { branch: application()!.branch ?? "", commit: commit().slice(0, 12) })}
            </code>
            <p class={application()!.sameSource ? "text-v2-text-text-muted" : "text-v2-state-fg-warning"}>
              {language.t(application()!.sameSource ? "apply.sameSource" : "apply.differentSource")}
            </p>
            <Show when={application()!.checks.length > 0}>
              <div class="flex flex-col gap-0.5 text-[12px]">
                <span class="font-medium">{language.t("apply.checks")}</span>
                <For each={application()!.checks}>
                  {(check) => (
                    <code
                      classList={{ "text-v2-state-fg-success": check.passed, "text-v2-state-fg-danger": !check.passed }}
                    >
                      $ {check.command} → {check.exitCode}
                    </code>
                  )}
                </For>
              </div>
            </Show>
            <Show when={application()!.diff}>
              {(diff) => (
                <details>
                  <summary class="cursor-pointer text-[12px] text-v2-text-text-muted">
                    {language.t("apply.diff")}
                  </summary>
                  <pre
                    class="max-h-64 overflow-auto rounded bg-v2-background-bg-deep p-2 font-mono text-[12px]"
                    data-scrollable
                  >
                    {diff()}
                  </pre>
                </details>
              )}
            </Show>
            <div class="flex flex-wrap items-center gap-2">
              <Show
                when={application()!.published}
                fallback={
                  <Show
                    when={current()?.remote}
                    fallback={
                      <span class="text-[12px] text-v2-text-text-faint">{language.t("apply.publish.none")}</span>
                    }
                  >
                    {(remote) => (
                      <Button
                        variant="outline"
                        size="small"
                        disabled={application()!.status !== "applied"}
                        onClick={() => void props.act(() => sdk.api.improvement.publish({ improvementID: id() }))}
                      >
                        {language.t("apply.publish", { remote: remote() })}
                      </Button>
                    )}
                  </Show>
                }
              >
                {(published) => (
                  <span class="text-[12px] text-v2-state-fg-success">
                    {language.t("apply.published", { remote: published().remote })}
                  </span>
                )}
              </Show>
              <Show when={!application()!.build}>
                <Button
                  variant="submit"
                  size="small"
                  disabled={application()!.status !== "applied"}
                  onClick={() =>
                    void props
                      .act(() => sdk.api.improvement.stage({ improvementID: id() }))
                      .then(() => refetchRuntime())
                  }
                >
                  {language.t("apply.stage")}
                </Button>
              </Show>
              <Show when={application()!.build}>
                {(generation) => (
                  <>
                    <span class="flex items-center gap-1 text-[12px]">
                      <Show when={build() && build()!.status !== "validated" && build()!.status !== "failed"}>
                        <Loader class="size-3" />
                      </Show>
                      {language.t("apply.build", {
                        generation: generation(),
                        status: build() ? language.t(`runtime.generation.status.${build()!.status}`) : "…",
                      })}
                    </span>
                    <Show when={!active()} fallback={<Badge variant="accent">{language.t("apply.active")}</Badge>}>
                      <Button
                        variant="submit"
                        size="small"
                        disabled={build()?.status !== "validated"}
                        onClick={() =>
                          void sdk.api.stackAgent.activate({ generation: generation() }).then(() => refetchRuntime())
                        }
                      >
                        {language.t("apply.activate")}
                      </Button>
                    </Show>
                  </>
                )}
              </Show>
              <A class="text-[12px] text-v2-text-text-accent underline" href={runtimeHref(server.key)}>
                {language.t("apply.runtimePage")}
              </A>
            </div>
          </div>
        )}
      </Show>
    </Panel>
  )
}

function Stepper(props: { info: ImprovementInfo }) {
  const language = useLanguage()

  return (
    <ol class="flex flex-wrap items-center gap-2 text-[12px]" data-component="improvement-lifecycle">
      <For each={lifecycle(props.info)}>
        {(step, index) => (
          <li class="flex items-center gap-2">
            <Show when={index() > 0}>
              <span class="text-v2-text-text-faint">→</span>
            </Show>
            <span
              class="inline-flex items-center gap-1 rounded-md border px-2 py-0.5"
              classList={{
                "border-v2-border-border-base text-v2-state-fg-success": step.status === "done",
                "border-v2-border-border-strong text-v2-text-text-base font-medium": step.status === "active",
                "border-v2-border-border-base text-v2-state-fg-danger": step.status === "failed",
                "border-v2-border-border-muted text-v2-text-text-faint": step.status === "pending",
              }}
            >
              <Show when={step.status === "active"}>
                <Loader class="size-3" />
              </Show>
              {language.t(`improve.state.${step.key}`)}
            </span>
          </li>
        )}
      </For>
      <li class="ms-auto flex gap-1">
        <Badge>{language.t(`improve.target.${props.info.definition.target ?? "project"}`)}</Badge>
        <Badge variant="subtle">{language.t(`improve.stage.${props.info.state.stage}`)}</Badge>
      </li>
    </ol>
  )
}

function Investigation(props: {
  investigation: ImprovementInvestigation
  info: ImprovementInfo
  harness: ComparisonHarness
  onHarness: (harness: ComparisonHarness) => void
  onApprove: () => void
}) {
  const server = useServer()
  const language = useLanguage()

  const awaiting = () =>
    props.info.state.stage === "proposed" &&
    props.investigation.status === "valid" &&
    props.investigation.attempt === props.info.state.investigations.findLast((item) => item.status === "valid")?.attempt

  return (
    <Panel
      title={language.t("improve.investigation", { attempt: props.investigation.attempt + 1 })}
      state="proposed"
      aside={
        <div class="flex items-center gap-2">
          <Show when={props.investigation.status === "running"}>
            <Loader class="size-4 text-v2-icon-icon-muted" />
          </Show>
          <Badge variant="subtle">{language.t(`improve.investigation.status.${props.investigation.status}`)}</Badge>
          <Show when={props.investigation.sessionID}>
            {(sessionID) => (
              <A class="text-[13px] text-v2-text-text-accent underline" href={sessionHref(server.key, sessionID())}>
                {language.t("improve.openSession")}
              </A>
            )}
          </Show>
        </div>
      }
    >
      <Show when={props.investigation.status === "running"}>
        <p class="text-[13px] text-v2-text-text-muted">{language.t("improve.investigating")}</p>
      </Show>
      <Show when={props.investigation.errors.length > 0}>
        <ul class="list-disc ps-5 text-[12px] text-v2-state-fg-danger">
          <For each={props.investigation.errors}>{(error) => <li class="break-words">{error}</li>}</For>
        </ul>
      </Show>
      <Show when={props.investigation.proposal}>{(proposal) => <ProposalView proposal={proposal()} />}</Show>
      <Show when={awaiting()}>
        <div class="flex flex-col gap-2 rounded-md bg-v2-background-bg-deep p-3">
          <p class="text-[12px] text-v2-text-text-muted">
            {language.t("improve.approve.note", { branch: `improvement/${props.info.definition.id}` })}
          </p>
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-[13px]">{language.t("improve.approve.runtime")}</span>
            <Select
              data-action="improvement-runtime"
              options={RUNTIMES}
              current={props.harness}
              gutter={6}
              label={(harness) => language.t(`compare.harness.${harness}`)}
              onSelect={(harness) => harness && props.onHarness(harness)}
            />
            <Button variant="submit" size="small" onClick={props.onApprove}>
              {language.t("improve.approve")}
            </Button>
          </div>
        </div>
      </Show>
    </Panel>
  )
}

function ProposalView(props: { proposal: ImprovementProposal }) {
  const language = useLanguage()

  const list = (items: readonly string[]) => (
    <ul class="list-disc ps-5">
      <For each={items}>{(item) => <li>{item}</li>}</For>
    </ul>
  )

  return (
    <div class="flex flex-col gap-3 text-[13px]" data-component="improvement-proposal">
      <h3 class="text-[15px] font-medium">{props.proposal.title}</h3>
      <dl class="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-[180px_1fr]">
        <dt class="text-v2-text-text-muted">{language.t("improve.proposal.cause")}</dt>
        <dd>{props.proposal.cause}</dd>
        <dt class="text-v2-text-text-muted">{language.t("improve.proposal.hypothesis")}</dt>
        <dd>{props.proposal.hypothesis}</dd>
        <dt class="text-v2-text-text-muted">{language.t("improve.proposal.mechanism")}</dt>
        <dd>{props.proposal.mechanism}</dd>
        <dt class="text-v2-text-text-muted">{language.t("improve.proposal.layer")}</dt>
        <dd>{props.proposal.layer}</dd>
        <dt class="text-v2-text-text-muted">{language.t("improve.proposal.alternatives")}</dt>
        <dd>{list(props.proposal.alternatives)}</dd>
        <dt class="text-v2-text-text-muted">{language.t("improve.proposal.sources")}</dt>
        <dd>
          <ul class="flex flex-col gap-0.5">
            <For each={props.proposal.sourceLocations}>
              {(item) => (
                <li>
                  <code class="text-[12px]">
                    {item.path}
                    {item.line ? `:${item.line}` : ""}
                  </code>{" "}
                  <span class="text-v2-text-text-muted">{item.reason}</span>
                </li>
              )}
            </For>
          </ul>
        </dd>
        <dt class="text-v2-text-text-muted">{language.t("improve.proposal.changes")}</dt>
        <dd>
          <ul class="flex flex-col gap-0.5">
            <For each={props.proposal.changes}>
              {(item) => (
                <li>
                  <code class="text-[12px]">{item.path}</code>{" "}
                  <span class="text-v2-text-text-muted">{item.description}</span>
                </li>
              )}
            </For>
          </ul>
        </dd>
        <dt class="text-v2-text-text-muted">{language.t("improve.proposal.criteria")}</dt>
        <dd>
          <ul class="flex flex-col gap-0.5">
            <For each={props.proposal.acceptanceCriteria}>
              {(item) => (
                <li>
                  {item.description} <code class="text-[12px] text-v2-text-text-muted">$ {item.command}</code>
                </li>
              )}
            </For>
          </ul>
        </dd>
        <dt class="text-v2-text-text-muted">{language.t("improve.proposal.evaluation")}</dt>
        <dd>
          {language.t("improve.proposal.evaluation.detail", {
            trials: props.proposal.evaluation.trials,
            tasks: props.proposal.evaluation.taskKeys.length,
            runtimes: props.proposal.evaluation.targetRuntimes.join(", "),
          })}
        </dd>
        <dt class="text-v2-text-text-muted">{language.t("improve.proposal.risks")}</dt>
        <dd>{list(props.proposal.risks)}</dd>
        <dt class="text-v2-text-text-muted">{language.t("improve.proposal.rollback")}</dt>
        <dd>{list(props.proposal.rollback)}</dd>
        <dt class="text-v2-text-text-muted">{language.t("improve.proposal.approvals")}</dt>
        <dd>{list(props.proposal.requiredApprovals)}</dd>
      </dl>
    </div>
  )
}

function PlanView(props: { plan: NonNullable<ImprovementInfo["state"]["plan"]> }) {
  const server = useServer()
  const language = useLanguage()

  return (
    <Panel title={language.t("improve.plan")} state="proposed">
      <p class="text-[12px] text-v2-text-text-muted">
        {language.t("improve.plan.detail", { alpha: props.plan.alpha, trials: props.plan.trials })}
      </p>
      <ul class="flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
        <For each={props.plan.runs}>
          {(run) => (
            <li>
              <A class="text-v2-text-text-accent underline" href={compareHref(server.key, { id: run.comparisonID })}>
                {language.t(`improve.plan.variant.${run.variant}`)} #{run.trial + 1}
              </A>
            </li>
          )}
        </For>
      </ul>
    </Panel>
  )
}

function ImplementationView(props: { implementation: NonNullable<ImprovementInfo["state"]["implementation"]> }) {
  const server = useServer()
  const language = useLanguage()
  const implementation = () => props.implementation

  return (
    <Panel
      title={language.t("improve.implementation")}
      state="implemented"
      aside={
        <div class="flex items-center gap-2">
          <Show when={["preparing", "running", "verifying"].includes(implementation().status)}>
            <Loader class="size-4 text-v2-icon-icon-muted" />
          </Show>
          <Badge variant="subtle">{language.t(`improve.implementation.status.${implementation().status}`)}</Badge>
          <Badge>{language.t(`compare.harness.${implementation().harness}`)}</Badge>
          <Show when={implementation().sessionID}>
            {(sessionID) => (
              <A class="text-[13px] text-v2-text-text-accent underline" href={sessionHref(server.key, sessionID())}>
                {language.t("improve.openSession")}
              </A>
            )}
          </Show>
        </div>
      }
    >
      <Show when={implementation().error}>
        {(error) => <p class="text-[13px] text-v2-state-fg-danger">{error()}</p>}
      </Show>
      <Show when={implementation().branch && implementation().commit}>
        <code class="text-[12px] text-v2-text-text-muted">
          {language.t("improve.implementation.branch", {
            branch: implementation().branch!,
            commit: implementation().commit!.slice(0, 12),
          })}
        </code>
      </Show>
      <Show when={implementation().checks.length > 0}>
        <div class="flex flex-col gap-1">
          <span class="text-[12px] font-medium">{language.t("improve.implementation.checks")}</span>
          <For each={implementation().checks}>
            {(check) => (
              <details class="text-[12px]">
                <summary class="cursor-pointer">
                  <span
                    classList={{
                      "text-v2-state-fg-success": check.passed,
                      "text-v2-state-fg-danger": !check.passed,
                    }}
                  >
                    {language.t(check.passed ? "compare.criterion.passed" : "compare.criterion.failed")}
                  </span>{" "}
                  {check.description}{" "}
                  <code>
                    $ {check.command} → {check.exitCode}
                  </code>
                </summary>
                <Show when={check.output}>
                  <pre
                    class="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-v2-background-bg-deep p-2 font-mono"
                    data-scrollable
                  >
                    {check.output}
                  </pre>
                </Show>
              </details>
            )}
          </For>
        </div>
      </Show>
      <Show when={implementation().patch}>
        {(patch) => (
          <div class="flex flex-col gap-1">
            <span class="text-[12px] font-medium">{language.t("improve.implementation.patch")}</span>
            <pre
              class="max-h-80 overflow-auto rounded bg-v2-background-bg-deep p-2 font-mono text-[12px] leading-[var(--line-height-compact)]"
              data-scrollable
            >
              <For each={patch().split("\n")}>
                {(line) => (
                  <div
                    classList={{
                      "text-v2-state-fg-success": line.startsWith("+") && !line.startsWith("+++"),
                      "text-v2-state-fg-danger": line.startsWith("-") && !line.startsWith("---"),
                      "text-v2-text-text-muted": line.startsWith("@@") || line.startsWith("diff "),
                    }}
                  >
                    {line || " "}
                  </div>
                )}
              </For>
            </pre>
            <Show when={implementation().patchTruncated}>
              <p class="text-[12px] text-v2-text-text-muted">{language.t("improve.implementation.truncated")}</p>
            </Show>
          </div>
        )}
      </Show>
    </Panel>
  )
}

function EvaluationView(props: { info: ImprovementInfo }) {
  const language = useLanguage()
  const evaluation = () => props.info.state.evaluation!

  const rate = (value: { runs: number; verified: number; successes: number }) =>
    language.t("improve.evaluation.rate", value)

  return (
    <Panel
      title={language.t("improve.evaluation")}
      state="verified"
      aside={
        <Show when={evaluation().verdict}>
          {(verdict) => (
            <span
              class="text-[14px] font-medium"
              classList={{
                "text-v2-state-fg-success": verdict() === "improved",
                "text-v2-state-fg-danger": verdict() === "regressed" || verdict() === "failed-to-implement",
                "text-v2-state-fg-warning": verdict() === "inconclusive",
              }}
            >
              {language.t(`improve.verdict.${verdict()}`)}
            </span>
          )}
        </Show>
      }
    >
      <Show
        when={evaluation().status === "completed"}
        fallback={<p class="text-[13px] text-v2-text-text-muted">{language.t("improve.evaluation.pending")}</p>}
      >
        <p class="text-[13px]">{evaluation().reason}</p>
        <Show when={evaluation().runtime}>
          {(runtime) => (
            <p class="text-[12px] text-v2-text-text-muted">
              {language.t("improve.evaluation.runtime")}:{" "}
              {language.t("improve.evaluation.runtime.detail", {
                baseline: runtimeLabel(runtime().baseline),
                candidate: runtimeLabel(runtime().candidate),
              })}
            </p>
          )}
        </Show>
        <div class="overflow-x-auto" data-scrollable>
          <table class="w-full min-w-[560px] text-left text-[13px]">
            <thead class="text-[12px] text-v2-text-text-muted">
              <tr>
                <th class="py-1 pe-3 font-medium">{language.t("improve.evaluation.harness")}</th>
                <th class="py-1 pe-3 font-medium">{language.t("improve.evaluation.baseline")}</th>
                <th class="py-1 pe-3 font-medium">{language.t("improve.evaluation.candidate")}</th>
                <th class="py-1 font-medium">p</th>
              </tr>
            </thead>
            <tbody>
              <For each={evaluation().results}>
                {(result) => (
                  <tr class="border-t border-v2-border-border-muted align-top">
                    <td class="py-1 pe-3">
                      {language.t(`compare.harness.${result.harness}`)}
                      <Show when={result.target}>
                        <span class="ms-1 text-[11px] text-v2-text-text-faint">
                          {language.t("improve.evaluation.target")}
                        </span>
                      </Show>
                    </td>
                    <td class="py-1 pe-3 tabular-nums">{rate(result.baseline)}</td>
                    <td class="py-1 pe-3 tabular-nums">{rate(result.candidate)}</td>
                    <td class="py-1 text-[12px] tabular-nums text-v2-text-text-muted">
                      {result.pImproved === undefined
                        ? "—"
                        : `↑ ${result.pImproved.toFixed(3)} · ↓ ${result.pRegressed!.toFixed(3)}`}
                      <Show when={result.criterionRegressions.length > 0}>
                        <div class="text-v2-state-fg-danger">
                          {language.t("improve.evaluation.regressions")}: {result.criterionRegressions.join("; ")}
                        </div>
                      </Show>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
        <div class="overflow-x-auto" data-scrollable>
          <table class="w-full min-w-[560px] text-left text-[12px] text-v2-text-text-muted">
            <thead>
              <tr>
                <th class="py-1 pe-3 font-medium">{language.t("improve.evaluation.harness")}</th>
                <th class="py-1 pe-3 font-medium">{language.t("compare.metric.column")}</th>
                <th class="py-1 pe-3 font-medium">{language.t("improve.evaluation.baseline")}</th>
                <th class="py-1 font-medium">{language.t("improve.evaluation.candidate")}</th>
              </tr>
            </thead>
            <tbody>
              <For each={evaluation().results}>
                {(result) => (
                  <For
                    each={result.metrics.filter(
                      (metric) => metric.baseline !== undefined || metric.candidate !== undefined,
                    )}
                  >
                    {(metric) => (
                      <tr>
                        <td class="py-0.5 pe-3">{language.t(`compare.harness.${result.harness}`)}</td>
                        <td class="py-0.5 pe-3">{metric.label}</td>
                        <td class="py-0.5 pe-3 tabular-nums">{metric.baseline ?? language.t("compare.unavailable")}</td>
                        <td class="py-0.5 tabular-nums">{metric.candidate ?? language.t("compare.unavailable")}</td>
                      </tr>
                    )}
                  </For>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </Panel>
  )
}

function Decision(props: { info: ImprovementInfo; onDecide: (decision: ImprovementDecision) => void }) {
  const language = useLanguage()

  return (
    <Panel
      title={language.t("improve.decision")}
      state="verified"
      aside={
        <span
          class="text-[13px] font-medium"
          classList={{
            "text-v2-state-fg-success": validated(props.info),
            "text-v2-text-text-muted": !validated(props.info),
          }}
        >
          {language.t(validated(props.info) ? "improve.validated" : "improve.notValidated")}
        </span>
      }
    >
      <p class="text-[12px] text-v2-text-text-muted">{language.t("improve.decision.note")}</p>
      <Show when={props.info.state.decision}>
        {(decision) => (
          <p class="text-[13px]">
            {language.t("improve.decision.recorded", {
              decision: language.t(`improve.decision.${decision().decision}`),
            })}
          </p>
        )}
      </Show>
      <div class="flex flex-wrap gap-2">
        <For each={DECISIONS}>
          {(decision) => (
            <Button
              variant={DECISION_VARIANTS[decision]}
              size="small"
              disabled={decision === "accept" && props.info.state.evaluation?.verdict !== "improved"}
              onClick={() => props.onDecide(decision)}
            >
              {language.t(`improve.decision.${decision}`)}
            </Button>
          )}
        </For>
      </div>
    </Panel>
  )
}

function Labeled(props: { state: "observed" | "inferred"; children: JSX.Element }) {
  const language = useLanguage()

  return (
    <p class="text-[13px] leading-[var(--line-height-base)]">
      <span
        class="me-2 rounded px-1.5 py-0.5 text-[11px] font-medium"
        classList={{
          "bg-v2-background-bg-deep text-v2-text-text-base": props.state === "observed",
          "bg-v2-background-bg-deep text-v2-text-text-muted italic": props.state === "inferred",
        }}
      >
        {language.t(`improve.state.${props.state}`)}
      </span>
      {props.children}
    </p>
  )
}

function Panel(props: {
  title: string
  state: "proposed" | "implemented" | "verified"
  aside?: JSX.Element
  children: JSX.Element
}) {
  const language = useLanguage()

  return (
    <section class="flex flex-col gap-3 rounded-lg border border-v2-border-border-base p-4">
      <header class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <h2 class="text-[15px] font-medium">{props.title}</h2>
          <span class="text-[11px] uppercase tracking-wide text-v2-text-text-faint">
            {language.t(`improve.state.${props.state}`)}
          </span>
        </div>
        {props.aside}
      </header>
      {props.children}
    </section>
  )
}
