const path = require("path");
const fs = require("fs");
const db = require("../db");
const { BOOKS_DIR } = require("./config");
const { exists, ensureDir } = require("./utils");
const {
  parseTxt,
  parseFb2,
  detectAndDecode,
  extractFb2Cover,
  parseEpubAsync,
  estimatePageCount,
  parseBook,
} = require("./parsers");

function bookDir(id) {
  return path.join(BOOKS_DIR, id);
}

function getBookPath(book) {
  if (!book || !book.filename) return null;
  const direct = path.join(BOOKS_DIR, book.filename);
  if (exists(direct)) return direct;
  if (book.id) {
    const inDir = path.join(BOOKS_DIR, book.id, path.basename(book.filename));
    if (exists(inDir)) return inDir;
    if (book.format) {
      const byFmt = path.join(BOOKS_DIR, book.id, "book." + book.format);
      if (exists(byFmt)) return byFmt;
    }
  }
  return direct;
}

function getChaptersPath(bookId, forWrite) {
  const neu = path.join(BOOKS_DIR, bookId, "chapters.json");
  if (exists(neu)) return neu;
  const old = path.join(BOOKS_DIR, bookId + ".chapters.json");
  if (exists(old) && !forWrite) return old;
  return neu;
}

function getCoverPath(book) {
  if (!book) return null;
  if (book.coverFile) {
    const direct = path.join(BOOKS_DIR, book.coverFile);
    if (exists(direct)) return direct;
    if (book.id) {
      const inDir = path.join(BOOKS_DIR, book.id, path.basename(book.coverFile));
      if (exists(inDir)) return inDir;
    }
  }
  if (book.id) {
    const dir = bookDir(book.id);
    if (exists(dir)) {
      try {
        for (const name of fs.readdirSync(dir)) {
          if (/^cover\.(jpe?g|png|webp|gif)$/i.test(name)) {
            return path.join(dir, name);
          }
        }
      } catch (_) {}
    }
  }
  return null;
}

function publicBookForUser(b, user) {
  const fullUser = user && (user.dbName ? user : db.findUserById(user.id));
  const st = db.getUserBookState(fullUser, b.id);
  return {
    id: b.id,
    title: b.title,
    author: b.author,
    format: b.format,
    progress: st.progress || 0,
    chapterIndex: st.chapterIndex || 0,
    charOffset: st.charOffset || 0,
    addedAt: b.addedAt,
    chaptersCount: b.chaptersCount || 0,
    pageCount: b.pageCount || 0,
    hasCover: !!getCoverPath(b),
    series: b.series || "",
    year: b.year || null,
    description: b.description || "",
    status: st.status || "queue",
    isPrivate: !!b.isPrivate,
    ownerId: b.ownerId || null,
    ownerName: b.ownerName || null,
    bookmarks: st.bookmarks || [],
    lastTts: st.lastTts || null,
  };
}

function removeBookFiles(book) {
  if (!book || !book.id) return;
  const dir = bookDir(book.id);
  if (exists(dir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {}
  }
  try {
    if (book.filename) {
      const p = path.join(BOOKS_DIR, book.filename);
      if (exists(p) && !String(p).startsWith(dir + path.sep) && p !== dir) fs.unlinkSync(p);
    }
  } catch (_) {}
  try {
    if (book.coverFile) {
      const p = path.join(BOOKS_DIR, book.coverFile);
      if (exists(p) && !String(p).startsWith(dir + path.sep) && p !== dir) fs.unlinkSync(p);
    }
  } catch (_) {}
  try {
    const ch = path.join(BOOKS_DIR, book.id + ".chapters.json");
    if (exists(ch)) fs.unlinkSync(ch);
  } catch (_) {}
}

async function deleteBooksByOwner(ownerId) {
  const owned = db.loadBooks().filter((b) => Number(b.ownerId) === Number(ownerId));
  const ids = db.deleteBooksByOwner(ownerId);
  for (const book of owned) {
    removeBookFiles(book);
  }
  for (const id of ids) {
    removeBookFiles({ id, filename: null, coverFile: null });
  }
  return ids.length;
}

module.exports = {
  publicBookForUser,
  removeBookFiles,
  deleteBooksByOwner,
  getBookPath,
  getChaptersPath,
  getCoverPath,
  bookDir,
  estimatePageCount,
  parseBook,
  parseEpubAsync,
  extractFb2Cover,
  detectAndDecode,
  parseTxt,
  parseFb2,
};
