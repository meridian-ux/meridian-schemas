#!/usr/bin/env node
/**
 * Renderer-coverage gate: conformance/coverage.json vs proto/panel.proto.
 *
 * WHY THIS EXISTS. `PanelDescriptor.body` is a 21-arm oneof and no renderer
 * implements all of it — which is fine and deliberate, because panel.proto
 * designs for degradation. What is NOT fine is that the coverage was, until
 * now, only knowable by reading six dispatch sites in four repositories and
 * three languages. That means:
 *
 *   • a new arm can be added to the proto and simply never reach a renderer,
 *     with nothing anywhere reporting the hole;
 *   • an arm the proto declares FULL-PARITY ("every modality realizes them at
 *     full fidelity") can be unrenderable in practice, and has been — no React
 *     kit can draw `stream`, because ComponentKit has no Stream member at all;
 *   • and any tool that wants to say "this descriptor will not draw on your
 *     other surface" has no ground truth to say it from.
 *
 * So coverage becomes a declared artifact that drifts loudly. This gate asserts
 * the manifest and the proto agree, that every gap is explained, and that a
 * full-parity gap is explicitly waived rather than silently tolerated.
 *
 * Deliberately parses the .proto TEXT rather than a FileDescriptorSet. The
 * canonical descriptor set is produced by Bazel, and ci.yml's gates job is
 * node/python only on purpose — no Bazel, no registry auth. Both inputs are
 * source files in this repository, so a text parse is comparing two things we
 * own. The parse is strict and fails loudly rather than degrading.
 *
 * Run:  node tools/check_coverage.mjs [--matrix]
 *       --matrix  print the coverage matrix and exit 0 (documentation mode)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Statuses that mean "the shape does not draw here". */
const GAP_STATUSES = new Set(["missing", "structural-gap"]);
/** Statuses that need an explanation. Everything except the happy one. */
const NEEDS_REASON = (s) => s !== "renders";

/**
 * Extract the `body` oneof's arm names from panel.proto.
 *
 * Strict by construction: if the block cannot be found, or the brace never
 * closes, or it yields an implausible number of arms, this throws rather than
 * returning a partial set — a silently-short list would make the gate pass by
 * omission, which is the one failure mode a drift gate must not have.
 */
