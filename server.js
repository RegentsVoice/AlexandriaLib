#!/usr/bin/env node

const { spawn, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const { XMLParser } = require("fast-xml-parser");
const JSZip = require("jszip");
const {
  authMiddleware,
  requireAuth,
  registerAuthRoutes,
  registerAdminRoutes,
  localhostOnlyMiddleware,
  canSeeBook,
  canEditBook,
  getAccessConfig,
} = require("./auth");
const db = require("./db");

const ROOT = __dirname;
const PYTHON_DIR = path.join(ROOT, "python");
const VENV_DIR = path.join(PYTHON_DIR, ".venv");
const REQUIREMENTS = path.join(PYTHON_DIR, "requirements.txt");
const TTS_SCRIPT = path.join(PYTHON_DIR, "tts_server.py");
const PUBLIC_DIR = path.join(ROOT, "public");
const BOOKS_DIR = path.join(ROOT, "books");
const SETUP_MARKER = path.join(PYTHON_DIR, ".setup-ok");

const PYTHON_PORT = 8765;
const NODE_PORT = process.env.PORT || 8766;

const isWindows = process.platform === "win32";
const pythonBin = isWindows
  ? path.join(VENV_DIR, "Scripts", "python.exe")
  : path.join(VENV_DIR, "bin", "python");
const pipBin = isWindows
  ? path.join(VENV_DIR, "Scripts", "pip.exe")
  : path.join(VENV_DIR, "bin", "pip");

function log(msg) {
  console.log(`[AL] ${msg}`);
}

function pythonEnv(extra = {}) {
  return {
    ...process.env,
    TORCH_HOME: path.join(PYTHON_DIR, ".torch"),
    HF_HOME: path.join(PYTHON_DIR, ".hf"),
    PYTHONUNBUFFERED: "1",
    HF_HUB_DISABLE_SYMLINKS_WARNING: "1",
    HF_HUB_DISABLE_TELEMETRY: "1",
    RUST_LOG: "error",
    HF_XET_LOG_LEVEL: "error",
    ...extra,
  };
}

function run(cmd, opts = {}) {
  const quiet = opts.quiet !== false;
  try {
    return execSync(cmd, {
      stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
      cwd: opts.cwd || ROOT,
      env: pythonEnv(opts.env || {}),
      shell: true,
      encoding: "utf8",
    });
  } catch (e) {
    if (quiet && e.stderr) process.stderr.write(String(e.stderr).slice(-2000));
    throw e;
  }
}

function exists(p) {
  return fs.existsSync(p);
}

function ensureDir(dir) {
  if (!exists(dir)) fs.mkdirSync(dir, { recursive: true });
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
    hasCover: !!(b.coverFile && exists(path.join(BOOKS_DIR, b.coverFile))),
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
  try {
    if (book.filename) {
      const p = path.join(BOOKS_DIR, book.filename);
      if (exists(p)) fs.unlinkSync(p);
    }
  } catch (_) {}
  try {
    if (book.coverFile) {
      const p = path.join(BOOKS_DIR, book.coverFile);
      if (exists(p)) fs.unlinkSync(p);
    }
  } catch (_) {}
  try {
    const ch = path.join(BOOKS_DIR, book.id + ".chapters.json");
    if (exists(ch)) fs.unlinkSync(ch);
  } catch (_) {}
}

async function deleteBooksByOwner(ownerId) {
  const ids = db.deleteBooksByOwner(ownerId);
  for (const id of ids) {
    const book = { id, filename: null, coverFile: null };
    const full = db.getBookById(id);
    if (full) removeBookFiles(full);
    else {
      try {
        const ch = path.join(BOOKS_DIR, id + ".chapters.json");
        if (exists(ch)) fs.unlinkSync(ch);
      } catch (_) {}
    }
  }
  return ids.length;
}

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
  for (const b of lib) {
    if (b.filename) {
      const p = path.join(BOOKS_DIR, b.filename);
      if (exists(p)) zip.file("books/" + b.filename, fs.readFileSync(p));
    }
    if (b.coverFile) {
      const p = path.join(BOOKS_DIR, b.coverFile);
      if (exists(p)) zip.file("books/" + b.coverFile, fs.readFileSync(p));
    }
    const ch = path.join(BOOKS_DIR, b.id + ".chapters.json");
    if (exists(ch)) zip.file("books/" + b.id + ".chapters.json", fs.readFileSync(ch));
  }
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  ensureDir(BOOKS_DIR);
  const out = path.join(BOOKS_DIR, "backup-" + Date.now() + ".zip");
  fs.writeFileSync(out, buf);
  return out;
}

