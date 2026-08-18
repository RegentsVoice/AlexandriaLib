const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const db = require("./db");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const SESSION_SECRET_FILE = path.join(DATA_DIR, "session.secret");

const SESSION_COOKIE = "al_sid";
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

const sessions = new Map();

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getSessionSecret() {
  ensureDataDir();
  if (fs.existsSync(SESSION_SECRET_FILE)) {
    return fs.readFileSync(SESSION_SECRET_FILE, "utf8").trim();
  }
  const secret = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(SESSION_SECRET_FILE, secret, "utf8");
  return secret;
}

const SESSION_SECRET = getSessionSecret();

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto
    .scryptSync(password, s, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
    .toString("hex");
  return { salt: s, hash };
}

function verifyPassword(password, salt, expectedHash) {
  try {
    const { hash } = hashPassword(password, salt);
    const a = Buffer.from(hash, "hex");
    const b = Buffer.from(expectedHash, "hex");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    isAdmin: !!u.isAdmin,
    createdAt: u.createdAt,
  };
}

function loadAccessConfig() {
  return db.loadAccessConfig();
}

function saveAccessConfig(cfg) {
  return db.saveAccessConfig(cfg);
}

function getAccessConfig() {
  return db.loadAccessConfig();
}

function loadUsers() {
  return db.loadUsers();
}

function findUserByUsername(username) {
  return db.findUserByUsername(username);
}

function findUserById(id) {
  return db.findUserById(id);
}

function registerUser(username, password) {
  username = String(username || "").trim();
  password = String(password || "");
  if (!username || username.length < 2) {
    return { error: "Имя пользователя: минимум 2 символа", status: 400 };
  }
  if (username.length > 32) {
    return { error: "Имя пользователя слишком длинное", status: 400 };
  }
  if (!/^[a-zA-Z0-9_\u0400-\u04FF.-]+$/.test(username)) {
    return { error: "Имя: только буквы, цифры, _ . -", status: 400 };
  }
  if (password.length < 4) {
    return { error: "Пароль: минимум 4 символа", status: 400 };
  }
  if (findUserByUsername(username)) {
    return { error: "Такой пользователь уже есть", status: 400 };
  }

  const users = loadUsers();
  const isFirst = users.length === 0;
  const { salt, hash } = hashPassword(password);
  const user = db.createUser({
    username,
    passwordHash: hash,
    salt,
    isAdmin: isFirst,
  });
  return { user: publicUser(user) };
}

function loginUser(username, password) {
  const user = findUserByUsername(username);
  if (!user || !verifyPassword(password, user.salt, user.passwordHash)) {
    return { error: "Неверный логин или пароль", status: 401 };
  }
  return { user: publicUser(user) };
}

function reloadSessions() {
  sessions.clear();
  const map = db.loadSessions();
  for (const [sid, s] of map) {
    sessions.set(sid, s);
  }
}

reloadSessions();

function createSession(userId) {
  const sid = crypto.randomBytes(24).toString("hex");
  const expires = Date.now() + SESSION_TTL_MS;
  sessions.set(sid, { userId, expires });
  db.saveSession(sid, userId, expires);
  return { sid, expires };
}

function destroySession(sid) {
  if (sid) {
    sessions.delete(sid);
    db.deleteSession(sid);
  }
}

function destroySessionsForUser(userId) {
  for (const [sid, s] of sessions.entries()) {
    if (s.userId === userId) sessions.delete(sid);
  }
  db.deleteSessionsForUser(userId);
}

function getSession(sid) {
  if (!sid) return null;
  let s = sessions.get(sid);
  if (!s) {
    reloadSessions();
    s = sessions.get(sid);
  }
  if (!s) return null;
  if (Date.now() > s.expires) {
    sessions.delete(sid);
    db.deleteSession(sid);
    return null;
  }
  return s;
}

function changePassword(userId, oldPassword, newPassword) {
  const user = findUserById(userId);
  if (!user) return { error: "Пользователь не найден", status: 404 };
  if (!verifyPassword(oldPassword, user.salt, user.passwordHash)) {
    return { error: "Неверный текущий пароль", status: 400 };
  }
  if (!newPassword || String(newPassword).length < 4) {
    return { error: "Новый пароль: минимум 4 символа", status: 400 };
  }
  const { salt, hash } = hashPassword(String(newPassword));
  db.updateUserPassword(userId, hash, salt);
  return { ok: true };
}

function adminSetPassword(targetId, newPassword, actorId) {
  const target = findUserById(targetId);
  if (!target) return { error: "Пользователь не найден", status: 404 };
  if (!newPassword || String(newPassword).length < 4) {
    return { error: "Пароль: минимум 4 символа", status: 400 };
  }
  const { salt, hash } = hashPassword(String(newPassword));
  db.updateUserPassword(targetId, hash, salt);
  destroySessionsForUser(targetId);
  return { ok: true };
}

