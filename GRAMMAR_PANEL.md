# GrammarPanel — declarative grammars as a first-class panel

`GrammarPanel` (`meridian.ui.v1`, `proto/grammar.proto`) renders **declarative
rendering grammars** — markdown, mermaid, plantuml, graphviz, vega / vega-lite —
through one panel, on every modality.

## The abstraction

A declarative grammar describes **intent** — prose, a diagram, a chart — as a
`(language, source)` pair, not pixels. Because the intent is language-level, each
surface can transcode it to whatever **output format** it can display, at whatever
fidelity it supports. That is the exact shape of meridian's multi-modal descriptor
model, so all of these collapse into a single panel:

```
GrammarPanel {
  language  // MARKDOWN | MERMAID | PLANTUML | GRAPHVIZ | VEGA_LITE | VEGA (open enum)
  source    // the declarative text/spec (one uniform field)
  data?     // optional inline datasets/params (google.protobuf.Struct; mainly Vega)
  title? caption? alt?
}
```

## Content negotiation for grammars

Rendering is **HTTP-style content negotiation**:

| HTTP | GrammarPanel |
|---|---|
| resource | the grammar `(language, source)` |
| `Accept` (what the client can display) | the surface's set of **wired renderers** |
| transcoder | a renderer: mermaid→svg, vega→canvas, md→html/ANSI |
| `406` fallback | `alt`, else `source`-as-text (text displays everywhere) |

The host wires `renderGrammar(opts) → Output | null` (on `MountOptions` + each
provider). It registers a renderer **only for the languages its surface can
display**; that registered set *is* the surface's capability set — data-driven,
no separate capability enum. Returning `null` means "this surface can't render
this language" → the renderer degrades.

`"the TUI can't render vega/mermaid/graphviz"` is **not special-cased**. It's
simply the TUI's Accept set lacking svg/raster, so it degrades automatically —
the same code path a web surface would take for a language it hasn't wired.

## The degradation ladder

When no wired transcoder matches (seam absent or returns `null`), a renderer
walks this ladder — it never blanks, never crashes:

1. **MARKDOWN → a native lightweight render.** Text is universally displayable:
   web emits a minimal md→html (headings / bold / code / lists); the TUI emits
   ANSI-styled text. No library.
2. **else `alt`** — the author's one-line text summary ("Bar chart: requests/day").
3. **else `source`** in a titled/labeled code block (always displayable — it's text).

## Per-language × per-modality

Rich path = a wired host renderer; otherwise the ladder.

| language | web (html/shadcn/meridian-web/mui) | tui | chat (contract) |
|---|---|---|---|
| markdown | md→html (or host) | ANSI text (native) | fenced ` ```markdown ` |
| mermaid | mermaid→svg (host) | ladder | fenced ` ```mermaid ` |
| plantuml | PlantUML server/img (host) | ladder | image/link (host) |
| graphviz | viz.js→svg (host) | ladder | image/link (host) |
| vega/-lite | vega-embed (host) | sparkline-or-ladder | image/link (host) |

`chat` has no renderer package yet; its column is the documented contract.

## Kit contract (what every renderer emits)

Web kits emit a `.mer-grammar` mount carrying `data-grammar-language` and the
source in a `<script type="text/plain" class="mer-grammar-source">` (SSR-safe,
present for host hydration), render `title`/`caption`, invoke `renderGrammar`,
and on `null` walk the ladder. **No** vega/mermaid/graphviz/plantuml/markdown
library is a kit dependency — that is the host's job (the icon-seam pattern).

## Adding a new grammar

1. Add an enum value to `GrammarLanguage` in `proto/grammar.proto` (bump schemas
   minor).
2. Hosts that can display it wire a `renderGrammar` branch for the new language.

No kit change, no new panel, no per-surface special-casing. The abstraction —
grammar = resource, capability set = Accept, renderers = transcoders, text = the
guaranteed fallback — absorbs it.

## Interactivity (Vega selections, mermaid clicks) — the standard seam

Interaction is a **second capability dimension** on top of output format: a
surface has output capabilities (svg / text / image) *and* interaction
capabilities (pointer / keyboard / none). Negotiation + degradation already cover
it — a surface that can't do the interaction (chat = image; a keyboardless TUI)
**degrades to a static snapshot** (Vega renders the spec at its default signal
values), so you lose the live interaction, never the content.

Live interaction rides meridian's **existing** panel seam — `RpcInvoker` +
`RpcCall` / `FieldBinding` — **not** a bespoke event bus:

- The `renderGrammar` host result may be a **`GrammarHandle`** exposing
  `getSignal(name)` + `onSignal(name, cb)` (and `dispose()`), surfacing the
  grammar's named signals (Vega params/selections) to the framework.
- `FieldBinding.source` (rpc.proto) gains a **`signal`** case: a binding
  `{ request_field: "range", source: signal: "brush" }` pulls the current value
  of a named signal — mirroring `row_field` / `form_field`. So a chart selection
  populates an `RpcCall` request and fires through the `RpcInvoker` exactly like a
  Table row-action pulls from the selected row. **No new dispatch path.**
- On a static / degraded surface there are no live signals, so a signal-bound
  call is simply **inert** (documented, not an error).

**SSR / hydration.** Interactive grammars are a hydration concern: SSR emits the
declarative `source` (in the `text/plain` script) + the mount container; the
**client** host runtime (vega-embed, mermaid) brings it alive and exposes the
handle's signals. A purely static export (no client seam wired) shows the
static / degraded form. Interactivity therefore requires the client `renderGrammar`
seam to be wired.

## Relationship to the other panels

`GrammarPanel` and `TerminalPanel` are **specialized** panels. Unlike the six
brand-neutral content shapes (choice / snippet / action / connect-flow /
copy-value / catalog), they do **not** meet the strict cross-modality field-parity
bar — the rich render is web, and other modalities degrade per the ladder above.
That is by design and documented here rather than enforced.
