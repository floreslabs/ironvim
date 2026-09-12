/* The grammar tables and parser live inside index.html; pull them out and pin
 * the behavior that earlier changes established (space separators, pd codes). */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const slice = src.slice(src.indexOf("const ANGLE_LABELS"), src.indexOf("/* ---------------- session header convention"));
const G = new Function(slice + "; return { tryParseExerciseLine, parseLog, describeExercise, migrateLegend, DEFAULT_LEGEND, SAMPLE_LOG };")();

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

test("bodyweight and superset forms survive", () => {
  assert.strictEqual(sets("di bw+25x8,8,6"), "bw+25x8 bw+25x8 bw+25x6");
  assert.strictEqual(sets("p 135x8 + c 60x10"), "135x8 | 60x10");
});

test("a bare trailing number fails instead of silently merging digits", () => {
  assert.strictEqual(sets("p 135x8 8"), null);
});

test("pd is the pulldown code, across angle and equipment prefixes", () => {
  assert.strictEqual(label("pd"), "Pulldown");
  assert.strictEqual(label("cpd"), "Cable Pulldown");
  assert.strictEqual(label("ipd"), "Incline Pulldown");
  assert.strictEqual(label("dpd"), "Decline Pulldown");
  assert.strictEqual(label("cpd.t"), "Cable Pulldown (Triangle)");
});

test("retired l code still resolves to pulldown", () => {
  assert.strictEqual(label("l"), "Pulldown");
  assert.strictEqual(label("cl"), "Cable Pulldown");
  assert.strictEqual(label("l.w"), "Pulldown (Wide Bar)");
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

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log("  pass  " + name); }
  catch (e) { failed++; console.log("  FAIL  " + name + "\n        " + e.message); }
}
console.log(failed ? "\n" + failed + " failing" : "\nall " + tests.length + " passing");
process.exit(failed ? 1 : 0);
