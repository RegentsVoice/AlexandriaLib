

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let books = [];
let currentBook = null;
let currentChapterIndex = 0;
let isSpeaking = false;
let settings = loadSettings();

let ttsSentences = [];
let ttsPos = 0;
let ttsPrefetch = null;
let ttsPrefetchPromise = null;
let ttsStopped = true;
let ttsPicked = null; 
let ttsPanelOpen = false;
let ttsGeneration = 0; 
let ttsAbort = null; 
let ttsPrefetchAbort = null;
let sleepTimerId = null;
let sleepTimerEndsAt = 0;
let sleepStopAtChapterEnd = false;
let sleepCountdownId = null;
let pageCache = new Map(); 

function setPlayIcon(playing) {
  const btn = $("#btnTtsPlay");
  if (!btn) return;
  const href = playing ? "#i-pause" : "#i-play";
  btn.innerHTML = `<svg class="icon icon-play"><use href="${href}"/></svg>`;
  btn.title = playing ? "Пауза" : "Слушать";
  btn.setAttribute("aria-label", playing ? "Пауза" : "Слушать");
}

function updateMediaSession(state) {
  if (!("mediaSession" in navigator)) return;
  try {
    const title = currentBook?.title || "AlexandriaLib";
    const artist = currentBook?.author || "Озвучка";
    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist,
      album: "AlexandriaLib",
    });
    navigator.mediaSession.playbackState = state || "none";
  } catch (_) {}
}

function setupMediaSessionHandlers() {
  if (!("mediaSession" in navigator) || setupMediaSessionHandlers.done) return;
  setupMediaSessionHandlers.done = true;
  try {
    navigator.mediaSession.setActionHandler("play", () => {
      if (ttsAudio.paused) {
        ttsAudio.play().catch(() => {});
        setPlayIcon(true);
        setScrollLock(true);
        updateMediaSession("playing");
      }
    });
    navigator.mediaSession.setActionHandler("pause", () => {
      ttsAudio.pause();
      setPlayIcon(false);
      setScrollLock(false);
      updateMediaSession("paused");
    });
    navigator.mediaSession.setActionHandler("previoustrack", () => {
      $("#btnTtsPrev")?.click();
    });
    navigator.mediaSession.setActionHandler("nexttrack", () => {
      $("#btnTtsNext")?.click();
    });
    navigator.mediaSession.setActionHandler("stop", () => {
      stopTts();
      updateMediaSession("none");
    });
  } catch (_) {}
}

let headerHidden = false;
let lastScrollTop = 0;
let headerScrollBound = false;

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

let libQuery = "";
let libStatus = (localStorage.getItem("al_lib_status") || localStorage.getItem("sr_lib_status")) || "all";
let detailBookId = null;
let libSort = (localStorage.getItem("al_lib_sort") || localStorage.getItem("sr_lib_sort")) || "recent";

function showToast(message, type = "error", ms = 4200) {
  const host = $("#toastHost");
  if (!host) {
    console.warn(message);
    return;
  }
  const el = document.createElement("div");
  el.className = "toast " + (type === "ok" ? "ok" : type === "error" ? "error" : "");
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity 0.25s";
    setTimeout(() => el.remove(), 280);
  }, ms);
}

function loadSettings() {
  try {
    const s = JSON.parse((localStorage.getItem("al_settings") || localStorage.getItem("sr_settings")) || "{}");
    
    if (s.layoutMode === "spread" || s.layoutMode === "page") s.layoutMode = "pages";
    if (!s.layoutMode) s.layoutMode = "pages";
    if (!s.theme) s.theme = "sepia";
    if (!s.pageIndicatorMode) s.pageIndicatorMode = "total";
    if (s.volume == null) s.volume = 1;
    return s;
  } catch {
    return { layoutMode: "pages", theme: "sepia", pageIndicatorMode: "total", volume: 1 };
  }
}

function saveSettings() {
  localStorage.setItem("al_settings", JSON.stringify(settings));
}

function applySettings() {
  const root = document.documentElement;
  const fontSize = settings.fontSize || 18;
  const lineHeight = settings.lineHeight || 1.65;
  const theme = settings.theme || "sepia";
  const width = settings.contentWidth || "normal";

  root.style.setProperty("--reader-font-size", fontSize + "px");
  root.style.setProperty("--reader-line-height", String(lineHeight));

  const widths = { narrow: "560px", normal: "680px", wide: "860px" };
  root.style.setProperty("--reader-max-width", widths[width] || "680px");

  const nextTheme = ["dark", "light", "sepia", "black"].includes(theme) ? theme : "sepia";
  root.setAttribute("data-theme", nextTheme);
  if (document.body) document.body.setAttribute("data-theme", nextTheme);

  const meta = document.querySelector('meta[name="theme-color"]');
  const colors = { dark: "#0b0b0c", light: "#f2f2f7", sepia: "#f4ecd8", black: "#000000" };
  if (meta) meta.setAttribute("content", colors[nextTheme] || colors.sepia);

  const content = $("#readerContent");
  if (content) {
    content.style.fontSize = fontSize + "px";
    content.style.lineHeight = String(lineHeight);
    content.classList.remove("width-narrow", "width-wide");
    if (width === "narrow") content.classList.add("width-narrow");
    if (width === "wide") content.classList.add("width-wide");
  }

  pageCache.clear();
  applyLayoutMode();

  if ($("#fontSize")) {
    $("#fontSize").value = fontSize;
    $("#fontSizeVal").textContent = fontSize;
  }
  if ($("#lineHeight")) {
    $("#lineHeight").value = lineHeight;
    $("#lineHeightVal").textContent = lineHeight;
  }
  if ($("#themeSelect")) $("#themeSelect").value = theme;
  if ($("#contentWidth")) $("#contentWidth").value = width;
  if ($("#layoutMode")) {
    let lm = settings.layoutMode || "pages";
    if (lm === "spread" || lm === "page") lm = "pages";
    $("#layoutMode").value = lm;
  }
  if ($("#pageIndicatorMode")) $("#pageIndicatorMode").value = settings.pageIndicatorMode || "total";
  if (typeof updateThemeSwatches === "function") updateThemeSwatches();

  if (settings.speaker && $("#ttsSpeaker")) $("#ttsSpeaker").value = settings.speaker;
  if (settings.speed && $("#ttsSpeed")) {
    $("#ttsSpeed").value = settings.speed;
    $("#ttsSpeedVal").textContent = Number(settings.speed).toFixed(1) + "×";
  }
  const vol = settings.volume != null ? Number(settings.volume) : 1;
  if ($("#ttsVolume")) {
    $("#ttsVolume").value = vol;
    $("#ttsVolumeVal").textContent = Math.round(vol * 100) + "%";
  }
  if (typeof ttsAudio !== "undefined" && ttsAudio) {
    ttsAudio.volume = Math.min(1, Math.max(0, vol));
  }
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || "Ошибка запроса");
  }
  return res.json();
}

async function loadBooks() {
  books = await api("/api/books");
  renderLibrary();
}

function fitCoverImage(img, host) {
  if (!img || !host) return;
  const apply = () => {
    host.classList.remove("is-cover", "is-contain");
    const nw = img.naturalWidth || 0;
    const nh = img.naturalHeight || 0;
    if (!nw || !nh) {
      host.classList.add("is-contain");
      return;
    }
    const ratio = nw / nh;
    
    if (ratio > 0.95 || ratio < 0.45 || nw < 120 || nh < 160) {
      host.classList.add("is-contain");
    } else {
      host.classList.add("is-cover");
    }
  };
  if (img.complete && img.naturalWidth) apply();
  else img.addEventListener("load", apply, { once: true });
}

function coverGradient(title) {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) >>> 0;
  const a = h % 360;
  const b = (h * 7) % 360;
  return `linear-gradient(145deg, hsl(${a} 42% 28%), hsl(${b} 48% 18%))`;
}

function bookStatus(b) {
  if (b.status && ["queue", "reading", "finished"].includes(b.status)) return b.status;
  if ((b.progress || 0) >= 100) return "finished";
  if ((b.progress || 0) > 0) return "reading";
  return "queue";
}

