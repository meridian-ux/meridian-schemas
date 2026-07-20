# meridian-schemas

The framework- and brand-neutral **root of the meridian design language**. Every
renderer and every emitter depends on this module; it depends on none of them.

It ships three things:

- **The proto contracts** — `meridian.ui.v1.PanelDescriptor` (semantics: which RPC
  to call, how to map the response into rows/columns/actions, what bespoke panels
  to host) and `meridian.theme.v1.Theme` (style). Semantics and style are
  orthogonal proto layers, so a renderer or a skin can depend on one without the
  other. See [`proto/`](proto/).
- **`@savvifi/meridian-proto-ts`** — the canonical TypeScript surface, generated from the
  protos via [protobuf-es](https://github.com/bufbuild/protobuf-es)
  (`//bazel:proto_es.bzl`). The single source the web renderers and the aion
  emitter consume.
- **`@savvifi/meridian-schemas` (the WebRenderer seam)** — the framework-neutral
  `mount(container, descriptor, theme, invoker) → { update, unmount }` interface
  plus the host transport/runtime contracts (`RpcInvoker`, `RenderContext`). Every
  *web* renderer implements it: `meridian-web` (web-components, reference),
  `meridian-web-react` (kit-driven React), and any future web renderer. Because
  the seam lives here, those renderers depend on `meridian-schemas` rather than on
  each other. See [`src/uiview/`](src/uiview/).

Language bindings for the non-web renderers (Java/JavaFX, Rust/TUI, Swift/SwiftUI)
and the wasm web-components core live in their own renderer repos, each depending
back on these protos.

## Layering

```
  aion graph ──emits──▶ PanelDescriptor + Theme  (meridian-schemas)
                              │
                   WebRenderer seam (neutral TS)
                    ├── meridian-web        (web-components, reference)
                    ├── meridian-web-react  (React · swappable ComponentKit)
                    ├── meridian-tui · meridian-javafx · meridian-swiftui
                    └── …
```

Dependency direction is strictly one-way: renderers and emitters → `meridian-schemas`.
The module stays brand- and framework-neutral; brand (a `Theme`) and framework
(the kit/renderer) are supplied by consumers.

## Build

```bash
bazel build //...        # proto contracts, @savvifi/meridian-proto-ts, the seam
```

Codegen uses a prebuilt `protoc` (`//bazel:protoc_prebuilt.bzl`) so it never
compiles protoc from source.

## Gates

Two checks run on every PR (`.github/workflows/ci.yml`). Both exist because the
failure they catch has already shipped.

```bash
python3 tools/check_versions.py      # published versions move in lockstep
node --test "tools/*.test.mjs"       # the mirror gate still catches divergence
```

### Mirroring `meridian.ui.v1`

Some repos carry a small hand-maintained copy of a few `meridian.ui.v1` messages
instead of depending on this module — `nav_tree.proto` imports nothing but
`field_behavior` precisely so a ~40-line mirror is possible. That is supported.
A mirror that silently *disagrees* with the contract is not: a shipped mirror
transposed `GetPanelRequest`'s field numbers, and because both fields are wire
type 2 a canonical client and that mirror parse each other's tag-1 field with no
error and get garbage.

If you maintain a mirror, run the gate in your own CI:

```bash
# your mirror -> a descriptor set (any toolchain: protoc, Bazel's proto_library,
# tonic_build's committed FDS — a FileDescriptorSet is the interchange format)
protoc -I proto --descriptor_set_out=mirror.binpb --include_imports \
  meridian/ui/v1/layout_service.proto

node tools/mirror_conformance.mjs \
  --canonical canonical.binpb \
  --mirror    mirror.binpb \
  --allowlist mirror-deviations.json     # optional
```

Only messages present in **both** are compared. Exit code is non-zero on divergence.

There are two kinds of mirror, and they want different strictness:

| kind | flag | a *missing* field means |
|---|---|---|
| a deliberate hand-written subset (e.g. a ~40-line `nav_tree` copy) | *(default)* | fine — you don't use it |
| a **vendored copy of the full tree** | `--require-complete` | drift, and a silent one |

In the second case a missing field is a real defect: proto decoders ignore unknown
fields, so a producer that sets `Slot.sub_view` against a consumer vendored before
that field existed gets a slot with no panel and **no error**. `REQUIRED` does not
save you — `field_behavior` is documentation only in proto3, and no runtime enforces
it. Measured across the vendored trees in this fleet: 11–16 fields behind canonical
each, with zero disagreements — stale, never wrong. The hand-written subset mirror
had the opposite profile: current, but with two transposed field numbers.

A deliberate divergence is legal but must be written down, which turns a silent
landmine into a reviewable line:

```json
{ "deviations": [
    { "message": "meridian.ui.v1.GetPanelRequest",
      "field": "panel_id",
      "reason": "legacy plugin surface returns an opaque bundle envelope" }
] }
```

`"field": "*"` waives a whole message.
