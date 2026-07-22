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

/** Handle onto a live subscription. Idempotent: closing twice is not an error. */
export interface StreamSubscription {
  close(): void;
}

/**
 * Host-supplied transport for SERVER-STREAMING methods — the streaming peer of
 * `RpcInvoker`, and what a `StreamPanel` renders through.
 *
 * Meridian names the intent (subscribe to this method, with this request); the
 * host owns the wire. A host may back this with server-sent events, a WebSocket,
 * a gRPC stream, or a poll loop, and the same descriptor renders either way.
 *
 * `onFrame` receives one streamed frame — a string when the host's transport
 * yields bare text, an object when it yields structured envelopes
 * (`StreamPanel.line_field` selects the text out of the latter). `onError` is
 * terminal for that subscription; a host that reconnects internally simply never
 * calls it. A renderer that receives no invoker degrades per the StreamPanel
 * ladder (a bounded snapshot, else the placeholder) — it never blanks.
 */
export interface StreamInvoker {
  subscribe(
    service: string,
    method: string,
    request: object,
    handlers: {
      onFrame(frame: string | object): void;
      onError?(err: Error): void;
      onClose?(): void;
    },
  ): StreamSubscription;
}
