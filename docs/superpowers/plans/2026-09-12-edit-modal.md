# Per-Session Edit Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single main LOG textarea with per-session edit modals. Each session card's `edit` button opens a modal whose textarea edits that workout's raw body.

**Architecture:** Remove the `selectedWorkoutId`/`editorRef` editor machinery from `App`. Introduce `editingId` state (which workout's modal is open), `updateWorkout(id, value)` that writes through the existing workout collection, and a `WorkoutModal` component. The existing 500ms debounced autosave + sync dirty-marking effect watches the collection, so modal edits flow through the unchanged persistence/sync pipelines.

**Tech Stack:** Plain JavaScript modules loaded by the existing static HTML page, React 18 via CDN/Babel, jsdom-based Node tests, Supabase SQL migrations.

**Spec:** Approved in-chat design (2026-09-12, modal-only editing). Scope confirmed with the human partner: no main editor; `+ new workout` creates a dated row and opens its modal; files touched are `index.html`, `sw.js`, `test/render.test.js`, `README.md`; one commit.

## Global Constraints

- Modal edits update the workout collection live (same debounced autosave + sync).
- The fresh-sample `untouched` logic stays so the sample is never pushed to the cloud.
- `applyRemote`, `sessions`, `allTime`, conflict UI, and sync wiring stay untouched.
- `ironvim-selected-workout` storage key becomes unused (harmless leftover).
- PWA cache version bumps so installed apps refetch the changed `index.html`.

---

### Task 1: Modal editing in `index.html` + render tests

**Files:**
- Modify: `test/render.test.js`
- Modify: `index.html`

**Interfaces:**
- Consumes: `window.ironvimWorkouts` (`createWorkout`, `loadLocalWorkouts`, `saveLocalWorkouts`), existing `Modal`/`Panel`/`sessionHeader` helpers.
- Produces: `editingId` state, `updateWorkout(id, value)`, `WorkoutModal({ workout, onClose, onChange })`.

- [ ] **Step 1: Convert the test harness and write failing tests**

Refactor `mount()` into `mountDom(syncStub)` returning `{ dom, el, act }`; `mount()` returns `el.innerHTML`. Update compile assertions to require `editingId`/`updateWorkout` and forbid `selectedWorkoutId`/`updateSelectedWorkout`/`setText(e.target.value)`. Add tests: default mount has no `<textarea>`; clicking `edit` opens an `EDIT WORKOUT` modal with a textarea bound to the workout body; typing via the native value setter updates the live `getLocal()` collection.

- [ ] **Step 2: Run render tests and verify they fail**

Run: `node test/render.test.js`
Expected: FAIL (main editor still present; no modal).

- [ ] **Step 3: Implement modal-only editing in `index.html`**

Replace `selectedWorkoutId` state with `editingId`; delete `editorRef`, the `selectedWorkout`/`text` derivation, and the selection-sync effect. Add `updateWorkout(id, value)`. Rewire `addSession` (create row + open modal) and `editWorkout` (open modal). Drop `ironvim-selected-workout` from the autosave effect. Add `WorkoutModal` after the `Modal` definition and render it when `editingWorkout` is set. Remove the LOG panel textarea and add a "Tap edit on a session to change its text." hint.

- [ ] **Step 4: Run render tests and verify they pass**

Run: `node test/render.test.js`
Expected: all render tests pass.

### Task 2: PWA cache + docs, full verification, single commit

**Files:**
- Modify: `sw.js`
- Modify: `README.md`

- [ ] **Step 1: Bump the service-worker cache version**

`const CACHE = "ironvim-v4"` → `"ironvim-v5"`.

- [ ] **Step 2: Update README editor-behavior lines**

Describe the per-session edit modal in place of the selected-workout editor wording.

- [ ] **Step 3: Run the complete test suite and check repo state**

Run: `npm test` then `git diff --check && git status --short`
Expected: parser, workouts, schema, sync, render all pass; no whitespace errors; only intended files changed.

- [ ] **Step 4: Commit**

```bash
git add index.html sw.js README.md test/render.test.js
git commit -m "feat: edit workouts in a modal"
```