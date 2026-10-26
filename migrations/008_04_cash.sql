-- cash_sessions: prepared server schema; UI currently uses IndexedDB.
create table if not exists public.cash_sessions (
 id uuid primary key default gen_random_uuid(), lot_id uuid not null references public.lots(id),
 auth_user_id uuid not null default auth.uid(), created_at timestamptz not null default now(),
 user_id text not null, user_name text, opening_float numeric not null check(opening_float>=0),
 status text not null default 'ouverte' check(status in ('ouverte','cloturee')),
 opened_at timestamptz not null default now(), closed_at timestamptz,
 expected numeric, counted numeric check(counted>=0), variance numeric, reason text, reviewed_by uuid,
 check(status<>'cloturee' or (closed_at is not null and counted is not null))
);
create index if not exists cash_sessions_lot on public.cash_sessions(lot_id);
alter table public.cash_sessions enable row level security;
revoke all on public.cash_sessions from anon,authenticated;
grant select,insert,update on public.cash_sessions to authenticated;
drop policy if exists cash_sessions_read on public.cash_sessions;
create policy cash_sessions_read on public.cash_sessions for select to authenticated using((auth_user_id=auth.uid() or public.ops_has_role(lot_id,array['admin','responsable'])) and public.ops_has_role(lot_id,array['admin','responsable','caissier','agent','employe']));
drop policy if exists cash_sessions_insert on public.cash_sessions;
create policy cash_sessions_insert on public.cash_sessions for insert to authenticated with check(public.ops_has_role(lot_id,array['admin','responsable','caissier','employe']) and auth_user_id=auth.uid());
drop policy if exists cash_sessions_update on public.cash_sessions;
create policy cash_sessions_update on public.cash_sessions for update to authenticated using(public.ops_has_role(lot_id,array['admin','responsable']) or (auth_user_id=auth.uid() and public.ops_has_role(lot_id,array['admin','responsable','caissier','employe']))) with check(public.ops_has_role(lot_id,array['admin','responsable']) or (auth_user_id=auth.uid() and public.ops_has_role(lot_id,array['admin','responsable','caissier','employe'])));
drop trigger if exists cash_sessions_audit on public.cash_sessions;
create trigger cash_sessions_audit after insert or update on public.cash_sessions for each row execute function public.ops_audit_trigger();
create unique index if not exists one_open_cash on public.cash_sessions(lot_id,user_id) where status='ouverte';
