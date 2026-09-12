/* Node harness for the sync state machine. Stubs window.supabase with a fake
 * PostgREST builder so every branch can be driven without a network or a build. */
const assert = require("assert");
const path = require("path");

let store, statuses, conflicts, applied, calls, remote, failNext;

function fakeQuery(table, kind, payload) {
  const q = { filters: {} };
  q.eq = (col, val) => { q.filters[col] = val; return q; };
  q.select = () => {
    calls.push({ kind, payload, filters: q.filters });
    if (failNext) { failNext = false; return Promise.reject(new Error("network down")); }
    if (kind === "select") {
      q.maybeSingle = undefined;
      return Promise.resolve({ data: remote, error: null });
    }
    if (kind === "insert") {
      remote = Object.assign({ revision: 1, updated_at: "2026-09-11T12:00:00Z" }, payload);
      return { single: () => Promise.resolve({ data: { revision: 1 }, error: null }) };
    }
    // update: honor the optimistic revision filter
    if (q.filters.revision != null && q.filters.revision !== remote.revision) {
      return Promise.resolve({ data: [], error: null });
    }
    remote = Object.assign({}, remote, payload, { revision: remote.revision + 1 });
    return Promise.resolve({ data: [{ revision: remote.revision }], error: null });
  };
  q.maybeSingle = () => {
    calls.push({ kind, filters: q.filters });
    if (failNext) { failNext = false; return Promise.reject(new Error("network down")); }
    return Promise.resolve({ data: remote, error: null });
  };
  q.single = () => q.select().single();
  return q;
}

let session = null;
const fakeClient = {
  from: () => ({
    select: () => fakeQuery("logs", "select"),
    insert: (payload) => fakeQuery("logs", "insert", payload),
    update: (payload) => fakeQuery("logs", "update", payload),
  }),
  auth: {
    getSession: () => Promise.resolve({ data: { session } }),
    signOut: () => Promise.resolve({}),
  },
};

function reset(localState, opts) {
  opts = opts || {};
  store = {};
  statuses = []; conflicts = []; applied = []; calls = [];
  remote = opts.remote === undefined ? null : opts.remote;
  session = opts.session ? { user: { id: "user-1", email: "a@b.c" } } : null;
  failNext = false;
  global.window = {
    addEventListener() {},
    supabase: { createClient: () => fakeClient },
    IRONVIM_SUPABASE: { url: "https://test.supabase.co", publishableKey: "sb_publishable_test" },
  };
  global.document = { addEventListener() {}, visibilityState: "visible" };
  global.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  delete require.cache[require.resolve(path.join("..", "sync.js"))];
  const sync = require("../sync.js");
  sync._setClient(fakeClient, "user-1", "a@b.c");
  sync._setHooks(hooksFor(localState));
  return sync;
}

function hooksFor(localState) {
  return {
    getLocal: () => localState,
    applyRemote: (r) => { applied.push(r); Object.assign(localState, r); },
    onStatus: (s, d) => statuses.push(d ? s + ":" + d : s),
    onConflict: (c) => conflicts.push(c),
    onAuth: () => {},
  };
}

const local = () => ({ text: "PUSH\np 135x8", bodyweight: "180", legend: { pd: { w: "Wide Bar" } }, untouched: false });
const last = (a) => a[a.length - 1];
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("first sign-in with no remote row uploads the local log", async () => {
  const l = local();
  const s = reset(l, { remote: null, session: true });
  await s.init(hooksFor(l));
  assert.strictEqual(remote.body, l.text, "local log was uploaded");
  assert.strictEqual(remote.bodyweight, 180);
  assert.strictEqual(store["ironvim-sync-revision"], "1");
  assert.ok(!store["ironvim-sync-dirty"]);
  assert.strictEqual(last(statuses), "synced");
});

test("clean local adopts the remote row on load", async () => {
  const l = local();
  const s = reset(l, { session: true, remote: { body: "LEGS\nsq 225x5", bodyweight: 175, legend: { lc: { l: "Lying" } }, revision: 7, updated_at: "t" } });
  await s.init(hooksFor(l));
  assert.strictEqual(l.text, "LEGS\nsq 225x5", "remote copy adopted");
  assert.strictEqual(l.bodyweight, "175");
  assert.strictEqual(store["ironvim-sync-revision"], "7");
  assert.strictEqual(last(statuses), "synced");
  assert.ok(!calls.some((c) => c.kind === "update"), "adopting must not write back");
});

test("untouched sample log never wins over the cloud", async () => {
  const l = Object.assign(local(), { untouched: true });
  const s = reset(l, { session: true, remote: { body: "real history", bodyweight: 175, legend: {}, revision: 3, updated_at: "t" } });
  store["ironvim-sync-dirty"] = "1";         // sample text counts as dirty locally
  await s.init(hooksFor(l));
  assert.strictEqual(l.text, "real history", "cloud won over the untouched sample");
  assert.ok(!store["ironvim-sync-dirty"]);
});

test("no session -> signed-out, nothing read or written", async () => {
  const l = local();
  const s = reset(l, { session: false, remote: { body: "x", revision: 1, legend: {}, updated_at: "t" } });
  await s.init(hooksFor(l));
  assert.strictEqual(last(statuses), "signed-out");
  assert.deepStrictEqual(calls, [], "no row access without a session");
});

