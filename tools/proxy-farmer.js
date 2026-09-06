// Proxy Farmer: colhe proxies públicos grátis, testa, e mantém o Proxy Pools
// do 9router sempre com N proxies vivos. Pools gerenciados usam o prefixo
// "auto-" — tudo que não for "auto-" (Webshare, relays) é intocável.
//
// Uso:
//   node tools/proxy-farmer.js --once     # um ciclo e sai
//   node tools/proxy-farmer.js            # loop contínuo (FARM_INTERVAL_MIN)
//
// Env:
//   ROUTER_URL          default http://127.0.0.1:20128
//   ROUTER_PASSWORD     senha do painel (login para a API)
//   FARM_SOURCES        URLs de listas, separadas por vírgula
//   FARM_POOL_SIZE      alvo de proxies vivos no pool (default 12)
//   FARM_INTERVAL_MIN   intervalo entre ciclos no modo loop (default 30)
//   FARM_TIMEOUT_MS     timeout de teste por proxy (default 9000)
//   FARM_TEST_URL       URL de eco usada no teste (default https://ipv4.webshare.io/)
//   FARM_STATE_FILE     arquivo de estado (default <DATA_DIR>/proxy-farmer.json)

const { execFile } = require("child_process");
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
const WAVE = Number(process.env.FARM_WAVE || 300);
const INTERVAL_MIN = Number(process.env.FARM_INTERVAL_MIN || 30);
const TIMEOUT_MS = Number(process.env.FARM_TIMEOUT_MS || 9000);
const TEST_URL = process.env.FARM_TEST_URL || "https://ipv4.webshare.io/";
const PREFIX = "auto-";
const ONCE = process.argv.includes("--once");

const state = { dead: {}, stats: { cycles: 0, created: 0, removed: 0 } };
try { Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))); } catch {}
const saveState = () => { try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1)); } catch {} };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const curl = (args, timeout) => new Promise(resolve => {
  execFile("curl", ["-s", "-m", String(Math.ceil(timeout / 1000)), ...args], { timeout: timeout + 2000, maxBuffer: 8e6 },
    (err, stdout) => resolve({ ok: !err, body: stdout || "" }));
});