function filteredBooks() {
  let list = books.slice();
  const q = (libQuery || "").trim().toLowerCase();
  if (q) {
    list = list.filter(
      (b) =>
        (b.title || "").toLowerCase().includes(q) ||
        (b.author || "").toLowerCase().includes(q)
    );
  }
  if (libStatus && libStatus !== "all") {
    list = list.filter((b) => bookStatus(b) === libStatus);
  }
  const sort = libSort || "recent";
  list.sort((a, b) => {
    if (sort === "title")
      return (a.title || "").localeCompare(b.title || "", "ru", { sensitivity: "base" });
    if (sort === "author")
      return (a.author || "").localeCompare(b.author || "", "ru", { sensitivity: "base" });
    if (sort === "progress") return (b.progress || 0) - (a.progress || 0);
    
    return (b.addedAt || 0) - (a.addedAt || 0);
  });
  return list;
}

function renderLibrary() {
  const list = $("#booksList");
  const empty = $("#emptyState");
  const items = filteredBooks();
  const contSec = $("#continueSection");
  const contList = $("#continueList");
  const sectionTitle = $("#librarySectionTitle");

  if (list) list.classList.add("books-grid");

  
  if (sectionTitle) {
    const titles = {
      all: "Все книги",
      reading: "Читаю",
      queue: "В очереди",
      finished: "Прочитано",
    };
    sectionTitle.textContent = titles[libStatus] || "Все книги";
  }

  
  const continueBooks = books
    .filter((b) => (b.progress || 0) > 0 && (b.progress || 0) < 100)
    .sort((a, b) => (b.progress || 0) - (a.progress || 0))
    .slice(0, 12);

  if (contSec && contList) {
    const showCont = continueBooks.length > 0 && !libQuery && (libStatus === "all" || libStatus === "reading");
    contSec.classList.toggle("hidden", !showCont);
    if (showCont) {
      contList.innerHTML = continueBooks
        .map((b) => {
          const letter = (b.title || "?").trim().charAt(0).toUpperCase();
          const prog = Math.round(b.progress || 0);
          const thumb = b.hasCover
            ? `<img class="continue-img" src="/api/books/${b.id}/cover" alt="" loading="lazy" draggable="false" />`
            : `<span class="letter" style="background:${coverGradient(b.title || "")}">${escapeHtml(letter)}</span>`;
          return `<button type="button" class="continue-card" data-id="${b.id}">
            <div class="thumb">${thumb}<div class="bar"><i style="width:${prog}%"></i></div></div>
            <div class="ctitle">${escapeHtml(b.title)}</div>
            <div class="cmeta">${prog}%</div>
          </button>`;
        })
        .join("");
      contList.querySelectorAll(".continue-card").forEach((btn) => {
        btn.addEventListener("click", () => openBookDetail(btn.dataset.id));
      });
    } else {
      contList.innerHTML = "";
    }
  }

  if (!books.length) {
    list.innerHTML = "";
    empty.classList.remove("hidden");
    const t = empty.querySelector(".empty-title");
    if (t) t.textContent = "Пока нет книг";
    contSec?.classList.add("hidden");
    return;
  }

  if (!items.length) {
    list.innerHTML = "";
    empty.classList.remove("hidden");
    const t = empty.querySelector(".empty-title");
    if (t) t.textContent = "Ничего не найдено";
    const hint = empty.querySelector(".hint");
    if (hint) hint.textContent = "Попробуйте другой запрос";
    return;
  }

  empty.classList.add("hidden");
  list.innerHTML = items
    .map((b) => {
      const letter = (b.title || "?").trim().charAt(0).toUpperCase();
      const hasCover = !!b.hasCover;
      const st = bookStatus(b);
      const prog = Math.round(b.progress || 0);
      const media = hasCover
        ? `<img class="bc-img" src="/api/books/${b.id}/cover" alt="" loading="lazy" draggable="false" />`
        : `<div class="bc-placeholder" style="background:${coverGradient(b.title || "")}"><span>${escapeHtml(letter)}</span></div>`;
      return `<article class="bc${hasCover ? " has-cover" : ""}" data-id="${b.id}">
  <div class="bc-media">${media}</div>
  <div class="bc-ui">
    <span class="bc-status ${st}"></span>
    <span class="bc-progress">${prog}%</span>
    <button type="button" class="bc-delete delete-btn" data-id="${b.id}" title="Удалить" aria-label="Удалить">
      <svg class="icon"><use href="#i-trash"/></svg>
    </button>
    <div class="bc-caption">
      <div class="bc-title">${escapeHtml(b.title)}</div>
      <div class="bc-author">${escapeHtml(b.author || "")}</div>
    </div>
  </div>
</article>`;
    })
    .join("");

  list.querySelectorAll(".bc").forEach((card) => {
    const img = card.querySelector(".bc-img");
    if (img) {
      img.addEventListener("error", () => {
        card.classList.remove("has-cover", "is-cover", "is-contain");
        const media = card.querySelector(".bc-media");
        const letter = (card.querySelector(".bc-title")?.textContent || "?").trim().charAt(0).toUpperCase();
        if (media) {
          media.innerHTML = `<div class="bc-placeholder" style="background:${coverGradient(letter)}"><span>${escapeHtml(letter)}</span></div>`;
        }
      });
      fitCoverImage(img, card);
    }
    card.addEventListener("click", (e) => {
      if (e.target.closest(".bc-delete, .delete-btn")) return;
      openBookDetail(card.dataset.id);
    });
  });

  list.querySelectorAll(".delete-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("Удалить книгу?")) return;
      try {
        await api("/api/books/" + btn.dataset.id, { method: "DELETE" });
        showToast("Книга удалена", "ok", 2500);
        await loadBooks();
      } catch (err) {
        showToast(err.message || "Ошибка удаления", "error");
      }
    });
  });
}

function openBookDetail(id) {
  const book = books.find((b) => b.id === id);
  if (!book) return;
  detailBookId = id;

  $("#libraryView").classList.add("hidden");
  $("#bookDetailView").classList.remove("hidden");
  $("#readerView").classList.add("hidden");

  renderBookDetail(book);
}

function renderBookDetail(book) {
  const setVal = (sel, v) => {
    const el = $(sel);
    if (el && "value" in el) el.value = v ?? "";
  };
  setVal("#detailTitle", book.title || "");
  setVal("#detailAuthor", book.author || "");
  setVal("#detailSeries", book.series || "");
  setVal("#detailYear", book.year || "");
  setVal("#detailDesc", book.description || "");

  const cover = $("#detailCover");
  if (cover) {
    const letter = (book.title || "?").trim().charAt(0).toUpperCase();
    if (book.hasCover) {
      cover.className = "detail-cover has-img";
      cover.style.background = "";
      cover.innerHTML = `<img class="detail-cover-img" src="/api/books/${book.id}/cover" alt="" draggable="false" />`;
      const img = cover.querySelector("img");
      if (img) {
        img.addEventListener("error", () => {
          cover.classList.remove("has-img", "is-cover", "is-contain");
          cover.style.background = coverGradient(book.title || "");
          cover.innerHTML = `<span class="cover-letter">${escapeHtml(letter)}</span>`;
        });
        fitCoverImage(img, cover);
      }
    } else {
      cover.className = "detail-cover";
      cover.classList.remove("is-cover", "is-contain");
      cover.style.background = coverGradient(book.title || "");
      cover.innerHTML = `<span class="cover-letter">${escapeHtml(letter)}</span>`;
    }
  }

  const progress = Math.round(book.progress || 0);
  const pv = $("#detailProgressVal");
  const pb = $("#detailProgressBar");
  if (pv) pv.textContent = progress + "%";
  if (pb) pb.style.width = progress + "%";

  const meta = [];
  meta.push(`<span class="badge">${escapeHtml((book.format || "").toUpperCase())}</span>`);
  meta.push(`<span class="chip">${book.chaptersCount || "?"} гл.</span>`);
  const dm = $("#detailMeta");
  if (dm) dm.innerHTML = meta.join("");

  const cont = $("#btnDetailContinue");
  const read = $("#btnDetailRead");
  if (cont && read) {
    if (progress > 0 && progress < 100) {
      cont.classList.remove("hidden");
      cont.textContent = "Продолжить · " + progress + "%";
      read.textContent = "Читать с начала";
    } else if (progress >= 100) {
      cont.classList.add("hidden");
      read.textContent = "Читать снова";
    } else {
      cont.classList.add("hidden");
      read.textContent = "Читать";
    }
  }

  const stSel = $("#detailStatus");
  if (stSel) stSel.value = bookStatus(book);

  const hint = $("#detailSaveHint");
  if (hint) {
    hint.textContent = "";
    hint.className = "detail-save-hint";
  }
}

