#!/usr/bin/env bash
set -Eeuo pipefail

# Install the Agent server as a managed Linux service. The script is
# intentionally idempotent and never overwrites an existing environment file.

SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="/opt/ai-jinyiwei/server"
ENV_FILE="/etc/ai-jinyiwei/server.env"
SERVICE_USER="jinyiwei"
INIT_ENV=0
INSTALL_JOURNALD=0

usage() {
  cat <<'EOF'
Usage: sudo bash server/deploy/install-systemd.sh [options]

Options:
  --source DIR          Repository server directory (default: script parent)
  --install-dir DIR    Runtime directory (default: /opt/ai-jinyiwei/server)
  --env-file FILE      Environment file (default: /etc/ai-jinyiwei/server.env)
  --init-env            Create a template env file, then stop for configuration
  --install-journald    Install the example journald retention policy
  -h, --help            Show this help
EOF
}

die() { echo "[ai-jinyiwei] error: $*" >&2; exit 1; }

while (($#)); do
  case "$1" in
    --source) SOURCE_DIR="$(cd -- "$2" && pwd)"; shift 2 ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --init-env) INIT_ENV=1; shift ;;
    --install-journald) INSTALL_JOURNALD=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

[[ "${EUID}" -eq 0 ]] || die "run this installer with sudo"
[[ -f "$SOURCE_DIR/package.json" ]] || die "server source not found: $SOURCE_DIR"
command -v systemctl >/dev/null || die "systemd is required"
command -v node >/dev/null || die "Node.js 22 or newer is required"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 22 )) || die "Node.js 22 or newer is required; found $(node --version)"

if ! getent passwd "$SERVICE_USER" >/dev/null; then
  useradd --system --home-dir "$INSTALL_DIR" --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$INSTALL_DIR" "$INSTALL_DIR/data"
install -d -m 0755 /etc/ai-jinyiwei

for directory in src scripts; do
  [[ -d "$SOURCE_DIR/$directory" ]] || die "missing source directory: $SOURCE_DIR/$directory"
  if command -v rsync >/dev/null; then
    rsync -a --delete "$SOURCE_DIR/$directory/" "$INSTALL_DIR/$directory/"
  else
    install -d "$INSTALL_DIR/$directory"
    cp -a "$SOURCE_DIR/$directory/." "$INSTALL_DIR/$directory/"
  fi
done
for file in package.json package-lock.json; do
  [[ -f "$SOURCE_DIR/$file" ]] && install -m 0644 "$SOURCE_DIR/$file" "$INSTALL_DIR/$file"
done

if [[ ! -f "$ENV_FILE" ]]; then
  if (( INIT_ENV )); then
    [[ -f "$SOURCE_DIR/.env.example" ]] || die "missing $SOURCE_DIR/.env.example"
    install -m 0640 -o root -g "$SERVICE_USER" "$SOURCE_DIR/.env.example" "$ENV_FILE"
    echo "Created $ENV_FILE. Fill in the production secrets and absolute data paths, then rerun without --init-env."
    exit 0
  fi
  die "$ENV_FILE does not exist; run once with --init-env, configure it, then rerun"
fi
chown root:"$SERVICE_USER" "$ENV_FILE"
chmod 0640 "$ENV_FILE"

npm install --omit=dev --ignore-scripts --prefix "$INSTALL_DIR"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$INSTALL_DIR"
chown root:"$SERVICE_USER" "$ENV_FILE"

UNIT_DIR="/etc/systemd/system"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT
for unit in \
  ai-jinyiwei-agent-server.service \
  ai-jinyiwei-agent-backup.service \
  ai-jinyiwei-agent-backup.timer \
  ai-jinyiwei-agent-health.service \
  ai-jinyiwei-agent-health-alert.service \
  ai-jinyiwei-agent-health.timer; do
  source_unit="$SOURCE_DIR/deploy/$unit"
  [[ -f "$source_unit" ]] || die "missing unit template: $source_unit"
  sed -e "s#/opt/ai-jinyiwei/server#$INSTALL_DIR#g" \
      -e "s#/etc/ai-jinyiwei/server.env#$ENV_FILE#g" \
      "$source_unit" > "$TEMP_DIR/$unit"
  install -m 0644 "$TEMP_DIR/$unit" "$UNIT_DIR/$unit"
done

if (( INSTALL_JOURNALD )); then
  install -d -m 0755 /etc/systemd/journald.conf.d
  install -m 0644 "$SOURCE_DIR/deploy/journald-ai-jinyiwei.conf.example" \
    /etc/systemd/journald.conf.d/ai-jinyiwei.conf
  systemctl restart systemd-journald
fi

systemctl daemon-reload
systemctl enable --now ai-jinyiwei-agent-server.service
systemctl enable --now ai-jinyiwei-agent-backup.timer ai-jinyiwei-agent-health.timer
systemctl --no-pager --full status ai-jinyiwei-agent-server.service || true
systemctl --no-pager list-timers ai-jinyiwei-agent-backup.timer ai-jinyiwei-agent-health.timer || true
echo "AI锦衣卫 Agent Server installed. Check logs with: journalctl -u ai-jinyiwei-agent-server -f"
