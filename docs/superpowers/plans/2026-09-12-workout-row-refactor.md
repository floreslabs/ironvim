# Workout Row Persistence Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single per-user workout document with independent workout records, a single-workout editor, and per-workout Supabase synchronization.

**Architecture:** Keep the existing raw grammar and parser, but represent each workout as `{ id, body, createdAt, updatedAt, revision, dirty }`. Extract local collection migration/helpers into a focused module, update `sync.js` to synchronize `workouts` rows independently, and adapt `index.html` to select/edit one workout while rendering all workout cards.

**Tech Stack:** Plain JavaScript modules loaded by the existing static HTML page, React 18 via CDN/Babel, Supabase JS v2, Supabase SQL migrations, Node-based tests.

**Spec:** `docs/superpowers/specs/2026-09-12-workout-row-refactor-design.md`

## Global Constraints

- Store the full raw workout text, including its header, in each workout row.
- Select the most recent workout when the app starts.
- Use the main textarea as the editor for the selected workout.
- Keep the existing debounced autosave behavior.
- Make `+ new session` immediately create and select a blank dated workout row.
- Use normalized per-workout rows rather than one JSON document.
- Keep bodyweight and variation legend as user-level settings.
- Do not deploy or run the Supabase migration automatically as part of the implementation.
- Preserve existing parser grammar and local-first behavior.
- Never discard existing local raw data during migration or sync failure.

---

### Task 1: Add local workout collection primitives

**Files:**
- Create: `workouts.js`
- Test: `test/workouts.test.js`

**Interfaces:**
- Produces `window.ironvimWorkouts` and CommonJS exports:
  - `createWorkout(body, now, id)`
  - `splitWorkoutDocument(text, parseLog)`
  - `migrateLocalWorkouts(text, parseLog, now)`
  - `loadLocalWorkouts(storage, parseLog, now)`
  - `saveLocalWorkouts(storage, workouts)`
  - `mostRecentWorkout(workouts)`

- [ ] **Step 1: Write failing migration and selection tests**

Test a two-session document:

```js
const text = "PUSH 09-11\np 135x8\n\nLEGS 09-12\nsq 225x5";
const rows = splitWorkoutDocument(text, parseLog);
assert.deepStrictEqual(rows.map((row) => row.body), [
  "PUSH 09-11\np 135x8",
  "LEGS 09-12\nsq 225x5",
]);
assert.strictEqual(mostRecentWorkout(rows).body, rows[1].body);
```

