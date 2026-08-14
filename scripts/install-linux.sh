#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${ALEXANDRIA_REPO:-https://github.com/RegentsVoice/AlexandriaLib.git}"
REPO_NAME="AlexandriaLib"
MIN_NODE=18

echo ""
echo "  AlexandriaLib installer (Linux)"
echo "  -------------------------------"
echo ""

need_root() {
  if [[ "$(id -u)" -eq 0 ]]; then "$@"
  else sudo "$@"
  fi
}

have() { command -v "$1" >/dev/null 2>&1; }

step() { echo "==> $1"; }
ok()   { echo "    ok: $1"; }

spin_pid=""
spin_start() {
  local msg="$1"
  (
    local i=0
    local frames='|/-\'
    while true; do
      printf "\r    %s %s" "$msg" "${frames:i++%4:1}"
      sleep 0.15
    done
  ) &
  spin_pid=$!
}
spin_stop() {
  if [[ -n "${spin_pid:-}" ]]; then
    kill "$spin_pid" 2>/dev/null || true
    wait "$spin_pid" 2>/dev/null || true
    spin_pid=""
    printf "\r\033[K"
  fi
}
trap 'spin_stop' EXIT

detect_distro() {
  if [[ -f /etc/os-release ]]; then
    . /etc/os-release
    echo "${ID:-unknown}|${ID_LIKE:-}"
  else
    echo "unknown|"
  fi
}

pkg_install() {
  local id like
  IFS='|' read -r id like <<<"$(detect_distro)"
  id="$(echo "$id" | tr '[:upper:]' '[:lower:]')"
  like="$(echo "$like" | tr '[:upper:]' '[:lower:]')"

  if [[ "$id" == "arch" || "$id" == "manjaro" || "$id" == "endeavouros" || "$like" == *arch* ]]; then
    need_root pacman -Sy --needed --noconfirm "$@"
  elif [[ "$id" == "fedora" || "$id" == "rhel" || "$id" == "centos" || "$id" == "rocky" || "$id" == "almalinux" || "$like" == *fedora* || "$like" == *rhel* ]]; then
    need_root dnf install -y "$@"
  elif [[ "$id" == "debian" || "$id" == "ubuntu" || "$id" == "linuxmint" || "$id" == "pop" || "$like" == *debian* || "$like" == *ubuntu* ]]; then
    need_root apt-get update -y -qq
    need_root apt-get install -y -qq "$@"
  else
    return 1
  fi
}

install_git() {
  if have git; then ok "git $(git --version | head -1)"; return 0; fi
  step "Installing git..."
  pkg_install git || { echo "ERROR: install git manually"; exit 1; }
  ok "git installed"
}

install_curl() {
  if have curl || have wget; then return 0; fi
  step "Installing curl..."
  pkg_install curl || true
}

install_nodejs() {
  if have node && have npm; then
    local major
    major="$(node -v | sed 's/^v//' | cut -d. -f1)"
    if [[ "${major:-0}" -ge "$MIN_NODE" ]]; then
      ok "Node $(node -v), npm $(npm -v)"
      return 0
    fi
    step "Node $(node -v) is too old (< $MIN_NODE), upgrading..."
  else
    step "Installing Node.js..."
  fi

  local id like
  IFS='|' read -r id like <<<"$(detect_distro)"
  id="$(echo "$id" | tr '[:upper:]' '[:lower:]')"
  like="$(echo "$like" | tr '[:upper:]' '[:lower:]')"

  if [[ "$id" == "arch" || "$id" == "manjaro" || "$id" == "endeavouros" || "$like" == *arch* ]]; then
    need_root pacman -Sy --needed --noconfirm nodejs npm
  elif [[ "$id" == "fedora" || "$id" == "rhel" || "$id" == "centos" || "$id" == "rocky" || "$id" == "almalinux" || "$like" == *fedora* || "$like" == *rhel* ]]; then
    need_root dnf install -y nodejs npm
  elif [[ "$id" == "debian" || "$id" == "ubuntu" || "$id" == "linuxmint" || "$id" == "pop" || "$like" == *debian* || "$like" == *ubuntu* ]]; then
    need_root apt-get update -y -qq
    need_root apt-get install -y -qq ca-certificates curl gnupg
    need_root mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | need_root gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg 2>/dev/null || true
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" \
      | need_root tee /etc/apt/sources.list.d/nodesource.list >/dev/null
    need_root apt-get update -y -qq
    need_root apt-get install -y -qq nodejs
  else
    echo "ERROR: unsupported distro. Install Node.js >= $MIN_NODE manually."
    exit 1
  fi

  have node || { echo "ERROR: node not found after install"; exit 1; }
  local major
  major="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [[ "${major:-0}" -lt "$MIN_NODE" ]]; then
    echo "ERROR: Node.js >= $MIN_NODE required (found $(node -v))"
    exit 1
  fi
  ok "Node $(node -v)"
}

