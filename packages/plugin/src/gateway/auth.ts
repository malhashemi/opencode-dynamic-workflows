/**
 * Gateway credentials: device tokens (stored hashed, revocable) and short-lived pairing codes.
 *
 * Rules: no tokens in URLs; bearer tokens in the `Authorization` header only; codes are one-use and
 * expire in five minutes; tokens are stored as SHA-256 hashes in a 0600 file under the user's state directory.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { mkdir, rename, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export type Scope = "read" | "control"

export interface DeviceToken {
  id: string
  name: string
  hash: string
  scopes: Scope[]
  createdAt: number
  lastUsedAt: number | null
}

export function gatewayStateDir(): string {
  const xdg = process.env.XDG_STATE_HOME
  const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".local", "state")
  return path.join(base, "opencode-dynamic-workflows")
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex")

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex")
  const right = Buffer.from(b, "hex")
  return left.length === right.length && timingSafeEqual(left, right)
}

export interface TokenStore {
  issue(name: string, scopes: Scope[]): Promise<{ token: string; id: string }>
  verify(token: string): DeviceToken | null
  revoke(id: string): Promise<boolean>
  list(): DeviceToken[]
  createPairingCode(scopes?: Scope[]): { code: string; expiresAt: number }
  redeem(code: string, name: string): Promise<{ token: string; id: string } | null>
}

export async function createTokenStore(
  file = path.join(gatewayStateDir(), "gateway-tokens.json"),
): Promise<TokenStore> {
  let tokens: DeviceToken[] = []
  /** The file's modification time and size at the last load: a change means someone edited it. */
  let loadedStamp: string | null = null
  const stamp = (): string | null => {
    try {
      const stat = statSync(file)
      return `${stat.mtimeMs}:${stat.size}`
    } catch {
      return null
    }
  }
  /**
   * Re-read the file when it changed since the last load, so deleting an entry revokes that token at once, in the
   * running Gateway. A missing or unreadable file means no tokens: a broken file never grants access.
   */
  const load = () => {
    const current = stamp()
    if (current !== null && current === loadedStamp) return
    loadedStamp = current
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { tokens?: DeviceToken[] }
      tokens = Array.isArray(parsed.tokens)
        ? parsed.tokens.filter((t) => typeof t.hash === "string" && typeof t.id === "string")
        : []
    } catch {
      tokens = []
    }
  }
  load()
  const codes = new Map<string, { expiresAt: number; scopes: Scope[] }>()

  const persist = async () => {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`
    await writeFile(temp, `${JSON.stringify({ tokens }, null, 2)}\n`, { mode: 0o600 })
    await rename(temp, file)
    loadedStamp = stamp()
  }

  const store: TokenStore = {
    async issue(name, scopes) {
      load()
      const token = `wfg_${randomBytes(24).toString("base64url")}`
      const id = randomBytes(6).toString("hex")
      tokens.push({
        id,
        name: name.slice(0, 80) || "device",
        hash: hash(token),
        scopes,
        createdAt: Date.now(),
        lastUsedAt: null,
      })
      await persist()
      return { token, id }
    },
    verify(token) {
      if (!token.startsWith("wfg_")) return null
      load()
      const digest = hash(token)
      const match = tokens.find((candidate) => sameHash(candidate.hash, digest))
      if (match) match.lastUsedAt = Date.now()
      return match ?? null
    },
    async revoke(id) {
      load()
      const before = tokens.length
      tokens = tokens.filter((token) => token.id !== id)
      if (tokens.length === before) return false
      await persist()
      return true
    },
    list() {
      load()
      return tokens.map((token) => ({ ...token, scopes: [...token.scopes] }))
    },
    createPairingCode(scopes = ["read", "control"]) {
      const now = Date.now()
      for (const [code, entry] of codes) if (entry.expiresAt < now) codes.delete(code)
      const code = Array.from(randomBytes(8), (byte) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[byte % 32]).join("")
      const expiresAt = now + 5 * 60_000
      codes.set(code, { expiresAt, scopes })
      return { code, expiresAt }
    },
    async redeem(code, name) {
      const normalized = code
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
      const entry = codes.get(normalized)
      codes.delete(normalized)
      if (!entry || entry.expiresAt < Date.now()) return null
      return store.issue(name, entry.scopes)
    },
  }
  return store
}

export function bearer(request: Request): string | null {
  const header = request.headers.get("authorization")
  if (!header) return null
  const [scheme, value] = header.split(" ", 2)
  return scheme?.toLowerCase() === "bearer" && value ? value.trim() : null
}

export function isLoopbackAddress(address: string | undefined | null): boolean {
  if (!address) return false
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1" || address.startsWith("127.")
}
