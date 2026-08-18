let libQuery = "";
let libStatus = (localStorage.getItem("al_lib_status") || localStorage.getItem("sr_lib_status")) || "all";
let detailBookId = null;
let libSort = (localStorage.getItem("al_lib_sort") || localStorage.getItem("sr_lib_sort")) || "recent";
let libScope = "all";
let selectedBookIds = new Set();
let detailSaveTimer = null;

async function loadBooks() {
  books = await api("/api/books");
  renderLibrary();
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

let adminViewBooks = [];
let adminViewUserId = null;
let adminViewOpen = false;

function findBookById(id) {
  return books.find((b) => b.id === id) || adminViewBooks.find((b) => b.id === id) || null;
}

function canEditBookLocal(book) {
  if (!book || !currentUser) return false;
  if (currentUser.isAdmin) return true;
  return Number(book.ownerId) === Number(currentUser.id);
}

function bookForCurrentUserView(book) {
  if (!book) return null;
  const mine = books.find((b) => b.id === book.id);
  if (mine) {
    return Object.assign({}, book, {
      progress: mine.progress || 0,
      chapterIndex: mine.chapterIndex || 0,
      charOffset: mine.charOffset || 0,
      status: mine.status || "queue",
      lastTts: mine.lastTts || null,
    });
  }
  return Object.assign({}, book, {
    progress: 0,
    chapterIndex: 0,
    charOffset: 0,
    status: "queue",
    lastTts: null,
  });
}

function openBookDetail(id) {
  const raw = findBookById(id);
  if (!raw) return;
  const book = bookForCurrentUserView(raw);
  detailBookId = id;

  $("#libraryView").classList.add("hidden");
  $("#bookDetailView").classList.remove("hidden");
  $("#readerView").classList.add("hidden");
  if (adminViewOpen) {
    $("#userLibraryOverlay")?.classList.add("hidden");
  }

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
      cover.innerHTML = `<img class="detail-cover-img" src="/api/books/${book.id}/cover?t=${Date.now()}" alt="" draggable="false" />`;
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

  const editable = canEditBookLocal(book);
  const metaSelectors = [
    "#detailTitle",
    "#detailAuthor",
    "#detailSeries",
    "#detailYear",
    "#detailDesc",
  ];
  metaSelectors.forEach((sel) => {
    const el = $(sel);
    if (!el) return;
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      el.readOnly = !editable;
    } else {
      el.disabled = !editable;
    }
  });
  if (priv) {
    priv.disabled = !editable;
    const row = priv.closest(".switch-row, .detail-private, label");
    if (row) {
      row.classList.toggle("is-disabled", !editable);
      row.classList.toggle("hidden", !editable);
    }
  }
  if (stSel) stSel.disabled = false;

  const del = $("#btnDetailDelete");
  if (del) del.classList.toggle("hidden", !editable);

  const view = $("#bookDetailView");
  if (view) view.classList.toggle("detail-readonly", !editable);

  const ownerLine = $("#detailOwnerLine");
  if (ownerLine) {
    if (book.ownerName) {
      ownerLine.textContent = "Владелец: " + book.ownerName;
      ownerLine.classList.remove("hidden");
    } else {
      ownerLine.textContent = "";
      ownerLine.classList.add("hidden");
    }
  }

  const coverActions = $("#detailCoverActions");
  if (coverActions) coverActions.classList.toggle("hidden", !editable);
}

function closeBookDetail() {
  detailBookId = null;
  $("#bookDetailView").classList.add("hidden");
  if (adminViewOpen) {
    $("#userLibraryOverlay")?.classList.remove("hidden");
    return;
  }
  $("#libraryView").classList.remove("hidden");
}

function scheduleDetailSave() {
  const book = findBookById(detailBookId);
  if (!book) return;
  const isStatusOnly =
    document.activeElement && document.activeElement.id === "detailStatus";
  if (!canEditBookLocal(book) && !isStatusOnly) return;
  clearTimeout(detailSaveTimer);
  detailSaveTimer = setTimeout(saveDetailBook, 450);
}

