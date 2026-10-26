-- ============================================================================
-- MON PARKING · 001 — schéma de base (PostgreSQL / Supabase)
-- Exécutable sur Supabase (auth.users existe) et sur PostgreSQL nu (voir
-- supabase/tests/00_auth_stub.sql pour le harnais local).
-- Montants en numeric, identifiants en uuid, suppression en cascade par parking.
-- ============================================================================
create extension if not exists "pgcrypto";

create table if not exists lots (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text,
  logo text,
  address text, city text, phone text, email text, tax_id text,
  currency text not null default 'XOF',
  vat_rate numeric not null default 18 check (vat_rate >= 0 and vat_rate <= 100),
  invoice_prefix text not null default 'FAC',
  receipt_prefix text not null default 'REC',
  invoice_next int not null default 1 check (invoice_next > 0),
  receipt_next int not null default 1 check (receipt_next > 0),
  tagline text, footer_note text,
  hourly_rate numeric not null default 500 check (hourly_rate >= 0),
  daily_cap numeric not null default 6000 check (daily_cap >= 0),
  grace_minutes int not null default 15 check (grace_minutes between 0 and 240),
  owner_id uuid not null references auth.users(id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists memberships (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references lots(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'employe'
    check (role in ('admin','responsable','caissier','agent','employe')),
  username text not null,
  display_name text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, lot_id)
);
create index if not exists memberships_lot on memberships (lot_id, active);
create index if not exists memberships_user on memberships (user_id, active);

create table if not exists vehicles (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references lots(id) on delete cascade,
  plate text not null,
  brand text, model text, year int check (year is null or year between 1900 and 2100),
  vin text,
  mileage int not null default 0 check (mileage >= 0),
  fuel text, gearbox text, color text, category text, condition text,
  purchase_price numeric not null default 0 check (purchase_price >= 0),
  price numeric not null default 0 check (price >= 0),
  rent_price_daily numeric not null default 0 check (rent_price_daily >= 0),
  status text not null default 'stock'
    check (status in ('stock','vendu','loue','reserve','maintenance')),
  photo text, supplier text, acquisition_date date, description text,
  photo_count int not null default 0 check (photo_count >= 0),
  frame_count int not null default 0 check (frame_count >= 0),
  media_updated_at timestamptz,
  sold_at timestamptz, sold_price numeric,
  created_at timestamptz not null default now(),
  -- Une plaque ne peut pas exister deux fois dans le même parking.
  unique (lot_id, plate)
);
create index if not exists vehicles_lot_status on vehicles (lot_id, status);
create index if not exists vehicles_lot_plate on vehicles (lot_id, lower(plate));

create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references lots(id) on delete cascade,
  name text not null, type text not null default 'particulier',
  phone text, email text, address text, tax_id text,
  created_at timestamptz not null default now()
);
create index if not exists clients_lot on clients (lot_id, name);

create table if not exists sales (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references lots(id) on delete cascade,
  ref text,
  type text not null check (type in ('vente','location')),
  status text not null default 'impayee' check (status in ('payee','partielle','impayee')),
  -- RESTRICT : on n'efface pas un véhicule qui porte une vente.
  vehicle_id uuid references vehicles(id) on delete restrict,
  vehicle_snapshot jsonb, client_id uuid references clients(id) on delete restrict,
  client_snapshot jsonb, user_id uuid, user_name text,
  date timestamptz not null default now(),
  price numeric not null default 0 check (price >= 0),
  discount numeric not null default 0 check (discount >= 0),
  vat_rate numeric not null default 0 check (vat_rate >= 0),
  subtotal numeric not null default 0, vat_amount numeric not null default 0,
  total numeric not null default 0 check (total >= 0),
  paid numeric not null default 0 check (paid >= 0),
  payment_method text, due_date timestamptz,
  invoice_number text, receipt_number text, notes text,
  rental_start timestamptz, rental_end timestamptz, rental_days int not null default 0,
  deposit numeric not null default 0 check (deposit >= 0),
  returned_at timestamptz, extra_fees numeric not null default 0 check (extra_fees >= 0),
  created_at timestamptz not null default now(),
  -- Un règlement ne peut pas dépasser le total facturé.
  constraint sales_paid_le_total check (paid <= total)
);
create index if not exists sales_lot_date on sales (lot_id, date desc);
create index if not exists sales_lot_type on sales (lot_id, type);
create unique index if not exists sales_invoice_unique on sales (lot_id, invoice_number) where invoice_number is not null;

create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references lots(id) on delete cascade,
  sale_id uuid not null references sales(id) on delete cascade,
  amount numeric not null check (amount > 0),
  date timestamptz not null default now(),
  method text, user_id uuid, user_name text, ref text
);
create index if not exists payments_sale on payments (sale_id, date);
create index if not exists payments_lot_date on payments (lot_id, date desc);

