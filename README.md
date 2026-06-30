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