test("dirty + base revision current -> pushes and clears dirty", async () => {
  const l = local();
  const s = reset(l, { remote: { body: "old", bodyweight: 180, legend: {}, revision: 4, updated_at: "t" } });
  store["ironvim-sync-revision"] = "4";
  s.notifyChange();
  assert.strictEqual(store["ironvim-sync-dirty"], "1");
  await s.flush();
  assert.strictEqual(remote.body, l.text, "remote took our text");
  assert.strictEqual(remote.revision, 5, "revision bumped");
  assert.strictEqual(store["ironvim-sync-revision"], "5");
  assert.ok(!store["ironvim-sync-dirty"], "dirty cleared after push");
  assert.strictEqual(last(statuses), "synced");
});

test("dirty + stale base revision -> conflict, dirty kept", async () => {
  const l = local();
  const s = reset(l, { remote: { body: "cloud text", bodyweight: 190, legend: {}, revision: 9, updated_at: "2026-09-11T16:12:00Z" } });
  store["ironvim-sync-revision"] = "4";      // someone else wrote since our base
  s.notifyChange();
  await s.flush();
  assert.strictEqual(last(statuses), "conflict");
  assert.strictEqual(store["ironvim-sync-dirty"], "1", "dirty must survive a conflict");
  assert.strictEqual(remote.body, "cloud text", "remote untouched");
  assert.strictEqual(last(conflicts).remote.text, "cloud text");
});

test("conflict -> use cloud adopts remote and clears dirty", async () => {
  const l = local();
  const s = reset(l, { remote: { body: "cloud text", bodyweight: 190, legend: { t: { r: "Rope" } }, revision: 9, updated_at: "t" } });
  store["ironvim-sync-revision"] = "4";
  s.notifyChange();
  await s.flush();
  await s.resolveConflict("cloud");
  assert.strictEqual(l.text, "cloud text", "local adopted the cloud copy");
  assert.strictEqual(l.bodyweight, "190", "numeric bodyweight came back as a string");
  assert.strictEqual(store["ironvim-sync-revision"], "9");
  assert.ok(!store["ironvim-sync-dirty"]);
  assert.strictEqual(last(conflicts), null, "conflict cleared");
});

test("conflict -> keep mine force-pushes over the newer remote", async () => {
  const l = local();
  const s = reset(l, { remote: { body: "cloud text", bodyweight: 190, legend: {}, revision: 9, updated_at: "t" } });
  store["ironvim-sync-revision"] = "4";
  s.notifyChange();
  await s.flush();
  await s.resolveConflict("mine");
  assert.strictEqual(remote.body, l.text, "our text won");
  assert.strictEqual(remote.revision, 10);
  assert.ok(!store["ironvim-sync-dirty"]);
  const forced = last(calls);
  assert.strictEqual(forced.filters.revision, undefined, "force push drops the revision filter");
});

test("conflict -> keep both appends the cloud copy under a marker", async () => {
  const l = local();
  const s = reset(l, { remote: { body: "LEGS\nsq 225x5", bodyweight: 190, legend: { t: { r: "Rope" } }, revision: 9, updated_at: "2026-09-11T16:12:00Z" } });
  store["ironvim-sync-revision"] = "4";
  s.notifyChange();
  await s.flush();
  await s.resolveConflict("both");
  assert.ok(l.text.startsWith("PUSH\np 135x8"), "local text kept at the top");
  assert.ok(/=== cloud copy .+ ===/.test(l.text), "marker line present");
  assert.ok(l.text.includes("LEGS\nsq 225x5"), "cloud text appended");
  assert.deepStrictEqual(l.legend, { t: { r: "Rope" }, pd: { w: "Wide Bar" } }, "legends merged");
  assert.strictEqual(remote.body, l.text, "merged text pushed");
  assert.ok(!store["ironvim-sync-dirty"]);
});

test("network failure keeps dirty and reports offline", async () => {
  const l = local();
  const s = reset(l, { remote: { body: "old", bodyweight: 180, legend: {}, revision: 4, updated_at: "t" } });
  store["ironvim-sync-revision"] = "4";
  s.notifyChange();
  failNext = true;
  await s.flush();
  assert.ok(last(statuses).startsWith("offline"), "status is offline, got " + last(statuses));
  assert.strictEqual(store["ironvim-sync-dirty"], "1", "edit stays queued");
  failNext = false;
  await s.flush();                            // retry, e.g. on the online event
  assert.strictEqual(remote.body, l.text, "queued edit pushed on retry");
  assert.ok(!store["ironvim-sync-dirty"]);
});

test("bodyweight crosses the boundary as numeric-or-null", async () => {
  const l = Object.assign(local(), { bodyweight: "" });
  const s = reset(l, { remote: { body: "old", bodyweight: 180, legend: {}, revision: 2, updated_at: "t" } });
  store["ironvim-sync-revision"] = "2";
  s.notifyChange();
  await s.flush();
  assert.strictEqual(remote.bodyweight, null, "empty string became null, not NaN");
});

test("no client -> every entry point is inert", async () => {
  const l = local();
  const s = reset(l);
  s._reset();
  s.notifyChange();
  await s.flush();
  await s.resolveConflict("mine");
  assert.deepStrictEqual(calls, [], "nothing hit the network");
  await assert.rejects(() => s.sendCode("a@b.c"), /not configured/);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log("  pass  " + name); }
    catch (e) { failed++; console.log("  FAIL  " + name + "\n        " + e.message); }
  }
  console.log(failed ? "\n" + failed + " failing" : "\nall " + tests.length + " passing");
  process.exit(failed ? 1 : 0);
})();
