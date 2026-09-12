/* ironvim cloud sync.
 *
 * Local-first: localStorage stays the read path and the offline write buffer
 * (see the persistence effect in index.html); this module pushes behind it.
 *
 * Plain JS on purpose -- it sits outside the text/babel block so it is not
 * transpiled in the browser and can be required in node for tests. Wrapped in
 * an IIFE so nothing leaks into the babel script's top-level scope.
 *
 * Every entry point no-ops when the SDK or config is missing, so the app never
 * depends on the network to start.
 */
(function () {
  var REVISION_KEY = "ironvim-sync-revision";
  var DIRTY_KEY = "ironvim-sync-dirty";
  var PUSH_DEBOUNCE_MS = 2500;
  var ROW_COLS = "body,bodyweight,legend,revision,updated_at";

  var client = null;
  var userId = null;
  var userEmail = null;
  var conflict = null;
  var pushTimer = null;
  var status = "local-only";
  var hooks = {};

  /* ---------------- local bookkeeping ---------------- */
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  function baseRevision() { var v = parseInt(lsGet(REVISION_KEY), 10); return isNaN(v) ? null : v; }
  function isDirty() { return lsGet(DIRTY_KEY) === "1"; }
  function setDirty(on) { if (on) lsSet(DIRTY_KEY, "1"); else lsDel(DIRTY_KEY); }

  function setStatus(next, detail) {
    status = next;
    if (hooks.onStatus) hooks.onStatus(next, detail || null);
  }
  function setConflict(next) {
    conflict = next;
    if (hooks.onConflict) hooks.onConflict(next);
  }
  function errText(err) {
    if (!err) return null;
    return err.message || err.error_description || err.msg || String(err);
  }

  /* ---------------- row <-> app state ---------------- */
  function toRow(local) {
    var bw = local && local.bodyweight;
    var num = Number(bw);
    return {
      body: String(local && local.text != null ? local.text : ""),
      bodyweight: (bw === "" || bw == null || isNaN(num)) ? null : num,
      legend: (local && local.legend) || {},
    };
  }
  function fromRow(row) {
    return {
      text: row.body == null ? "" : String(row.body),
      bodyweight: row.bodyweight == null ? "" : String(row.bodyweight),
      legend: row.legend || {},
    };
  }

  /* ---------------- sync ---------------- */
  function adopt(row) {
    lsSet(REVISION_KEY, String(row.revision));
    setDirty(false);
    if (hooks.applyRemote) hooks.applyRemote(fromRow(row));
    setStatus("synced");
  }

  function insertRow(local) {
    var row = toRow(local);
    row.user_id = userId;
    return client.from("logs").insert(row).select("revision,updated_at").single().then(function (res) {
      // 23505: another device created the row first -- re-run the load instead of clobbering.
      if (res.error && res.error.code === "23505") return load();
      if (res.error) throw res.error;
      lsSet(REVISION_KEY, String(res.data.revision));
      setDirty(false);
      setStatus("synced");
    });
  }

  function load() {
    if (!client || !userId) return Promise.resolve();
    setStatus("syncing");
    return client.from("logs").select(ROW_COLS).maybeSingle().then(function (res) {
      if (res.error) throw res.error;
      var row = res.data;
      var local = hooks.getLocal ? hooks.getLocal() : null;
      if (!row) return insertRow(local);
      // Re-read dirty here rather than before the round trip, so an edit typed
      // while the request was in flight is not silently overwritten.
      if (!isDirty() || (local && local.untouched)) return adopt(row);
      if (baseRevision() === row.revision) return push(local, row.revision);
      setConflict({
        local: local,
        remote: fromRow(row),
        remoteRevision: row.revision,
        remoteUpdatedAt: row.updated_at,
      });
      setStatus("conflict");
    }).catch(function (err) {
      setStatus("offline", errText(err));
    });
  }

  // base === null forces the write through (conflict resolution); otherwise a
  // zero-row result means someone else wrote since our base revision.
  function push(local, base) {
    if (!client || !userId) return Promise.resolve();
    setStatus("syncing");
    var q = client.from("logs").update(toRow(local)).eq("user_id", userId);
    if (base != null) q = q.eq("revision", base);
    return q.select("revision,updated_at").then(function (res) {
      if (res.error) throw res.error;
      var rows = res.data || [];
      if (!rows.length) return diverged(local);
      lsSet(REVISION_KEY, String(rows[0].revision));
      setDirty(false);
      setStatus("synced");
    }).catch(function (err) {
      setStatus("offline", errText(err));
    });
  }

  function diverged(local) {
    return client.from("logs").select(ROW_COLS).maybeSingle().then(function (res) {
      if (res.error) throw res.error;
      if (!res.data) return insertRow(local);
      setConflict({
        local: local,
        remote: fromRow(res.data),
        remoteRevision: res.data.revision,
        remoteUpdatedAt: res.data.updated_at,
      });
      setStatus("conflict");
    });
  }

  /* ---------------- conflict resolution ---------------- */
  function mergeLegend(mine, theirs) {
    var out = {}, k;
    for (k in (theirs || {})) out[k] = Object.assign({}, theirs[k]);
    for (k in (mine || {})) out[k] = Object.assign({}, out[k] || {}, mine[k]);
    return out;
  }

  // The marker line does not parse as an exercise, so parseLog promotes it to a
  // session header -- the merged block shows up as a visibly titled session.
  function mergeBoth(local, c) {
    var stamp = c.remoteUpdatedAt ? new Date(c.remoteUpdatedAt).toLocaleString() : "unknown time";
    var mine = String(local && local.text != null ? local.text : "").replace(/\s+$/, "");
    var theirs = String(c.remote.text || "").replace(/^\s+/, "").replace(/\s+$/, "");
    return {
      text: mine + "\n\n=== cloud copy " + stamp + " ===\n" + theirs,
      bodyweight: local ? local.bodyweight : "",
      legend: mergeLegend(local && local.legend, c.remote.legend),
      untouched: false,
    };
  }

  function resolveConflict(choice) {
    if (!conflict) return Promise.resolve();
    var c = conflict;
    if (choice === "cloud") {
      setConflict(null);
      lsSet(REVISION_KEY, String(c.remoteRevision));
      setDirty(false);
      if (hooks.applyRemote) hooks.applyRemote(c.remote);
      setStatus("synced");
      return Promise.resolve();
    }
    var local = hooks.getLocal ? hooks.getLocal() : c.local;
    var merged = choice === "both" ? mergeBoth(local, c) : local;
    setConflict(null);
    if (choice === "both" && hooks.applyRemote) hooks.applyRemote(merged);
    setDirty(true);
    return push(merged, null);
  }

  /* ---------------- scheduling ---------------- */
  function notifyChange() {
    setDirty(true);
    if (!client || !userId || status === "conflict") return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { pushTimer = null; flush(); }, PUSH_DEBOUNCE_MS);
  }

  function flush() {
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    if (!client || !userId || !isDirty() || status === "conflict") return Promise.resolve();
    return push(hooks.getLocal ? hooks.getLocal() : null, baseRevision());
  }

  /* ---------------- auth ---------------- */
  function requireClient() {
    if (!client) return Promise.reject(new Error("cloud sync is not configured"));
    return null;
  }

  function sendCode(addr) {
    var redirectTo;
    if (typeof window !== "undefined" && window.location) {
      redirectTo = window.location.hostname === "ironvim.vercel.app"
        ? "https://ironvim.vercel.app"
        : window.location.origin;
    }
    return requireClient() || client.auth.signInWithOtp({
      email: String(addr).trim(),
      options: { emailRedirectTo: redirectTo },
    })
      .then(function (res) { if (res.error) throw res.error; return true; });
  }

  function signOut() {
    if (!client) return Promise.resolve();
    return client.auth.signOut().catch(function () {}).then(function () {
      userId = null;
      userEmail = null;
      setConflict(null);
      lsDel(REVISION_KEY);
      setDirty(false);
      if (hooks.onAuth) hooks.onAuth(null);
      setStatus("signed-out");
    });
  }

  /* ---------------- init ---------------- */
  function configured(cfg) {
    return !!(cfg && cfg.url && cfg.publishableKey &&
      !/[<>]/.test(cfg.url + cfg.publishableKey));
  }

  function init(opts) {
    hooks = opts || {};
    var sdk = typeof window !== "undefined" ? window.supabase : null;
    var cfg = typeof window !== "undefined" ? window.IRONVIM_SUPABASE : null;
    if (!sdk || !sdk.createClient || !configured(cfg)) {
      setStatus("local-only");
      return Promise.resolve();
    }
    client = sdk.createClient(cfg.url, cfg.publishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: "pkce",
      },
    });

    window.addEventListener("online", function () { flush(); });
    window.addEventListener("pagehide", function () { flush(); });
    if (typeof document !== "undefined") {
      // iOS freezes backgrounded PWAs, so a pending debounce may never fire.
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "hidden") flush();
      });
    }

    return client.auth.getSession().then(function (res) {
      var session = res && res.data && res.data.session;
      if (!session) { setStatus("signed-out"); return; }
      userId = session.user.id;
      userEmail = session.user.email;
      if (hooks.onAuth) hooks.onAuth(userEmail);
      return load();
    }).catch(function (err) {
      setStatus("offline", errText(err));
    });
  }

  var api = {
    init: init,
    sendCode: sendCode,
    signOut: signOut,
    notifyChange: notifyChange,
    flush: flush,
    resolveConflict: resolveConflict,
    getStatus: function () { return status; },
    getEmail: function () { return userEmail; },
    getConflict: function () { return conflict; },
    /* test seam */
    _setClient: function (c, id, addr) { client = c; userId = id || null; userEmail = addr || null; },
    _setHooks: function (h) { hooks = h || {}; },
    _reset: function () { client = null; userId = null; userEmail = null; conflict = null; status = "local-only"; if (pushTimer) clearTimeout(pushTimer); pushTimer = null; },
  };

  if (typeof window !== "undefined") window.ironvimSync = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
