

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let books = [];
let currentBook = null;
let currentChapterIndex = 0;
let isSpeaking = false;
let settings = loadSettings();
let currentUser = null;
let authMode = "login";
let pendingUploadFile = null;

let ttsSentences = [];
let ttsPos = 0;
let ttsCache = new Map();
let ttsPrefetching = new Set();
let ttsStopped = true;
let ttsPicked = null;
let ttsPanelOpen = false;
let ttsGeneration = 0;
let ttsAbort = null;
const TTS_PREFETCH_AHEAD = 3;
let sleepTimerId = null;
let sleepTimerEndsAt = 0;
let sleepStopAtChapterEnd = false;
let sleepCountdownId = null;
let pageCache = new Map(); 

function setPlayIcon(playing) {
  const href = playing ? "#i-pause" : "#i-play";
  const title = playing ? "Пауза" : "Слушать";
  ["#btnTtsPlay", "#btnBarTtsPlay"].forEach((sel) => {
    const btn = $(sel);
    if (!btn) return;
    btn.innerHTML = `<svg class="icon icon-play"><use href="${href}"/></svg>`;
    btn.title = title;
    btn.setAttribute("aria-label", title);
  });
}

function updateReaderBarTts() {
  const bar = $("#readerBarTts");
  if (!bar) return;
  const active = !ttsStopped;
  bar.classList.toggle("hidden", !active);
  if (active) startWaveform();
  else stopWaveform();
}

let waveCtx = null;
let waveAnalyser = null;
let waveSource = null;
let waveData = null;
let waveRaf = 0;
let waveAudioCtx = null;

function ensureWaveAnalyser() {
  const audio = $("#ttsAudio");
  if (!audio) return null;
  try {
    if (!waveAudioCtx) {
      waveAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (!waveSource) {
      waveSource = waveAudioCtx.createMediaElementSource(audio);
      waveAnalyser = waveAudioCtx.createAnalyser();
      waveAnalyser.fftSize = 128;
      waveAnalyser.smoothingTimeConstant = 0.75;
      waveSource.connect(waveAnalyser);
      waveAnalyser.connect(waveAudioCtx.destination);
      waveData = new Uint8Array(waveAnalyser.frequencyBinCount);
    }
    if (waveAudioCtx.state === "suspended") waveAudioCtx.resume().catch(() => {});
    return waveAnalyser;
  } catch (_) {
    return null;
  }
}

function startWaveform() {
  const canvas = $("#readerBarWave");
  if (!canvas) return;
  const analyser = ensureWaveAnalyser();
  if (!analyser || !waveData) {
    drawWaveIdle(canvas);
    return;
  }
  if (waveRaf) cancelAnimationFrame(waveRaf);
  const ctx = canvas.getContext("2d");
  const bars = 32;
  const draw = () => {
    waveRaf = requestAnimationFrame(draw);
    analyser.getByteFrequencyData(waveData);
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const gap = 2;
    const barW = Math.max(2, (w - gap * (bars - 1)) / bars);
    const step = Math.floor(waveData.length / bars);
    const playing = ttsAudio && !ttsAudio.paused && !ttsStopped;
    for (let i = 0; i < bars; i++) {
      let v = 0;
      const base = i * step;
      for (let j = 0; j < step; j++) v += waveData[base + j] || 0;
      v = v / step / 255;
      if (!playing) v = 0.12 + Math.sin(Date.now() / 400 + i * 0.4) * 0.04;
      const bh = Math.max(2, v * (h - 4));
      const x = i * (barW + gap);
      const y = (h - bh) / 2;
      ctx.fillStyle = getComputedStyle(document.documentElement)
        .getPropertyValue("--accent")
        .trim() || "#0a84ff";
      ctx.globalAlpha = 0.35 + v * 0.65;
      ctx.fillRect(x, y, barW, bh);
    }
    ctx.globalAlpha = 1;
  };
  draw();
}

function drawWaveIdle(canvas) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const bars = 32;
  const gap = 2;
  const barW = Math.max(2, (w - gap * (bars - 1)) / bars);
  ctx.fillStyle = getComputedStyle(document.documentElement)
    .getPropertyValue("--text3")
    .trim() || "#888";
  ctx.globalAlpha = 0.35;
  for (let i = 0; i < bars; i++) {
    const bh = 4 + (i % 5) * 2;
    const x = i * (barW + gap);
    const y = (h - bh) / 2;
    ctx.fillRect(x, y, barW, bh);
  }
  ctx.globalAlpha = 1;
}

