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
// Returns the live dom so tests can dispatch clicks and re-read state after events.
function mountDom(syncStub) {
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

  const { App } = new Function("React", compile() + "; return { App, GrammarReference, Modal, SYNC_LABELS, exerciseLabelAtSelection };")(React);
  const el = dom.window.document.getElementById("root");
  act(() => { ReactDOMClient.createRoot(el).render(React.createElement(App)); });
  return { dom, el, act };
}

function mount(syncStub) {
  return mountDom(syncStub).el.innerHTML;
}

function exports_() {
  return new Function("React", compile() + "; return { App, GrammarReference, Modal, SYNC_LABELS, exerciseLabelAtSelection, ...(typeof buildSetTable === \"function\" ? { buildSetTable } : {}), ...(typeof countSourceLines === \"function\" ? { countSourceLines } : {}), ...(typeof lineOffsets === \"function\" ? { lineOffsets } : {}), ...(typeof rowSpanCount === \"function\" ? { rowSpanCount } : {}) };")(React);
}

const tests = [];
const test = (n, f) => tests.push([n, f]);

test("compiles under the react preset", () => {
  const compiled = compile();
  assert.ok(compiled.length > 0);
  assert.ok(compiled.includes("ironvimWorkouts"), "app consumes the workout collection API");
  assert.ok(compiled.includes("editingId"), "editor state is the workout id being edited");
  assert.ok(compiled.includes("updateWorkout"), "textarea edits a workout by id");
  assert.ok(!compiled.includes("selectedWorkoutId"), "main selected-workout editor is gone");
  assert.ok(!compiled.includes("updateSelectedWorkout"), "single selected-editor binding is gone");
  assert.ok(!compiled.includes("setText(e.target.value)"), "single-document editor binding is gone");
});

test("mounts with no sync module at all (CDN blocked / offline cold start)", () => {
  const html = mount(undefined);
  assert.ok(html.includes("local only"), "status falls back to local-only");
  assert.ok(html.includes("Cloud sync is not configured"));
  assert.ok(html.includes("+ new workout") && html.includes("? grammar"), "log controls intact");
  assert.ok(html.includes(">edit</button>"), "parsed workout has an edit action");
  assert.ok(!html.includes("<textarea"), "no main editor textarea on the default mount");
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
  assert.strictEqual(captured.bodyweight, undefined, "bodyweight dropped from the sync payload");
  assert.strictEqual(captured.untouched, false, "test workout is not the untouched sample");
  assert.ok(captured.legend.pd, "legend included");
});

