import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

export interface EndpointDescriptor {
  url: string
  token: string
  pid: number
  directory: string
  worktree: string
  startedAt: number
}

export interface ReadDescriptorOptions {
  isProcessAlive?: (pid: number) => boolean
}

export function endpointDescriptorDirectory(statePath: string): string {
  return path.join(statePath, "workflows", "endpoints")
}

export function endpointDescriptorPath(statePath: string, pid: number): string {
  return path.join(endpointDescriptorDirectory(statePath), `${pid}.json`)
}

/**
 * The stable half of an endpoint's identity: the port it should bind and the token it should serve, per
 * worktree, across process restarts.
 *
 * A descriptor names a PROCESS (its file is the pid) and dies with it; this names a PROJECT and outlives every
 * process, which is what lets an old browser tab or a link in a day-old reply survive a host restart — same
 * port, same token, no re-handoff. It lives beside the descriptors rather than among them because
 * {@link readDescriptors} prunes everything in its directory that does not parse as a live descriptor.
 */
export interface EndpointPreference {
  port: number
  token: string
}

/** `<statePath>/workflows/addresses` — the per-worktree address book beside the per-process descriptors. */
export function endpointPreferenceDirectory(statePath: string): string {
  return path.join(statePath, "workflows", "addresses")
}

/** Keyed on a hash of the worktree path: stable, filename-safe, and collision-free enough for one machine. */
export function endpointPreferencePath(statePath: string, worktree: string): string {
  const key = createHash("sha256").update(path.resolve(worktree)).digest("hex").slice(0, 16)
  return path.join(endpointPreferenceDirectory(statePath), `${key}.json`)
}

function isPreference(value: unknown): value is EndpointPreference {
  if (typeof value !== "object" || value === null) return false
  const preference = value as Partial<EndpointPreference>
  return (
    Number.isInteger(preference.port) &&
    (preference.port ?? 0) > 0 &&
    (preference.port ?? 0) <= 65_535 &&
    typeof preference.token === "string" &&
    preference.token.length > 0
  )
}

/** A missing or corrupt preference reads as "first boot" — the endpoint then persists what it actually got. */
export async function readEndpointPreference(statePath: string, worktree: string): Promise<EndpointPreference | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(endpointPreferencePath(statePath, worktree), "utf8"))
    return isPreference(parsed) ? { port: parsed.port, token: parsed.token } : null
  } catch {
    return null
  }
}

export async function writeEndpointPreference(
  statePath: string,
  worktree: string,
  preference: EndpointPreference,
): Promise<void> {
  if (!isPreference(preference)) throw new Error("invalid workflow endpoint preference")
  const target = endpointPreferencePath(statePath, worktree)
  const directory = path.dirname(target)
  const temp = path.join(directory, `.${path.basename(target)}.${crypto.randomUUID()}.tmp`)
  await mkdir(directory, { recursive: true })
  try {
    await writeFile(temp, `${JSON.stringify(preference)}\n`, { encoding: "utf8", mode: 0o600 })
    await rename(temp, target)
  } finally {
    await rm(temp, { force: true }).catch(() => {})
  }
}

function loopbackUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  } catch {
    return false
  }
}

function isDescriptor(value: unknown): value is EndpointDescriptor {
  if (typeof value !== "object" || value === null) return false
  const descriptor = value as Partial<EndpointDescriptor>
  return (
    typeof descriptor.url === "string" &&
    loopbackUrl(descriptor.url) &&
    typeof descriptor.token === "string" &&
    descriptor.token.length > 0 &&
    Number.isInteger(descriptor.pid) &&
    (descriptor.pid ?? 0) > 0 &&
    typeof descriptor.directory === "string" &&
    typeof descriptor.worktree === "string" &&
    typeof descriptor.startedAt === "number" &&
    Number.isFinite(descriptor.startedAt) &&
    descriptor.startedAt > 0 &&
    descriptor.startedAt <= Date.now() + 60_000
  )
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}

export async function writeDescriptor(statePath: string, descriptor: EndpointDescriptor): Promise<string> {
  if (!isDescriptor(descriptor)) throw new Error("invalid workflow endpoint descriptor")
  const directory = endpointDescriptorDirectory(statePath)
  const target = endpointDescriptorPath(statePath, descriptor.pid)
  const temp = path.join(directory, `.${descriptor.pid}.${crypto.randomUUID()}.tmp`)
  await mkdir(directory, { recursive: true })
  try {
    await writeFile(temp, `${JSON.stringify(descriptor)}\n`, { encoding: "utf8", mode: 0o600 })
    await rename(temp, target)
  } finally {
    await rm(temp, { force: true }).catch(() => {})
  }
  return target
}

export async function removeDescriptor(statePath: string, pid = process.pid): Promise<void> {
  await rm(endpointDescriptorPath(statePath, pid), { force: true }).catch(() => {})
}

/** Read valid live descriptors and prune invalid JSON, mismatched filenames, and dead process entries. */
export async function readDescriptors(
  statePath: string,
  options: ReadDescriptorOptions = {},
): Promise<EndpointDescriptor[]> {
  const directory = endpointDescriptorDirectory(statePath)
  const alive = options.isProcessAlive ?? processIsAlive
  let names: string[]
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort()
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
    return []
  }

  const descriptors: EndpointDescriptor[] = []
  for (const name of names) {
    const file = path.join(directory, name)
    let descriptor: unknown
    try {
      descriptor = JSON.parse(await readFile(file, "utf8"))
    } catch {
      await rm(file, { force: true }).catch(() => {})
      continue
    }

    const filenamePid = Number(name.slice(0, -".json".length))
    if (!isDescriptor(descriptor) || descriptor.pid !== filenamePid || !alive(descriptor.pid)) {
      await rm(file, { force: true }).catch(() => {})
      continue
    }
    descriptors.push({ ...descriptor })
  }

  return descriptors.sort((a, b) => b.startedAt - a.startedAt || a.pid - b.pid)
}
