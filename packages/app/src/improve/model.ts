import type { ImprovementInfo } from "@opencode/client/promise"

export type LifecycleStep = {
  key: "observed" | "inferred" | "proposed" | "implemented" | "verified"
  status: "done" | "active" | "failed" | "pending"
}

/**
 * Where an improvement stands on observed → inferred → proposed → implemented → verified. "Verified" means the
 * candidate was evaluated against the baseline, whatever the verdict; only an improved verdict accepted by a
 * reviewer is a validated intervention.
 */
export function lifecycle(info: ImprovementInfo): LifecycleStep[] {
  const state = info.state
  const proposal = state.investigations.some((item) => item.status === "valid")
  const implementation = state.implementation?.status
  const verdict = state.evaluation?.verdict

  return [
    { key: "observed", status: "done" },
    { key: "inferred", status: "done" },
    {
      key: "proposed",
      status: proposal
        ? "done"
        : state.stage === "investigating"
          ? "active"
          : state.stage === "needs-proposal"
            ? "failed"
            : "pending",
    },
    {
      key: "implemented",
      status:
        implementation === "completed"
          ? "done"
          : implementation === "failed" || verdict === "failed-to-implement"
            ? "failed"
            : state.stage === "baseline" || state.stage === "implementing"
              ? "active"
              : "pending",
    },
    {
      key: "verified",
      status:
        verdict && verdict !== "failed-to-implement" ? "done" : state.stage === "candidate" ? "active" : "pending",
    },
  ]
}

export const validated = (info: ImprovementInfo) =>
  info.state.evaluation?.verdict === "improved" && info.state.decision?.decision === "accept"

const SETTLED = new Set(["proposed", "needs-proposal", "evaluated", "decided"])

/** Polling stops once the pipeline waits on the user. */
export const live = (info: ImprovementInfo | undefined) => !info || !SETTLED.has(info.state.stage)
