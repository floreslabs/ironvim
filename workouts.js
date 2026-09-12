(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ironvimWorkouts = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var STORAGE_KEY = "ironvim-workouts";
  var LEGACY_STORAGE_KEY = "ironvim-logs-text";
  var VERSION = 1;

  function asDate(now) {
    var date = now == null ? new Date() : new Date(now);
    if (isNaN(date.getTime())) throw new TypeError("now must be a valid date");
    return date;
  }

  function createId() {
    var cryptoObject = typeof globalThis !== "undefined" ? globalThis.crypto : null;
    if (cryptoObject && typeof cryptoObject.randomUUID === "function") return cryptoObject.randomUUID();
    return "workout-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  }

  function createWorkout(body, now, id) {
    var timestamp = asDate(now).toISOString();
    return {
      id: id == null ? createId() : String(id),
      body: body == null ? "" : String(body),
      createdAt: timestamp,
      updatedAt: timestamp,
      revision: null,
      dirty: true,
    };
  }

  function trimBlankLines(lines) {
    var start = 0;
    var end = lines.length;
    while (start < end && lines[start].trim() === "") start += 1;
    while (end > start && lines[end - 1].trim() === "") end -= 1;
    return lines.slice(start, end);
  }

  function splitWorkoutBodies(text, parseLog) {
    if (typeof parseLog !== "function") throw new TypeError("parseLog must be a function");
    var source = text == null ? "" : String(text);
    if (!source.trim()) return [];

    var lines = source.split(/\r?\n/);
    var starts = [];
    var sessionCount = 0;
    for (var i = 0; i < lines.length; i += 1) {
      var parsed = parseLog(lines.slice(0, i + 1).join("\n"));
      if (!Array.isArray(parsed)) throw new TypeError("parseLog must return an array");
      if (parsed.length > sessionCount) {
        starts.push(i);
        sessionCount = parsed.length;
      }
    }

    if (!starts.length) {
      var fallback = trimBlankLines(lines);
      return fallback.length ? [fallback.join("\n")] : [];
    }

    var bodies = [];
    for (var j = 0; j < starts.length; j += 1) {
      var block = trimBlankLines(lines.slice(starts[j], starts[j + 1] == null ? lines.length : starts[j + 1]));
      if (block.length) bodies.push(block.join("\n"));
    }
    return bodies;
  }

  function splitWorkoutDocument(text, parseLog) {
    return splitWorkoutBodies(text, parseLog).map(function (body) {
      return createWorkout(body);
    });
  }

  function dateHeader(now) {
    var date = asDate(now);
    return "Workout for " + (date.getMonth() + 1) + "/" + date.getDate() + "/" + date.getFullYear();
  }

  function migrateLocalWorkouts(text, parseLog, now) {
    var date = asDate(now);
    var bodies = splitWorkoutBodies(text, parseLog);
    if (!bodies.length) bodies = [dateHeader(date)];
    return bodies.map(function (body) { return createWorkout(body, date); });
  }

  function requireStorage(storage) {
    if (!storage) throw new TypeError("storage is required");
    if (typeof storage.getItem === "function" || typeof storage.get === "function") return storage;
    throw new TypeError("storage must provide getItem or get");
  }

  function read(storage, key) {
    requireStorage(storage);
    if (typeof storage.getItem === "function") return storage.getItem(key);
    return storage.get(key);
  }

  function write(storage, key, value) {
    requireStorage(storage);
    var result;
    if (typeof storage.setItem === "function") result = storage.setItem(key, value);
    else if (typeof storage.set === "function") result = storage.set(key, value);
    if (result === false) throw new Error("unable to save local workouts");
  }

  function saveLocalWorkouts(storage, workouts) {
    if (!Array.isArray(workouts)) throw new TypeError("workouts must be an array");
    write(storage, STORAGE_KEY, JSON.stringify({ version: VERSION, workouts: workouts }));
  }

  function loadLocalWorkouts(storage, parseLog, now) {
    var raw = read(storage, STORAGE_KEY);
    if (raw != null) {
      var payload = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!payload || payload.version !== VERSION || !Array.isArray(payload.workouts)) {
        throw new Error("unsupported local workout collection");
      }
      return payload.workouts;
    }

    var legacyText = read(storage, LEGACY_STORAGE_KEY);
    var workouts = migrateLocalWorkouts(legacyText == null ? "" : legacyText, parseLog, now);
    saveLocalWorkouts(storage, workouts);
    return workouts;
  }

  function workoutTimestamp(workout) {
    var value = workout && (workout.updatedAt || workout.createdAt);
    var timestamp = value == null ? NaN : Date.parse(value);
    return isNaN(timestamp) ? -Infinity : timestamp;
  }

  function mostRecentWorkout(workouts) {
    if (!Array.isArray(workouts) || !workouts.length) return null;
    var recent = workouts[0];
    for (var i = 1; i < workouts.length; i += 1) {
      if (workoutTimestamp(workouts[i]) >= workoutTimestamp(recent)) recent = workouts[i];
    }
    return recent;
  }

  return {
    createWorkout: createWorkout,
    splitWorkoutDocument: splitWorkoutDocument,
    migrateLocalWorkouts: migrateLocalWorkouts,
    loadLocalWorkouts: loadLocalWorkouts,
    saveLocalWorkouts: saveLocalWorkouts,
    mostRecentWorkout: mostRecentWorkout,
  };
}));
