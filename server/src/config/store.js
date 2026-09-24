import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { createClient } from '@libsql/client';
import { getDb } from '../memory/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.SAOS_DATA_DIR || path.resolve(__dirname, '../../data'));
const FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULTS = {
  connection: {
    instanceUrl: '',      // e.g. https://dev12345.service-now.com
    authType: 'basic',    // 'basic' | 'oauth'
    username: '',
    password: '',
    clientId: '',
    clientSecret: '',
  },
  llm: {
    // The set of valid provider names lives in agent/providers/ and NOWHERE
    // else, this comment included. Listing them here would put vendor knowledge
    // in the config layer, and the provider suite asserts that no file outside
    // that directory names one.
    provider: 'anthropic',
    apiKey: '',
    baseUrl: '',                      // optional override; ollama default http://localhost:11434/v1
    model: '',                        // blank = provider default
    // Local embedding model for semantic recall (A-5), reached through the same
    // baseUrl. Blank = nomic-embed-text. If it is not pulled, recall degrades to
    // keyword search and says so — it never pretends to be semantic.
    embedModel: '',
  },
  agent: {
    autoApprove: false,               // when false, every mutating tool call requires user approval
    // WI-8. When a completion contains BOTH a question for the user and
    // mutation-flagged tool calls, hold the calls and surface the question.
    // Default on: the model asking and acting in the same breath means the
    // user is answering a question that was already decided for them.
    holdMutationsOnQuestion: true,
    /*
     * SESSION 2 — WHICH HOSTS MAY BE WRITTEN TO WITHOUT A HUMAN CLICK.
     *
     * `autoApprove` is a single global switch: turn it on and every mutating
     * tool runs ungated, against whatever instance happens to be bound. That is
     * fine for a scripted acceptance run against a disposable PDI and is
     * exactly wrong if the binding later moves to something that matters.
     *
     * `liveHosts` narrows it. Auto-approve is honoured ONLY when the bound
     * host is named here, so switching instances silently disarms it rather
     * than silently carrying it over. Empty by default: on a fresh install,
     * auto-approve authorises nothing until a host is named deliberately.
     *
     * This is a TIGHTENING of an existing permission and never a widening — a
     * host in this list still needs `autoApprove` on, and a human click is
     * unaffected by it entirely.
     */
    liveHosts: [],
  },
  /*
   * E2 Tier 3 — the escalation the agent cannot grant itself.
   *
   * Irreversible schema operations (drop, rename, retype, narrow, truncate)
   * create NO rollback context on any engine. They are refused by default and
   * the refusal is not something the agent may argue its way past: this flag is
   * written ONLY by the Settings route, and no entry in the agent tool catalogue
   * can reach `saveSettings`. `no-settings-write-tool.test.js` asserts that,
   * because the guarantee is the absence of a capability and an absence is
   * exactly what nobody notices being added back.
   *
   * The flag alone is not authorisation. It only makes the gate ASKABLE; the
   * operation still needs a pre-export, a typed confirmation phrase naming the
   * target, and an acknowledged impact report.
   */
  dba: {
    allowIrreversible: false,
  },
  /*
   * K1 — the ServiceNow knowledge base the agent retrieves from.
   *
   * Every default here is deliberately inert. An empty corpus retrieves
   * nothing, and retrieving nothing is reported as "no knowledge indexed"
   * rather than silently producing an empty context block that reads like a
   * confident absence of documentation.
   */
  rag: {
    // Retrieval is read-only and cannot authorise anything (see
    // knowledge/context.js), so it is on by default. Off is for measuring what
    // the agent does WITHOUT it, which is the only way to tell whether it
    // helped.
    enabled: true,
    // Where ingestion reads from. Blank = <server>/data/knowledge. Documents
    // are supplied by the operator: nothing here fetches from the web, because
    // a fabricated URL is worse than a missing one.
    corpusDir: '',
    // How many retrieved chunks reach the system prompt. Small on purpose —
    // the prompt already carries ~100 tool schemas and the fact ledger, and
    // budget.js measures what is actually sent.
    maxContextChunks: 6,
    /*
     * VERSION-AWARE RETRIEVAL, and the one thing this cannot know for itself.
     *
     * "Prefer newer documentation" needs an ordering over ServiceNow release
     * names, and that ordering is not derivable from a document — it is a fact
     * about the platform's release history. Deriving it from the names would
     * be a guess dressed as logic.
     *
     * So it is OPERATOR-SUPPLIED, oldest first, e.g.
     *   ["Vancouver", "Washington DC", "Xanadu"]
     * A release named in a document but absent from this list is not ranked,
     * and retrieval falls back to `updated_at` recency and SAYS SO in its
     * result. Empty by default: no ordering is claimed until someone states one.
     */
    releaseOrder: [],
    /*
     * Extra hosts the operator declares official for their situation: a
     * licensed documentation mirror, an internal proxy, an air-gapped copy.
     *
     * Empty by default, and the ONLY way to widen the source allowlist beyond
     * the vendor's own domain. It is configuration rather than code so that
     * admitting a non-vendor host is a decision someone made and can be shown
     * to have made — see knowledge/sources.js.
     */
    allowedHosts: [],
  },
  /*
   * EXPERIENCE §28/§77 — the skill registry's durable half.
   *
   * §77 says not to create a table by default, and to first inspect whether the
   * existing capability/configuration storage can represent a skill registry.
   * It can, and this is that inspection's answer: a skill is a name, a version,
   * a list of capabilities and an on/off switch — configuration, of exactly the
   * kind this file already holds — so it lives here and the database stays at
   * user_version 23 with no new table.
   *
   * TWO KEYS, AND THE SPLIT MATTERS. `installed` holds user-installed manifests
   * only; the seven built-ins are code (agent/skills/builtin.js) and are never
   * written here, so a settings file cannot redefine a built-in skill or claim
   * built-in trust for one. `disabled` is a list of identities that are OFF —
   * an ABSENCE list rather than a presence list, so §35's "do not delete skill
   * definitions merely to disable them" is the only thing this can express.
   */
  skills: {
    installed: [],
    disabled: [],
  },
};

