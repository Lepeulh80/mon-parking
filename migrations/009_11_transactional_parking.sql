-- v9 transactional parking namespace. Does not overwrite historical v8 tables.
create table public.pro_slots(lot_id uuid references public.lots(id), code text not null, kind text not null default 'standard', status text not null default 'libre' check(status in('libre','occupe','hs','reserve')), primary key(lot_id,code));
create table public.pro_rates(lot_id uuid references public.lots(id), id text, fees jsonb not null, active boolean not null default true, primary key(lot_id,id));
create table public.pro_passes(lot_id uuid references public.lots(id), id text, plate_key text not null, start_at timestamptz not null,end_at timestamptz not null,status text not null,primary key(lot_id,id));
create table public.pro_tickets(id uuid primary key,lot_id uuid not null references public.lots(id),slot_code text not null,plate_key text not null,status text not null check(status in('ouvert','cloture','annule')),version int not null default 1,state jsonb not null,updated_at timestamptz not null default clock_timestamp(),foreign key(lot_id,slot_code) references public.pro_slots(lot_id,code));
create unique index pro_one_ticket_slot on public.pro_tickets(lot_id,slot_code) where status='ouvert';
create unique index pro_one_ticket_plate on public.pro_tickets(lot_id,plate_key) where status='ouvert';
create table public.pro_cash(id text primary key,lot_id uuid not null references public.lots(id),operator_id uuid not null,opening numeric not null check(opening>=0),status text not null check(status in('ouverte','cloturee')),state jsonb not null,updated_at timestamptz not null default clock_timestamp());
create unique index pro_one_cash_operator on public.pro_cash(lot_id,operator_id) where status='ouverte';
create table public.pro_receipts(id uuid primary key default gen_random_uuid(),lot_id uuid not null references public.lots(id),ticket_id uuid unique not null references public.pro_tickets(id),session_id text not null references public.pro_cash(id),operator_id uuid not null,amount numeric not null check(amount>=0),method text not null,at timestamptz not null default clock_timestamp());
create table public.pro_sync_events(id uuid primary key,lot_id uuid not null references public.lots(id),actor_id uuid not null,kind text not null,result jsonb not null,at timestamptz not null default clock_timestamp());
create table public.pro_plate_corrections(id uuid primary key,lot_id uuid not null references public.lots(id),ticket_id uuid not null references public.pro_tickets(id),actor_id uuid not null,before_plate text not null,after_plate text not null,reason text not null,version int not null,at timestamptz not null default clock_timestamp());
-- All writes flow through RPCs; no direct anonymous or authenticated mutations.
do $$declare t text;begin foreach t in array array['pro_slots','pro_rates','pro_passes','pro_tickets','pro_cash','pro_receipts','pro_sync_events','pro_plate_corrections'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from anon,authenticated',t);
 execute format('grant select on public.%I to authenticated',t);
 execute format('create policy %I on public.%I for select to authenticated using(public.ops_has_role(lot_id,array[''admin'',''responsable'',''caissier'',''agent'',''employe'']))',t||'_read',t);
end loop;end;$$;
create or replace function public.pro_append_only() returns trigger language plpgsql set search_path='' as $$begin raise exception 'APPEND_ONLY';end;$$;
create trigger pro_events_immutable before update or delete on public.pro_sync_events for each row execute function public.pro_append_only();
create trigger pro_corrections_immutable before update or delete on public.pro_plate_corrections for each row execute function public.pro_append_only();
create trigger pro_receipts_immutable before update or delete on public.pro_receipts for each row execute function public.pro_append_only();
create or replace function public.pro_configure(p_lot uuid,p_fees jsonb,p_slots jsonb,p_rates jsonb default '[]',p_passes jsonb default '[]') returns jsonb language plpgsql security definer set search_path='' as $$
declare s jsonb;begin
 if not public.ops_has_role(p_lot,array['admin','responsable']) then raise exception 'FORBIDDEN';end if;
 perform public.pro_fee(now(),now(),p_fees,false,false);
 insert into public.pro_parking_settings(lot_id,fees) values(p_lot,p_fees) on conflict(lot_id) do update set fees=excluded.fees,updated_at=now();
 for s in select * from jsonb_array_elements(p_slots) loop
 insert into public.pro_slots(lot_id,code,kind,status) values(p_lot,s->>'code',coalesce(s->>'type','standard'),case when s->>'status'='hs' then 'hs' else 'libre' end) on conflict(lot_id,code) do nothing;
 end loop;
 for s in select * from jsonb_array_elements(p_rates) loop
 perform public.pro_fee(now(),now(),s,false,false);
 insert into public.pro_rates(lot_id,id,fees,active) values(p_lot,s->>'id',s,coalesce((s->>'active')::boolean,true)) on conflict(lot_id,id) do update set fees=excluded.fees,active=excluded.active;
 end loop;
 for s in select * from jsonb_array_elements(p_passes) loop
 insert into public.pro_passes(lot_id,id,plate_key,start_at,end_at,status) values(p_lot,s->>'id',s->>'plateKey',(s->>'startAt')::timestamptz,(s->>'endAt')::timestamptz,s->>'status') on conflict(lot_id,id) do update set start_at=excluded.start_at,end_at=excluded.end_at,status=excluded.status,plate_key=excluded.plate_key;
 end loop;
 insert into public.ops_audit(lot_id,actor_id,action,target,after_data) values(p_lot,auth.uid(),'pro-configure',p_lot::text,p_fees);
 return jsonb_build_object('configured',true);
end;$$;
create or replace function public.pro_apply_event(p_lot uuid,p_event jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare eid uuid:=(p_event->>'id')::uuid; kind text:=p_event->>'kind'; p jsonb:=p_event->'payload'; who uuid:=auth.uid(); existing public.pro_sync_events; t public.pro_tickets; c public.pro_cash; sl public.pro_slots; fees jsonb; state jsonb; result jsonb; charge jsonb; key text; plate text; ref text; amount numeric; expected numeric; counted numeric; delta numeric; ticket_id uuid; entry_time timestamptz; exit_time timestamptz; subscriber boolean; is_manager boolean; before_state jsonb;
begin
 if not public.ops_has_role(p_lot,array['admin','responsable','caissier','agent','employe']) then raise exception 'FORBIDDEN';end if;
 -- One advisory key per event, so even simultaneous retries execute once.
 perform pg_advisory_xact_lock(hashtextextended(eid::text,0));
 select * into existing from public.pro_sync_events where id=eid;
 if found then if existing.lot_id<>p_lot or existing.actor_id<>who then raise exception 'EVENT_OWNER_MISMATCH';end if;return existing.result;end if;
 is_manager:=public.ops_has_role(p_lot,array['admin','responsable']);
 if kind='entry' then
  if not public.ops_has_role(p_lot,array['admin','responsable','caissier','agent']) then raise exception 'FORBIDDEN';end if;
  select * into sl from public.pro_slots where lot_id=p_lot and code=p->>'spotCode' for update;
  if not found or sl.status<>'libre' then raise exception 'SLOT_UNAVAILABLE';end if;
  plate:=upper(trim(p->>'plate'));key:=regexp_replace(plate,'[^A-Z0-9]','','g');
  if length(key)<4 then raise exception 'INVALID_PLATE';end if;
  select s.fees into fees from public.pro_parking_settings s where s.lot_id=p_lot;
  if fees is null then raise exception 'CONFIGURATION_REQUIRED';end if;
  if nullif(p->>'ratePlanId','') is not null then
   select r.fees into fees from public.pro_rates r where r.lot_id=p_lot and r.id=p->>'ratePlanId' and r.active;
   if fees is null or (coalesce(fees->>'spotType','')<>'' and fees->>'spotType'<>sl.kind) then raise exception 'RATE_UNAVAILABLE';end if;
  end if;
  ticket_id:=(p->>'id')::uuid;entry_time:=(p->>'entryAt')::timestamptz;
  if entry_time>clock_timestamp()+interval '1 minute' or entry_time<clock_timestamp()-interval '7 days' then raise exception 'INVALID_ENTRY_TIME';end if;
  ref:='TCK-'||upper(left(replace(ticket_id::text,'-',''),16));
  state:=p||fees||jsonb_build_object('id',ticket_id,'ref',ref,'plate',plate,'entryAt',entry_time,'spotType',sl.kind,'status','ouvert','version',1,'userId',who,'amount',0,'cloudConfirmed',true);
  insert into public.pro_tickets(id,lot_id,slot_code,plate_key,status,state) values(ticket_id,p_lot,sl.code,key,'ouvert',state);
  update public.pro_slots set status='occupe' where lot_id=p_lot and code=sl.code;
  result:=jsonb_build_object('ticket',state);
 elsif kind in('correction','lost','exit','cancel') then
  select * into t from public.pro_tickets where id=(p->>'ticketId')::uuid and lot_id=p_lot for update;
  if not found or t.status<>'ouvert' then raise exception 'TICKET_NOT_OPEN';end if;
  if p->>'expectedVersion' is null or t.version<>(p->>'expectedVersion')::int then raise exception 'VERSION_CONFLICT current=%',t.version;end if;
  state:=t.state;before_state:=state;ticket_id:=t.id;
  if kind in('correction','lost','cancel') and not is_manager then raise exception 'FORBIDDEN';end if;
  if kind in('correction','lost','cancel') and length(trim(coalesce(p->>'reason','')))<3 then raise exception 'REASON_REQUIRED';end if;
  if kind='correction' then
   plate:=upper(trim(p->>'plate')); key:=regexp_replace(plate,'[^A-Z0-9]','','g'); if length(key)<4 then raise exception 'INVALID_PLATE';end if;
   insert into public.pro_plate_corrections(id,lot_id,ticket_id,actor_id,before_plate,after_plate,reason,version) values(eid,p_lot,t.id,who,state->>'plate',plate,p->>'reason',t.version+1);
   state:=state||jsonb_build_object('plate',plate,'correctionReason',p->>'reason');
   update public.pro_tickets set plate_key=key where id=t.id;
  elsif kind='lost' then state:=state||jsonb_build_object('lostTicket',true,'lostTicketReason',p->>'reason','lostTicketAt',clock_timestamp());
  elsif kind='cancel' then
   state:=state||jsonb_build_object('status','annule','exitAt',clock_timestamp(),'amount',0,'cancellationReason',p->>'reason');
   update public.pro_slots set status='libre' where lot_id=p_lot and code=t.slot_code;
  else
   if not public.ops_has_role(p_lot,array['admin','responsable','caissier']) then raise exception 'FORBIDDEN';end if;
   exit_time:=(p->>'exitAt')::timestamptz;
   if exit_time>clock_timestamp()+interval '1 minute' or exit_time<(state->>'entryAt')::timestamptz then raise exception 'INVALID_EXIT_TIME';end if;
   subscriber:=exists(select 1 from public.pro_passes b where b.lot_id=p_lot and b.plate_key=t.plate_key and b.status='actif' and b.start_at<=(state->>'entryAt')::timestamptz and b.end_at>=exit_time);
   charge:=public.pro_fee((state->>'entryAt')::timestamptz,exit_time,state,coalesce((state->>'lostTicket')::boolean,false),subscriber);
   expected:=(charge->>'amount')::numeric;amount:=coalesce((p->>'amount')::numeric,expected);
   if amount<0 or amount::text in ('NaN','Infinity','-Infinity') then raise exception 'INVALID_AMOUNT';end if;
   if amount<>expected and (not is_manager or length(trim(coalesce(p->>'reason','')))<3) then raise exception 'ADJUSTMENT_FORBIDDEN';end if;
   if coalesce(p->>'paymentMethod','') not in('espèces','mobile money','carte bancaire','virement','abonnement') or (p->>'paymentMethod'='abonnement' and (not subscriber or amount>0)) then raise exception 'INVALID_METHOD';end if;
   select * into c from public.pro_cash where lot_id=p_lot and operator_id=who and status='ouverte' for update;
   if amount>0 and not found then raise exception 'CASH_SESSION_REQUIRED';end if;
   if amount>0 then insert into public.pro_receipts(lot_id,ticket_id,session_id,operator_id,amount,method) values(p_lot,t.id,c.id,who,amount,p->>'paymentMethod');end if;
   state:=state||charge||jsonb_build_object('status','cloture','exitAt',exit_time,'amount',amount,'expectedAmount',expected,'paymentMethod',p->>'paymentMethod','cashSessionId',case when amount>0 then c.id else null end,'closedById',who,'subscriptionCovered',subscriber,'adjustmentReason',p->>'reason');
   update public.pro_slots set status='libre' where lot_id=p_lot and code=t.slot_code;
  end if;
  state:=state||jsonb_build_object('version',t.version+1);
  update public.pro_tickets set state=state,version=t.version+1,status=state->>'status',updated_at=clock_timestamp() where id=t.id;
  result:=jsonb_build_object('ticket',state);
 elsif kind='cash_open' then
  if not public.ops_has_role(p_lot,array['admin','responsable','caissier','employe']) then raise exception 'FORBIDDEN';end if;
  amount:=(p->>'openingFloat')::numeric;if amount is null or amount<0 or amount::text in ('NaN','Infinity','-Infinity') then raise exception 'INVALID_AMOUNT';end if;
  state:=p||jsonb_build_object('userId',who,'status','ouverte','openedAt',clock_timestamp(),'openingFloat',amount,'expected',amount);
  insert into public.pro_cash(id,lot_id,operator_id,opening,status,state) values(p->>'id',p_lot,who,amount,'ouverte',state);
  result:=jsonb_build_object('cash',state);
 elsif kind='cash_close' then
  select * into c from public.pro_cash where id=p->>'sessionId' and lot_id=p_lot and operator_id=who for update;
  if not found or c.status<>'ouverte' then raise exception 'CASH_NOT_OPEN';end if;
  select c.opening+coalesce(sum(r.amount) filter(where r.method='espèces'),0) into expected from public.pro_receipts r where r.session_id=c.id;
  counted:=(p->>'counted')::numeric;if counted is null or counted<0 or counted::text in ('NaN','Infinity','-Infinity') then raise exception 'INVALID_AMOUNT';end if;
  delta:=round(counted-expected,2);if delta<>0 and length(trim(coalesce(p->>'reason','')))<3 then raise exception 'VARIANCE_REASON_REQUIRED';end if;
  state:=c.state||jsonb_build_object('status','cloturee','expected',expected,'counted',counted,'variance',delta,'reason',p->>'reason','closedAt',clock_timestamp());
  update public.pro_cash set state=state,status='cloturee',updated_at=clock_timestamp() where id=c.id;
  result:=jsonb_build_object('cash',state);
 else raise exception 'UNKNOWN_EVENT';end if;
 insert into public.pro_sync_events(id,lot_id,actor_id,kind,result) values(eid,p_lot,who,kind,result);
 insert into public.ops_audit(lot_id,actor_id,action,target,before_data,after_data) values(p_lot,who,'pro-'||kind,coalesce(ticket_id::text,p->>'id',p->>'sessionId'),before_state,result);
 return result;
end;$$;
-- Avoid PL/pgSQL column/variable ambiguity in UPDATE statements above.
-- The function-local directive explicitly selects variables on ambiguous RHS.
create or replace function public.pro_snapshot(p_lot uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not public.ops_has_role(p_lot,array['admin','responsable','caissier','agent','employe']) then raise exception 'FORBIDDEN';end if;
 return jsonb_build_object('serverAt',clock_timestamp(),'tickets',coalesce((select jsonb_agg(state) from public.pro_tickets where lot_id=p_lot),'[]'::jsonb),'slots',coalesce((select jsonb_agg(to_jsonb(s)) from public.pro_slots s where lot_id=p_lot),'[]'::jsonb),'cash',coalesce((select jsonb_agg(state||jsonb_build_object('expected',opening+coalesce((select sum(r.amount) from public.pro_receipts r where r.session_id=pro_cash.id and r.method='espèces'),0))) from public.pro_cash where lot_id=p_lot and (operator_id=auth.uid() or public.ops_has_role(p_lot,array['admin','responsable']))),'[]'::jsonb),'corrections',coalesce((select jsonb_agg(to_jsonb(c)) from public.pro_plate_corrections c where lot_id=p_lot),'[]'::jsonb));
end;$$;
revoke all on function public.pro_configure(uuid,jsonb,jsonb,jsonb,jsonb),public.pro_apply_event(uuid,jsonb),public.pro_snapshot(uuid) from public,anon;
grant execute on function public.pro_configure(uuid,jsonb,jsonb,jsonb,jsonb),public.pro_apply_event(uuid,jsonb),public.pro_snapshot(uuid) to authenticated;

-- Restrict financial information separately from operational ticket visibility.
drop policy pro_cash_read on public.pro_cash;
create policy pro_cash_read on public.pro_cash for select to authenticated using(public.ops_has_role(lot_id,array['admin','responsable']) or (operator_id=auth.uid() and public.ops_has_role(lot_id,array['caissier','employe'])));
drop policy pro_receipts_read on public.pro_receipts;
create policy pro_receipts_read on public.pro_receipts for select to authenticated using(public.ops_has_role(lot_id,array['admin','responsable']) or (operator_id=auth.uid() and public.ops_has_role(lot_id,array['caissier'])));
drop policy pro_sync_events_read on public.pro_sync_events;
create policy pro_sync_events_read on public.pro_sync_events for select to authenticated using(actor_id=auth.uid() or public.ops_has_role(lot_id,array['admin','responsable']));
