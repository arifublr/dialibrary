'use strict';
/**
 * Dual database architecture:
 *   SQL   -> PostgreSQL (Cloud / Render) or SQLite (local fallback)
 *            Houses bibliographic records (biblio), physical copies (items), loans
 *   NoSQL -> MongoDB Atlas (Cloud) or NeDB (local fallback)
 *            Houses users, passkeys, sessions, settings, holds, fines, audit logs, shelves
 */
const path = require('path');
const cfg = require('./config');

// ========================================================
// 1. NoSQL Layer: MongoDB Atlas (or NeDB fallback)
// ========================================================
let nosql = {};

if (cfg.MONGODB_URI) {
  const { MongoClient, ObjectId } = require('mongodb');
  const mongoClient = new MongoClient(cfg.MONGODB_URI, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 8000,
  });

  const ID_FIELDS = new Set(['_id', 'patronId', 'userId', 'itemId']);

  function normalizeQuery(query) {
    if (!query || typeof query !== 'object') return query;
    const out = Array.isArray(query) ? [] : {};
    for (const [k, v] of Object.entries(query)) {
      if (ID_FIELDS.has(k)) {
        if (typeof v === 'string' && ObjectId.isValid(v) && v.length === 24) {
          out[k] = { $in: [v, new ObjectId(v)] };
        } else if (v && typeof v === 'object' && v.$in) {
          out[k] = {
            $in: v.$in.flatMap((item) =>
              typeof item === 'string' && ObjectId.isValid(item) && item.length === 24
                ? [item, new ObjectId(item)]
                : [item]
            ),
          };
        } else {
          out[k] = v;
        }
      } else if (Array.isArray(v)) {
        out[k] = v.map((item) => (typeof item === 'object' ? normalizeQuery(item) : item));
      } else if (v && typeof v === 'object' && !(v instanceof ObjectId) && !(v instanceof Date) && !(v instanceof RegExp)) {
        out[k] = normalizeQuery(v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  function normalizeDoc(doc) {
    if (!doc || typeof doc !== 'object') return doc;
    if (doc._id && typeof doc._id === 'object') doc._id = doc._id.toString();
    if (doc.patronId && typeof doc.patronId === 'object') doc.patronId = doc.patronId.toString();
    if (doc.userId && typeof doc.userId === 'object') doc.userId = doc.userId.toString();
    return doc;
  }

  const getCollection = (name) => {
    let col = null;
    const ensureCol = async () => {
      if (!col) {
        await mongoClient.connect();
        col = mongoClient.db(cfg.MONGODB_DB || 'dialibrary').collection(name);
      }
      return col;
    };

    return {
      findOneAsync: async (query) => {
        const c = await ensureCol();
        const doc = await c.findOne(normalizeQuery(query));
        return normalizeDoc(doc);
      },
      findAsync: (query) => {
        let sortObj = null;
        let limitVal = null;
        let skipVal = null;

        const exec = async () => {
          const c = await ensureCol();
          let cursor = c.find(normalizeQuery(query));
          if (sortObj) cursor = cursor.sort(sortObj);
          if (skipVal != null) cursor = cursor.skip(skipVal);
          if (limitVal != null) cursor = cursor.limit(limitVal);
          const docs = await cursor.toArray();
          return docs.map(normalizeDoc);
        };

        const chain = {
          sort: (s) => { sortObj = s; return chain; },
          limit: (l) => { limitVal = l; return chain; },
          skip: (k) => { skipVal = k; return chain; },
          then: (resolve, reject) => exec().then(resolve, reject),
          catch: (reject) => exec().catch(reject),
        };
        return chain;
      },
      insertAsync: async (doc) => {
        const c = await ensureCol();
        const copy = { ...doc };
        if (!copy._id) copy._id = new ObjectId().toHexString();
        await c.insertOne(copy);
        return normalizeDoc(copy);
      },
      updateAsync: async (query, update, options = {}) => {
        const c = await ensureCol();
        const q = normalizeQuery(query);
        let op = update;
        const hasAtomic = Object.keys(update).some((k) => k.startsWith('$'));
        if (!hasAtomic) {
          const { _id, ...rest } = update;
          op = { $set: rest };
        }
        if (options.multi) {
          const res = await c.updateMany(q, op, { upsert: !!options.upsert });
          return res.modifiedCount;
        }
        const res = await c.updateOne(q, op, { upsert: !!options.upsert });
        return res.modifiedCount;
      },
      removeAsync: async (query, options = {}) => {
        const c = await ensureCol();
        const q = normalizeQuery(query);
        if (options.multi) {
          const res = await c.deleteMany(q);
          return res.deletedCount;
        }
        const res = await c.deleteOne(q);
        return res.deletedCount;
      },
      countAsync: async (query) => {
        const c = await ensureCol();
        return c.countDocuments(normalizeQuery(query));
      },
      ensureIndexAsync: async (options) => {
        const c = await ensureCol();
        const spec = { [options.fieldName]: 1 };
        const opts = {};
        if (options.unique) opts.unique = true;
        if (options.sparse) opts.sparse = true;
        if (options.expireAfterSeconds != null) opts.expireAfterSeconds = options.expireAfterSeconds;
        return c.createIndex(spec, opts);
      },
    };
  };

  nosql = {
    users: getCollection('users'),
    sessions: getCollection('sessions'),
    challenges: getCollection('challenges'),
    settings: getCollection('settings'),
    holds: getCollection('holds'),
    fines: getCollection('fines'),
    audit: getCollection('audit'),
    shelves: getCollection('shelves'),
    _client: mongoClient,
  };
} else {
  // NeDB Fallback for local offline development
  const Datastore = require('@seald-io/nedb');
  const store = (name) =>
    new Datastore({ filename: path.join(cfg.DATA_DIR, `${name}.db`), autoload: true });

  nosql = {
    users: store('users'),
    sessions: store('sessions'),
    challenges: store('challenges'),
    settings: store('settings'),
    holds: store('holds'),
    fines: store('fines'),
    audit: store('audit'),
    shelves: store('shelves'),
  };
}

// ========================================================
// 2. SQL Layer: PostgreSQL (Cloud) or SQLite (local fallback)
// ========================================================
let sql = {};
let isPg = false;

if (cfg.DATABASE_URL) {
  isPg = true;
  const { Pool, types } = require('pg');
  // Parse PostgreSQL BIGINT (type 20) as integer so COUNT(*) returns a Number
  types.setTypeParser(20, (val) => parseInt(val, 10));

  const pool = new Pool({
    connectionString: cfg.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
  });

  function convertSql(query) {
    let idx = 0;
    let q = query.replace(/\?/g, () => `$${++idx}`);
    q = q.replace(/GLOB\s+'B\[0-9\]\*'/gi, "LIKE 'B%'");
    q = q.replace(/SUM\(i\.status='available'\)/gi, "SUM(CASE WHEN i.status='available' THEN 1 ELSE 0 END)");
    q = q.replace(/COLLATE\s+NOCASE/gi, '');
    q = q.replace(/group_concat\(([^,)]+),\s*'([^']+)'\)/gi, "string_agg($1, '$2')");
    q = q.replace(/group_concat\(([^)]+)\)/gi, "string_agg($1, ',')");
    q = q.replace(/substr\(out_at,1,10\)/gi, "substr(CAST(out_at AS TEXT),1,10)");
    if (/^\s*INSERT\s+INTO\s+/i.test(q) && !/RETURNING/i.test(q)) {
      q += ' RETURNING id';
    }
    return q;
  }

  sql = {
    isPg: true,
    pool,
    exec: async (q) => pool.query(q),
    prepare: (rawSql) => {
      const q = convertSql(rawSql);
      return {
        get: async (...args) => {
          const res = await pool.query(q, args);
          return res.rows[0];
        },
        all: async (...args) => {
          const res = await pool.query(q, args);
          return res.rows;
        },
        run: async (...args) => {
          const res = await pool.query(q, args);
          return {
            lastInsertRowid: res.rows[0] ? res.rows[0].id : null,
            changes: res.rowCount,
          };
        },
      };
    },
    transaction: (fn) => async (...args) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(...args);
        await client.query('COMMIT');
        return out;
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw e;
      } finally {
        client.release();
      }
    },
  };
} else {
  // SQLite Fallback
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(path.join(cfg.DATA_DIR, cfg.SQL_FILENAME || 'catalogue.sqlite'));
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

  sql = {
    isPg: false,
    exec: (q) => raw.exec(q),
    prepare: (q) => raw.prepare(q),
    transaction: (fn) => (...args) => {
      raw.exec('BEGIN');
      try { const out = fn(...args); raw.exec('COMMIT'); return out; }
      catch (e) { try { raw.exec('ROLLBACK'); } catch {} throw e; }
    },
  };
}

