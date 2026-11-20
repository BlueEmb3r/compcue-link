// Smoke test for a built CompCue Link executable, on whatever system it runs (the build runs it on Linux,
// Windows and macOS). It needs no League and no CompCue site: both are faked here on 127.0.0.1.
//
//   node test/smoke.mjs <path to executable>            run the checks and exit 0 or 1
//   node test/smoke.mjs --serve <folder>                 only run the fakes (for the Mac installer test):
//                                                        writes <folder>/ports.json, keeps <folder>/seen.json current
//
// The fake League client speaks https with a self-signed certificate and a lockfile, like the real one, and counts
// every request that is not a GET (there must be none). The fake site pairs the helper and asks it for reads.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";

const SETUP_KEY = "SMOKE-setup-key-0123456789";
const TOKEN = "smoke-token-0123456789-abcdefghij";
const SECRET = "MUST-NOT-LEAVE-THE-COMPUTER";
const PUUID = "0b9f3c2a-1d4e-5f60-8a7b-9c0d1e2f3a4b";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startFakes(dir) {
  // SMOKE_LEAGUE_DIR: put the fake client where a packaged app looks by itself (it cannot be handed LEAGUE_PATH)
  const league = process.env.SMOKE_LEAGUE_DIR || path.join(dir, "league");
  mkdirSync(league, { recursive: true });
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem"), "-days", "2", "-subj", "/CN=rclient"], { stdio: "ignore" });
  const password = "pw" + Math.random().toString(36).slice(2);
  const seen = { writes: 0, gets: [], claimed: 0, started: 0, hello: null, clientUp: false, answers: {}, events: [], badAuth: 0 };
  const session = { localPlayerCellId: 0, myTeam: [{ cellId: 0, puuid: PUUID, championId: 103 }], theirTeam: [], actions: [], gameId: 7,
    timer: { phase: "BAN_PICK", adjustedTimeLeftInPhase: 20000 }, chatDetails: { mucJwtDto: { jwt: SECRET } }, trades: [] };

  // ---- the League client
  const lcu = https.createServer({ key: readFileSync(path.join(dir, "key.pem")), cert: readFileSync(path.join(dir, "cert.pem")) }, (req, res) => {
    if (req.headers.authorization !== `Basic ${Buffer.from(`riot:${password}`).toString("base64")}`) { res.writeHead(401); return res.end(); }
    if (req.method !== "GET") { seen.writes++; res.writeHead(405); return res.end(); }
    seen.gets.push(req.url);
    const send = (b) => { if (b == null) { res.writeHead(404); return res.end("{}"); } res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(b)); };
    if (req.url === "/lol-gameflow/v1/gameflow-phase") return send("ChampSelect");
    if (req.url === "/lol-champ-select/v1/session") return send(session);
    if (req.url === "/lol-lobby/v2/lobby") return send({ partyId: "p", mucJwtDto: { jwt: SECRET }, members: [{ puuid: PUUID, summonerName: "n" }] });
    return send(null);
  });
  const lcuWs = new WebSocketServer({ server: lcu });
  lcuWs.on("connection", (ws) => {
    ws.on("message", () => {});
    const push = (uri, data) => ws.send(JSON.stringify([8, "OnJsonApiEvent" + uri.replace(/\//g, "_"), { uri, eventType: "Update", data }]));
    const id = setInterval(() => { if (ws.readyState === 1) { push("/lol-champ-select/v1/session", session); push("/lol-chat/v1/conversations", { secret: SECRET }); } }, 700);
    ws.on("close", () => clearInterval(id));
  });

  // ---- the CompCue site
  const body = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { r(JSON.parse(b || "{}")); } catch { r({}); } }); });
  const site = http.createServer(async (req, res) => {
    const json = (code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    const b = req.method === "POST" ? await body(req) : {};
    if (req.url === "/api/link/claim") { if (b.key === SETUP_KEY) { seen.claimed++; return json(200, { token: TOKEN, deviceId: "d" }); } return json(410, { error: "gone" }); }
    if (req.url === "/api/link/start") { seen.started++; return json(200, { device: "smoke-device-secret", code: "KDA-4F7Q", url: "file:///etc/passwd", expiresInMs: 600000 }); }
    if (req.url === "/api/link/token") return json(200, { token: TOKEN, deviceId: "d" }); // the "player" confirms at once
    json(404, {});
  });
  const siteWs = new WebSocketServer({ noServer: true });
  site.on("upgrade", (req, socket, head) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { seen.badAuth++; socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); return socket.destroy(); }
    siteWs.handleUpgrade(req, socket, head, (ws) => {
      const asks = { 1: "/lol-gameflow/v1/gameflow-phase", 2: "/lol-champ-select/v1/session", 3: "/lol-login/v1/session", 4: "/lol-lobby/v2/lobby", 5: "/lol-champ-select/v1/session/actions/1" };
      ws.on("message", (raw) => {
        const m = JSON.parse(String(raw));
        if (m.t === "hello") seen.hello = m;
        if (m.t === "client") { seen.clientUp = m.up; if (m.up) for (const [id, p] of Object.entries(asks)) ws.send(JSON.stringify({ t: "get", id: Number(id), path: p })); }
        if (m.t === "res") seen.answers[asks[m.id]] = { status: m.status, body: m.body };
        if (m.t === "event") seen.events.push(m);
      });
    });
  });

  return new Promise((resolve) => lcu.listen(0, "127.0.0.1", () => site.listen(0, "127.0.0.1", () => {
    writeFileSync(path.join(league, "lockfile"), `LeagueClient:${process.pid}:${lcu.address().port}:${password}:https`);
    resolve({ seen, league, siteUrl: `http://127.0.0.1:${site.address().port}`, close: () => { lcu.close(); site.close(); lcuWs.close(); siteWs.close(); } });
  })));
}