function closeBookDetail() {
  detailBookId = null;
  $("#bookDetailView").classList.add("hidden");
  $("#libraryView").classList.remove("hidden");
}

let detailSaveTimer = null;

function scheduleDetailSave() {
  clearTimeout(detailSaveTimer);
  const hint = $("#detailSaveHint");
  if (hint) {
    hint.textContent = "Сохранение…";
    hint.className = "detail-save-hint saving";
  }
  detailSaveTimer = setTimeout(saveDetailBook, 450);
}

async function saveDetailBook() {
  if (!detailBookId) return;
  const title = ($("#detailTitle")?.value || "").trim();
  if (!title) {
    const hint = $("#detailSaveHint");
    if (hint) {
      hint.textContent = "Название не может быть пустым";
      hint.className = "detail-save-hint error";
    }
    return;
  }
  const payload = {
    title,
    author: ($("#detailAuthor")?.value || "").trim(),
    series: ($("#detailSeries")?.value || "").trim(),
    year: ($("#detailYear")?.value || "").trim(),
    description: ($("#detailDesc")?.value || "").trim(),
    status: $("#detailStatus")?.value || "queue",
  };
  try {
    await api("/api/books/" + detailBookId, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    await loadBooks();
    const hint = $("#detailSaveHint");
    if (hint) {
      hint.textContent = "Сохранено";
      hint.className = "detail-save-hint saved";
      setTimeout(() => {
        if (hint.textContent === "Сохранено") {
          hint.textContent = "";
          hint.className = "detail-save-hint";
        }
      }, 1600);
    }
  } catch (err) {
    const hint = $("#detailSaveHint");
    if (hint) {
      hint.textContent = err.message || "Ошибка сохранения";
      hint.className = "detail-save-hint error";
    }
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let pageMetrics = {
  mode: "scroll",
  pageIndex: 0,
  pageCount: 1,
  pages: [],
  chapterIndex: 0,
};

function pageCacheKey(chIndex, mode, w, h, fontSize, lineHeight) {
  return [currentBook?.id, chIndex, mode, w, h, fontSize, lineHeight].join("|");
}

function getLayoutMode() {
  let m = settings.layoutMode || "pages";
  if (m === "spread" || m === "page") m = "pages";
  return m;
}

function isTtsActivelyPlaying() {
  return !ttsStopped && isSpeaking && ttsAudio && !ttsAudio.paused;
}

function canTurnPages() {
  return pageMetrics.mode !== "scroll" && !isTtsActivelyPlaying();
}

function getPagePadding() {
  return { x: 28, y: 24, gap: 24 };
}

function applyLayoutMode() {
  

  const content = $("#readerContent");
  const view = $("#readerView");
  const wrap = document.querySelector(".reader-view-wrap");
  if (!content) return;

  const mode = getLayoutMode(); 
  const effective = mode === "pages" ? "pages" : "scroll";

  content.classList.remove("layout-scroll", "layout-page", "layout-spread", "layout-pages");
  content.classList.add("layout-" + effective);
  view?.classList.toggle("paged", effective === "pages");
  wrap?.classList.toggle("paged", effective === "pages");
  pageMetrics.mode = effective;
  content.style.cssText = "";

  if (effective === "scroll") {
    pageMetrics.pageIndex = 0;
    pageMetrics.pageCount = 1;
    pageMetrics.pages = [];
    if (currentBook) renderScrollContent();
    updatePageIndicator();
    bindPagedNavigation();
    return;
  }

  
  pageMetrics.chapterIndex = currentChapterIndex || 0;
  buildChapterPages(true);
  bindPagedNavigation();
}

function buildFullBookHtml() {
  if (!currentBook) return "";
  return currentBook.chapters
    .map(
      (ch, i) => `
    <div class="chapter" data-index="${i}">
      <div class="chapter-title">${escapeHtml(ch.title)}</div>
      <div class="chapter-body">${formatChapterText(ch.text, i)}</div>
    </div>`
    )
    .join("");
}

function renderScrollContent() {
  const content = $("#readerContent");
  if (!content || !currentBook) return;
  content.innerHTML = buildFullBookHtml();
  bindSentenceEvents();
}

function chapterUnits(chIndex) {
  const ch = currentBook?.chapters?.[chIndex];
  if (!ch) return [];
  const units = [
    { type: "title", html: `<div class="chapter-title">${escapeHtml(ch.title)}</div>` },
  ];
  let si = 0;
  const paragraphs = (ch.text || "").split(/\n{2,}/);
  paragraphs.forEach((p) => {
    p = p.trim();
    if (!p) return;
    const sentences = splitSentences(p);
    sentences.forEach((s, sj) => {
      units.push({
        type: "sentence",
        html: `<span class="sentence" data-ch="${chIndex}" data-si="${si}">${escapeHtml(s)}</span>`,
      });
      si++;
    });
    if (sentences.length) units.push({ type: "para-break" });
  });
  return units;
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

function paginateUnits(units, pageW, pageH) {
  if (!units.length) return ["<p></p>"];

  const measure = document.createElement("div");
  measure.className = "page-measure page-panel";
  measure.style.cssText = [
    "position:absolute",
    "left:-99999px",
    "top:0",
    "visibility:hidden",
    "pointer-events:none",
    `width:${pageW}px`,
    `height:${pageH}px`,
    "overflow:hidden",
    "box-sizing:border-box",
    `font-size:${settings.fontSize || 18}px`,
    `line-height:${settings.lineHeight || 1.65}`,
  ].join(";");
  document.body.appendChild(measure);

  const fitsRange = (from, to) => {
    measure.innerHTML = unitsToHtml(units.slice(from, to));
    return measure.scrollHeight <= measure.clientHeight + 2;
  };

  const pages = [];
  let start = 0;
  const n = units.length;

  while (start < n) {
    
    while (start < n && units[start].type === "para-break") start++;
    if (start >= n) break;

    
    let lo = start + 1;
    let hi = n;
    let best = start + 1;
    
    if (!fitsRange(start, start + 1)) {
      pages.push(unitsToHtml(units.slice(start, start + 1)));
      start = start + 1;
      continue;
    }
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (fitsRange(start, mid)) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    pages.push(unitsToHtml(units.slice(start, best)));
    start = best;
  }

  measure.remove();
  return pages.length ? pages : ["<p></p>"];
}

function buildChapterPages(keepPage) {
  const wrap = document.querySelector(".reader-view-wrap");
  if (!wrap || !currentBook || pageMetrics.mode === "scroll") return;

  const chIndex = currentChapterIndex || 0;
  pageMetrics.chapterIndex = chIndex;

  const pad = getPagePadding();
  const wrapW = wrap.clientWidth;
  const wrapH = wrap.clientHeight;
  if (wrapW < 60 || wrapH < 60) return;

  
  const isSpread = pageMetrics.mode === "pages" && window.innerWidth >= 700;
  const pageW = isSpread
    ? Math.floor((wrapW - pad.x * 2 - pad.gap) / 2)
    : wrapW - pad.x * 2;
  const pageH = wrapH - pad.y * 2;

  const fontSize = settings.fontSize || 18;
  const lineHeight = settings.lineHeight || 1.65;
  const key = pageCacheKey(chIndex, pageMetrics.mode, pageW, pageH, fontSize, lineHeight);

  let pages = pageCache.get(key);
  if (!pages) {
    const units = chapterUnits(chIndex);
    pages = paginateUnits(units, pageW, pageH);
    pageCache.set(key, pages);
    
    if (pageCache.size > 40) {
      const first = pageCache.keys().next().value;
      pageCache.delete(first);
    }
  }

  pageMetrics.pages = pages;
  const perScreen = (pageMetrics.mode === "pages" && window.innerWidth >= 700) ? 2 : 1;
  pageMetrics.pageCount = Math.max(1, Math.ceil(pages.length / perScreen));

  if (!keepPage) pageMetrics.pageIndex = 0;
  
  if (keepPage && typeof currentBook.charOffset === "number") {
    pageMetrics.pageIndex = currentBook.charOffset || 0;
  }
  pageMetrics.pageIndex = Math.max(
    0,
    Math.min(pageMetrics.pageCount - 1, pageMetrics.pageIndex || 0)
  );

  renderCurrentScreen();
}

function renderCurrentScreen() {
  const content = $("#readerContent");
  if (!content || pageMetrics.mode === "scroll") return;

  const isSpread = pageMetrics.mode === "pages" && window.innerWidth >= 700;
  const perScreen = isSpread ? 2 : 1;
  const start = pageMetrics.pageIndex * perScreen;
  const pad = getPagePadding();

  if (isSpread) {
    const left = pageMetrics.pages[start] || "";
    const right = pageMetrics.pages[start + 1] || "";
    content.innerHTML = `
      <div class="spread-row" style="gap:${pad.gap}px;padding:${pad.y}px ${pad.x}px;">
        <div class="page-panel">${left}</div>
        <div class="page-panel">${right}</div>
      </div>`;
  } else {
    const html = pageMetrics.pages[start] || "";
    content.innerHTML = `
      <div class="page-panel single" style="padding:${pad.y}px ${pad.x}px;">
        ${html}
      </div>`;
  }

  bindSentenceEvents();
  updatePageIndicator();
  saveProgressDebounced();
}

function turnPage(dir) {
  if (pageMetrics.mode === "scroll") return;
  if (!canTurnPages()) return;

  const next = pageMetrics.pageIndex + dir;
  if (next >= 0 && next < pageMetrics.pageCount) {
    pageMetrics.pageIndex = next;
    renderCurrentScreen();
    return;
  }

  
  if (dir > 0 && currentChapterIndex < (currentBook?.chapters?.length || 1) - 1) {
    currentChapterIndex += 1;
    pageMetrics.pageIndex = 0;
    buildChapterPages(false);
    return;
  }
  if (dir < 0 && currentChapterIndex > 0) {
    currentChapterIndex -= 1;
    pageMetrics.pageIndex = 0;
    buildChapterPages(false);
    
    pageMetrics.pageIndex = Math.max(0, pageMetrics.pageCount - 1);
    renderCurrentScreen();
  }
}

function goToPage(index) {
  if (pageMetrics.mode === "scroll") return;
  pageMetrics.pageIndex = Math.max(0, Math.min(pageMetrics.pageCount - 1, index));
  renderCurrentScreen();
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
  if (!el) return;
  if (pageMetrics.mode === "scroll") {
    el.textContent = "";
    return;
  }
  const mode = settings.pageIndicatorMode || "total";
  if (mode === "chapter") {
    const ch = (currentChapterIndex || 0) + 1;
    const chTotal = currentBook?.chapters?.length || 1;
    el.textContent = `гл. ${ch}/${chTotal} · ${pageMetrics.pageIndex + 1}/${pageMetrics.pageCount}`;
  } else {
    const total = estimateBookPages(currentBook);
    const cur = Math.min(total, estimateGlobalPage());
    el.textContent = `${cur} / ${total}`;
  }
}

let pageWheelLock = 0;
let pageTouch = null;

function bindPagedNavigation() {
  const wrap = document.querySelector(".reader-view-wrap");
  if (!wrap || wrap.dataset.pagedBound === "1") return;
  wrap.dataset.pagedBound = "1";

  wrap.addEventListener(
    "wheel",
    (e) => {
      if (pageMetrics.mode === "scroll") return;
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
      if (pageMetrics.mode === "scroll") return;
      const t = e.changedTouches[0];
      pageTouch = { x: t.clientX, y: t.clientY };
    },
    { passive: true }
  );

  wrap.addEventListener(
    "touchmove",
    (e) => {
      if (pageMetrics.mode === "scroll") return;
      e.preventDefault();
    },
    { passive: false }
  );

  wrap.addEventListener(
    "touchend",
    (e) => {
      if (pageMetrics.mode === "scroll") return;
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

$("#fileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  showToast("Загрузка «" + file.name + "»…", "ok", 2500);

  const form = new FormData();
  form.append("book", file);

  try {
    const res = await fetch("/api/books", { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Ошибка");

    showToast(`Добавлено: «${data.title}» (${data.chaptersCount} гл.)`, "ok", 3500);
    await loadBooks();
  } catch (err) {
    showToast(err.message || "Ошибка загрузки", "error");
  }

  e.target.value = "";
});

async function openBook(id) {
  try {
    stopTts(false);
    currentBook = await api("/api/books/" + id);
    currentChapterIndex = currentBook.chapterIndex || 0;

    $("#libraryView").classList.add("hidden");
    $("#bookDetailView").classList.add("hidden");
    $("#readerView").classList.remove("hidden");

    $("#readerTitle").textContent = currentBook.title;
    $("#readerAuthor").textContent = currentBook.author;

    bindReaderHeaderAutoHide();
    setHeaderHidden(false);
    currentChapterIndex = currentBook.chapterIndex || 0;
    pageMetrics.pageIndex = currentBook.charOffset || 0;
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
  if (pageMetrics.mode === "scroll") {
    renderScrollContent();
  } else {
    buildChapterPages(false);
  }
}

function scrollToChapter(index, smooth = true) {
  currentChapterIndex = index;
  if (pageMetrics.mode === "scroll") {
    const el = document.querySelector(`.chapter[data-index="${index}"]`);
    if (el) el.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
    saveProgressDebounced();
    return;
  }
  pageMetrics.pageIndex = 0;
  buildChapterPages(false);
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
  const ch = currentBook?.chapters?.[chapterIndex];
  if (!ch) return [];
  return splitChapterIntoSentences(ch.text || "").map((t, si) => ({
    ch: chapterIndex,
    si,
    text: t,
  }));
}

function collectFromPick(ch, si, clickedText) {
  const all = collectSentencesFromChapter(ch);
  if (!all.length) return [];

  const want = (clickedText || "").replace(/\s+/g, " ").trim();
  let start = -1;

  if (want) {
    
    if (all[si] && all[si].text.replace(/\s+/g, " ").trim() === want) {
      start = si;
    } else {
      
      const from = Math.max(0, si - 2);
      const to = Math.min(all.length, si + 5);
      for (let i = from; i < to; i++) {
        if (all[i].text.replace(/\s+/g, " ").trim() === want) {
          start = i;
          break;
        }
      }
      
      if (start < 0) {
        start = all.findIndex(
          (s) => s.text.replace(/\s+/g, " ").trim() === want
        );
      }
      
      if (start < 0) {
        start = all.findIndex((s) => {
          const t = s.text.replace(/\s+/g, " ").trim();
          return t.startsWith(want) || want.startsWith(t);
        });
      }
    }
  }

  if (start < 0) start = Math.max(0, Math.min(all.length - 1, Number(si) || 0));
  return all.slice(start);
}

function bindSentenceEvents() {
  const content = $("#readerContent");

  const canPick = () => ttsPanelOpen || !ttsStopped;

  content.onmouseover = (e) => {
    if (!canPick()) return;
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
    if (!canPick()) return;
    const s = e.target.closest(".sentence");
    if (!s) return;
    e.stopPropagation();

    const ch = Number(s.dataset.ch);
    const si = Number(s.dataset.si);
    if (!Number.isFinite(ch) || !Number.isFinite(si)) return;
    const clickedText = (s.textContent || "").replace(/\s+/g, " ").trim();
    ttsPicked = { ch, si, text: clickedText };

    content.querySelectorAll(".sentence.picked").forEach((el) => el.classList.remove("picked"));
    s.classList.add("picked");

    startTtsFromPick();
  };

  
  content.oncontextmenu = null;
}

let progressTimer = null;

function saveProgressDebounced() {
  clearTimeout(progressTimer);
  progressTimer = setTimeout(saveProgress, 1500);
}

async function saveProgress() {
  if (!currentBook) return;
  const total = currentBook.chapters.length || 1;
  let progress;
  if (pageMetrics.mode !== "scroll" && pageMetrics.pageCount > 0) {
    const chapterFrac =
      (pageMetrics.pageIndex + 1) / Math.max(1, pageMetrics.pageCount);
    progress = Math.round(
      ((currentChapterIndex + chapterFrac) / total) * 100
    );
  } else {
    progress = Math.round(((currentChapterIndex + 0.5) / total) * 100);
  }
  progress = Math.min(100, Math.max(0, progress));
  const pageIdx =
    pageMetrics.mode !== "scroll" ? pageMetrics.pageIndex || 0 : 0;
  try {
    await api("/api/books/" + currentBook.id + "/progress", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chapterIndex: currentChapterIndex,
        charOffset: pageIdx, 
        progress,
      }),
    });
    currentBook.chapterIndex = currentChapterIndex;
    currentBook.charOffset = pageIdx;
    currentBook.progress = progress;
  } catch (_) {}
}

let scrollTimer = null;
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

function openSettings(tab) {
  applySettings();
  syncSettingsTtsFields();
  updateThemeSwatches();
  if (tab) selectSettingsTab(tab);
  $("#settingsOverlay").classList.remove("hidden");
}

function closeSettings() {
  $("#settingsOverlay").classList.add("hidden");
}

function selectSettingsTab(name) {
  $$(".settings-tab").forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", on ? "true" : "false");
  });
  $$(".settings-pane").forEach((p) => {
    const on = p.dataset.pane === name;
    p.classList.toggle("active", on);
    if (on) p.removeAttribute("hidden");
    else p.setAttribute("hidden", "");
  });
}

function syncSettingsTtsFields() {
  const sp = settings.speaker || $("#ttsSpeaker")?.value || "xenia";
  const spd = settings.speed != null ? settings.speed : Number($("#ttsSpeed")?.value || 1);
  if ($("#settingsSpeaker")) $("#settingsSpeaker").value = sp;
  if ($("#settingsSpeed")) {
    $("#settingsSpeed").value = spd;
    if ($("#settingsSpeedVal")) $("#settingsSpeedVal").textContent = Number(spd).toFixed(1) + "×";
  }
}

const THEME_COLORS = {
  dark: { bg: "#0b0b0c", fg: "#f5f5f7" },
  light: { bg: "#f2f2f7", fg: "#1c1c1e" },
  sepia: { bg: "#f4ecd8", fg: "#3e3226" },
  black: { bg: "#000000", fg: "#e8e8e8" },
};

function setTheme(theme, fromEl) {
  const next = THEME_COLORS[theme] ? theme : "sepia";
  if ((settings.theme || "sepia") === next) {
    updateThemeSwatches();
    return;
  }
  settings.theme = next;
  saveSettings();
  applySettings();
  updateThemeSwatches();
}

function updateThemeSwatches() {
  const theme = settings.theme || "sepia";
  $$(".theme-swatch").forEach((s) => s.classList.toggle("active", s.dataset.theme === theme));
}

$("#btnSettings")?.addEventListener("click", () => openSettings());
$("#btnSettingsLib")?.addEventListener("click", () => openSettings());
$("#btnSettingsDetail")?.addEventListener("click", () => openSettings());

$("#btnCloseSettings")?.addEventListener("click", closeSettings);
$("#settingsOverlay")?.addEventListener("click", (e) => {
  if (e.target === $("#settingsOverlay")) closeSettings();
});

$$(".settings-tab").forEach((tab) => {
  tab.addEventListener("click", () => selectSettingsTab(tab.dataset.tab));
});

$$(".theme-swatch").forEach((sw) => {
  sw.addEventListener("click", () => {
    setTheme(sw.dataset.theme, sw);
  });
});

$("#settingsSpeaker")?.addEventListener("change", (e) => {
  settings.speaker = e.target.value;
  saveSettings();
  if ($("#ttsSpeaker")) $("#ttsSpeaker").value = settings.speaker;
  if (!ttsStopped) restartTtsWithNewSettings();
});

$("#settingsSpeed")?.addEventListener("input", (e) => {
  const v = Number(e.target.value);
  settings.speed = v;
  if ($("#settingsSpeedVal")) $("#settingsSpeedVal").textContent = v.toFixed(1) + "×";
  if ($("#ttsSpeed")) {
    $("#ttsSpeed").value = v;
    $("#ttsSpeedVal").textContent = v.toFixed(1) + "×";
  }
  saveSettings();
});

$("#settingsSpeed")?.addEventListener("change", () => {
  if (!ttsStopped) restartTtsWithNewSettings();
});

$("#fontSize").addEventListener("input", (e) => {
  settings.fontSize = Number(e.target.value);
  $("#fontSizeVal").textContent = settings.fontSize;
  applySettings();
  saveSettings();
});

$("#lineHeight").addEventListener("input", (e) => {
  settings.lineHeight = Number(e.target.value);
  $("#lineHeightVal").textContent = settings.lineHeight;
  applySettings();
  saveSettings();
});

$("#themeSelect").addEventListener("change", (e) => {
  setTheme(e.target.value, e.target);
});

$("#contentWidth").addEventListener("change", (e) => {
  settings.contentWidth = e.target.value;
  applySettings();
  saveSettings();
});

$("#layoutMode")?.addEventListener("change", (e) => {
  settings.layoutMode = e.target.value;
  saveSettings();
  pageCache.clear();
  applyLayoutMode();
});

$("#pageIndicatorMode")?.addEventListener("change", (e) => {
  settings.pageIndicatorMode = e.target.value;
  saveSettings();
  updatePageIndicator();
});

$("#pageNavPrev")?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (canTurnPages()) turnPage(-1);
});
$("#pageNavNext")?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (canTurnPages()) turnPage(1);
});