async function initIndexes() {
  await nosql.users.ensureIndexAsync({ fieldName: 'username', unique: true });
  await nosql.users.ensureIndexAsync({ fieldName: 'cardNumber', unique: true, sparse: true });
  await nosql.sessions.ensureIndexAsync({ fieldName: 'expireAt', expireAfterSeconds: 0 });
  await nosql.challenges.ensureIndexAsync({ fieldName: 'expireAt', expireAfterSeconds: 0 });
  await nosql.holds.ensureIndexAsync({ fieldName: 'patronId' });
  await nosql.fines.ensureIndexAsync({ fieldName: 'patronId' });

  if (isPg) {
    await sql.exec(`
      CREATE TABLE IF NOT EXISTS biblio (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT '',
        isbn TEXT NOT NULL DEFAULT '',
        publisher TEXT NOT NULL DEFAULT '',
        year INTEGER,
        language TEXT NOT NULL DEFAULT 'English',
        subjects TEXT NOT NULL DEFAULT '',
        search_aliases TEXT NOT NULL DEFAULT '',
        call_number TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_biblio_isbn ON biblio(isbn);

      CREATE TABLE IF NOT EXISTS items (
        id SERIAL PRIMARY KEY,
        biblio_id INTEGER NOT NULL REFERENCES biblio(id) ON DELETE CASCADE,
        barcode TEXT NOT NULL UNIQUE,
        location TEXT NOT NULL DEFAULT 'Main Shelves',
        shelf_number TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','checked_out','on_hold','lost','withdrawn','repair')),
        inventory_status TEXT NOT NULL DEFAULT 'unchecked',
        inventory_checked_at TIMESTAMPTZ,
        added_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_items_biblio ON items(biblio_id);

      CREATE TABLE IF NOT EXISTS loans (
        id SERIAL PRIMARY KEY,
        item_id INTEGER NOT NULL REFERENCES items(id),
        patron_id TEXT NOT NULL,
        patron_name TEXT NOT NULL,
        out_at TIMESTAMPTZ NOT NULL,
        due_at TIMESTAMPTZ NOT NULL,
        returned_at TIMESTAMPTZ,
        renewals INTEGER NOT NULL DEFAULT 0,
        issued_by TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_loans_patron ON loans(patron_id);
      CREATE INDEX IF NOT EXISTS idx_loans_open ON loans(returned_at);
    `);
  } else {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS biblio (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT '',
        isbn TEXT NOT NULL DEFAULT '',
        publisher TEXT NOT NULL DEFAULT '',
        year INTEGER,
        language TEXT NOT NULL DEFAULT 'English',
        subjects TEXT NOT NULL DEFAULT '',
        search_aliases TEXT NOT NULL DEFAULT '',
        call_number TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_biblio_isbn ON biblio(isbn);

      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        biblio_id INTEGER NOT NULL REFERENCES biblio(id) ON DELETE CASCADE,
        barcode TEXT NOT NULL UNIQUE,
        location TEXT NOT NULL DEFAULT 'Main Shelves',
        shelf_number TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','checked_out','on_hold','lost','withdrawn','repair')),
        inventory_status TEXT NOT NULL DEFAULT 'unchecked',
        inventory_checked_at TEXT,
        added_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_items_biblio ON items(biblio_id);

      CREATE TABLE IF NOT EXISTS loans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL REFERENCES items(id),
        patron_id TEXT NOT NULL,
        patron_name TEXT NOT NULL,
        out_at TEXT NOT NULL,
        due_at TEXT NOT NULL,
        returned_at TEXT,
        renewals INTEGER NOT NULL DEFAULT 0,
        issued_by TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_loans_patron ON loans(patron_id);
      CREATE INDEX IF NOT EXISTS idx_loans_open ON loans(returned_at);

      CREATE VIRTUAL TABLE IF NOT EXISTS biblio_fts USING fts5(
        title, author, subjects, isbn, call_number, publisher, description,
        content='biblio', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
      );
    `);
  }

  if (isPg) {
    await sql.exec(`
      ALTER TABLE biblio ADD COLUMN IF NOT EXISTS search_aliases TEXT NOT NULL DEFAULT '';
      ALTER TABLE items ADD COLUMN IF NOT EXISTS shelf_number TEXT NOT NULL DEFAULT '';
      ALTER TABLE items ADD COLUMN IF NOT EXISTS inventory_status TEXT NOT NULL DEFAULT 'unchecked';
      ALTER TABLE items ADD COLUMN IF NOT EXISTS inventory_checked_at TIMESTAMPTZ;
      CREATE INDEX IF NOT EXISTS idx_items_inventory_status ON items(inventory_status);
    `);
  } else {
    const biblioColumns = await sql.prepare('PRAGMA table_info(biblio)').all();
    const itemColumns = await sql.prepare('PRAGMA table_info(items)').all();
    if (!biblioColumns.some((column) => column.name === 'search_aliases')) {
      sql.exec(`ALTER TABLE biblio ADD COLUMN search_aliases TEXT NOT NULL DEFAULT ''`);
    }
    if (!itemColumns.some((column) => column.name === 'inventory_status')) {
      sql.exec(`ALTER TABLE items ADD COLUMN inventory_status TEXT NOT NULL DEFAULT 'unchecked'`);
    }
    if (!itemColumns.some((column) => column.name === 'shelf_number')) {
      sql.exec(`ALTER TABLE items ADD COLUMN shelf_number TEXT NOT NULL DEFAULT ''`);
    }
    if (!itemColumns.some((column) => column.name === 'inventory_checked_at')) {
      sql.exec(`ALTER TABLE items ADD COLUMN inventory_checked_at TEXT`);
    }
    sql.exec('CREATE INDEX IF NOT EXISTS idx_items_inventory_status ON items(inventory_status)');
  }
}

module.exports = { sql, nosql, initIndexes };