Test that an empty document produces one dated row and that a stored v1
collection is returned without re-migration.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node test/workouts.test.js`

Expected: FAIL because `workouts.js` does not exist.

- [ ] **Step 3: Implement the collection module**

Use a versioned storage payload:

```js
{
  version: 1,
  workouts: [
    { id, body, createdAt, updatedAt, revision: null, dirty: true }
  ]
}
```

Split only at parsed session boundaries. Preserve each raw header plus its
exercise lines. Use `crypto.randomUUID()` when available and a timestamp/random
fallback in Node/browser environments without it. Do not overwrite the old
`ironvim-logs-text` key until the new collection has been written successfully.

- [ ] **Step 4: Run focused tests**

Run: `node test/workouts.test.js`

Expected: all collection migration, persistence, and selection tests pass.

- [ ] **Step 5: Commit**

```bash
git add workouts.js test/workouts.test.js
git commit -m "feat: add local workout collection model"
```

### Task 2: Add the Supabase workouts schema

**Files:**
- Create: `supabase/migrations/20260912150000_workouts.sql`
- Test: `test/migration-schema.test.js`

**Interfaces:**
- Produces the `public.workouts` table consumed by `sync.js`.
- Columns: `id uuid`, `user_id uuid`, `body text`, `created_at timestamptz`, `updated_at timestamptz`, `revision bigint`.

- [ ] **Step 1: Write schema assertions**

Read the migration file and assert that it contains the required table,
foreign key, revision trigger, RLS enablement, and select/insert/update/delete
policies.

- [ ] **Step 2: Run the schema test and verify it fails**

Run: `node test/migration-schema.test.js`

Expected: FAIL because the new migration file does not exist.

- [ ] **Step 3: Implement the migration**

Create `public.workouts` with `id uuid primary key default gen_random_uuid()`,
`user_id uuid not null references auth.users(id) on delete cascade`, non-empty
`body`, timestamps, and `revision bigint not null default 1`. Add the
`user_id, updated_at` index. Enable RLS and add ownership policies for select,
insert, update, and delete. Add a trigger that increments revision and updates
`updated_at` on update.

- [ ] **Step 4: Run the schema test**

Run: `node test/migration-schema.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260912150000_workouts.sql test/migration-schema.test.js
git commit -m "feat: add per-workout Supabase table"
```

### Task 3: Refactor sync to per-workout rows

**Files:**
- Modify: `sync.js`
- Modify: `test/sync.test.js`

**Interfaces:**
- `init({ getLocal, applyRemote, onStatus, onConflict, onAuth })`
  consumes `{ workouts, bodyweight, legend, untouched }` and applies
  `{ workouts, bodyweight, legend }`.
- `notifyChange()` marks the local workout collection dirty.
- `resolveConflict({ workoutId, choice })` accepts `"mine"`, `"cloud"`, or `"both"`.
- Supabase queries use table `workouts` and columns
  `id,user_id,body,created_at,updated_at,revision`.

- [ ] **Step 1: Update fake Supabase tests**

Replace the single `remote` object with a remote workout array. Add tests for:

```js
assert.deepStrictEqual(remote.map((row) => row.body), ["PUSH\np 135x8", "LEGS\nsq 225x5"]);
assert.strictEqual(last(conflicts).workoutId, local.workouts[0].id);
```

Cover independent new-row merges, one-row optimistic conflicts, keep-mine,
use-cloud, keep-both creating a distinct ID, deletion, and offline retry.

- [ ] **Step 2: Run sync tests and verify failures**

Run: `node test/sync.test.js`

Expected: FAIL because the current implementation still queries `logs` and
expects one `body`.

- [ ] **Step 3: Implement row-based load and save**

Load all rows ordered by `updated_at desc`. Match rows by stable ID. Upsert
only dirty/new rows with `.eq("id", workoutId).eq("revision", baseRevision)`
for updates. Delete local rows through `.delete().eq("id", workoutId)`.
Persist per-row remote revision metadata in the local collection. Keep
bodyweight and legend in the existing local/sync payload.

- [ ] **Step 4: Implement per-workout conflicts**

When an update returns zero rows, fetch that workout and report a conflict
containing `workoutId`, `local`, `remote`, and `remoteRevision`. Keep-mine
force-updates only that row. Use-cloud replaces only that row. Keep-both
retains the local row and creates a new row with a generated ID and a
`=== cloud copy ... ===` marker in its body.

- [ ] **Step 5: Run sync tests**

Run: `node test/sync.test.js`

Expected: all sync tests pass.

- [ ] **Step 6: Commit**

```bash
git add sync.js test/sync.test.js
git commit -m "feat: synchronize workouts independently"
```

### Task 4: Wire local collection and single-workout editor

**Files:**
- Modify: `index.html`
- Modify: `sw.js`
- Modify: `test/render.test.js`

**Interfaces:**
- `index.html` consumes `window.ironvimWorkouts`.
- React state holds `workouts` and `selectedWorkoutId`.
- `getLocal()` returns the selected collection and settings.
- `applyRemote()` replaces the collection while preserving the selected most recent workout.

- [ ] **Step 1: Add failing rendering tests**

Assert that rendered source includes:

```js
assert.ok(html.includes("ironvimWorkouts"));
assert.ok(html.includes(">edit</button>"));
assert.ok(html.includes("selectedWorkoutId"));
```

Add a test that the old single `value={text}` editor binding is absent from
the workout state path and that each parsed workout card has an Edit action.

- [ ] **Step 2: Run render tests and verify failures**

Run: `node test/render.test.js`

Expected: FAIL because the app still has one `text` state and no workout
collection/editor selection.

- [ ] **Step 3: Load and migrate local workouts**

Load `ironvim-workouts` through `workouts.js`, migrate
`ironvim-logs-text` when needed, select the most recent row, and keep
bodyweight/legend initialization unchanged. Persist the collection with the
existing 500ms debounce.

- [ ] **Step 4: Bind the editor to the selected workout**

Derive `text` from the selected row. On textarea changes, update only that row’s
body and updated timestamp. If no row exists, create a dated row before
applying the edit. Update `+ new session` to create/select a blank dated row,
focus the textarea, and place the caret at the beginning.

- [ ] **Step 5: Add Edit actions and independent rendering**

Parse each workout body separately. Add an `edit` button to every session card
that sets `selectedWorkoutId`, updates the editor, and scrolls/focuses it.
Aggregate all-time totals across every row. Update conflict UI to display the
affected workout and call `resolveConflict({ workoutId, choice })`.

- [ ] **Step 6: Cache the new runtime module**

Add `./workouts.js` to `sw.js` assets and increment the cache version so
existing installed PWAs receive the module.

- [ ] **Step 7: Run render tests**

Run: `node test/render.test.js`

Expected: all render tests pass.

- [ ] **Step 8: Commit**

```bash
git add index.html sw.js test/render.test.js
git commit -m "feat: edit individual workouts"
```

### Task 5: Complete migration coverage and regression validation

**Files:**
- Modify: `test/parser.test.js`
- Modify: `test/workouts.test.js`
- Modify: `README.md`

**Interfaces:**
- Documents the new `ironvim-workouts` storage key, editor behavior, and
  explicit Supabase migration command.

- [ ] **Step 1: Add parser compatibility tests**

Assert that legacy `di`/`e`/`ca` codes still normalize correctly and that
multi-session raw documents retain exact headers and exercise text after
migration.

- [ ] **Step 2: Add README instructions**

Document that the new schema migration is applied explicitly with:

```sh
supabase db push --include-all
```

Document that the editor edits one workout at a time and that existing local
logs are migrated on first load.

- [ ] **Step 3: Run the complete test suite**

Run: `npm test`

Expected: parser, workout collection, sync, schema, and render tests all pass.

- [ ] **Step 4: Check formatting and repository state**

Run: `git diff --check && git status --short`

Expected: no whitespace errors and only intentional implementation changes.

- [ ] **Step 5: Commit**

```bash
git add README.md test/parser.test.js test/workouts.test.js
git commit -m "test: cover workout row migration and editing"
```