$("#readerContent")?.addEventListener("scroll", () => {
  if (pageMetrics.mode !== "scroll") updatePageIndicator();
}, { passive: true });

window.addEventListener("resize", () => {
  if (!$("#readerView")?.classList.contains("hidden")) {
    applyLayoutMode();
  }
});

$("#btnBack").addEventListener("click", async () => {
  stopTts();
  closeTtsPanel();
  await saveProgress();
  const returnId = currentBook?.id || detailBookId;
  currentBook = null;
  $("#readerView").classList.add("hidden");
  await loadBooks();
  if (returnId && books.find((b) => b.id === returnId)) {
    openBookDetail(returnId);
  } else {
    $("#libraryView").classList.remove("hidden");
  }
});

const ttsAudio = $("#ttsAudio");
const ttsStatus = $("#ttsStatus"); 

function openTtsPanel() {
  ttsPanelOpen = true;
  $("#ttsPanel").classList.remove("hidden");
  $("#btnTtsPanel").classList.add("active");
  document.body.classList.add("tts-pick-mode");
  if (typeof updateSleepLabel === "function") updateSleepLabel();
}

function closeTtsPanel() {
  ttsPanelOpen = false;
  $("#ttsPanel").classList.add("hidden");
  $("#btnTtsPanel").classList.remove("active");
  document.body.classList.remove("tts-pick-mode");
  $$(".sentence.hover").forEach((el) => el.classList.remove("hover"));
}

