#!/usr/bin/env bash
set -euo pipefail

repo=nick1udwig/pebble-agent
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) target=linux-amd64 ;;
  Linux/i?86) target=linux-386 ;;
  Linux/aarch64|Linux/arm64) target=linux-arm64 ;;
  Linux/armv7l|Linux/armv8l) target=linux-arm ;;
  Darwin/arm64) target=darwin-arm64 ;;
  *) echo 'Unsupported system. Build from source: go build ./cmd/pebble-agent-server' >&2; exit 1 ;;
esac
command -v curl >/dev/null || { echo 'curl is required.' >&2; exit 1; }
base="https://github.com/$repo/releases/latest/download"
if [[ -n ${PEBBLE_AGENT_VERSION:-} ]]; then
  base="https://github.com/$repo/releases/download/$PEBBLE_AGENT_VERSION"
fi
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
asset="pebble-agent-server-$target"
curl -fLsS --retry 3 "$base/$asset" -o "$work/$asset"
curl -fLsS --retry 3 "$base/SHA256SUMS" -o "$work/SHA256SUMS"
expected=$(awk -v name="$asset" '$2 == name {print $1}' "$work/SHA256SUMS")
if command -v sha256sum >/dev/null; then
  actual=$(sha256sum "$work/$asset"); actual=${actual%% *}
else
  actual=$(shasum -a 256 "$work/$asset"); actual=${actual%% *}
fi
[[ $expected =~ ^[0-9a-f]{64}$ && $actual == "$expected" ]] || { echo 'Checksum verification failed.' >&2; exit 1; }
bin="$HOME/.local/bin/pebble-agent-server"
mkdir -p "${bin%/*}"
install -m 755 "$work/$asset" "$bin.new"
mv -f "$bin.new" "$bin"
printf 'Installed %s\n' "$bin"
manual() {
  printf '\nInstall and sign in to the Codex CLI first, then run:\n  export PEBBLE_AGENT_TOKEN="replace-with-a-long-random-secret"\n  %q --listen 127.0.0.1:8787\n' "$bin"
  echo 'Connect the phone through an HTTPS reverse proxy/VPN, or use --listen 0.0.0.0:8787 on a trusted private network.'
  echo 'Enter the reachable /v1/agent URL and the same token in the Pebble app settings.'
}
if [[ $target != linux-* ]] || ! command -v systemctl >/dev/null || ! systemctl --user show-environment >/dev/null 2>&1; then
  echo 'A systemd user manager is unavailable.'
  manual
  exit 0
fi
answer=n
if { exec 3<>/dev/tty; } 2>/dev/null; then
  printf 'Install and start a systemd user service (no sudo)? [y/N] ' >&3
  read -r answer <&3 || answer=n
  exec 3>&-
fi
case "$answer" in y|Y|yes|YES) ;; *) manual; exit 0 ;; esac
if ! command -v codex >/dev/null; then
  echo 'Codex CLI is missing; install it and sign in, then rerun this installer.'
  manual
  exit 0
fi
config="${XDG_CONFIG_HOME:-$HOME/.config}"
mkdir -p "$config/pebble-agent" "$config/systemd/user"
umask 077
if [[ ! -e $config/pebble-agent/environment ]]; then
  token=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
  printf 'PEBBLE_AGENT_TOKEN=%s\n' "$token" > "$config/pebble-agent/environment"
fi
# Escape systemd quoted strings and literal specifiers.
unit_quote() { local s=$1; s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//%/%%}; printf '%s' "$s"; }
cat > "$config/systemd/user/pebble-agent.service" <<UNIT
[Unit]
Description=Pebble Agent service
After=network.target

[Service]
ExecStart="$(unit_quote "$bin")" --listen 127.0.0.1:8787
Environment="PATH=$(unit_quote "$PATH")"
EnvironmentFile="$(unit_quote "$config/pebble-agent/environment")"
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT
if systemctl --user daemon-reload && systemctl --user enable pebble-agent.service && systemctl --user restart pebble-agent.service; then
  echo 'User service enabled. It runs while your user manager is active (normally after login).'
  printf 'Token file: %s\n' "$config/pebble-agent/environment"
  echo 'Listener: 127.0.0.1:8787. Use an HTTPS reverse proxy/VPN to reach it from your phone.'
  echo 'Status: systemctl --user status pebble-agent.service'
  echo 'Logs: journalctl --user -u pebble-agent.service'
else
  echo 'Could not start the user service. Check: journalctl --user -u pebble-agent.service' >&2
  manual
  exit 1
fi
