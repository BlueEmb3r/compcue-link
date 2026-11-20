#!/usr/bin/env node
/**
 * CompCue Link command line: `compcue-link` (pairs on first run, then keeps running), `--site <url>`,
 * `--unpair` (forget this computer's token), `--version`.
 * The work is in link.ts; this file is the real side effects: the League client, the site, the token file, the browser.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { Lcu } from "../server/live/lcu.js";
import { LcuSocket } from "../server/live/lcuSocket.js";
import { findClient } from "../server/live/lockfile.js";
import { LINK_MAX_BYTES, normalizeCode, siteAllowed } from "../src/shared/link.js";
import { LINK_VERSION, runLink, type LinkDeps } from "./link.js";

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
if (args.includes("--version")) { console.log(LINK_VERSION); process.exit(0); }

const site = (arg("--site") ?? process.env.COMPCUE_SITE ?? "https://compcue.aflince.com").replace(/\/+$/, "");
// the token is only ever sent to this site: refuse anything but https (plain http only on this same computer)
if (!siteAllowed(site)) { console.error(`[CompCue Link] ${site} is not allowed: the site must be https.`); process.exit(1); }
const dir = process.platform === "win32" ? path.join(process.env.APPDATA ?? os.homedir(), "CompCue")
  : process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support", "CompCue")
  : path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "compcue");
const file = path.join(dir, "link.json");
type Saved = { site: string; token: string };
const load = (): Saved | null => { try { const s = JSON.parse(readFileSync(file, "utf8")) as Saved; return s.site === site && s.token ? s : null; } catch { return null; } };
const save = (s: Saved) => { mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(file, JSON.stringify(s), { mode: 0o600 }); };
const forget = () => { if (existsSync(file)) rmSync(file); };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const log = (line: string) => console.log(`[CompCue Link] ${line}`);

function openBrowser(url: string) {
  if (process.env.COMPCUE_NO_BROWSER === "1") return;
  const [cmd, a] = process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  execFile(cmd as string, a as string[], () => { /* the code is printed too */ });
}

async function pair(): Promise<string> {
  for (;;) {
    try {
      const r = await fetch(`${site}/api/link/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ platform: process.platform, name: os.hostname() }) });
      if (!r.ok) throw new Error(`start -> ${r.status}`);
      const s = (await r.json()) as { device: string; code: string; expiresInMs: number };
      // nothing the site sent is printed or opened as it came: the code must have the code's shape, and the
      // page address is built here from the site this helper was started with
      const code = normalizeCode(String(s.code));
      if (!code || typeof s.device !== "string" || s.device.length > 200) throw new Error("unexpected answer");
      const url = `${site}/#/link?code=${code}`;
      log(`Confirm this code in your browser: ${code}`);
      log(`If the page did not open, go to ${url}`);
      openBrowser(url);
      const until = Date.now() + Math.min(Number(s.expiresInMs) || 0, 15 * 60_000);
      while (Date.now() < until) {
        await sleep(2000);
        const t = await fetch(`${site}/api/link/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device: s.device }) });
        if (t.status === 200) {
          const j = (await t.json()) as { token: string };
          if (typeof j.token !== "string" || !/^[A-Za-z0-9_-]{20,200}$/.test(j.token)) throw new Error("unexpected answer");
          save({ site, token: j.token }); log("Paired."); return j.token;
        }
        if (t.status === 410) break;
      }
      log("The code ran out. Here is a new one.");
    } catch (e) { log(`Can't reach ${site} (${e instanceof Error ? e.message : e}). Trying again in 15 s.`); await sleep(15_000); }
  }
}

const deps: LinkDeps = {
  platform: process.platform, sleep, log,
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
    ws.on("open", () => h.open());
    ws.on("message", (raw, binary) => { if (!binary) h.message(String(raw)); });
    ws.on("unexpected-response", (_req, res) => { refused = res.statusCode ?? 0; ws.terminate(); });
    ws.on("close", (code) => h.close(refused === 401 ? 401 : code));
    ws.on("error", () => { try { ws.terminate(); } catch { /* gone */ } });
    return { send: (t) => { if (ws.readyState === ws.OPEN) ws.send(t); }, close: () => ws.close() };
  },
};

if (args.includes("--unpair")) { forget(); log("This computer is no longer paired."); process.exit(0); }
log(`version ${LINK_VERSION}, site ${site}`);
for (;;) {
  const token = load()?.token ?? (await pair());
  log("Waiting for the League client.");
  const end = await runLink(token, deps);
  if (end === "update") process.exit(2);
  if (end === "unpaired") forget();
}