$("#btnTtsPanel").addEventListener("click", (e) => {
  e.stopPropagation();
  if (ttsPanelOpen) closeTtsPanel();
  else openTtsPanel();
});

$("#btnTtsPanelClose")?.addEventListener("click", (e) => {
  e.stopPropagation();
  closeTtsPanel();
});

$("#ttsSpeed").addEventListener("input", (e) => {
  const v = Number(e.target.value);
  $("#ttsSpeedVal").textContent = v.toFixed(1) + "×";
  settings.speed = v;
  saveSettings();
  if (!ttsStopped) restartTtsWithNewSettings();
});

$("#ttsSpeaker").addEventListener("change", (e) => {
  settings.speaker = e.target.value;
  saveSettings();
  if (!ttsStopped) restartTtsWithNewSettings();
});

$("#btnTtsPlay").addEventListener("click", () => {
  
  const hasAudio = ttsAudio && ttsAudio.src && !ttsStopped && isSpeaking;
  if (hasAudio) {
    if (ttsAudio.paused) {
      ttsAudio.play().catch(() => {});
      setPlayIcon(true);
      setScrollLock(true);
      updateMediaSession("playing");
    } else {
      ttsAudio.pause();
      setPlayIcon(false);
      setScrollLock(false);
      updateMediaSession("paused");
    }
    return;
  }

  
  if (!ttsStopped && !hasAudio) {
    ttsStopped = true;
    isSpeaking = false;
  }

  if (ttsPicked) startTtsFromPick();
  else startTtsFromCurrentChapter();
});

let lastPrevClick = 0;
$("#btnTtsPrev").addEventListener("click", () => {
  if (ttsStopped || !ttsSentences.length) return;
  const nearStart = ttsPos <= 0;
  if (nearStart) {
    const ch =
      ttsSentences[0] && ttsSentences[0].ch != null
        ? ttsSentences[0].ch
        : currentChapterIndex;
    if (ch > 0) {
      const gen = ttsGeneration;
      advanceToChapter(ch - 1, true);
      return;
    }
    jumpToQueueIndex(0);
    return;
  }
  const target = Math.max(0, ttsPos - 1);
  jumpToQueueIndex(target);
});

