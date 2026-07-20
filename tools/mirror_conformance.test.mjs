/**
 * Self-test for the mirror conformance gate.
 *
 * The fixtures are built programmatically rather than compiled from .proto files,
 * so the test needs no protoc and states the divergence it is checking directly in
 * the assertion. The central case is REAL: it is the transposition observed in a
 * shipped mirror of `meridian.ui.v1.LayoutService`, which is the reason this gate
 * exists. A gate that has never been shown to fail is not a gate.
 *
 * Run: node --test tools/
 */
import test from "node:test";
import assert from "node:assert/strict";
import { create, toBinary, fromBinary } from "@bufbuild/protobuf";
import {
  FileDescriptorSetSchema,
  FieldDescriptorProto_Type,
  FieldDescriptorProto_Label,
} from "@bufbuild/protobuf/wkt";
import { indexMessages, compare } from "./mirror_conformance.mjs";

// NB: protobuf-es strips the proto enum's common prefix, so the members are
// `STRING`/`MESSAGE` and `OPTIONAL`/`REPEATED` — NOT `TYPE_STRING`/`LABEL_OPTIONAL`.
// Destructuring the prefixed names silently yields `undefined`, which makes every
// fixture identical and every divergence assertion vacuously pass. Caught by this
// suite's own label test failing when it should have passed.
const { STRING: TYPE_STRING, MESSAGE: TYPE_MESSAGE, BYTES: TYPE_BYTES } = FieldDescriptorProto_Type;
const { OPTIONAL: LABEL_OPTIONAL, REPEATED: LABEL_REPEATED } = FieldDescriptorProto_Label;

for (const [n, v] of Object.entries({ TYPE_STRING, TYPE_MESSAGE, TYPE_BYTES, LABEL_OPTIONAL, LABEL_REPEATED })) {
  if (typeof v !== "number") throw new Error(`fixture enum ${n} is ${v} — protobuf-es enum member names changed`);
}

/** Build a FileDescriptorSet from a terse message spec. */
function fdset(messages) {
  const set = create(FileDescriptorSetSchema, {
    file: [
      {
        name: "meridian/ui/v1/layout_service.proto",
        package: "meridian.ui.v1",
        syntax: "proto3",
        messageType: Object.entries(messages).map(([name, fields]) => ({
          name,
          field: fields.map((f) => ({
            name: f.name,
            number: f.number,
            type: f.type ?? TYPE_STRING,
            typeName: f.typeName ?? "",
            label: f.label ?? LABEL_OPTIONAL,
          })),
        })),
      },
    ],
  });
  // Round-trip through the wire so the test exercises the same path as the CLI.
  return indexMessages(fromBinary(FileDescriptorSetSchema, toBinary(FileDescriptorSetSchema, set)));
}

const CANONICAL = fdset({
  GetPanelRequest: [
    { name: "panel_id", number: 1 },
    { name: "context", number: 2, type: TYPE_MESSAGE, typeName: ".meridian.ui.v1.LayoutContext" },
  ],
  GetViewRequest: [
    { name: "view_id", number: 1 },
    { name: "context", number: 2, type: TYPE_MESSAGE, typeName: ".meridian.ui.v1.LayoutContext" },
  ],
  NavNode: [
    { name: "id", number: 1 },
    { name: "label", number: 2 },
    { name: "children", number: 6, type: TYPE_MESSAGE, typeName: ".meridian.ui.v1.NavNode", label: LABEL_REPEATED },
  ],
});

test("a faithful mirror passes", () => {
  // A legitimate mirror: a strict SUBSET. Omitting fields you do not use is fine.
  const mirror = fdset({
    NavNode: [
      { name: "id", number: 1 },
      { name: "label", number: 2 },
    ],
  });
  assert.deepEqual(compare(CANONICAL, mirror), []);
});

test("mirror-only messages are ignored", () => {
  const mirror = fdset({ FastverkPluginMeta: [{ name: "slug", number: 1 }] });
  assert.deepEqual(compare(CANONICAL, mirror), []);
});

test("THE REAL CASE: transposed field numbers are caught and named", () => {
  // Verbatim the shape found in a shipped mirror: context and the id field swap
  // numbers 1 and 2. Both are wire type 2, so this corrupts silently.
  const mirror = fdset({
    GetPanelRequest: [
      { name: "context", number: 1, type: TYPE_MESSAGE, typeName: ".meridian.ui.v1.LayoutContext" },
      { name: "panel_id", number: 2 },
    ],
  });
  const findings = compare(CANONICAL, mirror);

  // Both fields are reported as divergent...
  const divergent = findings.filter((f) => f.kind === "divergent-field").map((f) => f.field).sort();
  assert.deepEqual(divergent, ["context", "panel_id"]);

  // ...and the transposition is called out as such, so the report explains the
  // failure mode rather than leaving a reader to notice two numbers were swapped.
  const transposed = findings.filter((f) => f.kind === "transposed-fields");
  assert.equal(transposed.length, 1);
  assert.equal(transposed[0].field, "context <-> panel_id");
  assert.match(transposed[0].detail, /EXCHANGED/);
});