function setUserAdminFlag(targetId, isAdmin, actorId) {
  const target = findUserById(targetId);
  if (!target) return { error: "Пользователь не найден", status: 404 };
  if (targetId === actorId && !isAdmin) {
    return { error: "Нельзя снять админку с себя", status: 400 };
  }
  const users = loadUsers();
  const admins = users.filter((u) => u.isAdmin);
  if (target.isAdmin && !isAdmin && admins.length <= 1) {
    return { error: "Должен остаться хотя бы один админ", status: 400 };
  }
  const updated = db.setUserAdmin(targetId, isAdmin);
  return { user: publicUser(updated) };
}

function deleteUserById(targetId, actorId) {
  if (targetId === actorId) {
    return { error: "Нельзя удалить себя", status: 400 };
  }
  const target = findUserById(targetId);
  if (!target) return { error: "Пользователь не найден", status: 404 };
  if (target.isAdmin) {
    const users = loadUsers();
    const admins = users.filter((u) => u.isAdmin);
    if (admins.length <= 1) {
      return { error: "Нельзя удалить последнего админа", status: 400 };
    }
  }
  destroySessionsForUser(targetId);
  db.deleteUser(targetId);
  return { ok: true };
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function setSessionCookie(res, sid, expires) {
  const maxAge = Math.max(0, Math.floor((expires - Date.now()) / 1000));
  const secure = false;
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(sid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  );
}

function authMiddleware(req, res, next) {
  const cookies = parseCookies(req);
  const sid = cookies[SESSION_COOKIE];
  const sess = getSession(sid);
  if (sess) {
    const user = findUserById(sess.userId);
    if (user) {
      req.user = publicUser(user);
      req.sessionId = sid;
      req.fullUser = user;
      return next();
    }
    destroySession(sid);
  }
  req.user = null;
  req.sessionId = null;
  req.fullUser = null;
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "Требуется вход" });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: "Только для администратора" });
  }
  next();
}

function localhostOnlyMiddleware(req, res, next) {
  const cfg = getAccessConfig();
  if (!cfg.localhostOnly) return next();
  const ip = req.ip || req.connection?.remoteAddress || "";
  const clean = String(ip).replace(/^::ffff:/, "");
  if (clean === "127.0.0.1" || clean === "::1" || clean === "localhost") {
    return next();
  }
  if (req.path.startsWith("/api/")) {
    return res.status(403).json({ error: "Доступ только с localhost. Включите сетевой доступ в админке." });
  }
  return res.status(403).send("Доступ только с localhost");
}

function canSeeBook(book, user) {
  if (!book) return false;
  if (!book.isPrivate) return true;
  if (!user) return false;
  if (user.isAdmin) return true;
  return Number(book.ownerId) === Number(user.id);
}

function canEditBook(book, user) {
  if (!book || !user) return false;
  if (user.isAdmin) return true;
  return Number(book.ownerId) === Number(user.id);
}


const rateLimitMap = new Map();
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 20;

function rateLimitAuth(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || "unknown";
  const now = Date.now();
  let entry = rateLimitMap.get(ip);
  if (!entry || now - entry.start > RATE_WINDOW_MS) {
    entry = { start: now, count: 0 };
    rateLimitMap.set(ip, entry);
  }
  entry.count++;
  if (entry.count > RATE_MAX) {
    return res.status(429).json({ error: "Слишком много попыток. Подождите минуту." });
  }
  if (rateLimitMap.size > 5000) {
    for (const [k, v] of rateLimitMap) {
      if (now - v.start > RATE_WINDOW_MS * 2) rateLimitMap.delete(k);
    }
  }
  next();
}