function decodeOriginalName(name) {
  if (!name || typeof name !== "string") return "book";
  try {
    const fixed = Buffer.from(name, "latin1").toString("utf8");
    if (/[А-Яа-яЁё]/.test(fixed) && !/[А-Яа-яЁё]/.test(name)) return fixed;
    if (fixed.includes("\uFFFD")) return name;
    if (/[\u0400-\u04FF]/.test(fixed)) return fixed;
  } catch (_) {}
  return name;
}

function getBookPath(book) {
  return path.join(BOOKS_DIR, book.filename);
}

function parseTxt(content, originalName) {
  const title = originalName.replace(/\.txt$/i, "") || "Без названия";
  const text = content.replace(/\r\n/g, "\n").trim();
  return {
    title,
    author: "Неизвестный автор",
    chapters: [{ id: "ch0", title: "Текст", text }],
  };
}

function extractTextFromFb2Node(node) {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);

  let result = "";

  if (Array.isArray(node)) {
    for (const item of node) {
      result += extractTextFromFb2Node(item);
    }
    return result;
  }

  if (typeof node === "object") {
    const blockTags = new Set([
      "p", "v", "subtitle", "text-author", "title", "epigraph",
      "cite", "poem", "stanza", "empty-line", "section"
    ]);

    for (const [key, value] of Object.entries(node)) {
      if (key === "#text") {
        result += value;
      } else if (key === "empty-line") {
        result += "\n\n";
      } else if (blockTags.has(key)) {
        const inner = extractTextFromFb2Node(value);
        if (inner.trim()) {
          result += inner.trim() + "\n\n";
        }
      } else if (key !== "@_id" && key !== "@_name" && !key.startsWith("@_")) {
        result += extractTextFromFb2Node(value);
      }
    }
  }

  return result;
}

