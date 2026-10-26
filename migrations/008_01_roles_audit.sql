-- MON PARKING v8. Run after the main schema and the v7 OCR migration.
-- Schema/RLS for a future server adapter; the new operational UI stays LOCAL.
-- These migrations do not activate RH/cash replication or replace financial RPCs.
alter table public.memberships drop constraint if exists memberships_role_check;
alter table public.memberships add constraint memberships_role_check check(role in ('admin','responsable','caissier','agent','employe'));
create or replace function public.ops_has_role(p_lot uuid, p_roles text[])
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.memberships m where m.lot_id=p_lot and m.user_id=auth.uid() and m.active and m.role=any(p_roles));
$$;
revoke all on function public.ops_has_role(uuid,text[]) from public,anon;
grant execute on function public.ops_has_role(uuid,text[]) to authenticated;
create table if not exists public.ops_audit (
 id uuid primary key default gen_random_uuid(), lot_id uuid not null references public.lots(id),
 actor_id uuid not null default auth.uid(), action text not null, target text,
 before_data jsonb, after_data jsonb, at timestamptz not null default now()
);
alter table public.ops_audit enable row level security;
revoke all on public.ops_audit from anon,authenticated;
grant select on public.ops_audit to authenticated;
drop policy if exists ops_audit_read on public.ops_audit;
create policy ops_audit_read on public.ops_audit for select to authenticated using(public.ops_has_role(lot_id,array['admin','responsable']));
create or replace function public.ops_audit_trigger() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.ops_audit(lot_id,actor_id,action,target,before_data,after_data)
 values(new.lot_id, auth.uid(), tg_table_name||':'||tg_op, new.id::text,
 case when tg_op='UPDATE' then to_jsonb(old) else null end,to_jsonb(new));
 return new;
end;$$;
revoke all on function public.ops_audit_trigger() from public,anon,authenticated;
