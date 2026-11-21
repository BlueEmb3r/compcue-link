#!/usr/bin/env node
/**
 * CompCue Link command line.
 *   compcue-link                    pair on first run, then keep running
 *   --setup <key>                   pair with the one-time key from the install command (nothing to confirm)
 *   --pair-only                     pair, then exit (the installer uses it before it starts the app)
 *   --claim-only                    with --setup: trade the key, exit 0 when this computer is paired (the Windows app)
 *   --status                        print where the running helper stands
 *   --unpair                        forget this computer's token
 *   --site <url>  --version
 * The work is in link.ts; this file is the real side effects: the League client, the site, the files, the browser.
 *
 * Files, all in one folder only this user can read (%APPDATA%\CompCue, ~/Library/Application Support/CompCue):
 *   link.json    the token for the site          status.json  what the menu bar app shows
 *   link.lock    the running helper's pid         link.log     the last lines it printed (never the token)
 */
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { Lcu } from "../server/live/lcu.js";
import { LcuSocket } from "../server/live/lcuSocket.js";
import { findClient } from "../server/live/lockfile.js";
import { LINK_MAX_BYTES, normalizeCode, siteAllowed } from "../src/shared/link.js";
import { LINK_VERSION, runLink, type LinkDeps, type LinkState } from "./link.js";
import { checkForUpdate, runMacUpdate } from "./update.js";

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
if (args.includes("--version")) { console.log(LINK_VERSION); process.exit(0); }

const site = (arg("--site") ?? process.env.COMPCUE_SITE ?? "https://compcue.aflince.com").replace(/\/+$/, "");
// the token is only ever sent to this site: refuse anything but https (plain http only on this same computer)
if (!siteAllowed(site)) { console.error(`[CompCue Link] ${site} is not allowed: the site must be https.`); process.exit(1); }
const dir = process.env.COMPCUE_DIR ?? (process.platform === "win32" ? path.join(process.env.APPDATA ?? os.homedir(), "CompCue")
  : process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support", "CompCue")
  : path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "compcue"));
mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = path.join(dir, "link.json"), statusFile = path.join(dir, "status.json"), lockFile = path.join(dir, "link.lock"), logFile = path.join(dir, "link.log");
type Saved = { site: string; token: string };
const load = (): Saved | null => { try { const s = JSON.parse(readFileSync(file, "utf8")) as Saved; return s.site === site && s.token ? s : null; } catch { return null; } };
const save = (s: Saved) => writeFileSync(file, JSON.stringify(s), { mode: 0o600 });
const forget = () => { if (existsSync(file)) rmSync(file); };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

if (args.includes("--status")) { try { console.log(readFileSync(statusFile, "utf8")); } catch { console.log(JSON.stringify({ state: "stopped" })); } process.exit(0); }
if (args.includes("--unpair")) { forget(); console.log("[CompCue Link] This computer is no longer paired."); process.exit(0); }

// ---- log: the console, and a small file the menu bar app and bug reports can read ----------------------------
try { if (statSync(logFile).size > 512 * 1024) rmSync(logFile); } catch { /* no log yet */ }
const log = (line: string) => {
  console.log(`[CompCue Link] ${line}`);
  try { appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 }); } catch { /* the console has it */ }
};

// ---- status: one small file, rewritten when something changes -------------------------------------------------
let status: { state: LinkState | "stopped"; code?: string; update?: string } = { state: "pairing" };
const setStatus = (next: Partial<typeof status>) => {
  status = { ...status, ...next };
  if (next.state && next.state !== "pairing") delete status.code;
  try { writeFileSync(statusFile, JSON.stringify({ ...status, site, version: LINK_VERSION, pid: process.pid, at: Date.now() }), { mode: 0o600 }); } catch { /* shown in the log */ }
};

// ---- one helper per user: a second start leaves the first alone ----------------------------------------------
const pairOnly = args.includes("--pair-only") || args.includes("--claim-only");
if (!pairOnly) {
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; } };
  const other = Number((() => { try { return readFileSync(lockFile, "utf8"); } catch { return ""; } })());
  if (other && other !== process.pid && alive(other)) { console.log("[CompCue Link] Already running."); process.exit(0); }
  writeFileSync(lockFile, String(process.pid), { mode: 0o600 });
  const bye = () => { try { if (readFileSync(lockFile, "utf8") === String(process.pid)) rmSync(lockFile); } catch { /* gone */ } setStatus({ state: "stopped" }); process.exit(0); };
  process.on("SIGINT", bye); process.on("SIGTERM", bye);
}

function openBrowser(url: string) {
  if (process.env.COMPCUE_NO_BROWSER === "1") return;
  const [cmd, a] = process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  execFile(cmd as string, a as string[], () => { /* the code is printed too */ });
}
const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
const goodToken = (t: unknown): t is string => typeof t === "string" && /^[A-Za-z0-9_-]{20,200}$/.test(t);
const me = { platform: process.platform, name: os.hostname() };

