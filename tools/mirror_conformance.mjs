#!/usr/bin/env node
/**
 * Mirror-vs-canonical conformance gate.
 *
 * Several repos carry a hand-maintained MIRROR of `meridian.ui.v1` rather than
 * consuming this one: a standalone copy of a few messages, kept small so the repo
 * can compile without a Bazel dependency on meridian-schemas. That is a legitimate
 * pattern — `nav_tree.proto` imports nothing but `field_behavior` precisely so a
 * 40-line mirror is possible. What is NOT legitimate is a mirror that silently
 * disagrees with the contract it claims to implement.
 *
 * The failure this exists to prevent, observed in the wild:
 *
 *   canonical  GetPanelRequest { panel_id = 1; LayoutContext context = 2; }
 *   a mirror   GetPanelRequest { LayoutContext context = 1; string panel_id = 2; }
 *
 * Both fields are protobuf wire type 2 (length-delimited), so a canonical client
 * and that mirror's server parse each other's tag-1 field WITHOUT ERROR and get
 * garbage. `string` validates UTF-8, so one direction errors intermittently while
 * the other yields a silently wrong value — it presents as flakiness, not as a
 * protocol bug, and it is invisible to every test that checks a mirror against
 * itself. Which is every test a mirror repo has.
 *
 * So: compare FileDescriptorSets, not text. For every message present in BOTH the
 * canonical set and the mirror, every field they share must agree on number, type
 * and label. A deliberate divergence is legal but must be written down in an
 * allowlist with a reason, which turns a silent landmine into a reviewable line.
 *
 * Usage:
 *   node tools/mirror_conformance.mjs \
 *     --canonical <canonical.binpb> --mirror <mirror.binpb> [--allowlist <file.json>]
 *
 * Both inputs are serialized `google.protobuf.FileDescriptorSet`s. Every proto
 * toolchain can emit one (`protoc --descriptor_set_out`, Bazel's `proto_library`,
 * `tonic_build`'s committed FDS), which is why this compares descriptors rather
 * than parsing `.proto` text — it needs no parser and no protoc at check time.
 *
 * Allowlist format:
 *   { "deviations": [ { "message": "meridian.ui.v1.GetPanelRequest",
 *                       "field": "panel_id", "reason": "…" } ] }
 * A `field` of "*" waives the whole message.
 */
import { readFileSync } from "node:fs";
import { fromBinary } from "@bufbuild/protobuf";
import {
  FileDescriptorSetSchema,
  FieldDescriptorProto_Type,
  FieldDescriptorProto_Label,
} from "@bufbuild/protobuf/wkt";

const TYPE_NAME = invert(FieldDescriptorProto_Type);
const LABEL_NAME = invert(FieldDescriptorProto_Label);

function invert(enumObj) {
  const out = {};
  for (const [k, v] of Object.entries(enumObj)) if (typeof v === "number") out[v] = k;
  return out;
}

/**
 * Flatten a FileDescriptorSet into `fully.qualified.Message -> field name -> shape`.
 * Nested messages are included under their qualified name, so `Block.Table` is
 * compared as `meridian.ui.v1.Block.Table`.
 */
export function indexMessages(fdset) {
  const messages = new Map();
  const walk = (pkg, msg) => {
    const fq = pkg ? `${pkg}.${msg.name}` : msg.name;
    const fields = new Map();
    for (const f of msg.field ?? []) {
      fields.set(f.name, {
        number: f.number,
        // typeName carries the referent for message/enum fields; comparing it
        // catches a mirror that swapped one message type for another at the same
        // number and wire type — which the raw `type` alone would not.
        type: TYPE_NAME[f.type] ?? String(f.type),
        typeName: f.typeName ?? "",
        label: LABEL_NAME[f.label] ?? String(f.label),
      });
    }
    messages.set(fq, fields);
    for (const nested of msg.nestedType ?? []) walk(fq, nested);
  };
  for (const file of fdset.file ?? []) {
    for (const msg of file.messageType ?? []) walk(file.package ?? "", msg);
  }
  return messages;
}

function loadSet(path) {
  return indexMessages(fromBinary(FileDescriptorSetSchema, readFileSync(path)));
}

function waived(allowlist, message, field) {
  return (allowlist.deviations ?? []).some(
    (d) => d.message === message && (d.field === field || d.field === "*"),
  );
}

/**
 * Compare a mirror against canonical. Only messages present in BOTH are checked —
 * a mirror-only message is its own business.
 *
 * Two modes, because "mirror" covers two different things:
 *
 *   subset (default) — a deliberate hand-written copy of a few messages, kept small
 *     on purpose (botnoc's ~40-line nav_tree). Omitting a field you do not use is
 *     the whole point; only DISAGREEMENT about a shared field is a bug.
 *
 *   complete (`requireComplete: true`) — a VENDORED copy of the full tree, claiming
 *     to be the contract. Here a missing field is also drift, and a silent one: proto
 *     decoders ignore unknown fields, so a producer that sets `Slot.sub_view` against
 *     a consumer vendored before that field existed gets a slot with no panel and no
 *     error. `REQUIRED` does not save you — `field_behavior` is documentation only in
 *     proto3 and no runtime enforces it. Use this mode for a vendored tree.
 */
