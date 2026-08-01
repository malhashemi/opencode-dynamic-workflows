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
