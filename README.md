<p align="center">
  <img src="public/logo.png" alt="OPEN Booru" width="180" />
</p>

# AlexandriaLib

Локальная библиотека книг (TXT / FB2 / EPUB) с озвучкой Silero TTS и мультипользовательским доступом.

## Запуск

```bash
npm install
node server.js
```

Откройте: http://127.0.0.1:8766

Первый зарегистрированный пользователь становится администратором.

## Возможности

- Загрузка TXT, FB2, EPUB
- Читалка с пагинацией, темами, TTS
- Учётки, сессии, смена пароля
- Личные книги
- Прогресс и статус на пользователя
- Закладки (кнопка / клавиша B)
- Admin: localhost/сеть, регистрация, пользователи, backup
- Фильтры: мои / общие / личные
- Массовое удаление книг (admin)
- PWA
- SQLite: общий core + отдельная БД на каждого пользователя (имена — случайные 8 цифр)
- TTS: очередь с предзагрузкой 3 предложений, retry, плавный переход глав

## Порты

- Node: 8766 (`PORT`)
- TTS: 8765

Сервер слушает 0.0.0.0; middleware «только localhost» настраивается в админке.

## Данные

- `books/` — файлы книг, обложки, `*.chapters.json`
- `data/cXXXXXXXX.sqlite` — общая БД (users, books meta, sessions, config)
- `data/udb/uXXXXXXXX.sqlite` — БД пользователя (progress, bookmarks)
- `data/core.name` — имя файла общей БД
- `data/session.secret`

При первом запуске, если есть старые `users.json` / `library.json`, выполняется миграция.
