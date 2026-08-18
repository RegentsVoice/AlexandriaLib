const { spawn, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const {
  PYTHON_DIR,
  VENV_DIR,
  REQUIREMENTS,
  TTS_SCRIPT,
  SETUP_MARKER,
  isWindows,
  pythonBin,
} = require("./config");
const { log, pythonEnv, run, exists } = require("./utils");

function findSystemPython() {
  const candidates = isWindows ? ["python", "py", "python3"] : ["python3", "python"];
  for (const cmd of candidates) {
    try {
      execSync(cmd + " --version", { stdio: "ignore", shell: true });
      return cmd;
    } catch (_) {}
  }
  throw new Error(
    "Не найден Python. Установите Python 3.10+ и убедитесь, что он в PATH " +
      "(на Windows при установке отметьте «Add python.exe to PATH»)."
  );
}

function ensureVenv() {
  if (exists(pythonBin)) {
    log("venv exists");
    return;
  }
  log("creating venv...");
  const sysPython = findSystemPython();
  log("system python: " + sysPython);
  run('"' + sysPython + '" -m venv "' + VENV_DIR + '"');
  log("venv created");
}

function installPythonDeps() {
  const pipCmd = '"' + pythonBin + '" -m pip';
  try {
    log("upgrading pip...");
    run(pipCmd + " install -q --upgrade pip");
  } catch (_) {}
  log("installing pip packages (torch may take a while)...");
  run(pipCmd + ' install -r "' + REQUIREMENTS + '"', { quiet: false });
  log("pip packages ok");
}

function predownloadModels() {
  log("downloading TTS models (RUAccent + Silero)...");
  const preloadCode = `
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import hf_compat
import torch
from ruaccent import RUAccent
print("RUAccent...", flush=True)
a = RUAccent()
a.load(omograph_model_size="turbo3.1", use_dictionary=True, device="CPU")
print("RUAccent ok", flush=True)
print("Silero TTS...", flush=True)
torch.hub.load(repo_or_dir="snakers4/silero-models", model="silero_tts",
  language="ru", speaker="v5_5_ru", trust_repo=True)
print("Silero ok", flush=True)
`;
  const tmpFile = path.join(PYTHON_DIR, "_preload.py");
  fs.writeFileSync(tmpFile, preloadCode, "utf8");
  try {
    run('"' + pythonBin + '" "' + tmpFile + '"', { quiet: false });
    log("TTS models ok");
  } finally {
    if (exists(tmpFile)) fs.unlinkSync(tmpFile);
  }
}

function needsSetup() {
  if (!exists(pythonBin)) return true;
  if (!exists(SETUP_MARKER)) return true;
  try {
    const marker = fs.readFileSync(SETUP_MARKER, "utf8").trim();
    const req = fs.readFileSync(REQUIREMENTS, "utf8");
    const hash = crypto.createHash("sha1").update(req).digest("hex").slice(0, 12);
    return marker !== hash;
  } catch {
    return true;
  }
}

function writeSetupMarker() {
  const req = fs.readFileSync(REQUIREMENTS, "utf8");
  const hash = crypto.createHash("sha1").update(req).digest("hex").slice(0, 12);
  fs.writeFileSync(SETUP_MARKER, hash, "utf8");
}

let pythonProcess = null;
let ttsReady = false;

function startPythonServer() {
  return new Promise((resolve, reject) => {
    if (!exists(pythonBin)) {
      const msg = "Python venv not found. Run: npm run setup";
      log(msg);
      reject(new Error(msg));
      return;
    }
    if (!exists(TTS_SCRIPT)) {
      const msg = "tts_server.py missing";
      log(msg);
      reject(new Error(msg));
      return;
    }

    log("TTS loading (1–3 min on first start)...");
    log("python: " + pythonBin);

    let logBuf = "";
    pythonProcess = spawn(pythonBin, [TTS_SCRIPT], {
      cwd: PYTHON_DIR,
      env: pythonEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let ready = false;
    const heartbeat = setInterval(() => {
      if (!ready) log("TTS still loading...");
    }, 15000);

    const finish = () => {
      if (ready) return;
      ready = true;
      ttsReady = true;
      clearInterval(heartbeat);
      log("TTS ready");
      resolve();
    };

    const onData = (data) => {
      const text = data.toString();
      logBuf += text;
      if (logBuf.length > 12000) logBuf = logBuf.slice(-8000);
      if (/\r|%\|█|Downloading|Fetching|Fetching [0-9]|Loading/.test(text)) {
        process.stdout.write(text);
      }
      for (const line of text.split(/\r?\n/)) {
        const s = line.trim();
        if (!s) continue;
        if (/^(AL:|TTS |RUAccent|Uvicorn|Application startup|Silero)/i.test(s)) {
          log(s.replace(/^AL:\s*/i, "").trim());
        } else if (/error|exception|traceback|modulenotfound|failed/i.test(s)) {
          log(s);
        }
      }
      if (
        text.includes("Uvicorn running") ||
        text.includes("Application startup complete") ||
        text.includes("TTS server listening")
      ) {
        finish();
      }
    };

    pythonProcess.stdout.on("data", onData);
    pythonProcess.stderr.on("data", onData);
    pythonProcess.on("error", (err) => {
      clearInterval(heartbeat);
      log("TTS start failed: " + err.message);
      reject(err);
    });
    pythonProcess.on("exit", (code) => {
      clearInterval(heartbeat);
      pythonProcess = null;
      ttsReady = false;
      if (!ready) {
        log("TTS exited with code " + code);
        const tail = logBuf.trim().split(/\r?\n/).slice(-25).join("\n");
        if (tail) log("TTS log:\n" + tail);
        reject(new Error("TTS exited " + code));
      }
    });
    setTimeout(() => {
      if (!ready) {
        log("TTS slow — UI is up, voice may lag");
        finish();
      }
    }, 300000);
  });
}

function getTtsReady() {
  return ttsReady;
}

function getPythonProcess() {
  return pythonProcess;
}

module.exports = {
  findSystemPython,
  ensureVenv,
  installPythonDeps,
  predownloadModels,
  needsSetup,
  writeSetupMarker,
  startPythonServer,
  getTtsReady,
  getPythonProcess,
};
