#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# run.sh  –  start | stop | restart  DataDesk backend + frontend
#
# PostgreSQL must already be running with the metadata DB from database/schema.sql.
# Ports differ from mcp-demo (8000/8081) so both apps can run side by side.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$REPO_DIR/backend"
FRONTEND_DIR="$REPO_DIR/frontend"

LOG_DIR="$REPO_DIR/.logs"
PID_DIR="$REPO_DIR/.pids"
BACKEND_PORT=8001
FRONTEND_PORT=8082

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
die()     { echo -e "${RED}[ERROR]${RESET} $*" >&2; exit 1; }

port_in_use() { lsof -iTCP:"$1" -sTCP:LISTEN -t &>/dev/null; }
pid_alive()   { [[ -n "$1" ]] && kill -0 "$1" 2>/dev/null; }
read_pid()    { [[ -f "$1" ]] && cat "$1" || echo ""; }

stop_service() {
  local name=$1 port=$2 pidfile="$PID_DIR/$1.pid"
  local pids; pids="$(read_pid "$pidfile") $(lsof -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
  local stopped=false
  for p in $pids; do
    if pid_alive "$p"; then kill "$p" 2>/dev/null || true; stopped=true; fi
  done
  rm -f "$pidfile"
  $stopped && success "$name stopped." || warn "$name is not running."
}

start_service() {
  local name=$1 port=$2 dir=$3; shift 3
  if port_in_use "$port"; then
    warn "Port $port already in use — skipping $name."
    return
  fi
  info "Starting $name on port $port…"
  (cd "$dir" && "$@" >> "$LOG_DIR/$name.log" 2>&1) &
  echo $! > "$PID_DIR/$name.pid"
  sleep 3
  pid_alive "$(read_pid "$PID_DIR/$name.pid")" \
    && success "$name started. Logs: $LOG_DIR/$name.log" \
    || die "$name failed to start. Check $LOG_DIR/$name.log"
}

cmd_start() {
  mkdir -p "$LOG_DIR" "$PID_DIR"
  [[ -f "$BACKEND_DIR/.env" ]]  || die "backend/.env missing — copy backend/.env.example and fill it in."
  [[ -f "$FRONTEND_DIR/.env" ]] || warn "frontend/.env missing — API defaults to http://localhost:8001."

  info "Installing dependencies…"
  (cd "$BACKEND_DIR" && poetry install --no-interaction --no-root)
  (cd "$FRONTEND_DIR" && npm install --no-audit --no-fund)

  start_service backend  "$BACKEND_PORT"  "$BACKEND_DIR" \
    poetry run uvicorn app.main:app --host 0.0.0.0 --port "$BACKEND_PORT"
  start_service frontend "$FRONTEND_PORT" "$FRONTEND_DIR" \
    env BROWSER=none npx expo start --web --port "$FRONTEND_PORT"

  echo ""
  echo -e "${BOLD}${GREEN}DataDesk is up!${RESET}"
  echo -e "  Frontend  →  ${CYAN}http://localhost:${FRONTEND_PORT}${RESET}"
  echo -e "  Backend   →  ${CYAN}http://localhost:${BACKEND_PORT}/docs${RESET}"
}

cmd_stop() {
  stop_service frontend "$FRONTEND_PORT"
  stop_service backend  "$BACKEND_PORT"
}

case "${1:-}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_stop; cmd_start ;;
  *) echo -e "Usage: ${BOLD}./run.sh${RESET} <start|stop|restart>"; exit 1 ;;
esac
