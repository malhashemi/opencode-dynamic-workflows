/**
 * Writes `docs/protocol/schemas/<Name>.json` and `docs/protocol/openapi.json` from the protocol's zod schemas (the
 * single source of truth).
 * `--check` fails when the committed files are out of date.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import { z } from "zod"

import { PROTOCOL_VERSION, PUBLISHED_SCHEMAS } from "../src/protocol"
import { openApiDocument } from "../src/protocol/openapi"

const out = path.join(import.meta.dir, "..", "docs", "protocol", "schemas")
const check = process.argv.includes("--check")
await mkdir(out, { recursive: true })
const stale: string[] = []
for (const [name, schema] of Object.entries(PUBLISHED_SCHEMAS)) {
  const json = {
    $id: `https://opencode-dynamic-workflows/protocol/v${PROTOCOL_VERSION}/${name}.json`,
    title: name,
    ...z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" }),
  }
  const text = `${JSON.stringify(json, null, 2)}\n`
  const file = path.join(out, `${name}.json`)
  if (check) {
    if ((await readFile(file, "utf8").catch(() => "")) !== text) stale.push(name)
  } else await writeFile(file, text)
}
// The Gateway's OpenAPI document, beside the schemas.
const openapiFile = path.join(out, "..", "openapi.json")
const openapiText = `${JSON.stringify(openApiDocument(), null, 2)}\n`
if (check) {
  if ((await readFile(openapiFile, "utf8").catch(() => "")) !== openapiText) stale.push("openapi.json")
} else await writeFile(openapiFile, openapiText)
if (stale.length) {
  console.error(`protocol schemas out of date: ${stale.join(", ")} — run bun run script/protocol-schemas.ts`)
  process.exit(1)
}
console.log(
  `${check ? "checked" : "wrote"} ${Object.keys(PUBLISHED_SCHEMAS).length} schemas in ${path.relative(process.cwd(), out)}`,
)
