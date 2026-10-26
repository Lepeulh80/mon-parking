-- ============================================================================
-- MON PARKING · 004 — journal d'audit infalsifiable + numérotation atomique
-- ============================================================================

-- Chaîne de hachage : hash = sha256(prev_hash || id || action || details || at)
create or replace function mp_audit_seal() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, extensions as $$
declare prev text;
begin
  select a.hash into prev from public.audit_log a
   where a.lot_id = new.lot_id order by a.at desc, a.id desc limit 1;
  new.prev_hash := prev;
  new.hash := encode(digest(coalesce(prev,'') || new.id::text || new.action ||
                            coalesce(new.details,'') || new.at::text, 'sha256'), 'hex');
  return new;
end $$;

drop trigger if exists audit_seal on audit_log;
create trigger audit_seal before insert on audit_log
  for each row execute function mp_audit_seal();

-- Vérification : renvoie le nombre de lignes dont la chaîne ne se referme pas.
create or replace function mp_audit_verify(p_lot uuid) returns table (broken int, checked int)
language plpgsql stable security definer set search_path = pg_catalog, public, extensions as $$
declare r record; prev text := null; bad int := 0; total int := 0; expect text;
begin
  for r in select * from public.audit_log a where a.lot_id = p_lot order by a.at, a.id loop
    total := total + 1;
    expect := encode(digest(coalesce(prev,'') || r.id::text || r.action ||
                            coalesce(r.details,'') || r.at::text, 'sha256'), 'hex');
    if r.prev_hash is distinct from prev or r.hash <> expect then bad := bad + 1; end if;
    prev := r.hash;
  end loop;
  return query select bad, total;
end $$;

-- Numérotation de facture sans trou ni doublon, même sous concurrence :
-- update ... returning verrouille la ligne du parking pour la transaction.
create or replace function mp_next_number(p_lot uuid, p_kind text) returns text
language plpgsql security definer set search_path = pg_catalog, public as $$
declare n int; prefix text;
begin
  if p_kind = 'invoice' then
    update public.lots set invoice_next = invoice_next + 1
     where id = p_lot returning invoice_next - 1, invoice_prefix into n, prefix;
  elsif p_kind = 'receipt' then
    update public.lots set receipt_next = receipt_next + 1
     where id = p_lot returning receipt_next - 1, receipt_prefix into n, prefix;
  else
    raise exception 'Type de numéro inconnu : %', p_kind using errcode = '22023';
  end if;
  if n is null then raise exception 'Parking introuvable' using errcode = 'P0002'; end if;
  return prefix || '-' || extract(year from now())::int || '-' || lpad(n::text, 4, '0');
end $$;

-- Cohérence d'un paiement : le cumul ne peut pas dépasser le total de la vente.
create or replace function mp_check_payment_total() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
declare cap numeric; sum_paid numeric; sale_total numeric;
begin
  select total into sale_total from public.sales where id = new.sale_id;
  select coalesce(sum(amount),0) into sum_paid from public.payments where sale_id = new.sale_id;
  cap := coalesce(sale_total,0);
  if sum_paid + new.amount > cap then
    raise exception 'Le règlement dépasse le solde restant (reste %)', cap - sum_paid
      using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists payments_within_total on payments;
create trigger payments_within_total before insert on payments
  for each row execute function mp_check_payment_total();
