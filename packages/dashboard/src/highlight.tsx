/**
 * Syntax highlighting for a unit's Prompt and Answer, through Shiki — lazily.
 *
 * The highlighter (grammars, themes, engine) is dynamically imported on the FIRST render of a `<Code>` block,
 * which in practice means the first expanded unit: Vite splits it into its own chunk, so the shell bundle
 * stays the size it was before Shiki existed. Until (and unless) the highlighter arrives, the text renders as
 * the plain `<pre>` it always was — highlighting is a garnish, never a gate.
 *
 * Language is decided by the text itself: something that parses as JSON is JSON; everything else is treated as
 * markdown, which degrades gracefully to styled prose for plain text (a prompt IS effectively markdown).
 *
 * The engine is the pure-JavaScript one and the grammars are imported individually — no WASM asset, no
 * full-bundle import — so the lazy chunk stays as small as a highlighter can be.
 */
import { createEffect, createSignal, Show, type JSX } from "solid-js"

type Highlight = (code: string, lang: "json" | "markdown") => string

/**
 * Beyond this, highlighting costs more than it says: a tokenizer on hundreds of kilobytes of model output
 * stalls the pane for a garnish. The plain `<pre>` fallback is the honest rendering for such an answer.
 */
const MAX_HIGHLIGHT_CHARS = 100_000

let highlighterPromise: Promise<Highlight | null> | null = null

function loadHighlighter(): Promise<Highlight | null> {
  highlighterPromise ??= (async () => {
    try {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, json, markdown, light, dark] =
        await Promise.all([
          import("shiki/core"),
          import("shiki/engine/javascript"),
          import("@shikijs/langs/json"),
          import("@shikijs/langs/markdown"),
          import("@shikijs/themes/github-light"),
          import("@shikijs/themes/github-dark"),
        ])
      const highlighter = await createHighlighterCore({
        themes: [light.default, dark.default],
        langs: [json.default, markdown.default],
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      })
      return (code, lang) =>
        // Dual-theme output: every token carries its dark-scheme colour as a CSS variable, and `theme.css`
        // flips to it under `prefers-color-scheme: dark` — the same media query the semantic tokens use.
        highlighter.codeToHtml(code, {
          lang,
          themes: { light: "github-light", dark: "github-dark" },
          defaultColor: "light",
        })
    } catch {
      // A chunk that fails to load (offline tab, ad blocker) leaves plain <pre> rendering — never an error.
      return null
    }
  })()
  return highlighterPromise
}

function languageOf(text: string): "json" | "markdown" {
  try {
    JSON.parse(text)
    return "json"
  } catch {
    return "markdown"
  }
}

/**
 * A `<pre>` that upgrades itself to highlighted markup when the highlighter lands.
 *
 * `class` is forwarded so the error styling (`<pre class="error">`) keeps working where highlighting is not
 * wanted — callers choose per block.
 */
export function Code(props: { text: string }): JSX.Element {
  const [html, setHtml] = createSignal<string | null>(null)
  createEffect(() => {
    const text = props.text
    setHtml(null)
    if (text.length > MAX_HIGHLIGHT_CHARS) return
    void loadHighlighter().then((highlight) => {
      if (!highlight) return
      try {
        setHtml(highlight(text, languageOf(text)))
      } catch {
        // One un-tokenizable text keeps its plain rendering; the highlighter stays up for the next one.
      }
    })
  })
  return (
    <Show when={html()} fallback={<pre>{props.text}</pre>}>
      {/* Shiki's own markup: a <pre class="shiki"> whose inline colours are the highlighter's palette — the
          documented exception to the semantic-variables rule (see theme.css). */}
      <div class="code" innerHTML={html() as string} />
    </Show>
  )
}
