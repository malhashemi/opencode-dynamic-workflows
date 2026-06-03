/**
 * LIVE DIAGNOSIS — two experiments against one booted opencode, instrumented with the event stream.
 *
 *  EXP 1 (ask-hang): does an UNANSWERED permission "ask" in a CHILD session hang the prompt, and does it
 *    surface (publish a permission event)? Trigger = a `general` child reading a `*.env` file (the `read
 *    "*.env":"ask"` default gate — NOT neutralised by the user's `external_directory:"allow"` override).
 *    Outcomes:
 *      - HANG + a permission event for the child  → ask-hang CONFIRMED (then reply "once" → should unblock).
 *      - HANG + NO permission event for the child → a DIFFERENT hang (loop/stream) — matches "nothing surfaced".
 *      - completes                                → the ask did not trigger (gate allowed / model skipped it).
 *
 *  EXP 2 (explore+schema): WHY does `explore` + schema fail? Source says StructuredOutput is never permission-
 *    gated, so the failure should be BEHAVIOURAL ("model did not produce structured output"), not a denial.
 *    We run it, then read the child transcript and check: any permission event for the child? a StructuredOutput
 *    tool part? what is info.error?
 *
 * Run:  bun run packages/plugin/test/live/diagnosis.repro.live.ts
 */
