-- MON PARKING — données métier côté serveur (PostgreSQL).
-- Les tables d'authentification viennent de 20261026100000_auth_store.sql et
-- utilisent `lots(id, profile)`. Les tables ci-dessous partagent ce `lot_id` :
-- un employé du parking A ne voit jamais une ligne du parking B, le filtrage
-- étant fait dans le magasin applicatif (server/business-store-pg.mjs) après
-- authentification du jeton de session.
--
-- Choix de types :
--   * montants en numeric(14,2) : jamais de flottant pour de l'argent ;
--   * horodatages en bigint : Date.now() (~1,8e12) dépasse int4 ;
--   * `data` en jsonb : conserve les champs propres à l'interface sans figer
--     une colonne par option future.

CREATE TABLE IF NOT EXISTS vehicles (
  id          text PRIMARY KEY,
  lot_id      text NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  plate       text NOT NULL,
  status      text NOT NULL DEFAULT 'disponible',
  brand       text NOT NULL DEFAULT '',
  model       text NOT NULL DEFAULT '',
  year        integer NOT NULL DEFAULT 0,
  category    text NOT NULL DEFAULT '',
  price       numeric(14,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  cost        numeric(14,2) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  mileage     integer NOT NULL DEFAULT 0 CHECK (mileage >= 0),
  fuel        text NOT NULL DEFAULT '',
  gearbox     text NOT NULL DEFAULT '',
  color       text NOT NULL DEFAULT '',
  photo_count integer NOT NULL DEFAULT 0,
  frame_count integer NOT NULL DEFAULT 0,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  bigint NOT NULL,
  updated_at  bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS vehicles_lot_plate ON vehicles (lot_id, lower(plate));
CREATE INDEX IF NOT EXISTS vehicles_lot_status ON vehicles (lot_id, status);
CREATE INDEX IF NOT EXISTS vehicles_lot_created ON vehicles (lot_id, created_at DESC);

CREATE TABLE IF NOT EXISTS clients (
  id         text PRIMARY KEY,
  lot_id     text NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  name       text NOT NULL,
  phone      text NOT NULL DEFAULT '',
  email      text NOT NULL DEFAULT '',
  address    text NOT NULL DEFAULT '',
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS clients_lot_name ON clients (lot_id, lower(name));
CREATE INDEX IF NOT EXISTS clients_lot_phone ON clients (lot_id, phone);

CREATE TABLE IF NOT EXISTS sales (
  id             text PRIMARY KEY,
  lot_id         text NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  ref            text NOT NULL,
  type           text NOT NULL CHECK (type IN ('vente', 'location')),
  status         text NOT NULL DEFAULT 'payee',
  vehicle_id     text REFERENCES vehicles(id) ON DELETE RESTRICT,
  client_id      text REFERENCES clients(id) ON DELETE SET NULL,
  user_id        text,
  total          numeric(14,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  paid           numeric(14,2) NOT NULL DEFAULT 0 CHECK (paid >= 0),
  invoice_number text,
  date           bigint NOT NULL,
  data           jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT sales_paid_within_total CHECK (paid <= total)
);
CREATE UNIQUE INDEX IF NOT EXISTS sales_lot_ref ON sales (lot_id, ref);
CREATE INDEX IF NOT EXISTS sales_lot_date ON sales (lot_id, date DESC);
CREATE INDEX IF NOT EXISTS sales_lot_type ON sales (lot_id, type);
CREATE INDEX IF NOT EXISTS sales_vehicle ON sales (vehicle_id);

CREATE TABLE IF NOT EXISTS payments (
  id      text PRIMARY KEY,
  lot_id  text NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  sale_id text NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  amount  numeric(14,2) NOT NULL CHECK (amount > 0),
  method  text NOT NULL DEFAULT 'espece',
  date    bigint NOT NULL,
  data    jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS payments_sale ON payments (sale_id);
CREATE INDEX IF NOT EXISTS payments_lot_date ON payments (lot_id, date DESC);

CREATE TABLE IF NOT EXISTS tickets (
  id        text PRIMARY KEY,
  lot_id    text NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  ref       text NOT NULL,
  plate     text NOT NULL DEFAULT '',
  spot_code text NOT NULL DEFAULT '',
  status    text NOT NULL DEFAULT 'ouvert' CHECK (status IN ('ouvert', 'clos')),
  entry_at  bigint NOT NULL,
  exit_at   bigint NOT NULL DEFAULT 0,
  amount    numeric(14,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  data      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS tickets_lot_ref ON tickets (lot_id, ref);
CREATE INDEX IF NOT EXISTS tickets_lot_status ON tickets (lot_id, status);
CREATE INDEX IF NOT EXISTS tickets_lot_plate ON tickets (lot_id, lower(plate));

CREATE TABLE IF NOT EXISTS vehicle_photos (
  id         text PRIMARY KEY,
  lot_id     text NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  vehicle_id text NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  kind       text NOT NULL DEFAULT 'photo',
  sort       integer NOT NULL DEFAULT 0,
  url        text NOT NULL DEFAULT '',
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS vehicle_photos_vehicle ON vehicle_photos (vehicle_id, kind, sort);