test("a changed message type at the same number is caught", () => {
  // The case a number+wire-type comparison alone would MISS: same number, same
  // wire type (both length-delimited), different referent.
  const mirror = fdset({
    GetPanelRequest: [
      { name: "panel_id", number: 1 },
      { name: "context", number: 2, type: TYPE_MESSAGE, typeName: ".fastverk.plugin.v1.PluginContext" },
    ],
  });
  const findings = compare(CANONICAL, mirror);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].field, "context");
  assert.match(findings[0].detail, /typeName/);
});

test("a changed label is caught", () => {
  const mirror = fdset({
    NavNode: [
      { name: "children", number: 6, type: TYPE_MESSAGE, typeName: ".meridian.ui.v1.NavNode", label: LABEL_OPTIONAL },
    ],
  });
  const findings = compare(CANONICAL, mirror);
  assert.equal(findings.length, 1);
  assert.match(findings[0].detail, /label REPEATED -> OPTIONAL/);
});

test("a field canonical does not have is caught", () => {
  const mirror = fdset({ NavNode: [{ name: "tab_bar_position", number: 42 }] });
  const findings = compare(CANONICAL, mirror);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "unknown-field");
});

test("an allowlisted deviation is waived, and only that one", () => {
  // The documented, deliberate case: a mirror returns an opaque bytes envelope
  // where canonical returns a typed message. Legal — but it must be written down.
  const mirror = fdset({
    GetPanelRequest: [
      { name: "panel_id", number: 1, type: TYPE_BYTES },
      { name: "context", number: 9, type: TYPE_MESSAGE, typeName: ".meridian.ui.v1.LayoutContext" },
    ],
  });
  const allowlist = {
    deviations: [
      { message: "meridian.ui.v1.GetPanelRequest", field: "panel_id", reason: "opaque bundle envelope" },
    ],
  };
  const findings = compare(CANONICAL, mirror, allowlist);
  assert.equal(findings.length, 1, "the un-waived field must still be reported");
  assert.equal(findings[0].field, "context");
});

test('a "*" waiver covers the whole message', () => {
  const mirror = fdset({
    GetPanelRequest: [
      { name: "context", number: 1, type: TYPE_MESSAGE, typeName: ".meridian.ui.v1.LayoutContext" },
      { name: "panel_id", number: 2 },
    ],
  });
  const allowlist = {
    deviations: [{ message: "meridian.ui.v1.GetPanelRequest", field: "*", reason: "legacy plugin surface" }],
  };
  assert.deepEqual(compare(CANONICAL, mirror, allowlist), []);
});

test("subset mode ignores a missing field; complete mode reports it", () => {
  // THE REAL CASE, again: a vendored tree frozen before `Slot.sub_view` landed. A
  // producer that sets sub_view gets it dropped as an unknown field — no error, just
  // a slot with no panel. `REQUIRED` does not help: field_behavior is documentation
  // only in proto3. Measured live in aion/mail's vendored tree, which is 16 fields
  // behind canonical across 7 messages with ZERO disagreements.
  const canonical = fdset({
    Slot: [
      { name: "id", number: 1 },
      { name: "panel", number: 6, type: TYPE_MESSAGE, typeName: ".meridian.ui.v1.PanelDescriptor" },
      { name: "sub_view", number: 8, type: TYPE_MESSAGE, typeName: ".meridian.ui.v1.ViewDescriptor" },
    ],
  });
  const vendored = fdset({
    Slot: [
      { name: "id", number: 1 },
      { name: "panel", number: 6, type: TYPE_MESSAGE, typeName: ".meridian.ui.v1.PanelDescriptor" },
    ],
  });

  // A deliberate subset mirror: legal, silent.
  assert.deepEqual(compare(canonical, vendored), []);

  // The same bytes judged as a vendored full-tree copy: drift.
  const strict = compare(canonical, vendored, {}, { requireComplete: true });
  assert.equal(strict.length, 1);
  assert.equal(strict[0].kind, "missing-field");
  assert.equal(strict[0].field, "sub_view");
  assert.match(strict[0].detail, /SILENTLY dropped/);
});

test("complete mode still honours the allowlist", () => {
  const canonical = fdset({
    ViewDescriptor: [
      { name: "id", number: 1 },
      { name: "subject_id", number: 9 },
    ],
  });
  const vendored = fdset({ ViewDescriptor: [{ name: "id", number: 1 }] });
  const allowlist = {
    deviations: [
      { message: "meridian.ui.v1.ViewDescriptor", field: "subject_id", reason: "list-only surface" },
    ],
  };
  assert.deepEqual(compare(canonical, vendored, allowlist, { requireComplete: true }), []);
});

test("nested messages are compared under their qualified name", () => {
  const nestedCanonical = indexMessages(
    fromBinary(
      FileDescriptorSetSchema,
      toBinary(
        FileDescriptorSetSchema,
        create(FileDescriptorSetSchema, {
          file: [
            {
              name: "meridian/ui/v1/conversation.proto",
              package: "meridian.ui.v1",
              syntax: "proto3",
              messageType: [
                {
                  name: "Block",
                  field: [{ name: "id", number: 1, type: TYPE_STRING, label: LABEL_OPTIONAL }],
                  nestedType: [
                    { name: "Table", field: [{ name: "rows", number: 1, type: TYPE_STRING, label: LABEL_REPEATED }] },
                  ],
                },
              ],
            },
          ],
        }),
      ),
    ),
  );
  assert.ok(nestedCanonical.has("meridian.ui.v1.Block.Table"), "nested type must be indexed by qualified name");
});
