/**
 * LIVE PROBE fixture — a throwaway opencode plugin whose ONLY job is to test the load-bearing
 * assumption behind wf-discovery-dispatcher's `/workflow` command:
 *
 *   "A plugin can contribute a single static slash command by MUTATING `cfg.command` in the
 *    `config` hook (there is no command-registration hook), and that command surfaces as a
 *    registered / listable command because the Command service builds AFTER plugin.init()."
 *
 * See research-2026-05-29-discovery-dispatcher-surface §1 (Command surface). If this probe passes,
 * the command-injection design holds; if it fails, the dispatcher falls back to the "defer the slash
 * command" option. Throwaway — delete with the probe once the slice is verified.
 */
import type { Plugin } from "@opencode-ai/plugin"

export const PROBE_COMMAND_NAME = "wf_probe"
export const PROBE_TEMPLATE = 'PROBE: run the Workflow named "$ARGUMENTS" by calling the `workflow` tool.'

/**
 * Per-workflow-command probe: inject MULTIPLE commands at once, with different name styles, to learn
 * empirically which characters opencode accepts as a command name (decides how a workflow key like
 * "research:deep" maps to a command). Each value is the candidate command name we try to register.
 */
export const PROBE_NAME_STYLES = ["wf_simple", "deep-research", "research:deep", "research/deep", "rate_pr"]

const ProbePlugin: Plugin = async () => ({
  // The runtime calls this hook with the live, cached Config object and ignores the return (void).
  // We mutate `command` in place; every later reader (incl. the Command service) sees the mutation.
  config: async (cfg) => {
    const c = cfg as { command?: Record<string, unknown> }
    c.command = c.command ?? {}
    c.command[PROBE_COMMAND_NAME] = {
      template: PROBE_TEMPLATE,
      description: "wf-discovery-dispatcher injection probe",
    }
    // Multi-injection + special-char name probe: register one command per candidate name style.
    for (const name of PROBE_NAME_STYLES) {
      c.command[name] = {
        template: `PROBE per-workflow command "${name}". Context: $ARGUMENTS`,
        description: `probe command (${name})`,
      }
    }
  },
})

export default { id: "wf-command-injection-probe", server: ProbePlugin }