export function compare(canonical, mirror, allowlist = {}, { requireComplete = false } = {}) {
  const findings = [];
  for (const [msgName, mirrorFields] of mirror) {
    const canonFields = canonical.get(msgName);
    if (!canonFields) continue; // mirror-only message
    for (const [fieldName, m] of mirrorFields) {
      const c = canonFields.get(fieldName);
      if (!c) {
        if (!waived(allowlist, msgName, fieldName)) {
          findings.push({
            message: msgName,
            field: fieldName,
            kind: "unknown-field",
            detail: `mirror declares "${fieldName}" (number ${m.number}); canonical has no such field`,
          });
        }
        continue;
      }
      const diffs = [];
      if (c.number !== m.number) diffs.push(`number ${c.number} -> ${m.number}`);
      if (c.type !== m.type) diffs.push(`type ${c.type} -> ${m.type}`);
      if (c.typeName !== m.typeName) diffs.push(`typeName "${c.typeName}" -> "${m.typeName}"`);
      if (c.label !== m.label) diffs.push(`label ${c.label} -> ${m.label}`);
      if (diffs.length && !waived(allowlist, msgName, fieldName)) {
        findings.push({
          message: msgName,
          field: fieldName,
          kind: "divergent-field",
          detail: diffs.join("; "),
        });
      }
    }
    // Completeness: a field canonical has that this vendored copy lacks. Silent by
    // construction — the decoder drops it as unknown — so it needs saying out loud.
    if (requireComplete) {
      for (const [fieldName, c] of canonFields) {
        if (mirrorFields.has(fieldName)) continue;
        if (waived(allowlist, msgName, fieldName)) continue;
        findings.push({
          message: msgName,
          field: fieldName,
          kind: "missing-field",
          detail:
            `canonical declares "${fieldName}" (number ${c.number}); this copy lacks it, ` +
            `so a producer that sets it is SILENTLY dropped on decode`,
        });
      }
    }

    // A transposition only shows up as two divergent fields; naming it explicitly
    // makes the report say what actually happened rather than leaving a reader to
    // spot that two numbers were exchanged.
    for (const [fieldName, m] of mirrorFields) {
      const c = canonFields.get(fieldName);
      if (!c || c.number === m.number) continue;
      for (const [otherName, otherM] of mirrorFields) {
        const otherC = canonFields.get(otherName);
        if (!otherC || otherName === fieldName) continue;
        if (otherC.number === m.number && c.number === otherM.number) {
          if (!waived(allowlist, msgName, fieldName) && fieldName < otherName) {
            findings.push({
              message: msgName,
              field: `${fieldName} <-> ${otherName}`,
              kind: "transposed-fields",
              detail:
                `field numbers ${c.number} and ${otherC.number} are EXCHANGED. ` +
                `If both are the same wire type this corrupts silently in both directions.`,
            });
          }
        }
      }
    }
  }
  return findings;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, "")] = argv[i + 1];
  return args;
}

function main() {
  const argv = process.argv.slice(2);
  const requireComplete = argv.includes("--require-complete");
  const { canonical, mirror, allowlist } = parseArgs(argv.filter((a) => a !== "--require-complete"));
  if (!canonical || !mirror) {
    console.error(
      "usage: mirror_conformance.mjs --canonical <fds> --mirror <fds>\n" +
        "                             [--allowlist <json>] [--require-complete]\n\n" +
        "  --require-complete  also report fields canonical has that the mirror lacks.\n" +
        "                      Use for a VENDORED copy of the full tree; omit for a\n" +
        "                      deliberate subset mirror.",
    );
    process.exit(2);
  }
  const waivers = allowlist ? JSON.parse(readFileSync(allowlist, "utf8")) : {};
  const findings = compare(loadSet(canonical), loadSet(mirror), waivers, { requireComplete });

  if (findings.length === 0) {
    console.log("mirror conformance: OK — every shared field agrees with meridian.ui.v1");
    return;
  }
  console.error(`mirror conformance: ${findings.length} divergence(s) from meridian.ui.v1\n`);
  for (const f of findings) {
    console.error(`  ${f.message}.${f.field}`);
    console.error(`    ${f.kind}: ${f.detail}`);
  }
  console.error(
    "\nEach divergence is either a bug or a deliberate choice. If deliberate, add it to the\n" +
      "allowlist with a reason:\n" +
      '  { "deviations": [ { "message": "…", "field": "…", "reason": "…" } ] }',
  );
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
