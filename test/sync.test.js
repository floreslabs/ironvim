/* Node harness for the row-based sync state machine. */
const assert = require("assert");
const path = require("path");

let store, statuses, conflicts, applied, calls, remote, failNext;
let session = null;
let nextUpdatedAt = 100;
let zeroNextUpdate = false;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function makeRemote(id, body, revision, updatedAt) {
  return {
    id,
    user_id: "user-1",
    body,
    created_at: "2026-09-11T12:00:00Z",
    updated_at: updatedAt || "2026-09-11T12:00:00Z",
    revision: revision == null ? 1 : revision,
  };
}

function runRequest(kind, payload, filters, order) {
  calls.push({ kind, payload: clone(payload), filters: Object.assign({}, filters), order });
  if (failNext) {
    failNext = false;
    return Promise.reject(new Error("network down"));
  }

  if (kind === "select") {
    let rows = remote.filter((row) => Object.keys(filters).every((key) => row[key] === filters[key]));
    if (order && order.column === "updated_at" && order.ascending === false) {
      rows = rows.slice().sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    }
    return Promise.resolve({ data: clone(rows), error: null });
  }

  if (kind === "insert") {
    const payloadRows = Array.isArray(payload) ? payload : [payload];
    const inserted = payloadRows.map((row) => {
      if (remote.some((existing) => existing.id === row.id)) return null;
      const created = Object.assign({}, row, {
        user_id: row.user_id || "user-1",
        created_at: row.created_at || "2026-09-11T12:00:00Z",
        updated_at: row.updated_at || "2026-09-11T12:00:00Z",
        revision: 1,
      });
      remote.push(created);
      return created;
    });
    if (inserted.some((row) => row === null)) {
      return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
    }
    return Promise.resolve({ data: clone(inserted), error: null });
  }

  if (kind === "update") {
    if (zeroNextUpdate) {
      zeroNextUpdate = false;
      return Promise.resolve({ data: [], error: null });
    }
    const matches = remote.filter((row) => Object.keys(filters).every((key) => row[key] === filters[key]));
    const updated = matches.map((row) => {
      Object.assign(row, payload, {
        revision: row.revision + 1,
        updated_at: "2026-09-12T15:00:" + String(nextUpdatedAt++).padStart(2, "0") + "Z",
      });
      return row;
    });
    return Promise.resolve({ data: clone(updated), error: null });
  }

  if (kind === "delete") {
    const deleted = remote.filter((row) => Object.keys(filters).every((key) => row[key] === filters[key]));
    remote = remote.filter((row) => !Object.keys(filters).every((key) => row[key] === filters[key]));
    return Promise.resolve({ data: clone(deleted), error: null });
  }

  throw new Error("unknown fake query: " + kind);
}

function fakeQuery(kind, payload) {
  const q = { filters: {}, order: null };
  q.eq = (col, val) => { q.filters[col] = val; return q; };
  q.order = (column, options) => {
    q.order = { column, ascending: !options || options.ascending !== false };
    return q;
  };
  q.select = () => runRequest(kind, payload, q.filters, q.order);
  q.maybeSingle = () => runRequest(kind, payload, q.filters, q.order).then((res) => ({ data: res.data && res.data[0] || null, error: res.error }));
  q.then = (resolve, reject) => runRequest(kind, payload, q.filters, q.order).then(resolve, reject);
  return q;
}

const fakeClient = {
  from: (table) => {
    assert.strictEqual(table, "workouts", "sync must use the workouts table");
    return {
      select: () => fakeQuery("select"),
      insert: (payload) => fakeQuery("insert", payload),
      update: (payload) => fakeQuery("update", payload),
      delete: () => fakeQuery("delete"),
    };
  },
  auth: {
    getSession: () => Promise.resolve({ data: { session } }),
    signOut: () => Promise.resolve({}),
  },
};

function reset(localState, opts) {
  opts = opts || {};
  store = {};
  statuses = [];
  conflicts = [];
  applied = [];
  calls = [];
  remote = opts.remote === undefined ? [] : clone(opts.remote);
  session = opts.session ? { user: { id: "user-1", email: "a@b.c" } } : null;
  failNext = false;
  zeroNextUpdate = false;
  nextUpdatedAt = 100;
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
    applyRemote: (payload) => {
      applied.push(clone(payload));
      localState.workouts = payload.workouts;
      localState.legend = payload.legend;
    },
    onStatus: (s, d) => statuses.push(d ? s + ":" + d : s),
    onConflict: (c) => conflicts.push(c),
    onAuth: () => {},
  };
}

function localWorkout(id, body, revision, dirty) {
  return {
    id,
    body,
    createdAt: "2026-09-11T12:00:00Z",
    updatedAt: "2026-09-11T12:00:00Z",
    revision: revision == null ? null : revision,
    dirty: dirty !== false,
  };
}

