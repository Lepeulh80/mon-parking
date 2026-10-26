-- Read-only live database views; no predictive AI, payroll or legal accounts.
create or replace view public.ops_occupancy as
select l.id as lot_id,
 (select count(*) from public.spots s where s.lot_id=l.id and s.status<>'hs') as capacity,
 (select count(*) from public.spots s where s.lot_id=l.id and s.status='occupe') as occupied,
 (select count(*) from public.spots s where s.lot_id=l.id and s.status='libre') as free
from public.lots l where public.ops_has_role(l.id,array['admin','responsable','caissier','agent','employe']);
create or replace view public.ops_kpis as
select o.*,
 case when o.capacity=0 then 0 else round(100.0*o.occupied/o.capacity,2) end as occupancy_pct,
 (select count(*) from public.parking_incidents i where i.lot_id=o.lot_id and i.status<>'resolu') as open_incidents,
 (select count(*) from public.staff_attendance a where a.lot_id=o.lot_id and a.out_at is null) as staff_present
from public.ops_occupancy o where public.ops_has_role(o.lot_id,array['admin','responsable']);
revoke all on public.ops_occupancy,public.ops_kpis from anon;
grant select on public.ops_occupancy,public.ops_kpis to authenticated;
