# KNOWLEDGE — ironvim findings & observations

Engineering notes gathered while building and debugging ironvim. Use this as the
shared context when planning refactors. Dates/commits are approximate and
point to the current `proto/init` branch state (HEAD `f294755`).

## 1. What ironvim is

A gym-log web app, deliberately **simple**: a text editor over a compact
workout grammar, with local-first storage and optional cloud sync.

- Everything lives in a single HTML file: `index.html` (~1,000 lines) holds the
  DOM, the React app (compiled in-browser by `@babel/standalone` from a CDN),
  the parser, the syntax highlighter, the editor, and all panels.
- Plain-JS companion modules (no bundler, no ES modules — IIFEs on globals,
  with `module.exports` guards so Node tests can `require()` them):
  - `sync.js` — cloud-sync state machine (`window.ironvimSync`).
  - `workouts.js` — local storage + legacy migration (`window.ironvimWorkouts`).
  - `supabase-config.js` — Supabase URL + publishable key.
- `sw.js` — service worker, **cache-first**. The `CACHE` key in `sw.js` must be
  bumped on every shipped UI change or returning users keep the stale build.

## 2. Two palettes

- `C` = Sonokai "dark" (app-wide: panels, buttons, tables, sync status).
- `A` = Sonokai "andromeda" — used **only** for the edit-workout modal (gutter,
  highlight layer, status bar). `A.bg0` etc. are deliberately separate from `C`
  so the editor has its own skin.

## 3. Log grammar & parser

Core tokens (all lowercased by the parser):

- **Session header** line starts a workout session, e.g. `PUSH 09-11` or
  `Workout for 9/12/2026`. `sessionHeader()` generates the header for new
  workouts. A workout body can contain many sessions; the parser detects session
  boundaries by counting parsed sessions as it walks lines.
- **Exercise** token = `base` optionally `.code` + `.variation`, e.g. `p`,
  `sh.b`, `sh.rg`, `tb.u.ng`.
  - `BASE_LABELS` maps `p -> Press`, `sq -> Squat`, etc. (line ~80 in index.html).
  - `BASE_ALIASES` resolve retired codes (`l->pd`, `ca->cr`, `e->d`, `di->dip`).
  - `DEFAULT_LEGEND` holds per-base variation labels (`pd.v -> V-Bar`, `sh.b ->
    Behind the Back`, ...); stored under localStorage key `ironvim-logs-legend`.
  - `PULLDOWN_LEGACY` — labels retired from the pulldown; a saved entry still
    matching one is dropped so existing installs see only the current set.
- **Sets**: comma-separated after the weight: `p 135x8,8,8`. `>` still parses so
  very old logs keep working (a continuation marker). Notes are in double
  quotes (`"wide grip"`). Bodyweight notation exists (`bw`) and is parsed but
  **no longer flows through the sync payload** (see §5).
- `describeExercise` + `exerciseLabelAtSelection` resolve the status-bar label
  for the caret's line. Unknown tokens show `—`.

## 4. The edit modal (biggest invariants)

A classic **transparent-textarea-over-highlight** editor:

- A `text-align`-identical `<pre class="gl-highlight">` behind the textarea
  renders `highlightLog()` output via `dangerouslySetInnerHTML`. The textarea
  has `color: transparent`, `caretColor: A.fg`, `WebkitTextFillColor:
  transparent`.
- **Alignment depends on exact metrics**: textarea and pre must share
  `fontFamily` mono, `fontSize:13`, `lineHeight:1.6`, `padding:12`,
  `boxSizing:border-box`, and the textarea must have no chrome
  (`borderStyle:none`, `overflow:hidden`, no scrollbar gutter) or the wrap
  points diverge.
- Font is **13px** (chosen via visual mockups). Tradeoff: iOS Safari force-zooms
  on focus for inputs < 16px; this is a known, accepted cost of the smaller size.
- **Gutter** (`.gl-gutter`): one cell per source line; cell height =
  visual-row-count × `GL_ROW_PX` where `GL_ROW_PX = 13 * 1.6 = 20.8`.
  Numbering starts at **1 on the second source line** — the first line is the
  session title and stays blank. The active line's number is `A.blue`.
