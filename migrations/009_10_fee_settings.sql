-- v9, AFTER the nine 008 migrations. Old migrations remain unchanged.
create table if not exists public.pro_parking_settings (
 lot_id uuid primary key references public.lots(id),
 fees jsonb not null default '{"billingMode":"hourly","hourlyRate":500,"dailyRate":6000,"dailyCap":6000,"graceMinutes":15,"lostTicketFee":0,"maxStayHours":24,"overstayHourlyRate":0}',
 updated_at timestamptz not null default now()
);
alter table public.pro_parking_settings enable row level security;
revoke all on public.pro_parking_settings from anon,authenticated;
grant select on public.pro_parking_settings to authenticated;
create policy pro_settings_read on public.pro_parking_settings for select to authenticated using(public.ops_has_role(lot_id,array['admin','responsable','caissier','agent','employe']));
-- Shared, deterministic fee formula; 24h elapsed blocks, never calendar days.
create or replace function public.pro_fee(p_entry timestamptz,p_exit timestamptz,p jsonb,p_lost boolean default false,p_subscriber boolean default false)
returns jsonb language plpgsql immutable set search_path='' as $$
declare mins int; bill int; hrs int; days int; remainder int; base numeric; cap numeric:=coalesce((p->>'dailyCap')::numeric,6000); hourly numeric:=coalesce((p->>'hourlyRate')::numeric,500); daily numeric:=coalesce((p->>'dailyRate')::numeric,6000); grace int:=coalesce((p->>'graceMinutes')::int,15); maximum numeric:=coalesce((p->>'maxStayHours')::numeric,24); extra numeric:=coalesce((p->>'overstayHourlyRate')::numeric,0); lost numeric:=coalesce((p->>'lostTicketFee')::numeric,0); overdue int; surcharge numeric; penalty numeric;
begin
 if p_exit<p_entry or p_entry is null or p_exit is null or least(cap,hourly,daily,grace,extra,lost)<0 or maximum<=0 or grace>1440 or coalesce(p->>'billingMode','hourly') not in ('hourly','daily') then raise exception 'INVALID_FEES_OR_DATES'; end if;
 mins:=ceil(extract(epoch from(p_exit-p_entry))/60); bill:=greatest(0,mins-grace); days:=floor(bill/1440.0); remainder:=bill-days*1440; hrs:=days*24+ceil(remainder/60.0);
 if coalesce(p->>'billingMode','hourly')='daily' then base:=ceil(bill/1440.0)*(case when cap>0 then least(daily,cap) else daily end);
 else base:=days*(case when cap>0 then least(hourly*24,cap) else hourly*24 end)+(case when cap>0 then least(ceil(remainder/60.0)*hourly,cap) else ceil(remainder/60.0)*hourly end); end if;
 overdue:=ceil(greatest(0,mins-maximum*60)/60.0); surcharge:=case when p_subscriber then 0 else overdue*extra end; penalty:=case when p_lost then lost else 0 end;
 if p_subscriber then base:=0; end if;
 return jsonb_build_object('minutes',mins,'hours',hrs,'days',ceil(bill/1440.0),'baseAmount',round(base,2),'overstayFee',round(surcharge,2),'lostFee',round(penalty,2),'overdueHours',overdue,'amount',round(base+surcharge+penalty,2));
end;$$;
revoke all on function public.pro_fee(timestamptz,timestamptz,jsonb,boolean,boolean) from public,anon;
grant execute on function public.pro_fee(timestamptz,timestamptz,jsonb,boolean,boolean) to authenticated;
