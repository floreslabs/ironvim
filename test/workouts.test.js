const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  createWorkout,
  splitWorkoutDocument,
  migrateLocalWorkouts,
  loadLocalWorkouts,
  saveLocalWorkouts,
  mostRecentWorkout,
} = require("../workouts.js");

// The real in-page grammar: session headers are unparseable lines, so a legacy
// multi-session document splits exactly where the parser starts a new session.
const htmlSrc = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const grammarSlice = htmlSrc.slice(htmlSrc.indexOf("const ANGLE_LABELS"), htmlSrc.indexOf("/* ---------------- session header convention"));
const G = new Function(grammarSlice + "; return { parseLog };")();
const realParseLog = G.parseLog;

const parseLog = (text) => {
  const sessions = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line && /^[A-Z][A-Z ]+ \d\d-\d\d$/.test(line)) sessions.push({ title: line });
  }
  return sessions;
};

const storage = (initial) => {
  const values = Object.assign({}, initial);
  return {
    values,
    getItem: (key) => (key in values ? values[key] : null),
    setItem: (key, value) => { values[key] = String(value); },
  };
};

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("splits a document at parsed session boundaries and selects the latest row", () => {
  const text = "PUSH 09-11\np 135x8\n\nLEGS 09-12\nsq 225x5";
  const rows = splitWorkoutDocument(text, parseLog);
  assert.deepStrictEqual(rows.map((row) => row.body), [
    "PUSH 09-11\np 135x8",
    "LEGS 09-12\nsq 225x5",
  ]);
  assert.strictEqual(mostRecentWorkout(rows).body, rows[1].body);
});

test("migrating an empty document creates one dated workout", () => {
  const rows = migrateLocalWorkouts("", parseLog, new Date("2026-09-12T14:38:49.363Z"));
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].body, "Workout for 9/12/2026");
  assert.strictEqual(rows[0].createdAt, "2026-09-12T14:38:49.363Z");
  assert.strictEqual(rows[0].updatedAt, rows[0].createdAt);
  assert.strictEqual(rows[0].revision, null);
  assert.strictEqual(rows[0].dirty, true);
});

test("loading a stored v1 collection does not re-migrate it", () => {
  const workouts = [createWorkout("PUSH 09-11\np 135x8", new Date("2026-09-11T12:00:00Z"), "push")];
  const store = storage({
    "ironvim-workouts": JSON.stringify({ version: 1, workouts }),
    "ironvim-logs-text": "LEGS 09-12\nsq 225x5",
  });
  const loaded = loadLocalWorkouts(store, () => { throw new Error("unexpected migration"); }, new Date("2026-09-12T12:00:00Z"));
  assert.deepStrictEqual(loaded, workouts);
});

test("migrating legacy text writes the new collection without deleting the old text", () => {
  const store = storage({ "ironvim-logs-text": "PUSH 09-11\np 135x8" });
  const rows = loadLocalWorkouts(store, parseLog, new Date("2026-09-12T12:00:00Z"));
  assert.deepStrictEqual(rows.map((row) => row.body), ["PUSH 09-11\np 135x8"]);
  assert.deepStrictEqual(JSON.parse(store.values["ironvim-workouts"]), { version: 1, workouts: rows });
  assert.strictEqual(store.values["ironvim-logs-text"], "PUSH 09-11\np 135x8");
});

test("multi-session legacy text migrates with exact headers and exercise lines", () => {
  const text = "PUSH 09-11\np 135x8,8 \"bench day\n\nLEGS 09-12\nsq 225x5*5\nlc.l 90x12";
  const rows = migrateLocalWorkouts(text, realParseLog, new Date("2026-09-12T12:00:00Z"));
  assert.deepStrictEqual(rows.map((row) => row.body), [
    "PUSH 09-11\np 135x8,8 \"bench day",
    "LEGS 09-12\nsq 225x5*5\nlc.l 90x12",
  ]);
  assert.deepStrictEqual(realParseLog(rows[0].body).map((s) => s.title), ["PUSH 09-11"]);
  assert.deepStrictEqual(realParseLog(rows[1].body).map((s) => s.title), ["LEGS 09-12"]);
});

test("saving a collection stores the versioned payload", () => {
  const store = storage();
  const workouts = [createWorkout("LEGS 09-12\nsq 225x5", new Date("2026-09-12T12:00:00Z"), "legs")];
  saveLocalWorkouts(store, workouts);
  assert.deepStrictEqual(JSON.parse(store.values["ironvim-workouts"]), { version: 1, workouts });
});

test("mostRecentWorkout uses updated timestamps and returns null for no rows", () => {
  const old = createWorkout("old", new Date("2026-09-11T12:00:00Z"), "old");
  const recent = createWorkout("recent", new Date("2026-09-12T12:00:00Z"), "recent");
  old.updatedAt = "2026-09-13T12:00:00Z";
  assert.strictEqual(mostRecentWorkout([recent, old]), old);
  assert.strictEqual(mostRecentWorkout([]), null);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log("  pass  " + name); }
  catch (e) { failed++; console.log("  FAIL  " + name + "\n        " + e.message); }
}
console.log(failed ? "\n" + failed + " failing" : "\nall " + tests.length + " passing");