export function parseBodyArms(protoText) {
  const withoutComments = protoText.replace(/\/\/[^\n]*/g, "");
  const start = withoutComments.indexOf("oneof body");
  if (start === -1) throw new Error("panel.proto: no `oneof body` block found");

  const open = withoutComments.indexOf("{", start);
  if (open === -1) throw new Error("panel.proto: `oneof body` has no opening brace");

  let depth = 0;
  let end = -1;
  for (let i = open; i < withoutComments.length; i++) {
    if (withoutComments[i] === "{") depth++;
    else if (withoutComments[i] === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) throw new Error("panel.proto: `oneof body` brace never closes");

  const body = withoutComments.slice(open + 1, end);
  const arms = [];
  const re = /^\s*([A-Za-z_][\w.]*)\s+([a-z_][a-z0-9_]*)\s*=\s*(\d+)\s*;/gm;
  let m;
  while ((m = re.exec(body)) !== null) arms.push({ type: m[1], name: m[2], number: Number(m[3]) });

  if (arms.length < 5) {
    throw new Error(
      `panel.proto: parsed only ${arms.length} arms from \`oneof body\` — the parse is ` +
      `wrong, not the proto. Fix the parser rather than the manifest.`,
    );
  }
  return arms;
}

function renderMatrix(manifest, arms) {
  const renderers = Object.keys(manifest.renderers);
  const glyph = {
    renders: "  ●  ", placeholder: "  ○  ", "separate-entrypoint": " sep ",
    missing: "  —  ", "structural-gap": "  ✗  ", "not-applicable": " n/a ",
  };
  const w = Math.max(...arms.map((a) => a.name.length)) + 1;
  const head = " ".repeat(w) + renderers.map((r) => r.slice(0, 5).padStart(5)).join(" ");
  const lines = [head];
  for (const arm of arms) {
    const cells = manifest.arms[arm.name].renderers;
    lines.push(arm.name.padEnd(w) + renderers.map((r) => glyph[cells[r].status]).join(" "));
  }
  const totals = renderers.map((r) => {
    const n = arms.filter((a) => manifest.arms[a.name].renderers[r].status === "renders").length;
    return String(n).padStart(5);
  });
  lines.push(" ".repeat(w) + totals.join(" ") + `   of ${arms.length}`);
  return lines.join("\n");
}

export function check(manifest, arms) {
  const errors = [];
  const renderers = Object.keys(manifest.renderers);
  const validStatuses = new Set(Object.keys(manifest.statuses));
  const validParity = new Set(Object.keys(manifest.parity));

  const protoNames = new Set(arms.map((a) => a.name));
  const manifestNames = new Set(Object.keys(manifest.arms));

  for (const n of protoNames) {
    if (!manifestNames.has(n)) {
      errors.push(
        `proto/panel.proto declares \`${n}\` but conformance/coverage.json does not. ` +
        `A new panel shape must declare where it renders — add it, marking each ` +
        `renderer honestly (\`missing\` with a reason is a fine answer).`,
      );
    }
  }
  for (const n of manifestNames) {
    if (!protoNames.has(n)) {
      errors.push(`conformance/coverage.json declares \`${n}\`, which is not in panel.proto's body oneof.`);
    }
  }

  for (const [name, arm] of Object.entries(manifest.arms)) {
    if (!validParity.has(arm.parity)) {
      errors.push(`${name}: unknown parity "${arm.parity}"`);
    }
    const cells = arm.renderers ?? {};
    for (const r of renderers) {
      if (!(r in cells)) { errors.push(`${name}: no entry for renderer "${r}"`); continue; }
      const { status, reason, waiver } = cells[r];
      if (!validStatuses.has(status)) {
        errors.push(`${name}.${r}: unknown status "${status}"`);
        continue;
      }
      if (NEEDS_REASON(status) && !reason) {
        errors.push(`${name}.${r}: status "${status}" needs a reason.`);
      }
      // The finding this gate exists to hold: panel.proto promises full-parity
      // shapes render everywhere. Where they do not, that must be an explicit,
      // attributable waiver — never a silence.
      if (arm.parity === "full" && GAP_STATUSES.has(status) && !waiver) {
        errors.push(
          `${name}.${r}: ${name} is declared FULL-PARITY by panel.proto ("every modality ` +
          `realizes them at full fidelity") but is "${status}" here with no waiver. ` +
          `Either implement it, or add a waiver saying who owes it.`,
        );
      }
    }
    for (const r of Object.keys(cells)) {
      if (!renderers.includes(r)) errors.push(`${name}: unknown renderer "${r}"`);
    }
  }
  return errors;
}

function main() {
  const manifest = JSON.parse(readFileSync(join(ROOT, "conformance/coverage.json"), "utf8"));
  const arms = parseBodyArms(readFileSync(join(ROOT, "proto/panel.proto"), "utf8"));

  if (process.argv.includes("--matrix")) {
    console.log(renderMatrix(manifest, arms));
    return;
  }

  const errors = check(manifest, arms);
  if (errors.length === 0) {
    const waived = Object.entries(manifest.arms).flatMap(([n, a]) =>
      Object.entries(a.renderers).filter(([, c]) => c.waiver).map(([r]) => `${n}.${r}`));
    console.log(
      `coverage OK — ${arms.length} arms × ${Object.keys(manifest.renderers).length} renderers` +
      (waived.length ? `, ${waived.length} waived full-parity gaps: ${waived.join(", ")}` : ""),
    );
    return;
  }
  console.error(`coverage drift (${errors.length}):\n`);
  for (const e of errors) console.error(`  • ${e}`);
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
