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
  "https://gist.githubusercontent.com/Panhard-Dev/f4d5df48748c6be6d66d6794107908f4/raw," +
  "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt," +
  "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000&country=all," +
  "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt," +
  "https://raw.githubusercontent.com/zloi-user/hideip.me/main/http.txt"
).split(",").map(s => s.trim()).filter(Boolean);
const POOL_SIZE = Number(process.env.FARM_POOL_SIZE || 50);  // padrao fixo: 50
const WATCH_SEC = Number(process.env.FARM_WATCH_SEC || 60);
const WAVE = Number(process.env.FARM_WAVE || 400);
const TIMEOUT_MS = Number(process.env.FARM_TIMEOUT_MS || 9000);
const TEST_URL = process.env.FARM_TEST_URL || "https://ipv4.webshare.io/";
const PREFIX = "auto-";
const ONCE = process.argv.includes("--once");
const DEAD_RETRY_MS = 24 * 3600 * 1000;
const BURNED_RETRY_MS = 5 * 3600 * 1000;  // IP queimado pro opencode volta no ciclo de ~5h
const CANARY_MODEL = process.env.FARM_CANARY_MODEL || "oc/muse-spark-1.3-contributor-free(xhigh)";
// a API key do render NAO vai no codigo (repo publico): seta so ela no env do deploy
const REDEPLOY_KEY = process.env.FARM_REDEPLOY_KEY || "";
const REDEPLOY_SERVICE = process.env.FARM_REDEPLOY_SERVICE || "srv-daee451t0dsc739s5tf0";
const GIST_ID = process.env.FARM_GIST_ID || "f4d5df48748c6be6d66d6794107908f4";

