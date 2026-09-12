-- One independently synchronized workout per row.
create table if not exists public.workouts (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references auth.users(id) on delete cascade,
  body       text        not null check (length(trim(body)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revision   bigint      not null default 1
);

create index if not exists workouts_user_updated_at_idx
  on public.workouts (user_id, updated_at);

alter table public.workouts enable row level security;

create policy "workouts_select_own" on public.workouts for select
  using (auth.uid() = user_id);
create policy "workouts_insert_own" on public.workouts for insert
  with check (auth.uid() = user_id);
create policy "workouts_update_own" on public.workouts for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "workouts_delete_own" on public.workouts for delete
  using (auth.uid() = user_id);

create or replace function public.workouts_touch() returns trigger language plpgsql as $$
begin
  new.revision   := old.revision + 1;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists workouts_touch on public.workouts;
create trigger workouts_touch before update on public.workouts
  for each row execute function public.workouts_touch();
