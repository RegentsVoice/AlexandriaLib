
let books = [];
let currentBook = null;
let currentChapterIndex = 0;
let isSpeaking = false;
let settings = loadSettings();
let currentUser = null;
let authMode = "login";
let pendingUploadFile = null;

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
  const confirmWrap = $("#authConfirmWrap");
  const confirm = $("#authPasswordConfirm");
  if (submit) submit.textContent = authMode === "register" ? "Создать аккаунт" : "Войти";
  if (pass) pass.autocomplete = authMode === "register" ? "new-password" : "current-password";
  if (confirmWrap) confirmWrap.classList.toggle("hidden", authMode !== "register");
  if (confirm) {
    confirm.required = authMode === "register";
    if (authMode !== "register") confirm.value = "";
  }
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
  const passwordConfirm = $("#authPasswordConfirm")?.value || "";
  const errEl = $("#authError");
  const submit = $("#authSubmit");
  if (errEl) {
    errEl.classList.add("hidden");
    errEl.textContent = "";
  }
  if (authMode === "register" && password !== passwordConfirm) {
    if (errEl) {
      errEl.textContent = "Пароли не совпадают";
      errEl.classList.remove("hidden");
    }
    return;
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
    const id = detailBookId;
    const fromAdmin = adminViewOpen;
    const uid = adminViewUserId;
    await api("/api/books/" + id, { method: "DELETE" });
    showToast("Книга удалена", "ok", 2500);
    closeBookDetail();
    await loadBooks();
    if (fromAdmin && uid) await showUserLibrary(uid);
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
  const newConfirm = $("#pwdNewConfirm")?.value || "";
  if (!newPassword || newPassword.length < 4) {
    showToast("Новый пароль: минимум 4 символа", "error");
    return;
  }
  if (newPassword !== newConfirm) {
    showToast("Пароли не совпадают", "error");
    return;
  }
  try {
    await api("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ oldPassword, newPassword }),
    });
    showToast("Пароль изменён", "ok");
    if ($("#pwdOld")) $("#pwdOld").value = "";
    if ($("#pwdNew")) $("#pwdNew").value = "";
    if ($("#pwdNewConfirm")) $("#pwdNewConfirm").value = "";
  } catch (err) {
    showToast(err.message || "Ошибка", "error");
  }
});

$("#btnDownloadBackup")?.addEventListener("click", () => {
  window.location.href = "/api/admin/backup";
});


$("#detailStatus")?.addEventListener("change", () => scheduleDetailSave());
$("#detailIsPrivate")?.addEventListener("change", () => scheduleDetailSave());
["#detailTitle", "#detailAuthor", "#detailSeries", "#detailYear", "#detailDesc"].forEach((sel) => {
  const el = $(sel);
  if (!el) return;
  el.addEventListener("blur", () => scheduleDetailSave());
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