install_python() {
  local py=""
  for c in python3.12 python3.11 python3.10 python3.9 python3; do
    if have "$c"; then py="$c"; break; fi
  done

  if [[ -n "$py" ]]; then
    if "$py" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
      ok "Python $($py -V 2>&1)"
      if ! "$py" -c 'import venv' 2>/dev/null; then
        step "Installing python3-venv..."
        pkg_install python3-venv python3-pip || pkg_install python3-venv || true
      fi
      return 0
    fi
  fi

  step "Installing Python 3.9+..."
  local id like
  IFS='|' read -r id like <<<"$(detect_distro)"
  id="$(echo "$id" | tr '[:upper:]' '[:lower:]')"
  like="$(echo "$like" | tr '[:upper:]' '[:lower:]')"

  if [[ "$id" == "arch" || "$id" == "manjaro" || "$id" == "endeavouros" || "$like" == *arch* ]]; then
    need_root pacman -Sy --needed --noconfirm python python-pip
  elif [[ "$id" == "fedora" || "$like" == *fedora* || "$like" == *rhel* ]]; then
    need_root dnf install -y python3 python3-pip python3-venv
  elif [[ "$id" == "debian" || "$id" == "ubuntu" || "$like" == *debian* || "$like" == *ubuntu* ]]; then
    need_root apt-get update -y -qq
    need_root apt-get install -y -qq python3 python3-pip python3-venv
  else
    echo "ERROR: install Python 3.9+ manually"
    exit 1
  fi

  have python3 || { echo "ERROR: python3 not found"; exit 1; }
  python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' \
    || { echo "ERROR: Python >= 3.9 required"; exit 1; }
  ok "Python $(python3 -V 2>&1)"
}

SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"
if [[ -f package.json ]] && grep -q '"name": "alexandria-lib"' package.json 2>/dev/null; then
  ROOT="$(pwd)"
  step "Using current directory"
elif [[ -f "$(dirname "$SCRIPT_PATH")/../package.json" ]]; then
  ROOT="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)"
  step "Using repo next to script"
else
  install_curl
  install_git
  install_nodejs
  install_python
  TARGET="${ALEXANDRIA_DIR:-$HOME/$REPO_NAME}"
  if [[ -d "$TARGET/.git" ]]; then
    step "Updating $TARGET"
    spin_start "git pull"
    git -C "$TARGET" pull --ff-only >/dev/null 2>&1 || true
    spin_stop
    ok "updated"
  else
    step "Cloning repository → $TARGET"
    spin_start "git clone"
    git clone --depth 1 "$REPO_URL" "$TARGET" >/dev/null
    spin_stop
    ok "cloned"
  fi
  ROOT="$TARGET"
fi

cd "$ROOT"
ok "project: $ROOT"

install_curl
install_git
install_nodejs
install_python

step "npm install (Node packages)..."
spin_start "npm working"
npm install --no-fund --no-audit >/tmp/al-npm.log 2>&1 || {
  spin_stop
  echo "ERROR: npm install failed"
  tail -30 /tmp/al-npm.log || true
  exit 1
}
spin_stop
ok "npm packages"

step "Python venv + pip + TTS models..."
echo "    (torch / Silero — first time can take several minutes)"
spin_start "downloading models"
if npm run setup >/tmp/al-setup.log 2>&1; then
  spin_stop
  ok "python + models"
else
  spin_stop
  echo "ERROR: setup failed — last lines:"
  tail -40 /tmp/al-setup.log || true
  exit 1
fi

step "Installing hf_xet for faster model downloads..."
spin_start "pip install hf_xet"
"$ROOT/python/.venv/bin/pip" install hf_xet >/tmp/al-hfxet.log 2>&1 || true
spin_stop
ok "hf_xet installed (if available)"

echo ""
echo "  -------------------------------"
echo "  Installation complete"
echo "  Path:   $ROOT"
echo "  Start:  cd \"$ROOT\" && npm start"
echo "  Open:   http://localhost:3000"
echo "  -------------------------------"
echo ""
