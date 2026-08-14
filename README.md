<p align="center">
  <img src="public/logo.png" alt="OPEN Booru" width="180" />
</p>

**AlexandriaLib** — локальная библиотека и читалка с озвучкой **Silero** (русский).

### Возможности

| Возможность | Описание |
| --- | --- |
| **Форматы** | `.txt`, `.fb2`, `.epub` |
| **Библиотека** | Обложки, поиск, сортировка, статусы, «Продолжить» |
| **Читалка** | Лента / страница / разворот |
| **Озвучка** | Голоса Silero, навигация по предложениям |
| **Метаданные** | Правка прямо на карточке книги |

### Требования

* **Node.js ≥ 18**
* **Python ≥ 3.9**
* **git**
* Место под модели TTS (первый запуск дольше)

### Установка

#### 1. Автоматическая (рекомендуется)

**Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/RegentsVoice/AlexandriaLib/main/scripts/install-linux.sh | bash
cd ~/AlexandriaLib && npm start
```

**Windows** (PowerShell):

```powershell
irm https://raw.githubusercontent.com/RegentsVoice/AlexandriaLib/main/scripts/install-windows.ps1 | iex
cd $HOME\AlexandriaLib; npm start
```

#### 2. Вручную

```bash
git clone https://github.com/RegentsVoice/AlexandriaLib.git
cd AlexandriaLib
npm install
npm run setup
npm start
```

### Использование

```
http://localhost:3000
```
