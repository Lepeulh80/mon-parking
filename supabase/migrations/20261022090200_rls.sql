-- ============================================================================
-- MON PARKING · 003 — Row Level Security
-- Toutes les policies passent par des fonctions SECURITY DEFINER : une policy
-- sur `memberships` qui interroge `memberships` provoque une récursion
-- infinie (« infinite recursion detected in policy »).
-- Convention : les helpers sont dans le schéma public, nommés mp_*, et
-- renvoient false plutôt que null quand l'utilisateur n'est pas authentifié.
-- ============================================================================

create schema if not exists app_private;

-- UUID de l'utilisateur authentifié, ou null.
create or replace function public.mp_uid() returns uuid
language sql stable security definer set search_path = pg_catalog as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
$$;

-- Conversion tolérante d'un texte en uuid (un chemin Storage peut être autre chose).
create or replace function public.mp_try_uuid(p text) returns uuid
language plpgsql immutable as $$
begin
  return p::uuid;
exception when others then
  return null;
end $$;

create or replace function public.mp_member_of(p_lot uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select p_lot is not null and exists (
    select 1 from public.memberships m
    where m.lot_id = p_lot and m.user_id = public.mp_uid() and m.active
  )
$$;

create or replace function public.mp_role_of(p_lot uuid) returns text
language sql stable security definer set search_path = pg_catalog, public as $$
  select m.role from public.memberships m
  where m.lot_id = p_lot and m.user_id = public.mp_uid() and m.active
  limit 1
$$;

-- Administrateur du parking, ou propriétaire du parking.
create or replace function public.mp_is_admin(p_lot uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select p_lot is not null and (
    exists (select 1 from public.memberships m
            where m.lot_id = p_lot and m.user_id = public.mp_uid() and m.active and m.role = 'admin')
    or exists (select 1 from public.lots l
               where l.id = p_lot and l.owner_id = public.mp_uid())
  )
$$;

-- Peut encaisser / vendre (admin, responsable, caissier, employé).
create or replace function public.mp_can_sell(p_lot uuid) returns boolean
language sql stable security definer set search_path = pg_catalog, public as $$
  select public.mp_role_of(p_lot) in ('admin','responsable','caissier','employe')
$$;

revoke all on function public.mp_uid(), public.mp_try_uuid(text) from public;
grant execute on function public.mp_uid(), public.mp_try_uuid(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Activation RLS sur toutes les tables métier.
-- ---------------------------------------------------------------------------
alter table lots            enable row level security;
alter table memberships     enable row level security;
alter table vehicles        enable row level security;
alter table vehicle_photos  enable row level security;
alter table clients         enable row level security;
alter table sales           enable row level security;
alter table payments        enable row level security;
alter table expenses        enable row level security;
alter table stock_moves     enable row level security;
alter table audit_log       enable row level security;
alter table spots           enable row level security;
alter table tickets         enable row level security;
alter table reservations    enable row level security;

-- Filet de sécurité : sans policy, aucune ligne n'est visible. On garde
-- néanmoins les grants explicites pour que les tests soient parlants.
revoke all on all tables in schema public from anon;
grant select on lots, memberships, vehicles, vehicle_photos, clients, sales,
  payments, expenses, stock_moves, audit_log, spots, tickets, reservations to authenticated;
grant insert, update, delete on vehicles, vehicle_photos, clients, sales, payments,
  expenses, stock_moves, spots, tickets, reservations to authenticated;
-- `lots` est modifiable (nom, tarifs, préfixes de facture) mais la policy limite
-- l'écriture à l'admin du parking.
grant update on lots to authenticated;
grant insert on lots to authenticated;

-- ---------------------------------------------------------------------------
-- lots
-- ---------------------------------------------------------------------------
drop policy if exists lots_read on lots;
drop policy if exists lots_update on lots;
drop policy if exists lots_insert on lots;
create policy lots_read on lots for select to authenticated using (public.mp_member_of(id));
create policy lots_update on lots for update to authenticated
  using (public.mp_is_admin(id)) with check (public.mp_is_admin(id));
-- Un parking ne peut être créé que par son propriétaire.
create policy lots_insert on lots for insert to authenticated with check (owner_id = public.mp_uid());

-- ---------------------------------------------------------------------------
-- memberships
-- ---------------------------------------------------------------------------
drop policy if exists memberships_read on memberships;
drop policy if exists memberships_admin on memberships;
create policy memberships_read on memberships for select to authenticated
  using (user_id = public.mp_uid() or public.mp_is_admin(lot_id));
create policy memberships_admin on memberships for all to authenticated
  using (public.mp_is_admin(lot_id)) with check (public.mp_is_admin(lot_id));

-- ---------------------------------------------------------------------------
-- vehicles : lecture pour tous les membres ; écriture réservée à l'admin.
-- L'employé ne peut donc ni modifier un prix, ni supprimer un véhicule.
-- ---------------------------------------------------------------------------
drop policy if exists vehicles_read on vehicles;
drop policy if exists vehicles_write on vehicles;
drop policy if exists vehicles_admin on vehicles;
create policy vehicles_read on vehicles for select to authenticated using (public.mp_member_of(lot_id));
create policy vehicles_write on vehicles for insert to authenticated with check (public.mp_is_admin(lot_id));
create policy vehicles_admin on vehicles for all to authenticated
  using (public.mp_is_admin(lot_id)) with check (public.mp_is_admin(lot_id));

-- ---------------------------------------------------------------------------
-- vehicle_photos : lecture membres, écriture admin (les photos sont des
-- pièces commerciales : elles ne doivent pas être modifiables par un vendeur).
-- ---------------------------------------------------------------------------
drop policy if exists vehicle_photos_read on vehicle_photos;
drop policy if exists vehicle_photos_admin on vehicle_photos;
create policy vehicle_photos_read on vehicle_photos for select to authenticated
  using (public.mp_member_of(lot_id));
create policy vehicle_photos_admin on vehicle_photos for all to authenticated
  using (public.mp_is_admin(lot_id)) with check (public.mp_is_admin(lot_id));

-- ---------------------------------------------------------------------------
-- clients : lecture et création par tout membre, suppression admin.
-- ---------------------------------------------------------------------------
drop policy if exists clients_read on clients;
drop policy if exists clients_insert on clients;
drop policy if exists clients_update on clients;
drop policy if exists clients_delete on clients;
create policy clients_read on clients for select to authenticated using (public.mp_member_of(lot_id));
create policy clients_insert on clients for insert to authenticated with check (public.mp_member_of(lot_id));
create policy clients_update on clients for update to authenticated
  using (public.mp_member_of(lot_id)) with check (public.mp_member_of(lot_id));
create policy clients_delete on clients for delete to authenticated using (public.mp_is_admin(lot_id));

-- ---------------------------------------------------------------------------
-- sales : l'employé vend (insert), l'admin seul modifie ou supprime.
-- ---------------------------------------------------------------------------
drop policy if exists sales_read on sales;
drop policy if exists sales_insert on sales;
drop policy if exists sales_update on sales;
drop policy if exists sales_delete on sales;
create policy sales_read on sales for select to authenticated using (public.mp_member_of(lot_id));
create policy sales_insert on sales for insert to authenticated
  with check (public.mp_can_sell(lot_id) and user_id = public.mp_uid());
create policy sales_update on sales for update to authenticated
  using (public.mp_is_admin(lot_id)) with check (public.mp_is_admin(lot_id));
create policy sales_delete on sales for delete to authenticated using (public.mp_is_admin(lot_id));

-- ---------------------------------------------------------------------------
-- payments : encaissement par les vendeurs, mais jamais de suppression.
-- ---------------------------------------------------------------------------
drop policy if exists payments_read on payments;
drop policy if exists payments_insert on payments;
drop policy if exists payments_delete on payments;
create policy payments_read on payments for select to authenticated using (public.mp_member_of(lot_id));
create policy payments_insert on payments for insert to authenticated with check (public.mp_can_sell(lot_id));
create policy payments_delete on payments for delete to authenticated using (public.mp_is_admin(lot_id));

-- ---------------------------------------------------------------------------
-- expenses / audit_log : admin seulement.
-- ---------------------------------------------------------------------------
drop policy if exists expenses_admin on expenses;
create policy expenses_admin on expenses for all to authenticated
  using (public.mp_is_admin(lot_id)) with check (public.mp_is_admin(lot_id));

drop policy if exists audit_read on audit_log;
drop policy if exists audit_insert on audit_log;
create policy audit_read on audit_log for select to authenticated using (public.mp_is_admin(lot_id));
create policy audit_insert on audit_log for insert to authenticated with check (public.mp_member_of(lot_id));

-- ---------------------------------------------------------------------------
-- stock_moves : lecture membres, écriture membres (entrée/sortie), pas d'update.
-- ---------------------------------------------------------------------------
drop policy if exists moves_read on stock_moves;
drop policy if exists moves_insert on stock_moves;
drop policy if exists moves_update on stock_moves;
create policy moves_read on stock_moves for select to authenticated using (public.mp_member_of(lot_id));
create policy moves_insert on stock_moves for insert to authenticated with check (public.mp_member_of(lot_id));
create policy moves_update on stock_moves for update to authenticated
  using (public.mp_is_admin(lot_id)) with check (public.mp_is_admin(lot_id));

-- ---------------------------------------------------------------------------
-- stationnement : entrées/sorties par les agents, tarifs par l'admin.
-- ---------------------------------------------------------------------------
drop policy if exists spots_read on spots;
drop policy if exists spots_admin on spots;
create policy spots_read on spots for select to authenticated using (public.mp_member_of(lot_id));
create policy spots_admin on spots for all to authenticated
  using (public.mp_is_admin(lot_id)) with check (public.mp_is_admin(lot_id));

drop policy if exists tickets_read on tickets;
drop policy if exists tickets_insert on tickets;
drop policy if exists tickets_update on tickets;
drop policy if exists tickets_delete on tickets;
create policy tickets_read on tickets for select to authenticated using (public.mp_member_of(lot_id));
create policy tickets_insert on tickets for insert to authenticated with check (public.mp_member_of(lot_id));
create policy tickets_update on tickets for update to authenticated
  using (public.mp_member_of(lot_id)) with check (public.mp_member_of(lot_id));
create policy tickets_delete on tickets for delete to authenticated using (public.mp_is_admin(lot_id));

drop policy if exists resa_read on reservations;
drop policy if exists resa_write on reservations;
create policy resa_read on reservations for select to authenticated using (public.mp_member_of(lot_id));
create policy resa_write on reservations for all to authenticated
  using (public.mp_member_of(lot_id)) with check (public.mp_member_of(lot_id));