const last = (a) => a[a.length - 1];
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("first sign-in uploads each local workout row", async () => {
  const local = {
    workouts: [localWorkout("push-1", "PUSH\np 135x8"), localWorkout("legs-1", "LEGS\nsq 225x5")],
    legend: { pd: { w: "Wide Bar" } },
  };
  const sync = reset(local, { remote: [], session: true });
  await sync.init(hooksFor(local));
  assert.deepStrictEqual(remote.map((row) => row.body), ["PUSH\np 135x8", "LEGS\nsq 225x5"]);
  assert.deepStrictEqual(local.workouts.map((row) => row.revision), [1, 1]);
  assert.ok(local.workouts.every((row) => !row.dirty));
  assert.deepStrictEqual(local.legend, { pd: { w: "Wide Bar" } });
  assert.strictEqual(last(statuses), "synced");
});

test("clean local merges remote rows and adopts newest row data", async () => {
  const local = {
    workouts: [localWorkout("push-1", "old", 2, false)],
    legend: {},
  };
  const sync = reset(local, {
    session: true,
    remote: [
      makeRemote("push-1", "PUSH\np 135x8", 7, "2026-09-11T13:00:00Z"),
      makeRemote("legs-1", "LEGS\nsq 225x5", 4, "2026-09-11T14:00:00Z"),
    ],
  });
  await sync.init(hooksFor(local));
  assert.deepStrictEqual(local.workouts.map((row) => row.id), ["legs-1", "push-1"]);
  assert.deepStrictEqual(local.workouts.map((row) => row.body), ["LEGS\nsq 225x5", "PUSH\np 135x8"]);
  assert.deepStrictEqual(local.workouts.map((row) => row.revision), [4, 7]);
  assert.ok(local.workouts.every((row) => !row.dirty));
  assert.ok(!calls.some((call) => call.kind === "update"), "clean rows must not be written");
});

test("independently created local and remote rows merge without conflict", async () => {
  const local = {
    workouts: [localWorkout("local-new", "PUSH\np 135x8")],
    legend: {},
  };
  const sync = reset(local, { session: true, remote: [makeRemote("cloud-new", "LEGS\nsq 225x5", 3)] });
  await sync.init(hooksFor(local));
  assert.deepStrictEqual(remote.map((row) => row.id).sort(), ["cloud-new", "local-new"]);
  assert.deepStrictEqual(remote.map((row) => row.body).sort(), ["LEGS\nsq 225x5", "PUSH\np 135x8"]);
  assert.strictEqual(conflicts.length, 0);
  assert.deepStrictEqual(local.workouts.map((row) => row.id).sort(), ["cloud-new", "local-new"]);
});

test("zero-row optimistic update fetches and reports the affected conflict", async () => {
  const local = { workouts: [localWorkout("push-1", "mine", 4)] };
  const sync = reset(local, { remote: [makeRemote("push-1", "cloud", 4)], session: true });
  zeroNextUpdate = true;
  await sync.init(hooksFor(local));
  assert.strictEqual(last(conflicts).workoutId, "push-1");
  assert.strictEqual(last(conflicts).remote.body, "cloud");
  assert.ok(calls.some((call) => call.kind === "select" && call.filters.id === "push-1"));
});

test("one stale workout reports a conflict without blocking another row", async () => {
  const local = {
    workouts: [localWorkout("push-1", "mine", 4), localWorkout("legs-1", "old legs", 2, false)],
    legend: {},
  };
  const sync = reset(local, {
    session: true,
    remote: [makeRemote("push-1", "cloud", 9), makeRemote("legs-1", "new legs", 8)],
  });
  await sync.init(hooksFor(local));
  assert.strictEqual(last(conflicts).workoutId, "push-1");
  assert.strictEqual(last(conflicts).local.body, "mine");
  assert.strictEqual(last(conflicts).remote.body, "cloud");
  assert.strictEqual(last(conflicts).remoteRevision, 9);
  assert.strictEqual(local.workouts.find((row) => row.id === "legs-1").body, "new legs");
  assert.strictEqual(last(statuses), "conflict");
});

test("conflict -> use cloud replaces only the affected row", async () => {
  const local = {
    workouts: [localWorkout("push-1", "mine", 4), localWorkout("legs-1", "keep", 8, false)],
    legend: {},
  };
  const sync = reset(local, { remote: [makeRemote("push-1", "cloud", 9)], session: true });
  await sync.init(hooksFor(local));
  await sync.resolveConflict({ workoutId: "push-1", choice: "cloud" });
  assert.strictEqual(local.workouts.find((row) => row.id === "push-1").body, "cloud");
  assert.strictEqual(local.workouts.find((row) => row.id === "legs-1").body, "keep");
  assert.strictEqual(local.workouts.find((row) => row.id === "push-1").revision, 9);
  assert.ok(local.workouts.every((row) => !row.dirty));
  assert.strictEqual(last(conflicts), null);
});