$("#btnTtsNext").addEventListener("click", () => {
  if (ttsStopped) {
    if (ttsPicked) startTtsFromPick();
    else startTtsFromCurrentChapter();
    return;
  }
  if (!ttsSentences.length) return;
  if (ttsPos >= ttsSentences.length - 1) {
    const ch =
      ttsSentences[ttsSentences.length - 1] &&
      ttsSentences[ttsSentences.length - 1].ch != null
        ? ttsSentences[ttsSentences.length - 1].ch
        : currentChapterIndex;
    advanceToChapter(ch + 1, false);
    return;
  }
  jumpToQueueIndex(ttsPos + 1);
});

function restartCurrentSentence() {
  if (!ttsSentences.length || ttsStopped) return;
  const rest = ttsSentences.slice(ttsPos);
  beginQueue(rest);
}

function jumpToQueueIndex(index) {
  if (!ttsSentences.length) return;
  index = Math.max(0, Math.min(ttsSentences.length - 1, index));
  const rest = ttsSentences.slice(index);
  beginQueue(rest);
}

function findPageIndexForSentence(ch, si) {
  if (!pageMetrics.pages || !pageMetrics.pages.length) return -1;
  const chMark = `data-ch="${ch}"`;
  const siMark = `data-si="${si}"`;
  for (let i = 0; i < pageMetrics.pages.length; i++) {
    const html = pageMetrics.pages[i];
    if (html.includes(chMark) && html.includes(siMark)) return i;
  }
  return -1;
}

function ensureSentencePageVisible(ch, si) {
  if (pageMetrics.mode === "scroll") return;
  if (document.querySelector(`.sentence[data-ch="${ch}"][data-si="${si}"]`)) return;
  if (pageMetrics.chapterIndex !== ch && currentChapterIndex !== ch) {
    currentChapterIndex = ch;
    pageMetrics.pageIndex = 0;
    buildChapterPages(true);
  }
  const pageIdx = findPageIndexForSentence(ch, si);
  if (pageIdx < 0) return;
  const perScreen =
    pageMetrics.mode === "pages" && window.innerWidth >= 700 ? 2 : 1;
  const screen = Math.floor(pageIdx / perScreen);
  if (screen !== pageMetrics.pageIndex) {
    goToPage(screen);
  }
}

function highlightSentence(ch, si) {
  $$(".sentence.active").forEach((el) => el.classList.remove("active"));
  if (pageMetrics.mode !== "scroll") {
    ensureSentencePageVisible(ch, si);
  }
  const el = document.querySelector(`.sentence[data-ch="${ch}"][data-si="${si}"]`);
  if (el) {
    el.classList.add("active");
    el.classList.remove("hover", "picked");
    scrollSentenceIntoView(el, true);
  }
}

function scrollSentenceIntoView(el, force = false) {
  const container = $("#readerContent");
  if (!container || !el) return;
  
  if (pageMetrics.mode !== "scroll") return;

  const cRect = container.getBoundingClientRect();
  const eRect = el.getBoundingClientRect();
  const offset = 72;
  const outOfView =
    eRect.top < cRect.top + offset || eRect.bottom > cRect.bottom - 40;
  if (force || outOfView) {
    const target = container.scrollTop + (eRect.top - cRect.top) - offset;
    container.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
  }
}

function clearHighlight() {
  $$(".sentence.active").forEach((el) => el.classList.remove("active"));
}

function setScrollLock(on) {
  const content = $("#readerContent");
  if (!content) return;
  content.classList.toggle("tts-scroll-lock", !!on);
}

function getTtsSpeaker() {
  return (
    $("#ttsSpeaker")?.value ||
    $("#settingsSpeaker")?.value ||
    settings.speaker ||
    "xenia"
  );
}

function getTtsSpeed() {
  const v = Number(
    $("#ttsSpeed")?.value || $("#settingsSpeed")?.value || settings.speed || 1
  );
  return Number.isFinite(v) && v > 0 ? v : 1;
}

function sanitizeTtsText(text) {
  let t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (t.length > 800) t = t.slice(0, 800);
  if (!/[0-9A-Za-zА-Яа-яЁё]/.test(t)) return "";
  return t;
}

async function fetchSentenceAudio(text, gen, { prefetch = false } = {}) {
  const speaker = getTtsSpeaker();
  const speed = getTtsSpeed();
  let t = sanitizeTtsText(text);
  if (!t) throw new Error("Пустое предложение");

  
  if (!prefetch) {
    if (ttsAbort) {
      try { ttsAbort.abort(); } catch (_) {}
    }
    ttsAbort = new AbortController();
  } else {
    if (ttsPrefetchAbort) {
      try { ttsPrefetchAbort.abort(); } catch (_) {}
    }
    ttsPrefetchAbort = new AbortController();
  }
  const signal = (prefetch ? ttsPrefetchAbort : ttsAbort).signal;

  let res;
  try {
    res = await fetch("/api/tts/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: t, speaker, speed }),
      signal,
    });
  } catch (err) {
    if (err.name === "AbortError" || gen !== ttsGeneration) throw new Error("cancelled");
    throw new Error("Сеть / TTS недоступен");
  }

  if (gen !== ttsGeneration) throw new Error("cancelled");

  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    let msg = "Ошибка TTS (" + res.status + ")";
    try {
      const err = JSON.parse(raw);
      if (typeof err.detail === "string") msg = err.detail;
      else if (Array.isArray(err.detail))
        msg = err.detail.map((d) => d.msg || JSON.stringify(d)).join("; ");
      else if (err.error) msg = err.error + (err.detail ? ": " + err.detail : "");
      else if (err.message) msg = err.message;
    } catch (_) {
      if (raw && raw.length < 200) msg = raw;
    }
    throw new Error(msg);
  }

  const blob = await res.blob();
  if (gen !== ttsGeneration) throw new Error("cancelled");
  return URL.createObjectURL(blob);
}

function clearPrefetch() {
  if (ttsPrefetch) {
    URL.revokeObjectURL(ttsPrefetch.url);
    ttsPrefetch = null;
  }
  ttsPrefetchPromise = null;
}

function prefetchNext(gen) {
  const next = ttsPos + 1;
  if (next >= ttsSentences.length) return;
  if (ttsPrefetch && ttsPrefetch.index === next) return;
  if (ttsPrefetchPromise) return;

  const item = ttsSentences[next];
  ttsPrefetchPromise = fetchSentenceAudio(item.text, gen, { prefetch: true })
    .then((url) => {
      if (ttsStopped || gen !== ttsGeneration || ttsPos + 1 !== next) {
        URL.revokeObjectURL(url);
        return;
      }
      ttsPrefetch = { index: next, url };
    })
    .catch(() => {})
    .finally(() => {
      ttsPrefetchPromise = null;
    });
}

function advanceToChapter(chIndex, fromEnd) {
  if (!currentBook || chIndex < 0 || chIndex >= currentBook.chapters.length) return false;
  if (sleepStopAtChapterEnd && !fromEnd) {
    clearSleepTimer(true);
    finishTts();
    if (typeof showToast === "function") showToast("Таймер сна: конец главы", "ok");
    return false;
  }
  let list = collectSentencesFromChapter(chIndex);
  list = (list || []).filter((s) => sanitizeTtsText(s.text));
  if (!list.length) {
    const next = chIndex + (fromEnd ? -1 : 1);
    if (next !== chIndex && next >= 0 && next < currentBook.chapters.length) {
      return advanceToChapter(next, fromEnd);
    }
    return false;
  }
  currentChapterIndex = chIndex;
  ttsPicked = null;
  try {
    if (pageMetrics.mode === "scroll") {
      scrollToChapter(chIndex, true);
    } else {
      pageMetrics.pageIndex = 0;
      buildChapterPages(false);
    }
  } catch (_) {}
  saveProgressDebounced();
  if (fromEnd) {
    beginQueue(list.slice(Math.max(0, list.length - 1)));
  } else {
    beginQueue(list);
  }
  return true;
}

