# Meridian primitives — proposal for the next release

A shortlist of new (and matured) primitives, each **designed cross-modally** — web,
TUI, and chat — per meridian's content-negotiation philosophy (a descriptor names
*intent*; each surface transcodes it to whatever it can display, degrading down a
ladder rather than blanking). Nothing here is web-only.

Motivation is concrete: building the fastverk RBE console (Vega dashboards +
grouped tabbed nav) hit §1–§5 host-side, and revamping the fastverk **Workspaces**
console (a resource manager: cards, lifecycle actions, create/edit forms, a
key→value files editor, delete-confirms) hit §6–§8 the same way — every one of them a
custom adhoc handler + hand-wired REST calls. The point of this doc is to pull those
workarounds *up* into the framework so every consumer and every renderer gets them.

**Principle for all of the below:** a primitive is only "in meridian" if it has a
proto shape, a degradation ladder, and a rendering story for **all three**
modalities. If it only makes sense on web, it stays a host seam (like `renderGrammar`).

---

## 1. `NavTree` — hierarchical navigation (flagship)

**Problem.** The left rail / nav is 100% host-owned today: `PanelBundle` is a flat
`repeated PanelDescriptor` with no grouping, so every renderer (web rail, TUI list,
chat menu) reinvents structure, and consumers can't express "these panels are one
group." The RBE section had to collapse `Cache` + `Cache — details` into tabs
host-side because there was nowhere to say "these belong together."

**Proposal.** A declarative navigation tree — sections → groups → leaves — where a
leaf targets a panel or a view.

```proto
message NavTree {
  repeated NavNode roots = 1;   // top-level sections, in order
}
message NavNode {
  string id = 1;                // stable key (routing + telemetry)
  string label = 2;             // resolved copy
  string icon = 3;              // icon-seam key (optional)
  oneof target {                // a leaf targets exactly one surface…
    string panel_id = 4;        //   a PanelDescriptor in the bundle
    string view_id = 5;         //   a ViewDescriptor (§2)
  }
  repeated NavNode children = 6; // …or is a group with children (no target)
  bool default_open = 7;         // groups: expanded by default
  string badge = 8;              // optional count/status pill (e.g. "3")
}
```

