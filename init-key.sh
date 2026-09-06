#!/bin/bash
set -u
NODE_BIN="$(command -v node || true)"
[ -x "$NODE_BIN" ] || NODE_BIN="$HOME/.local/node/bin/node"
export PATH="$(dirname "$NODE_BIN"):$PATH"
export PORT="${PORT:-20128}"
"$NODE_BIN" --dns-result-order=ipv4first --max-old-space-size=6144 app/custom-server.js &
SRV=$!
DB="${DATA_DIR:-$HOME/.9router}/db/data.sqlite"
for i in $(seq 1 90); do
  [ -f "$DB" ] && break
  sleep 1
done
sleep 2
"$NODE_BIN" --experimental-sqlite init-key.js || echo "[init-key] falhou ao plantar a key (seguindo sem ela)"

wait $SRV
