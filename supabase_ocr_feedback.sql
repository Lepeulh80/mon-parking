-- ============================================================================
-- MON PARKING — Réplication de l'apprentissage OCR entre les postes
-- Table : ocr_feedback
-- À exécuter APRÈS supabase_schema.sql (dépend de lots.id et is_member()).
-- ============================================================================

create table if not exists ocr_feedback (
  -- UUID généré par le poste : c'est la clé d'idempotence.
  -- Rejouer un envoi fait un upsert sur cette clé, jamais un doublon.
  id              uuid primary key,
  lot_id          uuid not null references lots(id) on delete cascade,
  poste_id        text not null,
  at              timestamptz not null default now(),
  user_id         text,
  user_name       text,
  raw             text not null,             -- texte réellement lu par l'OCR
  raw_compact     text,
  chosen          text not null,             -- plaque retenue par l'opérateur
  chosen_compact  text,
  rejected        text[] not null default '{}',
  source          text not null default 'suggestion'
                    check (source in ('suggestion','correction')),
  pairs           text[] not null default '{}',   -- substitutions, ex. {4>A}
  created_at      timestamptz not null default now()
);

create index if not exists ocr_feedback_lot_created on ocr_feedback (lot_id, created_at);
create index if not exists ocr_feedback_lot_poste   on ocr_feedback (lot_id, poste_id);

alter table ocr_feedback enable row level security;

-- Aucune modification ni suppression : une confirmation est un fait daté.
-- La réinitialisation côté application est locale (elle n'efface pas la
-- connaissance des autres postes).
revoke update, delete on ocr_feedback from anon, authenticated;

-- Helper dédié : évite la récursion RLS des policies de memberships.
-- Exécuter ce fichier comme propriétaire des tables dans le SQL Editor.
create or replace function public.ocr_is_member(p_lot uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.lot_id = p_lot and m.user_id = auth.uid() and m.active
  );
$$;
revoke all on function public.ocr_is_member(uuid) from public, anon;
grant execute on function public.ocr_is_member(uuid) to authenticated;

-- 1) Postes authentifiés (Supabase Auth + memberships) ------------------------
drop policy if exists ocr_feedback_select_member on ocr_feedback;
drop policy if exists ocr_feedback_insert_member on ocr_feedback;
create policy ocr_feedback_select_member on ocr_feedback
  for select to authenticated using (public.ocr_is_member(lot_id));
create policy ocr_feedback_insert_member on ocr_feedback
  for insert to authenticated with check (public.ocr_is_member(lot_id));

-- La clé publique seule ne donne AUCUN accès aux plaques.
-- Supprimer aussi les anciennes policies anon si cette migration est réexécutée.
drop policy if exists ocr_feedback_select_anon on ocr_feedback;
drop policy if exists ocr_feedback_insert_anon on ocr_feedback;
revoke all on ocr_feedback from anon;
grant select, insert on ocr_feedback to authenticated;
-- Supabase Realtime est facultatif : la synchronisation automatique est un
-- polling incrémental de 20 secondes et une reprise lors du retour réseau.
