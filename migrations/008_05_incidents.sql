-- parking_incidents: prepared server schema; UI currently uses IndexedDB.
create table if not exists public.parking_incidents (
 id uuid primary key default gen_random_uuid(), lot_id uuid not null references public.lots(id),
 auth_user_id uuid not null default auth.uid(), created_at timestamptz not null default now(),
 title text not null check(length(trim(title))>0), description text not null,
 plate text, severity text not null check(severity in ('faible','moyenne','haute','critique')),
 status text not null default 'ouvert' check(status in ('ouvert','en_cours','resolu')),
 assigned_auth_id uuid, photo text, history jsonb not null default '[]', resolved_at timestamptz
);
create index if not exists parking_incidents_lot on public.parking_incidents(lot_id);
alter table public.parking_incidents enable row level security;
revoke all on public.parking_incidents from anon,authenticated;
grant select,insert,update on public.parking_incidents to authenticated;
drop policy if exists parking_incidents_read on public.parking_incidents;
create policy parking_incidents_read on public.parking_incidents for select to authenticated using((auth_user_id=auth.uid() or public.ops_has_role(lot_id,array['admin','responsable'])) and public.ops_has_role(lot_id,array['admin','responsable','caissier','agent','employe']));
drop policy if exists parking_incidents_insert on public.parking_incidents;
create policy parking_incidents_insert on public.parking_incidents for insert to authenticated with check(public.ops_has_role(lot_id,array['admin','responsable','caissier','agent','employe']) and auth_user_id=auth.uid());
drop policy if exists parking_incidents_update on public.parking_incidents;
create policy parking_incidents_update on public.parking_incidents for update to authenticated using(public.ops_has_role(lot_id,array['admin','responsable']) or (auth_user_id=auth.uid() and public.ops_has_role(lot_id,array['admin','responsable','caissier','agent','employe']))) with check(public.ops_has_role(lot_id,array['admin','responsable']) or (auth_user_id=auth.uid() and public.ops_has_role(lot_id,array['admin','responsable','caissier','agent','employe'])));
drop trigger if exists parking_incidents_audit on public.parking_incidents;
create trigger parking_incidents_audit after insert or update on public.parking_incidents for each row execute function public.ops_audit_trigger();
