// Proxy Farmer: mantem o Proxy Pools do 9router sempre cheio de proxies
// publicos vivos. Vigilancia continua: a cada FARM_WATCH_SEC testa todos os
// pools "auto-" pelo teste do proprio router; quem falha e deletado na hora
// e reposto imediatamente. Pools sem o prefixo "auto-" sao intocaveis.
//
// Uso:
//   node tools/proxy-farmer.js --once     # um ciclo de vigilancia e sai
//   node tools/proxy-farmer.js            # vigilancia continua (default)
//
// Env:
//   ROUTER_URL          default http://127.0.0.1:20128
//   ROUTER_PASSWORD     senha do painel (login para a API)
//   FARM_POOL_SIZE      alvo de proxies vivos (default 12)
//   FARM_WATCH_SEC      intervalo da vigilancia (default 60)
//   FARM_SOURCES        URLs de listas publicas, separadas por virgula
//   FARM_WAVE           candidatos testados por rodada de reposicao (default 400)
//   FARM_TIMEOUT_MS     timeout por teste (default 9000)
//   FARM_TEST_URL       alvo do teste (default https://ipv4.webshare.io/)
//   FARM_STATE_FILE     estado (default <DATA_DIR>/proxy-farmer.json)

const net = require("net");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROUTER_URL = (process.env.ROUTER_URL || "http://127.0.0.1:20128").replace(/\/$/, "");
const ROUTER_PASSWORD = process.env.ROUTER_PASSWORD || "123456";
const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), ".9router");
const STATE_FILE = process.env.FARM_STATE_FILE || path.join(DATA_DIR, "proxy-farmer.json");
const SOURCES = (process.env.FARM_SOURCES ||
  "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt," +
  "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000&country=all," +
  "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt," +
  "https://raw.githubusercontent.com/zloi-user/hideip.me/main/http.txt"
).split(",").map(s => s.trim()).filter(Boolean);
const POOL_SIZE = Number(process.env.FARM_POOL_SIZE || 12);
const WATCH_SEC = Number(process.env.FARM_WATCH_SEC || 60);
const WAVE = Number(process.env.FARM_WAVE || 400);
const TIMEOUT_MS = Number(process.env.FARM_TIMEOUT_MS || 9000);
const TEST_URL = process.env.FARM_TEST_URL || "https://ipv4.webshare.io/";
const PREFIX = "auto-";
const ONCE = process.argv.includes("--once");
const DEAD_RETRY_MS = 24 * 3600 * 1000;

const state = { dead: {}, stats: { cycles: 0, created: 0, removed: 0 } };
try { Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))); } catch {}
const saveState = () => { try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1)); } catch {} };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const target = new URL(TEST_URL);

// teste de proxy sem curl: CONNECT no alvo e ve se responde 200
function testProxyConnect(proxyUrl, timeoutMs) {
  return new Promise(resolve => {
    let m;
    try { m = new URL(proxyUrl); } catch { return resolve(null); }
    const port = Number(m.port) || (m.protocol === "https:" ? 443 : 80);
    const socket = net.connect(port, m.hostname);
    let done = false;
    const finish = r => { if (!done) { done = true; socket.destroy(); resolve(r); } };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => socket.write(`CONNECT ${target.hostname}:${target.port || 443} HTTP/1.1\r\nHost: ${target.hostname}:${target.port || 443}\r\n\r\n`));
    socket.on("data", buf => finish(/^HTTP\/1\.[01] 200/.test(buf.toString("latin1")) ? "ok" : null));
    socket.on("error", () => finish(null));
    socket.on("timeout", () => finish(null));
    socket.on("close", () => finish(null));
  });
}
const testProxy = proxyUrl => Promise.race([
  testProxyConnect(proxyUrl, TIMEOUT_MS),
  sleep(TIMEOUT_MS + 1500).then(() => null),
]);

