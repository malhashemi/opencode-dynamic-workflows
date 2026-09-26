/**
 * Writes `packages/plugin/README.md` (the npm page) from the repository's root `README.md`, rewriting relative links
 * so they work outside the repository: `assets/…` to raw.githubusercontent.com, any other repository path to its
 * GitHub page. Mermaid blocks, which npm does not render, become links to the diagram on GitHub. `--check` fails when
 * the committed copy is out of date.
 */
import { existsSync, statSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const REPO = "malhashemi/opencode-dynamic-workflows"
const BRANCH = "main"
const root = path.join(import.meta.dir, "..", "..", "..")
const source = path.join(root, "README.md")
const target = path.join(import.meta.dir, "..", "README.md")
const check = process.argv.includes("--check")

const HEADER =
  "<!-- Generated from the repository's README.md by packages/plugin/script/sync-readme.ts. Do not edit. -->\n\n"

function rewrite(link: string): string {
  if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(link)) return link
  const [pathPart, hash = ""] = link.split(/(?=#)/, 2)
  const clean = path.posix.normalize(pathPart.replace(/^\.\//, ""))
  if (clean.startsWith("assets/")) return `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${clean}${hash}`
  const full = path.join(root, clean)
  const kind = existsSync(full) && statSync(full).isDirectory() ? "tree" : "blob"
  return `https://github.com/${REPO}/${kind}/${BRANCH}/${clean}${hash}`
}

/** GitHub's anchor for a heading. */
const anchor = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[^\w\- ]/g, "")
    .replace(/ /g, "-")

/** Rewrites Markdown `](link)` and HTML `src="link"` / `href="link"` outside fenced code blocks; drops Mermaid blocks. */
function transform(markdown: string): string {
  const out: string[] = []
  let fence: "code" | "mermaid" | null = null
  let heading = ""
  for (const line of markdown.split("\n")) {
    if (fence === null && /^#{1,6} /.test(line)) heading = line.replace(/^#+ /, "")
    if (/^\s*(```|~~~)/.test(line)) {
      if (fence === null) {
        fence = /^\s*(```|~~~)\s*mermaid\b/.test(line) ? "mermaid" : "code"
        if (fence === "mermaid") out.push(`[See the diagram on GitHub.](https://github.com/${REPO}#${anchor(heading)})`)
        else out.push(line)
      } else {
        if (fence === "code") out.push(line)
        fence = null
      }
      continue
    }
    if (fence === "mermaid") continue
    if (fence === "code") {
      out.push(line)
      continue
    }
    out.push(
      line
        .replace(/\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g, (_, link: string, title: string) => `](${rewrite(link)}${title})`)
        .replace(/\b(src|href)="([^"]+)"/g, (_, attr: string, link: string) => `${attr}="${rewrite(link)}"`),
    )
  }
  return HEADER + out.join("\n")
}

const text = transform(await readFile(source, "utf8"))
if (check) {
  if ((await readFile(target, "utf8").catch(() => "")) !== text) {
    console.error("packages/plugin/README.md is out of date — run bun run packages/plugin/script/sync-readme.ts")
    process.exit(1)
  }
} else await writeFile(target, text)
console.log(`${check ? "checked" : "wrote"} ${path.relative(process.cwd(), target)}`)