function parseFb2(content) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    textNodeName: "#text",
    isArray: (name) =>
      ["section", "title", "p", "v", "emphasis", "strong", "binary", "image"].includes(name),
  });

  let xml;
  try {
    xml = parser.parse(content);
  } catch (e) {
    throw new Error("Не удалось распарсить FB2: " + e.message);
  }

  const fictionBook = xml.FictionBook || xml.fictionbook;
  if (!fictionBook) throw new Error("Неверный FB2: нет корневого элемента FictionBook");

  const desc = fictionBook.description || {};
  const titleInfo = desc["title-info"] || {};
  const bookTitle = titleInfo["book-title"];
  const title = (typeof bookTitle === "string" ? bookTitle : bookTitle?.["#text"]) || "Без названия";

  let author = "Неизвестный автор";
  const authors = titleInfo.author;
  if (authors) {
    const a = Array.isArray(authors) ? authors[0] : authors;
    const first = (a["first-name"] && (typeof a["first-name"] === "string" ? a["first-name"] : a["first-name"]["#text"])) || "";
    const last = (a["last-name"] && (typeof a["last-name"] === "string" ? a["last-name"] : a["last-name"]["#text"])) || "";
    const nick = a.nickname || "";
    author = [first, last].filter(Boolean).join(" ") || nick || author;
  }

  const body = fictionBook.body;
  if (!body) throw new Error("В FB2 нет body");

  const bodies = Array.isArray(body) ? body : [body];
  const mainBody = bodies[0];

  const chapters = [];
  let chapterIndex = 0;

  function processSection(section, parentTitle = null, prependText = "") {
    if (!section) return;

    let sectionTitle = parentTitle;
    if (section.title) {
      const titleNode = Array.isArray(section.title) ? section.title[0] : section.title;
      const t = extractTextFromFb2Node(titleNode).trim().replace(/\n+/g, " ");
      if (t) sectionTitle = t;
    }

    const hasNested = section.section && (Array.isArray(section.section) ? section.section.length > 0 : true);

    if (hasNested) {
      const own = { ...section };
      delete own.section;
      delete own.title;
      let ownText = extractTextFromFb2Node(own).trim();
      if (prependText) {
        ownText = ownText ? prependText + "\n\n" + ownText : prependText;
      }
      const children = Array.isArray(section.section) ? section.section : [section.section];
      if (ownText && ownText.length >= 120) {
        chapters.push({
          id: "ch" + (chapterIndex++),
          title: sectionTitle || ("Глава " + chapterIndex),
          text: ownText,
        });
        for (const child of children) {
          processSection(child, sectionTitle, "");
        }
      } else {
        let carry = ownText || "";
        for (let i = 0; i < children.length; i++) {
          processSection(children[i], sectionTitle, i === 0 ? carry : "");
          carry = "";
        }
      }
    } else {
      let text = extractTextFromFb2Node(section).trim();
      if (prependText) {
        text = text ? prependText + "\n\n" + text : prependText;
      }
      if (text) {
        chapters.push({
          id: "ch" + (chapterIndex++),
          title: sectionTitle || ("Глава " + chapterIndex),
          text,
        });
      }
    }
  }

  if (mainBody.section) {
    const sections = Array.isArray(mainBody.section) ? mainBody.section : [mainBody.section];
    for (const sec of sections) {
      processSection(sec);
    }
  } else {
    const text = extractTextFromFb2Node(mainBody).trim();
    chapters.push({
      id: "ch0",
      title: title,
      text: text || "Пустая книга",
    });
  }

  if (chapters.length === 0) {
    chapters.push({
      id: "ch0",
      title: title,
      text: "Не удалось извлечь текст из FB2",
    });
  }

  const merged = [];
  for (const ch of chapters) {
    const t = (ch.text || "").trim();
    if (!t) continue;
    if (
      merged.length &&
      t.length < 80 &&
      merged[merged.length - 1].text.length < 400
    ) {
      const prev = merged[merged.length - 1];
      prev.text = prev.text + "\n\n" + t;
    } else {
      merged.push({ ...ch, text: t });
    }
  }
  if (merged.length) {
    for (let i = 0; i < merged.length; i++) merged[i].id = "ch" + i;
    return { title, author, chapters: merged, fictionBook };
  }

  return { title, author, chapters, fictionBook };
}

function detectAndDecode(buffer) {
  
  const headLatin = buffer.slice(0, 400).toString("latin1");
  const encMatch = headLatin.match(/encoding\s*=\s*["']([^"']+)["']/i);
  let declared = encMatch ? encMatch[1].trim().toLowerCase() : null;

  const alias = {
    "windows-1251": "windows-1251",
    "cp1251": "windows-1251",
    "win-1251": "windows-1251",
    "1251": "windows-1251",
    "utf-8": "utf-8",
    "utf8": "utf-8",
    "koi8-r": "koi8-r",
    "koi8r": "koi8-r",
    "iso-8859-5": "iso-8859-5",
  };

  const tryDecode = (label) => {
    try {
      const dec = new TextDecoder(label, { fatal: false });
      return dec.decode(buffer);
    } catch {
      return null;
    }
  };

  
  if (declared && alias[declared]) {
    const s = tryDecode(alias[declared]);
    if (s && !s.includes("\uFFFD")) return s;
    if (s) return s; 
  }

  
  const utf8 = tryDecode("utf-8");
  if (utf8 && !utf8.includes("\uFFFD") && /[а-яА-ЯёЁ]/.test(utf8)) {
    return utf8;
  }

  
  const cp1251 = tryDecode("windows-1251");
  if (cp1251 && /[а-яА-ЯёЁ]/.test(cp1251)) {
    return cp1251;
  }

  
  const koi = tryDecode("koi8-r");
  if (koi && /[а-яА-ЯёЁ]/.test(koi)) {
    return koi;
  }

  
  return utf8 || cp1251 || buffer.toString("utf8");
}

