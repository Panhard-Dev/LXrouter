// Proxy Farmer: mantem o Proxy Pools do 9router sempre cheio de proxies
// publicos vivos, validados pelo teste do proprio router.
//
// - Vigilancia continua: a cada FARM_WATCH_SEC testa todos os pools "auto-"
//   pelo router; error/inativo e deletado na hora e reposto.
// - Colheita: gist (publicada pelo farmer local) + listas publicas filtradas
//   por pais. github sempre via relay (datacenter leva desafio do cloudflare).
// - Canario: 1 request minucula pelo router com modelo rapido; 2 canarios 429
//   seguidos = sessao queimada -> redeploy automatico (nova sessao = nova cota).
// - Pools sem o prefixo "auto-" sao intocaveis (webshare, relays, manual).
//
// Env (tudo opcional):
//   ROUTER_URL / ROUTER_PASSWORD / DATA_DIR / FARM_STATE_FILE
//   FARM_POOL_SIZE (50) / FARM_WATCH_SEC (30) / FARM_WAVE (400)
//   FARM_TIMEOUT_MS (9000) / FARM_TEST_URL / FARM_SOURCES
//   FARM_CANARY_MODEL (oc/ling-3.0-flash-fin-free)
//   FARM_RENOVAR_PCT (80: repoe quando cair abaixo de 80% do alvo)
//   FARM_REDEPLOY_KEY + FARM_REDEPLOY_SERVICE (auto-redeploy quando queima)
//   FARM_RELAYS (relays vercel usados como ponte pras fontes do github)

const net = require("net");
const fs = require("fs");
const path = require("path");
const os = require("os");

const ROUTER_URL = (process.env.ROUTER_URL || "http://127.0.0.1:20128").replace(/\/$/, "");
const ROUTER_PASSWORD = process.env.ROUTER_PASSWORD || "123456";
const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), ".9router");
const STATE_FILE = process.env.FARM_STATE_FILE || path.join(DATA_DIR, "proxy-farmer.json");
const GIST_URL = process.env.FARM_GIST_URL || "https://gist.githubusercontent.com/Panhard-Dev/f4d5df48748c6be6d66d6794107908f4/raw/";
const RELAYS = (process.env.FARM_RELAYS || "https://vercel-relay-9ufpvqdi5-light-opis-projects.vercel.app,https://vercel-relay-eb0i6abzo-pannnns-projects.vercel.app").split(",").map(s => s.trim()).filter(Boolean);
const SOURCES = (process.env.FARM_SOURCES ||
  GIST_URL + "," +
  "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=5000," +
  "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt," +
  "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt," +
  "https://www.proxy-list.download/api/v1/get?type=http&anon=elite," +
  "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies_anonymous/http.txt"
).split(",").map(s => s.trim()).filter(Boolean);
const POOL_SIZE = Number(process.env.FARM_POOL_SIZE || 50);   // alvo fixo: 50
const WATCH_SEC = Number(process.env.FARM_WATCH_SEC || 30);   // renovacao rapida
const RENOVAR_PCT = Number(process.env.FARM_RENOVAR_PCT || 80); // repoe quando cair abaixo de 80% do alvo
const WAVE = Number(process.env.FARM_WAVE || 400);
const TIMEOUT_MS = Number(process.env.FARM_TIMEOUT_MS || 9000);
const TEST_URL = process.env.FARM_TEST_URL || "https://ipv4.webshare.io/";
const CANARY_MODEL = process.env.FARM_CANARY_MODEL || "oc/ling-3.0-flash-fin-free";  // rapido
const REDEPLOY_KEY = process.env.FARM_REDEPLOY_KEY || "";     // unica env que costuma ir no deploy
const REDEPLOY_SERVICE = process.env.FARM_REDEPLOY_SERVICE || "";
const PREFIX = "auto-";
const OC_BATCH = Number(process.env.FARM_OC_BATCH || 15);   // membros testados no caminho opencode por ciclo
const OC_FALHAS = Number(process.env.FARM_OC_FALHAS || 2);  // falhas seguidas ate deletar
const ONCE = process.argv.includes("--once");
const DEAD_RETRY_MS = 24 * 3600 * 1000;
const BURNED_RETRY_MS = 5 * 3600 * 1000;  // ip queimado pro opencode volta no ciclo de ~5h

const state = { dead: {}, burned: {}, ocFails: {}, stats: { cycles: 0, created: 0, removed: 0, redeploys: 0 } };
try { Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))); } catch {}
const saveState = () => { try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1)); } catch {} };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ehLinhaProxy = l => {
  const t = (l || "").trim();
  return /^https?:\/\/\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(t) || /^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(t);
};
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

