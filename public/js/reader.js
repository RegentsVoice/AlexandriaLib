let pageCache = new Map();
let headerHidden = false;
let lastScrollTop = 0;
let headerScrollBound = false;
let pageMetrics = {
  mode: "pages",
  pageIndex: 0,
  pageCount: 1,
  pages: [],
  chapterIndex: 0,
};
let pageCursor = { ch: 0, u: 0 };
let pageNextCursor = null;
let pageHistory = [];
let chapterUnitsCache = new Map();
let pageWheelLock = 0;
let pageTouch = null;
let progressTimer = null;
let scrollTimer = null;

function setHeaderHidden(hidden) {
  const hdr = $(".reader-header");
  if (!hdr) return;
  headerHidden = !!hidden;
  hdr.classList.toggle("header-hidden", headerHidden);
}

function bindReaderHeaderAutoHide() {
  const content = $("#readerContent");
  if (!content || headerScrollBound) return;
  headerScrollBound = true;
  lastScrollTop = content.scrollTop || 0;
  content.addEventListener(
    "scroll",
    () => {
      if (content.classList.contains("tts-scroll-lock")) return;
      const st = content.scrollTop;
      const dy = st - lastScrollTop;
      if (st < 40) {
        setHeaderHidden(false);
      } else if (dy > 8) {
        setHeaderHidden(true);
        
      } else if (dy < -8) {
        setHeaderHidden(false);
      }
      lastScrollTop = st;
    },
    { passive: true }
  );
  content.addEventListener(
    "click",
    () => {
      if (headerHidden) setHeaderHidden(false);
    },
    true
  );
}

function getLayoutMode() {
  return "pages";
}

function isTtsActivelyPlaying() {
  return !ttsStopped && isSpeaking && ttsAudio && !ttsAudio.paused;
}

function canTurnPages() {
  return !isTtsActivelyPlaying();
}

function getPagePadding() {
  return { x: 40, y: 28, bottom: 28, gap: 28 };
}

function useSpread() {
  return window.innerWidth >= 900;
}

function resetPageCursors(ch, u) {
  pageCursor = { ch: ch || 0, u: u || 0 };
  pageNextCursor = null;
  pageHistory = [];
  pageMetrics.pageIndex = 0;
}

function applyLayoutMode() {
  const content = $("#readerContent");
  const view = $("#readerView");
  const wrap = document.querySelector(".reader-view-wrap");
  if (!content) return;

  const spread = useSpread();
  content.classList.remove("layout-scroll", "layout-page", "layout-spread", "layout-pages");
  content.classList.add(spread ? "layout-spread" : "layout-pages");
  view?.classList.toggle("paged", true);
  wrap?.classList.toggle("paged", true);
  pageMetrics.mode = "pages";
  content.style.cssText = "";

  buildChapterPages(true);
  bindPagedNavigation();
}

