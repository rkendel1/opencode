import { base64Encode } from "@opencode/util/encode"
import { ServerConnection } from "@/runtime/server/registry"
import { decode64 } from "@/runtime/persistence/base64"

export function sessionHref(server: ServerConnection.Key, sessionID: string) {
  return `/server/${base64Encode(server)}/session/${sessionID}`
}

export function requireServerKey(segment: string | undefined) {
  const key = decode64(segment)

  if (!key || base64Encode(key) !== segment) throw new Error("Invalid server route")

  return ServerConnection.Key.make(key)
}

type SessionParent = { id: string; parentID?: string }

export async function rootSession<T extends SessionParent>(session: T, get: (sessionID: string) => Promise<T>) {
  const seen = new Set([session.id])
  let current = session

  while (current.parentID) {
    if (seen.has(current.parentID)) throw new Error(`Session parent cycle: ${current.parentID}`)
    seen.add(current.parentID)
    current = await get(current.parentID)
  }

  return current
}

/** The Compare Agents workspace: a new comparison for `directory`, or the persisted comparison `id`. */
export function compareHref(server: ServerConnection.Key, input: { id?: string; directory?: string }) {
  const base = `/server/${base64Encode(server)}/compare${input.id ? `/${input.id}` : ""}`

  return input.directory ? `${base}?directory=${encodeURIComponent(input.directory)}` : base
}

/** The Improvement Lab: findings for `directory`, or the persisted improvement `id`. */
export function improveHref(server: ServerConnection.Key, input: { id?: string; directory?: string }) {
  const base = `/server/${base64Encode(server)}/improve${input.id ? `/${input.id}` : ""}`
  return input.directory ? `${base}?directory=${encodeURIComponent(input.directory)}` : base
}

/** The Stack-Agent runtime page: versions, builds, activation and rollback. */
export function runtimeHref(server: ServerConnection.Key) {
  return `/server/${base64Encode(server)}/stack-agent`
}