import { createOpencode } from "@opencode-ai/sdk/v2"
import { writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"

const MODEL = { providerID: "anthropic", modelID: "claude-haiku-4-5" }
const HANG_WAIT_MS = 45_000
const ENV_FILE = join(process.cwd(), "wf-diag-secret.env")

type Perm = { type: string; sessionID?: string; requestID?: string; permission?: string; patterns?: unknown; t: number }

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> {
  return Promise.race([
    p.then((value) => ({ done: true as const, value })),
    new Promise<{ done: false }>((r) => setTimeout(() => r({ done: false }), ms)),
  ])
}

async function main() {
  const port = 40000 + Math.floor((Date.now() % 20000))
  console.log("• booting opencode (inherits your ~/.config/opencode config + plugins)…")
  const { client, server } = await createOpencode({ port, config: { logLevel: "ERROR" }, timeout: 30000 })
  const t0 = Date.now()

  // --- event instrument: collect every permission.* event with its session id ---
  const perms: Perm[] = []
  const seenTypes = new Set<string>()
  const sub = await client.event.subscribe()
  ;(async () => {
    for await (const ev of sub.stream as AsyncGenerator<any>) {
      seenTypes.add(ev?.type)
      if (typeof ev?.type === "string" && ev.type.startsWith("permission")) {
        const p = ev.properties ?? {}
        const rec: Perm = { type: ev.type, sessionID: p.sessionID, requestID: p.id ?? p.requestID ?? p.permissionID, permission: p.permission, patterns: p.patterns, t: Date.now() - t0 }
        perms.push(rec)
        console.log(`    <event ${ev.type}> session=${rec.sessionID} perm=${rec.permission} patterns=${JSON.stringify(rec.patterns)} (+${rec.t}ms)`)
      }
    }
  })().catch(() => {})

  try {
    const parent = (await client.session.create({ title: "wf-diagnosis" })).data
    if (!parent?.id) throw new Error("failed to create parent session")
    console.log(`  parent = ${parent.id}`)

    console.log("• warming up (absorb cold start)…")
    const warm = await raceTimeout(
      client.session.prompt({ sessionID: parent.id, agent: "general", model: MODEL, parts: [{ type: "text", text: "Reply with the single word: warm" }] }),
      120_000,
    )
    console.log(`  warmup: ${warm.done ? "OK" : "HANG (cold start exceeded 120s)"}\n`)

    // ============================ EXPERIMENT 1: ask-hang ============================
    console.log("══ EXP 1: child reads a *.env file → expect `read \"*.env\":\"ask\"` gate ══")
    writeFileSync(ENV_FILE, "DIAG_TOKEN=do-not-care\n")
    const child1 = (await client.session.create({ parentID: parent.id, title: "exp1-child" })).data
    if (!child1?.id) throw new Error("failed to create exp1 child session")
    console.log(`  child1 = ${child1.id}`)
    const prompt1 = client.session.prompt({
      sessionID: child1.id,
      agent: "general",
      model: MODEL,
      parts: [{ type: "text", text: "Use the read tool to read the file 'wf-diag-secret.env' in the current directory, then reply with its exact contents." }],
    })
    void prompt1.catch(() => {})
    const r1 = await raceTimeout(prompt1, HANG_WAIT_MS)
    const child1Perms = perms.filter((p) => p.sessionID === child1.id)

    if (!r1.done) {
      if (child1Perms.length > 0) {
        console.log(`  ✓ RESULT: HANG + ${child1Perms.length} permission event(s) for the child → ASK-HANG CONFIRMED.`)
        const ask = child1Perms[0]
        if (ask?.requestID) {
          console.log(`  → replying "once" to permission ${ask.requestID} to prove it was the blocker…`)
          await client.permission.reply({ requestID: ask.requestID, reply: "once" }).catch((e: unknown) => console.log("    reply threw:", e))
          const r1b = await raceTimeout(prompt1, 30_000)
          console.log(`  → after reply: ${r1b.done ? "PROMPT COMPLETED ✓ (the ask was THE blocker)" : "still hung ✗ (reply did not unblock — look deeper)"}`)
        }
      } else {
        console.log(`  ⚠ RESULT: HANG but NO permission event for the child → NOT an ask. A different never-return path (uncapped loop / stalled stream). This is what "nothing surfaced" looks like.`)
        await client.session.abort({ sessionID: child1.id }).catch(() => {})
      }
    } else {
      console.log(`  ⚠ RESULT: completed (no hang). The .env ask did not fire (model skipped the read, or gate allowed). child1 perms seen: ${child1Perms.length}`)
    }
    console.log("")

    // ============================ EXPERIMENT 2: explore + schema ============================
    console.log("══ EXP 2: explore + json_schema → expect BEHAVIOURAL fail (not a permission denial) ══")
    const child2 = (await client.session.create({ parentID: parent.id, title: "exp2-child" })).data
    if (!child2?.id) throw new Error("failed to create exp2 child session")
    console.log(`  child2 = ${child2.id}`)
    const r2 = await raceTimeout(
      client.session.prompt({
        sessionID: child2.id,
        agent: "explore",
        model: MODEL,
        parts: [{ type: "text", text: "Rate how hard concurrency is from 0 to 10." }],
        format: { type: "json_schema", schema: { type: "object", properties: { score: { type: "number" } }, required: ["score"], additionalProperties: false } },
      }),
      HANG_WAIT_MS,
    )
    const child2Perms = perms.filter((p) => p.sessionID === child2.id)
    if (!r2.done) {
      console.log(`  RESULT: explore+schema HUNG (perms for child2: ${child2Perms.length}).`)
      await client.session.abort({ sessionID: child2.id }).catch(() => {})
    } else {
      const info = (r2.value as any)?.data?.info
      const parts = (r2.value as any)?.data?.parts ?? []
      const toolNames = parts.filter((p: any) => p.type === "tool").map((p: any) => p.tool ?? p.name)
      const hasStructuredCall = toolNames.some((n: string) => n === "StructuredOutput")
      console.log(`  RESULT: explore+schema completed.`)
      console.log(`    info.error      = ${info?.error ? JSON.stringify(info.error) : "(none)"}`)
      console.log(`    info.structured = ${info?.structured ? JSON.stringify(info.structured) : "(none)"}`)
      console.log(`    tool parts      = ${JSON.stringify(toolNames)} (StructuredOutput called: ${hasStructuredCall})`)
      console.log(`    child2 perm evts= ${child2Perms.length} (a denial would show here)`)
      console.log(
        child2Perms.length === 0 && !hasStructuredCall
          ? `  → INTERPRETATION: behavioural — model never emitted StructuredOutput, NO permission gate. Premise "explore denies StructuredOutput" REFUTED.`
          : `  → INTERPRETATION: re-examine (a permission event or a StructuredOutput call appeared).`,
      )
    }
    console.log("")

    console.log(`• event types observed this run: ${[...seenTypes].sort().join(", ")}`)
  } finally {
    rmSync(ENV_FILE, { force: true })
    await server.close()
  }
}

main().catch((e) => {
  console.error("diagnosis threw:", e)
  process.exitCode = 1
})