let cache = null;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
let cloud = null;
let cloudReady = false;
let cloudStatus = { configured: false, ready: false, error: null };

function cloudClient() {
  if (cloud !== null) return cloud;
  const url = process.env.TURSO_DATABASE_URL || '';
  const authToken = process.env.TURSO_AUTH_TOKEN || '';
  cloudStatus.configured = Boolean(url && authToken);
  cloud = url && authToken ? createClient({ url, authToken }) : false;
  return cloud || null;
}

async function ensureCloudSettings() {
  const client = cloudClient();
  if (!client) return null;
  await client.execute(`
    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  return client;
}

export async function initSettingsStore() {
  if (cloudReady) return cache;
  const client = await ensureCloudSettings();
  if (!client) { cloudReady = true; return load(); }
  let rs;
  try {
    rs = await client.execute('SELECT value FROM app_settings WHERE id = 1');
    cloudStatus = { configured: true, ready: true, error: null };
  } catch (err) {
    cloudStatus = { configured: true, ready: false, error: err.message };
    cloudReady = true;
    return load();
  }
  const raw = rs.rows?.[0]?.value;
  if (raw) {
    const parsed = JSON.parse(String(raw));
    cache = {
      connection: { ...DEFAULTS.connection, ...(parsed.connection || {}) },
      llm: { ...DEFAULTS.llm, ...(parsed.llm || {}) },
      agent: { ...DEFAULTS.agent, ...(parsed.agent || {}) },
      dba: { ...DEFAULTS.dba, ...(parsed.dba || {}) },
      rag: { ...DEFAULTS.rag, ...(parsed.rag || {}) },
      skills: { ...DEFAULTS.skills, ...(parsed.skills || {}) },
    };
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
    } catch { /* local cache is optional */ }
  } else {
    const local = load();
    await saveCloudSettings(local);
  }
  cloudReady = true;
  return load();
}

export function settingsStorageStatus() {
  return { ...cloudStatus, localPath: FILE };
}

async function saveCloudSettings(next) {
  const client = await ensureCloudSettings();
  if (!client) return false;
  await client.execute({
    sql: `
      INSERT INTO app_settings (id, value, updated_at)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `,
    args: [JSON.stringify(next), new Date().toISOString()],
  });
  return true;
}

function appDb() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS saos_users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS saos_sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES saos_users(id) ON DELETE CASCADE
    );
  `);
  return db;
}

