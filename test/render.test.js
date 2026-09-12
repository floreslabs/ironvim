/* Compiles the in-page babel block and mounts <App/> in jsdom, so effects (and
 * therefore the sync wiring) actually run. A broken edit fails here instead of
 * as a blank screen on a phone at the gym. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Babel = require("@babel/standalone");
const React = require("react");
const { JSDOM } = require("jsdom");

const src = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const MARK = 'data-presets="react">';
const start = src.indexOf(MARK) + MARK.length;
const block = src.slice(start, src.indexOf("</script>", start));

function compile() {
  return Babel.transform(block.replace(/ReactDOM\.createRoot[\s\S]*$/, ""),
    { presets: [["react", { runtime: "classic" }]] }).code;
}

// Fresh jsdom + fresh react-dom per mount: react-dom caches globals at require time.
function mount(syncStub) {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://ironvim.test/" });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.localStorage = dom.window.localStorage;
  global.requestAnimationFrame = (fn) => fn();
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.ironvimSync = syncStub;
  dom.window.ironvimWorkouts = {
    createWorkout: (body) => ({ id:"local-workout", body, createdAt:"2026-09-12T00:00:00.000Z", updatedAt:"2026-09-12T00:00:00.000Z", revision:null, dirty:true }),
    loadLocalWorkouts: () => [{ id:"local-workout", body:"PUSH\np 135x8", createdAt:"2026-09-12T00:00:00.000Z", updatedAt:"2026-09-12T00:00:00.000Z", revision:null, dirty:true }],
    saveLocalWorkouts() {},
    mostRecentWorkout: (rows) => rows[0],
  };

  for (const k of Object.keys(require.cache)) if (k.includes("react-dom")) delete require.cache[k];
  const ReactDOMClient = require("react-dom/client");
  const act = React.act;

  const { App } = new Function("React", compile() + "; return { App, GrammarReference, Modal, SYNC_LABELS };")(React);
  const el = dom.window.document.getElementById("root");
  act(() => { ReactDOMClient.createRoot(el).render(React.createElement(App)); });
  return el.innerHTML;
}

function exports_() {
  return new Function("React", compile() + "; return { App, GrammarReference, Modal, SYNC_LABELS };")(React);
}

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("compiles under the react preset", () => {
  const compiled = compile();
  assert.ok(compiled.length > 0);
  assert.ok(compiled.includes("ironvimWorkouts"), "app consumes the workout collection API");
  assert.ok(compiled.includes("selectedWorkoutId"), "editor state is a selected workout id");
  assert.ok(compiled.includes("updateSelectedWorkout"), "textarea edits the selected workout");
  assert.ok(!compiled.includes("setText(e.target.value)"), "single-document editor binding is gone");
});

test("mounts with no sync module at all (CDN blocked / offline cold start)", () => {
  const html = mount(undefined);
  assert.ok(html.includes("local only"), "status falls back to local-only");
  assert.ok(html.includes("Cloud sync is not configured"));
  assert.ok(html.includes("+ new workout") && html.includes("? grammar"), "log controls intact");
  assert.ok(html.includes(">edit</button>"), "parsed workout has an edit action");
});

test("signed out: email field and magic-link action", () => {
  const html = mount({ getStatus: () => "signed-out", init() {} });
  assert.ok(html.includes('placeholder="you@email.com"'));
  assert.ok(html.includes("email sign-in link"));
  assert.ok(!html.includes('placeholder="6-digit code"'), "magic-link flow has no code field");
});

test("signed in: shows the address, sign out, and synced status", () => {
  const html = mount({
    getStatus: () => "synced",
    init: (h) => { h.onAuth("lifter@example.com"); h.onStatus("synced", null); },
  });
  assert.ok(html.includes("lifter@example.com"), "address shown");
  assert.ok(html.includes("sign out"));
  assert.ok(html.includes("✓ synced"), "title bar shows synced");
  assert.ok(!html.includes('placeholder="you@email.com"'), "form replaced");
});

test("conflict: modal shows both copies and all three choices", () => {
  const html = mount({
    getStatus: () => "conflict",
    init: (h) => {
      h.onStatus("conflict", null);
      h.onConflict({ workoutId:"local-workout", local: { body: "MINE\np 135x8" }, remote: { body: "THEIRS\nsq 225x5" } });
    },
  });
  assert.ok(html.includes("SYNC CONFLICT"));
  assert.ok(html.includes("MINE") && html.includes("THEIRS"), "both copies rendered");
  ["keep mine", "use cloud", "keep both"].forEach((b) =>
    assert.ok(html.includes(b), "missing button: " + b));
  assert.ok(html.includes("⚠ conflict"), "title bar reflects the conflict");
});

test("sync reports the local state it will push", () => {
  let captured = null;
  mount({ getStatus: () => "signed-out", init: (h) => { captured = h.getLocal(); } });
  assert.ok(captured, "init received a getLocal hook");
  assert.ok(captured.workouts[0].body.includes("PUSH"), "local workout handed to sync");
  assert.strictEqual(captured.bodyweight, "180");
  assert.strictEqual(captured.untouched, false, "test workout is not the untouched sample");
  assert.ok(captured.legend.pd, "legend included");
});

test("every sync status maps to a label", () => {
  const { SYNC_LABELS } = exports_();
  ["local-only", "signed-out", "syncing", "synced", "offline", "conflict"].forEach((s) =>
    assert.ok(SYNC_LABELS[s] && SYNC_LABELS[s].text, "no label for " + s));
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log("  pass  " + name); }
  catch (e) { failed++; console.log("  FAIL  " + name + "\n        " + e.message); }
}
console.log(failed ? "\n" + failed + " failing" : "\nall " + tests.length + " passing");
process.exit(failed ? 1 : 0);
