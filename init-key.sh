#!/bin/bash
set -u
node --dns-result-order=ipv4first --max-old-space-size=6144 app/custom-server.js &
SRV=$!
DB="${DATA_DIR:-/root/.9router}/db/data.sqlite"
for i in $(seq 1 90); do
  [ -f "$DB" ] && break
  sleep 1
done
sleep 2
node --experimental-sqlite init-key.js || echo "[init-key] falhou ao plantar a key (seguindo sem ela)"
wait $SRV