function persist(next) {
  const db = appDb();
  db.prepare(`
    INSERT INTO app_settings (id, value, updated_at)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(JSON.stringify(next), new Date().toISOString());
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  } catch { /* database is the durable source */ }
  saveCloudSettings(next)
    .then(() => { if (cloudStatus.configured) cloudStatus = { configured: true, ready: true, error: null }; })
    .catch((err) => { cloudStatus = { configured: true, ready: false, error: err.message }; });
}

function load() {
  if (cache) return cache;
  try {
    const raw = appDb().prepare('SELECT value FROM app_settings WHERE id = 1').get()?.value
      || fs.readFileSync(FILE, 'utf8');
    const parsed = JSON.parse(raw);
    cache = {
      connection: { ...DEFAULTS.connection, ...(parsed.connection || {}) },
      llm: { ...DEFAULTS.llm, ...(parsed.llm || {}) },
      agent: { ...DEFAULTS.agent, ...(parsed.agent || {}) },
      dba: { ...DEFAULTS.dba, ...(parsed.dba || {}) },
      rag: { ...DEFAULTS.rag, ...(parsed.rag || {}) },
      skills: { ...DEFAULTS.skills, ...(parsed.skills || {}) },
    };
  } catch {
    cache = JSON.parse(JSON.stringify(DEFAULTS));
  }
  return cache;
}

export function getSettings() {
  return load();
}

/**
 * Test seam, mirroring `_setDbForTests` in memory/db.js.
 *
 * The offline suite has to pin `agent.autoApprove` and `agent.holdMutations-
 * OnQuestion` to assert what the gate does, and pin `llm.model` to '' so the
 * context-window probe returns its fallback instead of reaching for a daemon.
 * Reading the developer's real `settings.json` would make those tests pass or
 * fail on whatever that file happens to hold, and writing to it to fix that
 * would be worse.
 *
 * Merged over the defaults, never over what is on disk, so a test states its
 * whole world rather than inheriting half of one.
 */
export function _setSettingsForTests(patch) {
  if (!patch) { cache = null; return null; }
  cache = {
    connection: { ...DEFAULTS.connection, ...(patch.connection || {}) },
    llm: { ...DEFAULTS.llm, ...(patch.llm || {}) },
    agent: { ...DEFAULTS.agent, ...(patch.agent || {}) },
    dba: { ...DEFAULTS.dba, ...(patch.dba || {}) },
    rag: { ...DEFAULTS.rag, ...(patch.rag || {}) },
    skills: { ...DEFAULTS.skills, ...(patch.skills || {}) },
  };
  return cache;
}

/**
 * Credentials arrive by paste, and pastes bring passengers. A stored password
 * once carried four embedded spaces — a password plus trailing text copied from
 * the same line — which produced nothing but "User is not authenticated" with
 * no clue why. Trim the obvious damage, and report what we cannot safely fix.
 */
const TRIMMED_FIELDS = ['instanceUrl', 'username', 'password', 'clientId', 'clientSecret'];

function sanitizeConnection(conn) {
  const out = { ...conn };
  for (const f of TRIMMED_FIELDS) {
    if (typeof out[f] === 'string') out[f] = out[f].trim();
  }
  if (typeof out.instanceUrl === 'string') out.instanceUrl = out.instanceUrl.replace(/\/+$/, '');
  return out;
}

/** Non-fatal problems worth showing the user rather than silently storing. */
export function credentialWarnings(conn) {
  const warnings = [];
  const check = (label, value) => {
    if (typeof value !== 'string' || !value) return;
    if (/\s/.test(value)) {
      warnings.push(`${label} contains a space. Passwords rarely do — check you didn't paste extra text along with it.`);
    } else if (/[^\x21-\x7e]/.test(value)) {
      warnings.push(`${label} contains a non-standard character (a smart quote or non-breaking space often sneaks in when copying from a web page).`);
    }
  };
  check('The password', conn.password);
  check('The client secret', conn.clientSecret);
  if (conn.username && /\s/.test(conn.username)) warnings.push('The username contains a space.');
  if (conn.instanceUrl && !/^https?:\/\//i.test(conn.instanceUrl)) {
    warnings.push('The instance URL should start with https://');
  }
  return warnings;
}

/*
 * B6 — the instance-switch handler.
 *
 * Registered by the binding module at boot rather than imported here, because
 * `config/store.js` is the lowest layer in the app and must not depend on
 * anything that reads settings — that would be a cycle, and this file is loaded
 * by the offline suite in isolation.
 *
 * Fires AFTER the new config is durable. If it threw, the app would be left
 * with new settings and old caches, which is the worst of both.
 */
let bindingHook = null;

export function _setBindingHook(fn) {
  bindingHook = fn;
}

function announceBinding() {
  if (!bindingHook) return null;
  try { return bindingHook(); } catch { return null; }
}

export function saveSettings(patch) {
  const cur = load();
  const next = {
    connection: sanitizeConnection({ ...cur.connection, ...(patch.connection || {}) }),
    llm: { ...cur.llm, ...(patch.llm || {}) },
    agent: { ...cur.agent, ...(patch.agent || {}) },
    dba: { ...cur.dba, ...(patch.dba || {}) },
    rag: { ...cur.rag, ...(patch.rag || {}) },
    skills: { ...cur.skills, ...(patch.skills || {}) },
  };
  persist(next);
  cache = next;
  announceBinding();
  return next;
}

/**
 * EXPERIENCE §28 — persist ONLY the skill registry.
 *
 * A separate writer rather than a `saveSettings({ skills })` call, for two
 * reasons that are both about blast radius.
 *
 * It does not announce a binding. `saveSettings` fires the instance-switch hook
 * because changing `connection` invalidates every cache that read it; toggling
 * a skill changes nothing about the instance, and re-announcing on every toggle
 * would rebuild schema caches for no reason.
 *
 * It does not touch `connection`. Skills are edited from a skills route, and a
 * writer that could reach the credential block from there would be one more
 * path by which a password could be rewritten by something that had no business
 * near it. This one structurally cannot: it copies `cur` and replaces a single
 * key.
 */
