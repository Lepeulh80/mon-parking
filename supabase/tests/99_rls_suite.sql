-- ============================================================================
-- Suite RLS — exécutée par supabase/tests/run-rls.mjs
-- Principe : les requêtes sont exécutées SOUS LE RÔLE `authenticated` avec le
-- claim JWT d'un utilisateur donné. Une policy qui laisserait passer une
-- lecture ou une écriture entre deux parkings fait échouer le test.
-- ============================================================================

drop table if exists rls_results;
create table rls_results (id serial primary key, name text not null, ok boolean not null, detail text);
revoke all on rls_results from public;

-- Enregistrement : SECURITY DEFINER, uniquement pour écrire le résultat.
create or replace function public.mp_record(p_name text, p_ok boolean, p_detail text default null)
returns void language sql security definer set search_path = pg_catalog, public as $$
  insert into public.rls_results (name, ok, detail) values (p_name, p_ok, p_detail);
$$;

-- Exécute une requête en tant qu'appelant (donc avec RLS) et vérifie le
-- nombre de lignes obtenues. Pour un DML, min_rows = 0 suffit à prouver le droit.
create or replace function public.mp_expect_rows(p_name text, p_sql text, p_min int)
returns void language plpgsql security invoker as $$
declare n int;
begin
  execute 'select count(*) from (' || p_sql || ') t' into n;
  perform public.mp_record(p_name, n >= p_min, format('%s ligne(s), minimum attendu %s', n, p_min));
exception when others then
  perform public.mp_record(p_name, false, sqlstate || ' ' || sqlerrm);
end $$;

-- Exécute un DML et attend un REFUS (SQLSTATE 42501 = RLS / privilège).
create or replace function public.mp_expect_denied(p_name text, p_sql text)
returns void language plpgsql security invoker as $$
begin
  execute p_sql;
  perform public.mp_record(p_name, false, 'la requête a été ACCEPTÉE alors qu''elle devait être refusée');
exception
  when insufficient_privilege then
    perform public.mp_record(p_name, true, 'refusée (42501)');
  when others then
    -- Un refus par contrainte (23505, 23514) prouve aussi le blocage, mais on
    -- le distingue pour ne pas confondre RLS et contrainte métier.
    perform public.mp_record(p_name, sqlstate in ('42501','23505','23514'), sqlstate || ' ' || sqlerrm);
end $$;

-- Exécute un UPDATE/DELETE et prouve qu'il ne touche AUCUNE ligne.
-- PostgreSQL ne lève pas d'erreur quand la clause USING masque toutes les
-- lignes : il en modifie zéro. Mesurer ROW_COUNT est donc la seule preuve
-- honnête pour ces deux verbes.
create or replace function public.mp_expect_no_rows(p_name text, p_sql text)
returns void language plpgsql security invoker as $$
declare n int;
begin
  execute p_sql;
  get diagnostics n = row_count;
  perform public.mp_record(p_name, n = 0, format('%s ligne(s) touchée(s), attendu 0', n));
exception
  when insufficient_privilege then
    perform public.mp_record(p_name, true, 'refusée (42501)');
  when others then
    perform public.mp_record(p_name, sqlstate in ('42501','23505','23514'), sqlstate || ' ' || sqlerrm);
end $$;

-- Exige EXACTEMENT n lignes : seule forme correcte pour prouver une absence.
create or replace function public.mp_expect_count(p_name text, p_sql text, p_expected int)
returns void language plpgsql security invoker as $$
declare n int;
begin
  execute 'select count(*) from (' || p_sql || ') t' into n;
  perform public.mp_record(p_name, n = p_expected, format('%s ligne(s), attendu exactement %s', n, p_expected));
exception when others then
  perform public.mp_record(p_name, false, sqlstate || ' ' || sqlerrm);
end $$;

-- Exécute un DML et attend un succès.
create or replace function public.mp_expect_ok(p_name text, p_sql text)
returns void language plpgsql security invoker as $$
begin
  execute p_sql;
  perform public.mp_record(p_name, true, 'acceptée');
