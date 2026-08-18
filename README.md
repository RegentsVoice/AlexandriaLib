<p align="center">
  <img src="public/logo.png" alt="AlexandriaLib" width="160" />
</p>

<h1 align="center">AlexandriaLib</h1>

<p align="center">
  Self-hosted библиотека книг с читалкой и озвучкой Silero TTS<br/>
  TXT · FB2 · EPUB · мультипользовательский доступ · PWA
</p>

---

## Возможности

- Загрузка **TXT / FB2 / EPUB**
- Читалка: темы, ширина, прогресс, закладки (`B`)
- **Silero TTS** с очередью и предзагрузкой
- Личные и общие книги, фильтры, статусы
- Аккаунты, админка, backup
- SQLite (общая БД + отдельная на пользователя)
- PWA

---

## Требования

| | Минимум |
|---|---|
| Node.js | 18+ |
| Python | 3.9+ |
| Место | ~2–4 ГБ (модели TTS при первом запуске) |

---

## Автоустановка

### Linux

```bash
curl -fsSL https://raw.githubusercontent.com/RegentsVoice/AlexandriaLib/main/scripts/install-linux.sh | bash
```

Или из клона репозитория:

```bash
bash scripts/install-linux.sh
```

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/RegentsVoice/AlexandriaLib/main/scripts/install-windows.ps1 | iex
```

Или из клона:

```powershell
.\scripts\install-windows.ps1
```

Скрипт поставит зависимости, клонирует/обновит репозиторий (если нужно), выполнит `npm install` и `npm run setup`.

---

## Ручная установка

```bash
git clone https://github.com/RegentsVoice/AlexandriaLib.git
cd AlexandriaLib

npm install
npm run setup
npm start
```

Первый `npm run setup` скачает Python-зависимости и модели TTS — может занять несколько минут.

---

## Запуск

```bash
npm start
```

Откройте: **http://127.0.0.1:8766**

Первый зарегистрированный пользователь становится администратором.

Порт Node можно сменить: `PORT=9000 npm start`  
TTS: `8765`

---


---

## Docker

```bash
docker compose up -d --build
```

Откройте: **http://127.0.0.1:8766**

Первый запуск скачает модели TTS (2–4 ГБ) — может занять несколько минут. Данные и модели хранятся в Docker volumes.

Только Dockerfile:

```bash
docker build -t alexandria-lib .
docker run -d -p 8766:8766 \
  -v alexandria-books:/app/books \
  -v alexandria-data:/app/data \
  -v alexandria-torch:/app/python/.torch \
  -v alexandria-hf:/app/python/.hf \
  --name alexandria-lib alexandria-lib
```

## Данные

| Путь | Назначение |
|------|------------|
| `books/` | Файлы книг, обложки, главы |
| `data/cXXXXXXXX.sqlite` | Общая БД |
| `data/udb/uXXXXXXXX.sqlite` | БД пользователя |
| `data/session.secret` | Секрет сессий |

---

## Лицензия

[MIT](LICENSE)
