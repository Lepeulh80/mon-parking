-- parking_passes: prepared server schema; UI currently uses IndexedDB.
create table if not exists public.parking_passes (
 id uuid primary key default gen_random_uuid(), lot_id uuid not null references public.lots(id),
 auth_user_id uuid not null default auth.uid(), created_at timestamptz not null default now(),
 holder text not null, plate text not null, plate_key text not null, start_at timestamptz not null, end_at timestamptz not null,
 amount numeric not null default 0 check(amount>=0), payment_method text,
 status text not null default 'actif' check(status in ('actif','suspendu')), check(end_at>start_at)
);
create index if not exists parking_passes_lot on public.parking_passes(lot_id);
alter table public.parking_passes enable row level security;
revoke all on public.parking_passes from anon,authenticated;
grant select,insert,update on public.parking_passes to authenticated;
drop policy if exists parking_passes_read on public.parking_passes;
create policy parking_passes_read on public.parking_passes for select to authenticated using(public.ops_has_role(lot_id,array['admin','responsable','caissier','agent']));
drop policy if exists parking_passes_insert on public.parking_passes;
create policy parking_passes_insert on public.parking_passes for insert to authenticated with check(public.ops_has_role(lot_id,array['admin','responsable','caissier']));
drop policy if exists parking_passes_update on public.parking_passes;
create policy parking_passes_update on public.parking_passes for update to authenticated using(public.ops_has_role(lot_id,array['admin','responsable','caissier'])) with check(public.ops_has_role(lot_id,array['admin','responsable','caissier']));
drop trigger if exists parking_passes_audit on public.parking_passes;
create trigger parking_passes_audit after insert or update on public.parking_passes for each row execute function public.ops_audit_trigger();
