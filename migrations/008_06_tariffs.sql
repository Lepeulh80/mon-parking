-- parking_rate_plans: prepared server schema; UI currently uses IndexedDB.
create table if not exists public.parking_rate_plans (
 id uuid primary key default gen_random_uuid(), lot_id uuid not null references public.lots(id),
 auth_user_id uuid not null default auth.uid(), created_at timestamptz not null default now(),
 name text not null, hourly_rate numeric not null check(hourly_rate>=0),
 daily_cap numeric not null default 0 check(daily_cap>=0), grace_minutes int not null default 15 check(grace_minutes between 0 and 1440),
 spot_type text, active boolean not null default true
);
create index if not exists parking_rate_plans_lot on public.parking_rate_plans(lot_id);
alter table public.parking_rate_plans enable row level security;
revoke all on public.parking_rate_plans from anon,authenticated;
grant select,insert,update on public.parking_rate_plans to authenticated;
drop policy if exists parking_rate_plans_read on public.parking_rate_plans;
create policy parking_rate_plans_read on public.parking_rate_plans for select to authenticated using(public.ops_has_role(lot_id,array['admin','responsable','caissier','agent','employe']));
drop policy if exists parking_rate_plans_insert on public.parking_rate_plans;
create policy parking_rate_plans_insert on public.parking_rate_plans for insert to authenticated with check(public.ops_has_role(lot_id,array['admin','responsable']));
drop policy if exists parking_rate_plans_update on public.parking_rate_plans;
create policy parking_rate_plans_update on public.parking_rate_plans for update to authenticated using(public.ops_has_role(lot_id,array['admin','responsable'])) with check(public.ops_has_role(lot_id,array['admin','responsable']));
drop trigger if exists parking_rate_plans_audit on public.parking_rate_plans;
create trigger parking_rate_plans_audit after insert or update on public.parking_rate_plans for each row execute function public.ops_audit_trigger();
