/* ------------------------------------------------------------------ */
/* db.js — storage backend for Ayaz AI Studio                            */
/*                                                                     */
/* PostgreSQL when DATABASE_URL is set (persistent across deploys),    */
/* JSON files otherwise (local dev / fallback — ephemeral on Render    */
/* free tier, same as before).                                         */
/*                                                                     */
/* Design: every store lives in an in-memory cache in server.js,       */
/* exactly like the old JSON code. The save*() functions below are     */
/* write-through and fire-and-forget (same semantics as the old        */
/* fs.writeFile callbacks). Postgres writes for one bucket are        */
/* serialized so rapid successive saves apply in order.                */
/*                                                                     */
/* Tables (created automatically on boot when Postgres is reachable):  */
/*   users(email PK, data JSONB)         — accounts + sessions/tokens   */
/*   usage(email PK, data JSONB)         — daily generation limits      */
/*   creations(email PK, data JSONB)     — per-user generation history */
/*   chat_history(email PK, data JSONB)  — per-user chat history       */
/*   feedback(id PK, data JSONB)         — feedback entries            */
/*   newsletter(email PK, data JSONB)    — newsletter signups          */
/*   video_queue(id PK, user_email, prompt, status, created_at,        */
/*               result_url, data JSONB) — agent video requests        */
/*   image_queue(id PK, ...)            — agent image requests        */
/* ------------------------------------------------------------------ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const JSON_FILES = {
  users: 'users.json',
  usage: 'usage.json',
  creations: 'creations.json',
  chat: 'chat.json',
  feedback: 'feedback.json',
  newsletter: 'newsletter.json',
  video_queue: 'video_queue.json',
  image_queue: 'image_queue.json',
};

let pool = null;
let pgMode = false;

function mode() { return pgMode ? 'postgres' : 'json'; }

/* ---------------- JSON fallback ---------------- */

function readJson(name, fallback) {
  try {
    const file = path.join(__dirname, JSON_FILES[name]);
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed !== undefined && parsed !== null) return parsed;
    }
  } catch (e) {
    console.log(`[db] ${JSON_FILES[name]} unreadable, starting fresh`);
  }
  return fallback;
}

function writeJson(name, data) {
  fs.writeFile(path.join(__dirname, JSON_FILES[name]), JSON.stringify(data), (e) => {
    if (e) console.log(`[db] ${name} save failed:`, e.message);
  });
}

/* ---------------- Postgres helpers ---------------- */

/** Serialize writes per bucket so they apply in call order. */
const chains = {};
function chain(bucket, fn) {
  chains[bucket] = (chains[bucket] || Promise.resolve())
    .then(fn)
    .catch((e) => console.log(`[db] ${bucket} persist failed:`, e.message));
}