function extractFb2Cover(fictionBook, bookId) {
  try {
    const desc = fictionBook.description || {};
    const titleInfo = desc["title-info"] || {};
    let coverId = null;
    const coverPage = titleInfo.coverpage || titleInfo["coverpage"];
    if (coverPage) {
      const img = coverPage.image || coverPage.Image;
      if (img) {
        const node = Array.isArray(img) ? img[0] : img;
        coverId = node["@_l:href"] || node["@_xlink:href"] || node["@_href"];
        if (coverId && coverId.startsWith("#")) coverId = coverId.slice(1);
      }
    }
    let binaries = fictionBook.binary || fictionBook.Binary;
    if (!binaries) return null;
    if (!Array.isArray(binaries)) binaries = [binaries];
    let bin = null;
    if (coverId) {
      bin = binaries.find((b) => (b["@_id"] || b.id) === coverId);
    }
    if (!bin) {
      bin =
        binaries.find((b) => {
          const ct = String(b["@_content-type"] || "").toLowerCase();
          return ct.includes("image");
        }) || binaries[0];
    }
    if (!bin) return null;
    const b64 = typeof bin === "string" ? bin : bin["#text"];
    if (!b64 || typeof b64 !== "string") return null;
    const cleaned = b64.replace(/\s+/g, "");
    const buf = Buffer.from(cleaned, "base64");
    if (buf.length < 100) return null;
    const ct = (bin["@_content-type"] || "image/jpeg").toLowerCase();
    const ext = ct.includes("png") ? ".png" : ct.includes("gif") ? ".gif" : ".jpg";
    const coverName = bookId + "_cover" + ext;
    fs.writeFileSync(path.join(BOOKS_DIR, coverName), buf);
    return coverName;
  } catch (e) {
    log("cover extract failed: " + e.message);
    return null;
  }
}

