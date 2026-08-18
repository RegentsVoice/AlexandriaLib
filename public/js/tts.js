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

let waveCtx = null;
let waveAnalyser = null;
let waveSource = null;
let waveData = null;
let waveRaf = 0;
let waveAudioCtx = null;

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
  const showMini = !settings || settings.showMiniPlayer !== false;
  const showWave = !settings || settings.showWaveform !== false;
  bar.classList.toggle("hidden", !active || !showMini);
  const waveWrap = bar.querySelector(".reader-bar-wave-wrap");
  if (waveWrap) waveWrap.classList.toggle("hidden", !showWave);
  if (active && showMini && showWave) startWaveform();
  else stopWaveform();
}

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
  else startTtsFromLastOrChapter();
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
    else startTtsFromLastOrChapter();
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
  if (typeof currentBook !== "undefined" && currentBook) {
    currentBook.lastTts = { ch: item.ch, si: item.si };
  }
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

function startTtsFromLastOrChapter() {
  const lt = typeof currentBook !== "undefined" && currentBook && currentBook.lastTts;
  if (lt && lt.ch != null && lt.si != null) {
    const ch = Number(lt.ch);
    const si = Number(lt.si);
    if (Number.isFinite(ch) && Number.isFinite(si)) {
      try {
        ensureSentencePageVisible(ch, si);
      } catch (_) {}
      const list = collectFromPick(ch, si, null);
      if (list && list.length) {
        ttsPicked = null;
        beginQueue(list);
        return;
      }
    }
  }
  startTtsFromCurrentChapter();
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