/** pg-types parses JSONB into objects already; tolerate raw strings too. */
function asObj(v, fallback) {
  if (v && typeof v === 'object') return v;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch (e) { /* fall through */ }
  }
  return fallback;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS usage (
  email TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS creations (
  email TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS chat_history (
  email TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS newsletter (
  email TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS video_queue (
  id TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  result_url TEXT,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS image_queue (
  id TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  prompt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  result_url TEXT,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_video_queue_status ON video_queue (status);
CREATE INDEX IF NOT EXISTS idx_image_queue_status ON image_queue (status);
`;

/** Upsert every entry of an email-keyed map; delete rows missing from it. */
async function persistEmailMap(client, table, map) {
  const entries = Object.entries(map || {});
  for (const [email, data] of entries) {
    await client.query(
      `INSERT INTO ${table} (email, data, updated_at) VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (email) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [email, JSON.stringify(data)]
    );
  }
  if (entries.length) {
    await client.query(
      `DELETE FROM ${table} WHERE email <> ALL($1)`,
      [entries.map(([e]) => e)]
    );
  } else {
    await client.query(`DELETE FROM ${table}`);
  }
}

async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

async function loadAllPg() {
  const users = {};
  for (const r of (await pool.query('SELECT email, data FROM users')).rows) {
    users[r.email] = asObj(r.data, {});
  }
  const usage = {};
  for (const r of (await pool.query('SELECT email, data FROM usage')).rows) {
    usage[r.email] = asObj(r.data, {});
  }
  const creations = {};
  for (const r of (await pool.query('SELECT email, data FROM creations')).rows) {
    creations[r.email] = asObj(r.data, []);
  }
  const chat = {};
  for (const r of (await pool.query('SELECT email, data FROM chat_history')).rows) {
    chat[r.email] = asObj(r.data, []);
  }
  const feedbackEntries = (await pool.query('SELECT data FROM feedback ORDER BY created_at ASC')).rows
    .map((r) => asObj(r.data, null))
    .filter(Boolean);
  const newsletterEmails = (await pool.query('SELECT data FROM newsletter ORDER BY created_at ASC')).rows
    .map((r) => asObj(r.data, null))
    .filter(Boolean);
  const videoQueue = (await pool.query('SELECT data FROM video_queue ORDER BY created_at ASC')).rows
    .map((r) => asObj(r.data, null))
    .filter(Boolean);
  const imageQueue = (await pool.query('SELECT data FROM image_queue ORDER BY created_at ASC')).rows
    .map((r) => asObj(r.data, null))
    .filter(Boolean);
  return {
    userStore: { users },
    usageStore: { users: usage },
    creationsStore: { users: creations },
    chatStore: { users: chat },
    feedbackStore: { entries: feedbackEntries },
    newsletterStore: { emails: newsletterEmails },
    videoQueue,
    imageQueue,
  };
}

function loadAllJson() {
  const users = readJson('users', { users: {} });
  const usage = readJson('usage', { users: {} });
  const creations = readJson('creations', { users: {} });
  const chat = readJson('chat', { users: {} });
  const feedback = readJson('feedback', { entries: [] });
  const newsletter = readJson('newsletter', { emails: [] });
  return {
    userStore: users && users.users ? users : { users: {} },
    usageStore: usage && usage.users ? usage : { users: {} },
    creationsStore: creations && creations.users ? creations : { users: {} },
    chatStore: chat && chat.users ? chat : { users: {} },
    feedbackStore: feedback && Array.isArray(feedback.entries) ? feedback : { entries: [] },
    newsletterStore: newsletter && Array.isArray(newsletter.emails) ? newsletter : { emails: [] },
    videoQueue: readJson('video_queue', []),
    imageQueue: readJson('image_queue', []),
  };
}

/**
 * init() — connect to Postgres if DATABASE_URL is set, create tables,
 * load every store into memory, and return them. Falls back to JSON
 * files when DATABASE_URL is unset or Postgres is unreachable (never
 * crashes the boot).
 */
async function init() {
  const url = process.env.DATABASE_URL;
  if (url) {
    try {
      const { Pool } = require('pg');
      pool = new Pool({
        connectionString: url,
        ssl: { rejectUnauthorized: false }, // Render Postgres needs TLS
        max: 5,
      });
      await pool.query('SELECT 1');
      await pool.query(SCHEMA);
      pgMode = true;
      console.log('[db] PostgreSQL connected — data persists across deploys.');
      return await loadAllPg();
    } catch (e) {
      console.log('[db] PostgreSQL unavailable, falling back to JSON files:', e.message);
      try { await pool.end(); } catch (_) { /* ignore */ }
      pool = null;
      pgMode = false;
    }
  } else {
    console.log('[db] DATABASE_URL not set — using JSON files (ephemeral on Render free tier).');
  }
  return loadAllJson();
}

/* ---------------- write-through save functions ---------------- */
/* Same fire-and-forget semantics as the old fs.writeFile calls.    */

function saveUsers(userStore) {
  if (!pgMode) return writeJson('users', userStore);
  chain('users', () => withTx((c) => persistEmailMap(c, 'users', userStore.users)));
}

function saveUsage(usageStore) {
  if (!pgMode) return writeJson('usage', usageStore);
  chain('usage', () => withTx((c) => persistEmailMap(c, 'usage', usageStore.users)));
}

function saveCreations(creationsStore) {
  if (!pgMode) return writeJson('creations', creationsStore);
  chain('creations', () => withTx((c) => persistEmailMap(c, 'creations', creationsStore.users)));
}

function saveChat(chatStore) {
  if (!pgMode) return writeJson('chat', chatStore);
  chain('chat', () => withTx((c) => persistEmailMap(c, 'chat_history', chatStore.users)));
}

function saveFeedback(feedbackStore) {
  const entries = (feedbackStore && feedbackStore.entries) || [];
  if (!pgMode) return writeJson('feedback', feedbackStore);
  chain('feedback', () => withTx(async (c) => {
    await c.query('DELETE FROM feedback');
    for (const entry of entries) {
      const id = crypto.randomBytes(8).toString('hex');
      await c.query(
        'INSERT INTO feedback (id, data, created_at) VALUES ($1, $2::jsonb, $3)',
        [id, JSON.stringify(entry), entry.createdAt || new Date().toISOString()]
      );
    }
  }));
}

function saveNewsletter(newsletterStore) {
  const emails = (newsletterStore && newsletterStore.emails) || [];
  if (!pgMode) return writeJson('newsletter', newsletterStore);
  chain('newsletter', () => withTx(async (c) => {
    for (const e of emails) {
      const email = e && e.email;
      if (!email) continue;
      await c.query(
        `INSERT INTO newsletter (email, data, created_at) VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (email) DO UPDATE SET data = EXCLUDED.data`,
        [email, JSON.stringify(e), e.createdAt || new Date().toISOString()]
      );
    }
    if (emails.length) {
      await c.query('DELETE FROM newsletter WHERE email <> ALL($1)', [emails.map((e) => e.email).filter(Boolean)]);
    } else {
      await c.query('DELETE FROM newsletter');
    }
  }));
}

function saveQueue(kind, arr) {
  const table = kind === 'video' ? 'video_queue' : 'image_queue';
  if (!pgMode) {
    return writeJson(kind === 'video' ? 'video_queue' : 'image_queue', arr);
  }
  const items = Array.isArray(arr) ? arr : [];
  chain(table, () => withTx(async (c) => {
    await c.query(`DELETE FROM ${table}`);
    for (const q of items) {
      if (!q || !q.id) continue;
      await c.query(
        `INSERT INTO ${table} (id, user_email, prompt, status, created_at, result_url, data, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW())`,
        [
          q.id,
          q.userId || '',
          (q.prompt || '').toString().slice(0, 2000),
          q.status || 'pending',
          q.createdAt || new Date().toISOString(),
          q.resultUrl || null,
          JSON.stringify(q),
        ]
      );
    }
  }));
}

module.exports = {
  init,
  mode,
  saveUsers,
  saveUsage,
  saveCreations,
  saveChat,
  saveFeedback,
  saveNewsletter,
  saveQueue,
};
