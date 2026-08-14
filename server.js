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

const ROOT = __dirname;
const PYTHON_DIR = path.join(ROOT, "python");
const VENV_DIR = path.join(PYTHON_DIR, ".venv");
const REQUIREMENTS = path.join(PYTHON_DIR, "requirements.txt");
const TTS_SCRIPT = path.join(PYTHON_DIR, "tts_server.py");
const PUBLIC_DIR = path.join(ROOT, "public");
const BOOKS_DIR = path.join(ROOT, "books");
const LIBRARY_FILE = path.join(BOOKS_DIR, "library.json");
const SETUP_MARKER = path.join(PYTHON_DIR, ".setup-ok");

const PYTHON_PORT = 8765;
const NODE_PORT = process.env.PORT || 3000;

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

function run(cmd, opts = {}) {
  const quiet = opts.quiet !== false;
  try {
    return execSync(cmd, {
      stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
      cwd: opts.cwd || ROOT,
      env: { ...process.env, ...opts.env },
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

function loadLibrary() {
  ensureDir(BOOKS_DIR);
  if (!exists(LIBRARY_FILE)) {
    fs.writeFileSync(LIBRARY_FILE, "[]", "utf8");
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(LIBRARY_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveLibrary(lib) {
  ensureDir(BOOKS_DIR);
  fs.writeFileSync(LIBRARY_FILE, JSON.stringify(lib, null, 2), "utf8");
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
    isArray: (name) => ["section", "title", "p", "v", "emphasis", "strong"].includes(name),
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

  function processSection(section, parentTitle = null) {
    if (!section) return;

    let sectionTitle = parentTitle;
    if (section.title) {
      const titleNode = Array.isArray(section.title) ? section.title[0] : section.title;
      const t = extractTextFromFb2Node(titleNode).trim().replace(/\n+/g, " ");
      if (t) sectionTitle = t;
    }

    const hasNested = section.section && (Array.isArray(section.section) ? section.section.length > 0 : true);

    if (hasNested) {
      const children = Array.isArray(section.section) ? section.section : [section.section];
      for (const child of children) {
        processSection(child, sectionTitle);
      }
    } else {
      const text = extractTextFromFb2Node(section).trim();
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

  return { title, author, chapters };
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
      
      bin = binaries.find((b) => {
        const ct = (b["@_content-type"] || b["@_content-type"] || "").toLowerCase();
        return ct.includes("image");
      }) || binaries[0];
    }
    if (!bin) return null;
    const b64 = typeof bin === "string" ? bin : bin["#text"] || bin["#text"];
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
    return String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<\/h[1-6]>/gi, "\n\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  const chapters = [];
  let i = 0;
  for (const ref of spine) {
    if (!ref) continue;
    const idref = ref["@_idref"];
    const item = byId[idref];
    if (!item || !item.href) continue;
    if (item.type && !item.type.includes("html") && !item.type.includes("xml")) continue;
    const full = opfDir + item.href;
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
      return t.startsWith("image/") && (h.includes("cover") || h.includes("cover"));
    });
  }
  if (coverItem && coverItem["@_href"]) {
    const full = opfDir + coverItem["@_href"];
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
  if (exists(pythonBin)) return;
  log("venv...");
  const sysPython = findSystemPython();
  run('"' + sysPython + '" -m venv "' + VENV_DIR + '"');
}

function installPythonDeps() {
  const pipCmd = '"' + pythonBin + '" -m pip';
  try {
    run(pipCmd + " install -q --upgrade pip");
  } catch (_) {}
  log("pip packages...");
  run(pipCmd + ' install -q -r "' + REQUIREMENTS + '"');
}

function predownloadModels() {
  log("TTS models (first run)...");
  const preloadCode = `
import torch
from ruaccent import RUAccent
a = RUAccent()
a.load(omograph_model_size="turbo3.1", use_dictionary=True, device="CPU")
torch.hub.load(repo_or_dir="snakers4/silero-models", model="silero_tts",
  language="ru", speaker="v5_ru", trust_repo=True)
`;
  const tmpFile = path.join(PYTHON_DIR, "_preload.py");
  fs.writeFileSync(tmpFile, preloadCode, "utf8");
  try {
    run('"' + pythonBin + '" "' + tmpFile + '"');
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

function startPythonServer() {
  return new Promise((resolve, reject) => {
    log("TTS...");
    pythonProcess = spawn(pythonBin, [TTS_SCRIPT], {
      cwd: PYTHON_DIR,
      env: {
        ...process.env,
        TORCH_HOME: path.join(PYTHON_DIR, ".torch"),
        HF_HOME: path.join(PYTHON_DIR, ".hf"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let ready = false;
    const onData = (data) => {
      const text = data.toString();
      // only surface errors / readiness, not torch noise
      if (/error|exception|traceback/i.test(text) && !/Uvicorn running/i.test(text)) {
        process.stderr.write(text);
      }
      if (!ready && (text.includes("Uvicorn running") || text.includes("Application startup complete") || text.includes("TTS ready"))) {
        ready = true;
        resolve();
      }
    };

    pythonProcess.stdout.on("data", onData);
    pythonProcess.stderr.on("data", onData);
    pythonProcess.on("error", (err) => {
      log("TTS start failed: " + err.message);
      reject(err);
    });
    pythonProcess.on("exit", (code) => {
      pythonProcess = null;
      if (!ready) reject(new Error("TTS exited " + code));
    });
    setTimeout(() => {
      if (!ready) {
        ready = true;
        resolve();
      }
    }, 180000);
  });
}

function startExpress() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "5mb" }));

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

  

  app.get("/api/books", (req, res) => {
    const lib = loadLibrary();
    const list = lib.map((b) => ({
      id: b.id,
      title: b.title,
      author: b.author,
      format: b.format,
      progress: b.progress || 0,
      chapterIndex: b.chapterIndex || 0,
      charOffset: b.charOffset || 0,
      addedAt: b.addedAt,
      chaptersCount: b.chaptersCount || 0,
      pageCount: b.pageCount || 0,
      hasCover: !!(b.coverFile && exists(path.join(BOOKS_DIR, b.coverFile))),
      series: b.series || "",
      year: b.year || null,
      description: b.description || "",
      status: b.status || (b.progress >= 100 ? "finished" : b.progress > 0 ? "reading" : "queue"),
    }));
    res.json(list);
  });

  app.post("/api/books", upload.single("book"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "Файл не получен" });
      }

      const ext = path.extname(req.file.originalname).toLowerCase().slice(1);
      const id = path.basename(req.file.filename, path.extname(req.file.filename));

      let parsed;
      let coverFile = null;

      if (ext === "epub") {
        parsed = await parseEpubAsync(req.file.path, req.file.originalname);
        if (parsed.coverBuffer) {
          const cext = parsed.coverExt || ".jpg";
          coverFile = id + "_cover" + cext;
          fs.writeFileSync(path.join(BOOKS_DIR, coverFile), parsed.coverBuffer);
        }
      } else {
        parsed = parseBook(req.file.path, req.file.originalname, ext);
        if (ext === "fb2") {
          try {
            const buffer = fs.readFileSync(req.file.path);
            const content = detectAndDecode(buffer);
            const parser = new XMLParser({
              ignoreAttributes: false,
              attributeNamePrefix: "@_",
              textNodeName: "#text",
              isArray: (name) =>
                ["section", "title", "p", "v", "emphasis", "strong", "binary", "image"].includes(name),
            });
            const xml = parser.parse(content);
            const fictionBook = xml.FictionBook || xml.fictionbook;
            if (fictionBook) {
              coverFile = extractFb2Cover(fictionBook, id);
            }
          } catch (e) {
            log("fb2 cover: " + e.message);
          }
        }
      }

      const pageCount = estimatePageCount(parsed.chapters);
      const book = {
        id,
        title: parsed.title,
        author: parsed.author,
        format: ext,
        filename: req.file.filename,
        progress: 0,
        chapterIndex: 0,
        charOffset: 0,
        addedAt: Date.now(),
        chaptersCount: parsed.chapters.length,
        pageCount,
        chapters: parsed.chapters,
        coverFile: coverFile || null,
        status: "queue",
      };

      const lib = loadLibrary();
      lib.unshift(book);
      
      const meta = { ...book };
      delete meta.chapters;
      lib[0] = meta;
      saveLibrary(lib);

      
      const chaptersPath = path.join(BOOKS_DIR, id + ".chapters.json");
      fs.writeFileSync(chaptersPath, JSON.stringify(parsed.chapters), "utf8");

      res.json({
        id: book.id,
        title: book.title,
        author: book.author,
        format: book.format,
        chaptersCount: book.chaptersCount,
        pageCount: book.pageCount,
        hasCover: !!coverFile,
      });
    } catch (err) {
      log("upload error: " + err.message);
      if (req.file && exists(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
      }
      res.status(400).json({ error: err.message || "Ошибка загрузки" });
    }
  });

  app.get("/api/books/:id", async (req, res) => {
    const lib = loadLibrary();
    const book = lib.find((b) => b.id === req.params.id);
    if (!book) return res.status(404).json({ error: "Книга не найдена" });

    const chaptersPath = path.join(BOOKS_DIR, book.id + ".chapters.json");
    try {
      let chapters = null;
      if (exists(chaptersPath)) {
        chapters = JSON.parse(fs.readFileSync(chaptersPath, "utf8"));
      } else if (book.chapters && book.chapters.length) {
        chapters = book.chapters;
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
        book.chaptersCount = chapters.length;
        saveLibrary(lib);
      }

      if (chapters && !book.pageCount) {
        book.pageCount = estimatePageCount(chapters);
        saveLibrary(lib);
      }

      res.json({
        id: book.id,
        title: book.title,
        author: book.author,
        format: book.format,
        progress: book.progress || 0,
        chapterIndex: book.chapterIndex || 0,
        charOffset: book.charOffset || 0,
        pageCount: book.pageCount || estimatePageCount(chapters),
        chapters,
      });
    } catch (err) {
      log("open book: " + err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/books/:id/cover", (req, res) => {
    const lib = loadLibrary();
    const book = lib.find((b) => b.id === req.params.id);
    if (!book || !book.coverFile) return res.status(404).end();
    const p = path.join(BOOKS_DIR, book.coverFile);
    if (!exists(p)) return res.status(404).end();
    res.sendFile(p);
  });

  app.patch("/api/books/:id", (req, res) => {
    const lib = loadLibrary();
    const book = lib.find((b) => b.id === req.params.id);
    if (!book) return res.status(404).json({ error: "Книга не найдена" });
    const { title, author, series, year, description, status } = req.body || {};
    if (title != null) {
      const t = String(title).trim();
      if (!t) return res.status(400).json({ error: "Пустое название" });
      book.title = t;
    }
    if (author != null) book.author = String(author).trim() || "Неизвестный автор";
    if (series != null) book.series = String(series).trim();
    if (year != null) {
      const y = String(year).trim();
      book.year = y ? Number(y) || null : null;
    }
    if (description != null) book.description = String(description).trim();
    if (status != null && ["queue", "reading", "finished"].includes(status)) {
      book.status = status;
    }
    saveLibrary(lib);
    res.json({
      ok: true,
      title: book.title,
      author: book.author,
      series: book.series || "",
      year: book.year || null,
      description: book.description || "",
      status: book.status || "queue",
    });
  });

  app.put("/api/books/:id/progress", (req, res) => {
    const lib = loadLibrary();
    const book = lib.find((b) => b.id === req.params.id);
    if (!book) return res.status(404).json({ error: "Книга не найдена" });

    const { chapterIndex, charOffset, progress } = req.body;
    if (typeof chapterIndex === "number") book.chapterIndex = chapterIndex;
    if (typeof charOffset === "number") book.charOffset = charOffset;
    if (typeof progress === "number") book.progress = Math.min(100, Math.max(0, progress));

    
    if (book.progress >= 100) book.status = "finished";
    else if (book.progress > 0 && book.status !== "finished") book.status = "reading";
    else if (!book.status) book.status = "queue";

    saveLibrary(lib);
    res.json({ ok: true, status: book.status });
  });

  app.delete("/api/books/:id", (req, res) => {
    const lib = loadLibrary();
    const idx = lib.findIndex((b) => b.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "Книга не найдена" });

    const book = lib[idx];
    const filePath = getBookPath(book);
    if (exists(filePath)) {
      try { fs.unlinkSync(filePath); } catch (_) {}
    }
    const chaptersPath = path.join(BOOKS_DIR, book.id + ".chapters.json");
    if (exists(chaptersPath)) {
      try { fs.unlinkSync(chaptersPath); } catch (_) {}
    }
    if (book.coverFile) {
      const cp = path.join(BOOKS_DIR, book.coverFile);
      if (exists(cp)) {
        try { fs.unlinkSync(cp); } catch (_) {}
      }
    }

    lib.splice(idx, 1);
    saveLibrary(lib);
    res.json({ ok: true });
  });

  
  app.use("/api/tts", async (req, res) => {
    
    const targetPath = (req.url || "/").split("?")[0] || "/";
    const target = "http://127.0.0.1:" + PYTHON_PORT + targetPath;

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

  app.listen(NODE_PORT, () => {
    log("http://localhost:" + NODE_PORT);
  });
}

async function main() {
  const setupOnly = process.argv.includes("--setup-only");
  ensureDir(BOOKS_DIR);

  if (needsSetup()) {
    log("setup...");
    ensureVenv();
    installPythonDeps();
    predownloadModels();
    writeSetupMarker();
    log("setup ok");
  }

  if (setupOnly) {
    process.exit(0);
  }

  await startPythonServer();
  startExpress();

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
