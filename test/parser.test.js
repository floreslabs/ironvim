/* The grammar tables and parser live inside index.html; pull them out and pin
 * the behavior that earlier changes established (space separators, pd codes). */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const slice = src.slice(src.indexOf("const ANGLE_LABELS"), src.indexOf("/* ---------------- session header convention"));
const G = new Function(slice + "; return { tryParseExerciseLine, parseLog, describeExercise, migrateLegend, withDefaultLegend, DEFAULT_LEGEND, SAMPLE_LOG };")();

const sets = (line) => {
  const e = G.tryParseExerciseLine(line);
  return e ? e.map((x) => x.sets.map((s) => s.weightRaw + "x" + s.reps).join(" ")).join(" | ") : null;
};
const label = (code) => G.describeExercise(G.tryParseExerciseLine(code + " 100x5")[0], G.DEFAULT_LEGEND);

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("space separates sets", () => {
  assert.strictEqual(sets("le 120x12 140x10 160x8"), "120x12 140x10 160x8");
  assert.strictEqual(sets("op 95x10  105x8   115x6"), "95x10 105x8 115x6");
});

test("> still parses for older logs", () => {
  assert.strictEqual(sets("p 135x8>120x8"), "135x8 120x8");
  assert.strictEqual(sets("p 135x8 > 120x8"), "135x8 120x8");
});

test("padding around , * x is not a set break", () => {
  assert.strictEqual(sets("p 135x8, 8, 6"), "135x8 135x8 135x6");
  assert.strictEqual(sets("sq 225x5 * 5"), "225x5 225x5 225x5 225x5 225x5");
  assert.strictEqual(sets("p 135 x 8"), "135x8");
});

test("numeric and superset forms survive; bw tokens do not", () => {
  assert.strictEqual(sets("di 25x8,8,6"), "25x8 25x8 25x6");
  assert.strictEqual(sets("p 135x8 + c 60x10"), "135x8 | 60x10");
  assert.strictEqual(sets("p bw+25x8"), null, "bw is not a valid weight token");
});

test("bw lines degrade to session headers", () => {
  const parsed = G.parseLog("PUSH 09-11\np 135x8\n\nLEGS 09-12\ndi bw+25x8,8,6");
  assert.deepStrictEqual(parsed.map((s) => s.title), ["PUSH 09-11", "LEGS 09-12", "di bw+25x8,8,6"]);
  assert.deepStrictEqual(parsed.map((s) => s.entries.length), [1, 0, 0]);
});

test("a bare trailing number fails instead of silently merging digits", () => {
  assert.strictEqual(sets("p 135x8 8"), null);
});

test("pd is the pulldown code, across angle and equipment prefixes", () => {
  assert.strictEqual(label("pd"), "Pulldown");
  assert.strictEqual(label("cpd"), "Cable Pulldown");
  assert.strictEqual(label("ipd"), "Incline Pulldown");
  assert.strictEqual(label("dpd"), "Decline Pulldown");
  assert.strictEqual(label("pd.v"), "Pulldown (V-Bar)");
  assert.strictEqual(label("cpd.rg"), "Cable Pulldown (Reverse Grip)");
  assert.strictEqual(label("cpd.s"), "Cable Pulldown (Single Handle)");
});

test("pulldown keeps v-bar, single handle, reverse grip, and neutral grip variations", () => {
  assert.deepStrictEqual(G.DEFAULT_LEGEND.pd, { v:"V-Bar", s:"Single Handle", rg:"Reverse Grip", ng:"Neutral Grip" });
  assert.strictEqual(label("pd.ng"), "Pulldown (Neutral Grip)");
});

test("retired l code still resolves to pulldown", () => {
  assert.strictEqual(label("l"), "Pulldown");
  assert.strictEqual(label("cl"), "Cable Pulldown");
  assert.strictEqual(label("l.ng"), "Pulldown (Neutral Grip)");
});

