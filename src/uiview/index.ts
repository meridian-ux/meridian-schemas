// @savvifi/meridian-schemas/uiview — the framework-neutral WebRenderer seam.
//
// Every meridian *web* renderer (meridian-web's web-components reference impl,
// meridian-web-react's kit-driven React adapter, any future web renderer)
// implements the `WebRenderer` interface here, binding the canonical
// PanelDescriptor + Theme (from @savvifi/meridian-proto-ts) to a DOM container. The
// transport/runtime contracts (RpcInvoker, RenderContext) live alongside it.
// This barrel is the seam's public surface; it pulls in no renderer.
export * from "./web_renderer.js";
export * from "./transport.js";
// Host-supplied RpcCall admission: which service/method a descriptor may dial,
// and the read/mutation tier the renderer fires it from.
export * from "./admission.js";
// Shared StatPanel computation (the one TS impl of delta/trend/formatting).
export * from "./stat.js";