async function playAt(pos, gen) {
  if (gen !== ttsGeneration) return;
  if (ttsStopped) {
    finishTts();
    return;
  }
  if (pos >= ttsSentences.length) {
    const lastCh =
      ttsSentences.length && ttsSentences[ttsSentences.length - 1]
        ? ttsSentences[ttsSentences.length - 1].ch
        : currentChapterIndex;
    if (ttsAudio) {
      ttsAudio.onended = null;
      ttsAudio.onerror = null;
    }
    clearPrefetch();
    const nextCh = (Number.isFinite(lastCh) ? lastCh : currentChapterIndex) + 1;
    setTimeout(() => {
      if (ttsStopped) return;
      if (gen !== ttsGeneration) return;
      if (!advanceToChapter(nextCh, false)) finishTts();
    }, 40);
    return;
  }

  ttsPos = pos;
  const item = ttsSentences[pos];
  if (!item || !sanitizeTtsText(item.text)) {
    return playAt(pos + 1, gen);
  }

  highlightSentence(item.ch, item.si);
  currentChapterIndex = item.ch;
  saveProgressDebounced();

  if (ttsStatus) ttsStatus.textContent = `${pos + 1} / ${ttsSentences.length}`;

  let url;
  try {
    if (ttsPrefetch && ttsPrefetch.index === pos) {
      url = ttsPrefetch.url;
      ttsPrefetch = null;
    } else {
      $("#btnTtsPlay").disabled = true;
      if (ttsStatus) ttsStatus.textContent = `Генерация ${pos + 1}/${ttsSentences.length}...`;
      url = await fetchSentenceAudio(item.text, gen);
      if (gen !== ttsGeneration) {
        URL.revokeObjectURL(url);
        return;
      }
      $("#btnTtsPlay").disabled = false;
    }
  } catch (err) {
    if (err.message === "cancelled") return;
    $("#btnTtsPlay").disabled = false;
    const msg = err.message || "Ошибка TTS";
    if (ttsStatus) ttsStatus.textContent = msg;
    return playAt(pos + 1, gen);
  }

  
  highlightSentence(item.ch, item.si);
  prefetchNext(gen);

  ttsAudio.onended = null;
  ttsAudio.onerror = null;
  ttsAudio.src = url;

  ttsAudio.onended = () => {
    URL.revokeObjectURL(url);
    if (!ttsStopped && gen === ttsGeneration) playAt(pos + 1, gen);
  };
  ttsAudio.onerror = () => {
    URL.revokeObjectURL(url);
    if (!ttsStopped && gen === ttsGeneration) playAt(pos + 1, gen);
  };

  try {
    ttsAudio.volume = Math.min(
      1,
      Math.max(0, Number(settings.volume != null ? settings.volume : 1))
    );
    await ttsAudio.play();
    if (gen !== ttsGeneration) return;
    isSpeaking = true;
    setScrollLock(true);
    setPlayIcon(true);
    setupMediaSessionHandlers();
    updateMediaSession("playing");
        if (ttsStatus) ttsStatus.textContent = `${pos + 1} / ${ttsSentences.length}`;
  } catch (err) {
    if (ttsStatus) ttsStatus.textContent = "Воспроизведение: " + err.message;
    if (!ttsStopped && gen === ttsGeneration) playAt(pos + 1, gen);
    else finishTts();
  }
}

function beginQueue(sentences) {
  sentences = (sentences || []).filter((s) => sanitizeTtsText(s && s.text));
  if (!sentences.length) {
    if (ttsStatus) ttsStatus.textContent = "Нет текста";
    if (typeof showToast === "function") showToast("Нет текста для озвучки", "error");
    return;
  }
  if (!ttsAudio) {
    if (typeof showToast === "function") showToast("Аудиоэлемент не найден", "error");
    return;
  }
  ttsGeneration++;
  const gen = ttsGeneration;
  clearPrefetch();
  if (ttsAbort) {
    try { ttsAbort.abort(); } catch (_) {}
    ttsAbort = null;
  }
  if (ttsPrefetchAbort) {
    try { ttsPrefetchAbort.abort(); } catch (_) {}
    ttsPrefetchAbort = null;
  }
  try {
    ttsAudio.onended = null;
    ttsAudio.onerror = null;
    ttsAudio.pause();
    ttsAudio.removeAttribute("src");
  } catch (_) {}

  ttsSentences = sentences;
  ttsStopped = false;
  ttsPos = 0;
  isSpeaking = false;
  document.body.classList.add("tts-pick-mode");
  setPlayIcon(true);
  if (ttsStatus) ttsStatus.textContent = "Генерация…";
  setTimeout(() => {
    if (gen !== ttsGeneration || ttsStopped) return;
    playAt(0, gen);
  }, 20);
}

function collectFromVisiblePage() {
  const nodes = [...document.querySelectorAll("#readerContent .sentence")];
  if (!nodes.length) return null;
  const first = nodes[0];
  const ch = Number(first.dataset.ch);
  const si = Number(first.dataset.si);
  const text = (first.textContent || "").replace(/\s+/g, " ").trim();
  if (!Number.isFinite(ch) || !Number.isFinite(si)) return null;
  return collectFromPick(ch, si, text);
}

function startTtsFromCurrentChapter() {
  if (!currentBook) {
    if (typeof showToast === "function") showToast("Сначала откройте книгу", "error");
    return;
  }
  const visible = collectFromVisiblePage();
  if (visible && visible.length) {
    beginQueue(visible);
    return;
  }
  const list = collectSentencesFromChapter(currentChapterIndex);
  if (!list.length) {
    if (typeof showToast === "function") showToast("В этой главе нет текста", "error");
    return;
  }
  beginQueue(list);
}

function startTtsFromPick() {
  if (!currentBook || !ttsPicked) {
    startTtsFromCurrentChapter();
    return;
  }
  const list = collectFromPick(
    ttsPicked.ch,
    ttsPicked.si,
    ttsPicked.text || ""
  );
  if (!list.length) {
    startTtsFromCurrentChapter();
    return;
  }
  
  if (ttsPicked.text) {
    const first = (list[0].text || "").replace(/\s+/g, " ").trim();
    const want = ttsPicked.text.replace(/\s+/g, " ").trim();
    if (first !== want && !first.startsWith(want) && !want.startsWith(first)) {
      console.warn("[tts] pick mismatch", { want, first, si: ttsPicked.si });
    }
  }
  beginQueue(list);
}

function restartTtsWithNewSettings() {
  if (!ttsSentences.length || ttsStopped) return;
  
  const rest = ttsSentences.slice(ttsPos);
  beginQueue(rest);
}


const SLEEP_STEPS = [0, 5, 15, 30, 45, 60, 90, -1];
let sleepSelectedStep = 0;
let sleepActive = false;
let sleepDurationMs = 0;

function sleepStepLabel(step) {
  const v = SLEEP_STEPS[step] ?? 0;
  if (v === 0) return "Выкл";
  if (v < 0) return "До конца главы";
  return v + " мин";
}