test("conflict -> keep mine force-updates only the affected row", async () => {
  const local = {
    workouts: [localWorkout("push-1", "mine", 4), localWorkout("legs-1", "keep", 8, false)],
  };
  const sync = reset(local, { remote: [makeRemote("push-1", "cloud", 9), makeRemote("legs-1", "legs", 8)], session: true });
  await sync.init(hooksFor(local));
  await sync.resolveConflict({ workoutId: "push-1", choice: "mine" });
  assert.strictEqual(remote.find((row) => row.id === "push-1").body, "mine");
  assert.strictEqual(remote.find((row) => row.id === "legs-1").body, "legs");
  const forced = last(calls.filter((call) => call.kind === "update"));
  assert.strictEqual(forced.filters.id, "push-1");
  assert.strictEqual(forced.filters.revision, undefined, "force push drops only the revision filter");
  assert.ok(local.workouts.every((row) => !row.dirty));
});

test("conflict -> keep both retains mine and creates a distinct cloud copy", async () => {
  const local = {
    workouts: [localWorkout("push-1", "PUSH\np 135x8", 4)],
  };
  const sync = reset(local, {
    remote: [makeRemote("push-1", "LEGS\nsq 225x5", 9, "2026-09-11T16:12:00Z")],
    session: true,
  });
  await sync.init(hooksFor(local));
  await sync.resolveConflict({ workoutId: "push-1", choice: "both" });
  assert.strictEqual(local.workouts.find((row) => row.id === "push-1").body, "PUSH\np 135x8");
  assert.strictEqual(remote.length, 2);
  assert.ok(remote.some((row) => row.id !== "push-1" && row.body.includes("=== cloud copy ")));
  assert.ok(remote.some((row) => row.body.includes("LEGS\nsq 225x5")));
  assert.ok(local.workouts.some((row) => row.id !== "push-1"));
  assert.ok(local.workouts.every((row) => !row.dirty));
});

test("dirty deletion removes the matching remote row", async () => {
  const local = {
    workouts: [{ id: "push-1", revision: 4, dirty: true, deleted: true }],
  };
  const sync = reset(local, { remote: [makeRemote("push-1", "PUSH\np 135x8", 4)], session: true });
  await sync.init(hooksFor(local));
  assert.deepStrictEqual(remote, []);
  assert.deepStrictEqual(local.workouts, []);
  assert.ok(calls.some((call) => call.kind === "delete" && call.filters.id === "push-1"));
});

test("removing a previously synchronized local row deletes its remote row", async () => {
  const local = { workouts: [localWorkout("push-1", "PUSH\np 135x8", 1, false)] };
  const sync = reset(local, { remote: [makeRemote("push-1", "PUSH\np 135x8", 1)], session: true });
  await sync.init(hooksFor(local));
  local.workouts = [];
  sync.notifyChange();
  await sync.flush();
  assert.deepStrictEqual(remote, []);
  assert.ok(calls.some((call) => call.kind === "delete" && call.filters.id === "push-1"));
});

test("untouched local samples stay local when the account has no workouts", async () => {
  const local = { workouts: [localWorkout("sample-1", "sample", null, true)], untouched: true };
  const sync = reset(local, { remote: [], session: true });
  await sync.init(hooksFor(local));
  assert.deepStrictEqual(remote, []);
  assert.strictEqual(local.workouts[0].body, "sample");
  assert.strictEqual(last(statuses), "synced");
});

test("network failure keeps dirty rows and retries them", async () => {
  const local = {
    workouts: [localWorkout("push-1", "PUSH\np 135x8", 4)],
    legend: {},
  };
  const sync = reset(local, { remote: [makeRemote("push-1", "old", 4)], session: true });
  failNext = true;
  sync.notifyChange();
  await sync.flush();
  assert.ok(last(statuses).startsWith("offline"), "status is offline, got " + last(statuses));
  assert.strictEqual(local.workouts[0].dirty, true);
  await sync.flush();
  assert.strictEqual(remote[0].body, "PUSH\np 135x8");
  assert.strictEqual(local.workouts[0].dirty, false);
});

test("bodyweight no longer flows through the sync payload", async () => {
  const local = {
    workouts: [localWorkout("push-1", "PUSH\np 135x8")],
    bodyweight: "180",
    legend: { pd: { w: "Wide Bar" } },
  };
  const sync = reset(local, { remote: [], session: true });
  await sync.init(hooksFor(local));
  assert.deepStrictEqual(local.legend, { pd: { w: "Wide Bar" } });
  assert.deepStrictEqual(last(applied).legend, { pd: { w: "Wide Bar" } });
  assert.ok(!("bodyweight" in last(applied)), "sync payload carries no bodyweight, even if local state still has it");
});

test("no session -> signed-out, nothing read or written", async () => {
  const local = { workouts: [localWorkout("push-1", "x")] };
  const sync = reset(local, { session: false, remote: [makeRemote("push-1", "x", 1)] });
  await sync.init(hooksFor(local));
  assert.strictEqual(last(statuses), "signed-out");
  assert.deepStrictEqual(calls, [], "no row access without a session");
});

test("no client -> every entry point is inert", async () => {
  const local = { workouts: [localWorkout("push-1", "x")] };
  const sync = reset(local);
  sync._reset();
  sync.notifyChange();
  await sync.flush();
  await sync.resolveConflict({ workoutId: "push-1", choice: "mine" });
  assert.deepStrictEqual(calls, [], "nothing hit the network");
  await assert.rejects(() => sync.sendCode("a@b.c"), /not configured/);
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
