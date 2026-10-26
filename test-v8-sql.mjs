import { PGlite } from '@electric-sql/pglite'
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
const pg = new PGlite()
let passed = 0
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', G = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const L = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222'
await pg.exec(`create role authenticated; create role anon; create schema auth;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
grant usage on schema public,auth to authenticated,anon; grant execute on function auth.uid() to authenticated,anon;
create table public.lots(id uuid primary key);
create table public.memberships(id uuid primary key default gen_random_uuid(), user_id uuid, lot_id uuid, active bool default true, role text constraint memberships_role_check check(role in('admin','employe')));
create table public.spots(id uuid primary key default gen_random_uuid(),lot_id uuid,status text);
insert into lots values('${L}'),('${OTHER}');
insert into memberships(user_id,lot_id,role) values('${A}','${L}','admin'),('${C}','${L}','employe'),('${G}','${L}','employe');
insert into spots(lot_id,status) values('${L}','libre'),('${L}','occupe'),('${L}','hs');`)
const files = (await fs.readdir('./migrations')).filter((f) => f.startsWith('008_')).sort()
for (const file of files) { await pg.exec(await fs.readFile(`./migrations/${file}`,'utf8')); console.log('OK migration SQL', file); passed++ }
await pg.exec(`update memberships set role='caissier' where user_id='${C}';update memberships set role='agent' where user_id='${G}';`)
const login = async (uid, role='authenticated') => { await pg.exec('reset role'); await pg.exec(`set role ${role};select set_config('request.jwt.claim.sub','${uid}',false);`) }
const deny = async (sql) => { let denied=false; try { await pg.exec(sql) } catch(e) { denied=true } assert(denied,'SQL unexpectedly authorized'); passed++ }
await login(A)
await pg.exec(`insert into staff_shifts(lot_id,user_id,employee_auth_id,start_at,end_at) values('${L}','G','${G}',now(),now()+interval '8 hours');`)
assert.equal((await pg.query('select count(*)::int n from staff_shifts')).rows[0].n,1); passed++
console.log('OK planning SQL créé par admin et audité')
assert.equal((await pg.query('select count(*)::int n from ops_audit')).rows[0].n,1); passed++
await deny(`insert into staff_shifts(lot_id,user_id,employee_auth_id,start_at,end_at) values('${OTHER}','G','${G}',now(),now()+interval '8 hours')`)
await deny(`update ops_audit set action='effacement'`)
await deny(`delete from ops_audit`)
await pg.exec(`insert into parking_rate_plans(lot_id,name,hourly_rate,daily_cap) values('${L}','Standard',500,6000);`)
await deny(`insert into parking_rate_plans(lot_id,name,hourly_rate) values('${L}','Invalide',-1)`)
assert.equal(Number((await pg.query('select occupancy_pct from ops_kpis')).rows[0].occupancy_pct),50); passed++
console.log('OK occupation SQL : 50 %, places hors service exclues')
await login(G)
assert.equal((await pg.query('select count(*)::int n from staff_shifts')).rows[0].n,1); passed++
await deny(`insert into staff_shifts(lot_id,user_id,employee_auth_id,start_at,end_at) values('${L}','G','${G}',now(),now()+interval '8 hours')`)
await deny(`insert into parking_rate_plans(lot_id,name,hourly_rate) values('${L}','Fraude',0)`)
assert.equal((await pg.query('select count(*)::int n from ops_audit')).rows[0].n,0); passed++
await pg.exec(`insert into staff_attendance(lot_id,user_id,in_at) values('${L}','G',now());`)
await deny(`insert into staff_attendance(lot_id,user_id,in_at) values('${L}','G',now())`)
await pg.exec(`insert into parking_incidents(lot_id,title,description,severity) values('${L}','Rayure','Constat','haute');`)
await deny(`insert into parking_incidents(lot_id,title,description,severity) values('${OTHER}','Fraude','Test','haute')`)
console.log('OK agent : pointage et incident permis, planning/tarifs/inter-parking refusés')
await login(C)
assert.equal((await pg.query('select count(*)::int n from staff_attendance')).rows[0].n,0); passed++
await pg.exec(`insert into cash_sessions(lot_id,user_id,opening_float) values('${L}','C',1000);`)
await deny(`insert into cash_sessions(lot_id,user_id,opening_float) values('${L}','C',1000)`)
await pg.exec(`insert into parking_passes(lot_id,holder,plate,plate_key,start_at,end_at,amount) values('${L}','Client','CI 1234 AB','CI1234AB',now(),now()+interval '30 days',1000);`)
await deny(`insert into cash_movements(lot_id,session_id,kind,amount,method) select lot_id,id,'recette',10,'espèces' from cash_sessions limit 1`)
await login('', 'anon')
for (const t of ['staff_shifts','staff_attendance','cash_sessions','parking_incidents','parking_rate_plans','parking_passes','ops_audit']) await deny(`select * from ${t}`)
console.log('OK clé publique sans session : aucune table sensible accessible')
console.log(`RÉSULTAT SQL V8 : ${passed} vérifications réussies`)
await pg.close()
