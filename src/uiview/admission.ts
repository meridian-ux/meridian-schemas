// RpcCall admission — the host-supplied policy that decides which service/method
// a descriptor is allowed to dial.
//
// WHY THIS EXISTS. A ViewDescriptor is DATA, and data now arrives from places
// that are not the application author: meridian-mcp accepts a model-authored
// descriptor and validates it for SHAPE ONLY (prost-reflect with unknown fields
// denied), which proves the document is well-formed and proves nothing about
// what it points at. Meanwhile the renderer hands `RpcCall.service` /
// `RpcCall.method` straight to the host's RpcInvoker, and some hosts back that
// invoker with an authenticated session. Shape validation plus an authenticated
// transport is not an access-control decision; this module is.
//
// ── The load-bearing rule: INTENT IS STRUCTURAL ──────────────────────────────
//
// There is no read/write signal anywhere in the schema. `RpcCall` is
// {service, method, bindings}; `Action` is {id, label, call, placement} and
// `placement` is PRIMARY/ROW/HEADER/OVERFLOW — where the affordance draws, not
// what it does — even though its own doc comment says actions cover
// "edit / clone / delete / export".
//
// So the tier is taken from the CALLSITE, never from the descriptor:
//
//   read      TablePanel.populate, Slot.sub_view_populate, detail fetch,
//             gallery populate            — fires automatically on mount
//   mutation  Action.call, form submit, LRO start
//                                         — only from a user gesture
//
// Because the tier is fixed by which code path the renderer took, a descriptor
// cannot promote a read into a mutation. That is the whole security property.
//
// ⛔ DO NOT "FIX" THIS BY ADDING A `mutating` FIELD TO RpcCall. A field on the
// descriptor is authored by whoever authored the descriptor — the untrusted
// party — so a model that wanted to mutate would simply set it false. The
// tier must remain something the descriptor cannot express.

/** Which callsite tier a call is being fired from. Set by the renderer. */
export type RpcTier = "read" | "mutation";

/** Why a call was refused. Passed to {@link RpcAdmission.onDenied}. */
export interface AdmissionDenial {
  tier: RpcTier;
  service: string;
  method: string;
  /** Human-readable cause, already suitable for a log line or an overlay. */
  reason: string;
}

/**
 * What a descriptor is allowed to dial, declared by the HOST.
 *
 * Entries are `"<fully.qualified.Service>/<Method>"`, with `*` accepted as the
 * method (`"acme.v1.Orders/*"`, the whole service) or as the entire entry
 * (`"*"`, everything at that tier). Matching is exact and case-sensitive
 * otherwise — a service name is a proto identifier, not a URL.
 */
export interface RpcAdmission {
  /**
   * Methods reachable from a read callsite. OMITTED means "any", which is what
   * every host does today: populate already fires freely, so defaulting reads
   * closed would break every existing consumer on upgrade without closing the
   * hole this module exists for.
   */
  reads?: readonly string[];
  /**
   * Methods reachable from a mutation callsite. OMITTED means NONE — the
   * deliberate default, and the reason this module exists. A host that wants
   * actions to dial must say which ones.
   */
  mutations?: readonly string[];
  /**
   * Deny a read-tier call whose AIP verb says it mutates (Create / Update /
   * Patch / Delete), even when `reads` would otherwise admit it. Defaults to
   * TRUE: this is a tripwire, never a grant — it can only ever refuse, and it
   * refuses exactly the shape that matters, a destructive call smuggled into a
   * populate slot where it auto-fires on mount with no user gesture.
   */
  inferFromAipVerbs?: boolean;
  /** Called on every refusal. A host should log this; the dev overlay shows it. */
  onDenied?(denial: AdmissionDenial): void;
}

/**
 * `"unrestricted"` disables admission entirely. It exists so that opting out is
 * explicit and greppable rather than accidental — a host that genuinely renders
 * only first-party descriptors can say so in one word, and a reviewer can find
 * every such host with one search.
 */
export type AdmissionPolicy = RpcAdmission | "unrestricted";

/** Thrown when a call is refused. Renderers surface it; they never swallow it. */
export class AdmissionDeniedError extends Error {
  readonly denial: AdmissionDenial;
  constructor(denial: AdmissionDenial) {
    super(denial.reason);
    this.name = "AdmissionDeniedError";
    this.denial = denial;
  }
}

/** A prepared policy. Build once per mount; consult before every invoke. */
export interface AdmissionGate {
  /** Non-throwing test — for rendering an action as disabled rather than dead. */
  admits(tier: RpcTier, service: string, method: string): boolean;
  /** Throws {@link AdmissionDeniedError} unless the call is admitted. */
  check(tier: RpcTier, service: string, method: string): void;
}

