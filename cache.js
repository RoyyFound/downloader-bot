// cache.js — cache + statistik bot dengan TTL.
// Backend: MySQL kalau env MYSQL_HOST diset, kalau tidak / koneksi gagal
// fallback ke SQLite lokal (node:sqlite, file cache.db) — bot tetap jalan.
// Yang menyelesaikan "cache numpuk" bukan MySQL-nya, tapi TTL + cleanup:
// tiap baris cache punya expires_at, job cleanup tiap jam hapus yang kedaluwarsa.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TTL_DAYS = Number(process.env.CACHE_TTL_DAYS || '7');
const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000;
const DB_FILE = path.join(__dirname, 'cache.db');

let backend = 'sqlite'; // 'mysql' | 'sqlite'
let mysqlPool = null;
let sqliteDb = null;
let cleanupTimer = null;

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

// ---------- SQLite (fallback, tanpa dependensi luar) ----------
function sqliteInit() {
  const { DatabaseSync } = require('node:sqlite');
  sqliteDb = new DatabaseSync(DB_FILE);
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS dl_cache (
      url_hash TEXT NOT NULL, format TEXT NOT NULL, platform TEXT NOT NULL,
      url TEXT NOT NULL, file_id TEXT NOT NULL, title TEXT DEFAULT '',
      size_bytes INTEGER DEFAULT 0, route TEXT DEFAULT '',
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      PRIMARY KEY (url_hash, format)
    );
    CREATE TABLE IF NOT EXISTS route_stats (
      route TEXT NOT NULL, platform TEXT NOT NULL,
      ok_count INTEGER DEFAULT 0, fail_count INTEGER DEFAULT 0,
      last_ok_at TEXT, last_fail_at TEXT, last_error TEXT DEFAULT '',
      PRIMARY KEY (route, platform)
    );
    CREATE TABLE IF NOT EXISTS users (
      chat_id INTEGER PRIMARY KEY, name TEXT DEFAULT '', first_seen TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stats_daily (
      day TEXT PRIMARY KEY, downloads INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_dl_cache_expires ON dl_cache (expires_at);
  `);
  backend = 'sqlite';
  console.log('CACHE backend=sqlite file=' + DB_FILE + ' ttl=' + TTL_DAYS + ' hari');
}

// ---------- MySQL (kalau env diset) ----------
async function mysqlInit() {
  const mysql = require('mysql2/promise');
  const sslOff = String(process.env.MYSQL_SSL || '').toLowerCase() === 'false';
  mysqlPool = mysql.createPool({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || '3306'),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    connectTimeout: 10000,
    // TLS aktif default (mitigasi GHSA mysql2: downgrade auth ke plaintext).
    // Matikan hanya untuk MySQL lokal tanpa TLS: MYSQL_SSL=false.
    ssl: sslOff ? undefined : { rejectUnauthorized: true },
  });
  await mysqlPool.query('SELECT 1 AS ok');
  await mysqlPool.query(`
    CREATE TABLE IF NOT EXISTS dl_cache (
      url_hash VARCHAR(64) NOT NULL, format VARCHAR(10) NOT NULL, platform VARCHAR(20) NOT NULL,
      url TEXT NOT NULL, file_id TEXT NOT NULL, title VARCHAR(255) DEFAULT '',
      size_bytes BIGINT DEFAULT 0, route VARCHAR(64) DEFAULT '',
      created_at DATETIME NOT NULL, expires_at DATETIME NOT NULL,
      PRIMARY KEY (url_hash, format), INDEX idx_expires (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await mysqlPool.query(`
    CREATE TABLE IF NOT EXISTS route_stats (
      route VARCHAR(64) NOT NULL, platform VARCHAR(20) NOT NULL,
      ok_count INT DEFAULT 0, fail_count INT DEFAULT 0,
      last_ok_at DATETIME NULL, last_fail_at DATETIME NULL, last_error TEXT,
      PRIMARY KEY (route, platform)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await mysqlPool.query(`
    CREATE TABLE IF NOT EXISTS users (
      chat_id BIGINT PRIMARY KEY, name VARCHAR(255) DEFAULT '', first_seen DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await mysqlPool.query(`
    CREATE TABLE IF NOT EXISTS stats_daily (
      day DATE PRIMARY KEY, downloads INT DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  backend = 'mysql';
  console.log('CACHE backend=mysql host=' + process.env.MYSQL_HOST + ' db=' + process.env.MYSQL_DATABASE + ' ttl=' + TTL_DAYS + ' hari');
}

// ---------- query seragam (parameterized — JANGAN string concat) ----------
async function q(sql, params) {
  if (backend === 'mysql') {
    const [rows] = await mysqlPool.query(sql, params);
    return rows;
  }
  const stmt = sqliteDb.prepare(sql);
  if (/^\s*SELECT/i.test(sql)) return stmt.all(...params);
  return stmt.run(...params);
}
function nowSql() {
  if (backend === 'mysql') return new Date().toISOString().slice(0, 19).replace('T', ' ');
  return new Date().toISOString();
}
function todayStr() { return new Date().toISOString().slice(0, 10); }

// ---------- migrasi sekali dari users.json / stats.json lama ----------
async function migrateLegacy() {
  try {
    const usersFile = path.join(__dirname, 'users.json');
    const statsFile = path.join(__dirname, 'stats.json');
    const existing = await q('SELECT COUNT(*) AS n FROM users', []);
    if (Number(existing[0].n) > 0) return; // sudah ada isi — jangan timpa
    if (fs.existsSync(usersFile)) {
      const users = JSON.parse(fs.readFileSync(usersFile, 'utf-8') || '{}');
      for (const [chatId, u] of Object.entries(users)) {
        await q('INSERT INTO users (chat_id, name, first_seen) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)', [Number(chatId), (u && u.name) || '', (u && u.first) || nowSql()]).catch(async () => {
          // SQLite: sintaks upsert beda
          await q('INSERT OR IGNORE INTO users (chat_id, name, first_seen) VALUES (?, ?, ?)', [Number(chatId), (u && u.name) || '', (u && u.first) || nowSql()]);
        });
      }
    }
    if (fs.existsSync(statsFile)) {
      const s = JSON.parse(fs.readFileSync(statsFile, 'utf-8') || '{}');
      if (typeof s.downloads === 'number' && s.downloads > 0) {
        const day = todayStr();
        await q('INSERT INTO stats_daily (day, downloads) VALUES (?, ?) ON DUPLICATE KEY UPDATE downloads = VALUES(downloads)', [day, s.downloads]).catch(async () => {
          await q('INSERT OR REPLACE INTO stats_daily (day, downloads) VALUES (?, ?)', [day, s.downloads]);
        });
      }
    }
    console.log('CACHE migrasi users.json/stats.json selesai');
  } catch (e) {
    console.log('CACHE migrasi gagal (lanjut tanpa migrasi): ' + e.message);
  }
}

// ---------- API cache ----------
async function getCache(platform, url, format) {
  const hash = sha256(url);
  const rows = await q('SELECT * FROM dl_cache WHERE url_hash = ? AND format = ?', [hash, format]);
  if (!rows.length) return null;
  const row = rows[0];
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await q('DELETE FROM dl_cache WHERE url_hash = ? AND format = ?', [hash, format]);
    return null;
  }
  return row;
}

async function setCache(platform, url, format, fileId, title, size, route) {
  const hash = sha256(url);
  const now = nowSql();
  const exp = new Date(Date.now() + TTL_MS);
  const expSql = backend === 'mysql' ? exp.toISOString().slice(0, 19).replace('T', ' ') : exp.toISOString();
  const sql = backend === 'mysql'
    ? 'INSERT INTO dl_cache (url_hash, format, platform, url, file_id, title, size_bytes, route, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE file_id = VALUES(file_id), title = VALUES(title), size_bytes = VALUES(size_bytes), route = VALUES(route), created_at = VALUES(created_at), expires_at = VALUES(expires_at)'
    : 'INSERT OR REPLACE INTO dl_cache (url_hash, format, platform, url, file_id, title, size_bytes, route, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
  await q(sql, [hash, format, platform || '', url, fileId, (title || '').slice(0, 255), size || 0, route || '', now, expSql]);
}

async function recordRoute(route, platform, ok, error) {
  const now = nowSql();
  if (backend === 'mysql') {
    await q(
      'INSERT INTO route_stats (route, platform, ok_count, fail_count, last_ok_at, last_fail_at, last_error) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
      'ON DUPLICATE KEY UPDATE ok_count = ok_count + VALUES(ok_count), fail_count = fail_count + VALUES(fail_count), last_ok_at = COALESCE(VALUES(last_ok_at), last_ok_at), last_fail_at = COALESCE(VALUES(last_fail_at), last_fail_at), last_error = VALUES(last_error)',
      [route, platform || '', ok ? 1 : 0, ok ? 0 : 1, ok ? now : null, ok ? null : now, ok ? '' : String(error || '').slice(0, 500)]
    );
  } else {
    const rows = await q('SELECT * FROM route_stats WHERE route = ? AND platform = ?', [route, platform || '']);
    if (!rows.length) {
      await q('INSERT INTO route_stats (route, platform, ok_count, fail_count, last_ok_at, last_fail_at, last_error) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [route, platform || '', ok ? 1 : 0, ok ? 0 : 1, ok ? now : null, ok ? null : now, ok ? '' : String(error || '').slice(0, 500)]);
    } else {
      await q('UPDATE route_stats SET ok_count = ok_count + ?, fail_count = fail_count + ?, last_ok_at = COALESCE(?, last_ok_at), last_fail_at = COALESCE(?, last_fail_at), last_error = ? WHERE route = ? AND platform = ?',
        [ok ? 1 : 0, ok ? 0 : 1, ok ? now : null, ok ? null : now, ok ? '' : String(error || '').slice(0, 500), route, platform || '']);
    }
  }
}

async function getRouteStats() {
  return q('SELECT * FROM route_stats ORDER BY platform, route', []);
}

async function recordUser(chatId, name) {
  const now = nowSql();
  if (backend === 'mysql') {
    await q('INSERT IGNORE INTO users (chat_id, name, first_seen) VALUES (?, ?, ?)', [Number(chatId), (name || '').slice(0, 255), now]);
  } else {
    await q('INSERT OR IGNORE INTO users (chat_id, name, first_seen) VALUES (?, ?, ?)', [Number(chatId), (name || '').slice(0, 255), now]);
  }
}

async function incDownloads() {
  const day = todayStr();
  if (backend === 'mysql') {
    await q('INSERT INTO stats_daily (day, downloads) VALUES (?, 1) ON DUPLICATE KEY UPDATE downloads = downloads + 1', [day]);
  } else {
    await q('INSERT INTO stats_daily (day, downloads) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET downloads = downloads + 1', [day]);
  }
}

async function getStats() {
  const u = await q('SELECT COUNT(*) AS n FROM users', []);
  const d = await q('SELECT COALESCE(SUM(downloads), 0) AS n FROM stats_daily', []);
  const c = await q('SELECT COUNT(*) AS n FROM dl_cache', []);
  return { backend, users: Number(u[0].n), downloads: Number(d[0].n), cacheRows: Number(c[0].n), ttlDays: TTL_DAYS };
}

// ---------- cleanup: hapus cache kedaluwarsa + file temp tua ----------
async function cleanup() {
  try {
    const res = await q('DELETE FROM dl_cache WHERE expires_at < ?', [nowSql()]);
    const n = res.changes !== undefined ? res.changes : (res.affectedRows || 0);
    if (n) console.log('CACHE cleanup: hapus ' + n + ' baris kedaluwarsa');
  } catch (e) { console.log('CACHE cleanup gagal: ' + e.message); }
  // file temp di tmp_dl yang lebih tua dari 2 jam (sisa crash / gagal kirim)
  try {
    const base = path.join(__dirname, 'tmp_dl');
    if (fs.existsSync(base)) {
      const cutoff = Date.now() - 2 * 60 * 60 * 1000;
      for (const chatDir of fs.readdirSync(base)) {
        const dir = path.join(base, chatDir);
        if (!fs.statSync(dir).isDirectory()) continue;
        for (const f of fs.readdirSync(dir)) {
          const fp = path.join(dir, f);
          try { if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp); } catch (_) {}
        }
        try { if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch (_) {}
      }
    }
  } catch (_) {}
}

async function init() {
  if (process.env.MYSQL_HOST) {
    try { await mysqlInit(); }
    catch (e) {
      console.log('CACHE MySQL gagal (' + e.message + ') — fallback ke SQLite lokal');
      try { if (mysqlPool) await mysqlPool.end().catch(() => {}); } catch (_) {}
      mysqlPool = null;
      sqliteInit();
    }
  } else {
    sqliteInit();
  }
  await migrateLegacy();
  await cleanup();
  cleanupTimer = setInterval(() => { cleanup().catch(() => {}); }, 60 * 60 * 1000);
  return backend;
}

function getBackend() { return backend; }

module.exports = { init, getCache, setCache, recordRoute, getRouteStats, recordUser, incDownloads, getStats, cleanup, getBackend, TTL_DAYS };
