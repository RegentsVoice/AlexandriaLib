#!/usr/bin/env node

const path = require("path");
const express = require("express");
const cors = require("cors");
const {
  authMiddleware,
  registerAuthRoutes,
  registerAdminRoutes,
  localhostOnlyMiddleware,
  getAccessConfig,
} = require("./auth");
const db = require("./db");
const { BOOKS_DIR, PUBLIC_DIR, NODE_PORT, PYTHON_PORT } = require("./lib/config");
const { log, ensureDir } = require("./lib/utils");
const { deleteBooksByOwner } = require("./lib/books");
const { createBackup } = require("./lib/backup");
const {
  needsSetup,
  ensureVenv,
  installPythonDeps,
  predownloadModels,
  writeSetupMarker,
  startPythonServer,
  getPythonProcess,
} = require("./lib/setup");
const { registerBookRoutes } = require("./routes/books");
const { registerTtsRoutes } = require("./routes/tts");

function startExpress() {
  const app = express();
  app.use(cors({ origin: true, credentials: true }));
  app.use(express.json({ limit: "5mb" }));
  app.use(localhostOnlyMiddleware);
  app.use(authMiddleware);
  registerAuthRoutes(app);
  registerAdminRoutes(app, { deleteBooksByOwner, createBackup });

  app.get("/api/health", async (req, res) => {
    let tts = false;
    try {
      const r = await fetch("http://127.0.0.1:" + PYTHON_PORT + "/health");
      tts = r.ok;
    } catch (_) {
      tts = false;
    }
    res.json({
      ok: true,
      tts,
      time: Date.now(),
      localhostOnly: !!getAccessConfig().localhostOnly,
    });
  });

  registerBookRoutes(app);
  registerTtsRoutes(app);

  app.use(express.static(PUBLIC_DIR));

  app.get("*", (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, "index.html"));
  });

  const cfg = getAccessConfig();
  const host = process.env.HOST || "0.0.0.0";
  app.listen(NODE_PORT, host, () => {
    log("http://127.0.0.1:" + NODE_PORT);
    if (cfg.localhostOnly) log("режим: только localhost (middleware)");
    else log("режим: сеть");
  });
}

async function main() {
  const setupOnly = process.argv.includes("--setup-only");
  ensureDir(BOOKS_DIR);

  try {
    const mig = db.migrateFromJson();
    if (mig.migrated) {
      log("migrated from JSON: users=" + mig.migratedUsers + " books=" + mig.migratedBooks + " states=" + mig.migratedStates);
    }
  } catch (e) {
    log("migration skip: " + (e && e.message ? e.message : e));
  }

  if (needsSetup()) {
    log("first-time setup (may take several minutes)...");
    ensureVenv();
    installPythonDeps();
    predownloadModels();
    writeSetupMarker();
    log("setup complete");
  } else {
    log("setup cached — skip");
  }

  if (setupOnly) {
    process.exit(0);
  }

  startExpress();
  try {
    await startPythonServer();
  } catch (err) {
    log("TTS unavailable: " + (err && err.message ? err.message : err));
    log("UI works; fix TTS: npm run setup");
  }

  const shutdown = () => {
    const pythonProcess = getPythonProcess();
    if (pythonProcess) try { pythonProcess.kill("SIGTERM"); } catch (_) {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
