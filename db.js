const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const USERS_DB_DIR = path.join(DATA_DIR, "udb");
const CORE_NAME_FILE = path.join(DATA_DIR, "core.name");

let coreDb = null;
let coreDbPath = null;
const userDbCache = new Map();

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_DB_DIR)) fs.mkdirSync(USERS_DB_DIR, { recursive: true });
}

function random8() {
  return String(Math.floor(10000000 + Math.random() * 90000000));
}

function atomicWrite(filePath, data) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

function openDb(filePath) {
  const db = new DatabaseSync(filePath);
  db.exec("PRAGMA journal_mode = DELETE;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");
  return db;
}

function initCoreSchema(db) {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);");
  db.exec("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, salt TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, db_name TEXT NOT NULL UNIQUE);");
  db.exec("CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL, FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);");
  db.exec("CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  db.exec("CREATE TABLE IF NOT EXISTS books (id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT DEFAULT '', format TEXT NOT NULL, filename TEXT, cover_file TEXT, added_at INTEGER NOT NULL, chapters_count INTEGER DEFAULT 0, page_count INTEGER DEFAULT 0, series TEXT DEFAULT '', year INTEGER, description TEXT DEFAULT '', is_private INTEGER NOT NULL DEFAULT 0, owner_id INTEGER, owner_name TEXT);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_books_owner ON books(owner_id);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires);");
}

function initUserSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS book_state (
      book_id TEXT PRIMARY KEY,
      progress REAL NOT NULL DEFAULT 0,
      chapter_index INTEGER NOT NULL DEFAULT 0,
      char_offset INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'queue',
      last_tts TEXT,
      updated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS bookmarks (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      chapter_index INTEGER NOT NULL,
      char_offset INTEGER NOT NULL,
      label TEXT DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bm_book ON bookmarks(book_id);
  `);
}

function getCoreDbPath() {
  ensureDirs();
  if (coreDbPath) return coreDbPath;
  if (fs.existsSync(CORE_NAME_FILE)) {
    const name = fs.readFileSync(CORE_NAME_FILE, "utf8").trim();
    if (/^\d{8}$/.test(name)) {
      coreDbPath = path.join(DATA_DIR, `c${name}.sqlite`);
      return coreDbPath;
    }
  }
  const name = random8();
  atomicWrite(CORE_NAME_FILE, name);
  coreDbPath = path.join(DATA_DIR, `c${name}.sqlite`);
  return coreDbPath;
}

function getCore() {
  if (coreDb) return coreDb;
  const p = getCoreDbPath();
  const isNew = !fs.existsSync(p);
  coreDb = openDb(p);
  initCoreSchema(coreDb);
  if (isNew) {
    coreDb.prepare("INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)").run("localhostOnly", "1");
    coreDb.prepare("INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)").run("registrationDisabled", "0");
  }
  return coreDb;
}

function userDbPath(dbName) {
  return path.join(USERS_DB_DIR, `u${dbName}.sqlite`);
}

function getUserDb(dbName) {
  if (!dbName || !/^\d{8}$/.test(dbName)) throw new Error("invalid user db name");
  if (userDbCache.has(dbName)) return userDbCache.get(dbName);
  const p = userDbPath(dbName);
  const isNew = !fs.existsSync(p);
  const db = openDb(p);
  initUserSchema(db);
  userDbCache.set(dbName, db);
  return db;
}

function closeUserDb(dbName) {
  const db = userDbCache.get(dbName);
  if (db) {
    try { db.close(); } catch (_) {}
    userDbCache.delete(dbName);
  }
}

function closeAll() {
  for (const [name, db] of userDbCache) {
    try { db.close(); } catch (_) {}
  }
  userDbCache.clear();
  if (coreDb) {
    try { coreDb.close(); } catch (_) {}
    coreDb = null;
  }
}

function loadAccessConfig() {
  const db = getCore();
  const rows = db.prepare("SELECT key, value FROM config").all();
  const cfg = { localhostOnly: true, registrationDisabled: false };
  for (const r of rows) {
    if (r.key === "localhostOnly") cfg.localhostOnly = r.value !== "0";
    if (r.key === "registrationDisabled") cfg.registrationDisabled = r.value === "1";
  }
  return cfg;
}

function saveAccessConfig(cfg) {
  const db = getCore();
  const stmt = db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)");
  stmt.run("localhostOnly", cfg.localhostOnly !== false ? "1" : "0");
  stmt.run("registrationDisabled", cfg.registrationDisabled ? "1" : "0");
  return loadAccessConfig();
}

function loadUsers() {
  const db = getCore();
  return db.prepare("SELECT id, username, password_hash AS passwordHash, salt, is_admin AS isAdmin, created_at AS createdAt, db_name AS dbName FROM users ORDER BY id").all().map((u) => ({
    id: u.id,
    username: u.username,
    passwordHash: u.passwordHash,
    salt: u.salt,
    isAdmin: !!u.isAdmin,
    createdAt: u.createdAt,
    dbName: u.dbName,
  }));
}

function findUserByUsername(username) {
  const name = String(username || "").trim().toLowerCase();
  const db = getCore();
  const u = db.prepare("SELECT id, username, password_hash AS passwordHash, salt, is_admin AS isAdmin, created_at AS createdAt, db_name AS dbName FROM users WHERE lower(username) = ?").get(name);
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    passwordHash: u.passwordHash,
    salt: u.salt,
    isAdmin: !!u.isAdmin,
    createdAt: u.createdAt,
    dbName: u.dbName,
  };
}

function findUserById(id) {
  const db = getCore();
  const u = db.prepare("SELECT id, username, password_hash AS passwordHash, salt, is_admin AS isAdmin, created_at AS createdAt, db_name AS dbName FROM users WHERE id = ?").get(id);
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    passwordHash: u.passwordHash,
    salt: u.salt,
    isAdmin: !!u.isAdmin,
    createdAt: u.createdAt,
    dbName: u.dbName,
  };
}

function createUser({ username, passwordHash, salt, isAdmin }) {
  const db = getCore();
  const dbName = random8();
  let id;
  const max = db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM users").get();
  id = (max && max.m ? max.m : 0) + 1;
  db.prepare(
    "INSERT INTO users (id, username, password_hash, salt, is_admin, created_at, db_name) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, username, passwordHash, salt, isAdmin ? 1 : 0, Date.now(), dbName);
  getUserDb(dbName);
  return findUserById(id);
}

function updateUserPassword(id, passwordHash, salt) {
  const db = getCore();
  db.prepare("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?").run(passwordHash, salt, id);
}

function setUserAdmin(id, isAdmin) {
  const db = getCore();
  db.prepare("UPDATE users SET is_admin = ? WHERE id = ?").run(isAdmin ? 1 : 0, id);
  return findUserById(id);
}

function deleteUser(id) {
  const user = findUserById(id);
  if (!user) return false;
  const db = getCore();
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
  closeUserDb(user.dbName);
  const p = userDbPath(user.dbName);
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
    const wal = p + "-wal";
    const shm = p + "-shm";
    if (fs.existsSync(wal)) fs.unlinkSync(wal);
    if (fs.existsSync(shm)) fs.unlinkSync(shm);
  } catch (_) {}
  return true;
}

function loadSessions() {
  const db = getCore();
  const now = Date.now();
  db.prepare("DELETE FROM sessions WHERE expires <= ?").run(now);
  const rows = db.prepare("SELECT sid, user_id AS userId, expires FROM sessions WHERE expires > ?").all(now);
  const map = new Map();
  for (const r of rows) {
    map.set(r.sid, { userId: r.userId, expires: r.expires });
  }
  return map;
}

function saveSession(sid, userId, expires) {
  const db = getCore();
  db.prepare("INSERT OR REPLACE INTO sessions (sid, user_id, expires) VALUES (?, ?, ?)").run(sid, userId, expires);
}

function deleteSession(sid) {
  const db = getCore();
  db.prepare("DELETE FROM sessions WHERE sid = ?").run(sid);
}

function deleteSessionsForUser(userId) {
  const db = getCore();
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

function loadBooks() {
  const db = getCore();
  return db.prepare(`
    SELECT id, title, author, format, filename, cover_file AS coverFile,
           added_at AS addedAt, chapters_count AS chaptersCount, page_count AS pageCount,
           series, year, description, is_private AS isPrivate, owner_id AS ownerId, owner_name AS ownerName
    FROM books ORDER BY added_at DESC
  `).all().map((b) => ({
    id: b.id,
    title: b.title,
    author: b.author || "",
    format: b.format,
    filename: b.filename || null,
    coverFile: b.coverFile || null,
    addedAt: b.addedAt,
    chaptersCount: b.chaptersCount || 0,
    pageCount: b.pageCount || 0,
    series: b.series || "",
    year: b.year != null ? b.year : null,
    description: b.description || "",
    isPrivate: !!b.isPrivate,
    ownerId: b.ownerId != null ? b.ownerId : null,
    ownerName: b.ownerName || null,
  }));
}

function getBookById(id) {
  const db = getCore();
  const b = db.prepare(`
    SELECT id, title, author, format, filename, cover_file AS coverFile,
           added_at AS addedAt, chapters_count AS chaptersCount, page_count AS pageCount,
           series, year, description, is_private AS isPrivate, owner_id AS ownerId, owner_name AS ownerName
    FROM books WHERE id = ?
  `).get(id);
  if (!b) return null;
  return {
    id: b.id,
    title: b.title,
    author: b.author || "",
    format: b.format,
    filename: b.filename || null,
    coverFile: b.coverFile || null,
    addedAt: b.addedAt,
    chaptersCount: b.chaptersCount || 0,
    pageCount: b.pageCount || 0,
    series: b.series || "",
    year: b.year != null ? b.year : null,
    description: b.description || "",
    isPrivate: !!b.isPrivate,
    ownerId: b.ownerId != null ? b.ownerId : null,
    ownerName: b.ownerName || null,
  };
}

function insertBook(book) {
  const db = getCore();
  db.prepare(`
    INSERT INTO books (
      id, title, author, format, filename, cover_file, added_at,
      chapters_count, page_count, series, year, description, is_private, owner_id, owner_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    book.id,
    book.title,
    book.author || "",
    book.format,
    book.filename || null,
    book.coverFile || null,
    book.addedAt || Date.now(),
    book.chaptersCount || 0,
    book.pageCount || 0,
    book.series || "",
    book.year != null ? book.year : null,
    book.description || "",
    book.isPrivate ? 1 : 0,
    book.ownerId != null ? book.ownerId : null,
    book.ownerName || null
  );
  return getBookById(book.id);
}

function updateBook(id, fields) {
  const allowed = {
    title: "title",
    author: "author",
    series: "series",
    year: "year",
    description: "description",
    isPrivate: "is_private",
    chaptersCount: "chapters_count",
    pageCount: "page_count",
    coverFile: "cover_file",
    filename: "filename",
  };
  const sets = [];
  const vals = [];
  for (const [k, col] of Object.entries(allowed)) {
    if (fields[k] !== undefined) {
      sets.push(`${col} = ?`);
      if (k === "isPrivate") vals.push(fields[k] ? 1 : 0);
      else vals.push(fields[k]);
    }
  }
  if (!sets.length) return getBookById(id);
  vals.push(id);
  const db = getCore();
  db.prepare(`UPDATE books SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
  return getBookById(id);
}

function deleteBook(id) {
  const db = getCore();
  db.prepare("DELETE FROM books WHERE id = ?").run(id);
}

function deleteBooksByOwner(ownerId) {
  const db = getCore();
  const rows = db.prepare("SELECT id FROM books WHERE owner_id = ?").all(ownerId);
  db.prepare("DELETE FROM books WHERE owner_id = ?").run(ownerId);
  return rows.map((r) => r.id);
}

function getUserBookState(user, bookId) {
  if (!user || !user.dbName) {
    return {
      progress: 0,
      chapterIndex: 0,
      charOffset: 0,
      status: "queue",
      bookmarks: [],
      lastTts: null,
    };
  }
  const db = getUserDb(user.dbName);
  const st = db.prepare(
    "SELECT progress, chapter_index AS chapterIndex, char_offset AS charOffset, status, last_tts AS lastTts FROM book_state WHERE book_id = ?"
  ).get(bookId);
  const bookmarks = db.prepare(
    "SELECT id, book_id AS bookId, chapter_index AS chapterIndex, char_offset AS charOffset, label, created_at AS createdAt FROM bookmarks WHERE book_id = ? ORDER BY created_at DESC"
  ).all(bookId);
  if (!st) {
    return {
      progress: 0,
      chapterIndex: 0,
      charOffset: 0,
      status: "queue",
      bookmarks: bookmarks || [],
      lastTts: null,
    };
  }
  return {
    progress: st.progress || 0,
    chapterIndex: st.chapterIndex || 0,
    charOffset: st.charOffset || 0,
    status: st.status || "queue",
    bookmarks: bookmarks || [],
    lastTts: st.lastTts ? (() => { try { return JSON.parse(st.lastTts); } catch { return null; } })() : null,
  };
}

function setUserBookState(user, bookId, state) {
  if (!user || !user.dbName) return;
  const db = getUserDb(user.dbName);
  const lastTts = state.lastTts != null ? JSON.stringify(state.lastTts) : null;
  db.prepare(`
    INSERT INTO book_state (book_id, progress, chapter_index, char_offset, status, last_tts, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(book_id) DO UPDATE SET
      progress = excluded.progress,
      chapter_index = excluded.chapter_index,
      char_offset = excluded.char_offset,
      status = excluded.status,
      last_tts = excluded.last_tts,
      updated_at = excluded.updated_at
  `).run(
    bookId,
    state.progress != null ? state.progress : 0,
    state.chapterIndex != null ? state.chapterIndex : 0,
    state.charOffset != null ? state.charOffset : 0,
    state.status || "queue",
    lastTts,
    Date.now()
  );
}

function addBookmark(user, bookId, bm) {
  if (!user || !user.dbName) return null;
  const db = getUserDb(user.dbName);
  db.prepare(
    "INSERT INTO bookmarks (id, book_id, chapter_index, char_offset, label, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(bm.id, bookId, bm.chapterIndex, bm.charOffset, bm.label || "", bm.createdAt || Date.now());
  const count = db.prepare("SELECT COUNT(*) AS c FROM bookmarks WHERE book_id = ?").get(bookId);
  if (count && count.c > 50) {
    db.prepare(`
      DELETE FROM bookmarks WHERE id IN (
        SELECT id FROM bookmarks WHERE book_id = ? ORDER BY created_at ASC LIMIT ?
      )
    `).run(bookId, count.c - 50);
  }
  return bm;
}

function deleteBookmark(user, bookId, bmId) {
  if (!user || !user.dbName) return false;
  const db = getUserDb(user.dbName);
  db.prepare("DELETE FROM bookmarks WHERE id = ? AND book_id = ?").run(bmId, bookId);
  return true;
}

function migrateFromJson() {
  ensureDirs();
  const usersFile = path.join(DATA_DIR, "users.json");
  const configFile = path.join(DATA_DIR, "config.json");
  const sessionsFile = path.join(DATA_DIR, "sessions.json");
  const libraryFile = path.join(ROOT, "books", "library.json");

  const db = getCore();
  const userCount = db.prepare("SELECT COUNT(*) AS c FROM users").get();
  if (userCount && userCount.c > 0) return { migrated: false, reason: "already has users" };

  let migratedUsers = 0;
  let migratedBooks = 0;
  let migratedStates = 0;

  if (fs.existsSync(configFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(configFile, "utf8"));
      saveAccessConfig({
        localhostOnly: raw.localhostOnly !== false,
        registrationDisabled: !!raw.registrationDisabled,
      });
    } catch (_) {}
  }

  const oldUsers = [];
  if (fs.existsSync(usersFile)) {
    try {
      const arr = JSON.parse(fs.readFileSync(usersFile, "utf8"));
      if (Array.isArray(arr)) oldUsers.push(...arr);
    } catch (_) {}
  }

  const idToUser = new Map();
  for (const u of oldUsers) {
    const dbName = random8();
    const id = u.id;
    db.prepare(
      "INSERT OR IGNORE INTO users (id, username, password_hash, salt, is_admin, created_at, db_name) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(id, u.username, u.passwordHash, u.salt, u.isAdmin ? 1 : 0, u.createdAt || Date.now(), dbName);
    const created = findUserById(id);
    if (created) {
      idToUser.set(id, created);
      getUserDb(created.dbName);
      migratedUsers++;
    }
  }

  if (fs.existsSync(sessionsFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
      const now = Date.now();
      for (const [sid, s] of Object.entries(raw || {})) {
        if (s && s.userId != null && s.expires > now) {
          saveSession(sid, s.userId, s.expires);
        }
      }
    } catch (_) {}
  }

  if (fs.existsSync(libraryFile)) {
    try {
      const lib = JSON.parse(fs.readFileSync(libraryFile, "utf8"));
      if (Array.isArray(lib)) {
        for (const b of lib) {
          insertBook({
            id: b.id,
            title: b.title || "Без названия",
            author: b.author || "",
            format: b.format || "txt",
            filename: b.filename || null,
            coverFile: b.coverFile || null,
            addedAt: b.addedAt || Date.now(),
            chaptersCount: b.chaptersCount || 0,
            pageCount: b.pageCount || 0,
            series: b.series || "",
            year: b.year != null ? b.year : null,
            description: b.description || "",
            isPrivate: !!b.isPrivate,
            ownerId: b.ownerId != null ? b.ownerId : null,
            ownerName: b.ownerName || null,
          });
          migratedBooks++;

          if (b.userState && typeof b.userState === "object") {
            for (const [uid, st] of Object.entries(b.userState)) {
              const user = idToUser.get(Number(uid)) || findUserById(Number(uid));
              if (!user) continue;
              setUserBookState(user, b.id, {
                progress: st.progress || 0,
                chapterIndex: st.chapterIndex || 0,
                charOffset: st.charOffset || 0,
                status: st.status || "queue",
                lastTts: st.lastTts || null,
              });
              if (Array.isArray(st.bookmarks)) {
                for (const bm of st.bookmarks) {
                  if (bm && bm.id) {
                    addBookmark(user, b.id, {
                      id: bm.id,
                      chapterIndex: bm.chapterIndex || 0,
                      charOffset: bm.charOffset || 0,
                      label: bm.label || "",
                      createdAt: bm.createdAt || Date.now(),
                    });
                  }
                }
              }
              migratedStates++;
            }
          }
        }
      }
    } catch (_) {}
  }

  try {
    if (fs.existsSync(usersFile)) fs.renameSync(usersFile, usersFile + ".migrated");
    if (fs.existsSync(configFile)) fs.renameSync(configFile, configFile + ".migrated");
    if (fs.existsSync(sessionsFile)) fs.renameSync(sessionsFile, sessionsFile + ".migrated");
    if (fs.existsSync(libraryFile)) fs.renameSync(libraryFile, libraryFile + ".migrated");
  } catch (_) {}

  return { migrated: true, migratedUsers, migratedBooks, migratedStates };
}

function listDbFiles() {
  ensureDirs();
  const files = [];
  const core = getCoreDbPath();
  if (fs.existsSync(core)) files.push(core);
  if (fs.existsSync(CORE_NAME_FILE)) files.push(CORE_NAME_FILE);
  if (fs.existsSync(USERS_DB_DIR)) {
    for (const name of fs.readdirSync(USERS_DB_DIR)) {
      if (name.endsWith(".sqlite") || name.endsWith(".sqlite-wal") || name.endsWith(".sqlite-shm")) {
        files.push(path.join(USERS_DB_DIR, name));
      }
    }
  }
  return files;
}


function getBooksByOwner(ownerId, ownerName) {
  const all = loadBooks();
  const id = ownerId != null ? Number(ownerId) : null;
  const name = ownerName ? String(ownerName).toLowerCase() : "";
  return all.filter((b) => {
    if (b.ownerId != null && b.ownerId !== "" && !Number.isNaN(Number(b.ownerId))) {
      return Number(b.ownerId) === id;
    }
    if (name && b.ownerName && String(b.ownerName).toLowerCase() === name) return true;
    if ((b.ownerId == null || b.ownerId === "") && id === 1) return true;
    return false;
  });
}

module.exports = {
  getCore,
  getUserDb,
  closeAll,
  loadAccessConfig,
  saveAccessConfig,
  loadUsers,
  findUserByUsername,
  findUserById,
  createUser,
  updateUserPassword,
  setUserAdmin,
  deleteUser,
  loadSessions,
  saveSession,
  deleteSession,
  deleteSessionsForUser,
  loadBooks,
  getBooksByOwner,
  getBookById,
  insertBook,
  updateBook,
  deleteBook,
  deleteBooksByOwner,
  getUserBookState,
  setUserBookState,
  addBookmark,
  deleteBookmark,
  migrateFromJson,
  listDbFiles,
  random8,
};