test("withDefaultLegend prunes legacy pulldown defaults but keeps edits and additions", () => {
  const pruned = G.withDefaultLegend({ pd: { t:"Triangle", r:"Rope", w:"Wide Bar", b:"Straight Bar", z:"Custom" } });
  assert.deepStrictEqual(Object.keys(pruned.pd).sort(), ["ng", "rg", "s", "v", "z"]);
  assert.strictEqual(pruned.pd.z, "Custom");
  assert.strictEqual(pruned.pd.s, "Single Handle", "single handle returns via defaults");
  const renamed = G.withDefaultLegend({ pd: { t:"My Triangle" } });
  assert.strictEqual(renamed.pd.t, "My Triangle", "a renamed legacy entry survives");
  assert.strictEqual(renamed.pd.rg, "Reverse Grip", "defaults still apply");
});

test("legacy di/e/ca codes still normalize to their current base", () => {
  assert.strictEqual(label("di"), "Bodyweight Dip");
  assert.strictEqual(label("e"), "Dumbbell Delt Raises");
  assert.strictEqual(label("ca"), "Machine Calf Raise");
});

test("l-prefixed leg codes are unaffected", () => {
  assert.strictEqual(label("dl"), "Barbell Deadlift");
  assert.strictEqual(label("lp"), "Machine Leg Press");
  assert.strictEqual(label("lc.l"), "Machine Leg Curl (Lying)");
  assert.strictEqual(label("dp"), "Decline Barbell Press");
});

test("rdl labels as a Romanian Deadlift", () => {
  assert.strictEqual(label("rdl"), "Barbell Romanian Deadlift (RDL)");
  const parsed = G.parseLog("PUSH\nrdl 135x8");
  assert.strictEqual(parsed[0].entries[0].code, "rdl", "rdl parses as an exercise line");
});

test("legend migration moves retired keys and keeps custom entries", () => {
  const m = G.migrateLegend({ l: { w: "Wide Bar", z: "Custom" }, t: { r: "Rope" } });
  assert.deepStrictEqual(Object.keys(m).sort(), ["pd", "t"]);
  assert.strictEqual(m.pd.z, "Custom");
  assert.deepStrictEqual(G.migrateLegend({ l: { w: "OLD" }, pd: { w: "NEW" } }), { pd: { w: "NEW" } });
});

test("unparseable lines become session headers", () => {
  const parsed = G.parseLog("Workout for 9/11/2026\np 135x8\n\n=== cloud copy 9/11 ===\nsq 225x5");
  assert.deepStrictEqual(parsed.map((s) => s.title),
    ["Workout for 9/11/2026", "=== cloud copy 9/11 ==="]);
  assert.deepStrictEqual(parsed.map((s) => s.entries.length), [1, 1]);
});

test("sample log parses into two sessions", () => {
  const parsed = G.parseLog(G.SAMPLE_LOG);
  assert.deepStrictEqual(parsed.map((s) => s.title), ["PUSH 09-11", "LEGS 09-12"]);
});

test("tb is a T-Bar Row base across equipment and angle forms", () => {
  assert.strictEqual(label("tb"), "Barbell T-Bar Row");
  assert.strictEqual(label("mtb"), "Machine T-Bar Row");
  assert.strictEqual(label("stb"), "Smith Machine T-Bar Row");
  assert.strictEqual(label("itb"), "Incline Barbell T-Bar Row");
});

test("sh is a Shrug base across equipment forms", () => {
  assert.strictEqual(label("sh"), "Barbell Shrug");
  assert.strictEqual(label("dbsh"), "Dumbbell Shrug");
  assert.strictEqual(label("msh"), "Machine Shrug");
  assert.strictEqual(label("ssh"), "Smith Machine Shrug");
  assert.strictEqual(label("sh.b"), "Barbell Shrug (Behind the Back)");
});

test("new tb/sh codes do not shadow existing press and equipment forms", () => {
  assert.strictEqual(label("dp"), "Decline Barbell Press");
  assert.strictEqual(label("t"), "Barbell Triceps Extension");
  assert.strictEqual(label("ct.r"), "Cable Triceps Extension (Rope)");
  assert.strictEqual(label("r"), "Barbell Row");
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log("  pass  " + name); }
  catch (e) { failed++; console.log("  FAIL  " + name + "\n        " + e.message); }
}
console.log(failed ? "\n" + failed + " failing" : "\nall " + tests.length + " passing");
process.exit(failed ? 1 : 0);
