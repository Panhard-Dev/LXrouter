// Planta a FIXED_API_KEY (env) no banco do 9router, sobrevivendo a redeploys.
const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dataDir = process.env.DATA_DIR || path.join(os.homedir(), ".9router");
const key = (process.env.FIXED_API_KEY || "").trim();
const dbPath = path.join(dataDir, "db", "data.sqlite");

if (!key) { console.log("[init-key] FIXED_API_KEY vazia, pulando"); process.exit(0); }
if (!fs.existsSync(dbPath)) { console.log("[init-key] banco ainda nao existe:", dbPath); process.exit(1); }

const db = new DatabaseSync(dbPath);
db.exec("CREATE TABLE IF NOT EXISTS apiKeys (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, name TEXT, machineId TEXT, isActive INTEGER DEFAULT 1, createdAt TEXT NOT NULL)");
db.prepare("INSERT OR REPLACE INTO apiKeys (id, key, name, machineId, isActive, createdAt) VALUES (?, ?, ?, ?, 1, ?)")
  .run("fixa", key, "Fixa (env)", "env", new Date().toISOString());
db.close();
console.log(`[init-key] key fixa plantada: ${key.slice(0, 12)}...`);