let cookie = "";
async function api(method, apiPath, body) {
  const res = await fetch(ROUTER_URL + apiPath, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.getSetCookie?.() || [];
  for (const c of set) { const kv = c.split(";")[0]; if (!cookie.includes(kv.split("=")[0] + "=")) cookie += (cookie ? "; " : "") + kv; }
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

async function testProxy(proxyUrl) {
  const { body } = await curl(["-x", proxyUrl, TEST_URL.replace(/^https:/, "https:")], TIMEOUT_MS);
  const ip = body.trim();
  return /^\d{1,3}(\.\d{1,3}){3}/.test(ip) ? ip : null;
}

// o teste do proprio router e a autoridade: atualiza testStatus/isActive no painel
async function routerTest(poolId) {
  const res = await api("POST", `/api/proxy-pools/${poolId}/test`);
  return { ok: !!(res.json && res.json.ok), elapsed: (res.json && res.json.elapsedMs) || 0 };
}

async function harvest() {
  const found = new Set();
  for (const src of SOURCES) {
    const { body } = await curl([src], 20000);
    for (const line of body.split("\n")) {
      const px = line.trim();
      if (/^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(px)) found.add("http://" + px);
    }
  }
  return [...found];
}

async function cycle() {
  state.stats.cycles++;
  const login = await api("POST", "/api/auth/login", { password: ROUTER_PASSWORD });
  if (login.json?.success === false) { console.log("[farmer] login falhou:", login.json?.error || login.status); return; }

  const list = await api("GET", "/api/proxy-pools");
  const pools = (list.json && (list.json.proxyPools || list.json.pools || list.json.data)) || list.json || [];
  const all = Array.isArray(pools) ? pools : [];
  const mine = all.filter(p => typeof p.name === "string" && p.name.startsWith(PREFIX));
  console.log(`[farmer] ciclo ${state.stats.cycles}: ${all.length} pools no router, ${mine.length} sao meus (auto-)`);

  // testa os meus PELO ROUTER (autoridade) — falhou nele, fora
  let vivos = [];
  for (const pool of mine) {
    const res = await routerTest(pool.id);
    if (res.ok) vivos.push(pool);
    else {
      await api("DELETE", "/api/proxy-pools/" + pool.id);
      state.dead[pool.proxyUrl] = Date.now();
      state.stats.removed++;
      console.log(`  [remove] reprovou no router: ${pool.proxyUrl}`);
    }
  }

  // repor ate o alvo
  const emFalta = POOL_SIZE - vivos.length;
  if (emFalta > 0) {
    const emPool = new Set(vivos.map(p => p.proxyUrl));
    const DEAD_RETRY_MS = 24 * 3600 * 1000;
    const candidatos = (await harvest()).filter(px =>
      !emPool.has(px) && !(state.dead[px] && Date.now() - state.dead[px] < DEAD_RETRY_MS));
    console.log(`[farmer] faltam ${emFalta}; colhidos ${candidatos.length} candidatos`);
    let criados = 0;
    const wave = candidatos.slice(0, WAVE);
    const testados = [];
    let emVoo = 0;
    await Promise.all(wave.map(px => new Promise(async resolve => {
      while (emVoo >= 40) await sleep(100);
      emVoo++;
      const ip = await testProxy(px);
      emVoo--;
      if (ip) testados.push({ px, ip });
      else state.dead[px] = Date.now();
      resolve();
    })));
    for (const { px } of testados) {
      if (criados >= emFalta) break;
      const create = await api("POST", "/api/proxy-pools", { name: PREFIX + px.replace(/^https?:\/\//, ""), proxyUrl: px, isActive: true });
      if (create.status >= 300) continue;
      const newId = (create.json && (create.json.pool?.id || create.json.id)) || null;
      const rt = newId ? await routerTest(newId) : { ok: false };
      if (rt.ok) {
        criados++; state.stats.created++; vivos.push({ proxyUrl: px });
        console.log(`  [adiciona] ${px} (verificado pelo router em ${rt.elapsed}ms)`);
      } else {
        if (newId) await api("DELETE", "/api/proxy-pools/" + newId);
        state.dead[px] = Date.now();
        console.log(`  [descarta] reprovou no teste do router: ${px}`);
      }
    }
    for (const { px } of wave) if (!testados.find(t => t.px === px)) state.dead[px] = state.dead[px] || (Date.now() - DEAD_RETRY_MS * 2);
  }

  // Rotation Strategy = random em TODOS os providers, sempre
  const st = await api("GET", "/api/settings");
  const settings = st.json || {};
  const strategies = { ...(settings.providerStrategies || {}) };
  let mudou = false;
  for (const alias of Object.keys(strategies)) {
    if (strategies[alias].rotateStrategy !== "random") { strategies[alias].rotateStrategy = "random"; mudou = true; }
  }
  if (mudou) {
    await api("PATCH", "/api/settings", { providerStrategies: strategies });
    console.log("[farmer] rotateStrategy=random aplicado em:", Object.keys(strategies).join(", "));
  }
  if (vivos.length) {
    const alvo = mine.find(p => vivos.some(v => v.id === p.id));
    const ref = alvo || vivos[0];
    const aliasPadrao = process.env.FARM_PROVIDER_ALIAS;
    if (aliasPadrao) {
      strategies[aliasPadrao] = { ...(strategies[aliasPadrao] || {}), proxyPoolId: (alvo || vivos.find(v => v.id) || {}).id || ref.id, rotateStrategy: "random" };
      await api("PATCH", "/api/settings", { providerStrategies: strategies });
      console.log(`[farmer] provider '${aliasPadrao}' -> pool ${ref.id} (random)`);
    }
  }

  saveState();
  console.log(`[farmer] fim do ciclo: ${vivos.length} vivos | criados acum: ${state.stats.created} | removidos acum: ${state.stats.removed}`);
}

(async () => {
  if (ONCE) { await cycle(); process.exit(0); }
  for (;;) {
    try { await cycle(); } catch (e) { console.log("[farmer] erro no ciclo:", e.message); saveState(); }
    await sleep(INTERVAL_MIN * 60 * 1000);
  }
})();
