// The framework-neutral web-renderer seam.
//
// Every meridian *web* renderer implements this one interface: the built-in
// web-components renderer (`webComponentsRenderer` in ./web_components_renderer.ts,
// a thin bridge over `renderPanel`), the planned React adapter
// (`meridian-web-react`, which binds a swappable ComponentKit such as MUI or
// shadcn), and any future web renderer. A host picks an implementation and
// `mount`s a PanelDescriptor into a DOM container; swapping the look or the
// framework is swapping the implementation, not the descriptor or the theme.
//
// This is the web analogue of meridian's per-platform renderer contract: the
// TUI / JavaFX / SwiftUI renderers each bind the same (descriptor, theme) pair
// to their native widget tree. On the web there is more than one way to do that
// (web-components, React + MUI, React + shadcn, …), so the binding is a seam
// rather than a single renderer.
//
// The seam speaks the *canonical* generated types: `PanelDescriptor`
// (meridian.ui.v1) and `Theme` (meridian.theme.v1) from @savvifi/meridian-proto-ts.
// Transport (`RpcInvoker`) and runtime `RenderContext` are host-facing
// interfaces, not proto messages, so they stay in ./types.ts.

import type { PanelDescriptor } from "@savvifi/meridian-proto-ts/proto/panel_pb.js";
import type { Theme } from "@savvifi/meridian-proto-ts/proto/theme_pb.js";
import type { RenderContext, RpcInvoker } from "./transport.js";

/** A handle to one mounted panel, returned by {@link WebRenderer.mount}. */
export interface PanelHandle {
  /** Re-render in place with a new descriptor (same container + transport). */
  update(descriptor: PanelDescriptor): void | Promise<void>;
  /** Tear the panel down and release listeners / resources. */
  unmount(): void;
}

/** The web-components reference impl's adhoc-handler factory shape. */
export type AdhocDomFactory = (
  container: HTMLElement,
  descriptor: PanelDescriptor,
) => void;

/**
 * Impl-specific AdhocPanel handler registry: `handler_id` -> a factory. The
 * factory type is impl-specific (DOM nodes for web-components, React elements
 * for the React adapter), so it is a type parameter.
 */
export type AdhocRegistry<TFactory = AdhocDomFactory> = Record<string, TFactory>;

/** Everything a web renderer needs to mount one panel. */
export interface MountOptions<TTheme = Theme, TFactory = AdhocDomFactory> {
  /** DOM node the renderer draws into. The renderer owns the subtree. */
  container: HTMLElement;
  /** The panel to render (meridian.ui.v1.PanelDescriptor). */
  descriptor: PanelDescriptor;
  /** Host transport for the populate / action RPCs. */
  invoker: RpcInvoker;
  /** Active theme/skin (meridian.theme.v1). Each impl binds it natively. */
  theme?: TTheme;
  /** Runtime context (active resource path, identity, form values). */
  context?: RenderContext;
  /** Bespoke (AdhocPanel) handlers keyed by `handler_id`. */
  adhoc?: AdhocRegistry<TFactory>;
  /**
   * Host glyph resolver: maps an `icon` KEY (ChoiceOption.icon, Affordance.icon,
   * ConnectTarget.icon, CatalogItem.icon — brand-neutral keys the descriptor
   * carries, e.g. "github", "download") to a renderer-native glyph. The
   * "renderer draws, host wires" icon seam: the descriptor names the icon, the
   * host supplies the vector. Return type is renderer-specific (a ReactNode for
   * the React adapter, an HTMLElement for the web-components renderer), so it is
   * loosely typed here. Absent ⇒ renderers emit the key as a `data-icon`
   * attribute (never dropped) and draw no glyph.
   */
  renderIcon?: (key: string) => unknown;
  /**
   * Host transcoder for a GrammarPanel — a declarative grammar (markdown /
   * mermaid / plantuml / graphviz / vega). This is the surface's capability set:
   * the host wires it ONLY for languages this surface can display, returning a
   * live result for those, or `null`/nothing for the rest → the renderer degrades
   * down the ladder (native markdown → `alt` → source text). Kits import no
   * grammar library.
   *
   * The return is a LIVE result, not just markup: a renderer-native node
   * (HTMLElement for web-components, ReactNode for React) that is already
   * interactive once mounted (vega-embed tooltips / zoom / brush "just work"), OR
   * a {@link GrammarHandle} whose `element`/`node` is mounted and whose optional
   * `dispose` frees the runtime, and whose `getSignal`/`onSignal` expose the
   * grammar's live selections to the FRAMEWORK — which resolves them the
   * meridian-idiomatic way (a `signal` FieldBinding source, rpc.proto) so an
   * interactive selection fires an RpcCall through the RpcInvoker like every
   * other panel action. A plain node return is equally valid. Loosely typed
   * (renderer-specific); `data` is the decoded google.protobuf.Struct.
   */
  renderGrammar?: (opts: {
    language: string;
    source: string;
    data?: unknown;
  }) => unknown;
}

/**
 * A live handle a host MAY return from {@link MountOptions.renderGrammar} for an
 * interactive grammar (chiefly Vega). `element`/`node` is what the renderer
 * mounts; `dispose` frees the runtime on unmount. `getSignal`/`onSignal` expose
 * the grammar's named signals (Vega params/selections) so the framework can
 * resolve a `signal` FieldBinding (rpc.proto) — a chart selection thus populates
 * an RpcCall request and fires through the RpcInvoker, exactly like a Table
 * row-action pulls from the selected row. No bespoke event bus. A plain node
 * return is equally valid (the simpler, non-signal form). Interaction is a second
 * capability dimension: a surface that can't do it degrades to a static snapshot
 * (no live signals → a signal-bound call is inert), never losing content.
 */
export interface GrammarHandle {
  /** The node to mount — HTMLElement (web-components) or ReactNode (React). */
  element?: unknown;
  /** Alias of `element` for React-flavored hosts. */
  node?: unknown;
  /** Cleanup on unmount / re-render (dispose the chart view + listeners). */
  dispose?(): void;
  /** Read a named signal's current value — resolves a `signal` FieldBinding. */
  getSignal?(name: string): unknown;
  /** Subscribe to a named signal; the framework re-fires signal-bound RpcCalls. */
  onSignal?(name: string, cb: (value: unknown) => void): void;
}

/**
 * The seam. Implementations consume the same PanelDescriptor + Theme and differ
 * only in how they paint the DOM. See `webComponentsRenderer`
 * (./web_components_renderer.ts) for the reference (React-free) implementation.
 */
export interface WebRenderer<TTheme = Theme, TFactory = AdhocDomFactory> {
  /** Stable id for the impl, e.g. "web-components" / "react-mui". */
  readonly id: string;
  /** Mount one panel into `container`; returns a handle to update / unmount it. */
  mount(
    opts: MountOptions<TTheme, TFactory>,
  ): PanelHandle | Promise<PanelHandle>;
}
