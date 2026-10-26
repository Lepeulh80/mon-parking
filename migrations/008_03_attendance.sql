-- staff_attendance: prepared server schema; UI currently uses IndexedDB.
create table if not exists public.staff_attendance (
 id uuid primary key default gen_random_uuid(), lot_id uuid not null references public.lots(id),
 auth_user_id uuid not null default auth.uid(), created_at timestamptz not null default now(),
 user_id text not null, user_name text, in_at timestamptz not null,
 out_at timestamptz, breaks jsonb not null default '[]', shift_id uuid,
 correction_reason text, check(out_at is null or out_at>=in_at)
);
create index if not exists staff_attendance_lot on public.staff_attendance(lot_id);
alter table public.staff_attendance enable row level security;
revoke all on public.staff_attendance from anon,authenticated;
grant select,insert,update on public.staff_attendance to authenticated;
drop policy if exists staff_attendance_read on public.staff_attendance;
create policy staff_attendance_read on public.staff_attendance for select to authenticated using((auth_user_id=auth.uid() or public.ops_has_role(lot_id,array['admin','responsable'])) and public.ops_has_role(lot_id,array['admin','responsable','caissier','agent','employe']));
drop policy if exists staff_attendance_insert on public.staff_attendance;
create policy staff_attendance_insert on public.staff_attendance for insert to authenticated with check(public.ops_has_role(lot_id,array['admin','responsable','caissier','agent','employe']) and auth_user_id=auth.uid());
drop policy if exists staff_attendance_update on public.staff_attendance;
create policy staff_attendance_update on public.staff_attendance for update to authenticated using(public.ops_has_role(lot_id,array['admin','responsable']) or (auth_user_id=auth.uid() and public.ops_has_role(lot_id,array['admin','responsable','caissier','agent','employe']))) with check(public.ops_has_role(lot_id,array['admin','responsable']) or (auth_user_id=auth.uid() and public.ops_has_role(lot_id,array['admin','responsable','caissier','agent','employe'])));
drop trigger if exists staff_attendance_audit on public.staff_attendance;
create trigger staff_attendance_audit after insert or update on public.staff_attendance for each row execute function public.ops_audit_trigger();
create unique index if not exists one_open_attendance on public.staff_attendance(lot_id,user_id) where out_at is null;