// valida um membro no caminho OPENCODE: os outros pools ficam inativos,
// a request sai por esse ip especifico; 429/RegionError = ip queimado
async function validarMembroOpencode(poolId, todosPools) {
  for (const p of todosPools) {
    if (p.id !== poolId && p.isActive !== false) {
      await api("PATCH", `/api/proxy-pools/${p.id}`, { isActive: false });
    }
  }
  await api("PATCH", `/api/proxy-pools/${poolId}`, { isActive: true });
  const res = await api("POST", "/v1/chat/completions", { model: CANARY_MODEL, stream: false, max_tokens: 8,
    messages: [{ role: "user", content: "ok" }] });
  for (const p of todosPools) {
    if (p.id !== poolId) { try { await api("PATCH", `/api/proxy-pools/${p.id}`, { isActive: true }); } catch {} }
  }
  const m = JSON.stringify(res.json || {});
  const falha = m.includes("FreeUsageLimitError") || m.includes("RegionError") || m.includes('"status":403');
  return { ok: !falha, detalhe: falha ? (res.json?.error?.message || "queimado").slice(0, 80) : "ok" };
}

// baixa uma lista: github via relay primeiro (datacenter leva desafio do cloudflare)
const temProxy = b => (b || "").split("\n").some(ehLinhaProxy);
const ehGithub = u => /gist\.githubusercontent\.com|raw\.githubusercontent\.com/.test(u);
const ehLinha = b => (b || "").split("\n").some(ehLinhaProxy);
async function baixarLista(src) {
  const ordem = ehGithub(src) ? ["relay", "direto"] : ["direto", "relay"];
  for (const modo of ordem) {
    if (modo === "direto") {
      try {
        const res = await fetch(src, { signal: AbortSignal.timeout(20000) });
        const body = await res.text();
        if (ehLinha(body)) return body;
      } catch {}
      continue;
    }
    for (const relay of RELAYS) {
      try {
        const res = await fetch(relay, { headers: { "x-relay-target": src }, signal: AbortSignal.timeout(20000) });
        const body = await res.text();
        if (ehLinha(body)) { console.log(`[farmer] lista via relay: ${src.split("/")[2]}`); return body; }
      } catch {}
    }
  }
  return "";
}

let harvestCache = { at: 0, list: [] };
const vivoAgora = (emPool, px) => !emPool.has(px) && !(state.dead[px] && Date.now() - state.dead[px] < DEAD_RETRY_MS) &&
  !(state.burned[px] && Date.now() - state.burned[px] < BURNED_RETRY_MS);
async function harvestCandidates(emPool) {
  const diretos = SOURCES.filter(s => {
    try { const u = new URL(s); return /^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname) && (u.pathname === "/" || u.pathname === ""); } catch { return false; }
  });
  if (Date.now() - harvestCache.at < 30 * 60 * 1000 && harvestCache.list.length > POOL_SIZE * 4) {
    return [...diretos, ...harvestCache.list].filter(px => vivoAgora(emPool, px));
  }
  const found = new Set(diretos);
  for (const src of SOURCES) {
    if (diretos.includes(src)) continue;
    const body = await baixarLista(src);
    let n = 0;
    for (const line of body.split("\n")) {
      if (!ehLinhaProxy(line)) continue;
      const px = line.trim().startsWith("http") ? line.trim() : "http://" + line.trim();
      found.add(px); n++;
    }
    console.log(`[farmer] fonte ${(src.split("/")[2] || src).slice(0, 26)}: +${n}`);
  }
  harvestCache = { at: Date.now(), list: [...found] };
  return [...diretos, ...harvestCache.list].filter(px => vivoAgora(emPool, px));
}

