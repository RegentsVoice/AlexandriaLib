function loadSettings() {
  try {
    const s = JSON.parse((localStorage.getItem("al_settings") || localStorage.getItem("sr_settings")) || "{}");
    s.layoutMode = "spread";
    if (!s.theme) s.theme = "sepia";
    if (!s.pageIndicatorMode) s.pageIndicatorMode = "total";
    if (s.volume == null) s.volume = 1;
    if (s.showWaveform == null) s.showWaveform = true;
    if (s.showMiniPlayer == null) s.showMiniPlayer = true;
    return s;
  } catch {
    return {
      layoutMode: "spread",
      theme: "sepia",
      pageIndicatorMode: "total",
      volume: 1,
      showWaveform: true,
      showMiniPlayer: true,
    };
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
  if ($("#settingShowWaveform")) $("#settingShowWaveform").checked = settings.showWaveform !== false;
  if ($("#settingShowMiniPlayer")) $("#settingShowMiniPlayer").checked = settings.showMiniPlayer !== false;
  if (typeof updateReaderBarTts === "function") updateReaderBarTts();
}

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

let adminUsersCache = [];

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
    adminUsersCache = data.users || [];
    const q = ($("#adminUserSearch")?.value || "").trim();
    renderAdminUsersList(q);
  } catch (err) {
    list.innerHTML = `<p class="settings-hint">${escapeHtml(err.message || "Ошибка")}</p>`;
  }
}

function renderAdminUsersList(query) {
  const list = $("#adminUsersList");
  if (!list) return;
  const q = String(query || "").trim().toLowerCase();
  const users = !q
    ? adminUsersCache
    : adminUsersCache.filter((u) => String(u.username || "").toLowerCase().includes(q));
  if (!adminUsersCache.length) {
    list.innerHTML = "<p class='settings-hint'>Нет пользователей</p>";
    return;
  }
  if (!users.length) {
    list.innerHTML = "<p class='settings-hint'>Никого не найдено</p>";
    return;
  }
  list.innerHTML = users
    .map((u) => {
      const me = currentUser && currentUser.id === u.id;
      const booksCount = u.booksCount != null ? u.booksCount : 0;
      const privateCount = u.privateCount != null ? u.privateCount : 0;
      return `<div class="admin-user-row" data-id="${u.id}" data-username="${escapeHtml(u.username || "")}">
        <div class="admin-user-main">
          <strong>${escapeHtml(u.username)}</strong>
          ${u.isAdmin ? '<span class="admin-badge">admin</span>' : ""}
          ${me ? '<span class="admin-badge me">вы</span>' : ""}
          <span class="admin-user-meta">${booksCount} кн. · ${privateCount} личн.</span>
        </div>
        <div class="admin-user-actions">
          <button type="button" class="btn-primary sm" data-action="lib" data-id="${u.id}">Библиотека</button>
          ${
            !me
              ? `<button type="button" class="btn-secondary sm" data-action="admin" data-id="${u.id}" data-admin="${u.isAdmin ? "0" : "1"}">${
                  u.isAdmin ? "Снять админа" : "Сделать админом"
                }</button>
          <button type="button" class="btn-secondary sm" data-action="resetpwd" data-id="${u.id}">Сбросить пароль</button>
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

function closeUserLibraryModal() {
  adminViewOpen = false;
  adminViewBooks = [];
  adminViewUserId = null;
  const ov = $("#userLibraryOverlay");
  if (ov) {
    ov.classList.add("hidden");
    const grid = $("#userLibraryGrid");
    if (grid) grid.innerHTML = "";
  }
}

async function showUserLibrary(userId) {
  const overlay = $("#userLibraryOverlay");
  const grid = $("#userLibraryGrid");
  const titleEl = $("#userLibraryTitle");
  if (!overlay || !grid) return;

  adminViewOpen = true;
  adminViewUserId = userId;
  overlay.classList.remove("hidden");
  grid.innerHTML =
    '<div class="ulib-skeleton">' +
    "<div class='ulib-skel-card'></div>".repeat(6) +
    "</div>";
  if (titleEl) titleEl.textContent = "Библиотека…";

  try {
    const data = await api("/api/admin/users/" + userId + "/books");
    const user = data && data.user;
    adminViewBooks = (data && data.books) || [];
    if (titleEl) {
      titleEl.textContent =
        "Библиотека: " + (user && user.username ? user.username : "");
    }

    if (!adminViewBooks.length) {
      grid.innerHTML =
        "<div class='ulib-empty'><p class='settings-hint'>У пользователя нет книг</p></div>";
      return;
    }

    grid.innerHTML = adminViewBooks
      .map((b) => {
        const progress = Math.round(b.progress || 0);
        const letter = (b.title || "?").trim().charAt(0).toUpperCase();
        const hasCover = !!b.hasCover;
        const media = hasCover
          ? `<img class="bc-img" src="/api/books/${b.id}/cover" alt="" loading="lazy" draggable="false" />`
          : `<div class="bc-placeholder" style="background:${coverGradient(b.title || "")}"><span>${escapeHtml(letter)}</span></div>`;
        const priv = b.isPrivate
          ? `<span class="bc-private" title="Личная книга">личная</span>`
          : "";
        return `<article class="bc${hasCover ? " has-cover" : ""}${b.isPrivate ? " is-private" : ""}" data-id="${b.id}" role="button" tabindex="0">
  <div class="bc-media">${media}</div>
  <div class="bc-ui">
    <span class="bc-progress" title="Прогресс пользователя">${progress}%</span>
    ${priv}
    <div class="bc-caption">
      <div class="bc-title">${escapeHtml(b.title || "")}</div>
      <div class="bc-author">${escapeHtml(b.author || "")}</div>
    </div>
  </div>
</article>`;
      })
      .join("");

    grid.querySelectorAll(".bc").forEach((card) => {
      const open = () => {
        const id = card.dataset.id;
        if (id) openBookDetail(id);
      };
      card.addEventListener("click", (e) => {
        if (e.target.closest(".bc-delete")) return;
        open();
      });
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      });
    });
  } catch (err) {
    grid.innerHTML = `<p class="settings-hint">${escapeHtml(err.message || "Ошибка")}</p>`;
    showToast(err.message || "Ошибка загрузки библиотеки", "error");
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

$("#settingShowWaveform")?.addEventListener("change", (e) => {
  settings.showWaveform = !!e.target.checked;
  saveSettings();
  if (typeof updateReaderBarTts === "function") updateReaderBarTts();
});
$("#settingShowMiniPlayer")?.addEventListener("change", (e) => {
  settings.showMiniPlayer = !!e.target.checked;
  saveSettings();
  if (typeof updateReaderBarTts === "function") updateReaderBarTts();
});
$("#adminUserSearch")?.addEventListener("input", (e) => {
  renderAdminUsersList(e.target.value || "");
});
$("#btnCloseUserLibrary")?.addEventListener("click", () => closeUserLibraryModal());
$("#userLibraryOverlay")?.addEventListener("click", (e) => {
  if (e.target === $("#userLibraryOverlay")) closeUserLibraryModal();
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

$("#pageIndicatorMode")?.addEventListener("change", (e) => {
  settings.pageIndicatorMode = e.target.value;
  saveSettings();
  updatePageIndicator();
});
