-- MON PARKING · Schéma PostgreSQL de production (Supabase) avec Row Level Security
create extension if not exists "pgcrypto";

create table lots (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text,
  logo text,
  address text, city text, phone text, email text, tax_id text,
  currency text not null default 'XOF',
  vat_rate numeric not null default 18,
  invoice_prefix text not null default 'FAC',
  receipt_prefix text not null default 'REC',
  invoice_next int not null default 1,
  receipt_next int not null default 1,
  tagline text, footer_note text,
  owner_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  active boolean not null default true
);

create table memberships (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references lots(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('admin','employe')) default 'employe',
  username text not null,
  display_name text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, lot_id)
);

create table vehicles (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references lots(id) on delete cascade,
  plate text not null, brand text, model text, year int, vin text,
  mileage int default 0, fuel text, gearbox text, color text, category text,
  condition text, purchase_price numeric default 0, price numeric default 0,
  rent_price_daily numeric default 0,
  status text not null check (status in ('stock','vendu','loue','reserve','maintenance')) default 'stock',
  photo text, supplier text, acquisition_date date, description text,
  sold_at timestamptz, sold_price numeric,
  created_at timestamptz not null default now(),
  unique (lot_id, plate)
);
create index on vehicles (lot_id, status);

create table clients (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references lots(id) on delete cascade,
  name text not null, type text default 'particulier', phone text, email text,
  address text, tax_id text, created_at timestamptz not null default now()
);

create table sales (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references lots(id) on delete cascade,
  ref text, type text not null check (type in ('vente','location')),
  status text not null check (status in ('payee','partielle','impayee')) default 'impayee',
  vehicle_id uuid references vehicles(id) on delete set null,
  vehicle_snapshot jsonb, client_id uuid references clients(id) on delete set null,
  client_snapshot jsonb, user_id uuid references auth.users(id),
  user_name text, date timestamptz not null default now(),
  price numeric not null default 0, discount numeric default 0,
  vat_rate numeric default 0, subtotal numeric default 0,
  vat_amount numeric default 0, total numeric not null default 0,
  paid numeric not null default 0, payment_method text, due_date timestamptz,
  invoice_number text, receipt_number text, notes text,
  rental_start timestamptz, rental_end timestamptz, rental_days int default 0,
  deposit numeric default 0, returned_at timestamptz, extra_fees numeric default 0,
  created_at timestamptz not null default now()
);
create index on sales (lot_id, date desc);

create table payments (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references lots(id) on delete cascade,
  sale_id uuid not null references sales(id) on delete cascade,
  amount numeric not null, date timestamptz not null default now(),
  method text, user_id uuid, user_name text, ref text
);

create table expenses (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references lots(id) on delete cascade,
  label text not null, category text, amount numeric not null,
  date timestamptz not null default now(), notes text, user_id uuid,
  created_at timestamptz not null default now()
);

create table stock_moves (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references lots(id) on delete cascade,
  vehicle_id uuid references vehicles(id) on delete cascade,
  plate text, type text, date timestamptz not null default now(),
  user_id uuid, user_name text, note text
);

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references lots(id) on delete cascade,
  user_id uuid, user_name text, action text not null,
  details text, at timestamptz not null default now()
);

-- ---------- RLS ----------
create or replace function is_member(p_lot uuid) returns boolean language sql stable as $$
  select exists (select 1 from memberships m where m.lot_id = p_lot and m.user_id = auth.uid() and m.active);
$$;
create or replace function is_lot_admin(p_lot uuid) returns boolean language sql stable as $$
  select exists (select 1 from memberships m where m.lot_id = p_lot and m.user_id = auth.uid() and m.role = 'admin' and m.active);
$$;

alter table lots enable row level security;
alter table memberships enable row level security;
alter table vehicles enable row level security;
alter table clients enable row level security;
alter table sales enable row level security;
alter table payments enable row level security;
alter table expenses enable row level security;
alter table stock_moves enable row level security;
alter table audit_log enable row level security;

