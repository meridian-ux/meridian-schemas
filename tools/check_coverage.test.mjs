// Guards the coverage gate itself.
//
// Same standard mirror_conformance.test.mjs holds: a gate that has never been
// shown to fail is not a gate. The cases below are the drifts this one exists
// to catch — chiefly a new proto arm that never reaches a renderer, and a
// full-parity shape quietly left unrenderable.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { check, parseBodyArms } from "./check_coverage.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const realManifest = () =>
  JSON.parse(readFileSync(join(ROOT, "conformance/coverage.json"), "utf8"));
const realArms = () =>
  parseBodyArms(readFileSync(join(ROOT, "proto/panel.proto"), "utf8"));

test("the committed manifest and proto agree", () => {
  assert.deepEqual(check(realManifest(), realArms()), []);
});

test("the parser finds every arm of the body oneof", () => {
  const arms = realArms();
  assert.equal(arms.length, 21);
  // Field numbers start at 3 (1/2 are panel_id/title) and must be unique.
  assert.equal(new Set(arms.map((a) => a.number)).size, arms.length);
  assert.ok(arms.some((a) => a.name === "table" && a.type === "TablePanel"));
  assert.ok(arms.some((a) => a.name === "stream"));
});

test("a new proto arm with no declared coverage fails", () => {
  // The headline drift: someone adds a shape and no renderer ever hears of it.
  const arms = [...realArms(), { type: "SparklinePanel", name: "sparkline", number: 24 }];
  const errors = check(realManifest(), arms);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /sparkline/);
  assert.match(errors[0], /must declare where it renders/);
});

test("a manifest arm that the proto does not declare fails", () => {
  const m = realManifest();
  m.arms.ghost = { parity: "standard", renderers: {} };
  const errors = check(m, realArms());
  assert.ok(errors.some((e) => /ghost/.test(e) && /not in panel\.proto/.test(e)));
});

test("a gap with no reason fails", () => {
  const m = realManifest();
  m.arms.gallery.renderers["web-components"] = { status: "missing" };
  const errors = check(m, realArms());
  assert.ok(errors.some((e) => /gallery\.web-components/.test(e) && /needs a reason/.test(e)));
});

test("an UNWAIVED full-parity gap fails", () => {
  // This is the finding the gate is really for: panel.proto promises these
  // shapes render everywhere, so a silent hole must not be representable.
  const m = realManifest();
  delete m.arms.stream.renderers["web-react"].waiver;
  const errors = check(m, realArms());
  assert.ok(
    errors.some((e) => /stream\.web-react/.test(e) && /FULL-PARITY/.test(e)),
    `expected a full-parity violation, got: ${errors.join(" | ")}`,
  );
});

test("a specialized shape may have gaps without a waiver", () => {
  // terminal/grammar/media document degradation ladders instead of parity, so
  // the gate must not demand waivers there — otherwise it cries wolf and gets
  // switched off.
  const m = realManifest();
  assert.equal(m.arms.terminal.parity, "specialized");
  assert.equal(m.arms.terminal.renderers["web-react"].status, "structural-gap");
  assert.ok(!m.arms.terminal.renderers["web-react"].waiver);
  assert.deepEqual(check(m, realArms()), []);
});

test("unknown statuses and renderers fail", () => {
  const m = realManifest();
  m.arms.table.renderers["web-react"] = { status: "probably-fine" };
  m.arms.stat.renderers["holo-deck"] = { status: "renders" };
  const errors = check(m, realArms());
  assert.ok(errors.some((e) => /probably-fine/.test(e)));
  assert.ok(errors.some((e) => /holo-deck/.test(e)));
});

test("a renderer missing from an arm fails", () => {
  const m = realManifest();
  delete m.arms.table.renderers.tui;
  const errors = check(m, realArms());
  assert.ok(errors.some((e) => /table/.test(e) && /no entry for renderer "tui"/.test(e)));
});

test("a parse that finds too little throws rather than passing by omission", () => {
  // A short parse would make the gate pass for arms it never saw — the one
  // failure mode a drift gate must not have.
  assert.throws(
    () => parseBodyArms("message PanelDescriptor {\n  oneof body {\n    TablePanel table = 3;\n  }\n}"),
    /parsed only 1 arms/,
  );
  assert.throws(() => parseBodyArms("message X {}"), /no `oneof body` block/);
  assert.throws(() => parseBodyArms("oneof body {\n  TablePanel table = 3;"), /never closes/);
});

test("commented-out arms are not counted", () => {
  // panel.proto's oneof carries prose about future shapes; a line comment must
  // not read as a declaration.
  const arms = parseBodyArms(`
    oneof body {
      TablePanel table = 3;
      LroPanel lro = 4;
      // GridPanel grid = 5;  — future, promoted via the corpus ratchet
      FormPanel form = 9;
      ChoicePanel choice = 10;
      StatPanel stat = 18;
    }
  `);
  assert.deepEqual(arms.map((a) => a.name), ["table", "lro", "form", "choice", "stat"]);
});
