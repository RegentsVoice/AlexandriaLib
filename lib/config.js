const path = require("path");

const ROOT = path.join(__dirname, "..");
const PYTHON_DIR = path.join(ROOT, "python");
const VENV_DIR = path.join(PYTHON_DIR, ".venv");
const REQUIREMENTS = path.join(PYTHON_DIR, "requirements.txt");
const TTS_SCRIPT = path.join(PYTHON_DIR, "tts_server.py");
const PUBLIC_DIR = path.join(ROOT, "public");
const BOOKS_DIR = path.join(ROOT, "books");
const SETUP_MARKER = path.join(PYTHON_DIR, ".setup-ok");
const DATA_DIR = path.join(ROOT, "data");

const PYTHON_PORT = 8765;
const NODE_PORT = process.env.PORT || 8766;

const isWindows = process.platform === "win32";
const pythonBin = isWindows
  ? path.join(VENV_DIR, "Scripts", "python.exe")
  : path.join(VENV_DIR, "bin", "python");
const pipBin = isWindows
  ? path.join(VENV_DIR, "Scripts", "pip.exe")
  : path.join(VENV_DIR, "bin", "pip");

module.exports = {
  ROOT,
  PYTHON_DIR,
  VENV_DIR,
  REQUIREMENTS,
  TTS_SCRIPT,
  PUBLIC_DIR,
  BOOKS_DIR,
  SETUP_MARKER,
  DATA_DIR,
  PYTHON_PORT,
  NODE_PORT,
  isWindows,
  pythonBin,
  pipBin,
};