function check(seen) {
  const problems = [];
  const want = (ok, what) => { if (!ok) problems.push(what); };
  const all = JSON.stringify(seen);
  want(seen.hello && seen.hello.v === 1 && /^\d+\.\d+\.\d+$/.test(seen.hello.version), "the helper said hello with its version");
  want(seen.clientUp === true, "the helper found the League client");
  want(seen.answers["/lol-gameflow/v1/gameflow-phase"]?.body === "ChampSelect", "a read came back through the helper");
  want(seen.answers["/lol-champ-select/v1/session"]?.body?.myTeam?.[0]?.puuid === PUUID, "the champ select session came back");
  want(seen.answers["/lol-login/v1/session"]?.status === 403, "a path off the list was refused");
  want(seen.answers["/lol-champ-select/v1/session/actions/1"]?.status === 403, "a path that could write was refused");
  want(JSON.stringify(seen.answers["/lol-lobby/v2/lobby"]?.body) === JSON.stringify({ members: [{ puuid: PUUID }] }), "the lobby was cut to the members' ids");
  want(seen.events.some((e) => e.uri === "/lol-champ-select/v1/session"), "a champ select event was forwarded");
  want(!seen.events.some((e) => e.uri !== "/lol-champ-select/v1/session"), "no event off the list was forwarded");
  want(!all.includes(SECRET), "nothing secret left the computer");
  want(seen.writes === 0, "the helper sent only GET requests to the client");
  want(!seen.gets.some((g) => g.includes("login") || g.includes("actions")), "refused paths never reached the client");
  return problems;
}

async function runHelper(exe, fakes, dir, extra, until) {
  const env = { ...process.env, LEAGUE_PATH: fakes.league, COMPCUE_DIR: dir, COMPCUE_NO_BROWSER: "1", COMPCUE_NO_UPDATE: "1" };
  let out = "";
  const child = spawn(exe, ["--site", fakes.siteUrl, ...extra], { env });
  child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  const t0 = Date.now();
  while (Date.now() - t0 < 30000 && !until()) await sleep(200);
  return { child, out: () => out, env };
}

if (process.argv[2] === "--serve") {
  const dir = path.resolve(process.argv[3]);
  mkdirSync(dir, { recursive: true });
  const fakes = await startFakes(dir);
  writeFileSync(path.join(dir, "ports.json"), JSON.stringify({ siteUrl: fakes.siteUrl, league: fakes.league, key: SETUP_KEY }));
  setInterval(() => writeFileSync(path.join(dir, "seen.json"), JSON.stringify({ ...fakes.seen, problems: check(fakes.seen) })), 500);
  console.log(`fakes up: ${fakes.siteUrl}`);
} else {
  const exe = path.resolve(process.argv[2] ?? "dist/compcue-link");
  const failures = [];
  const version = execFileSync(exe, ["--version"]).toString().trim();
  console.log(`executable ${exe}, version ${version}, ${process.platform} ${process.arch}`);
  if (!/^\d+\.\d+\.\d+$/.test(version)) failures.push("--version prints the version");
  try { execFileSync(exe, ["--site", "http://example.com"], { stdio: "pipe" }); failures.push("a plain http site is refused"); } catch { /* refused, as it should be */ }

  // 1. the short way: the one-time key from the install command
  {
    const dir = mkdtempSync(path.join(os.tmpdir(), "link-smoke-"));
    const fakes = await startFakes(dir);
    const done = () => Object.keys(fakes.seen.answers).length === 5 && fakes.seen.events.length > 0;
    const h = await runHelper(exe, fakes, path.join(dir, "home"), ["--setup", SETUP_KEY], done);
    await sleep(500);
    const problems = check(fakes.seen);
    if (fakes.seen.claimed !== 1 || fakes.seen.started !== 0) problems.push("paired with the one-time key, without a code");
    const status = JSON.parse(readFileSync(path.join(dir, "home", "status.json"), "utf8"));
    if (status.state !== "connected") problems.push(`status.json says connected (it says ${status.state})`);
    if (readFileSync(path.join(dir, "home", "link.log"), "utf8").includes(TOKEN) || h.out().includes(TOKEN)) problems.push("the token is never printed or logged");
    const second = execFileSync(exe, ["--site", fakes.siteUrl], { env: h.env }).toString();
    if (!second.includes("Already running")) problems.push("a second copy leaves the first alone");
    h.child.kill(); fakes.close();
    for (const p of problems) failures.push(`with a setup key: ${p}`);
    if (problems.length) console.log(h.out());
  }
  // 2. the code way, with a site that sends a hostile address to open: the helper must build its own
  {
    const dir = mkdtempSync(path.join(os.tmpdir(), "link-smoke-"));
    const fakes = await startFakes(dir);
    const done = () => Object.keys(fakes.seen.answers).length === 5 && fakes.seen.events.length > 0;
    const h = await runHelper(exe, fakes, path.join(dir, "home"), [], done);
    await sleep(300);
    const problems = check(fakes.seen);
    if (fakes.seen.started !== 1) problems.push("paired with a code");
    if (h.out().includes("file:///")) problems.push("an address sent by the site is never shown or opened");
    if (!h.out().includes("KDA-4F7Q")) problems.push("the code is shown");
    h.child.kill(); fakes.close();
    for (const p of problems) failures.push(`with a code: ${p}`);
    if (problems.length) console.log(h.out());
  }
  if (failures.length) { console.log("FAILED, these did not hold:"); for (const f of failures) console.log(` - ${f}`); process.exit(1); }
  console.log("ok: pairing both ways, reads, refusals, data cut-down, read-only, single copy");
  process.exit(0);
}
