-- ironvim cloud persistence: one text document per user.
-- The raw log text stays the source of truth; parsing remains client-side.

create table if not exists public.logs (
  user_id    uuid        primary key references auth.users(id) on delete cascade,
  body       text        not null default '',
  bodyweight numeric,
  legend     jsonb       not null default '{}'::jsonb,
  revision   bigint      not null default 1,
  updated_at timestamptz not null default now()
);

-- Without RLS the publishable key in the page source would expose every row.
alter table public.logs enable row level security;

create policy "logs_select_own" on public.logs for select using (auth.uid() = user_id);
create policy "logs_insert_own" on public.logs for insert with check (auth.uid() = user_id);
create policy "logs_update_own" on public.logs for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- no delete policy on purpose; rows go away via the auth.users cascade

-- revision is the optimistic-concurrency token, bumped server-side so a client
-- cannot forge it and win a conflict it should have lost.
create or replace function public.logs_touch() returns trigger language plpgsql as $$
begin
  new.revision   := old.revision + 1;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists logs_touch on public.logs;
create trigger logs_touch before update on public.logs
  for each row execute function public.logs_touch();
