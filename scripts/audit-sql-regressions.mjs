import {PGlite} from '@electric-sql/pglite'
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
const pg=new PGlite(),L='11111111-1111-4111-8111-111111111111',U='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',report=[],before=process.env.AUDIT_PHASE==='before'
await pg.exec(`create role authenticated;create role anon;create schema auth;create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;create function auth.jwt() returns jsonb language sql stable as $$select jsonb_build_object('aal',coalesce(nullif(current_setting('request.jwt.aal',true),''),'aal1'))$$;grant usage on schema public,auth to authenticated,anon;grant execute on all functions in schema auth to authenticated,anon;`)
// gen_random_uuid is core here. Only the embedded runtime omits CREATE EXTENSION.
await pg.exec((await fs.readFile('supabase_schema.sql','utf8')).replace(/create extension if not exists ["\u0027]?pgcrypto["\u0027]?\s*;/i,''))
await pg.exec(await fs.readFile('supabase_ocr_feedback.sql','utf8'))
for(const file of (await fs.readdir('migrations')).filter(f=>f.endsWith('.sql')&&(!before||!f.startsWith('011_'))).sort())await pg.exec(await fs.readFile(`migrations/${file}`,'utf8'))
await pg.exec(`grant select,insert,update,delete on all tables in schema public to authenticated;revoke insert,update,delete on public.v10_encrypted_snapshots from authenticated;insert into auth.users values('${U}');insert into lots(id,name,owner_id) values('${L}','Audit SQL','${U}');insert into memberships(lot_id,user_id,role,active,username) values('${L}','${U}','admin',true,'audit-admin');set role authenticated;select set_config('request.jwt.claim.sub','${U}',false);select set_config('request.jwt.aal','aal2',false);`)
async function test(id,file,cause,fn){try{await fn();report.push({id,file,cause,pass:true});console.log('PASS',id)}catch(e){report.push({id,file,cause,pass:false,error:e.message});console.log('FAIL',id,e.message)}}
await test('B16','migrations/010_12_personal_preferences_vault.sql:28','Enveloppe acceptée sans nonce, sel ni ciphertext',async()=>{
 assert.equal((await pg.query('select public.ops_has_role($1,array[\'admin\']) as allowed',[L])).rows[0].allowed,true)
 await assert.rejects(()=>pg.query('select public.v10_store_encrypted_snapshot($1,$2)',[L,JSON.stringify({algorithm:'AES-256-GCM',kdf:'PBKDF2-SHA256',iterations:310000})]),/INVALID_ENCRYPTED_ENVELOPE/)
})
if(!before)await test('SQL_VALID_VAULT','migrations/011_13_audit_integrity.sql','Enveloppe complète autorisée ; MFA et isolation inchangés',async()=>{
 const env={version:1,algorithm:'AES-256-GCM',kdf:'PBKDF2-SHA256',iterations:310000,salt:Buffer.alloc(16).toString('base64'),iv:Buffer.alloc(12).toString('base64'),ciphertext:Buffer.alloc(32).toString('base64')}
 await pg.query('select public.v10_store_encrypted_snapshot($1,$2)',[L,JSON.stringify(env)])
 await pg.exec("select set_config('request.jwt.aal','aal1',false)")
 await assert.rejects(()=>pg.query('select public.v10_store_encrypted_snapshot($1,$2)',[L,JSON.stringify(env)]),/MFA_AAL2_REQUIRED/)
 await pg.exec("select set_config('request.jwt.aal','aal2',false)")
 await assert.rejects(()=>pg.query('select public.v10_store_encrypted_snapshot($1,$2)',['22222222-2222-4222-8222-222222222222',JSON.stringify(env)]),/FORBIDDEN/)
})
await test('B15','supabase_schema.sql:108-129','Helpers invoker relisant memberships protégée par ces mêmes helpers',async()=>{const result=await pg.query('select * from memberships');assert.equal(result.rows.length,1);const lots=await pg.query('select * from lots');assert.equal(lots.rows.length,1)})
if(!before)await test('SQL_NO_CROSS_LOT','migrations/011_13_audit_integrity.sql','Accès anonyme et autre parking refusés',async()=>{
 assert.equal((await pg.query('select public.is_member($1) as allowed',['22222222-2222-4222-8222-222222222222'])).rows[0].allowed,false)
 await pg.exec('reset role;set role anon');await assert.rejects(()=>pg.query('select public.is_member($1)',[L]),/permission denied/)
})
await pg.close();await fs.mkdir('audit-evidence',{recursive:true});await fs.writeFile(before?'audit-evidence/sql-before.json':'audit-evidence/sql-after.json',JSON.stringify(report,null,2));console.log('SQL AUDIT',report.filter(r=>r.pass).length,'/',report.length);process.exit(report.some(r=>!r.pass)?1:0)