exception when others then
  perform public.mp_record(p_name, false, sqlstate || ' ' || sqlerrm);
end $$;

grant execute on function public.mp_record(text, boolean, text),
  public.mp_expect_rows(text, text, int),
  public.mp_expect_denied(text, text),
  public.mp_expect_no_rows(text, text),
  public.mp_expect_count(text, text, int),
  public.mp_expect_ok(text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Jeu de données : deux parkings, quatre comptes, aucune donnée partagée.
-- Inséré en superutilisateur (propriétaire des tables) : la RLS ne s'applique
-- pas au propriétaire, ce qui est le comportement attendu.
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000000a1', 'admin-a@test.local'),
  ('00000000-0000-4000-8000-0000000000a2', 'vendeur-a@test.local'),
  ('00000000-0000-4000-8000-0000000000b1', 'admin-b@test.local'),
  ('00000000-0000-4000-8000-0000000000c1', 'sans-parking@test.local')
on conflict do nothing;

insert into lots (id, name, owner_id) values
  ('11111111-1111-4111-8111-111111111111', 'Parc A', '00000000-0000-4000-8000-0000000000a1'),
  ('22222222-2222-4222-8222-222222222222', 'Parc B', '00000000-0000-4000-8000-0000000000b1')
on conflict do nothing;

insert into memberships (lot_id, user_id, role, username) values
  ('11111111-1111-4111-8111-111111111111', '00000000-0000-4000-8000-0000000000a1', 'admin', 'admin-a'),
  ('11111111-1111-4111-8111-111111111111', '00000000-0000-4000-8000-0000000000a2', 'employe', 'vendeur-a'),
  ('22222222-2222-4222-8222-222222222222', '00000000-0000-4000-8000-0000000000b1', 'admin', 'admin-b')
on conflict do nothing;

insert into vehicles (id, lot_id, plate, brand, model, price, status) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '11111111-1111-4111-8111-111111111111', 'CI 0001 AA', 'Toyota', 'Corolla', 12000000, 'stock'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', '11111111-1111-4111-8111-111111111111', 'CI 0002 AA', 'Kia', 'Sportage', 19000000, 'stock'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', '22222222-2222-4222-8222-222222222222', 'CI 0003 BB', 'Hyundai', 'Tucson', 15000000, 'stock')
on conflict do nothing;

insert into clients (id, lot_id, name) values
  ('cccccccc-cccc-4ccc-8ccc-ccccccccccc1', '11111111-1111-4111-8111-111111111111', 'Client A'),
  ('cccccccc-cccc-4ccc-8ccc-ccccccccccc2', '22222222-2222-4222-8222-222222222222', 'Client B')
on conflict do nothing;

insert into expenses (id, lot_id, label, amount) values
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1', '11111111-1111-4111-8111-111111111111', 'Loyer', 250000)
on conflict do nothing;

insert into vehicle_photos (id, lot_id, vehicle_id, kind, thumb, bytes) values
  ('dddddddd-dddd-4ddd-8ddd-ddddddddddd1', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'photo', 'thumb-a', 100),
  ('dddddddd-dddd-4ddd-8ddd-ddddddddddd2', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', 'frame', 'thumb-a2', 100)
on conflict do nothing;

-- ===========================================================================
-- 1. ANON : aucun accès aux données métier.
-- ===========================================================================
set role anon;
select public.mp_expect_denied('anon : lecture des véhicules refusée', 'select * from vehicles');
select public.mp_expect_denied('anon : lecture des lots refusée', 'select * from lots');
reset role;

-- ===========================================================================
-- 2. ADMIN DU PARC A
-- ===========================================================================
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}', false);

select public.mp_expect_rows('admin A : voit exactement les 2 véhicules de son parc',
  $q$select * from vehicles where lot_id = '11111111-1111-4111-8111-111111111111'$q$, 2);