function stopWaveform() {
  if (waveRaf) {
    cancelAnimationFrame(waveRaf);
    waveRaf = 0;
  }
  const canvas = $("#readerBarWave");
  if (canvas) {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
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
    
    s.layoutMode = "spread";
    if (!s.theme) s.theme = "sepia";
    if (!s.pageIndicatorMode) s.pageIndicatorMode = "total";
    if (s.volume == null) s.volume = 1;
    return s;
  } catch {
    return { layoutMode: "spread", theme: "sepia", pageIndicatorMode: "total", volume: 1 };
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

  chapterUnitsCache.clear();
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
  const headers = { ...(opts.headers || {}) };
  if (opts.body && typeof opts.body === "string" && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(path, {
    ...opts,
    headers,
    credentials: "same-origin",
  });
  if (res.status === 401 && !path.startsWith("/api/auth/")) {
    currentUser = null;
    showAuthView();
    const err = await res.json().catch(() => ({ error: "Требуется вход" }));
    throw new Error(err.error || "Требуется вход");
  }
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

function showAuthView() {
  $("#authView")?.classList.remove("hidden");
  $("#libraryView")?.classList.add("hidden");
  $("#readerView")?.classList.add("hidden");
  $("#bookDetailView")?.classList.add("hidden");
  updateUserBadge();
  refreshPublicConfig();
}

function showLibraryView() {
  $("#authView")?.classList.add("hidden");
  $("#libraryView")?.classList.remove("hidden");
  updateUserBadge();
}

function updateUserBadge() {
  const badge = $("#userBadge");
  const logout = $("#btnLogout");
  if (!badge || !logout) return;
  if (currentUser) {
    badge.textContent = currentUser.username;
    badge.classList.remove("hidden");
    logout.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
    logout.classList.add("hidden");
  }
  updateAdminTabsVisibility();
}

async function refreshPublicConfig() {
  try {
    const cfg = await fetch("/api/auth/public-config", {
      credentials: "same-origin",
    }).then((r) => r.json());
    const regTab = document.querySelector('.auth-tab[data-auth-tab="register"]');
    if (regTab) {
      regTab.classList.toggle("hidden", cfg.registrationOpen === false);
    }
    if (cfg.registrationOpen === false && authMode === "register") {
      setAuthMode("login");
    }
  } catch (_) {}
}

function setAuthMode(mode) {
  authMode = mode === "register" ? "register" : "login";
  $$(".auth-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.authTab === authMode);
  });
  const submit = $("#authSubmit");
  const pass = $("#authPassword");
  if (submit) submit.textContent = authMode === "register" ? "Создать аккаунт" : "Войти";
  if (pass) pass.autocomplete = authMode === "register" ? "new-password" : "current-password";
  const err = $("#authError");
  if (err) {
    err.classList.add("hidden");
    err.textContent = "";
  }
}

async function checkAuth() {
  try {
    const data = await fetch("/api/auth/me", { credentials: "same-origin" }).then((r) => r.json());
    if (data.authenticated && data.user) {
      currentUser = data.user;
      showLibraryView();
      await loadBooks();
      return true;
    }
  } catch (_) {}
  currentUser = null;
  showAuthView();
  return false;
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const username = ($("#authUsername")?.value || "").trim();
  const password = $("#authPassword")?.value || "";
  const errEl = $("#authError");
  const submit = $("#authSubmit");
  if (errEl) {
    errEl.classList.add("hidden");
    errEl.textContent = "";
  }
  if (submit) submit.disabled = true;
  try {
    const path = authMode === "register" ? "/api/auth/register" : "/api/auth/login";
    const data = await api(path, {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    currentUser = data.user;
    showLibraryView();
    await loadBooks();
    showToast(
      authMode === "register" ? "Аккаунт создан" : "С возвращением, " + currentUser.username,
      "ok",
      2800
    );
  } catch (err) {
    if (errEl) {
      errEl.textContent = err.message || "Ошибка";
      errEl.classList.remove("hidden");
    }
  } finally {
    if (submit) submit.disabled = false;
  }
}

async function handleLogout() {
  try {
    await api("/api/auth/logout", { method: "POST", body: "{}" });
  } catch (_) {}
  currentUser = null;
  books = [];
  stopTts(false);
  showAuthView();
}

function openUploadModal() {
  pendingUploadFile = null;
  const name = $("#uploadFileName");
  if (name) name.textContent = "Выберите файл";
  const cb = $("#uploadIsPrivate");
  if (cb) cb.checked = false;
  const btn = $("#btnUploadSubmit");
  if (btn) btn.disabled = true;
  $("#uploadOverlay")?.classList.remove("hidden");
}

function closeUploadModal() {
  $("#uploadOverlay")?.classList.add("hidden");
  pendingUploadFile = null;
  const fi = $("#uploadFileInput");
  if (fi) fi.value = "";
  const fi2 = $("#fileInput");
  if (fi2) fi2.value = "";
}

async function submitUpload() {
  if (!pendingUploadFile) return;
  const isPrivate = !!$("#uploadIsPrivate")?.checked;
  const btn = $("#btnUploadSubmit");
  if (btn) btn.disabled = true;
  showToast("Загрузка «" + pendingUploadFile.name + "»…", "ok", 2500);

  const form = new FormData();
  form.append("book", pendingUploadFile);
  form.append("isPrivate", isPrivate ? "true" : "false");

  try {
    const res = await fetch("/api/books", {
      method: "POST",
      body: form,
      credentials: "same-origin",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Ошибка");
    const priv = data.isPrivate ? " · личная" : "";
    showToast(`Добавлено: «${data.title}» (${data.chaptersCount} гл.)${priv}`, "ok", 3500);
    closeUploadModal();
    await loadBooks();
  } catch (err) {
    showToast(err.message || "Ошибка загрузки", "error");
    if (btn) btn.disabled = false;
  }
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

let libScope = "all";
let selectedBookIds = new Set();

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
  if (libScope === "mine" && currentUser) {
    list = list.filter((b) => b.ownerId === currentUser.id);
  } else if (libScope === "public") {
    list = list.filter((b) => !b.isPrivate);
  } else if (libScope === "private") {
    list = list.filter((b) => !!b.isPrivate);
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
    const hint = empty.querySelector(".hint");
    if (hint) {
      hint.innerHTML =
        'Загрузите TXT, FB2 или EPUB. <button type="button" class="btn-primary" id="emptyAddBtn">Добавить книгу</button>';
      $("#emptyAddBtn")?.addEventListener("click", () => openUploadModal());
    }
    contSec?.classList.add("hidden");
    return;
  }

  if (!items.length) {
    list.innerHTML = "";
    empty.classList.remove("hidden");
    const t = empty.querySelector(".empty-title");
    if (t) t.textContent = "Ничего не найдено";
    const hint = empty.querySelector(".hint");
    if (hint) hint.textContent = "Попробуйте другой запрос или фильтр";
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
      const priv = b.isPrivate
        ? `<span class="bc-private" title="Личная книга">личная</span>`
        : "";
      const owner =
        currentUser &&
        currentUser.isAdmin &&
        b.ownerName &&
        b.ownerId !== currentUser.id
          ? `<span class="bc-owner" title="Владелец">${escapeHtml(b.ownerName)}</span>`
          : "";
      return `<article class="bc${hasCover ? " has-cover" : ""}${b.isPrivate ? " is-private" : ""}" data-id="${b.id}">
  <div class="bc-media">${media}</div>
  <div class="bc-ui">
    <span class="bc-status ${st}"></span>
    ${priv}
    ${owner}
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

  const priv = $("#detailIsPrivate");
  if (priv) priv.checked = !!book.isPrivate;

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
    isPrivate: !!$("#detailIsPrivate")?.checked,
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

let pageWheelLock = 0;
let pageTouch = null;

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

$("#btnAddBook")?.addEventListener("click", () => openUploadModal());
$("#btnCloseUpload")?.addEventListener("click", closeUploadModal);
$("#btnUploadCancel")?.addEventListener("click", closeUploadModal);
$("#uploadOverlay")?.addEventListener("click", (e) => {
  if (e.target === $("#uploadOverlay")) closeUploadModal();
});
$("#btnUploadSubmit")?.addEventListener("click", submitUpload);

function onUploadFileChosen(file) {
  if (!file) return;
  pendingUploadFile = file;
  const name = $("#uploadFileName");
  if (name) name.textContent = file.name;
  const btn = $("#btnUploadSubmit");
  if (btn) btn.disabled = false;
}

$("#uploadFileInput")?.addEventListener("change", (e) => {
  onUploadFileChosen(e.target.files?.[0]);
});
$("#fileInput")?.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  openUploadModal();
  onUploadFileChosen(file);
});
$("#uploadDrop")?.addEventListener("click", (e) => {
  if (e.target.closest("input")) return;
  $("#uploadFileInput")?.click();
});

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

let progressTimer = null;

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
  try {
    await api("/api/books/" + currentBook.id + "/progress", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chapterIndex: ch,
        charOffset: u,
        progress,
      }),
    });
    currentBook.chapterIndex = ch;
    currentBook.charOffset = u;
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

function updateAdminTabsVisibility() {
  const isAdmin = !!(currentUser && currentUser.isAdmin);
  $$(".settings-tab.admin-only").forEach((t) => {
    t.classList.toggle("hidden", !isAdmin);
  });
}

function openSettings(tab) {
  applySettings();
  updateThemeSwatches();
  updateAdminTabsVisibility();
  const isAdmin = !!(currentUser && currentUser.isAdmin);
  let target = tab || "text";
  if (!isAdmin && (target === "server" || target === "users")) target = "text";
  selectSettingsTab(target);
  if (isAdmin && target === "server") loadServerConfig();
  if (isAdmin && target === "users") loadAdminUsers();
  $("#settingsOverlay").classList.remove("hidden");
}

function closeSettings() {
  $("#settingsOverlay").classList.add("hidden");
  $("#adminUserBooks")?.classList.add("hidden");
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
  if (name === "server" && currentUser?.isAdmin) loadServerConfig();
  if (name === "users" && currentUser?.isAdmin) loadAdminUsers();
}

async function loadServerConfig() {
  try {
    const cfg = await api("/api/admin/config");
    const lo = $("#cfgLocalhostOnly");
    const reg = $("#cfgRegistrationDisabled");
    if (lo) lo.checked = !!cfg.localhostOnly;
    if (reg) reg.checked = !!cfg.registrationDisabled;
    const hint = $("#cfgServerHint");
    if (hint) hint.textContent = "";
  } catch (err) {
    showToast(err.message || "Ошибка загрузки настроек", "error");
  }
}

async function saveServerConfig() {
  const body = {
    localhostOnly: !!$("#cfgLocalhostOnly")?.checked,
    registrationDisabled: !!$("#cfgRegistrationDisabled")?.checked,
  };
  try {
    const res = await api("/api/admin/config", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    const hint = $("#cfgServerHint");
    if (hint) {
      hint.textContent = res.message || "Сохранено";
      hint.className = "settings-hint";
    }
    showToast(res.message || "Настройки сервера сохранены", "ok");
  } catch (err) {
    showToast(err.message || "Ошибка сохранения", "error");
  }
}

async function loadAdminUsers() {
  const list = $("#adminUsersList");
  const booksPanel = $("#adminUserBooks");
  if (booksPanel) {
    booksPanel.classList.add("hidden");
    booksPanel.innerHTML = "";
  }
  if (!list) return;
  list.innerHTML = "<p class='settings-hint'>Загрузка…</p>";
  try {
    const data = await api("/api/admin/users");
    const users = data.users || [];
    if (!users.length) {
      list.innerHTML = "<p class='settings-hint'>Нет пользователей</p>";
      return;
    }
    list.innerHTML = users
      .map((u) => {
        const me = currentUser && currentUser.id === u.id;
        return `<div class="admin-user-row" data-id="${u.id}">
          <div class="admin-user-main">
            <strong>${escapeHtml(u.username)}</strong>
            ${u.isAdmin ? '<span class="admin-badge">admin</span>' : ""}
            ${me ? '<span class="admin-badge me">вы</span>' : ""}
            <span class="admin-user-meta">${u.booksCount} кн. · ${u.privateCount} личн.</span>
          </div>
          <div class="admin-user-actions">
            <button type="button" class="btn-secondary sm" data-action="lib" data-id="${u.id}">Библиотека</button>
            ${
              !me
                ? `<button type="button" class="btn-secondary sm" data-action="admin" data-id="${u.id}" data-admin="${u.isAdmin ? "0" : "1"}">${
                    u.isAdmin ? "Снять admin" : "Сделать admin"
                  }</button>
            <button type="button" class="btn-secondary sm" data-action="resetpwd" data-id="${u.id}">Пароль</button>
            <button type="button" class="btn-secondary sm danger" data-action="del" data-id="${u.id}">Удалить</button>`
                : ""
            }
          </div>
        </div>`;
      })
      .join("");
    list.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", onAdminUserAction);
    });
  } catch (err) {
    list.innerHTML = `<p class="settings-hint">${escapeHtml(err.message || "Ошибка")}</p>`;
  }
}

async function onAdminUserAction(e) {
  const btn = e.currentTarget;
  const action = btn.dataset.action;
  const id = Number(btn.dataset.id);
  if (!Number.isFinite(id)) return;
  if (action === "lib") {
    await showUserLibrary(id);
    return;
  }
  if (action === "admin") {
    const makeAdmin = btn.dataset.admin === "1";
    try {
      await api("/api/admin/users/" + id + "/set-admin", {
        method: "POST",
        body: JSON.stringify({ isAdmin: makeAdmin }),
      });
      showToast(makeAdmin ? "Права admin выданы" : "Права admin сняты", "ok");
      await loadAdminUsers();
    } catch (err) {
      showToast(err.message || "Ошибка", "error");
    }
    return;
  }
  if (action === "del") {
    const withBooks = confirm(
      "Удалить пользователя?\nОК — только аккаунт\nПосле этого можно будет удалить и книги отдельно.\n\nНажмите ОК, чтобы отменить."
    );
    if (!withBooks && !confirm("Отмена удаления?")) {
      /* fallthrough only when first confirm true */
    }
    if (!withBooks) return;
    const deleteBooks = confirm("Также удалить все его книги?");
    try {
      await api("/api/admin/users/" + id, {
        method: "DELETE",
        body: JSON.stringify({ deleteBooks }),
      });
      showToast(
        deleteBooks ? "Пользователь и книги удалены" : "Пользователь удалён",
        "ok"
      );
      await loadAdminUsers();
      await loadBooks();
    } catch (err) {
      showToast(err.message || "Ошибка", "error");
    }
  }
  if (action === "resetpwd") {
    const newPassword = prompt("Новый пароль (мин. 4 символа):");
    if (!newPassword) return;
    try {
      await api("/api/admin/users/" + id + "/reset-password", {
        method: "POST",
        body: JSON.stringify({ newPassword }),
      });
      showToast("Пароль сброшен", "ok");
    } catch (err) {
      showToast(err.message || "Ошибка", "error");
    }
  }
}

async function showUserLibrary(userId) {
  const panel = $("#adminUserBooks");
  if (!panel) return;
  panel.classList.remove("hidden");
  panel.innerHTML = "<p class='settings-hint'>Загрузка библиотеки…</p>";
  try {
    const data = await api("/api/admin/users/" + userId + "/books");
    const user = data.user;
    const books = data.books || [];
    let html = `<div class="admin-books-head">
      <strong>${escapeHtml(user?.username || "")}</strong>
      <button type="button" class="btn-icon sm" id="btnCloseUserBooks" aria-label="Закрыть">
        <svg class="icon"><use href="#i-close"/></svg>
      </button>
    </div>`;
    if (!books.length) {
      html += "<p class='settings-hint'>У пользователя нет книг</p>";
    } else {
      html +=
        '<ul class="admin-books-list">' +
        books
          .map(
            (b) =>
              `<li data-book-id="${b.id}">
                <div class="ab-info">
                  <span class="ab-title">${escapeHtml(b.title)}</span>
                  <span class="ab-meta">${escapeHtml(b.author || "")} · ${(b.format || "").toUpperCase()}${
                    b.isPrivate ? " · личная" : ""
                  } · ${Math.round(b.progress || 0)}%</span>
                </div>
                <div class="ab-actions">
                  <button type="button" class="btn-secondary sm" data-ab="open" data-id="${b.id}">Открыть</button>
                  <button type="button" class="btn-secondary sm danger" data-ab="del" data-id="${b.id}">Удалить</button>
                </div>
              </li>`
          )
          .join("") +
        "</ul>";
    }
    panel.innerHTML = html;
    $("#btnCloseUserBooks")?.addEventListener("click", () => {
      panel.classList.add("hidden");
      panel.innerHTML = "";
    });
    panel.querySelectorAll("[data-ab]").forEach((btn) => {
      btn.addEventListener("click", async (ev) => {
        const id = btn.dataset.id;
        const act = btn.dataset.ab;
        if (!id) return;
        if (act === "open") {
          closeSettings();
          try {
            await openBook(id);
          } catch (err) {
            showToast(err.message || "Не удалось открыть", "error");
          }
          return;
        }
        if (act === "del") {
          if (!confirm("Удалить эту книгу?")) return;
          try {
            await api("/api/books/" + id, { method: "DELETE" });
            showToast("Книга удалена", "ok");
            await showUserLibrary(userId);
            await loadBooks();
          } catch (err) {
            showToast(err.message || "Ошибка удаления", "error");
          }
        }
      });
    });
  } catch (err) {
    panel.innerHTML = `<p class="settings-hint">${escapeHtml(err.message || "Ошибка")}</p>`;
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

$("#btnSaveServerConfig")?.addEventListener("click", () => saveServerConfig());

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

function onTtsPlayClick() {
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
    updateReaderBarTts();
  }

  if (ttsPicked) startTtsFromPick();
  else startTtsFromCurrentChapter();
}

$("#btnTtsPlay").addEventListener("click", onTtsPlayClick);
$("#btnBarTtsPlay")?.addEventListener("click", onTtsPlayClick);

let lastPrevClick = 0;
function onTtsPrevClick() {
  if (ttsStopped || !ttsSentences.length) return;
  const nearStart = ttsPos <= 0;
  if (nearStart) {
    const ch =
      ttsSentences[0] && ttsSentences[0].ch != null
        ? ttsSentences[0].ch
        : currentChapterIndex;
    if (ch > 0) {
      advanceToChapter(ch - 1, true);
      return;
    }
    jumpToQueueIndex(0);
    return;
  }
  const target = Math.max(0, ttsPos - 1);
  jumpToQueueIndex(target);
}

function onTtsNextClick() {
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
}

$("#btnTtsPrev").addEventListener("click", onTtsPrevClick);
$("#btnBarTtsPrev")?.addEventListener("click", onTtsPrevClick);
$("#btnTtsNext").addEventListener("click", onTtsNextClick);
$("#btnBarTtsNext")?.addEventListener("click", onTtsNextClick);

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

function findUnitIndexForSentence(ch, si) {
  const units = chapterUnits(ch);
  for (let i = 0; i < units.length; i++) {
    if (
      units[i].type === "sentence" &&
      units[i].html.includes(`data-ch="${ch}"`) &&
      units[i].html.includes(`data-si="${si}"`)
    ) {
      return i;
    }
  }
  return 0;
}

function ensureSentencePageVisible(ch, si) {
  if (document.querySelector(`.sentence[data-ch="${ch}"][data-si="${si}"]`)) return;
  currentChapterIndex = ch;
  const u = findUnitIndexForSentence(ch, si);
  pageHistory = [];
  pageCursor = { ch, u };
  pageMetrics.pageIndex = Math.max(0, pageMetrics.pageIndex || 0);
  buildChapterPages(true);
}

function highlightSentence(ch, si) {
  if (ch == null || si == null) return;
  const already = document.querySelector(
    `.sentence.active[data-ch="${ch}"][data-si="${si}"]`
  );
  if (already) {
    already.classList.remove("hover", "picked");
    return;
  }
  $$(".sentence.active, .sentence.picked, .sentence.hover").forEach((el) => {
    el.classList.remove("active", "picked", "hover");
  });
  ensureSentencePageVisible(ch, si);
  const el = document.querySelector(`.sentence[data-ch="${ch}"][data-si="${si}"]`);
  if (el) {
    el.classList.add("active");
    el.classList.remove("hover", "picked");
  }
}

function scrollSentenceIntoView(el, force = false) {}

function clearHighlight() {
  $$(".sentence.active, .sentence.picked, .sentence.hover").forEach((el) => {
    el.classList.remove("active", "picked", "hover");
  });
  try {
    const sel = window.getSelection && window.getSelection();
    if (sel && sel.removeAllRanges) sel.removeAllRanges();
  } catch (_) {}
}

function setScrollLock(on) {
  const content = $("#readerContent");
  if (!content) return;
  content.classList.toggle("tts-scroll-lock", !!on);
}

function getTtsSpeaker() {
  return $("#ttsSpeaker")?.value || settings.speaker || "xenia";
}

function getTtsSpeed() {
  const v = Number($("#ttsSpeed")?.value || settings.speed || 1);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

function sanitizeTtsText(text) {
  let t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (t.length > 800) t = t.slice(0, 800);
  if (!/[0-9A-Za-zА-Яа-яЁё]/.test(t)) return "";
  return t;
}


async function fetchSentenceAudio(text, gen, { signal } = {}) {
  const speaker = getTtsSpeaker();
  const speed = getTtsSpeed();
  let t = sanitizeTtsText(text);
  if (!t) throw new Error("Пустое предложение");

  const doFetch = async () => {
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
  };

  try {
    return await doFetch();
  } catch (err) {
    if (err.message === "cancelled") throw err;
    if (signal && signal.aborted) throw new Error("cancelled");
    await new Promise((r) => setTimeout(r, 350));
    if (gen !== ttsGeneration) throw new Error("cancelled");
    return await doFetch();
  }
}

function clearPrefetch() {
  for (const entry of ttsCache.values()) {
    try {
      if (entry && entry.url) URL.revokeObjectURL(entry.url);
    } catch (_) {}
  }
  ttsCache.clear();
  ttsPrefetching.clear();
}

function fillPrefetch(gen) {
  if (ttsStopped || gen !== ttsGeneration) return;
  if (!ttsSentences.length) return;

  if (!ttsAbort) ttsAbort = new AbortController();
  const signal = ttsAbort.signal;

  const start = ttsPos;
  const end = Math.min(ttsSentences.length, ttsPos + 1 + TTS_PREFETCH_AHEAD);

  for (let i = start; i < end; i++) {
    if (ttsCache.has(i) || ttsPrefetching.has(i)) continue;
    const item = ttsSentences[i];
    if (!item || !sanitizeTtsText(item.text)) continue;

    ttsPrefetching.add(i);
    const idx = i;
    fetchSentenceAudio(item.text, gen, { signal })
      .then((url) => {
        if (ttsStopped || gen !== ttsGeneration) {
          try { URL.revokeObjectURL(url); } catch (_) {}
          return;
        }
        if (ttsCache.has(idx)) {
          try { URL.revokeObjectURL(url); } catch (_) {}
          return;
        }
        ttsCache.set(idx, { url, index: idx });
        for (const [k, entry] of ttsCache) {
          if (k < ttsPos - 1) {
            try { URL.revokeObjectURL(entry.url); } catch (_) {}
            ttsCache.delete(k);
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        ttsPrefetching.delete(idx);
      });
  }
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
    scrollToChapter(chIndex, true);
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
    }, 20);
    return;
  }

  ttsPos = pos;
  const item = ttsSentences[pos];
  if (!item || !sanitizeTtsText(item.text)) {
    return playAt(pos + 1, gen);
  }

  currentChapterIndex = item.ch;
  highlightSentence(item.ch, item.si);
  saveProgressDebounced();

  if (ttsStatus) ttsStatus.textContent = `${pos + 1} / ${ttsSentences.length}`;

  fillPrefetch(gen);

  let url = null;
  let fromCache = false;
  const cached = ttsCache.get(pos);
  if (cached && cached.url) {
    url = cached.url;
    ttsCache.delete(pos);
    fromCache = true;
  }

  try {
    if (!url) {
      $("#btnTtsPlay").disabled = true;
      if (ttsStatus) ttsStatus.textContent = `Генерация ${pos + 1}/${ttsSentences.length}...`;
      if (!ttsAbort) ttsAbort = new AbortController();
      url = await fetchSentenceAudio(item.text, gen, { signal: ttsAbort.signal });
      if (gen !== ttsGeneration) {
        try { URL.revokeObjectURL(url); } catch (_) {}
        return;
      }
      $("#btnTtsPlay").disabled = false;
    }
  } catch (err) {
    if (err.message === "cancelled") return;
    $("#btnTtsPlay").disabled = false;
    const msg = err.message || "Ошибка TTS";
    if (ttsStatus) ttsStatus.textContent = msg;
    if (typeof showToast === "function") showToast(msg, "error");
    highlightSentence(item.ch, item.si);
    isSpeaking = false;
    setPlayIcon(false);
    setScrollLock(false);
    updateReaderBarTts();
    return;
  }

  highlightSentence(item.ch, item.si);
  fillPrefetch(gen);

  ttsAudio.onended = null;
  ttsAudio.onerror = null;
  ttsAudio.src = url;

  ttsAudio.onended = () => {
    try { URL.revokeObjectURL(url); } catch (_) {}
    if (!ttsStopped && gen === ttsGeneration) playAt(pos + 1, gen);
  };
  ttsAudio.onerror = () => {
    try { URL.revokeObjectURL(url); } catch (_) {}
    if (ttsStopped || gen !== ttsGeneration) return;
    if (ttsStatus) ttsStatus.textContent = "Ошибка воспроизведения";
    if (typeof showToast === "function") showToast("Ошибка воспроизведения", "error");
    highlightSentence(item.ch, item.si);
    isSpeaking = false;
    setPlayIcon(false);
    setScrollLock(false);
    updateReaderBarTts();
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
    if (ttsStatus) {
      ttsStatus.textContent = fromCache
        ? `${pos + 1} / ${ttsSentences.length}`
        : `${pos + 1} / ${ttsSentences.length}`;
    }
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
  updateReaderBarTts();
  if (ttsStatus) ttsStatus.textContent = "Генерация…";
  ttsAbort = new AbortController();
  fillPrefetch(gen);
  setTimeout(() => {
    if (gen !== ttsGeneration || ttsStopped) return;
    playAt(0, gen);
  }, 10);
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
  currentChapterIndex = list[0].ch;
  highlightSentence(list[0].ch, list[0].si);
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
  updateReaderBarTts();
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
  if (ttsAbort) {
    try { ttsAbort.abort(); } catch (_) {}
    ttsAbort = null;
  }
  try {
    ttsAudio.pause();
    ttsAudio.onended = null;
    ttsAudio.onerror = null;
    ttsAudio.removeAttribute("src");
    ttsAudio.load();
  } catch (_) {}
  clearPrefetch();

  if (updateUi) {
    setPlayIcon(false);
    updateReaderBarTts();
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
  if (e.code === "KeyB" && inReader) {
    e.preventDefault();
    addBookmarkHere();
    return;
  }
  if (e.code === "KeyT" && inReader) {
    e.preventDefault();
    $("#btnToc")?.click();
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


async function addBookmarkHere() {
  if (!currentBook) return;
  const ch = Number.isFinite(pageCursor?.ch) ? pageCursor.ch : currentChapterIndex || 0;
  const u = Number.isFinite(pageCursor?.u) ? pageCursor.u : 0;
  try {
    await api("/api/books/" + currentBook.id + "/bookmarks", {
      method: "POST",
      body: JSON.stringify({
        chapterIndex: ch,
        charOffset: u,
        label: "Глава " + (ch + 1),
      }),
    });
    showToast("Закладка сохранена", "ok");
  } catch (err) {
    showToast(err.message || "Ошибка закладки", "error");
  }
}

const libStatusSelect = $("#libStatus");
if (libStatusSelect) {
  libStatusSelect.value = libStatus || "all";
  libStatusSelect.addEventListener("change", () => {
    libStatus = libStatusSelect.value || "all";
    localStorage.setItem("al_lib_status", libStatus);
    renderLibrary();
  });
}

const libScopeSelect = $("#libScope");
if (libScopeSelect) {
  libScopeSelect.value = libScope || "all";
  libScopeSelect.addEventListener("change", () => {
    libScope = libScopeSelect.value || "all";
    renderLibrary();
  });
}

$("#btnChangePassword")?.addEventListener("click", async () => {
  const oldPassword = $("#pwdOld")?.value || "";
  const newPassword = $("#pwdNew")?.value || "";
  try {
    await api("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ oldPassword, newPassword }),
    });
    showToast("Пароль изменён", "ok");
    if ($("#pwdOld")) $("#pwdOld").value = "";
    if ($("#pwdNew")) $("#pwdNew").value = "";
  } catch (err) {
    showToast(err.message || "Ошибка", "error");
  }
});

$("#btnDownloadBackup")?.addEventListener("click", () => {
  window.location.href = "/api/admin/backup";
});

$("#btnBookmark")?.addEventListener("click", () => addBookmarkHere());

$("#detailStatus")?.addEventListener("change", () => scheduleDetailSave());
$("#detailIsPrivate")?.addEventListener("change", () => scheduleDetailSave());
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

$$(".auth-tab").forEach((tab) => {
  tab.addEventListener("click", () => setAuthMode(tab.dataset.authTab));
});
$("#authForm")?.addEventListener("submit", handleAuthSubmit);
$("#btnLogout")?.addEventListener("click", handleLogout);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

applySettings();
checkAuth().catch((err) => {
  console.error(err);
  showAuthView();
});
