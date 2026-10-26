// MON PARKING — couche d'accès PostgreSQL asynchrone.
//
// Le portage depuis node:sqlite (DatabaseSync) impose deux changements :
//   1. toute requête renvoie une promesse : chaque appel doit être attendu
//      (`await`), y compris dans les chemins qui étaient synchrones ;
//   2. les marqueurs `?` de SQLite deviennent `$1..$n` côté PostgreSQL.
//
// convert() fait cette traduction sans toucher aux `?` qui se trouvent dans une
// chaîne littérale ('?'), un identifiant ("a?b"), un commentaire ou un bloc
// dollar-quoté ($$…$$) — sinon une requête contenant un texte utilisateur
// verrait ses paramètres décalés.

const DOLLAR = /^\$[A-Za-z0-9_]*\$/;

export function convert(sql) {
  let out = '', n = 0, i = 0, inString = false, inIdent = false;
  while (i < sql.length) {
    const c = sql[i];
    if (inString) {
      out += c;
      if (c === "'") {
        if (sql[i + 1] === "'") { out += "'"; i += 2; continue }
        inString = false;
      }
      i++; continue;
    }
    if (inIdent) {
      out += c;
      if (c === '"') {
        if (sql[i + 1] === '"') { out += '"'; i += 2; continue }
        inIdent = false;
      }
      i++; continue;
    }
    if (c === "'") { inString = true; out += c; i++; continue }
    if (c === '"') { inIdent = true; out += c; i++; continue }
    if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end < 0 ? sql.length : end;
      out += sql.slice(i, stop); i = stop; continue;
    }
    if (c === '$') {
      const m = DOLLAR.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end >= 0) { out += sql.slice(i, end + tag.length); i = end + tag.length; continue }
      }
    }
    if (c === '?') { n++; out += '$' + n; i++; continue }
    out += c; i++;
  }
  return out;
}

// Client minimal : même vocabulaire que serveur SQLite (.get/.all/.run/.exec)
// mais asynchrone, pour que la relecture du code métier reste mécanique.
export class Sql {
  constructor(pool) { this.pool = pool }

  async one(sql, params = []) {
    const result = await this.pool.query(convert(sql), params);
    return result.rows[0];
  }

  async all(sql, params = []) {
    const result = await this.pool.query(convert(sql), params);
    return result.rows;
  }

  // `changes` reproduit le champ .changes de SQLite, utilisé par sweep().
  async run(sql, params = []) {
    const result = await this.pool.query(convert(sql), params);
    return { changes: result.rowCount };
  }

  async exec(sql) { await this.pool.query(sql) }

  // SQLite utilisait BEGIN IMMEDIATE pour prendre le verrou d'écriture tout de
  // suite. En PostgreSQL, on rend une connexion dédiée et on l'attend : sans
  // cela, les requêtes du callback pourraient partir sur d'autres connexions du
  // pool et échapper à la transaction.
  async transaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Le Sql dédié reçoit un exécuteur brut : convert() est appliqué une
      // seule fois, par les méthodes one/all/run de Sql.
      const scoped = new Sql({ query: (text, params) => client.query(text, params) });
      const value = await fn(scoped);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try { await client.query('ROLLBACK') } catch { /* connexion déjà perdue */ }
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function openSql({ connectionString, ssl, max = 5 } = {}) {
  const { default: pg } = await import('pg');
  if (!connectionString) throw new Error('DATABASE_URL manquant : impossible d\'ouvrir PostgreSQL.');
  // SSL déduit de la chaîne, comme le fait tout client PostgreSQL : sans cela
  // un `sslmode=disable` (Postgres local) échouait sur « self-signed certificate »
  // et un `sslmode=require` distant pouvait retomber en clair.
  const mode = /[?&]sslmode=([a-z]+)/.exec(connectionString)?.[1]
    || (process.env.PGSSLMODE ? String(process.env.PGSSLMODE) : undefined)
  const useSsl = ssl !== undefined ? ssl : !(mode === 'disable' || mode === 'allow')
  // rejectUnauthorized reste vrai : on veut un certificat valide, pas
  // seulement un canal chiffré.
  const pool = new pg.Pool({ connectionString, max, ssl: useSsl ? { rejectUnauthorized: true } : false });
  pool.on('error', error => console.error('[pg] connexion inactive perdue :', error.message));
  const sql = new Sql(pool);
  await sql.one('SELECT 1 AS ok');
  return { sql, pool, close: () => pool.end() };
}
