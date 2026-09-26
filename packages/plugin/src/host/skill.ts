/**
 * The authoring skill shipped with the plugin (`skill/dynamic-workflows/SKILL.md`), registered through
 * `ctx.skill.transform` so it always matches the installed engine.
 */
import { readFileSync } from "node:fs"
import path from "node:path"

export const SKILL_PATH = path.join(import.meta.dir, "..", "..", "skill", "dynamic-workflows", "SKILL.md")

export interface AuthoringSkill {
  id: string
  name: string
  description: string
  path: string
  content: string
}

/** Split YAML-ish frontmatter (`key: value` lines) from the body. */
export function parseSkill(text: string, file = SKILL_PATH): AuthoringSkill {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) throw new Error(`${file}: missing frontmatter`)
  const fields: Record<string, string> = {}
  for (const line of match[1]!.split(/\r?\n/)) {
    const at = line.indexOf(":")
    if (at > 0) fields[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  if (!fields.name || !fields.description) throw new Error(`${file}: frontmatter needs name and description`)
  return { id: fields.name, name: fields.name, description: fields.description, path: file, content: match[2]!.trim() }
}

export function loadAuthoringSkill(): AuthoringSkill | null {
  try {
    return parseSkill(readFileSync(SKILL_PATH, "utf8"))
  } catch (error) {
    console.warn(
      `[workflow] the authoring skill did not load: ${error instanceof Error ? error.message : String(error)}`,
    )
    return null
  }
}
