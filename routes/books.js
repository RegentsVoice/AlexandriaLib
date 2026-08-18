const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const db = require("../db");
const {
  requireAuth,
  canSeeBook,
  canEditBook,
} = require("../auth");
const { BOOKS_DIR } = require("../lib/config");
const { log, exists, ensureDir, decodeOriginalName } = require("../lib/utils");
const {
  publicBookForUser,
  removeBookFiles,
  getBookPath,
  getChaptersPath,
  getCoverPath,
  bookDir,
  estimatePageCount,
  parseBook,
  parseEpubAsync,
  extractFb2Cover,
} = require("../lib/books");

function createUpload() {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const id = uuidv4();
      req._bookId = id;
      const dir = path.join(BOOKS_DIR, id);
      ensureDir(BOOKS_DIR);
      ensureDir(dir);
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || ".txt";
      cb(null, "book" + ext);
    },
  });

  return multer({
    storage,
    limits: { fileSize: 30 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (ext === ".txt" || ext === ".fb2" || ext === ".epub") {
        cb(null, true);
      } else {
        cb(new Error("Только .txt, .fb2 и .epub"));
      }
    },
  });
}

function registerBookRoutes(app) {
  const upload = createUpload();

  app.get("/api/books", requireAuth, (req, res) => {
    const lib = db.loadBooks();
    const list = lib
      .filter((b) => canSeeBook(b, req.user))
      .map((b) => publicBookForUser(b, req.user));
    res.json(list);
  });

  app.post("/api/books", requireAuth, upload.single("book"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "Файл не получен" });
      }

      const originalName = decodeOriginalName(req.file.originalname);
      const ext = path.extname(originalName).toLowerCase().slice(1) ||
        path.extname(req.file.originalname).toLowerCase().slice(1);
      const id = req._bookId || path.basename(path.dirname(req.file.path));
      const dir = bookDir(id);
      ensureDir(dir);
      const isPrivate =
        req.body &&
        (req.body.isPrivate === true ||
          req.body.isPrivate === "true" ||
          req.body.isPrivate === "1" ||
          req.body.isPrivate === "on");

      let parsed;
      let coverFile = null;

      if (ext === "epub") {
        parsed = await parseEpubAsync(req.file.path, originalName);
        if (parsed.coverBuffer) {
          const cext = parsed.coverExt || ".jpg";
          const coverName = "cover" + cext;
          fs.writeFileSync(path.join(dir, coverName), parsed.coverBuffer);
          coverFile = id + "/" + coverName;
        }
      } else {
        parsed = parseBook(req.file.path, originalName, ext);
        if (ext === "fb2" && parsed.fictionBook) {
          try {
            coverFile = extractFb2Cover(parsed.fictionBook, id);
          } catch (e) {
            log("fb2 cover: " + e.message);
          }
        }
        if (parsed.fictionBook) delete parsed.fictionBook;
      }

      const pageCount = estimatePageCount(parsed.chapters);
      const relFile = id + "/" + path.basename(req.file.path);
      const book = {
        id,
        title: parsed.title,
        author: parsed.author,
        format: ext,
        filename: relFile,
        addedAt: Date.now(),
        chaptersCount: parsed.chapters.length,
        pageCount,
        coverFile: coverFile || null,
        isPrivate: !!isPrivate,
        ownerId: req.user.id,
        ownerName: req.user.username,
      };

      const chaptersPath = getChaptersPath(id, true);
      ensureDir(path.dirname(chaptersPath));
      fs.writeFileSync(chaptersPath, JSON.stringify(parsed.chapters), "utf8");

      db.insertBook(book);

      res.json({
        id: book.id,
        title: book.title,
        author: book.author,
        format: book.format,
        chaptersCount: book.chaptersCount,
        pageCount: book.pageCount,
        hasCover: !!coverFile,
        isPrivate: book.isPrivate,
      });
    } catch (err) {
      log("upload error: " + err.message);
      if (req.file && exists(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
      }
      res.status(400).json({ error: err.message || "Ошибка загрузки" });
    }
  });

  app.get("/api/books/:id", requireAuth, async (req, res) => {
    try {
      const book = db.getBookById(req.params.id);
      if (!book || !canSeeBook(book, req.user)) {
        return res.status(404).json({ error: "Книга не найдена" });
      }

      let chapters = null;
      const chaptersPath = getChaptersPath(book.id, false);
      if (exists(chaptersPath)) {
        chapters = JSON.parse(fs.readFileSync(chaptersPath, "utf8"));
      } else {
        const filePath = getBookPath(book);
        if (book.format === "epub") {
          const parsed = await parseEpubAsync(filePath, book.filename);
          chapters = parsed.chapters;
        } else {
          const parsed = parseBook(filePath, book.filename, book.format);
          chapters = parsed.chapters;
        }
        const writePath = getChaptersPath(book.id, true);
        ensureDir(path.dirname(writePath));
        fs.writeFileSync(writePath, JSON.stringify(chapters), "utf8");
        db.updateBook(book.id, { chaptersCount: chapters.length });
        book.chaptersCount = chapters.length;
      }

      if (chapters && !book.pageCount) {
        const pc = estimatePageCount(chapters);
        db.updateBook(book.id, { pageCount: pc });
        book.pageCount = pc;
      }

      const pub = publicBookForUser(book, req.user);
      res.json({
        ...pub,
        pageCount: book.pageCount || estimatePageCount(chapters),
        chapters,
      });
    } catch (err) {
      log("open book: " + err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/books/:id/cover", requireAuth, (req, res) => {
    const book = db.getBookById(req.params.id);
    if (!book || !canSeeBook(book, req.user)) return res.status(404).end();
    const p = getCoverPath(book);
    if (!p || !exists(p)) return res.status(404).end();
    res.sendFile(p);
  });

  const coverUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const dir = bookDir(req.params.id);
        ensureDir(BOOKS_DIR);
        ensureDir(dir);
        cb(null, dir);
      },
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase() || ".jpg";
        const allowed = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
        const use = allowed.includes(ext) ? ext : ".jpg";
        cb(null, "cover" + use);
      },
    }),
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const ok =
        [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext) ||
        (file.mimetype && file.mimetype.startsWith("image/"));
      if (ok) cb(null, true);
      else cb(new Error("Только изображения: JPG, PNG, WebP, GIF"));
    },
  });

  app.post(
    "/api/books/:id/cover",
    requireAuth,
    (req, res, next) => {
      coverUpload.single("cover")(req, res, (err) => {
        if (err) {
          return res.status(400).json({ error: err.message || "Ошибка загрузки" });
        }
        next();
      });
    },
    (req, res) => {
      try {
        const book = db.getBookById(req.params.id);
        if (!book || !canSeeBook(book, req.user)) {
          return res.status(404).json({ error: "Книга не найдена" });
        }
        if (!canEditBook(book, req.user)) {
          return res.status(403).json({ error: "Нет прав на смену обложки" });
        }
        if (!req.file) {
          return res.status(400).json({ error: "Файл не передан" });
        }
        const dir = bookDir(book.id);
        try {
          for (const name of fs.readdirSync(dir)) {
            if (/^cover\.(jpe?g|png|webp|gif)$/i.test(name) && name !== req.file.filename) {
              try { fs.unlinkSync(path.join(dir, name)); } catch (_) {}
            }
          }
        } catch (_) {}
        if (book.coverFile) {
          try {
            const oldPath = path.join(BOOKS_DIR, book.coverFile);
            if (exists(oldPath) && path.dirname(oldPath) !== dir) fs.unlinkSync(oldPath);
          } catch (_) {}
        }
        const relCover = book.id + "/" + req.file.filename;
        const updated = db.updateBook(book.id, { coverFile: relCover });
        if (!updated || !updated.coverFile) {
          return res.status(500).json({ error: "Не удалось сохранить обложку" });
        }
        res.json({ ok: true, hasCover: true, coverFile: updated.coverFile });
      } catch (e) {
        res.status(500).json({ error: e.message || "Ошибка сервера" });
      }
    }
  );

  app.delete("/api/books/:id/cover", requireAuth, (req, res) => {
    try {
      const book = db.getBookById(req.params.id);
      if (!book || !canSeeBook(book, req.user)) return res.status(404).json({ error: "Книга не найдена" });
      if (!canEditBook(book, req.user)) return res.status(403).json({ error: "Нет прав" });
      const coverPath = getCoverPath(book);
      if (coverPath) {
        try { fs.unlinkSync(coverPath); } catch (_) {}
      }
      if (book.coverFile) {
        try {
          const old = path.join(BOOKS_DIR, book.coverFile);
          if (exists(old)) fs.unlinkSync(old);
        } catch (_) {}
      }
      db.updateBook(book.id, { coverFile: null });
      res.json({ ok: true, hasCover: false });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });



  app.patch("/api/books/:id", requireAuth, async (req, res) => {
    try {
      const book = db.getBookById(req.params.id);
      if (!book || !canSeeBook(book, req.user)) return res.status(404).json({ error: "Книга не найдена" });
      const editable = canEditBook(book, req.user);
      const { title, author, series, year, description, status, isPrivate } = req.body || {};
      const fields = {};
      if (editable) {
        if (title != null) {
          const t = String(title).trim();
          if (!t) return res.status(400).json({ error: "Пустое название" });
          fields.title = t;
        }
        if (author != null) fields.author = String(author).trim() || "Неизвестный автор";
        if (series != null) fields.series = String(series).trim();
        if (year != null) {
          const y = String(year).trim();
          fields.year = y ? Number(y) || null : null;
        }
        if (description != null) fields.description = String(description).trim();
        if (isPrivate != null) {
          fields.isPrivate = !!(isPrivate === true || isPrivate === "true" || isPrivate === 1 || isPrivate === "1");
        }
      } else if (
        title != null ||
        author != null ||
        series != null ||
        year != null ||
        description != null ||
        isPrivate != null
      ) {
        return res.status(403).json({ error: "Нет прав на редактирование карточки" });
      }
      const updated = Object.keys(fields).length ? db.updateBook(book.id, fields) : book;
      const fullUser = db.findUserById(req.user.id);
      if (status != null && ["queue", "reading", "finished"].includes(status)) {
        const st = db.getUserBookState(fullUser, book.id);
        st.status = status;
        db.setUserBookState(fullUser, book.id, st);
      }
      const st = db.getUserBookState(fullUser, book.id);
      res.json({
        ok: true,
        title: updated.title,
        author: updated.author,
        series: updated.series || "",
        year: updated.year || null,
        description: updated.description || "",
        status: st.status || "queue",
        isPrivate: !!updated.isPrivate,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/books/:id/progress", requireAuth, async (req, res) => {
    try {
      const book = db.getBookById(req.params.id);
      if (!book || !canSeeBook(book, req.user)) return res.status(404).json({ error: "Книга не найдена" });
      const fullUser = db.findUserById(req.user.id);
      const st = db.getUserBookState(fullUser, book.id);
      const { chapterIndex, charOffset, progress, lastTts } = req.body || {};
      if (typeof chapterIndex === "number") st.chapterIndex = chapterIndex;
      if (typeof charOffset === "number") st.charOffset = charOffset;
      if (typeof progress === "number") st.progress = Math.min(100, Math.max(0, progress));
      if (lastTts != null) st.lastTts = lastTts;
      if (st.progress >= 100) st.status = "finished";
      else if (st.progress > 0 && st.status !== "finished") st.status = "reading";
      else if (!st.status) st.status = "queue";
      db.setUserBookState(fullUser, book.id, st);
      res.json({ ok: true, status: st.status, progress: st.progress });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });


  app.post("/api/books/bulk-delete", requireAuth, async (req, res) => {
    try {
      const ids = (req.body && req.body.ids) || [];
      if (!Array.isArray(ids) || !ids.length) {
        return res.status(400).json({ error: "Нужен массив ids" });
      }
      let removed = 0;
      for (const id of ids) {
        const book = db.getBookById(id);
        if (!book) continue;
        if (!canEditBook(book, req.user)) continue;
        removeBookFiles(book);
        db.deleteBook(id);
        removed++;
      }
      res.json({ removed });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/books/:id", requireAuth, async (req, res) => {
    try {
      const book = db.getBookById(req.params.id);
      if (!book) return res.status(404).json({ error: "Книга не найдена" });
      if (!canEditBook(book, req.user)) return res.status(403).json({ error: "Нет прав на удаление" });
      removeBookFiles(book);
      db.deleteBook(book.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerBookRoutes };
