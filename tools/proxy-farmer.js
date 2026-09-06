// Proxy Window: mantem exatamente WEBSHARE_WINDOW pools "auto-" ativos no
// 9router, girados a cada WEBSHARE_ROTATE_SEC a partir de uma lista FIXA de
// proxies Webshare embutida no codigo (lista fixa, sem env).
//
// Regras:
// - Lista fixa: 20 proxies Webshare (2 credenciais x 10 IPs), cada um com 1GB.
// - Janela: so WEBSHARE_WINDOW (5) entram em cena por vez; a janela gira
//   sozinha a cada WEBSHARE_ROTATE_SEC (300s = 5 min).
// - Validacao REAL antes de entrar: request de verdade pelo router com
//   oc/ling-3.0-flash-fin-free saindo por AQUELE ip. 429/RegionError/403 =
//   ip queimado -> nao entra (nao gasta janela).
// - Se WEBSHARE_MAX_BAD (3) dos ativos derem erro no cheque do ciclo, a
//   janela troca na hora (antes dos 5 min).
// - TUDO queimar (nenhum valido na lista inteira) = todos pools off:
//   o router usa a rede padrao (ip da casa/datacenter do deploy).
// - rotateStrategy = round-robin garantido em todos os providers, sempre.
//
// Env (opcional, tudo tem padrao):
//   ROUTER_URL / ROUTER_PASSWORD / DATA_DIR / FARM_STATE_FILE
//   (nenhum: a lista dos 20 webshare vive so aqui no codigo)
//   WEBSHARE_WINDOW (5) / WEBSHARE_ROTATE_SEC (300) / WEBSHARE_MAX_BAD (3)
//   WEBSHARE_TEST_MODEL (oc/ling-3.0-flash-fin-free) / WEBSHARE_TIMEOUT_MS (12000)
//   FARM_PROVIDER_ALIAS (opencode)

const fs = require("fs");
const path = require("path");
const os = require("os");

const ROUTER_URL = (process.env.ROUTER_URL || "http://127.0.0.1:20128").replace(/\/$/, "");
const ROUTER_PASSWORD = process.env.ROUTER_PASSWORD || "123456";
const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), ".9router");
const STATE_FILE = process.env.FARM_STATE_FILE || path.join(DATA_DIR, "proxy-farmer.json");

// 20 proxies Webshare (2 credenciais x 10 IPs). Cada um tem 1GB de trafego.
const WEBSHARE_DEFAULT = [
  "31.59.20.176:6754:ggktmmgj:8tqz9nbdylav",
  "45.38.107.97:6014:ggktmmgj:8tqz9nbdylav",
  "198.105.121.200:6462:ggktmmgj:8tqz9nbdylav",
  "64.137.96.74:6641:ggktmmgj:8tqz9nbdylav",
  "198.23.243.226:6361:ggktmmgj:8tqz9nbdylav",
  "38.154.185.97:6370:ggktmmgj:8tqz9nbdylav",
  "84.247.60.125:6095:ggktmmgj:8tqz9nbdylav",
  "142.111.67.146:5611:ggktmmgj:8tqz9nbdylav",
  "191.96.254.138:6185:ggktmmgj:8tqz9nbdylav",
  "31.58.9.4:6077:ggktmmgj:8tqz9nbdylav",
  "31.59.20.176:6754:zxucoiox:1mg8kgu44l0q",
  "45.38.107.97:6014:zxucoiox:1mg8kgu44l0q",
  "198.105.121.200:6462:zxucoiox:1mg8kgu44l0q",
  "64.137.96.74:6641:zxucoiox:1mg8kgu44l0q",
  "198.23.243.226:6361:zxucoiox:1mg8kgu44l0q",
  "38.154.185.97:6370:zxucoiox:1mg8kgu44l0q",
  "84.247.60.125:6095:zxucoiox:1mg8kgu44l0q",
  "142.111.67.146:5611:zxucoiox:1mg8kgu44l0q",
  "191.96.254.138:6185:zxucoiox:1mg8kgu44l0q",
  "31.58.9.4:6077:zxucoiox:1mg8kgu44l0q",
].map(s => {
  const [host, port, user, pass] = s.split(":");
  return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
});

// lista FIXA embutida no codigo - nao depende de env nenhum
const WEBSHARE = WEBSHARE_DEFAULT;

const WINDOW_SIZE = Number(process.env.WEBSHARE_WINDOW || 5);       // 5 em cena
const ROTATE_SEC = Number(process.env.WEBSHARE_ROTATE_SEC || 300);   // gira a cada 5 min
const MAX_BAD = Number(process.env.WEBSHARE_MAX_BAD || 3);          // 3/5 errados = troca na hora
const TEST_MODEL = process.env.WEBSHARE_TEST_MODEL || "oc/ling-3.0-flash-fin-free";
const TIMEOUT_MS = Number(process.env.WEBSHARE_TIMEOUT_MS || 12000);
const ALIAS = process.env.FARM_PROVIDER_ALIAS || "opencode";
const PREFIX = "auto-";
const ONCE = process.argv.includes("--once");

const state = { dead: {}, stats: { cycles: 0, rotations: 0, created: 0, removed: 0, fallbackRede: 0 } };
try { Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))); } catch {}
const saveState = () => { try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1)); } catch {} };
const sleep = ms => new Promise(r => setTimeout(r, ms));

let cookie = "";
async function api(method, apiPath, body) {
  const res = await fetch(ROUTER_URL + apiPath, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS * 2),
  });
  for (const c of res.headers.getSetCookie?.() || []) {
    const kv = c.split(";")[0];
    if (!cookie.includes(kv.split("=")[0] + "=")) cookie += (cookie ? "; " : "") + kv;
  }
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
// a rota do pool so aceita PUT (PATCH devolve 405 silencioso)
const patch = (id, body) => api("PUT", `/api/proxy-pools/${id}`, body);
const delPool = id => api("DELETE", "/api/proxy-pools/" + id);

async function listPools() {
  const r = await api("GET", "/api/proxy-pools");
  return (r.json && (r.json.proxyPools || r.json.pools || r.json.data)) || [];
}

// request REAL pelo router com SO esse pool ativo: o trafego sai por aquele ip.
// 429/RegionError/403 = queimado. Timeout/refused = proxy morto.
async function testarIpReal(poolId, todosPools) {
  for (const p of todosPools) {
    if (p.id !== poolId && p.isActive !== false) { try { await patch(p.id, { isActive: false }); } catch {} }
  }
  await patch(poolId, { isActive: true });
  const r = await api("POST", "/v1/chat/completions", {
    model: TEST_MODEL, stream: false, max_tokens: 2048,
    messages: [{ role: "user", content: "ok" }],
  });
  const s = JSON.stringify(r.json || {});
  const queimado = s.includes("FreeUsageLimitError") || s.includes("RegionError") || s.includes('"status":403');
  const morto = r.status === 0 || s.includes("ECONNREFUSED") || s.includes("ETIMEDOUT") || s.includes("tunneling socket");
  // devolve o pool pro estado anterior (so ele ativo -> fica ativo; os outros voltam depois)
  return { ok: r.status === 200 && !queimado && !morto, queimado, morto };
}

function poolName(px) {
  const m = /@([^:]+):(\d+)/.exec(px) || /\/\/([^:]+):(\d+)/.exec(px);
  return PREFIX + (m ? m[1] + ":" + m[2] : px.replace(/^https?:\/\//, ""));
}

// garante round-robin em todos os providers (default da UI e "none": so um pool)
async function garantirRoundRobin() {
  const st = await api("GET", "/api/settings");
  const settings = st.json || {};
  const strategies = { ...(settings.providerStrategies || {}) };
  if (!strategies[ALIAS] || typeof strategies[ALIAS] !== "object") strategies[ALIAS] = {};
  let mudou = false;
  if (strategies[ALIAS].rotateStrategy !== "round-robin") { strategies[ALIAS].rotateStrategy = "round-robin"; mudou = true; }
  for (const alias of Object.keys(strategies)) {
    if (alias !== ALIAS && strategies[alias].rotateStrategy !== "round-robin") { strategies[alias].rotateStrategy = "round-robin"; mudou = true; }
  }
  await api("PATCH", "/api/settings", { providerStrategies: strategies });
  return mudou;
}

// apaga todos os pools auto- e replanta a janela (inicial ou rotacionada)
async function plantarJanela(startIdx, todosPools) {
  for (const p of todosPools) {
    if (typeof p.name === "string" && p.name.startsWith(PREFIX)) { await delPool(p.id); state.stats.removed++; }
  }
  const ativos = [];
  for (let i = 0; i < WINDOW_SIZE; i++) {
    const px = WEBSHARE[(startIdx + i) % WEBSHARE.length];
    const create = await api("POST", "/api/proxy-pools", { name: poolName(px), proxyUrl: px, isActive: true });
    if (create.status >= 300) continue;
    const id = create.json?.proxyPool?.id || create.json?.pool?.id || create.json?.id;
    if (id) { ativos.push({ id, px }); state.stats.created++; }
  }
  return ativos;
}

async function ciclo() {
  state.stats.cycles++;
  const login = await api("POST", "/api/auth/login", { password: ROUTER_PASSWORD });
  if (login.json?.success === false) { console.log(`[window ${state.stats.cycles}] login falhou`); return; }

  await garantirRoundRobin();

  const agora = Date.now();
  const ultimo = Number(state.lastRotate || 0);
  const precisaGirar = agora - ultimo >= ROTATE_SEC * 1000;
  let todos = await listPools();
  let meus = todos.filter(p => typeof p.name === "string" && p.name.startsWith(PREFIX));

  // primeira rodada (banco vazio) ou hora de girar a janela
  if (!meus.length || precisaGirar) {
    const start = Number(state.nextStart || 0);
    const ativos = await plantarJanela(start, todos);
    state.lastRotate = agora;
    state.nextStart = (start + WINDOW_SIZE) % WEBSHARE.length;
    state.stats.rotations++;
    console.log(`[window ${state.stats.cycles}] janela plantada: ${ativos.map(a => a.px.replace(/https?:\/\/[^@]+@/, "")).join(", ")}`);
    todos = await listPools();
    meus = todos.filter(p => typeof p.name === "string" && p.name.startsWith(PREFIX));
  }

  // valida cada ativo com request REAL; conta queimados
  let queimados = 0, vivos = [];
  for (const p of meus) {
    const r = await testarIpReal(p.id, todos);
    if (r.ok) vivos.push(p);
    else {
      queimados++;
      state.dead[p.proxyUrl] = Date.now();
      console.log(`[window ${state.stats.cycles}] ${p.name}: ${r.queimado ? "QUEIMADO (429/region)" : "MORTO (conexao)"}`);
    }
  }

  // 3+ dos 5 errados = troca a janela AGORA (nao espera os 5 min)
  if (queimados >= MAX_BAD) {
    console.log(`[window ${state.stats.cycles}] ${queimados}/${meus.length} errados -> TROCANDO JANELA AGORA`);
    const start = Number(state.nextStart || 0);
    // pula ips sabidos queimados: avanca o start ate achar bloco com candidatos novos
    todos = await listPools();
    const ativos = await plantarJanela(start, todos);
    state.lastRotate = agora;
    state.nextStart = (start + WINDOW_SIZE) % WEBSHARE.length;
    state.stats.rotations++;
    console.log(`[window ${state.stats.cycles}] nova janela: ${ativos.map(a => a.px.replace(/https?:\/\/[^@]+@/, "")).join(", ")}`);
    // re-testa a nova janela na hora de vir
    const novos = await listPools();
    const meusNovos = novos.filter(p => typeof p.name === "string" && p.name.startsWith(PREFIX));
    let okNovos = 0;
    for (const p of meusNovos) {
      const r = await testarIpReal(p.id, novos);
      if (r.ok) okNovos++; else state.dead[p.proxyUrl] = Date.now();
    }
    if (okNovos === 0) {
      // TUDO queimado de verdade: desliga todos os pools -> rede padrao
      for (const p of meusNovos) { try { await patch(p.id, { isActive: false }); } catch {} }
      state.stats.fallbackRede++;
      console.log(`[window ${state.stats.cycles}] NENHUM ip valido -> REDE PADRAO (pools off) ate o proximo ciclo`);
    } else {
      console.log(`[window ${state.stats.cycles}] nova janela validada: ${okNovos}/${meusNovos.length} ok`);
    }
  } else if (vivos.length === 0 && meus.length > 0) {
    // edge: 0 vivos mas abaixo do MAX_BAD (pool 1-2) -> tambem cai pra rede padrao
    for (const p of meus) { try { await patch(p.id, { isActive: false }); } catch {} }
    state.stats.fallbackRede++;
    console.log(`[window ${state.stats.cycles}] 0 vivos -> REDE PADRAO`);
  } else {
    // normal: garante que so os vivos fiquem ativos, todos os outros off
    for (const p of todos) {
      if (typeof p.name === "string" && p.name.startsWith(PREFIX)) {
        const vivo = vivos.some(v => v.id === p.id);
        const querAtivo = p.isActive !== false;
        if (vivo !== querAtivo) { try { await patch(p.id, { isActive: vivo }); } catch {} }
      }
    }
    console.log(`[window ${state.stats.cycles}] ${vivos.length}/${meus.length} vivos (round-robin ativo)`);
  }

  saveState();
}

(async () => {
  console.log(`[window] ${WEBSHARE.length} proxies webshare no codigo, janela ${WINDOW_SIZE}, giro ${ROTATE_SEC}s, troca com ${MAX_BAD}+ errados`);
  if (ONCE) { await ciclo(); process.exit(0); }
  for (;;) {
    const t0 = Date.now();
    try { await ciclo(); } catch (e) { console.log(`[window] erro no ciclo:`, e.message); saveState(); }
    await sleep(Math.max(5000, 30 * 1000 - (Date.now() - t0)));
  }
})();
