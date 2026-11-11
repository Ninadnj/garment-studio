-- Garment Studio: the shared catalogue of a small team.
-- Run once in Supabase: SQL Editor → New query → paste all of this → Run. Running it again is harmless.

-- Products, their photos and their try-on results, one row each. `data` holds the record as the app
-- keeps it; photos are files in the "photos" bucket below, referenced from `data`.
create table if not exists public.records (
  id uuid primary key,
  type text not null check (type in ('product', 'garment', 'look')),
  data jsonb not null default '{}'::jsonb,
  changed_at bigint not null, -- when the change was made on the device (ms since 1970); the newer change wins
  deleted boolean not null default false, -- deleted records stay as markers, so every device learns about it
  updated_at timestamptz not null default now(), -- set by the server: devices fetch what changed since they last looked
  updated_by uuid default auth.uid() references auth.users on delete set null
);

create index if not exists records_updated_at on public.records (updated_at);

-- New tables are not open to the app's API until granted (Supabase, since October 2026). Signed-in team
-- members may read, add and change rows, as the policies below allow; signed-out visitors get nothing.
grant select, insert, update on table public.records to authenticated;
revoke all on table public.records from anon;

-- Server time on every write, who wrote it, and never an older change over a newer one.
create or replace function public.records_before_write() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  latest bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint + 60000;
begin
  -- A phone whose clock runs ahead would otherwise win every later edit to this record: no change counts as
  -- later than a minute past the server's time. The record's own updatedAt is set to match, so the other
  -- devices keep the corrected time too (and never re-send a copy that looks newer than it is).
  if new.changed_at > latest then
    new.changed_at := latest;
    if new.data ? 'updatedAt' then
      new.data := jsonb_set(new.data, '{updatedAt}', to_jsonb(latest));
    end if;
  end if;
  if tg_op = 'UPDATE' and new.changed_at < old.changed_at then
    return null; -- keep the newer row
  end if;
  new.updated_at := clock_timestamp();
  new.updated_by := auth.uid();
  return new;
end $$;

drop trigger if exists records_before_write on public.records;
create trigger records_before_write before insert or update on public.records
  for each row execute function public.records_before_write();

-- Only signed-in team members (the users you add under Authentication) can read or write.
alter table public.records enable row level security;
drop policy if exists "team reads" on public.records;
drop policy if exists "team adds" on public.records;
drop policy if exists "team changes" on public.records;
create policy "team reads" on public.records for select to authenticated using (true);
create policy "team adds" on public.records for insert to authenticated with check (true);
create policy "team changes" on public.records for update to authenticated using (true) with check (true);
-- No delete policy: rows are marked deleted instead.

-- Photos: a private bucket for the same team.
insert into storage.buckets (id, name, public) values ('photos', 'photos', false)
  on conflict (id) do nothing;
drop policy if exists "team reads photos" on storage.objects;
drop policy if exists "team adds photos" on storage.objects;
drop policy if exists "team replaces photos" on storage.objects;
drop policy if exists "team removes photos" on storage.objects;
create policy "team reads photos" on storage.objects for select to authenticated using (bucket_id = 'photos');
create policy "team adds photos" on storage.objects for insert to authenticated with check (bucket_id = 'photos');
create policy "team replaces photos" on storage.objects for update to authenticated using (bucket_id = 'photos');
create policy "team removes photos" on storage.objects for delete to authenticated using (bucket_id = 'photos');
