-- ============================================================================
-- MON PARKING · 005 — Second facteur (TOTP) et niveau d'assurance AAL2
--
-- Contexte honnête : la connexion de l'application est assurée par le serveur
-- Node (server/auth-store.mjs + cookie HttpOnly), PAS par Supabase Auth. On ne
-- peut donc pas utiliser `supabase.auth.mfa.challenge()` pour ouvrir la
-- session : le second facteur est vérifié côté serveur (server/totp.mjs).
--
-- Ce que ce fichier apporte, en revanche, est bien réel et testable : les
-- policies savent exiger un JWT de niveau `aal2` pour les membres qui ont
-- enrôlé un second facteur. Un jeton volé de niveau `aal1` (PIN seul) ne peut
-- donc pas lire les dépenses, ni supprimer un règlement, ni écrire dans le
-- stock, même s'il est parfaitement valide.
-- ============================================================================

-- Un membre enrôlé en 2FA voit ses écritures sensibles conditionnées à AAL2.
alter table public.memberships
  add column if not exists mfa_enrolled boolean not null default false;

comment on column public.memberships.mfa_enrolled is
  'true quand le membre a activé un second facteur (TOTP). Les policies sensibles exigent alors un JWT aal2.';

-- Niveau d'assurance du JWT courant : 'aal1' par défaut (comme Supabase).
create or replace function public.mp_aal() returns text
language sql stable security definer set search_path = pg_catalog as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'aal', ''), 'aal1')
$$;

-- Vrai si l'utilisateur peut effectuer une action sensible sur ce parking :
--   - il est membre, et
--   - soit il n'a pas enrôlé de second facteur (rétro-compatibilité), soit son
--     jeton est de niveau aal2.
-- Volontairement permissif quand `mfa_enrolled` est faux : sinon tous les
-- comptes existants perdraient l'accès du jour au lendemain.
create or replace function public.mp_mfa_ok(p_lot uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select public.mp_member_of(p_lot)
     and (
       not exists (select 1 from public.memberships m
                   where m.lot_id = p_lot and m.user_id = public.mp_uid() and m.active and m.mfa_enrolled)
       or public.mp_aal() = 'aal2'
     )
$$;

-- Administrateur ET second facteur satisfait.
create or replace function public.mp_is_admin_strong(p_lot uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select public.mp_is_admin(p_lot) and public.mp_mfa_ok(p_lot)
$$;

revoke all on function public.mp_aal(), public.mp_mfa_ok(uuid), public.mp_is_admin_strong(uuid) from public;
grant execute on function public.mp_aal(), public.mp_mfa_ok(uuid), public.mp_is_admin_strong(uuid)
  to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Policies sensibles : lecture des dépenses, journal d'audit, suppression d'un
-- règlement, écriture du stock et des photos. On conserve les policies
-- existantes pour les autres verbes (aucune régression sur les 43 assertions).
-- ---------------------------------------------------------------------------
drop policy if exists expenses_admin on expenses;
create policy expenses_admin on expenses for all to authenticated
  using (public.mp_is_admin_strong(lot_id)) with check (public.mp_is_admin_strong(lot_id));

drop policy if exists audit_read on audit_log;
create policy audit_read on audit_log for select to authenticated
  using (public.mp_is_admin_strong(lot_id));

drop policy if exists payments_delete on payments;
create policy payments_delete on payments for delete to authenticated
  using (public.mp_is_admin_strong(lot_id));

drop policy if exists vehicles_admin on vehicles;
create policy vehicles_admin on vehicles for all to authenticated
  using (public.mp_is_admin_strong(lot_id)) with check (public.mp_is_admin_strong(lot_id));

drop policy if exists vehicle_photos_admin on vehicle_photos;
create policy vehicle_photos_admin on vehicle_photos for all to authenticated
  using (public.mp_is_admin_strong(lot_id)) with check (public.mp_is_admin_strong(lot_id));

-- Le membre peut renseigner lui-même son état d'enrôlement (jamais celui d'un
-- autre) : la colonne est sinon réservée à l'admin du parking.
drop policy if exists memberships_self_mfa on memberships;
create policy memberships_self_mfa on memberships for update to authenticated
  using (user_id = public.mp_uid()) with check (user_id = public.mp_uid());
