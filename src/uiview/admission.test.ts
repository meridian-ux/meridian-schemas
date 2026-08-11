// Guards the RpcCall admission gate.
//
// A gate that has never been shown to refuse is not a gate — the same standard
// mirror_conformance.test.mjs holds itself to. So the cases that matter here are
// the REFUSALS: the default-closed mutation tier, and the AIP tripwire that
// catches a destructive call smuggled into a populate slot.
//
// NOT compiled into the published package: admission.ts is in the ts_project
// srcs, this file is not. CI compiles the pair standalone (admission.ts has no
// imports, by design) and runs this with node --test.

import test from "node:test";
import assert from "node:assert/strict";
import {
  AdmissionDeniedError,
  aipTier,
  createAdmissionGate,
  type AdmissionDenial,
} from "./admission.js";

test("with no policy: reads are allowed, mutations are denied", () => {
  const gate = createAdmissionGate();

  // Reads default open. Every host's populate already fires today; defaulting
  // this closed would break them all on upgrade without closing the hole.
  assert.equal(gate.admits("read", "acme.v1.Orders", "ListOrders"), true);

  // Mutations default closed. This is the whole point of the module.
  assert.equal(gate.admits("mutation", "acme.v1.Orders", "ArchiveOrder"), false);
});

test("a denial names the exact entry to add", () => {
  const gate = createAdmissionGate();
  assert.throws(
    () => gate.check("mutation", "acme.v1.Orders", "ArchiveOrder"),
    (err: unknown) => {
      assert.ok(err instanceof AdmissionDeniedError);
      assert.equal(err.denial.tier, "mutation");
      assert.equal(err.denial.service, "acme.v1.Orders");
      assert.equal(err.denial.method, "ArchiveOrder");
      // The message has to be actionable or a host will just reach for
      // "unrestricted" to make it go away.
      assert.match(err.denial.reason, /admission\.mutations/);
      assert.match(err.denial.reason, /acme\.v1\.Orders\/ArchiveOrder/);
      return true;
    },
  );
});

test('"unrestricted" opts out completely, including the tripwire', () => {
  const gate = createAdmissionGate("unrestricted");
  assert.equal(gate.admits("mutation", "acme.v1.Orders", "DeleteOrder"), true);
  assert.equal(gate.admits("read", "acme.v1.Orders", "DeleteOrder"), true);
  gate.check("mutation", "acme.v1.Orders", "DeleteOrder");
});

test("explicit allowlists admit exactly what they name", () => {
  const gate = createAdmissionGate({
    reads: ["acme.v1.Orders/ListOrders"],
    mutations: ["acme.v1.Orders/ArchiveOrder"],
  });

  assert.equal(gate.admits("read", "acme.v1.Orders", "ListOrders"), true);
  assert.equal(gate.admits("read", "acme.v1.Orders", "ListInvoices"), false);
  assert.equal(gate.admits("mutation", "acme.v1.Orders", "ArchiveOrder"), true);
  assert.equal(gate.admits("mutation", "acme.v1.Orders", "DeleteOrder"), false);

  // The tiers are separate lists: naming a read does not grant the mutation.
  assert.equal(gate.admits("mutation", "acme.v1.Orders", "ListOrders"), false);
});

test("wildcards cover a service, or everything", () => {
  const svc = createAdmissionGate({ mutations: ["acme.v1.Orders/*"] });
  assert.equal(svc.admits("mutation", "acme.v1.Orders", "ArchiveOrder"), true);
  assert.equal(svc.admits("mutation", "acme.v1.Invoices", "ArchiveInvoice"), false);

  const all = createAdmissionGate({ mutations: ["*"] });
  assert.equal(all.admits("mutation", "anything.v1.At", "All"), true);
});

test("a mutating verb fired from a READ callsite is refused", () => {
  // The attack this module exists for: a populate auto-fires on mount with no
  // user gesture, so a destructive method in that slot never needs a click.
  // Note reads are wide open here — the tripwire still refuses it.
  const gate = createAdmissionGate();

  for (const m of ["DeleteOrder", "CreateOrder", "UpdateOrder", "PatchOrder"]) {
    assert.equal(gate.admits("read", "acme.v1.Orders", m), false, m);
  }
  assert.throws(
    () => gate.check("read", "acme.v1.Orders", "DeleteOrder"),
    /fired from a READ callsite/,
  );
});

test("the tripwire can be switched off, and only then", () => {
  const off = createAdmissionGate({ inferFromAipVerbs: false });
  assert.equal(off.admits("read", "acme.v1.Orders", "DeleteOrder"), true);

  // It is a tripwire, never a grant: turning it ON does not admit a mutation
  // that the allowlist does not name.
  const on = createAdmissionGate({ inferFromAipVerbs: true });
  assert.equal(on.admits("mutation", "acme.v1.Orders", "DeleteOrder"), false);
});

test("onDenied observes every refusal", () => {
  const seen: AdmissionDenial[] = [];
  const gate = createAdmissionGate({ onDenied: (d) => seen.push(d) });

  assert.throws(() => gate.check("mutation", "acme.v1.Orders", "ArchiveOrder"));
  assert.throws(() => gate.check("read", "acme.v1.Orders", "DeleteOrder"));

  assert.equal(seen.length, 2);
  assert.deepEqual(
    seen.map((d) => `${d.tier} ${d.method}`),
    ["mutation ArchiveOrder", "read DeleteOrder"],
  );
});

test("an empty service or method is refused at either tier", () => {
  const gate = createAdmissionGate({});
  assert.equal(gate.admits("read", "", "ListOrders"), false);
  assert.equal(gate.admits("read", "acme.v1.Orders", ""), false);
  assert.throws(() => gate.check("read", "", ""), /empty service/);
});

// ── the AIP classifier ───────────────────────────────────────────────────────

test("aipTier classifies the standard verbs", () => {
  assert.equal(aipTier("ListOrders"), "read");
  assert.equal(aipTier("GetOrder"), "read");
  assert.equal(aipTier("SearchOrders"), "read");
  assert.equal(aipTier("CreateOrder"), "mutation");
  assert.equal(aipTier("UpdateOrder"), "mutation");
  assert.equal(aipTier("PatchOrder"), "mutation");
  assert.equal(aipTier("DeleteOrder"), "mutation");
});

test("aipTier keeps meridian-proto's Getty guard", () => {
  // A prefix only counts at a word boundary. "Getty" is a name, not Get + ty.
  assert.equal(aipTier("Getty"), null);
  assert.equal(aipTier("Listen"), null);
  assert.equal(aipTier("Patchwork"), null);
  assert.equal(aipTier("Deleterious"), null);
  // A custom method follows no standard verb; we have nothing to say about it.
  assert.equal(aipTier("Exchange"), null);
  assert.equal(aipTier("ArchiveOrder"), null);
});

test("aipTier treats Batch as a modifier, not a verb", () => {
  assert.equal(aipTier("BatchGetOrders"), "read");
  assert.equal(aipTier("BatchDeleteOrders"), "mutation");
  assert.equal(aipTier("BatchCreateOrders"), "mutation");
});

test("a bare standard verb still classifies", () => {
  assert.equal(aipTier("Get"), "read");
  assert.equal(aipTier("Delete"), "mutation");
});

test("an unclassifiable method is not refused by the tripwire", () => {
  // ArchiveOrder mutates in fact, but its name follows no standard verb, so
  // inference must stay silent rather than guess. The allowlist is the real
  // control; inference only catches the cases it can prove.
  const gate = createAdmissionGate();
  assert.equal(gate.admits("read", "acme.v1.Orders", "ArchiveOrder"), true);
});
