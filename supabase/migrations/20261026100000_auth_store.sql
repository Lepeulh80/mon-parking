-- MON PARKING — portage de la couche d'authentification SQLite vers PostgreSQL.
-- Remplace les tables créées par AuthStore (server/auth-store.mjs) : lots,
-- accounts, sessions, auth_audit, login_attempts, login_challenges.
--
-- Différences volontaires avec le DDL SQLite, toutes imposées par le moteur :
--   * INTEGER (horodatage ms) -> BIGINT : Date.now() vaut ~1,8e12, hors du
--     domaine de int4 (2,1e9). Un INTEGER PG aurait levé « out of range ».
--   * INTEGER 0/1 conservé pour active / totp_active : le code JS teste la
--     véracité (`!!row.active`, `active?1:0`) et parseActive normalise déjà.
--   * COLLATE NOCASE (SQLite) -> index unique fonctionnel sur lower(username).
--   * PRAGMA (journal_mode, busy_timeout, foreign_keys) : sans objet, MVCC.

CREATE TABLE IF NOT EXISTS lots (
  id      text PRIMARY KEY,
  profile text NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id                text PRIMARY KEY,
  principal         text NOT NULL,
  username          text NOT NULL,
  name              text NOT NULL,
  role              text NOT NULL,
  lot_id            text NOT NULL REFERENCES lots(id),
  active            integer NOT NULL DEFAULT 1,
  pin_hash          text NOT NULL,
  pin_salt          text NOT NULL,
  generation        integer NOT NULL DEFAULT 1,
  failures          integer NOT NULL DEFAULT 0,
  locked_until      bigint  NOT NULL DEFAULT 0,
  phone             text    NOT NULL DEFAULT '',
  email             text    NOT NULL DEFAULT '',
  totp_secret       text    NOT NULL DEFAULT '',
  totp_active       integer NOT NULL DEFAULT 0,
  totp_last_step    bigint  NOT NULL DEFAULT 0,
  totp_backup       text    NOT NULL DEFAULT '[]',
  totp_failures     integer NOT NULL DEFAULT 0,
  totp_locked_until bigint  NOT NULL DEFAULT 0,
  CONSTRAINT accounts_active_bool     CHECK (active      IN (0,1)),
  CONSTRAINT accounts_totp_active_bool CHECK (totp_active IN (0,1)),
  CONSTRAINT accounts_generation_pos  CHECK (generation >= 1)
);

-- Équivalent de UNIQUE(username,lot_id) COLLATE NOCASE : un identifiant ne doit
-- pas exister deux fois sur le même parking, quelle que soit la casse.
CREATE UNIQUE INDEX IF NOT EXISTS accounts_username_lower
  ON accounts (lower(username), lot_id);
CREATE INDEX IF NOT EXISTS accounts_principal ON accounts (principal);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  generation integer NOT NULL,
  created    bigint  NOT NULL,
  expires    bigint  NOT NULL
);
CREATE INDEX IF NOT EXISTS session_account ON sessions (account_id);
-- La purge au démarrage (sweep) filtre sur expires : sans cet index elle
-- balaie toute la table à chaque redémarrage.
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires);

CREATE TABLE IF NOT EXISTS auth_audit (
  id     text PRIMARY KEY,
  actor  text,
  action text NOT NULL,
  target text,
  at     bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_audit_at ON auth_audit (at);

CREATE TABLE IF NOT EXISTS login_attempts (
  key   text PRIMARY KEY,
  count integer NOT NULL,
  reset bigint  NOT NULL
);
CREATE INDEX IF NOT EXISTS login_attempts_reset ON login_attempts (reset);

CREATE TABLE IF NOT EXISTS login_challenges (
  token_hash text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id),
  principal  text NOT NULL,
  expires    bigint NOT NULL,
  attempts   integer NOT NULL DEFAULT 0,
  created    bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS login_challenges_account ON login_challenges (account_id);
CREATE INDEX IF NOT EXISTS login_challenges_expires ON login_challenges (expires);
