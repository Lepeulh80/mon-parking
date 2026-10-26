-- ============================================================================
-- Harnais local UNIQUEMENT : imite storage.buckets / storage.objects et
-- storage.foldername() pour pouvoir TESTER les policies du bucket.
-- Ne jamais exécuter sur Supabase (le vrai schéma storage existe).
-- ============================================================================
create schema if not exists storage;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz not null default now()
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets(id),
  name text not null,
  owner uuid,
  metadata jsonb,
  created_at timestamptz not null default now(),
  unique (bucket_id, name)
);

-- Même contrat que Supabase : tous les segments sauf le dernier.
create or replace function storage.foldername(name text) returns text[]
language sql immutable as $$
  select (string_to_array(name, '/'))[1 : array_length(string_to_array(name, '/'), 1) - 1]
$$;

alter table storage.objects enable row level security;

grant usage on schema storage to anon, authenticated, service_role;
grant select on storage.buckets to anon, authenticated;
grant select, insert, update, delete on storage.objects to anon, authenticated;
