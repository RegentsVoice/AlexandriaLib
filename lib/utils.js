const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { ROOT, PYTHON_DIR } = require("./config");

function log(msg) {
  console.log(`[AL] ${msg}`);
}

function pythonEnv(extra = {}) {
  return {
    ...process.env,
    TORCH_HOME: path.join(PYTHON_DIR, ".torch"),
    HF_HOME: path.join(PYTHON_DIR, ".hf"),
    PYTHONUNBUFFERED: "1",
    HF_HUB_DISABLE_SYMLINKS_WARNING: "1",
    HF_HUB_DISABLE_TELEMETRY: "1",
    RUST_LOG: "error",
    HF_XET_LOG_LEVEL: "error",
    ...extra,
  };
}

function run(cmd, opts = {}) {
  const quiet = opts.quiet !== false;
  try {
    return execSync(cmd, {
      stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
      cwd: opts.cwd || ROOT,
      env: pythonEnv(opts.env || {}),
      shell: true,
      encoding: "utf8",
    });
  } catch (e) {
    if (quiet && e.stderr) process.stderr.write(String(e.stderr).slice(-2000));
    throw e;
  }
}

function exists(p) {
  return fs.existsSync(p);
}

function ensureDir(dir) {
  if (!exists(dir)) fs.mkdirSync(dir, { recursive: true });
}

function decodeOriginalName(name) {
  if (!name || typeof name !== "string") return "book";
  try {
    const fixed = Buffer.from(name, "latin1").toString("utf8");
    if (/[А-Яа-яЁё]/.test(fixed) && !/[А-Яа-яЁё]/.test(name)) return fixed;
    if (fixed.includes("\uFFFD")) return name;
    if (/[\u0400-\u04FF]/.test(fixed)) return fixed;
  } catch (_) {}
  return name;
}

module.exports = {
  log,
  pythonEnv,
  run,
  exists,
  ensureDir,
  decodeOriginalName,
};
