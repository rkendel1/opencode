export * as ComparisonSettle from "./settle.js"

import { Effect } from "effect"
import type { Session } from "../session.js"

const POLL = "1 second"

/**
 * Waits until a Session has no execution and no admitted input left. Waiting on the execution alone is not enough:
 * a prompt's wake is scheduled after admission, so the Session can briefly be idle with the task still queued.
 */
export const untilSettled = (sessions: Session.Interface, sessionID: Session.ID) =>
  Effect.gen(function* () {
    while (true) {
      yield* sessions.wait(sessionID).pipe(Effect.ignore)
      const pending = yield* sessions.inbox(sessionID).pipe(Effect.orElseSucceed(() => []))
      if (pending.length === 0 && !(yield* sessions.active).has(sessionID)) return
      yield* Effect.sleep(POLL)
    }
  })