async function parseEpubAsync(filePath, originalName) {
  const data = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(data);

  
  const containerXml = await zip.file("META-INF/container.xml").async("string");
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    textNodeName: "#text",
  });
  const container = parser.parse(containerXml);
  const rootfile =
    container?.container?.rootfiles?.rootfile?.["@_full-path"] ||
    container?.container?.rootfiles?.rootfile?.[0]?.["@_full-path"];
  if (!rootfile) throw new Error("EPUB: нет rootfile в container.xml");

  const opfDir = rootfile.includes("/") ? rootfile.replace(/\/[^/]+$/, "/") : "";
  const opfXml = await zip.file(rootfile).async("string");
  const opf = parser.parse(opfXml);
  const pkg = opf.package || opf.Package;
  if (!pkg) throw new Error("EPUB: неверный OPF");

  const metadata = pkg.metadata || {};
  const getMeta = (key) => {
    const v = metadata[key] || metadata["dc:" + key.replace(/^dc:/, "")];
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (Array.isArray(v)) {
      const first = v[0];
      return typeof first === "string" ? first : first?.["#text"] || "";
    }
    return v["#text"] || "";
  };

  let title =
    getMeta("dc:title") ||
    getMeta("title") ||
    originalName.replace(/\.epub$/i, "") ||
    "Без названия";
  let author = getMeta("dc:creator") || getMeta("creator") || "Неизвестный автор";
  if (typeof title !== "string") title = String(title);
  if (typeof author !== "string") author = String(author);

  
  const manifestNode = pkg.manifest?.item || pkg.manifest?.Item || [];
  const items = Array.isArray(manifestNode) ? manifestNode : [manifestNode];
  const byId = {};
  for (const it of items) {
    if (!it) continue;
    byId[it["@_id"]] = {
      href: it["@_href"],
      type: it["@_media-type"] || "",
      props: it["@_properties"] || "",
    };
  }

  const spineNode = pkg.spine?.itemref || pkg.spine?.Itemref || [];
  const spine = Array.isArray(spineNode) ? spineNode : [spineNode];

  function stripHtml(html) {
    const entities = {
      nbsp: " ",
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
      mdash: "—",
      ndash: "–",
      hellip: "…",
      laquo: "«",
      raquo: "»",
      ldquo: "“",
      rdquo: "”",
      lsquo: "‘",
      rsquo: "’",
      times: "×",
      divide: "÷",
      copy: "©",
      reg: "®",
      trade: "™",
      sect: "§",
      para: "¶",
      deg: "°",
      plusmn: "±",
      euro: "€",
      pound: "£",
      yen: "¥",
      cent: "¢",
      thinsp: " ",
      ensp: " ",
      emsp: " ",
    };
    return String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<\/h[1-6]>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&#(\d+);/g, (_, n) => {
        const c = Number(n);
        return c >= 0 && c <= 0x10ffff ? String.fromCodePoint(c) : "";
      })
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
        const c = parseInt(h, 16);
        return c >= 0 && c <= 0x10ffff ? String.fromCodePoint(c) : "";
      })
      .replace(/&([a-zA-Z]+);/g, (m, name) => entities[name.toLowerCase()] || m)
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function safeZipPath(base, href) {
    const raw = String(href || "").replace(/\\/g, "/");
    const joined = path.posix.normalize((base || "") + raw);
    if (joined.startsWith("../") || joined === "..") return null;
    return joined;
  }

  const chapters = [];
  let i = 0;
  for (const ref of spine) {
    if (!ref) continue;
    const idref = ref["@_idref"];
    const item = byId[idref];
    if (!item || !item.href) continue;
    if (item.type && !item.type.includes("html") && !item.type.includes("xml")) continue;
    const full = safeZipPath(opfDir, item.href);
    if (!full) continue;
    const f = zip.file(full) || zip.file(decodeURIComponent(full));
    if (!f) continue;
    const html = await f.async("string");
    const text = stripHtml(html);
    if (!text || text.length < 20) continue;
    
    let chTitle = "Глава " + (i + 1);
    const h = html.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i);
    if (h) chTitle = stripHtml(h[1]).slice(0, 80) || chTitle;
    chapters.push({ id: "ch" + i, title: chTitle, text });
    i++;
  }

  if (!chapters.length) {
    throw new Error("EPUB: не удалось извлечь текст");
  }

  
  let coverBuffer = null;
  let coverExt = ".jpg";
  let coverItem = items.find((it) => (it["@_properties"] || "").includes("cover-image"));
  if (!coverItem) {
    const metaCover = metadata.meta;
    const metas = Array.isArray(metaCover) ? metaCover : metaCover ? [metaCover] : [];
    const coverMeta = metas.find((m) => m && (m["@_name"] === "cover" || m["@_name"] === "cover-image"));
    if (coverMeta) {
      const cid = coverMeta["@_content"];
      coverItem = items.find((it) => it["@_id"] === cid);
    }
  }
  if (!coverItem) {
    coverItem = items.find((it) => {
      const t = (it["@_media-type"] || "").toLowerCase();
      const h = (it["@_href"] || "").toLowerCase();
      return t.startsWith("image/") && (h.includes("cover") || h.includes("front"));
    });
  }
  if (coverItem && coverItem["@_href"]) {
    const full = safeZipPath(opfDir, coverItem["@_href"]);
    if (full) {
      const f = zip.file(full) || zip.file(decodeURIComponent(full));
      if (f) {
        coverBuffer = await f.async("nodebuffer");
        const mt = (coverItem["@_media-type"] || "").toLowerCase();
        if (mt.includes("png")) coverExt = ".png";
        else if (mt.includes("gif")) coverExt = ".gif";
        else if (mt.includes("webp")) coverExt = ".webp";
        else coverExt = ".jpg";
      }
    }
  }

  return { title, author, chapters, coverBuffer, coverExt };
}

function estimatePageCount(chapters) {
  const CHARS_PER_PAGE = 1800;
  let len = 0;
  for (const ch of chapters || []) {
    len += (ch.text || "").length;
  }
  return Math.max(1, Math.ceil(len / CHARS_PER_PAGE) || 1);
}

function parseBook(filePath, originalName, format) {
  const buffer = fs.readFileSync(filePath);

  if (format === "txt") {
    const content = detectAndDecode(buffer);
    return parseTxt(content, originalName);
  }
  if (format === "fb2") {
    const content = detectAndDecode(buffer);
    const result = parseFb2(content);
    return result;
  }
  if (format === "epub") {
    throw new Error("EPUB нужно открывать через parseEpubAsync");
  }
  throw new Error("Неподдерживаемый формат: " + format);
}

