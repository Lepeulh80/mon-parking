-- ============================================================================
-- MON PARKING · 002 — photos et séquences 360° des véhicules
-- Métadonnées en base ; binaires dans le bucket Storage « vehicle-media ».
-- Convention de chemin : <lot_id>/<vehicle_id>/<kind>/<id>.jpg
-- ============================================================================
create table if not exists vehicle_photos (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references lots(id) on delete cascade,
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  kind text not null check (kind in ('photo','frame')),
  sort int not null default 1 check (sort > 0),
  storage_path text, thumb_path text,
  data text, thumb text,          -- repli hors-ligne (cache local poussé)
  bytes bigint not null default 0 check (bytes >= 0),
  width int, height int, name text,
  cover boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists vehicle_photos_vehicle on vehicle_photos (vehicle_id, kind, sort);
create index if not exists vehicle_photos_lot on vehicle_photos (lot_id, kind);
-- Une seule couverture par véhicule.
create unique index if not exists vehicle_photos_one_cover
  on vehicle_photos (vehicle_id) where cover;

-- Recalcule photo_count / frame_count du véhicule après tout changement.
create or replace function mp_sync_media_counts() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, extensions as $$
declare target uuid := coalesce(new.vehicle_id, old.vehicle_id);
begin
  update public.vehicles v set
    photo_count = (select count(*) from public.vehicle_photos p where p.vehicle_id = target and p.kind = 'photo'),
    frame_count = (select count(*) from public.vehicle_photos p where p.vehicle_id = target and p.kind = 'frame'),
    media_updated_at = now()
  where v.id = target;
  return null;
end $$;

drop trigger if exists vehicle_photos_counts on vehicle_photos;
create trigger vehicle_photos_counts
  after insert or update or delete on vehicle_photos
  for each row execute function mp_sync_media_counts();

-- NOTE : le bucket et ses policies ont été DÉPLACÉS dans
-- 20261022090500_storage_policies.sql. Ils référencent public.mp_member_of() et
-- public.mp_is_admin(), créés seulement par 20261022090200_rls.sql : les créer
-- ici faisait échouer la migration sur un projet Supabase réel
-- (« function public.mp_member_of(uuid) does not exist »).
