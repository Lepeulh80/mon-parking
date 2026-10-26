-- staff_shifts: prepared server schema; UI currently uses IndexedDB.
create table if not exists public.staff_shifts (
 id uuid primary key default gen_random_uuid(), lot_id uuid not null references public.lots(id),
 auth_user_id uuid not null default auth.uid(), created_at timestamptz not null default now(),
 user_id text not null, employee_auth_id uuid not null, user_name text,
 start_at timestamptz not null, end_at timestamptz not null, zone text, note text,
 status text not null default 'planifie' check(status in ('planifie','annule')),
 check(end_at>start_at and end_at<=start_at+interval '24 hours')
);
create index if not exists staff_shifts_lot on public.staff_shifts(lot_id);
alter table public.staff_shifts enable row level security;
revoke all on public.staff_shifts from anon,authenticated;
grant select,insert,update on public.staff_shifts to authenticated;
drop policy if exists staff_shifts_read on public.staff_shifts;
create policy staff_shifts_read on public.staff_shifts for select to authenticated using((employee_auth_id=auth.uid() or public.ops_has_role(lot_id,array['admin','responsable'])) and public.ops_has_role(lot_id,array['admin','responsable','caissier','agent','employe']));
drop policy if exists staff_shifts_insert on public.staff_shifts;
create policy staff_shifts_insert on public.staff_shifts for insert to authenticated with check(public.ops_has_role(lot_id,array['admin','responsable']));
drop policy if exists staff_shifts_update on public.staff_shifts;
create policy staff_shifts_update on public.staff_shifts for update to authenticated using(public.ops_has_role(lot_id,array['admin','responsable'])) with check(public.ops_has_role(lot_id,array['admin','responsable']));
drop trigger if exists staff_shifts_audit on public.staff_shifts;
create trigger staff_shifts_audit after insert or update on public.staff_shifts for each row execute function public.ops_audit_trigger();
