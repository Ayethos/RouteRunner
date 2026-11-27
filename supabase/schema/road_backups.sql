begin;

create table if not exists public.road_backups (
  user_id uuid primary key references auth.users(id) on delete cascade,
  lines jsonb not null default '[]'::jsonb check (jsonb_typeof(lines) = 'array'),
  road_ids jsonb not null default '[]'::jsonb check (jsonb_typeof(road_ids) = 'array'),
  updated_at timestamptz not null default now()
);

alter table public.road_backups enable row level security;
revoke all on public.road_backups from public, anon, authenticated;
grant select, insert, update on public.road_backups to authenticated;

create policy "Read own road backup" on public.road_backups
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Create own road backup" on public.road_backups
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Update own road backup" on public.road_backups
  for update to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create or replace function public.merge_road_backup(in_lines jsonb, in_road_ids jsonb)
returns void
language sql
security invoker
set search_path = ''
as $$
  insert into public.road_backups as backup (user_id, lines, road_ids)
  values ((select auth.uid()), in_lines, in_road_ids)
  on conflict (user_id) do update set
    lines = (select coalesce(jsonb_agg(distinct item), '[]'::jsonb)
      from jsonb_array_elements(backup.lines || excluded.lines) as item),
    road_ids = (select coalesce(jsonb_agg(distinct item), '[]'::jsonb)
      from jsonb_array_elements(backup.road_ids || excluded.road_ids) as item),
    updated_at = now();
$$;

revoke all on function public.merge_road_backup(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.merge_road_backup(jsonb, jsonb) to authenticated;

commit;