test("edit button opens a modal textarea bound to that workout", () => {
  let getLocal = null;
  const { dom, el, act } = mountDom({ getStatus: () => "signed-out", init: (h) => { getLocal = h.getLocal; } });
  const editBtn = [...dom.window.document.querySelectorAll("button")].find((b) => b.textContent.trim() === "edit");
  assert.ok(editBtn, "session card has an edit button");

  act(() => { editBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
  const ta = dom.window.document.querySelector("textarea");
  assert.ok(ta, "modal renders a textarea");
  assert.ok(el.innerHTML.includes("EDIT WORKOUT"), "modal title shown");
  assert.ok(el.innerHTML.includes(">done</button>"), "modal has a done button");
  assert.strictEqual(ta.value, "PUSH\np 135x8", "textarea shows the workout raw body");

  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set;
  act(() => {
    setter.call(ta, "PUSH\np 200x5");
    ta.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  assert.ok(getLocal().workouts[0].body.includes("p 200x5"), "typing in the modal updates the workout collection");
});

test("edit modal layers a colorized copy of the raw log behind the textarea", () => {
  const { dom, act } = mountDom({ getStatus: () => "signed-out", init: () => {} });
  const editBtn = [...dom.window.document.querySelectorAll("button")].find((b) => b.textContent.trim() === "edit");
  act(() => { editBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });

  const ta = dom.window.document.querySelector("textarea");
  const pre = dom.window.document.querySelector(".gl-highlight");
  assert.ok(pre, "highlight layer rendered behind the editor");
  assert.strictEqual(ta.value, "PUSH\np 135x8", "textarea keeps the raw editable text");
  assert.strictEqual(pre.textContent, "PUSH\np 135x8", "highlight layer mirrors the raw log");
  const html = pre.innerHTML;
  assert.ok(html.includes('color:#f89860">PUSH<'), "session header colored");
  assert.ok(html.includes('color:#bb97ee">p<'), "exercise token purple");
  assert.ok(html.includes('color:#edc763">135<'), "weight yellow");
  assert.ok(html.includes('color:#9ed06c">8<'), "reps green");
});

test("highlight follows typing through variation, sets, comments, and bw removal", () => {
  const { dom, act } = mountDom({ getStatus: () => "signed-out", init: () => {} });
  const editBtn = [...dom.window.document.querySelectorAll("button")].find((b) => b.textContent.trim() === "edit");
  act(() => { editBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
  const ta = dom.window.document.querySelector("textarea");
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set;
  const next = "SHIFT\nsh.rg 25x12,12,10 \"wide grip";
  act(() => {
    setter.call(ta, next);
    ta.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });

  const pre = dom.window.document.querySelector(".gl-highlight");
  assert.strictEqual(pre.textContent, next, "layer mirrors edited text");
  const html = pre.innerHTML;
  assert.ok(html.includes('color:#f89860">SHIFT<'), "header stays orange");
  assert.ok(html.includes('color:#bb97ee">sh<'), "base token purple");
  assert.ok(html.includes('color:#6dcae8">.rg<'), "variation blue");
  assert.ok(html.includes('color:#edc763">25<'), "weight yellow");
  assert.ok(html.includes('color:#9ed06c">12<') && html.includes('color:#9ed06c">10<'), "reps green");
  assert.ok(html.includes('color:#7e8294;font-style:italic') && html.includes("wide grip"), "comment gray italic");

  const bw = "PUSH\np bw+25x8";
  act(() => {
    setter.call(ta, bw);
    ta.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  assert.ok(!pre.innerHTML.includes('color:#edc763">bw'), "bw is not highlighted as a weight");
});

test("editor and highlight layer share exact layout metrics", () => {
  const { dom, act } = mountDom({ getStatus: () => "signed-out", init: () => {} });
  const editBtn = [...dom.window.document.querySelectorAll("button")].find((b) => b.textContent.trim() === "edit");
  act(() => { editBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });

  const ta = dom.window.document.querySelector("textarea");
  const pre = dom.window.document.querySelector(".gl-highlight");
  assert.strictEqual(ta.style.borderWidth, "0px", "textarea chrome border zeroed so the caret aligns");
  assert.strictEqual(ta.style.overflow, "hidden", "no scrollbar gutter shifts the wrap points");
  assert.strictEqual(ta.style.fontSize, "16px", "textarea honors the iOS 16px minimum");
  assert.strictEqual(pre.style.fontSize, ta.style.fontSize, "highlight layer matches the textarea font size");
  assert.strictEqual(pre.style.wordBreak, "break-all", "highlight wraps at characters like a textarea");
});

test("exercise label follows the selection range across a line", () => {
  const { exerciseLabelAtSelection } = exports_();
  const body = "PUSH 09-11\np 135x8\nsh.rg 25x12,12,10 \"wide grip";
  assert.strictEqual(exerciseLabelAtSelection("", 0, 0, {}), null, "empty body has no label");
  assert.strictEqual(exerciseLabelAtSelection(body, 10, 10, {}), null, "header line has no label");
  assert.strictEqual(exerciseLabelAtSelection(body, 18, 18, {}), "Barbell Press", "collapsed caret at the end of the p line");
  assert.strictEqual(exerciseLabelAtSelection(body, 13, 15, {}), "Barbell Press", "selecting any character of the p line labels it");
  assert.strictEqual(exerciseLabelAtSelection(body, 12, 18, {}), "Barbell Press", "selection spanning the p line from a space");
  assert.strictEqual(exerciseLabelAtSelection(body, 30, 40, {}), "Barbell Shrug (RG)", "selection inside the noted sh.rg line");
});

test("exercise label resolves from a bare code token before weights exist", () => {
  const { exerciseLabelAtSelection } = exports_();
  assert.strictEqual(exerciseLabelAtSelection("PUSH\npu", 7, 7, {}), "Bodyweight Pull-Up", "bare pu token labels");
  assert.strictEqual(exerciseLabelAtSelection("PUSH\np", 6, 6, {}), "Barbell Press", "bare p token labels");
  assert.strictEqual(exerciseLabelAtSelection("PUSH\nsh.b", 9, 9, { sh: { b: "Behind the Back" } }), "Barbell Shrug (Behind the Back)", "variation-only token labels");
  assert.strictEqual(exerciseLabelAtSelection("PUSH\np 1", 8, 8, {}), "Barbell Press", "code token with a partial weight still labels");
  assert.strictEqual(exerciseLabelAtSelection("PUSH\nqq", 7, 7, {}), null, "unknown token stays unlabeled");
  assert.strictEqual(exerciseLabelAtSelection("PUSH 09-11", 6, 6, {}), null, "session header stays unlabeled");
});

test("edit modal status bar shows the exercise at the caret", () => {
  const { dom, act } = mountDom({ getStatus: () => "signed-out", init: () => {} });
  const editBtn = [...dom.window.document.querySelectorAll("button")].find((b) => b.textContent.trim() === "edit");
  act(() => { editBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });

  const ta = dom.window.document.querySelector("textarea");
  const labelEl = dom.window.document.querySelector(".gl-exercise-label");
  assert.ok(labelEl, "status bar rendered in the modal");

  act(() => { ta.setSelectionRange(2, 2); ta.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
  assert.ok(labelEl.textContent.includes("—"), "caret inside the header line shows the placeholder");

  act(() => { ta.setSelectionRange(8, 12); ta.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
  assert.ok(labelEl.textContent.includes("Barbell Press"), "selecting part of the p line labels it");

  act(() => { ta.setSelectionRange(15, 15); ta.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
  assert.ok(labelEl.textContent.includes("Barbell Press"), "caret on the p line shows the press label");

  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set;
  act(() => {
    setter.call(ta, "PUSH\nsh.b 25x12");
    ta.setSelectionRange("PUSH\nsh.b 25x12".length, "PUSH\nsh.b 25x12".length);
    ta.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  assert.ok(labelEl.textContent.includes("Barbell Shrug (Behind the Back)"), "typing a shrug updates the label");

  act(() => {
    setter.call(ta, "PUSH\npu");
    ta.setSelectionRange("PUSH\npu".length, "PUSH\npu".length);
    ta.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  assert.ok(labelEl.textContent.includes("Pull-Up"), "a bare pu token updates the label");

  act(() => {
    setter.call(ta, "PUSH\nqq");
    ta.setSelectionRange("PUSH\nqq".length, "PUSH\nqq".length);
    ta.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  assert.ok(labelEl.textContent.includes("—"), "an unknown token keeps the placeholder");
});

test("edit modal highlights the active row with the sonokai cursorline color", () => {
  const { dom, act } = mountDom({ getStatus: () => "signed-out", init: () => {} });
  const editBtn = [...dom.window.document.querySelectorAll("button")].find((b) => b.textContent.trim() === "edit");
  act(() => { editBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });

  const ta = dom.window.document.querySelector("textarea");
  const pre = dom.window.document.querySelector(".gl-highlight");

  act(() => { ta.setSelectionRange(12, 12); ta.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
  let html = pre.innerHTML;
  assert.ok(html.includes('<span class="gl-active-line" style="display:inline-block;width:100%;background:#333648">'), "active row is a full-width inline block (no block-level box, so no orphan line)");
  assert.ok(html.indexOf('class="gl-active-line"') < html.indexOf('color:#bb97ee">p<'), "highlight wraps the p line");
  assert.strictEqual(pre.textContent, "PUSH\np 135x8", "the highlight background leaves the mirrored text intact");

  act(() => { ta.setSelectionRange(2, 2); ta.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });
  html = pre.innerHTML;
  assert.ok(html.indexOf('class="gl-active-line"') < html.indexOf('color:#f89860">PUSH<'), "highlight moves to the header row");
});

test("countSourceLines counts editable rows including a trailing empty line", () => {
  const { countSourceLines } = exports_();
  assert.strictEqual(countSourceLines(""), 1, "empty body still has one blank row");
  assert.strictEqual(countSourceLines("PUSH\np 135x8"), 2);
  assert.strictEqual(countSourceLines("PUSH\np 135x8\n"), 3, "trailing newline adds a blank row");
  assert.strictEqual(countSourceLines("\n\n"), 3);
});

test("lineOffsets maps each source line to its byte range", () => {
  const { lineOffsets } = exports_();
  assert.deepStrictEqual(lineOffsets(""), [{ start:0, end:0 }], "an empty body is a single blank row");
  assert.deepStrictEqual(lineOffsets("PUSH\np 135x8"), [{ start:0, end:4 }, { start:5, end:12 }]);
  assert.deepStrictEqual(lineOffsets("PUSH\n"), [{ start:0, end:4 }, { start:5, end:5 }], "trailing newline yields an empty final line");
  assert.deepStrictEqual(lineOffsets("a\nb\nc"), [{ start:0, end:1 }, { start:2, end:3 }, { start:4, end:5 }]);
});

test("edit modal gutter numbers one cell per source line with the active line blue", () => {
  const { dom, act } = mountDom({ getStatus: () => "signed-out", init: () => {} });
  const editBtn = [...dom.window.document.querySelectorAll("button")].find((b) => b.textContent.trim() === "edit");
  act(() => { editBtn.dispatchEvent(new dom.window.Event("click", { bubbles: true })); });

  const ta = dom.window.document.querySelector("textarea");
  const gutter = dom.window.document.querySelector(".gl-gutter");
  assert.ok(gutter, "gutter column rendered");
  const cells = [...dom.window.document.querySelectorAll(".gl-gutter-line")];
  assert.strictEqual(cells.length, 2, "one gutter cell per source line");
  assert.deepStrictEqual(cells.map((c) => c.textContent), ["", "1"], "the title row is blank and numbering starts at 1 on the second row");

  assert.strictEqual(gutter.style.fontFamily, ta.style.fontFamily, "gutter uses the editor font");
  assert.strictEqual(gutter.style.fontSize, ta.style.fontSize, "gutter matches the editor font size");
  assert.strictEqual(gutter.style.lineHeight, ta.style.lineHeight, "gutter row height matches the editor");

  assert.strictEqual(cells[1].style.color, "rgb(109, 202, 232)", "the active (last) line number is blue");
  assert.strictEqual(cells[0].style.color, "rgb(126, 130, 148)", "inactive numbers stay gray");
  assert.strictEqual(cells[0].style.height, "25.6px", "unwrapped rows are one editor row tall");

  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set;
  act(() => {
    setter.call(ta, "PUSH\np 135x8\n");
    ta.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  const after = [...dom.window.document.querySelectorAll(".gl-gutter-line")];
  assert.strictEqual(after.length, 3, "a trailing newline adds a gutter cell");
  assert.deepStrictEqual(after.map((c) => c.textContent), ["", "1", "2"], "numbering continues past the blank title row");

  act(() => {
    setter.call(ta, "p 135x8\nct.r 60x12");
    ta.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  const noTitle = [...dom.window.document.querySelectorAll(".gl-gutter-line")];
  assert.deepStrictEqual(noTitle.map((c) => c.textContent), ["", "1"], "the first body row is always treated as the title");
});

test("rowSpanCount collapses per-fragment rects into distinct visual rows", () => {
  const { rowSpanCount } = exports_();
  assert.strictEqual(rowSpanCount([]), 1, "no layout data → one row");
  assert.strictEqual(rowSpanCount([10]), 1);
  assert.strictEqual(rowSpanCount([10.2, 10.4, 10.0]), 1, "many inline fragments on one visual row collapse to 1");
  assert.strictEqual(rowSpanCount([10, 35.6]), 2, "a wrapped line reports one top per visual row");
  assert.strictEqual(rowSpanCount([10, 35.6, 35.61, 61.2]), 3);
});

test("buildSetTable flattens exercises into a code-column table", () => {
  const { buildSetTable } = exports_();
  const rows = buildSetTable([
    { code:"le", base:"le", angle:null, equipment:null, variation:null, note:"ascending",
      sets:[{ weightRaw:"120", reps:12 },{ weightRaw:"140", reps:10 },{ weightRaw:"160", reps:8 }] },
    { code:"p", base:"p", angle:null, equipment:null, variation:null, note:null,
      sets:[{ weightRaw:"135", reps:8 },{ weightRaw:"135", reps:6 }] },
  ], {});
  assert.strictEqual(rows.length, 5, "one table row per set");
  assert.strictEqual(rows[0].code, "le", "code shown on the group's first row");
  assert.strictEqual(rows[0].name, "Machine Leg Extension", "name resolved on the group's first row");
  assert.strictEqual(rows[0].note, "ascending", "note rides the first row");
  assert.strictEqual(rows[0].weight, "120", "weight cell holds the raw weight, no unit (the column carries lb)");
  assert.strictEqual(rows[0].reps, 12, "reps cell holds the raw reps");
  assert.strictEqual(rows[1].code, null, "continuation rows drop the code");
  assert.strictEqual(rows[1].name, null, "continuation rows drop the name");
  assert.strictEqual(rows[1].note, null, "note only on the first row");
  assert.deepStrictEqual(rows.map((r) => r.weight), ["120","140","160","135","135"]);
  assert.deepStrictEqual(rows.map((r) => r.reps), [12,10,8,8,6]);
  assert.strictEqual(rows[3].name, "Barbell Press", "second group re-names on its own first row");
});

test("buildSetTable resolves variations and names each group once", () => {
  const { buildSetTable } = exports_();
  const rows = buildSetTable([
    { code:"sh.rg", base:"sh", angle:null, equipment:null, variation:"rg", note:"wide grip",
      sets:[{ weightRaw:"25", reps:12 },{ weightRaw:"25", reps:12 },{ weightRaw:"25", reps:10 }] },
  ], {});
  assert.strictEqual(rows[0].code, "sh.rg", "full typed token in the code column");
  assert.strictEqual(rows[0].name, "Barbell Shrug (RG)", "variation folded into the name");
  assert.strictEqual(rows[0].note, "wide grip");
  assert.strictEqual(rows[1].name, null);
  assert.strictEqual(rows[2].name, null);
  assert.strictEqual(rows[2].note, null);
});

test("workouts panel renders a light code-column table", () => {
  const html = mount(undefined);
  assert.ok(html.includes(">CODE<"), "code column header");
  assert.ok(html.includes(">EXERCISE<"), "exercise column header");
  assert.ok(html.includes(">WEIGHT (LB)<"), "weight column header");
  assert.ok(html.includes(">REPS<"), "reps column header");
  assert.ok(html.includes("Barbell Press"), "exercise name on the first row");
  assert.ok(html.includes(">WEIGHT (LB)<"), "weight column header carries the unit");
  assert.ok(html.includes(">135<"), "weight cell shows the unitless number");
  assert.ok(html.includes(">8<"), "reps cell for the single p set");
  assert.ok(!html.includes("width:18"), "per-set index rail is gone");
});

test("workout card: no header volume, edit button in brand blue, all-time row shows reps at max weight", () => {
  const { dom } = mountDom({ getStatus: () => "signed-out", init: () => {} });
  const html = dom.window.document.getElementById("root").innerHTML;
  assert.ok(html.includes("135 lb max × 8"), "the all-time row includes the reps at the max weight");
  const editBtn = [...dom.window.document.querySelectorAll("button")].find((b) => b.textContent.trim() === "edit");
  assert.ok(editBtn, "edit button present");
  assert.ok(!editBtn.parentElement.textContent.includes("lb"), "no volume label rides next to the edit button");
  assert.strictEqual(editBtn.style.background, "rgb(118, 204, 224)", "edit stands out in brand blue");
  assert.strictEqual(editBtn.style.color, "rgb(44, 46, 52)", "edit text rides dark on the brand fill");
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