function registerAuthRoutes(app) {
  app.get("/api/auth/me", (req, res) => {
    if (!req.user) return res.json({ user: null });
    res.json({ user: req.user });
  });

  app.get("/api/auth/config", (req, res) => {
    const cfg = getAccessConfig();
    res.json({
      registrationDisabled: !!cfg.registrationDisabled,
      localhostOnly: !!cfg.localhostOnly,
    });
  });

  app.post("/api/auth/register", rateLimitAuth, (req, res) => {
    const cfg = getAccessConfig();
    if (cfg.registrationDisabled) {
      return res.status(403).json({ error: "Регистрация отключена" });
    }
    const { username, password } = req.body || {};
    const result = registerUser(username, password);
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    const { sid, expires } = createSession(result.user.id);
    setSessionCookie(res, sid, expires);
    res.json({ user: result.user });
  });

  app.post("/api/auth/login", rateLimitAuth, (req, res) => {
    const { username, password } = req.body || {};
    const result = loginUser(username, password);
    if (result.error) return res.status(result.status || 401).json({ error: result.error });
    const { sid, expires } = createSession(result.user.id);
    setSessionCookie(res, sid, expires);
    res.json({ user: result.user });
  });

  app.post("/api/auth/logout", (req, res) => {
    if (req.sessionId) destroySession(req.sessionId);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.post("/api/auth/change-password", requireAuth, (req, res) => {
    const { oldPassword, newPassword } = req.body || {};
    const result = changePassword(req.user.id, oldPassword, newPassword);
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    res.json({ ok: true });
  });
}

function registerAdminRoutes(app, { deleteBooksByOwner, createBackup } = {}) {
  app.get("/api/admin/config", requireAuth, requireAdmin, (req, res) => {
    res.json(getAccessConfig());
  });

  app.put("/api/admin/config", requireAuth, requireAdmin, (req, res) => {
    const body = req.body || {};
    const cfg = getAccessConfig();
    if (body.localhostOnly != null) cfg.localhostOnly = !!body.localhostOnly;
    if (body.registrationDisabled != null) cfg.registrationDisabled = !!body.registrationDisabled;
    const saved = saveAccessConfig(cfg);
    res.json(saved);
  });

  app.post("/api/admin/config", requireAuth, requireAdmin, (req, res) => {
    const body = req.body || {};
    const cfg = getAccessConfig();
    if (body.localhostOnly != null) cfg.localhostOnly = !!body.localhostOnly;
    if (body.registrationDisabled != null) cfg.registrationDisabled = !!body.registrationDisabled;
    const saved = saveAccessConfig(cfg);
    res.json(saved);
  });

  app.get("/api/admin/users", requireAuth, requireAdmin, (req, res) => {
    const users = loadUsers().map((u) => {
      const pu = publicUser(u);
      const owned = db.getBooksByOwner(u.id, u.username);
      pu.booksCount = owned.length;
      pu.privateCount = owned.filter((b) => !!b.isPrivate).length;
      return pu;
    });
    res.json({ users });
  });

  app.get("/api/admin/users/:id/books", requireAuth, requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Неверный id" });
    const user = findUserById(id);
    if (!user) return res.status(404).json({ error: "Пользователь не найден" });
    const lib = db.getBooksByOwner(id, user.username);
    const pathMod = require("path");
    const fsMod = require("fs");
    const booksDir = pathMod.join(__dirname, "books");
    const books = lib.map((b) => {
      const st = db.getUserBookState(user, b.id);
      const coverFile = b.coverFile || null;
      const hasCover = !!(coverFile && fsMod.existsSync(pathMod.join(booksDir, coverFile)));
      return {
        id: b.id,
        title: b.title,
        author: b.author || "",
        format: b.format,
        progress: st.progress || 0,
        chapterIndex: st.chapterIndex || 0,
        charOffset: st.charOffset || 0,
        addedAt: b.addedAt,
        chaptersCount: b.chaptersCount || 0,
        pageCount: b.pageCount || 0,
        hasCover,
        series: b.series || "",
        year: b.year || null,
        description: b.description || "",
        status: st.status || "queue",
        isPrivate: !!b.isPrivate,
        ownerId: b.ownerId != null ? b.ownerId : null,
        ownerName: b.ownerName || null,
        bookmarks: st.bookmarks || [],
        lastTts: st.lastTts || null,
      };
    });
    res.json({ user: publicUser(user), books });
  });

  app.delete("/api/admin/users/:id", requireAuth, requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Неверный id" });
    const deleteBooks = !!(req.body && req.body.deleteBooks);
    const result = deleteUserById(id, req.user.id);
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    let removedBooks = 0;
    if (deleteBooks && typeof deleteBooksByOwner === "function") {
      try {
        removedBooks = await deleteBooksByOwner(id);
      } catch (_) {}
    }
    res.json({ ok: true, removedBooks });
  });

  app.post("/api/admin/users/:id/set-admin", requireAuth, requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Неверный id" });
    const makeAdmin = !!(req.body && req.body.isAdmin);
    const result = setUserAdminFlag(id, makeAdmin, req.user.id);
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    res.json({ ok: true, user: result.user });
  });

  app.post("/api/admin/users/:id/reset-password", requireAuth, requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Неверный id" });
    const newPassword = (req.body && req.body.newPassword) || "";
    const result = adminSetPassword(id, newPassword, req.user.id);
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    res.json({ ok: true });
  });

  app.get("/api/admin/backup", requireAuth, requireAdmin, async (req, res) => {
    if (typeof createBackup !== "function") {
      return res.status(501).json({ error: "Backup недоступен" });
    }
    try {
      const filePath = await createBackup();
      res.download(filePath, path.basename(filePath), (err) => {
        try {
          if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (_) {}
        if (err && !res.headersSent) res.status(500).json({ error: "Ошибка отдачи" });
      });
    } catch (e) {
      res.status(500).json({ error: e.message || "Ошибка backup" });
    }
  });
}

module.exports = {
  authMiddleware,
  requireAuth,
  requireAdmin,
  registerAuthRoutes,
  registerAdminRoutes,
  localhostOnlyMiddleware,
  canSeeBook,
  canEditBook,
  publicUser,
  findUserById,
  loadUsers,
  getAccessConfig,
  loadAccessConfig,
  saveAccessConfig,
};
