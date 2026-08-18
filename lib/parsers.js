const fs = require("fs");
const path = require("path");
const { XMLParser } = require("fast-xml-parser");
const JSZip = require("jszip");
const { BOOKS_DIR } = require("./config");
const { log, exists } = require("./utils");

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
    const dir = path.join(BOOKS_DIR, bookId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const coverName = "cover" + ext;
    fs.writeFileSync(path.join(dir, coverName), buf);
    return bookId + "/" + coverName;
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

module.exports = {
  parseTxt,
  extractTextFromFb2Node,
  parseFb2,
  detectAndDecode,
  extractFb2Cover,
  parseEpubAsync,
  estimatePageCount,
  parseBook,
};