function normHeading(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .replace(/[«»"„“”]/g, "")
    .trim()
    .toLowerCase();
}

function chapterUnits(chIndex) {
  if (chapterUnitsCache.has(chIndex)) return chapterUnitsCache.get(chIndex);
  const ch = currentBook?.chapters?.[chIndex];
  if (!ch) return [];
  const titleNorm = normHeading(ch.title);
  const units = [];
  if (ch.title && String(ch.title).trim()) {
    units.push({
      type: "title",
      ch: chIndex,
      html: `<div class="chapter-title" data-ch="${chIndex}">${escapeHtml(ch.title)}</div>`,
    });
  }
  let si = 0;
  const paragraphs = (ch.text || "").split(/\n{2,}/);
  paragraphs.forEach((p) => {
    p = p.trim();
    if (!p) return;
    if (titleNorm && normHeading(p) === titleNorm) return;
    const sentences = splitSentences(p);
    let added = 0;
    sentences.forEach((s) => {
      if (titleNorm && normHeading(s) === titleNorm) return;
      units.push({
        type: "sentence",
        ch: chIndex,
        si,
        text: s,
        html: `<span class="sentence" data-ch="${chIndex}" data-si="${si}">${escapeHtml(s)}</span>`,
      });
      si++;
      added++;
    });
    if (added) units.push({ type: "para-break", ch: chIndex });
  });
  chapterUnitsCache.set(chIndex, units);
  return units;
}

function collectUnitsFrom(ch, u, limit) {
  const out = [];
  const nCh = currentBook?.chapters?.length || 0;
  let c = Math.max(0, ch || 0);
  let i = Math.max(0, u || 0);
  while (out.length < limit && c < nCh) {
    const units = chapterUnits(c);
    if (!units.length) {
      c++;
      i = 0;
      continue;
    }
    if (i >= units.length) {
      c++;
      i = 0;
      continue;
    }
    while (i < units.length && out.length < limit) {
      out.push({ unit: units[i], ch: c, u: i });
      i++;
    }
    if (i >= units.length) {
      c++;
      i = 0;
    }
  }
  return out;
}

function advanceCursor(ch, u) {
  const nCh = currentBook?.chapters?.length || 0;
  let c = ch;
  let i = u + 1;
  while (c < nCh) {
    const units = chapterUnits(c);
    if (i < units.length) return { ch: c, u: i };
    c++;
    i = 0;
  }
  return null;
}

function unitsToHtml(list) {
  let html = "";
  let openP = false;
  for (const u of list) {
    if (u.type === "title") {
      if (openP) {
        html += "</p>";
        openP = false;
      }
      html += u.html;
    } else if (u.type === "para-break") {
      if (openP) {
        html += "</p>";
        openP = false;
      }
    } else if (u.type === "sentence") {
      if (!openP) {
        html += "<p>";
        openP = true;
      } else html += " ";
      html += u.html;
    }
  }
  if (openP) html += "</p>";
  return html;
}

function packPageFromCursor(cursor, pageW, pageH) {
  const batch = collectUnitsFrom(cursor.ch, cursor.u, 600);
  if (!batch.length) {
    return { html: "<p></p>", next: null, chapterIndex: cursor.ch || 0 };
  }
  if (pageW < 80 || pageH < 80) {
    const units = batch.map((b) => b.unit);
    const last = batch[batch.length - 1];
    return {
      html: unitsToHtml(units),
      next: advanceCursor(last.ch, last.u),
      chapterIndex: batch[0].ch,
    };
  }

  const measure = document.createElement("div");
  measure.className = "page-measure page-panel";
  measure.style.cssText = [
    "position:absolute",
    "left:-99999px",
    "top:0",
    "visibility:hidden",
    "pointer-events:none",
    `width:${Math.floor(pageW)}px`,
    `height:${Math.floor(pageH)}px`,
    "overflow:hidden",
    "box-sizing:border-box",
    "margin:0",
    "padding:0",
    `font-size:${settings.fontSize || 18}px`,
    `line-height:${settings.lineHeight || 1.65}`,
    'font-family:var(--font-read, Georgia, "Times New Roman", serif)',
  ].join(";");
  document.body.appendChild(measure);

  const units = batch.map((b) => b.unit);
  const fits = (to) => {
    measure.innerHTML = unitsToHtml(units.slice(0, to));
    void measure.offsetHeight;
    return measure.scrollHeight <= measure.clientHeight + 1;
  };

  let best = 1;
  if (!fits(1)) {
    measure.remove();
    const last = batch[0];
    return {
      html: unitsToHtml(units.slice(0, 1)),
      next: advanceCursor(last.ch, last.u),
      chapterIndex: last.ch,
    };
  }

  let lo = 1;
  let hi = units.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (fits(mid)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  measure.remove();
  const last = batch[best - 1];
  return {
    html: unitsToHtml(units.slice(0, best)),
    next: advanceCursor(last.ch, last.u),
    chapterIndex: batch[0].ch,
  };
}

function buildChapterPages(keepPage) {
  const wrap = document.querySelector(".reader-view-wrap");
  if (!wrap || !currentBook) return;

  const pad = getPagePadding();
  const wrapW = wrap.clientWidth;
  const wrapH = wrap.clientHeight;
  if (wrapW < 60 || wrapH < 60) return;

  const spread = useSpread();
  const pageW = spread
    ? Math.floor((wrapW - pad.x * 2 - pad.gap) / 2)
    : wrapW - pad.x * 2;
  const pageH = wrapH - pad.y - pad.bottom;

  if (!keepPage) {
    resetPageCursors(currentChapterIndex || 0, 0);
  } else if (!pageHistory.length && pageCursor.ch === 0 && pageCursor.u === 0) {
    resetPageCursors(currentChapterIndex || 0, 0);
  }

  const left = packPageFromCursor(pageCursor, pageW, pageH);
  let rightHtml = "";
  let next = left.next;
  if (spread && left.next) {
    const right = packPageFromCursor(left.next, pageW, pageH);
    rightHtml = right.html;
    next = right.next;
  }
  pageNextCursor = next;
  currentChapterIndex = left.chapterIndex;
  pageMetrics.chapterIndex = left.chapterIndex;
  pageMetrics.pages = spread ? [left.html, rightHtml] : [left.html];
  pageMetrics.pageCount = Math.max(1, estimateBookPages(currentBook));
  pageMetrics.mode = "pages";

  renderCurrentScreen();
}

function renderCurrentScreen() {
  const content = $("#readerContent");
  if (!content) return;

  const pad = getPagePadding();
  const spread = useSpread() && pageMetrics.pages.length > 1;
  const left = pageMetrics.pages[0] || "";
  const right = pageMetrics.pages[1] || "";

  if (spread) {
    content.innerHTML = `
      <div class="spread-row" style="gap:${pad.gap}px;padding:${pad.y}px ${pad.x}px ${pad.bottom}px;">
        <div class="page-panel">${left}</div>
        <div class="page-panel">${right}</div>
      </div>`;
  } else {
    content.innerHTML = `
      <div class="page-panel single" style="padding:${pad.y}px ${pad.x}px ${pad.bottom}px;">
        ${left}
      </div>`;
  }

  bindSentenceEvents();
  updatePageIndicator();
  saveProgressDebounced();
}

function turnPage(dir) {
  if (!canTurnPages()) return;
  if (!currentBook) return;

  if (dir > 0) {
    if (!pageNextCursor) return;
    pageHistory.push({ ch: pageCursor.ch, u: pageCursor.u });
    pageCursor = { ch: pageNextCursor.ch, u: pageNextCursor.u };
    pageMetrics.pageIndex = (pageMetrics.pageIndex || 0) + 1;
    buildChapterPages(true);
    return;
  }

  if (dir < 0) {
    if (!pageHistory.length) return;
    pageCursor = pageHistory.pop();
    pageMetrics.pageIndex = Math.max(0, (pageMetrics.pageIndex || 0) - 1);
    buildChapterPages(true);
  }
}

function goToPage(index) {
  if (!currentBook) return;
  index = Math.max(0, index || 0);
  resetPageCursors(0, 0);
  pageMetrics.pageIndex = 0;
  buildChapterPages(true);
  let guard = 0;
  while (pageMetrics.pageIndex < index && pageNextCursor && guard < index + 2) {
    pageHistory.push({ ch: pageCursor.ch, u: pageCursor.u });
    pageCursor = { ch: pageNextCursor.ch, u: pageNextCursor.u };
    pageMetrics.pageIndex++;
    buildChapterPages(true);
    guard++;
    if (!pageNextCursor) break;
  }
}

function estimateCharsPerPage() {
  return 1800;
}

function estimateBookPages(book) {
  if (!book) return 1;
  if (book.pageCount && book.pageCount > 0) return book.pageCount;
  const chapters = book.chapters || [];
  let len = 0;
  for (const ch of chapters) len += (ch.text || "").length;
  if (!len && book.chaptersCount) return Math.max(1, book.chaptersCount * 5);
  return Math.max(1, Math.ceil(len / estimateCharsPerPage()));
}

function estimateGlobalPage() {
  if (!currentBook) return 1;
  const cpp = estimateCharsPerPage();
  let charsBefore = 0;
  const chapters = currentBook.chapters || [];
  for (let i = 0; i < (currentChapterIndex || 0); i++) {
    charsBefore += (chapters[i]?.text || "").length;
  }
  
  return Math.max(1, Math.floor(charsBefore / cpp) + (pageMetrics.pageIndex || 0) + 1);
}

function updatePageIndicator() {
  const el = $("#pageIndicator");
  if (el) {
    const mode = settings.pageIndicatorMode || "total";
    if (mode === "chapter") {
      const ch = (currentChapterIndex || 0) + 1;
      const chTotal = currentBook?.chapters?.length || 1;
      el.textContent = `гл. ${ch}/${chTotal}`;
    } else {
      const total = estimateBookPages(currentBook);
      const cur = Math.min(total, (pageMetrics.pageIndex || 0) + 1);
      el.textContent = `${cur} / ${total}`;
    }
  }
  const chEl = $("#readerBarChapter");
  if (chEl) {
    const title =
      currentBook?.chapters?.[currentChapterIndex || 0]?.title ||
      currentBook?.title ||
      "";
    chEl.textContent = title;
    chEl.title = title;
  }
  updateReaderBarTts();
}

function bindPagedNavigation() {
  const wrap = document.querySelector(".reader-view-wrap");
  if (!wrap || wrap.dataset.pagedBound === "1") return;
  wrap.dataset.pagedBound = "1";

  wrap.addEventListener(
    "wheel",
    (e) => {
            e.preventDefault();
      if (!canTurnPages()) return;
      const now = Date.now();
      if (now - pageWheelLock < 280) return;
      const dominant =
        Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (Math.abs(dominant) < 6) return;
      pageWheelLock = now;
      turnPage(dominant > 0 ? 1 : -1);
    },
    { passive: false }
  );

  wrap.addEventListener(
    "touchstart",
    (e) => {
            const t = e.changedTouches[0];
      pageTouch = { x: t.clientX, y: t.clientY };
    },
    { passive: true }
  );

  wrap.addEventListener(
    "touchmove",
    (e) => {
            e.preventDefault();
    },
    { passive: false }
  );

  wrap.addEventListener(
    "touchend",
    (e) => {
            if (!pageTouch) return;
      if (!canTurnPages()) {
        pageTouch = null;
        return;
      }
      const t = e.changedTouches[0];
      const dx = t.clientX - pageTouch.x;
      const dy = t.clientY - pageTouch.y;
      pageTouch = null;
      if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return;
      turnPage(dx < 0 ? 1 : -1);
    },
    { passive: true }
  );
}

async function openBook(id) {
  try {
    stopTts(false);
    currentBook = await api("/api/books/" + id);
    chapterUnitsCache.clear();
    pageCache.clear();

    const ch = Math.max(
      0,
      Math.min(
        (currentBook.chapters?.length || 1) - 1,
        currentBook.chapterIndex || 0
      )
    );
    currentChapterIndex = ch;
    const units = chapterUnits(ch);
    let u = Number(currentBook.charOffset) || 0;
    if (u < 0) u = 0;
    if (units.length && u >= units.length) u = Math.max(0, units.length - 1);
    resetPageCursors(ch, u);

    $("#libraryView").classList.add("hidden");
    $("#bookDetailView").classList.add("hidden");
    $("#readerView").classList.remove("hidden");

    $("#readerTitle").textContent = currentBook.title;
    $("#readerAuthor").textContent = currentBook.author;

    bindReaderHeaderAutoHide();
    setHeaderHidden(false);
    applyLayoutMode();
    updatePageIndicator();
  } catch (err) {
    alert(err.message);
  }
}

function splitSentences(text) {
  
  const re = /[^.!?…]+(?:[.!?…]+(?:["»”']+)?)?[ \t]*|[^.!?…\n]+/g;
  const parts = text.match(re) || [text];
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

function formatChapterText(text, chapterIndex) {
  const paragraphs = text.split(/\n{2,}/);
  let globalSi = 0;
  return paragraphs
    .map((p) => {
      p = p.trim();
      if (!p) return "";
      const sentences = splitSentences(p);
      const inner = sentences
        .map((s) => `<span class="sentence" data-ch="${chapterIndex}" data-si="${globalSi++}">${escapeHtml(s)}</span>`)
        .join(" ");
      return `<p>${inner}</p>`;
    })
    .join("");
}

function renderChapters() {
  if (!currentBook) return;
  buildChapterPages(false);
}

function scrollToChapter(index, smooth = true) {
  currentChapterIndex = index;
  resetPageCursors(index, 0);
  buildChapterPages(true);
  saveProgressDebounced();
}

function splitChapterIntoSentences(chapterText) {
  const parts = [];
  const paragraphs = String(chapterText || "").split(/\n{2,}/);
  for (const p of paragraphs) {
    const trimmed = p.trim();
    if (!trimmed) continue;
    const sentences = splitSentences(trimmed);
    if (sentences.length) parts.push(...sentences);
    else parts.push(trimmed);
  }
  if (!parts.length) {
    const raw = String(chapterText || "").trim();
    if (raw) {
      for (let i = 0; i < raw.length; i += 400) parts.push(raw.slice(i, i + 400));
    }
  }
  return parts;
}

function collectSentencesFromChapter(chapterIndex) {
  return chapterUnits(chapterIndex)
    .filter((u) => u.type === "sentence" && u.text)
    .map((u) => ({
      ch: chapterIndex,
      si: u.si,
      text: u.text,
    }));
}

function normSentenceText(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function collectFromPick(ch, si, clickedText) {
  const all = collectSentencesFromChapter(ch);
  if (!all.length) return [];

  const want = normSentenceText(clickedText);
  let start = all.findIndex((s) => s.si === si);

  if (start >= 0 && want) {
    const got = normSentenceText(all[start].text);
    if (got !== want && !got.startsWith(want) && !want.startsWith(got)) {
      start = -1;
    }
  }

  if (start < 0 && want) {
    start = all.findIndex((s) => normSentenceText(s.text) === want);
  }
  if (start < 0 && want) {
    start = all.findIndex((s) => {
      const t = normSentenceText(s.text);
      return t.startsWith(want) || want.startsWith(t);
    });
  }
  if (start < 0) {
    start = all.findIndex((s) => s.si === si);
  }
  if (start < 0) start = 0;
  return all.slice(start);
}

function bindSentenceEvents() {
  const content = $("#readerContent");
  if (!content) return;

  content.onmouseover = (e) => {
    const s = e.target.closest(".sentence");
    content.querySelectorAll(".sentence.hover").forEach((el) => {
      if (el !== s) el.classList.remove("hover");
    });
    if (s && !s.classList.contains("active")) s.classList.add("hover");
  };

  content.onmouseout = (e) => {
    const s = e.target.closest(".sentence");
    if (s) s.classList.remove("hover");
  };

  content.onclick = (e) => {
    const s = e.target.closest(".sentence");
    if (!s) return;
    e.stopPropagation();
    try {
      const sel = window.getSelection && window.getSelection();
      if (sel && sel.removeAllRanges) sel.removeAllRanges();
    } catch (_) {}

    const ch = Number(s.dataset.ch);
    const si = Number(s.dataset.si);
    if (!Number.isFinite(ch) || !Number.isFinite(si)) return;
    const clickedText = normSentenceText(s.textContent);
    ttsPicked = { ch, si, text: clickedText };

    $$(".sentence.picked, .sentence.hover, .sentence.active").forEach((el) => {
      el.classList.remove("picked", "hover", "active");
    });
    s.classList.add("active");

    startTtsFromPick();
  };

  content.oncontextmenu = null;
}

function saveProgressDebounced() {
  clearTimeout(progressTimer);
  progressTimer = setTimeout(saveProgress, 1500);
}

async function saveProgress() {
  if (!currentBook) return;
  const totalCh = Math.max(1, currentBook.chapters?.length || 1);
  const ch = Number.isFinite(pageCursor?.ch) ? pageCursor.ch : currentChapterIndex || 0;
  const u = Number.isFinite(pageCursor?.u) ? pageCursor.u : 0;
  const units = typeof chapterUnits === "function" ? chapterUnits(ch) : [];
  const totalU = Math.max(1, units.length || 1);
  const frac = Math.min(1, Math.max(0, u / totalU));
  let progress = Math.round(((ch + frac) / totalCh) * 100);
  if (ch >= totalCh - 1 && frac >= 0.92) progress = 100;
  progress = Math.min(100, Math.max(0, progress));
  const body = {
    chapterIndex: ch,
    charOffset: u,
    progress,
  };
  if (currentBook.lastTts && currentBook.lastTts.ch != null && currentBook.lastTts.si != null) {
    body.lastTts = {
      ch: Number(currentBook.lastTts.ch),
      si: Number(currentBook.lastTts.si),
    };
  }
  try {
    await api("/api/books/" + currentBook.id + "/progress", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    currentBook.chapterIndex = ch;
    currentBook.charOffset = u;
    currentBook.progress = progress;
  } catch (_) {}
}

$("#readerContent")?.addEventListener("scroll", () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    if (!currentBook) return;
    const chapters = $$(".chapter");
    let closest = 0;
    let minDist = Infinity;
    const scrollTop = $("#readerContent").scrollTop;
    chapters.forEach((el, i) => {
      const dist = Math.abs(el.offsetTop - scrollTop - 40);
      if (dist < minDist) {
        minDist = dist;
        closest = i;
      }
    });
    if (closest !== currentChapterIndex) {
      currentChapterIndex = closest;
      saveProgressDebounced();
    }
  }, 300);
});

$("#btnToc").addEventListener("click", () => {
  const list = $("#tocList");
  list.innerHTML = currentBook.chapters
    .map(
      (ch, i) =>
        `<button class="toc-item ${i === currentChapterIndex ? "active" : ""}" data-index="${i}">${escapeHtml(ch.title)}</button>`
    )
    .join("");

  list.querySelectorAll(".toc-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      scrollToChapter(Number(btn.dataset.index));
      $("#tocOverlay").classList.add("hidden");
      saveProgressDebounced();
    });
  });

  $("#tocOverlay").classList.remove("hidden");
});

$("#btnCloseToc").addEventListener("click", () => {
  $("#tocOverlay").classList.add("hidden");
});