async function saveDetailBook() {
  if (!detailBookId) return;
  const book = findBookById(detailBookId);
  const editable = canEditBookLocal(book);
  const status = $("#detailStatus")?.value || "queue";
  let payload;
  if (editable) {
    const title = ($("#detailTitle")?.value || "").trim();
    if (!title) {
      showToast("Название не может быть пустым", "error");
      return;
    }
    payload = {
      title,
      author: ($("#detailAuthor")?.value || "").trim(),
      series: ($("#detailSeries")?.value || "").trim(),
      year: ($("#detailYear")?.value || "").trim(),
      description: ($("#detailDesc")?.value || "").trim(),
      status,
      isPrivate: !!$("#detailIsPrivate")?.checked,
    };
  } else {
    payload = { status };
  }
  try {
    await api("/api/books/" + detailBookId, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    await loadBooks();
    showToast("Карточка сохранена", "ok", 2200);
  } catch (err) {
    showToast(err.message || "Ошибка сохранения", "error");
  }
}

async function uploadDetailCover(file) {
  if (!detailBookId || !file) return;
  const book = findBookById(detailBookId);
  if (!canEditBookLocal(book)) {
    showToast("Нет прав на смену обложки", "error");
    return;
  }
  const form = new FormData();
  form.append("cover", file);
  try {
    const res = await fetch("/api/books/" + detailBookId + "/cover", {
      method: "POST",
      body: form,
      credentials: "same-origin",
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch (_) {
      throw new Error(res.ok ? "Некорректный ответ сервера" : "Сервер не принял обложку (нужен перезапуск?)");
    }
    if (!res.ok) throw new Error(data.error || "Ошибка загрузки обложки");
    showToast("Обложка обновлена", "ok", 2200);
    await loadBooks();
    let updated = findBookById(detailBookId);
    if (updated) {
      updated.hasCover = true;
      if (adminViewBooks.length) {
        const ab = adminViewBooks.find((b) => b.id === detailBookId);
        if (ab) ab.hasCover = true;
      }
      renderBookDetail(bookForCurrentUserView(updated));
    }
  } catch (err) {
    showToast(err.message || "Ошибка загрузки обложки", "error");
  }
}

async function removeDetailCover() {
  if (!detailBookId) return;
  const book = findBookById(detailBookId);
  if (!canEditBookLocal(book)) return;
  if (!confirm("Убрать обложку?")) return;
  try {
    await api("/api/books/" + detailBookId + "/cover", { method: "DELETE" });
    showToast("Обложка удалена", "ok", 2200);
    await loadBooks();
    const updated = findBookById(detailBookId);
    if (updated) {
      updated.hasCover = false;
      renderBookDetail(bookForCurrentUserView(updated));
    }
  } catch (err) {
    showToast(err.message || "Ошибка удаления обложки", "error");
  }
}

function onUploadFileChosen(file) {
  if (!file) return;
  pendingUploadFile = file;
  const name = $("#uploadFileName");
  if (name) name.textContent = file.name;
  const btn = $("#btnUploadSubmit");
  if (btn) btn.disabled = false;
}


$("#btnDetailCoverChange")?.addEventListener("click", () => {
  $("#detailCoverInput")?.click();
});
$("#detailCoverInput")?.addEventListener("change", (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = "";
  if (f) uploadDetailCover(f);
});
$("#btnDetailCoverRemove")?.addEventListener("click", () => removeDetailCover());

$("#btnAddBook")?.addEventListener("click", () => openUploadModal());
$("#btnCloseUpload")?.addEventListener("click", closeUploadModal);
$("#btnUploadCancel")?.addEventListener("click", closeUploadModal);
$("#uploadOverlay")?.addEventListener("click", (e) => {
  if (e.target === $("#uploadOverlay")) closeUploadModal();
});
$("#btnUploadSubmit")?.addEventListener("click", submitUpload);
