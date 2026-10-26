-- ============================================================================
-- MON PARKING · 006 — bucket Storage « vehicle-media » et ses policies
--
-- Placé APRÈS 20261022090200_rls.sql (helpers) et 20261022090400_mfa_aal.sql
-- (aal2) : les policies peuvent donc réellement référencer
-- public.mp_member_of(), mp_is_admin_strong() et auth.uid().
-- Chemin conventionnel : <lot_id>/<vehicle_id>/<kind>/<id>.jpg
-- ============================================================================

do $$
begin
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise notice 'Schéma storage absent : bucket vehicle-media non créé (PostgreSQL nu).';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('vehicle-media', 'vehicle-media', false, 8388608,
          array['image/jpeg','image/png','image/webp','image/avif'])
  on conflict (id) do update
    set public = excluded.public,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  execute 'drop policy if exists vehicle_media_read on storage.objects';
  execute 'drop policy if exists vehicle_media_write on storage.objects';
  execute 'drop policy if exists vehicle_media_update on storage.objects';
  execute 'drop policy if exists vehicle_media_delete on storage.objects';

  -- Lecture : tout membre du parking, dossier racine = lot_id.
  execute $p$create policy vehicle_media_read on storage.objects for select to authenticated
    using (bucket_id = 'vehicle-media'
           and public.mp_member_of(public.mp_try_uuid((storage.foldername(name))[1])))$p$;

  -- Écriture : admin du parking, second facteur satisfait, et propriétaire
  -- = l'appelant (sinon un admin pourrait déposer un objet au nom d'un tiers).
  execute $p$create policy vehicle_media_write on storage.objects for insert to authenticated
    with check (bucket_id = 'vehicle-media'
                and owner = auth.uid()
                and public.mp_is_admin_strong(public.mp_try_uuid((storage.foldername(name))[1])))$p$;

  -- Mise à jour (upsert d'une photo corrigée) : mêmes conditions.
  execute $p$create policy vehicle_media_update on storage.objects for update to authenticated
    using (bucket_id = 'vehicle-media'
           and public.mp_is_admin_strong(public.mp_try_uuid((storage.foldername(name))[1])))
    with check (bucket_id = 'vehicle-media'
                and public.mp_is_admin_strong(public.mp_try_uuid((storage.foldername(name))[1])))$p$;

  execute $p$create policy vehicle_media_delete on storage.objects for delete to authenticated
    using (bucket_id = 'vehicle-media'
           and public.mp_is_admin_strong(public.mp_try_uuid((storage.foldername(name))[1])))$p$;
end $$;