// ── AIP standard-method classification ───────────────────────────────────────
//
// Ported from meridian-proto's `verb_prefix` (src/model.rs), including its
// `Getty` guard: a prefix only counts when what follows starts a new word, so
// "Getty" is not Get + "ty". Kept in step with that list deliberately — the
// projector derives layouts from the same verbs these decisions read.

const MUTATING_VERBS = ["Create", "Update", "Patch", "Delete"] as const;
const READING_VERBS = ["List", "Get", "Search"] as const;

/** Does `method` start with `verb` at a word boundary? */
function startsWithVerb(method: string, verb: string): string | null {
  if (!method.startsWith(verb)) return null;
  const rest = method.slice(verb.length);
  if (rest.length === 0) return "";
  return rest[0] === rest[0].toUpperCase() && rest[0] !== rest[0].toLowerCase()
    ? rest
    : null;
}

/**
 * The tier an AIP standard-method name implies, or `null` when the name follows
 * no standard verb (a custom method — we have nothing to say about it).
 *
 * `Batch` is a modifier, not a verb: BatchGet reads, BatchDelete mutates, so it
 * is stripped and the remainder classified.
 */
export function aipTier(method: string): RpcTier | null {
  let name = method;
  const afterBatch = startsWithVerb(name, "Batch");
  if (afterBatch !== null && afterBatch !== "") name = afterBatch;

  for (const v of MUTATING_VERBS) {
    if (startsWithVerb(name, v) !== null) return "mutation";
  }
  for (const v of READING_VERBS) {
    if (startsWithVerb(name, v) !== null) return "read";
  }
  return null;
}

// ── Matching ─────────────────────────────────────────────────────────────────

function matches(patterns: readonly string[], service: string, method: string): boolean {
  const qualified = `${service}/${method}`;
  for (const p of patterns) {
    if (p === "*" || p === qualified) return true;
    if (p.endsWith("/*") && p.slice(0, -2) === service) return true;
  }
  return false;
}

/**
 * Build a gate from a host policy.
 *
 * With NO policy the gate allows reads and denies mutations. That is a
 * behaviour change for hosts whose actions dial today — deliberately, and at
 * the 1.0.0 boundary, because the alternative is a default that silently
 * forwards model-chosen request bodies to an authenticated backend. The denial
 * message names the exact entry to add.
 */
export function createAdmissionGate(policy?: AdmissionPolicy): AdmissionGate {
  if (policy === "unrestricted") {
    return { admits: () => true, check: () => {} };
  }

  const p: RpcAdmission = policy ?? {};
  const inferVerbs = p.inferFromAipVerbs ?? true;

  function evaluate(tier: RpcTier, service: string, method: string): string | null {
    if (!service || !method) {
      return `an RpcCall with an empty ${!service ? "service" : "method"} was refused`;
    }

    // Tripwire first: a mutating verb fired from a read callsite is refused
    // even if `reads` would admit it. A populate runs on mount, unprompted.
    if (inferVerbs && tier === "read" && aipTier(method) === "mutation") {
      return (
        `${service}/${method} was fired from a READ callsite (a populate), but its ` +
        `AIP verb says it mutates. A populate runs automatically on mount, with no ` +
        `user gesture, so this is refused regardless of the reads allowlist. If the ` +
        `method genuinely only reads, rename it or set inferFromAipVerbs: false.`
      );
    }

    if (tier === "read") {
      // Omitted `reads` means "any" — see the field doc.
      if (p.reads === undefined || matches(p.reads, service, method)) return null;
      return (
        `${service}/${method} is not in the reads allowlist. ` +
        `Add "${service}/${method}" (or "${service}/*") to admission.reads.`
      );
    }

    if (p.mutations !== undefined && matches(p.mutations, service, method)) return null;
    return (
      `${service}/${method} is not in the mutations allowlist. ` +
      `Mutations are denied by default because a descriptor may be authored by an ` +
      `untrusted party (meridian-mcp validates shape, not intent) while the host's ` +
      `invoker may be authenticated. Add "${service}/${method}" to admission.mutations, ` +
      `or set admission: "unrestricted" if this host renders only first-party descriptors.`
    );
  }

  return {
    admits(tier, service, method) {
      return evaluate(tier, service, method) === null;
    },
    check(tier, service, method) {
      const reason = evaluate(tier, service, method);
      if (reason === null) return;
      const denial: AdmissionDenial = { tier, service, method, reason };
      p.onDenied?.(denial);
      throw new AdmissionDeniedError(denial);
    },
  };
}