**Per modality.**
- **web** — a collapsible rail: sections as headers, groups as expandable rows,
  leaves as items; `badge` as a pill. (Replaces botnoc's hand-rolled `buildRail`.)
- **tui** — a tree widget: arrow-keys navigate, space/enter expand/collapse, the
  active leaf drives the right pane. `badge` after the label.
- **chat** — a nested numbered menu ("**Builds** — 1) Cache 2) Workers … 1.1 Cache
  details"); selecting a number loads that panel/view. Depth flattens to indented
  numbering.

**Ladder.** A renderer that can't do a tree renders the leaves flat (today's
behavior) — never worse than now.

---

## 2. `ViewDescriptor` / `renderView` — mature the tabbed + two-column layouts

`ViewDescriptor` + `renderView` already exist (0.5.0), but two gaps forced the RBE
tabs to be host-side:

**2a. TabbedLayout is a non-interactive stub.** The web `view_renderer.ts` renders
tabbed slots *stacked* with labels ("an interactive web-components tab strip is a
follow-up"). **Proposal:** a real tab strip per modality — web: a clickable tab bar
(one slot visible at a time); tui: a tab header with `[`/`]` or number-key switching
(or a pager); chat: each tab as a titled sub-section (all shown, since chat has no
"active tab"). Same for a real two-column split on web/tui (chat linearizes).

**2b. `renderView` doesn't thread the host seams.** `renderSlot` calls `renderPanel`
without `renderGrammar` (or `renderIcon`, …), so a chart/grammar panel inside a view
silently degrades to alt-text. **Proposal:** `RenderViewOptions` must carry and
forward *every* `RenderPanelOptions` host seam to each slot. (One-line-ish per
renderer; without it, views can't hold charts — which is most dashboards.)

With 2a+2b, "group Cache into Charts | Details tabs" becomes a `ViewDescriptor`
(TabbedLayout, two slots) instead of host JS.

---

## 3. `populate` on `GrammarPanel` and `StatPanel` — fetch-driven visuals

**Problem.** Neither carries an RpcCall, so live data can't flow the meridian way:
- `GrammarPanel` (charts) had to fetch via a **Vega `data.url`** baked into the
  spec — bypassing the `RpcInvoker`, gateway-coupled, and invisible to non-Vega
  surfaces.
- `StatPanel` (KPI tiles) is static — a *live* KPI can't use it, so the RBE overview
  is Vega text-marks instead of StatPanels.

**Proposal.** Add an optional `RpcCall populate` (mirroring `TablePanel.populate`) to
both. The renderer runs it through the `RpcInvoker` and injects the result: into
Vega's named `data` (web grammar), the sparkline series (tui/stat), the KPI
value/`series` (stat), or a chat table/image. Charts + stats become first-class
fetch-driven panels, and the same descriptor works on every surface (a chart with
`populate` renders as a chart on web, a sparkline on tui, a rendered image or a
values table on chat) instead of only where a Vega `data.url` resolves.

---

## 4. `ChartSpec` — portable chart intent (charts on every surface)

**Problem.** `GrammarPanel` + Vega is the only chart path, and it's **web-only**:
tui/chat degrade to `alt`/sparkline/ladder because they can't run a Vega spec. Most
of the RBE dashboard is therefore invisible outside web.

**Proposal.** A brand-neutral, modality-agnostic chart *intent* — enough to render
natively anywhere, with Vega as the web transcoder (not the wire format):

```proto
message ChartSpec {
  ChartMark mark = 1;   // LINE | AREA | BAR | POINT | STAT
  Encoding x = 2;       // field + type (temporal | quantitative | nominal | ordinal)
  Encoding y = 3;
  Encoding series = 4;  // optional color/series split
  Encoding facet = 5;   // optional small-multiples
  RpcCall populate = 6; // §3: the data source
  string title = 7;
  string y_format = 8;  // "%", "bytes", "duration", …
}
```

**Per modality.** web → transcode to Vega-Lite (host `renderChart` seam, same shape
as `renderGrammar`); tui → braille/block sparklines, bar rows, a stat number;
chat → a server-rendered PNG or a compact values table. Power users keep full Vega
via `GrammarPanel`; `ChartSpec` is the portable 90% that renders everywhere. This is
the biggest lever for "not just web."

---

## 5. `Source::Signal` — the cross-modal selection story

0.5.0 added `Source::Signal` (a Vega selection value feeding an `RpcCall`), which is
inherently web/vega. **Proposal:** define its cross-modal semantics so a
`signal`-bound action isn't inert off-web — tui exposes the "current selection" via
row-select / a focused mark; chat via a `ChoicePanel`-style pick. Same binding,
surfaced through each modality's native affordance (or genuinely inert on a static
render, which is already the documented fallback).

---

## 6. `ResourceCard` + `ActionSet` — declarative cards with lifecycle actions

**Problem.** Building the fastverk **Workspaces** console (a card per dev workspace:
phase badge, metadata chips, an idle countdown, launch buttons, and a
suspend/resume/reconfigure/delete action row) had to be **100% host-side** — a custom
adhoc handler drawing HTML + wiring every button to a REST call. Meridian has no
primitive for "a resource rendered as a card with a set of actions," so every console
that manages resources (workspaces, deployments, builds, agents) reinvents it, and
none of it renders off-web.

**Proposal.** A `ResourceCard` descriptor (title, subtitle, an icon, a status
`badge`, a `repeated MetaField` chip row) carrying an `ActionSet` — a list of
`Action { id, label, style: DEFAULT|PRIMARY|DANGER, RpcCall invoke, ConfirmSpec
confirm? }`. A `CardGridPanel { RpcCall populate, ResourceCardTemplate }` binds a row
list to the template (like `TablePanel`, but cards).

```proto
message Action {
  string id = 1;
  string label = 2;
  ActionStyle style = 3;         // DEFAULT | PRIMARY | DANGER
  RpcCall invoke = 4;            // run through the RpcInvoker
  ConfirmSpec confirm = 5;       // optional destructive-action guard (§8)
  string visible_when = 6;       // simple predicate over the row (e.g. "phase==Suspended")
}
message ActionSet { repeated Action actions = 1; }
```

**Per modality.** web — a card with a button row (`DANGER` = the red action,
confirm-gated). tui — a list row; actions on a context menu / number keys, the active
row driving them. chat — the resource as a block with actions as buttons or a numbered
pick. `visible_when` is how "Resume only when Suspended" degrades everywhere.

**Ladder.** A renderer without cards falls back to a `TablePanel` view of the same
rows with the actions as a trailing column — never worse than today.

---

## 7. `FormPanel` / `CreateDialog` — declarative create/edit forms

**Problem.** The Workspaces create dialog, the reconfigure dialog, and the config
editor (including a **key→value files map** editor) are all host-side modals with
hand-wired submit → RPC. `LroPanel` submits *one* action but isn't a general
create/edit **form** with typed fields, and there's no map/list field type at all.

**Proposal.** A `FormPanel { repeated FormField fields, RpcCall submit, RpcCall
prefill? }` where `FormField` is a typed input: `TEXT | SELECT (with
EnumSelection.options_source) | TEXTAREA | KEY_VALUE_MAP | TOGGLE`, each with
label/placeholder/required/pattern. `prefill` populates an edit form; `KEY_VALUE_MAP`
is the reusable "mounted files / labels / env" editor.

**Per modality.** web — a modal (or inline) form. tui — a field-stack the user tabs
through. chat — a guided Q&A that collects the fields, then submits. The `SELECT`
already has cross-modal precedent (`EnumSelection.options_source`, 0.4.0).

---

## 8. `ConfirmSpec` — the destructive-action guard

**Problem.** Every delete in the console re-implements a confirm modal host-side.

**Proposal.** A tiny `ConfirmSpec { title, message, confirm_label, bool destructive }`
attached to an `Action` (§6). The renderer gates the `invoke` behind it: web — a confirm
dialog; tui — a yes/no prompt; chat — a "reply `yes` to confirm" turn. Small, but it's
the difference between "delete" being safe on every surface vs. web-only.

---

## Priority / sequencing

1. **`NavTree`** (§1) + **renderView maturation** (§2) — the structural wins; they
   remove the two biggest host-side workarounds (rail + tabs) and are pure additions.
2. **`populate` on Grammar/Stat** (§3) — small proto add, big ergonomics win; unblocks
   live charts/KPIs the meridian way.
3. **`ResourceCard` + `ActionSet` (§6) + `ConfirmSpec` (§8)** — the resource-management
   pair; together they remove the biggest host-side surface (the whole Workspaces
   manager: cards, lifecycle actions, delete-confirm) and generalize to every
   resource console (builds, agents, deployments). `ConfirmSpec` is tiny and rides §6.
4. **`FormPanel` / `CreateDialog` (§7)** — the create/edit forms, incl. the
   `KEY_VALUE_MAP` field; matures `LroPanel` into a general typed form.
5. **`ChartSpec`** (§4) — the ambitious cross-modal charting primitive; largest scope,
   largest payoff for non-web surfaces.
6. **Signal cross-modal semantics** (§5) — smallest; formalizes what 0.5.0 started.

Each is additive (new fields / messages), so it's a clean MINOR bump per the registry
flow. §1–§3 (and §6/§8, which the Workspaces console just proved out host-side) are the
recommended next-release slice.
