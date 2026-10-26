-- MON PARKING v11. Apply AFTER all v8-v10 migrations, as database owner.
-- SECURITY DEFINER avoids recursion through memberships policies. No dynamic SQL.
create or replace function public.is_member(p_lot uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.memberships m where m.lot_id=p_lot and m.user_id=auth.uid() and m.active);
$$;
create or replace function public.is_lot_admin(p_lot uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.memberships m where m.lot_id=p_lot and m.user_id=auth.uid() and m.role='admin' and m.active);
$$;
revoke all on function public.is_member(uuid),public.is_lot_admin(uuid) from public,anon;
grant execute on function public.is_member(uuid),public.is_lot_admin(uuid) to authenticated;

-- Structural validation, not decryption: the passphrase remains client-only.
create or replace function public.v11_valid_envelope(e jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
begin
 if e is null or jsonb_typeof(e)<>'object' then return false;end if;
 if e->>'version' is distinct from '1' or e->>'algorithm' is distinct from 'AES-256-GCM'
 or e->>'kdf' is distinct from 'PBKDF2-SHA256' or e->>'iterations' is distinct from '310000' then return false;end if;
 if jsonb_typeof(e->'salt') is distinct from 'string' or jsonb_typeof(e->'iv') is distinct from 'string'
 or jsonb_typeof(e->'ciphertext') is distinct from 'string' then return false;end if;
 return octet_length(decode(e->>'salt','base64'))=16 and octet_length(decode(e->>'iv','base64'))=12
 and octet_length(decode(e->>'ciphertext','base64'))>=16 and pg_column_size(e)<=35000000;
exception when others then return false;
end;$$;
-- Existing malformed archives are not destroyed; audit/repair before VALIDATE.
alter table public.v10_encrypted_snapshots add constraint v11_complete_envelope
 check(public.v11_valid_envelope(envelope)) not valid;
create or replace function public.v10_store_encrypted_snapshot(p_lot uuid,p_envelope jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare result uuid;begin
 if not public.ops_has_role(p_lot,array['admin','responsable']) then raise exception 'FORBIDDEN';end if;
 if coalesce(auth.jwt()->>'aal','')<>'aal2' then raise exception 'MFA_AAL2_REQUIRED';end if;
 if not public.v11_valid_envelope(p_envelope) then raise exception 'INVALID_ENCRYPTED_ENVELOPE';end if;
 insert into public.v10_encrypted_snapshots(lot_id,user_id,envelope) values(p_lot,auth.uid(),p_envelope) returning id into result;
 return result;
end;$$;
revoke all on function public.v10_store_encrypted_snapshot(uuid,jsonb) from public,anon;
grant execute on function public.v10_store_encrypted_snapshot(uuid,jsonb) to authenticated;