create policy lots_read on lots for select using (is_member(id));
create policy lots_admin on lots for update using (is_lot_admin(id));

create policy memberships_read on memberships for select using (is_member(lot_id));
create policy memberships_admin on memberships for all using (is_lot_admin(lot_id));

-- employés : lecture + création de ventes ; admin : tout
create policy vehicles_read on vehicles for select using (is_member(lot_id));
create policy vehicles_admin on vehicles for all using (is_lot_admin(lot_id));

create policy clients_read on clients for select using (is_member(lot_id));
create policy clients_write on clients for all using (is_member(lot_id));

create policy sales_read on sales for select using (is_member(lot_id));
create policy sales_insert on sales for insert with check (is_member(lot_id));
create policy sales_admin on sales for update using (is_lot_admin(lot_id));
create policy sales_delete on sales for delete using (is_lot_admin(lot_id));

create policy payments_read on payments for select using (is_member(lot_id));
create policy payments_insert on payments for insert with check (is_member(lot_id));

create policy expenses_admin on expenses for all using (is_lot_admin(lot_id));
create policy moves_read on stock_moves for select using (is_member(lot_id));
create policy moves_insert on stock_moves for insert with check (is_member(lot_id));
create policy audit_read on audit_log for select using (is_lot_admin(lot_id));
create policy audit_insert on audit_log for insert with check (is_member(lot_id));

-- ================= STATIONNEMENT =================
create table spots (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references lots(id) on delete cascade,
  code text not null, zone text, type text not null default 'standard',
  status text not null check (status in ('libre','occupe','reserve','hs')) default 'libre',
  hourly_rate numeric, note text, current_ticket_id uuid,
  created_at timestamptz not null default now(),
  unique (lot_id, code)
);
create index on spots (lot_id, status);

create table tickets (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references lots(id) on delete cascade,
  ref text, plate text not null, vehicle_id uuid references vehicles(id) on delete set null,
  client_id uuid references clients(id) on delete set null,
  spot_id uuid references spots(id) on delete set null,
  spot_code text, spot_type text,
  entry_at timestamptz not null default now(), exit_at timestamptz,
  hourly_rate numeric default 0, daily_cap numeric default 0, grace_minutes int default 15,
  billed_minutes int, billed_hours int, amount numeric default 0,
  status text not null check (status in ('ouvert','cloture','annule')) default 'ouvert',
  payment_method text, notes text, user_id uuid, user_name text, closed_by text,
  created_at timestamptz not null default now()
);
create index on tickets (lot_id, status);
create index on tickets (lot_id, entry_at desc);

create table reservations (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references lots(id) on delete cascade,
  client_id uuid references clients(id) on delete set null,
  client_snapshot jsonb, plate text not null,
  vehicle_id uuid references vehicles(id) on delete set null,
  spot_id uuid references spots(id) on delete set null, spot_code text,
  start_at timestamptz not null, end_at timestamptz not null,
  amount numeric default 0, deposit numeric default 0,
  status text not null check (status in ('confirmee','en-cours','terminee','annulee')) default 'confirmee',
  notes text, ticket_id uuid, user_id uuid, user_name text,
  created_at timestamptz not null default now(),
  check (end_at > start_at)
);
create index on reservations (lot_id, status, start_at);

alter table spots enable row level security;
alter table tickets enable row level security;
alter table reservations enable row level security;

create policy spots_read on spots for select using (is_member(lot_id));
create policy spots_write on spots for all using (is_member(lot_id));
create policy tickets_read on tickets for select using (is_member(lot_id));
create policy tickets_insert on tickets for insert with check (is_member(lot_id));
create policy tickets_update on tickets for update using (is_member(lot_id));
create policy resa_read on reservations for select using (is_member(lot_id));
create policy resa_write on reservations for all using (is_member(lot_id));

-- tarifs de stationnement sur le parking
alter table lots
  add column if not exists hourly_rate numeric default 500,
  add column if not exists daily_cap numeric default 6000,
  add column if not exists grace_minutes int default 15,
  add column if not exists ticket_next int default 1;