create table if not exists expenses (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references lots(id) on delete cascade,
  label text not null, category text,
  amount numeric not null check (amount > 0),
  date timestamptz not null default now(), notes text, user_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists expenses_lot_date on expenses (lot_id, date desc);

create table if not exists stock_moves (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references lots(id) on delete cascade,
  vehicle_id uuid references vehicles(id) on delete cascade,
  plate text, type text, date timestamptz not null default now(),
  user_id uuid, user_name text, note text
);
create index if not exists stock_moves_lot_date on stock_moves (lot_id, date desc);

-- Journal d'audit chaîné : chaque ligne contient le hash de la précédente.
-- Modifier une ligne passée casse la chaîne, détectable par mp_audit_verify().
create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references lots(id) on delete cascade,
  user_id uuid, user_name text,
  action text not null, details text,
  at timestamptz not null default clock_timestamp(),
  prev_hash text, hash text
);
create index if not exists audit_log_lot_at on audit_log (lot_id, at desc);

create table if not exists spots (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references lots(id) on delete cascade,
  code text not null, zone text, type text not null default 'standard',
  status text not null default 'libre' check (status in ('libre','occupe','reserve','hs')),
  hourly_rate numeric, note text, current_ticket_id uuid,
  created_at timestamptz not null default now(),
  unique (lot_id, code)
);
create index if not exists spots_lot_status on spots (lot_id, status);

create table if not exists tickets (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references lots(id) on delete cascade,
  ref text, plate text not null,
  vehicle_id uuid references vehicles(id) on delete set null,
  client_id uuid references clients(id) on delete set null,
  spot_id uuid references spots(id) on delete set null,
  spot_code text, spot_type text,
  entry_at timestamptz not null default now(), exit_at timestamptz,
  hourly_rate numeric not null default 0, daily_cap numeric not null default 0,
  grace_minutes int not null default 15,
  billed_minutes int, billed_hours int,
  amount numeric not null default 0 check (amount >= 0),
  status text not null default 'ouvert' check (status in ('ouvert','cloture','annule')),
  payment_method text, notes text, user_id uuid, user_name text, closed_by text,
  created_at timestamptz not null default now(),
  constraint tickets_exit_after_entry check (exit_at is null or exit_at >= entry_at)
);
create index if not exists tickets_lot_status on tickets (lot_id, status);
create index if not exists tickets_lot_entry on tickets (lot_id, entry_at desc);

create table if not exists reservations (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references lots(id) on delete cascade,
  client_id uuid references clients(id) on delete set null,
  client_snapshot jsonb, plate text not null,
  vehicle_id uuid references vehicles(id) on delete set null,
  spot_id uuid references spots(id) on delete set null, spot_code text,
  start_at timestamptz not null, end_at timestamptz not null,
  amount numeric not null default 0, deposit numeric not null default 0,
  status text not null default 'confirmee'
    check (status in ('confirmee','en-cours','terminee','annulee')),
  notes text, ticket_id uuid, user_id uuid, user_name text,
  created_at timestamptz not null default now(),
  constraint resa_end_after_start check (end_at > start_at)
);
create index if not exists resa_lot_status on reservations (lot_id, status, start_at);
