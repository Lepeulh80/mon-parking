-- v10: server scaffold, after v9. No bank/OAuth secrets in the browser or these tables.
create table if not exists public.v10_preferences (
 lot_id uuid not null references public.lots(id), user_id uuid not null default auth.uid(),
 prefs jsonb not null default '{}', updated_at timestamptz not null default clock_timestamp(), primary key(lot_id,user_id)
);
create table if not exists public.v10_encrypted_snapshots (
 id uuid primary key default gen_random_uuid(),lot_id uuid not null references public.lots(id),
 user_id uuid not null default auth.uid(), envelope jsonb not null,created_at timestamptz not null default clock_timestamp(),
 check(envelope->>'algorithm'='AES-256-GCM' and envelope->>'kdf'='PBKDF2-SHA256' and (envelope->>'iterations')::int=310000)
);
alter table public.v10_preferences enable row level security;
alter table public.v10_encrypted_snapshots enable row level security;
revoke all on public.v10_preferences,public.v10_encrypted_snapshots from anon,authenticated;
grant select on public.v10_preferences,public.v10_encrypted_snapshots to authenticated;
create policy v10_prefs_own on public.v10_preferences for select to authenticated using(user_id=auth.uid() and public.ops_has_role(lot_id,array['admin','responsable','caissier','agent','employe']));
create policy v10_vault_own on public.v10_encrypted_snapshots for select to authenticated using(user_id=auth.uid() and (auth.jwt()->>'aal')='aal2' and public.ops_has_role(lot_id,array['admin','responsable']));
create or replace function public.v10_sync_preferences(p_lot uuid,p_preferences jsonb default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;begin
 if not public.ops_has_role(p_lot,array['admin','responsable','caissier','agent','employe']) then raise exception 'FORBIDDEN';end if;
 if p_preferences is not null then
  if pg_column_size(p_preferences)>32768 then raise exception 'PREFERENCES_TOO_LARGE';end if;
  insert into public.v10_preferences(lot_id,user_id,prefs) values(p_lot,auth.uid(),p_preferences)
  on conflict(lot_id,user_id) do update set prefs=excluded.prefs,updated_at=clock_timestamp();
 end if;
 select prefs||jsonb_build_object('serverUpdatedAt',updated_at) into result from public.v10_preferences where lot_id=p_lot and user_id=auth.uid();
 return coalesce(result,'{}'::jsonb);
end;$$;
create or replace function public.v10_store_encrypted_snapshot(p_lot uuid,p_envelope jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare result uuid;begin
 if not public.ops_has_role(p_lot,array['admin','responsable']) then raise exception 'FORBIDDEN';end if;
 if coalesce(auth.jwt()->>'aal','')<>'aal2' then raise exception 'MFA_AAL2_REQUIRED';end if;
 if pg_column_size(p_envelope)>35000000 or p_envelope->>'algorithm'<>'AES-256-GCM' or p_envelope->>'kdf'<>'PBKDF2-SHA256' or coalesce((p_envelope->>'iterations')::int,0)<>310000 then raise exception 'INVALID_ENCRYPTED_ENVELOPE';end if;
 insert into public.v10_encrypted_snapshots(lot_id,user_id,envelope) values(p_lot,auth.uid(),p_envelope) returning id into result;
 return result;
end;$$;
revoke all on function public.v10_sync_preferences(uuid,jsonb),public.v10_store_encrypted_snapshot(uuid,jsonb) from public,anon;
grant execute on function public.v10_sync_preferences(uuid,jsonb),public.v10_store_encrypted_snapshot(uuid,jsonb) to authenticated;
-- Role changes remain server-controlled through memberships. MFA here protects
-- vault access, NOT every legacy v1-v9 RPC; enforce global AAL2 before production.