function findSystemPython() {
  const candidates = isWindows ? ["python", "py", "python3"] : ["python3", "python"];
  for (const cmd of candidates) {
    try {
      execSync(cmd + " --version", { stdio: "ignore", shell: true });
      return cmd;
    } catch (_) {}
  }
  throw new Error(
    "Не найден Python. Установите Python 3.10+ и убедитесь, что он в PATH " +
      "(на Windows при установке отметьте «Add python.exe to PATH»)."
  );
}

function ensureVenv() {
  if (exists(pythonBin)) {
    log("venv exists");
    return;
  }
  log("creating venv...");
  const sysPython = findSystemPython();
  log("system python: " + sysPython);
  run('"' + sysPython + '" -m venv "' + VENV_DIR + '"');
  log("venv created");
}

function installPythonDeps() {
  const pipCmd = '"' + pythonBin + '" -m pip';
  try {
    log("upgrading pip...");
    run(pipCmd + " install -q --upgrade pip");
  } catch (_) {}
  log("installing pip packages (torch may take a while)...");
  run(pipCmd + ' install -r "' + REQUIREMENTS + '"', { quiet: false });
  log("pip packages ok");
}

function predownloadModels() {
  log("downloading TTS models (RUAccent + Silero)...");
  const preloadCode = `
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import hf_compat
import torch
from ruaccent import RUAccent
print("AL: RUAccent...", flush=True)
a = RUAccent()
a.load(omograph_model_size="turbo3.1", use_dictionary=True, device="CPU")
print("AL: RUAccent ok", flush=True)
print("AL: Silero TTS...", flush=True)
torch.hub.load(repo_or_dir="snakers4/silero-models", model="silero_tts",
  language="ru", speaker="v5_ru", trust_repo=True)
print("AL: Silero ok", flush=True)
`;
  const tmpFile = path.join(PYTHON_DIR, "_preload.py");
  fs.writeFileSync(tmpFile, preloadCode, "utf8");
  try {
    run('"' + pythonBin + '" "' + tmpFile + '"', { quiet: false });
    log("TTS models ok");
  } finally {
    if (exists(tmpFile)) fs.unlinkSync(tmpFile);
  }
}

function needsSetup() {
  if (!exists(pythonBin)) return true;
  if (!exists(SETUP_MARKER)) return true;
  try {
    const marker = fs.readFileSync(SETUP_MARKER, "utf8").trim();
    const req = fs.readFileSync(REQUIREMENTS, "utf8");
    const hash = require("crypto").createHash("sha1").update(req).digest("hex").slice(0, 12);
    return marker !== hash;
  } catch {
    return true;
  }
}

function writeSetupMarker() {
  const req = fs.readFileSync(REQUIREMENTS, "utf8");
  const hash = require("crypto").createHash("sha1").update(req).digest("hex").slice(0, 12);
  fs.writeFileSync(SETUP_MARKER, hash, "utf8");
}

let pythonProcess = null;

let ttsReady = false;