function formatSleepLeft() {
  if (!sleepActive) return sleepStepLabel(sleepSelectedStep);
  if (sleepStopAtChapterEnd) return "до конца главы";
  if (!sleepTimerEndsAt) return sleepStepLabel(sleepSelectedStep);
  const sec = Math.max(0, Math.round((sleepTimerEndsAt - Date.now()) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m + ":" + String(s).padStart(2, "0");
}

function updateSleepLabel() {
  const el = $("#ttsSleepVal");
  if (el) el.textContent = formatSleepLeft();
  const range = $("#ttsSleepRange");
  const startBtn = $("#btnTtsSleepStart");
  const cancelBtn = $("#btnTtsSleepCancel");
  if (sleepActive && sleepDurationMs > 0 && !sleepStopAtChapterEnd && range) {
    const left = Math.max(0, sleepTimerEndsAt - Date.now());
    const ratio = left / sleepDurationMs;
    range.value = String(Math.round(ratio * sleepSelectedStep));
  }
  if (startBtn) {
    startBtn.disabled = sleepActive || sleepSelectedStep <= 0;
    startBtn.textContent = sleepActive ? "Идёт…" : "Старт";
  }
  if (cancelBtn) {
    cancelBtn.classList.toggle("hidden", !sleepActive);
  }
  const badge = $("#sleepHeaderBadge");
  const badgeText = $("#sleepHeaderText");
  if (badge) {
    badge.classList.toggle("hidden", !sleepActive);
    if (sleepActive && badgeText) {
      if (sleepStopAtChapterEnd) badgeText.textContent = "глава";
      else badgeText.textContent = formatSleepLeft();
    }
  }
}

function clearSleepTimer(resetSelect) {
  if (sleepTimerId) {
    clearTimeout(sleepTimerId);
    sleepTimerId = null;
  }
  if (sleepCountdownId) {
    clearInterval(sleepCountdownId);
    sleepCountdownId = null;
  }
  sleepTimerEndsAt = 0;
  sleepDurationMs = 0;
  sleepStopAtChapterEnd = false;
  sleepActive = false;
  if (resetSelect) {
    sleepSelectedStep = 0;
    if ($("#ttsSleepRange")) $("#ttsSleepRange").value = "0";
  } else if ($("#ttsSleepRange") && !sleepActive) {
    $("#ttsSleepRange").value = String(sleepSelectedStep);
  }
  updateSleepLabel();
}

function startSleepTimerFromUi() {
  const step = sleepSelectedStep;
  const mins = SLEEP_STEPS[step] ?? 0;
  clearSleepTimer(false);
  if (step <= 0 || mins === 0) {
    updateSleepLabel();
    return;
  }
  sleepActive = true;
  sleepSelectedStep = step;
  if (mins < 0) {
    sleepStopAtChapterEnd = true;
    sleepDurationMs = 0;
    sleepTimerEndsAt = 0;
    updateSleepLabel();
    if (typeof showToast === "function") showToast("Таймер: до конца главы", "ok");
    return;
  }
  sleepDurationMs = mins * 60 * 1000;
  sleepTimerEndsAt = Date.now() + sleepDurationMs;
  sleepTimerId = setTimeout(() => {
    clearSleepTimer(true);
    stopTts();
    if (typeof showToast === "function") showToast("Таймер сна", "ok");
  }, sleepDurationMs);
  sleepCountdownId = setInterval(updateSleepLabel, 1000);
  updateSleepLabel();
  if (typeof showToast === "function") showToast("Таймер: " + mins + " мин", "ok");
}

$("#ttsSleepRange")?.addEventListener("input", (e) => {
  if (sleepActive) return;
  sleepSelectedStep = Number(e.target.value) || 0;
  updateSleepLabel();
  const startBtn = $("#btnTtsSleepStart");
  if (startBtn) startBtn.disabled = sleepSelectedStep <= 0;
});

$("#btnTtsSleepStart")?.addEventListener("click", () => {
  if (sleepActive || sleepSelectedStep <= 0) return;
  startSleepTimerFromUi();
});

$("#btnTtsSleepCancel")?.addEventListener("click", () => {
  clearSleepTimer(true);
  if (typeof showToast === "function") showToast("Таймер сброшен", "ok");
});

$("#sleepHeaderBadge")?.addEventListener("click", (e) => {
  e.stopPropagation();
  if (!ttsPanelOpen) openTtsPanel();
});

$("#ttsVolume")?.addEventListener("input", (e) => {
  const v = Number(e.target.value);
  settings.volume = v;
  if ($("#ttsVolumeVal")) $("#ttsVolumeVal").textContent = Math.round(v * 100) + "%";
  if (ttsAudio) ttsAudio.volume = Math.min(1, Math.max(0, v));
  saveSettings();
});

function finishTts() {
  isSpeaking = false;
  ttsStopped = true;
  setScrollLock(false);
  setPlayIcon(false);
  updateMediaSession("none");
  $("#btnTtsPlay").disabled = false;
    if (ttsStatus) ttsStatus.textContent = ttsPos >= ttsSentences.length - 1 ? "Готово" : "";
  clearHighlight();
  if (!ttsPanelOpen) document.body.classList.remove("tts-pick-mode");
}

function stopTts(updateUi = true) {
  ttsGeneration++; 
  ttsStopped = true;
  isSpeaking = false;
  setScrollLock(false);
  ttsAudio.pause();
  ttsAudio.onended = null;
  ttsAudio.onerror = null;
  ttsAudio.removeAttribute("src");
  ttsAudio.load();
  clearPrefetch();

  if (updateUi) {
    setPlayIcon(false);
    $("#btnTtsPlay").disabled = false;
        if (ttsStatus) ttsStatus.textContent = "";
    clearHighlight();
    if (!ttsPanelOpen) document.body.classList.remove("tts-pick-mode");
  }
}

$("#btnDetailBack")?.addEventListener("click", () => {
  closeBookDetail();
});
$("#btnDetailRead")?.addEventListener("click", async () => {
  if (!detailBookId) return;
  try {
    const label = ($("#btnDetailRead").textContent || "");
    if (label.includes("начала") || label.includes("снова")) {
      await api("/api/books/" + detailBookId + "/progress", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chapterIndex: 0, charOffset: 0, progress: 0 }),
      });
    }
    await openBook(detailBookId);
  } catch (err) {
    showToast(err.message || "Не удалось открыть", "error");
  }
});
$("#btnDetailContinue")?.addEventListener("click", async () => {
  if (!detailBookId) return;
  try {
    await openBook(detailBookId);
  } catch (err) {
    showToast(err.message || "Не удалось открыть", "error");
  }
});
$("#btnDetailDelete")?.addEventListener("click", async () => {
  if (!detailBookId) return;
  if (!confirm("Удалить книгу?")) return;
  try {
    await api("/api/books/" + detailBookId, { method: "DELETE" });
    showToast("Книга удалена", "ok", 2500);
    closeBookDetail();
    await loadBooks();
  } catch (err) {
    showToast(err.message || "Ошибка удаления", "error");
  }
});

document.addEventListener("keydown", (e) => {
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target.isContentEditable) return;

  const inReader = !$("#readerView")?.classList.contains("hidden");

  if (e.code === "Space") {
    if (!inReader) return;
    e.preventDefault();
    $("#btnTtsPlay")?.click();
    return;
  }
  
  
  if (e.code === "ArrowLeft" || e.code === "ArrowUp") {
    if (!inReader) return;
    e.preventDefault();
    if (isTtsActivelyPlaying()) {
      $("#btnTtsPrev")?.click();
    } else if (pageMetrics.mode !== "scroll") {
      turnPage(-1);
    } else {
      const c = $("#readerContent");
      if (c) c.scrollBy({ top: -Math.max(120, c.clientHeight * 0.85), behavior: "smooth" });
    }
    return;
  }
  if (e.code === "ArrowRight" || e.code === "ArrowDown") {
    if (!inReader) return;
    e.preventDefault();
    if (isTtsActivelyPlaying()) {
      $("#btnTtsNext")?.click();
    } else if (pageMetrics.mode !== "scroll") {
      turnPage(1);
    } else {
      const c = $("#readerContent");
      if (c) c.scrollBy({ top: Math.max(120, c.clientHeight * 0.85), behavior: "smooth" });
    }
    return;
  }
  if (e.code === "Escape") {
    if (isSpeaking || !ttsStopped) {
      e.preventDefault();
      stopTts();
      return;
    }
    if (ttsPanelOpen) {
      e.preventDefault();
      closeTtsPanel();
      return;
    }
  }
});

$$("#libStatusFilter .chip").forEach((chip) => {
  chip.classList.toggle("active", chip.dataset.status === libStatus);
  chip.addEventListener("click", () => {
    libStatus = chip.dataset.status || "all";
    localStorage.setItem("al_lib_status", libStatus);
    $$("#libStatusFilter .chip").forEach((c) =>
      c.classList.toggle("active", c.dataset.status === libStatus)
    );
    renderLibrary();
  });
});

$("#detailStatus")?.addEventListener("change", () => scheduleDetailSave());
["#detailTitle", "#detailAuthor", "#detailSeries", "#detailYear", "#detailDesc"].forEach((sel) => {
  const el = $(sel);
  if (!el) return;
  el.addEventListener("input", scheduleDetailSave);
  el.addEventListener("change", scheduleDetailSave);
});

$("#libSearch")?.addEventListener("input", (e) => {
  libQuery = e.target.value || "";
  renderLibrary();
});
$("#libSort")?.addEventListener("change", (e) => {
  libSort = e.target.value;
  localStorage.setItem("al_lib_sort", libSort);
  renderLibrary();
});
if ($("#libSort")) $("#libSort").value = libSort;

applySettings();
loadBooks().catch((err) => {
  console.error(err);
  const p = $("#emptyState")?.querySelector(".empty-title");
  if (p) p.textContent = "Ошибка загрузки библиотеки";
});
