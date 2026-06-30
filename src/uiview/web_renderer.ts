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
// (meridian.ui.v1) and `Theme` (meridian.theme.v1) from @meridian/proto-ts.
// Transport (`RpcInvoker`) and runtime `RenderContext` are host-facing
// interfaces, not proto messages, so they stay in ./types.ts.

import type { PanelDescriptor } from "@meridian/proto-ts/proto/panel_pb.js";
import type { Theme } from "@meridian/proto-ts/proto/theme_pb.js";
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