let cookie = "";
async function api(method, apiPath, body) {
  const res = await fetch(ROUTER_URL + apiPath, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  for (const c of res.headers.getSetCookie?.() || []) {
    const kv = c.split(";")[0];
    if (!cookie.includes(kv.split("=")[0] + "=")) cookie += (cookie ? "; " : "") + kv;
  }
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

// o teste do proprio router e a autoridade (atualiza testStatus/isActive no painel)
async function routerTest(poolId) {
  const res = await api("POST", `/api/proxy-pools/${poolId}/test`);
  return { ok: !!(res.json && res.json.ok), elapsed: (res.json && res.json.elapsedMs) || 0 };
}

let harvestCache = { at: 0, list: [] };
async function harvestCandidates(emPool) {
  if (Date.now() - harvestCache.at < 30 * 60 * 1000 && harvestCache.list.length > POOL_SIZE * 4) {
    return harvestCache.list.filter(px => !emPool.has(px) && !(state.dead[px] && Date.now() - state.dead[px] < DEAD_RETRY_MS));
  }
  const found = new Set();
  for (const src of SOURCES) {
    try {
      const res = await fetch(src, { signal: AbortSignal.timeout(20000) });
      const body = await res.text();
      for (const line of body.split("\n")) {
        const px = line.trim();
        if (/^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(px)) found.add("http://" + px);
      }
    } catch {}
  }
  harvestCache = { at: Date.now(), list: [...found] };
  return harvestCache.list.filter(px => !emPool.has(px) && !(state.dead[px] && Date.now() - state.dead[px] < DEAD_RETRY_MS));
}

// onda de testes com worker-pool: impossivel travar o ciclo
async function testWave(candidates) {
  const passers = [];
  let idx = 0;
  const worker = async () => {
    while (idx < candidates.length) {
      const px = candidates[idx++];
      const ip = await Promise.race([testProxy(px), sleep(TIMEOUT_MS + 1500).then(() => null)]);
      if (ip) passers.push(px);
      else state.dead[px] = Date.now();
    }
  };
  await Promise.all(Array.from({ length: 40 }, worker));
  return passers;
}

let cycles = 0;
async function guardCycle() {
  cycles++;
  const login = await api("POST", "/api/auth/login", { password: ROUTER_PASSWORD });
  if (login.json?.success === false) { console.log(`[farmer ${cycles}] login falhou:`, login.json?.error || login.status); return; }

  const list = await api("GET", "/api/proxy-pools");
  const all = (list.json && (list.json.proxyPools || list.json.pools || list.json.data)) || [];
  const mine = all.filter(p => typeof p.name === "string" && p.name.startsWith(PREFIX));

  // 1) router-testa todos os meus em paralelo (10 por vez); falhou, deleta JÁ
  let vivos = 0;
  let idx = 0;
  const mortos = [];
  const checker = async () => {
    while (idx < mine.length) {
      const pool = mine[idx++];
      const res = await routerTest(pool.id);
      if (res.ok) vivos++;
      else mortos.push(pool);
    }
  };
  await Promise.all(Array.from({ length: 10 }, checker));
  for (const pool of mortos) {
    await api("DELETE", "/api/proxy-pools/" + pool.id);
    state.dead[pool.proxyUrl] = Date.now();
    state.stats.removed++;
  }

  // 2) reposicao imediata se ficou abaixo do alvo
  let need = POOL_SIZE - vivos;
  let criados = 0;
  if (need > 0) {
    const emPool = new Set(mine.map(p => p.proxyUrl));
    const candidatos = await harvestCandidates(emPool);
    console.log(`[farmer ${cycles}] ${vivos} vivos, faltam ${need}; ${candidatos.length} candidatos`);
    const passers = await testWave(candidatos.slice(0, WAVE));
    for (const px of passers) {
      if (need <= 0) break;
      const create = await api("POST", "/api/proxy-pools", { name: PREFIX + px.replace(/^https?:\/\//, ""), proxyUrl: px, isActive: true });
      if (create.status >= 300) continue;
      const newId = (create.json && (create.json.pool?.id || create.json.id)) || null;
      const rt = newId ? await routerTest(newId) : { ok: false };
      if (rt.ok) { criados++; need--; vivos++; state.stats.created++; console.log(`  [adiciona] ${px} (verificado em ${rt.elapsed}ms)`); }
      else {
        if (newId) await api("DELETE", "/api/proxy-pools/" + newId);
        state.dead[px] = Date.now();
      }
    }
  }

  // 3) Rotation Strategy = random em todos os providers, sempre
  const st = await api("GET", "/api/settings");
  const settings = st.json || {};
  const strategies = { ...(settings.providerStrategies || {}) };
  let mudou = false;
  for (const alias of Object.keys(strategies)) {
    if (strategies[alias].rotateStrategy !== "random") { strategies[alias].rotateStrategy = "random"; mudou = true; }
  }
  if (mudou) {
    await api("PATCH", "/api/settings", { providerStrategies: strategies });
    console.log(`[farmer ${cycles}] rotateStrategy=random aplicado em:`, Object.keys(strategies).join(", "));
  }

  saveState();
  console.log(`[farmer ${cycles}] fim: ${vivos} vivos (+${criados} novos, -${mortos.length} mortos) | criados: ${state.stats.created} | removidos: ${state.stats.removed}`);
}

(async () => {
  if (ONCE) { await guardCycle(); process.exit(0); }
  for (;;) {
    const t0 = Date.now();
    try { await guardCycle(); } catch (e) { console.log(`[farmer] erro no ciclo:`, e.message); saveState(); }
    const decorrido = Date.now() - t0;
    await sleep(Math.max(2000, WATCH_SEC * 1000 - decorrido));
  }
})();