const state = { dead: {}, burned: {}, stats: { cycles: 0, created: 0, removed: 0, redeploys: 0 } };
let lastRedeploy = 0;
let burnsSeguidos = 0;
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
    socket.on("connect", () => {
      let req = `CONNECT ${target.hostname}:${target.port || 443} HTTP/1.1\r\nHost: ${target.hostname}:${target.port || 443}\r\n`;
      if (m.username) req += `Proxy-Authorization: Basic ${Buffer.from(decodeURIComponent(m.username) + ":" + decodeURIComponent(m.password)).toString("base64")}\r\n`;
      socket.write(req + "\r\n");
    });
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
  // fontes que ja sao proxies diretos (ip:porta ou http://ip:porta) entram como candidatos
  const diretos = SOURCES.filter(s => /^https?:\/\/\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(s));
  if (Date.now() - harvestCache.at < 30 * 60 * 1000 && harvestCache.list.length > POOL_SIZE * 4) {
    return [...diretos, ...harvestCache.list].filter(px => !emPool.has(px) && !(state.dead[px] && Date.now() - state.dead[px] < DEAD_RETRY_MS) &&
      !(state.burned[px] && Date.now() - state.burned[px] < BURNED_RETRY_MS));
  }
  const found = new Set(diretos);
  for (const src of SOURCES) {
    if (diretos.includes(src)) continue;
    try {
      const res = await fetch(src, { signal: AbortSignal.timeout(20000) });
      const body = await res.text();
      let n = 0;
      for (const line of body.split("\n")) {
        const px = line.trim();
        if (/^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(px)) { found.add("http://" + px); n++; }
      }
      console.log(`[farmer] fonte ${src.split("/")[2]}: +${n}`);
    } catch (e) { console.log(`[farmer] fonte ${src.split("/")[2]} FALHOU: ${e.message}`); }
  }
  harvestCache = { at: Date.now(), list: [...found] };
  return harvestCache.list.filter(px => !emPool.has(px) && !(state.dead[px] && Date.now() - state.dead[px] < DEAD_RETRY_MS) &&
      !(state.burned[px] && Date.now() - state.burned[px] < BURNED_RETRY_MS));
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

  // canario: o opencode ta recusando (FreeUsageLimitError)? a SESSAO queimou.
  // no render a sessao nasce no boot -> redeploy = sessao nova = cota nova.
  const canary = await api("POST", "/v1/chat/completions", { model: CANARY_MODEL, stream: false, max_tokens: 16,
    messages: [{ role: "user", content: "ok" }] });
  const msg = JSON.stringify(canary.json || {});
  const queimado = msg.includes("FreeUsageLimitError");
  if (queimado) {
    burnsSeguidos++;
    console.log(`[farmer ${cycles}] CANARIO 429 (${burnsSeguidos} seguidos) - sessao queimada`);
    if (REDEPLOY_KEY && REDEPLOY_SERVICE && burnsSeguidos >= 2 && Date.now() - lastRedeploy > 10 * 60 * 1000) {
      const res = await fetch(`https://api.render.com/v1/services/${REDEPLOY_SERVICE}/deploys`, {
        method: "POST",
        headers: { "authorization": `Bearer ${REDEPLOY_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ clearCache: "do_not_clear" }),
      });
      lastRedeploy = Date.now();
      state.stats.redeploys++;
      console.log(`[farmer ${cycles}] REDEPLOY disparado (${res.status}) - nova sessao = cota nova; pools serao replantados no boot`);
      saveState();
      process.exit(0); // o container vai morer no redeploy de qualquer forma
    }
    if (!REDEPLOY_KEY) console.log(`[farmer ${cycles}] (sem FARM_REDEPLOY_KEY: aguardando reset natural de ~5h)`);
    return; // sessao queimada domina: nao poda nem replante neste ciclo
  }
  burnsSeguidos = 0;

  const list = await api("GET", "/api/proxy-pools");
  const all = (list.json && (list.json.proxyPools || list.json.pools || list.json.data)) || [];
  const mine = all.filter(p => typeof p.name === "string" && p.name.startsWith(PREFIX));

  // 1) quem o router ja marcou error/inativo: fora IMEDIATO (sem re-teste)
  // 2) os demais: re-verifica pelo router em paralelo (10 por vez); falhou, fora
  const mortos = mine.filter(p => p.testStatus === "error" || p.isActive === false);
  const aTestar = mine.filter(p => !mortos.includes(p));
  let vivos = 0;
  let idx = 0;
  const reprovados = [];
  const checker = async () => {
    while (idx < aTestar.length) {
      const pool = aTestar[idx++];
      const res = await routerTest(pool.id);
      if (res.ok) vivos++;
      else reprovados.push(pool);
    }
  };
  await Promise.all(Array.from({ length: 10 }, checker));
  for (const pool of [...mortos, ...reprovados]) {
    await api("DELETE", "/api/proxy-pools/" + pool.id);
    state.dead[pool.proxyUrl] = Date.now();
    state.stats.removed++;
  }
  if (mortos.length) console.log(`[farmer ${cycles}] ${mortos.length} error/inativo removidos na hora`);

  // 2) renovacao: perdeu 20% do alvo (ex: 50 -> caiu pra 40) repoe ate o alvo
  const alvoMin = Math.floor(POOL_SIZE * 0.8);
  let need = vivos < alvoMin ? POOL_SIZE - vivos : 0;
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
  const FARM_PROVIDER_ALIAS = process.env.FARM_PROVIDER_ALIAS || "opencode";
  if (!strategies[FARM_PROVIDER_ALIAS] || typeof strategies[FARM_PROVIDER_ALIAS] !== "object") strategies[FARM_PROVIDER_ALIAS] = {};
  strategies[FARM_PROVIDER_ALIAS].rotateStrategy = "random";
  mudou = true;
  for (const alias of Object.keys(strategies)) {
    if (strategies[alias].rotateStrategy !== "random") { strategies[alias].rotateStrategy = "random"; mudou = true; }
  }
  if (mudou) {
    await api("PATCH", "/api/settings", { providerStrategies: strategies });
    console.log(`[farmer ${cycles}] rotateStrategy=random aplicado em:`, Object.keys(strategies).join(", "));
  }

  saveState();
  console.log(`[farmer ${cycles}] fim: ${vivos} vivos (+${criados} novos, -${mortos.length} mortos) | criados: ${state.stats.created} | removidos: ${state.stats.removed}`);

  // publica os vivos numa gist pros outros deploys consumirem (so onde tem gh CLI)
  if (GIST_ID && vivos.length) {
    const lista = mine.filter(p => !mortos.includes(p)).map(p => p.proxyUrl).join("\n");
    const { execFile } = require("child_process");
    const tmp = path.join(os.tmpdir(), "lxr-proxies.txt");
    fs.writeFileSync(tmp, lista);
    execFile("gh", ["gist", "edit", GIST_ID, "-f", `proxies.txt=${tmp}`], { timeout: 30000 }, (err) => {
      console.log(err ? `[farmer] gist update falhou: ${err.message}` : "[farmer] gist atualizado com os vivos");
    });
  }
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
