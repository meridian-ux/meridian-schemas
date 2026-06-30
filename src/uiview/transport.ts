// Framework-neutral transport + runtime-context contracts for the renderer seam.
//
// These are part of the *contract* surface (consumed by the WebRenderer seam and
// every renderer), not the wasm-DTO surface. They are split out of ./types.ts
// so the fracture can route them — with web_renderer.ts (the seam) — into
// meridian-schemas, while the wasm DTOs in ./types.ts stay with meridian-web.

/** Context the renderer/host expects when building requests. */
export interface RenderContext {
  currentResourcePath: string | null;
  uiIdentity: object | null;
  selectedRow: object | null;
  formValues: Record<string, unknown>;
}

/** Host-supplied transport. Mirrors the Rust RpcInvoker trait. */
export interface RpcInvoker {
  invoke(
    service: string,
    method: string,
    request: object,
  ): Promise<object>;
}