function startPythonServer() {
  return new Promise((resolve, reject) => {
    if (!exists(pythonBin)) {
      const msg = "Python venv not found. Run: npm run setup";
      log(msg);
      reject(new Error(msg));
      return;
    }
    if (!exists(TTS_SCRIPT)) {
      const msg = "tts_server.py missing";
      log(msg);
      reject(new Error(msg));
      return;
    }

    log("TTS loading (1–3 min on first start)...");
    log("python: " + pythonBin);

    let logBuf = "";
    pythonProcess = spawn(pythonBin, [TTS_SCRIPT], {
      cwd: PYTHON_DIR,
      env: pythonEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let ready = false;
    const heartbeat = setInterval(() => {
      if (!ready) log("TTS still loading...");
    }, 15000);

    const finish = () => {
      if (ready) return;
      ready = true;
      ttsReady = true;
      clearInterval(heartbeat);
      log("TTS ready");
      resolve();
    };

    const onData = (data) => {
      const text = data.toString();
      logBuf += text;
      if (logBuf.length > 12000) logBuf = logBuf.slice(-8000);
      if (/\r|%\|█|Downloading|Fetching|Fetching [0-9]|Loading/.test(text)) {
        process.stdout.write(text);
      }
      for (const line of text.split(/\r?\n/)) {
        const s = line.trim();
        if (!s) continue;
        if (/^(AL:|TTS |RUAccent|Uvicorn|Application startup|Silero)/i.test(s)) {
          log(s.replace(/^AL:\s*/i, ""));
        } else if (/error|exception|traceback|modulenotfound|failed/i.test(s)) {
          log(s);
        }
      }
      if (
        text.includes("Uvicorn running") ||
        text.includes("Application startup complete") ||
        text.includes("TTS server listening")
      ) {
        finish();
      }
    };

    pythonProcess.stdout.on("data", onData);
    pythonProcess.stderr.on("data", onData);
    pythonProcess.on("error", (err) => {
      clearInterval(heartbeat);
      log("TTS start failed: " + err.message);
      reject(err);
    });
    pythonProcess.on("exit", (code) => {
      clearInterval(heartbeat);
      pythonProcess = null;
      ttsReady = false;
      if (!ready) {
        log("TTS exited with code " + code);
        const tail = logBuf.trim().split(/\r?\n/).slice(-25).join("\n");
        if (tail) log("TTS log:\n" + tail);
        reject(new Error("TTS exited " + code));
      }
    });
    setTimeout(() => {
      if (!ready) {
        log("TTS slow — UI is up, voice may lag");
        finish();
      }
    }, 300000);
  });
}

function startExpress() {
  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: "5mb" }));
  app.use(localhostOnlyMiddleware);
  app.use(authMiddleware);
  registerAuthRoutes(app);
  registerAdminRoutes(app, { deleteBooksByOwner, createBackup });

  app.get("/api/health", async (req, res) => {
    let tts = false;
    try {
      const r = await fetch("http://127.0.0.1:" + PYTHON_PORT + "/health");
      tts = r.ok;
    } catch (_) {
      tts = false;
    }
    res.json({
      ok: true,
      tts,
      time: Date.now(),
      localhostOnly: !!getAccessConfig().localhostOnly,
    });
  });

  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      ensureDir(BOOKS_DIR);
      cb(null, BOOKS_DIR);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const id = uuidv4();
      cb(null, id + ext);
    },
  });

  const upload = multer({
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
      const id = path.basename(req.file.filename, path.extname(req.file.filename));
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
          coverFile = id + "_cover" + cext;
          fs.writeFileSync(path.join(BOOKS_DIR, coverFile), parsed.coverBuffer);
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
      const book = {
        id,
        title: parsed.title,
        author: parsed.author,
        format: ext,
        filename: req.file.filename,
        addedAt: Date.now(),
        chaptersCount: parsed.chapters.length,
        pageCount,
        coverFile: coverFile || null,
        isPrivate: !!isPrivate,
        ownerId: req.user.id,
        ownerName: req.user.username,
      };

      const chaptersPath = path.join(BOOKS_DIR, id + ".chapters.json");
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
      const chaptersPath = path.join(BOOKS_DIR, book.id + ".chapters.json");
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
        fs.writeFileSync(chaptersPath, JSON.stringify(chapters), "utf8");
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
    if (!book || !book.coverFile || !canSeeBook(book, req.user)) return res.status(404).end();
    const p = path.join(BOOKS_DIR, book.coverFile);
    if (!exists(p)) return res.status(404).end();
    res.sendFile(p);
  });


  app.patch("/api/books/:id", requireAuth, async (req, res) => {
    try {
      const book = db.getBookById(req.params.id);
      if (!book || !canSeeBook(book, req.user)) return res.status(404).json({ error: "Книга не найдена" });
      if (!canEditBook(book, req.user)) {
        return res.status(403).json({ error: "Нет прав на редактирование" });
      }
      const { title, author, series, year, description, status, isPrivate } = req.body || {};
      const fields = {};
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

  app.get("/api/books/:id/bookmarks", requireAuth, (req, res) => {
    const book = db.getBookById(req.params.id);
    if (!book || !canSeeBook(book, req.user)) return res.status(404).json({ error: "Не найдено" });
    const fullUser = db.findUserById(req.user.id);
    const st = db.getUserBookState(fullUser, book.id);
    res.json({ bookmarks: st.bookmarks || [] });
  });

  app.post("/api/books/:id/bookmarks", requireAuth, async (req, res) => {
    try {
      const book = db.getBookById(req.params.id);
      if (!book || !canSeeBook(book, req.user)) return res.status(404).json({ error: "Не найдено" });
      const fullUser = db.findUserById(req.user.id);
      const body = req.body || {};
      const bm = {
        id: uuidv4(),
        chapterIndex: typeof body.chapterIndex === "number" ? body.chapterIndex : 0,
        charOffset: typeof body.charOffset === "number" ? body.charOffset : 0,
        label: String(body.label || "").slice(0, 200),
        createdAt: Date.now(),
      };
      db.addBookmark(fullUser, book.id, bm);
      const st = db.getUserBookState(fullUser, book.id);
      res.json({ bookmark: bm, bookmarks: st.bookmarks || [] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/books/:id/bookmarks/:bmId", requireAuth, async (req, res) => {
    try {
      const book = db.getBookById(req.params.id);
      if (!book || !canSeeBook(book, req.user)) return res.status(404).json({ error: "Не найдено" });
      const fullUser = db.findUserById(req.user.id);
      db.deleteBookmark(fullUser, book.id, req.params.bmId);
      const st = db.getUserBookState(fullUser, book.id);
      res.json({ ok: true, bookmarks: st.bookmarks || [] });
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

  app.use("/api/tts", requireAuth, async (req, res) => {
    const rawUrl = req.url || "/";
    const qIdx = rawUrl.indexOf("?");
    const targetPath = (qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl) || "/";
    const query = qIdx >= 0 ? rawUrl.slice(qIdx) : "";
    const target = "http://127.0.0.1:" + PYTHON_PORT + targetPath + query;

    try {
      const fetchOpts = {
        method: req.method,
        headers: {
          "content-type": "application/json",
          accept: "application/json, audio/wav, */*",
        },
      };

      if (req.method !== "GET" && req.method !== "HEAD") {
        const body =
          req.body && typeof req.body === "object" ? req.body : {};
        fetchOpts.body = JSON.stringify(body);
      }

      const response = await fetch(target, fetchOpts);
      const contentType = response.headers.get("content-type") || "";

      res.status(response.status);

      if (contentType.includes("audio") || contentType.includes("octet-stream")) {
        const buf = Buffer.from(await response.arrayBuffer());
        res.set("Content-Type", contentType || "audio/wav");
        const cache = response.headers.get("X-Cache");
        if (cache) res.set("X-Cache", cache);
        return res.send(buf);
      }

      const textBody = await response.text();
      res.set("Content-Type", contentType || "application/json");
      return res.send(textBody);
    } catch (err) {
      console.error("Proxy error:", err.message);
      return res.status(502).json({
        error: "TTS server unavailable",
        detail: err.message,
      });
    }
  });

  app.use(express.static(PUBLIC_DIR));

  app.get("*", (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, "index.html"));
  });

  const cfg = getAccessConfig();
  const host = process.env.HOST || "0.0.0.0";
  app.listen(NODE_PORT, host, () => {
    log("http://127.0.0.1:" + NODE_PORT);
    if (cfg.localhostOnly) log("режим: только localhost (middleware)");
    else log("режим: сеть");
  });
}

async function main() {
  const setupOnly = process.argv.includes("--setup-only");
  ensureDir(BOOKS_DIR);

  try {
    const mig = db.migrateFromJson();
    if (mig.migrated) {
      log("migrated from JSON: users=" + mig.migratedUsers + " books=" + mig.migratedBooks + " states=" + mig.migratedStates);
    }
  } catch (e) {
    log("migration skip: " + (e && e.message ? e.message : e));
  }

  if (needsSetup()) {
    log("first-time setup (may take several minutes)...");
    ensureVenv();
    installPythonDeps();
    predownloadModels();
    writeSetupMarker();
    log("setup complete");
  } else {
    log("setup cached — skip");
  }

  if (setupOnly) {
    process.exit(0);
  }

  startExpress();
  try {
    await startPythonServer();
  } catch (err) {
    log("TTS unavailable: " + (err && err.message ? err.message : err));
    log("UI works; fix TTS: npm run setup");
  }

  const shutdown = () => {
    if (pythonProcess) try { pythonProcess.kill("SIGTERM"); } catch (_) {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