// onda de testes com worker-pool: sempre termina
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
let burnsSeguidos = 0;
let lastRedeploy = 0;
async function guardCycle() {
  cycles++;
  const login = await api("POST", "/api/auth/login", { password: ROUTER_PASSWORD });
  if (login.json?.success === false) { console.log(`[farmer ${cycles}] login falhou:`, login.json?.error || login.status); return; }

  // canario: request minucula pelo router com modelo rapido
  const canary = await api("POST", "/v1/chat/completions", { model: CANARY_MODEL, stream: false, max_tokens: 8, messages: [{ role: "user", content: "ok" }] });
  const msg = JSON.stringify(canary.json || {});
  if (msg.includes("FreeUsageLimitError")) {
    burnsSeguidos++;
    console.log(`[farmer ${cycles}] CANARIO 429 (${burnsSeguidos} seguidos) - sessao queimada`);
    if (REDEPLOY_KEY && REDEPLOY_SERVICE && burnsSeguidos >= 2 && Date.now() - lastRedeploy > 10 * 60 * 1000) {
      try {
        const res = await fetch(`https://api.render.com/v1/services/${REDEPLOY_SERVICE}/deploys`, {
          method: "POST",
          headers: { authorization: `Bearer ${REDEPLOY_KEY}`, "content-type": "application/json" },
          body: JSON.stringify({ clearCache: "do_not_clear" }),
        });
        lastRedeploy = Date.now();
        state.stats.redeploys++;
        console.log(`[farmer ${cycles}] REDEPLOY disparado (${res.status}) - nova sessao = cota nova`);
      } catch (e) { console.log(`[farmer ${cycles}] redeploy falhou:`, e.message); }
    }
  } else {
    burnsSeguidos = 0;
  }

  const list = await api("GET", "/api/proxy-pools");
  const all = (list.json && (list.json.proxyPools || list.json.pools || list.json.data)) || [];
  const mine = all.filter(p => typeof p.name === "string" && p.name.startsWith(PREFIX));

  // 1) error/inativo que o router ja marcou: fora imediato
  const mortos = mine.filter(p => p.testStatus === "error" || p.isActive === false);
  const aTestar = mine.filter(p => !mortos.includes(p));

  // 2) re-verifica os demais pelo router em paralelo (10 por vez); falhou, fora
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

  // 2.5) VALIDACAO OPENCODE POR MEMBRO: desativa os outros, request pelo router
  // sai por UM ip especifico; 429/RegionError nesse ip = queimado pro opencode = fora.
  // (o canario so testa a sessao sorteada; aqui e deterministic por ip)
  const restantes = mine.filter(p => !mortos.includes(p) && !reprovados.includes(p));
  if (restantes.length && canary.json && !msg.includes("503")) {
    let cursor = Number(state.ocCursor || 0);
    const lote = [];
    for (let k = 0; k < Math.min(OC_BATCH, restantes.length); k++) {
      lote.push(restantes[(cursor + k) % restantes.length]);
    }
    state.ocCursor = (cursor + lote.length) % Math.max(1, restantes.length);

    // desativa todos os pools auto (outros ficam de fora do sorteio)
    for (const pool of mine) {
      if (pool.isActive !== false) await api("PATCH", `/api/proxy-pools/${pool.id}`, { isActive: false });
    }
    let fora = 0;
    for (const pool of lote) {
      await api("PATCH", `/api/proxy-pools/${pool.id}`, { isActive: true });
      const res = await api("POST", "/v1/chat/completions", { model: CANARY_MODEL, stream: false, max_tokens: 8,
        messages: [{ role: "user", content: "ok" }] });
      const m = JSON.stringify(res.json || {});
      const queimado = m.includes("FreeUsageLimitError") || m.includes("RegionError") || m.includes('"status":403');
      const px = pool.proxyUrl;
      if (queimado) {
        state.ocFails[px] = (state.ocFails[px] || 0) + 1;
        if (state.ocFails[px] >= OC_FALHAS) {
          await api("DELETE", "/api/proxy-pools/" + pool.id);
          state.dead[px] = Date.now();
          state.stats.removed++;
          fora++;
          console.log(`  [oc-fora] ${px} queimado pro opencode (${state.ocFails[px]}x)`);
        }
      } else {
        state.ocFails[px] = 0;
      }
      await api("PATCH", `/api/proxy-pools/${pool.id}`, { isActive: false });
    }
    // reativa os sobreviventes (PATCH em pool deletado so da 404, inofensivo)
    for (const pool of mine) {
      await api("PATCH", `/api/proxy-pools/${pool.id}`, { isActive: true });
    }
    if (fora) console.log(`[farmer ${cycles}] validacao opencode: ${fora} ip(s) queimados removidos`);
  }

  // 3) renovacao: caiu abaixo de RENOVAR_PCT% do alvo, repoe ate o alvo
  const alvoMin = Math.floor(POOL_SIZE * RENOVAR_PCT / 100);
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
      const oc = rt.ok && newId ? await validarMembroOpencode(newId, mine) : { ok: false };
      if (rt.ok && oc.ok) { criados++; need--; vivos++; state.stats.created++; console.log(`  [adiciona] ${px} (router ${rt.elapsed}ms + opencode ok)`); }
      else {
        if (newId) await api("DELETE", "/api/proxy-pools/" + newId);
        if (rt.ok) state.burned[px] = Date.now();  // proxy vivo, mas queimado pro opencode
        else state.dead[px] = Date.now();
      }
    }
  }

  // 4) Rotation Strategy = random em todos os providers, sempre
  const st = await api("GET", "/api/settings");
  const settings = st.json || {};
  const strategies = { ...(settings.providerStrategies || {}) };
  let mudou = false;
  const ALIAS = process.env.FARM_PROVIDER_ALIAS || "opencode";
  if (!strategies[ALIAS] || typeof strategies[ALIAS] !== "object") strategies[ALIAS] = {};
  strategies[ALIAS].rotateStrategy = "random";
  for (const alias of Object.keys(strategies)) {
    if (strategies[alias].rotateStrategy !== "random") { strategies[alias].rotateStrategy = "random"; mudou = true; }
  }
  await api("PATCH", "/api/settings", { providerStrategies: strategies });
  if (mudou || strategies[ALIAS].rotateStrategy === "random") {
    console.log(`[farmer ${cycles}] rotateStrategy=random garantido em: ${Object.keys(strategies).join(", ")}`);
  }

  saveState();
  console.log(`[farmer ${cycles}] fim: ${vivos} vivos (+${criados} novos, -${mortos.length + reprovados.length} fora) | criados: ${state.stats.created} | removidos: ${state.stats.removed}`);
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
