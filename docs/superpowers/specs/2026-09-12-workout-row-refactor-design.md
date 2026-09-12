# Workout Row Persistence Refactor

## Status

Approved design for implementation planning.

## Goal

Refactor Ironvim from one raw workout log per user to one persisted workout
record per workout. The editor will display and edit one selected workout at a
time, while Parsed Sessions will continue to show the complete workout
collection.

## Decisions

- Store the full raw workout text, including its header, in each workout row.
- Select the most recent workout when the app starts.
- Use the main textarea as the editor for the selected workout.
- Keep the existing debounced autosave behavior.
- Make `+ new session` immediately create and select a blank dated workout row.
- Use normalized per-workout rows rather than one JSON document.
- Keep bodyweight and variation legend as user-level settings.
- Do not deploy or run the Supabase migration automatically as part of the
  implementation.

## Data model

Add a `public.workouts` table:

```text
id           uuid primary key
user_id      uuid not null references auth.users(id) on delete cascade
body         text not null
created_at   timestamptz not null default now()
updated_at   timestamptz not null default now()
revision     bigint not null default 1
```

Add indexes for `(user_id, updated_at)` and ownership-aware queries. Enable
RLS and allow users to select, insert, update, and delete only their own rows.
A trigger increments `revision` and updates `updated_at` on every update.

The existing `logs` table remains available during migration compatibility.
The new client reads and writes `workouts`; bodyweight and legend continue to
use the existing user-level settings representation until they are separately
normalized.

## Local data and migration

Replace the single raw-text localStorage value with a versioned workout
collection:

```text
ironvim-workouts
ironvim-selected-workout
ironvim-logs-bodyweight
ironvim-logs-legend
```

On first load, migrate the existing `ironvim-logs-text` value by splitting it
with the existing session parsing/header behavior. Preserve each complete raw
header-and-content block as one workout body. Write a migration marker or
version so the conversion runs once. If no workout exists, create and select a
dated initial workout.

When an authenticated user has only an old `logs` row, convert its body into
workout rows and upload them. The old row remains untouched for rollback and
diagnostics; subsequent application reads use `workouts`.

## Editor and UI flow

Maintain a selected workout ID in application state. The textarea value is the
selected workout's raw body. Editing updates only that workout and invokes the
existing debounced local save and sync behavior.

Parsed Sessions renders each workout independently. Each workout card includes
an Edit button that selects the card and loads its raw body into the textarea.
The card's parsed exercises, volume, and notes are derived from that workout
alone. The existing summary aggregates across all workout rows.

`+ new session` immediately creates a dated blank workout, selects it, and
focuses the editor. A new empty row is still a real persisted local/cloud
record.

## Sync and conflicts

The sync module loads all workout rows for the authenticated user, tracks each
row's revision and dirty state, and upserts only changed rows. Local deletion
removes the corresponding remote row after ownership checks. Independently
created workouts merge without conflict.

If an update loses its revision check, show a conflict for that workout only:

- **keep mine** force-updates that workout;
- **use cloud** adopts the remote workout;
- **keep both** creates a distinct local workout containing the two raw bodies.

Network failures leave local changes intact and mark the affected rows for
retry. Existing account authentication and bodyweight/legend synchronization
remain available.

## Error handling

Malformed content remains isolated to its workout and is rendered using the
existing parser behavior. Migration failures must be surfaced in the sync
status and must not discard the original local raw text. Remote failures must
not replace local data with empty defaults.

## Testing

Extend the existing tests to cover:

- splitting and migrating a multi-session raw log;
- preserving raw headers and workout bodies;
- selecting the most recent workout;
- creating and editing a workout row;
- independent localStorage persistence;
- loading and upserting multiple Supabase rows;
- per-workout optimistic conflicts and all three resolutions;
- independent new-workout merges and deletion;
- Parsed Sessions Edit buttons and selected-editor behavior.

Run the existing `npm test` suite plus the focused new migration, sync, and
render tests.