export function saveSkills(skills) {
  const cur = load();
  const next = { ...cur, skills: { ...cur.skills, ...(skills || {}) } };
  persist(next);
  cache = next;
  return next.skills;
}

/** Clears the bound instance and its secrets. The LLM settings are unrelated and stay. */
export function clearConnection() {
  const cur = load();
  const next = { ...cur, connection: { ...DEFAULTS.connection } };
  persist(next);
  cache = next;
  announceBinding();
  return next;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [, salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const actual = Buffer.from(hashPassword(password, salt).split(':')[2], 'hex');
  const expected = Buffer.from(hash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function publicUser(row) {
  return row ? { id: row.id, name: row.name, email: row.email } : null;
}

export function hasSaosUser() {
  return Boolean(appDb().prepare('SELECT 1 FROM saos_users LIMIT 1').get());
}

export function createSaosUser({ name, email, password }) {
  const cleanName = String(name || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanName) throw Object.assign(new Error('Name is required.'), { status: 400 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw Object.assign(new Error('A valid email address is required.'), { status: 400 });
  }
  if (String(password || '').length < 8) {
    throw Object.assign(new Error('Password must be at least 8 characters.'), { status: 400 });
  }
  const db = appDb();
  const now = new Date().toISOString();
  const user = { id: crypto.randomUUID(), name: cleanName, email: cleanEmail };
  try {
    db.prepare(`
      INSERT INTO saos_users (id, name, email, password_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(user.id, user.name, user.email, hashPassword(password), now, now);
  } catch (err) {
    if (/UNIQUE/i.test(err.message)) throw Object.assign(new Error('That email is already registered.'), { status: 409 });
    throw err;
  }
  return { user, session: createSaosSession(user.id) };
}

export function createSaosSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_MS);
  appDb().prepare('INSERT INTO saos_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, now.toISOString(), expires.toISOString());
  return { token, expiresAt: expires.toISOString() };
}

export function loginSaosUser({ email, password }) {
  const row = appDb().prepare('SELECT * FROM saos_users WHERE email = ?').get(String(email || '').trim().toLowerCase());
  if (!row || !verifyPassword(password, row.password_hash)) {
    throw Object.assign(new Error('Invalid email or password.'), { status: 401 });
  }
  return { user: publicUser(row), session: createSaosSession(row.id) };
}

export function userForSaosToken(token) {
  if (!token) return null;
  const row = appDb().prepare(`
    SELECT u.id, u.name, u.email, s.expires_at
      FROM saos_sessions s JOIN saos_users u ON u.id = s.user_id
     WHERE s.token = ?
  `).get(token);
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) {
    appDb().prepare('DELETE FROM saos_sessions WHERE token = ?').run(token);
    return null;
  }
  return publicUser(row);
}

export function logoutSaosToken(token) {
  if (token) appDb().prepare('DELETE FROM saos_sessions WHERE token = ?').run(token);
}

/** Redacts secrets for sending to the client. */
export function publicSettings() {
  const s = load();
  return {
    connection: {
      instanceUrl: s.connection.instanceUrl,
      authType: s.connection.authType,
      username: s.connection.username,
      hasPassword: Boolean(s.connection.password),
      clientId: s.connection.clientId,
      hasClientSecret: Boolean(s.connection.clientSecret),
      // Surfaced so an already-saved bad credential is visible without a probe.
      warnings: credentialWarnings(s.connection),
    },
    llm: {
      provider: s.llm.provider,
      hasApiKey: Boolean(s.llm.apiKey),
      baseUrl: s.llm.baseUrl,
      model: s.llm.model,
      embedModel: s.llm.embedModel,
    },
    agent: {
      autoApprove: s.agent.autoApprove,
      holdMutationsOnQuestion: s.agent.holdMutationsOnQuestion !== false,
      liveHosts: Array.isArray(s.agent?.liveHosts) ? s.agent.liveHosts : [],
    },
    dba: { allowIrreversible: s.dba?.allowIrreversible === true },
    rag: {
      enabled: s.rag?.enabled !== false,
      corpusDir: s.rag?.corpusDir || '',
      maxContextChunks: s.rag?.maxContextChunks ?? DEFAULTS.rag.maxContextChunks,
      releaseOrder: Array.isArray(s.rag?.releaseOrder) ? s.rag.releaseOrder : [],
      allowedHosts: Array.isArray(s.rag?.allowedHosts) ? s.rag.allowedHosts : [],
    },
  };
}