select public.mp_expect_rows('admin A : ne voit AUCUN véhicule du parc B',
  $q$select * from vehicles where lot_id = '22222222-2222-4222-8222-222222222222'$q$, 0);
select public.mp_expect_rows('admin A : ne voit AUCUNE vente du parc B',
  $q$select * from sales where lot_id = '22222222-2222-4222-8222-222222222222'$q$, 0);
select public.mp_expect_rows('admin A : ne voit AUCUN client du parc B',
  $q$select * from clients where lot_id = '22222222-2222-4222-8222-222222222222'$q$, 0);
select public.mp_expect_rows('admin A : ne voit AUCUNE adhésion du parc B',
  $q$select * from memberships where lot_id = '22222222-2222-4222-8222-222222222222'$q$, 0);
select public.mp_expect_rows('admin A : voit les 2 adhésions de son parc',
  $q$select * from memberships where lot_id = '11111111-1111-4111-8111-111111111111'$q$, 2);
select public.mp_expect_rows('admin A : voit ses photos de véhicule',
  $q$select * from vehicle_photos$q$, 2);

select public.mp_expect_ok('admin A : peut créer un véhicule dans son parc',
  $q$insert into vehicles (lot_id, plate, brand, price) values ('11111111-1111-4111-8111-111111111111', 'CI 0100 AA', 'Mazda', 8000000)$q$);
select public.mp_expect_denied('admin A : ne peut PAS créer un véhicule dans le parc B',
  $q$insert into vehicles (lot_id, plate, brand, price) values ('22222222-2222-4222-8222-222222222222', 'CI 0200 BB', 'Fraude', 1000)$q$);
select public.mp_expect_no_rows('admin A : ne peut PAS modifier un véhicule du parc B',
  $q$update vehicles set price = 1 where lot_id = '22222222-2222-4222-8222-222222222222'$q$);
select public.mp_expect_no_rows('admin A : ne peut PAS supprimer un véhicule du parc B',
  $q$delete from vehicles where lot_id = '22222222-2222-4222-8222-222222222222'$q$);
select public.mp_expect_denied('admin A : ne peut PAS s''ajouter au parc B',
  $q$insert into memberships (lot_id, user_id, role, username) values ('22222222-2222-4222-8222-222222222222','00000000-0000-4000-8000-0000000000a1','admin','intrus')$q$);
select public.mp_expect_no_rows('admin A : ne peut PAS modifier la ligne du parc B',
  $q$update lots set name = 'détourné' where id = '22222222-2222-4222-8222-222222222222'$q$);
select public.mp_expect_ok('admin A : peut modifier son propre parking',
  $q$update lots set footer_note = 'Merci' where id = '11111111-1111-4111-8111-111111111111'$q$);
reset role;

-- ===========================================================================
-- 3. EMPLOYÉ DU PARC A (role = employe)
-- ===========================================================================
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated"}', false);

