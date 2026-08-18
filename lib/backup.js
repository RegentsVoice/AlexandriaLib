const path = require("path");
const fs = require("fs");
const JSZip = require("jszip");
const db = require("../db");
const { ROOT, BOOKS_DIR } = require("./config");
const { exists, ensureDir } = require("./utils");

async function createBackup() {
  const zip = new JSZip();
  const lib = db.loadBooks();
  zip.file("library-export.json", JSON.stringify(lib, null, 2));
  for (const f of db.listDbFiles()) {
    if (exists(f)) {
      const rel = path.relative(ROOT, f).replace(/\\/g, "/");
      zip.file(rel, fs.readFileSync(f));
    }
  }
  const secret = path.join(ROOT, "data", "session.secret");
  if (exists(secret)) zip.file("data/session.secret", fs.readFileSync(secret));
  const { getBookPath, getCoverPath, getChaptersPath, bookDir } = require("./books");
  for (const b of lib) {
    const dir = bookDir(b.id);
    if (exists(dir)) {
      try {
        for (const name of fs.readdirSync(dir)) {
          const fp = path.join(dir, name);
          if (fs.statSync(fp).isFile()) {
            zip.file("books/" + b.id + "/" + name, fs.readFileSync(fp));
          }
        }
      } catch (_) {}
    } else {
      const bp = getBookPath(b);
      if (bp && exists(bp)) zip.file("books/" + path.basename(bp), fs.readFileSync(bp));
      const cp = getCoverPath(b);
      if (cp && exists(cp)) zip.file("books/" + path.basename(cp), fs.readFileSync(cp));
      const ch = getChaptersPath(b.id, false);
      if (ch && exists(ch)) zip.file("books/" + path.basename(ch), fs.readFileSync(ch));
    }
  }
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  ensureDir(BOOKS_DIR);
  const out = path.join(BOOKS_DIR, "backup-" + Date.now() + ".zip");
  fs.writeFileSync(out, buf);
  return out;
}

module.exports = { createBackup };
