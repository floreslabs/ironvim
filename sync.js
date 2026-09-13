/* ironvim cloud sync. */
(function () {
  var DIRTY_KEY = "ironvim-sync-dirty";
  var KNOWN_IDS_KEY = "ironvim-sync-workout-ids";
  var PUSH_DEBOUNCE_MS = 2500;
  var ROW_COLS = "id,user_id,body,created_at,updated_at,revision";

  var client = null;
  var userId = null;
  var userEmail = null;
  var conflict = null;
  var pushTimer = null;
  var status = "local-only";
  var hooks = {};

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

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
  function localState() { return hooks.getLocal ? (hooks.getLocal() || {}) : {}; }
  function localWorkouts(state) { return Array.isArray(state.workouts) ? state.workouts : []; }
  function hasPending(state) {
    return localWorkouts(state).some(function (row) { return row && (row.dirty || row.deleted); });
  }
  function isDirty(state) { return lsGet(DIRTY_KEY) === "1" || hasPending(state); }
  function sameRevision(left, right) {
    return left != null && right != null && String(left) === String(right);
  }
  function knownIds() {
    var raw = lsGet(KNOWN_IDS_KEY);
    if (!raw) return [];
    try {
      var ids = JSON.parse(raw);
      return Array.isArray(ids) ? ids.map(String) : [];
    } catch (e) {
      return [];
    }
  }
  function saveKnownIds(workouts) {
    lsSet(KNOWN_IDS_KEY, JSON.stringify(workouts.filter(function (row) {
      return row && row.id != null && !row.deleted;
    }).map(function (row) { return String(row.id); })));
  }

  function makeId() {
    var cryptoObject = typeof globalThis !== "undefined" ? globalThis.crypto : null;
    if (cryptoObject && typeof cryptoObject.randomUUID === "function") return cryptoObject.randomUUID();
    return "workout-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  }

  function fromRow(row) {
    return {
      id: String(row.id),
      body: row.body == null ? "" : String(row.body),
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || row.created_at || null,
      revision: row.revision == null ? null : row.revision,
      dirty: false,
    };
  }

  function toRow(workout, includeId) {
    var row = {
      user_id: userId,
      body: String(workout && workout.body != null ? workout.body : ""),
    };
    if (includeId !== false && workout && workout.id != null) row.id = String(workout.id);
    if (workout && workout.createdAt) row.created_at = workout.createdAt;
    return row;
  }

  function applyState(workouts, state) {
    if (hooks.applyRemote) {
      hooks.applyRemote({
        workouts: workouts,
        legend: state.legend || {},
      });
    }
  }

  function findWorkout(workouts, id) {
    for (var i = 0; i < workouts.length; i += 1) {
      if (workouts[i] && String(workouts[i].id) === String(id)) return workouts[i];
    }
    return null;
  }

  function findIndex(workouts, id) {
    for (var i = 0; i < workouts.length; i += 1) {
      if (workouts[i] && String(workouts[i].id) === String(id)) return i;
    }
    return -1;
  }

  function fetchRows() {
    return client.from("workouts").select(ROW_COLS).order("updated_at", { ascending: false }).then(function (res) {
      if (res.error) throw res.error;
      return res.data || [];
    });
  }

  function fetchRow(id) {
    return client.from("workouts").select(ROW_COLS).eq("id", id).maybeSingle().then(function (res) {
      if (res.error) throw res.error;
      return res.data || null;
    });
  }

  function insertWorkout(workout) {
    return client.from("workouts").insert(toRow(workout, true)).select(ROW_COLS).then(function (res) {
      if (res.error) throw res.error;
      var rows = res.data || [];
      if (!rows.length) throw new Error("workout insert returned no row");
      return rows[0];
    });
  }

  function updateWorkout(workout, baseRevision) {
    var q = client.from("workouts").update(toRow(workout, false)).eq("id", workout.id);
    if (baseRevision != null) q = q.eq("revision", baseRevision);
    return q.select(ROW_COLS).then(function (res) {
      if (res.error) throw res.error;
      var rows = res.data || [];
      return rows.length ? rows[0] : null;
    });
  }

  function deleteWorkout(workoutId) {
    return client.from("workouts").delete().eq("id", workoutId).then(function (res) {
      if (res && res.error) throw res.error;
      return true;
    });
  }

  function markSaved(workout, remoteRow) {
    var saved = fromRow(remoteRow);
    workout.id = saved.id;
    workout.createdAt = saved.createdAt;
    workout.updatedAt = saved.updatedAt;
    workout.revision = saved.revision;
    workout.dirty = false;
    delete workout.deleted;
    return saved;
  }

  function conflictFor(workout, remoteRow) {
    var remote = fromRow(remoteRow);
    return {
      workoutId: String(workout.id),
      local: workout,
      remote: remote,
      remoteRevision: remote.revision,
    };
  }

  function saveOrConflict(workout, baseRevision) {
    return updateWorkout(workout, baseRevision).then(function (saved) {
      if (saved) return { saved: saved };
      return fetchRow(workout.id).then(function (remoteRow) {
        if (!remoteRow) return insertWorkout(workout).then(function (inserted) { return { saved: inserted }; });
        return { conflict: conflictFor(workout, remoteRow) };
      });
    });
  }

  function mergeBoth(local, c) {
    var stamp = c.remote && c.remote.updatedAt ? new Date(c.remote.updatedAt).toLocaleString() : "unknown time";
    var mine = String(local && local.body != null ? local.body : "").replace(/\s+$/, "");
    var theirs = String(c.remote && c.remote.body != null ? c.remote.body : "").replace(/^\s+/, "").replace(/\s+$/, "");
    return {
      id: makeId(),
      body: mine + "\n\n=== cloud copy " + stamp + " ===\n" + theirs,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      revision: null,
      dirty: true,
    };
  }

  function syncRows(state, remoteRows) {
    var locals = localWorkouts(state);
    var remoteById = {};
    var seen = {};
    var next = [];
    var conflictsFound = false;
    var untouched = !!state.untouched;

    remoteRows.forEach(function (row) { remoteById[String(row.id)] = row; });

    if (untouched) {
      if (remoteRows.length) {
        next = remoteRows.map(fromRow);
        setConflict(null);
        setDirty(false);
        saveKnownIds(next);
        applyState(next, state);
        setStatus("synced");
        return Promise.resolve();
      }
      applyState(locals, state);
      setDirty(hasPending(state));
      setStatus("synced");
      return Promise.resolve();
    }

    function processLocal(local) {
      if (!local || local.id == null) return Promise.resolve();
      var id = String(local.id);
      seen[id] = true;
      var remote = remoteById[id];

      if (local.deleted) {
        if (!remote) return Promise.resolve();
        return deleteWorkout(id).then(function () {});
      }

      if (!remote) {
        if (!local.dirty && local.revision != null) {
          next.push(local);
          return Promise.resolve();
        }
        return insertWorkout(local).then(function (saved) {
          next.push(markSaved(local, saved));
        });
      }

      if (!local.dirty) {
        next.push(fromRow(remote));
        return Promise.resolve();
      }

      if (!sameRevision(local.revision, remote.revision)) {
        var c = conflictFor(local, remote);
        conflictsFound = true;
        next.push(local);
        setConflict(c);
        return Promise.resolve();
      }

      return saveOrConflict(local, local.revision).then(function (result) {
        if (result.conflict) {
          conflictsFound = true;
          next.push(local);
          setConflict(result.conflict);
          return;
        }
        next.push(markSaved(local, result.saved));
      });
    }

    var missingKnown = knownIds().filter(function (id) {
      return !findWorkout(locals, id) && remoteById[id];
    });
    var chain = Promise.resolve();
    missingKnown.forEach(function (id) {
      seen[id] = true;
      chain = chain.then(function () { return deleteWorkout(id); });
    });
    locals.forEach(function (local) {
      chain = chain.then(function () { return processLocal(local); });
    });
    return chain.then(function () {
      remoteRows.forEach(function (row) {
        if (!seen[String(row.id)]) next.push(fromRow(row));
      });
      var ordered = [];
      var orderedIds = {};
      remoteRows.forEach(function (row) {
        var remoteId = String(row.id);
        var matching = findWorkout(next, remoteId);
        if (matching) {
          ordered.push(matching);
          orderedIds[remoteId] = true;
        }
      });
      next.forEach(function (row) {
        if (row && !orderedIds[String(row.id)]) ordered.push(row);
      });
      next = ordered;
      var clean = !conflictsFound && !next.some(function (row) { return row && (row.dirty || row.deleted); });
      applyState(next, state);
      saveKnownIds(next);
      setDirty(!clean);
      if (conflictsFound) setStatus("conflict");
      else setStatus("synced");
    });
  }

  function load() {
    if (!client || !userId) return Promise.resolve();
    setStatus("syncing");
    var state = localState();
    return fetchRows().then(function (rows) {
      return syncRows(state, rows);
    }).catch(function (err) {
      setStatus("offline", errText(err));
    });
  }

  function resolveConflict(options) {
    if (!conflict) return Promise.resolve();
    options = options || {};
    var workoutId = options.workoutId == null ? conflict.workoutId : options.workoutId;
    var choice = options.choice;
    if (String(workoutId) !== String(conflict.workoutId)) return Promise.resolve();
    if (["mine", "cloud", "both"].indexOf(choice) < 0) return Promise.reject(new Error("invalid conflict choice"));

    var c = conflict;
    var state = localState();
    var workouts = localWorkouts(state);
    var index = findIndex(workouts, workoutId);
    var local = index < 0 ? c.local : workouts[index];

    if (choice === "cloud") {
      var cloud = fromRow({
        id: c.remote.id,
        body: c.remote.body,
        created_at: c.remote.createdAt,
        updated_at: c.remote.updatedAt,
        revision: c.remoteRevision,
      });
      if (index < 0) workouts.push(cloud);
      else workouts[index] = cloud;
      setConflict(null);
      saveKnownIds(workouts);
      setDirty(hasPending(state));
      applyState(workouts, state);
      setStatus("synced");
      return Promise.resolve();
    }

    setStatus("syncing");
    return updateWorkout(local, null).then(function (saved) {
      if (!saved) throw new Error("conflict resolution update returned no row");
      var savedLocal = markSaved(local, saved);
      if (choice === "both") {
        var copy = mergeBoth(local, c);
        return insertWorkout(copy).then(function (copyRow) {
          markSaved(copy, copyRow);
          if (index < 0) workouts.push(savedLocal);
          else workouts[index] = savedLocal;
          workouts.push(copy);
        });
      }
      if (index < 0) workouts.push(savedLocal);
      else workouts[index] = savedLocal;
      return null;
    }).then(function () {
      setConflict(null);
      saveKnownIds(workouts);
      setDirty(hasPending(state));
      applyState(workouts, state);
      setStatus("synced");
    }).catch(function (err) {
      setStatus("offline", errText(err));
    });
  }

  function notifyChange() {
    setDirty(true);
    if (!client || !userId || status === "conflict") return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { pushTimer = null; flush(); }, PUSH_DEBOUNCE_MS);
  }

  function flush() {
    if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
    if (!client || !userId || status === "conflict" || !isDirty(localState())) return Promise.resolve();
    return load();
  }

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
    }).then(function (res) { if (res.error) throw res.error; return true; });
  }

  function signOut() {
    if (!client) return Promise.resolve();
    return client.auth.signOut().catch(function () {}).then(function () {
      userId = null;
      userEmail = null;
      setConflict(null);
      setDirty(false);
      if (hooks.onAuth) hooks.onAuth(null);
      setStatus("signed-out");
    });
  }

  function configured(cfg) {
    return !!(cfg && cfg.url && cfg.publishableKey && !/[<>]/.test(cfg.url + cfg.publishableKey));
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
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" },
    });
    window.addEventListener("online", function () { flush(); });
    window.addEventListener("pagehide", function () { flush(); });
    if (typeof document !== "undefined") {
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
    _setClient: function (c, id, addr) { client = c; userId = id || null; userEmail = addr || null; },
    _setHooks: function (h) { hooks = h || {}; },
    _reset: function () {
      client = null;
      userId = null;
      userEmail = null;
      conflict = null;
      status = "local-only";
      if (pushTimer) clearTimeout(pushTimer);
      pushTimer = null;
    },
  };

  if (typeof window !== "undefined") window.ironvimSync = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