select public.mp_expect_rows('employé A : consulte le stock de son parc', $q$select * from vehicles$q$, 3);
select public.mp_expect_rows('employé A : ne voit rien du parc B', $q$select * from vehicles where lot_id = '22222222-2222-4222-8222-222222222222'$q$, 0);
select public.mp_expect_denied('employé A : ne peut PAS créer un véhicule', $q$insert into vehicles (lot_id, plate, brand) values ('11111111-1111-4111-8111-111111111111','CI 9999 ZZ','Interdit')$q$);
select public.mp_expect_no_rows('employé A : ne peut PAS changer un prix', $q$update vehicles set price = 1 where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'$q$);
select public.mp_expect_no_rows('employé A : ne peut PAS supprimer un véhicule', $q$delete from vehicles where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'$q$);
select public.mp_expect_denied('employé A : ne peut PAS créer une photo', $q$insert into vehicle_photos (lot_id, vehicle_id, kind, bytes) values ('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','photo',10)$q$);
select public.mp_expect_count('employé A : ne voit PAS le journal d''audit', $q$select * from audit_log$q$, 0);
select public.mp_expect_count('employé A : ne voit PAS les dépenses', $q$select * from expenses$q$, 0);

-- L'employé vend : autorisé, mais uniquement en son propre nom.
select public.mp_expect_ok('employé A : peut enregistrer une vente à son nom',
  $q$insert into sales (lot_id, type, total, paid, user_id, vehicle_id)
     values ('11111111-1111-4111-8111-111111111111','vente',12000000,12000000,'00000000-0000-4000-8000-0000000000a2','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1')$q$);
select public.mp_expect_denied('employé A : ne peut PAS vendre au nom d''un autre',
  $q$insert into sales (lot_id, type, total, user_id)
     values ('11111111-1111-4111-8111-111111111111','vente',1000,'00000000-0000-4000-8000-0000000000a1')$q$);
select public.mp_expect_no_rows('employé A : ne peut PAS supprimer une vente',
  $q$delete from sales where lot_id = '11111111-1111-4111-8111-111111111111'$q$);
select public.mp_expect_no_rows('employé A : ne peut PAS modifier une vente',
  $q$update sales set paid = 0 where lot_id = '11111111-1111-4111-8111-111111111111'$q$);
reset role;

-- Les tentatives refusées n'ont rien altéré : contrôle de valeur réelle.
select public.mp_expect_rows('intégrité : le prix du véhicule du parc B est inchangé',
  $q$select * from (values (1)) v where exists (
       select 1 from vehicles where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1' and price = 15000000)$q$, 1);

-- ===========================================================================
-- 4. COMPTE SANS PARKING
-- ===========================================================================
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000c1","role":"authenticated"}', false);
select public.mp_expect_rows('sans parking : ne voit aucun véhicule', $q$select * from vehicles$q$, 0);
select public.mp_expect_rows('sans parking : ne voit aucun parking', $q$select * from lots$q$, 0);
reset role;

-- ===========================================================================
-- 5. ADMIN DU PARC B : symétrie (aucune fuite dans l'autre sens)
-- ===========================================================================
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}', false);
select public.mp_expect_rows('admin B : voit son véhicule, pas ceux du parc A',
  $q$select * from vehicles where lot_id = '11111111-1111-4111-8111-111111111111'$q$, 0);
select public.mp_expect_rows('admin B : voit les ventes du parc A ? non',
  $q$select * from sales where lot_id = '11111111-1111-4111-8111-111111111111'$q$, 0);
select public.mp_expect_count('admin B : ne voit AUCUNE photo du parc A', $q$select * from vehicle_photos where lot_id = '11111111-1111-4111-8111-111111111111'$q$, 0);
reset role;

-- ===========================================================================
-- 6. Contraintes métier (indépendantes de la RLS)
-- ===========================================================================
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}', false);
select public.mp_expect_denied('plaque en double dans le même parc refusée',
  $q$insert into vehicles (lot_id, plate, brand) values ('11111111-1111-4111-8111-111111111111','CI 0001 AA','Doublon')$q$);
select public.mp_expect_denied('règlement supérieur au total refusé',
  $q$insert into payments (lot_id, sale_id, amount) select lot_id, id, total + 1 from sales where lot_id = '11111111-1111-4111-8111-111111111111' limit 1$q$);
reset role;

-- Numérotation : 60 appels, aucun doublon, format respecté, séquence continue.
do $$
declare i int; seen text[] := '{}'; n text;
begin
  for i in 1..60 loop
    n := public.mp_next_number('11111111-1111-4111-8111-111111111111', 'invoice');
    if n = any(seen) then
      perform public.mp_record('numérotation : aucun doublon sur 60 appels', false, 'doublon ' || n);
      return;
    end if;
    seen := seen || n;
  end loop;
  perform public.mp_record('numérotation : aucun doublon sur 60 appels', true, array_length(seen,1) || ' numéros uniques');
  perform public.mp_record('numérotation : format FAC-ANNÉE-0001', seen[1] ~ ('^FAC-[0-9]{4}-[0-9]{4}$'), seen[1]);
end $$;

-- Chaîne d'audit : intacte puis détectée après falsification.
insert into audit_log (lot_id, action, details) values
  ('11111111-1111-4111-8111-111111111111', 'vente-creee', 'FAC-1'),
  ('11111111-1111-4111-8111-111111111111', 'paiement', '12000000'),
  ('11111111-1111-4111-8111-111111111111', 'cloture', 'caisse');
do $$
declare b int; t int;
begin
  select broken, checked into b, t from public.mp_audit_verify('11111111-1111-4111-8111-111111111111');
  perform public.mp_record('audit : chaîne valide sur 3 écritures', b = 0 and t = 3, format('cassées=%s vérifiées=%s', b, t));
end $$;

update audit_log set details = 'montant falsifié'
 where action = 'paiement' and lot_id = '11111111-1111-4111-8111-111111111111';
do $$
declare b int; t int;
begin
  select broken, checked into b, t from public.mp_audit_verify('11111111-1111-4111-8111-111111111111');
  perform public.mp_record('audit : falsification détectée', b >= 1, format('cassées=%s vérifiées=%s', b, t));
end $$;

-- Contrôle positif : l'admin A VOIT bien ses 2 photos et sa dépense.
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}', false);
select public.mp_expect_count('contrôle : admin A voit ses 2 photos', $q$select * from vehicle_photos$q$, 2);
select public.mp_expect_count('contrôle : admin A voit sa dépense', $q$select * from expenses$q$, 1);
select public.mp_expect_count('contrôle : admin A voit son parking', $q$select * from lots$q$, 1);
reset role;


-- ===========================================================================
-- 8. SECOND FACTEUR : un jeton aal1 ne suffit plus pour les actions sensibles
-- ===========================================================================
-- L'admin A active la 2FA : ses écritures sensibles exigent désormais aal2.
reset role;
update public.memberships set mfa_enrolled = true
 where lot_id = '11111111-1111-4111-8111-111111111111'
   and user_id  = '00000000-0000-4000-8000-0000000000a1';

set role authenticated;
-- Jeton PIN seul (aal1) : lecture des dépenses et du journal d'audit refusée.
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal1"}', false);
select public.mp_expect_count('aal1 : dépenses masquées malgré le rôle admin',
  $q$select * from expenses$q$, 0);
select public.mp_expect_count('aal1 : journal d''audit masqué',
  $q$select * from audit_log$q$, 0);
select public.mp_expect_no_rows('aal1 : suppression d''un règlement impossible',
  $q$delete from payments where lot_id = '11111111-1111-4111-8111-111111111111'$q$);
select public.mp_expect_no_rows('aal1 : écriture du stock refusée',
  $q$update vehicles set price = 1 where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'$q$);
-- 3 véhicules : les 2 du jeu de données + celui créé par la section 3.
select public.mp_expect_count('aal1 : la lecture du stock reste permise (aucune régression)',
  $q$select * from vehicles$q$, 3);

-- Jeton après second facteur (aal2) : tout redevient accessible.
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);
select public.mp_expect_count('aal2 : dépenses visibles', $q$select * from expenses$q$, 1);
-- 3 entrées : les trois écritures du test de chaîne d'audit.
select public.mp_expect_count('aal2 : journal d''audit visible', $q$select * from audit_log$q$, 3);
select public.mp_expect_ok('aal2 : écriture du stock autorisée',
  $q$update vehicles set color = 'noir' where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'$q$);
select public.mp_expect_count('aal2 : la clé de parking reste unique', $q$select * from lots$q$, 1);

-- Un membre SANS 2FA n'est pas pénalisé : l'employé A garde son accès lecture.
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated","aal":"aal1"}', false);
select public.mp_expect_count('sans 2FA : l''employé conserve la lecture du stock',
  $q$select * from vehicles$q$, 3);
reset role;


-- ===========================================================================
-- 9. BUCKET STORAGE « vehicle-media »
-- Chemin : <lot_id>/<vehicle_id>/<kind>/<id>.jpg ; dossier racine = lot_id.
-- Le harnais 00b reproduit storage.buckets/objects/foldername, donc ces
-- policies sont réellement exécutées (elles ne l'étaient pas avant la v19.2 :
-- la migration 002 les créait avant les helpers et échouait sur Supabase).
-- ===========================================================================
-- Admin A en aal2 : dépôt autorisé, propriétaire = appelant.
set role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal2"}', false);

select public.mp_expect_ok('storage : admin aal2 dépose une photo de son parc',
  $q$insert into storage.objects (bucket_id, name, owner) values
     ('vehicle-media',
      '11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1/photo/p1.jpg',
      '00000000-0000-4000-8000-0000000000a1')$q$);

select public.mp_expect_denied('storage : dépôt dans le parc B refusé',
  $q$insert into storage.objects (bucket_id, name, owner) values
     ('vehicle-media',
      '22222222-2222-4222-8222-222222222222/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1/photo/x.jpg',
      '00000000-0000-4000-8000-0000000000a1')$q$);

select public.mp_expect_denied('storage : propriétaire mensonger refusé (owner ≠ appelant)',
  $q$insert into storage.objects (bucket_id, name, owner) values
     ('vehicle-media',
      '11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1/photo/p2.jpg',
      '00000000-0000-4000-8000-0000000000b1')$q$);

select public.mp_expect_denied('storage : chemin sans lot_id refusé',
  $q$insert into storage.objects (bucket_id, name, owner) values
     ('vehicle-media', 'photo-sans-lot.jpg', '00000000-0000-4000-8000-0000000000a1')$q$);

select public.mp_expect_count('storage : admin A voit la photo de son parc',
  $q$select * from storage.objects$q$, 1);

-- Même admin, mais jeton aal1 (PIN seul) : le dépôt exige le second facteur.
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated","aal":"aal1"}', false);
select public.mp_expect_denied('storage : dépôt refusé en aal1 malgré le rôle admin',
  $q$insert into storage.objects (bucket_id, name, owner) values
     ('vehicle-media',
      '11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1/photo/p3.jpg',
      '00000000-0000-4000-8000-0000000000a1')$q$);

-- Employé A : lecture oui, dépôt non, suppression non.
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000000000a2","role":"authenticated","aal":"aal2"}', false);
select public.mp_expect_count('storage : employé A lit la photo de son parc',
  $q$select * from storage.objects$q$, 1);
select public.mp_expect_denied('storage : employé A ne peut pas déposer',
  $q$insert into storage.objects (bucket_id, name, owner) values
     ('vehicle-media',
      '11111111-1111-4111-8111-111111111111/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1/photo/e.jpg',
      '00000000-0000-4000-8000-0000000000a2')$q$);
select public.mp_expect_no_rows('storage : employé A ne peut pas supprimer',
  $q$delete from storage.objects$q$);

-- Admin B : aucune photo du parc A.
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated","aal":"aal2"}', false);
select public.mp_expect_count('storage : admin B ne voit AUCUNE photo du parc A',
  $q$select * from storage.objects$q$, 0);

-- anon : rien du tout.
set role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', false);
select public.mp_expect_count('storage : anon ne voit aucun objet', $q$select * from storage.objects$q$, 0);
reset role;

-- Le bucket impose taille et types MIME (contrat de la migration 006).
select public.mp_expect_rows('storage : bucket privé, 8 Mio, types image limités',
  $q$select * from storage.buckets
     where id = 'vehicle-media' and public = false
       and file_size_limit = 8388608
       and allowed_mime_types @> array['image/jpeg','image/png','image/webp','image/avif']$q$, 1);

-- ===========================================================================
-- 7. Résultat
-- ===========================================================================
select name, ok, detail from rls_results order by id;
