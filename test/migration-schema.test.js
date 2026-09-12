const assert = require("assert");
const fs = require("fs");
const path = require("path");

const migrationPath = path.join(__dirname, "..", "supabase", "migrations", "20260912150000_workouts.sql");
const sql = fs.readFileSync(migrationPath, "utf8");
const normalized = sql.replace(/\s+/g, " ").toLowerCase();

const assertSql = (fragment) => assert.ok(normalized.includes(fragment), `missing SQL: ${fragment}`);

assertSql("create table if not exists public.workouts (");
assertSql("id uuid primary key default gen_random_uuid()");
assertSql("user_id uuid not null references auth.users(id) on delete cascade");
assertSql("body text not null check (length(trim(body)) > 0)");
assertSql("created_at timestamptz not null default now()");
assertSql("updated_at timestamptz not null default now()");
assertSql("revision bigint not null default 1");
assertSql("create index if not exists workouts_user_updated_at_idx on public.workouts (user_id, updated_at)");

assertSql("alter table public.workouts enable row level security");
assertSql('create policy "workouts_select_own" on public.workouts for select using (auth.uid() = user_id)');
assertSql('create policy "workouts_insert_own" on public.workouts for insert with check (auth.uid() = user_id)');
assertSql('create policy "workouts_update_own" on public.workouts for update using (auth.uid() = user_id) with check (auth.uid() = user_id)');
assertSql('create policy "workouts_delete_own" on public.workouts for delete using (auth.uid() = user_id)');

assertSql("create or replace function public.workouts_touch() returns trigger");
assertSql("new.revision := old.revision + 1");
assertSql("new.updated_at := now()");
assertSql("create trigger workouts_touch before update on public.workouts for each row execute function public.workouts_touch()");

console.log("migration schema assertions passed");