- **Wrapping bug we hit**: `Range.getClientRects()` returns **one rect per
  inline `<span>` fragment, not one per visual row** — a single 20-char line
  could report 19 rects and inflate cell heights by ~5×. Fixed by
  `rowSpanCount()`: round each rect's top, dedupe into a Set, and use the set
  size. Verified in a real headless Chrome (jsdom can't reproduce rects).
- Re-measure on: body change, `ResizeObserver` on the region (guarded with a
  `typeof` check because jsdom lacks it), and scroll-sync pre ↔ textarea.

## 5. Local storage & the legacy split

- Current key: `ironvim-workouts` → `{ version: 1, workouts: [...] }`.
- Legacy key: `ironvim-logs-text` (the old single-document log). On first load
  without a current collection, `migrateLocalWorkouts()` splits the old document
  into one workout per session by querying `parseLog` per prefix.
- A workout row: `{ id, body, createdAt, updatedAt, revision, dirty }`.

## 6. Cloud sync (`sync.js`) — shape & quirks

- Remote table `public.workouts`, RLS per-owner; columns
  `id, user_id, body, created_at, updated_at, revision`. A server trigger
  `workouts_touch` bumps `revision` and `updated_at` on every UPDATE so clients
  can't forge the concurrency token.
- **Full-state reconciliation**: every flush re-fetches all rows ordered by
  `updated_at desc` and reconciles local vs remote. No incremental feed, no
  subscriptions, no change stream.
- Optimistic concurrency: UPDATEs carry `eq("revision", baseRevision)`. A
  zero-row optimistic update re-fetches the row → either a conflict or a
  re-insert (if the row vanished).
- Dirty tracking: `ironvim-sync-dirty` flag + per-row `dirty`/`deleted`.
  `ironvim-sync-workout-ids` records ids ever seen; a synced id missing from the
  local collection is treated as deleted-on-another-device and deleted remotely
  (`missingKnown` path).
- Push cadence: debounced 2500ms after `notifyChange()`, plus flush on
  `online`, `pagehide`, and `visibilitychange hidden`.
- **Untouched-sample guard**: a brand-new user's default sample workout is not
  uploaded; the account stays empty until the user actually edits/creates data.
- Conflicts: three choices — `mine`, `cloud`, `both`. `both` merges into a NEW
  row: `mine + "\n\n=== cloud copy <timestamp> ===\n" + theirs` with a fresh id.
- Nightly-status labels: `local-only | signed-out | syncing | synced | offline |
  conflict` (colored in `C`).

### Bug 23514 (fixed, f294755)
Symptom: `new row for relation "workouts" violates check constraint
"workouts_body_check"` on ironvim.vercel.app.
Causes merged into one fix:
- The editor auto-saves every keystroke (500ms debounce in `App`); clearing a
  workout's text produced `body: ""`.
- `sync.js` wrote that empty body; the migration's `check (length(trim(body)) > 0)`
  rejected it; the row stayed dirty, so **every reload retried the same failed
  write** and the error never cleared.
- Fix: `processLocal()` now treats any workout whose `trim(body) === ""` as
  deleted — never inserted/updated, the remote row (if any) is deleted,
  and the local row is dropped from the applied state. This self-heals devices
  already stuck (they just had `dirty:true` empties sitting in localStorage).

## 7. Delete UX (added with the 23514 fix)

- Card header now has a red-outline `✕` next to the green-outline `edit`.
- Clicking it runs `window.confirm("Delete this workout?")`; only a confirmed
  delete removes the row locally and syncs the deletion. (Users chose confirm
  over instant delete.) Clearing editor text is still possible but the sync
  layer just treats the result as a deletion — the delete button is the
  intended path.

## 8. Panels & layout

- **WORKOUTS**: session cards; each card = header (title, `✕`, `edit`) + a
  CODE / EXERCISE / WEIGHT (LB) / REPS table. Grid: per-set rows; a group's
  code/name/note render only on its first row. Per-session header volume was
  removed (decision). The edit button is outline-green; delete is outline-red.
- **ALL-TIME SUMMARY**: aggregates by exercise label across all sessions →
  `maxWeight` + `maxReps` (the reps at that max weight) + `volume`. Rows sort by
  `maxWeight` desc, tie-break on `volume`. Each row shows a raw-volume bar scaled
  to the largest row (the "bar graphs"). History: an "80% of max" data point was
  prototyped as mini-table and inline; **both were reverted** — it does not ship.
- **ACCOUNT**: cloud sync status, sign-in via email magic link (PKCE), offline
  reason in `sync.detail`, legend manager (add/remove `base.code → label`),
  grammar-reference and sample-log modals.
- `App` wires everything: `useSync` bridges `sync.js` via refs so the state
  machine always reads current React state; `applyRemote` adopts server rows
  with `skipNotify` so an adoption can't be re-uploaded; `firstSave` prevents the
  mount-time save from marking the store dirty.

## 9. Testing & verification

No test framework — plain Node scripts with `assert`, a small runner, and a
pass/fail count. `npm test` runs five suites:

- `parser.test.js` — grammar edge cases (variations, retired codes, groups, res).
- `sync.test.js` — full fake-client harness (`reset()` + `fakeQuery` recording
  every call; knobs `failNext`, `zeroNextUpdate`). Asserts tables are `workouts`
  and that empty bodies never reach the wire.
- `render.test.js` — compiles `index.html`'s inline Babel block with
  `@babel/standalone`, mounts `<App/>` in jsdom with a fresh `react-dom` per
  test, and dispatches real DOM events + `act()`. `mountDom(syncStub,
  workoutsOverride)` injects a fake sync and a workout fixture.
- `workouts.test.js` — local storage + legacy-document splitting.
- `migration-schema.test.js` — string-asserts the workouts migration SQL (the
  client and schema must stay in lockstep).

Known jsdom gaps: no `Range.getClientRects` (fallback = 1 row/line), no
`ResizeObserver`, no `confirm` (tests stub it). Timing-heavy assertions are
handled with real `await setTimeout`. When jsdom can't answer a question, we
verify with a **headless Chrome probe** (temp harness + local HTTP server), as
we did for the wrapped-line gutter bug.

## 10. Deployment & database workflow

- Vercel hosts ironvim.vercel.app. `sw.js` is cache-first; **bump `CACHE` on
  every UI commit**, hard-reload during dev.
- Supabase CLI 2.117; project linked under `supabase/`. Apply migrations with
  `supabase db push`; check status with `supabase migration list`.
- Applied migrations:
  - `20260911190000_init.sql` — legacy `public.logs` (one document per user:
    `body`, `bodyweight`, `legend`, `revision`).
  - `20260912150000_workouts.sql` — current `public.workouts` (one workout per
    row) + per-owner RLS + revision-bump trigger.
- `.gitignore` covers `supabase/**/.temp/` (CLI scratch was getting committed by
  accident via the nested `supabase/supabase/.temp/` path).

## 11. Known debt / refactor fodder

1. **Monolith `index.html`**: palette, parser, highlighter, editor, panels,
   sync wiring, modals all in one file rendered through `App`. Any refactor has
   to first untangle these. Memory of the coupling points is the main risk.
2. **Runtime Babel**: `@babel/standalone` + React loaded from a CDN; `render`
   tests depend on that pipeline. A build step (bundle, real modules) would
   replace this and let the IIFE-global modules become proper imports.
3. **Sync = full re-fetch + per-row writes each flush**: fine for a gym log
   (small state), wasteful in general; no Postgres changes / subscriptions.
4. **Editor metric invariants are implicit**: the 13px / lineHeight 1.6 /
   padding 12 trio must stay in lockstep across textarea + pre + gutter +
   `GL_ROW_PX`. Intertwining them with a constant would be a refactor win.
5. **`logs` table is dead** on the remote DB (app reads/writes only
   `workouts`). A cleanup migration (and a backfill if any real data ever lived
   there) is a pending decision.
6. **Conflict "both" merge** materializes a synthetic row in the log text —
   no undo; worth reconsidering in a sync refactor.
7. **No delete-then-undo**: deleting a workout is permanent after sync.
8. `workouts.js` duplicate of the `App` fallback workout shape (the `workoutApi`
    branch mirrors the plain-object branch) — a single schema/creator would
    help.

## 12. Decisions worth remembering (so they aren't "revisited" by accident)

- Editor font is 13px by choice (mockups) — iOS zoom is accepted.
- Gutter numbers start after the session-title line.
- Summary sorts by **max weight**, not volume; volume bars remain.
- 80% of max: **decided not to ship** (prototyped as mini-table and inline,
  both reverted).
- Edit button: outline **green** (matches `+ new workout`); delete button:
  outline **red**, confirm-guarded.
- Empty workout body == deletion, at the sync layer — the DB constraint is the
  enforcement backstop and should stay.