/** The short way: the one-time key from the install command. null when it no longer works (then the code is used). */
async function claim(key: string): Promise<string | null> {
  try {
    const r = await post(`${site}/api/link/claim`, { key, ...me });
    if (!r.ok) { log("That install command ran out. Pairing with a code instead."); return null; }
    const j = (await r.json()) as { token?: unknown };
    if (!goodToken(j.token)) return null;
    save({ site, token: j.token }); log("Paired.");
    return j.token;
  } catch (e) { log(`Can't reach ${site} (${e instanceof Error ? e.message : e}).`); return null; }
}

async function pair(): Promise<string> {
  for (;;) {
    try {
      const r = await post(`${site}/api/link/start`, me);
      if (!r.ok) throw new Error(`start -> ${r.status}`);
      const s = (await r.json()) as { device: string; code: string; expiresInMs: number };
      // nothing the site sent is printed or opened as it came: the code must have the code's shape, and the
      // page address is built here from the site this helper was started with
      const code = normalizeCode(String(s.code));
      if (!code || typeof s.device !== "string" || s.device.length > 200) throw new Error("unexpected answer");
      const url = `${site}/#/link?code=${code}`;
      setStatus({ state: "pairing", code });
      log(`Confirm this code in your browser: ${code}`);
      log(`If the page did not open, go to ${url}`);
      openBrowser(url);
      const until = Date.now() + Math.min(Number(s.expiresInMs) || 0, 15 * 60_000);
      while (Date.now() < until) {
        await sleep(2000);
        // paired meanwhile from the site's "Connect this PC" button (the app claimed a one-time key): use that
        const now = load();
        if (now) { log("Paired."); return now.token; }
        const t = await post(`${site}/api/link/token`, { device: s.device });
        if (t.status === 200) {
          const j = (await t.json()) as { token?: unknown };
          if (!goodToken(j.token)) throw new Error("unexpected answer");
          save({ site, token: j.token }); log("Paired."); return j.token;
        }
        if (t.status === 410) break;
      }
      log("The code ran out. Here is a new one.");
    } catch (e) { setStatus({ state: "offline" }); log(`Can't reach ${site} (${e instanceof Error ? e.message : e}). Trying again in 15 s.`); await sleep(15_000); }
  }
}

const deps: LinkDeps = {
  platform: process.platform, sleep, log,
  status: (state) => { if (state !== status.state) setStatus({ state }); },
  async findClient() {
    const creds = await findClient();
    if (!creds) return null;
    return {
      reader: new Lcu(creds),
      events(on, down) { const s = new LcuSocket(creds, on, down); s.open(); return { close: () => s.close() }; },
    };
  },
  dial(token, h) {
    const ws = new WebSocket(`${site.replace(/^http/, "ws")}/api/link/ws`, { headers: { Authorization: `Bearer ${token}` }, maxPayload: LINK_MAX_BYTES, handshakeTimeout: 10_000 });
    let refused = 0;
    // a restarted site can leave this socket half open (no close ever arrives): ping, and drop it when nothing answers
    let heard = Date.now(), beat: ReturnType<typeof setInterval> | undefined;
    ws.on("pong", () => { heard = Date.now(); });
    ws.on("open", () => {
      heard = Date.now();
      beat = setInterval(() => { if (Date.now() - heard > 45_000) ws.terminate(); else { try { ws.ping(); } catch { ws.terminate(); } } }, 15_000);
      h.open();
    });
    ws.on("message", (raw, binary) => { heard = Date.now(); if (!binary) h.message(String(raw)); });
    ws.on("unexpected-response", (_req, res) => { refused = res.statusCode ?? 0; ws.terminate(); });
    ws.on("close", (code) => { clearInterval(beat); h.close(refused === 401 ? 401 : code); });
    ws.on("error", () => { try { ws.terminate(); } catch { /* gone */ } });
    return { send: (t) => { if (ws.readyState === ws.OPEN) ws.send(t); }, close: () => ws.close() };
  },
};

log(`version ${LINK_VERSION}, site ${site}`);
const setupKey = arg("--setup");
if (setupKey && !load()) await claim(setupKey);
// the Windows app's "Connect this PC": trade the key and say whether it worked, nothing else
if (args.includes("--claim-only")) process.exit(load() ? 0 : 1);
if (pairOnly) { if (!load()) await pair(); process.exit(0); }

// ---- updates: shortly after start and every 6 hours; applied only while League is not connected --
if (process.env.COMPCUE_NO_UPDATE !== "1") {
  const check = async () => {
    const latest = await checkForUpdate(LINK_VERSION);
    if (!latest) return;
    log(`Version ${latest} is out.`);
    setStatus({ update: latest });
    if (status.state !== "connected" && runMacUpdate(log)) log("Updating now. CompCue Link restarts by itself.");
  };
  setTimeout(check, 20_000).unref();
  setInterval(check, 6 * 3600_000).unref();
}

for (;;) {
  const token = load()?.token ?? (await pair());
  setStatus({ state: "waiting" });
  log("Waiting for the League client.");
  const end = await runLink(token, deps);
  if (end === "update") { await sleep(3600_000); continue; }
  if (end === "unpaired") forget();
}
