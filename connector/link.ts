/**
 * CompCue Link, the helper on a player's computer. All it does:
 *   1. wait until the League client is open (server/live/lockfile.ts: the same finder the local app uses)
 *   2. hold one outbound WebSocket to the site, recognised by the token from pairing
 *   3. answer the site's read requests from the allowlist (src/shared/link.ts) and forward three client events
 *
 * Read-only by construction: the only calls it can make to the client are GETs on ALLOWED_GETS. Nothing listens
 * on this computer, the client's port and password never leave it, and while a game is being played it goes
 * quiet (only the game phase and the already-locked teams can be read), except for one read the site may ask
 * for: the scoreboard (champion, side, level and items of the ten players), for the player's own build options. No connection to the site exists
 * while League is closed. Every body is cut down before it is sent (minimize): chat tokens, the game server's
 * address and keys and anything else the site does not use stay on this computer.
 *
 * Side effects come in as `deps`, so tests run it against a fake client and a fake site (tests/link.test.ts).
 */
import { allowedGet, allowedTopic, GAME_PHASE, minimizeGame, LINK_BEAT_MS, LINK_PING, LINK_PONG, LINK_PONG_LATE_MS, LINK_PROTOCOL, minimize, parseMessage, QUIET_PHASES, toLink, type FromLink, type ToLink } from "../src/shared/link.js";
import type { ClientReader } from "../server/live/lcu.js";
import type { LcuEvent } from "../server/live/lcuSocket.js";

export const LINK_VERSION = "0.4.1";

/** Reads allowed in every phase (the phase itself, and the session that names the locked teams at game start). */
const ALWAYS = ["/lol-gameflow/v1/gameflow-phase", "/lol-gameflow/v1/session"];

export interface SiteSocket { send(text: string): void; close(): void }
export interface SiteHandlers { open(): void; message(text: string): void; close(code: number, reason?: string): void }
export interface LinkDeps {
  /** the running League client, or null (found again on every call) */
  findClient(): Promise<{ reader: ClientReader; events(on: (e: LcuEvent) => void, down: () => void, up?: () => void): { close(): void } } | null>;
  /** open the socket to the site with this token; `status` 401 on close means the token no longer works */
  dial(token: string, h: SiteHandlers): SiteSocket;
  sleep(ms: number): Promise<void>;
  /** the clock (tests move it by hand) */
  now?(): number;
  log(line: string): void;
  /** where the helper stands, for the menu bar app and `--status` */
  status?(state: LinkState): void;
  /** the League client's phase each time it is read (the updater waits for an idle one) */
  phase?(phase: string): void;
  platform: string;
}

/** Phases an update must never interrupt: a queue about to pop, a champ select, a game. */
export const UPDATE_BUSY = ["Matchmaking", "ReadyCheck", "ChampSelect", "GameStart", "InProgress", "Reconnect"];
/** May the helper replace and restart itself now? Yes with no League client; with one, only once its phase is known and idle. */
export function mayUpdate(state: LinkState | "stopped", phase: string | null): boolean {
  if (state === "waiting" || state === "pairing") return true;
  return state === "connected" && phase !== null && !UPDATE_BUSY.includes(phase);
}

export type LinkState = "pairing" | "waiting" | "connecting" | "connected" | "offline" | "update";
export type LinkEnd = "unpaired" | "update" | "stopped";

/** One answer to a `get`, as the helper decides it. Exported for the allowlist tests. */
export async function answerGet(reader: ClientReader, path: string, phase: string): Promise<{ status: number; body?: unknown }> {
  if (!allowedGet(path)) return { status: 403 };
  if (QUIET_PHASES.includes(phase) && !ALWAYS.includes(path)) return { status: 409 };
  try { return { status: 200, body: minimize(path, await reader.get<unknown>(path)) }; }
  catch (e) { const s = (e as { status?: unknown })?.status; return { status: typeof s === "number" ? s : 502 }; }
}

/** One answer to a `game`: the scoreboard, only while a game is being played, cut down before it leaves. */
export async function answerGame(reader: ClientReader, phase: string): Promise<{ status: number; body?: unknown }> {
  if (phase !== GAME_PHASE) return { status: 409 };
  if (!reader.game) return { status: 501 };
  const body = minimizeGame(await reader.game().catch(() => null));
  return body ? { status: 200, body } : { status: 404 };
}

/**
 * Runs until the token is refused ("unpaired": pair again), the site asks for a newer helper ("update"),
 * or `stop` is set.
 */
export async function runLink(token: string, d: LinkDeps, stop: { now: boolean } = { now: false }): Promise<LinkEnd> {
  let backoff = 1000, refused = 0;
  while (!stop.now) {
    const client = await d.findClient().catch(() => null);
    if (!client) { d.status?.("waiting"); await d.sleep(3000); continue; }
    d.log("League client found. Connecting to CompCue.");
    d.status?.("connecting");
    const end = await session(token, client, d, stop);
    // a site that is restarting can refuse a token once: forget it only when it refuses twice in a row
    if (end === "unpaired" && ++refused < 2) { d.log("The site did not accept this computer. Trying once more."); await d.sleep(5000); continue; }
    if (end !== "unpaired") refused = 0;
    if (end === "unpaired" || end === "update") { d.status?.(end === "update" ? "update" : "pairing"); return end; }
    d.status?.(end === "site-closed" ? "offline" : "waiting");
    // the site restarting (a new version going out) is normal: come back quickly, never wait more than 15 s
    if (end === "ok" || end === "silent") backoff = 1000; else backoff = Math.min(backoff * 2, 15_000);
    if (!stop.now) await d.sleep(end === "client-closed" ? 1000 : backoff + Math.floor(Math.random() * 500));
  }
  return "stopped";
}

type SessionEnd = "unpaired" | "update" | "client-closed" | "site-closed" | "silent" | "ok";

function session(token: string, client: NonNullable<Awaited<ReturnType<LinkDeps["findClient"]>>>, d: LinkDeps, stop: { now: boolean }): Promise<SessionEnd> {
  const now = () => d.now?.() ?? Date.now();
  return new Promise((resolve) => {
    let phase = "None", done = false, opened = false, events: { close(): void } | null = null;
    // heartbeat: a pong proves the site's own code still holds this socket (see LINK_PING in src/shared/link.ts)
    let openedAt = 0, lastPong = 0, pongs = 0, eventsUp: boolean | undefined;
    const finish = (end: SessionEnd) => { if (done) return; done = true; events?.close(); events = null; try { site.close(); } catch { /* already closed */ } resolve(end); };
    const send = (m: FromLink) => { if (!done) site.send(JSON.stringify(m)); };
    const via = client.reader.via === "process" ? "process" : "lockfile";
    const tellClient = () => send({ t: "client", up: true, via, ...(eventsUp !== undefined ? { events: eventsUp } : {}) });
    /** the client's event socket: opened again when it drops (the client restarting its socket, a wake from sleep), 2 s, 5 s, then every 10 s */
    const openEvents = (tries = 0) => {
      if (done) return;
      let up = false;
      events = client.events((e) => {
        if (!up) { up = true; tries = 0; if (eventsUp !== true) { eventsUp = true; tellClient(); } }
        if (!allowedTopic(e.uri)) return;
        if (e.uri === "/lol-gameflow/v1/gameflow-phase" && typeof e.data === "string") { phase = e.data; d.phase?.(phase); }
        else if (QUIET_PHASES.includes(phase)) return;
        send({ t: "event", uri: e.uri, eventType: e.eventType, data: minimize(e.uri, e.data) });
      }, () => {
        if (done) return;
        if (eventsUp !== false) { eventsUp = false; d.log("League client events stopped. Reading it directly until they come back."); tellClient(); }
        events = null;
        void d.sleep(tries === 0 ? 2000 : tries === 1 ? 5000 : 10_000).then(() => { if (!done && !events) openEvents(tries + 1); });
      }, () => { up = true; tries = 0; if (eventsUp !== true) { const was = eventsUp; eventsUp = true; if (was === false) d.log("League client events are back."); tellClient(); } });
    };
    const site: SiteSocket = d.dial(token, {
      open() {
        opened = true; openedAt = now();
        send({ t: "hello", v: LINK_PROTOCOL, version: LINK_VERSION, platform: d.platform, beat: LINK_BEAT_MS, ...(client.reader.game ? { game: true } : {}) });
        tellClient();
        d.log("Connected. You can go back to the CompCue page.");
        d.status?.("connected");
        openEvents();
        // the client's own lifetime: when it stops answering, tell the site and leave (no idle connection)
        void (async () => {
          while (!done && !stop.now) {
            await d.sleep(5000);
            if (done) return;
            const r = await answerGet(client.reader, "/lol-gameflow/v1/gameflow-phase", "None");
            if (r.status === 200 && typeof r.body === "string") { phase = r.body; d.phase?.(phase); }
            else if (r.status === 502) { send({ t: "client", up: false }); d.log("League client closed."); return finish("client-closed"); }
          }
          if (stop.now) finish("ok");
        })();
        // the heartbeat: ping every LINK_BEAT_MS; once the site has answered one, a site that stops answering is gone
        void (async () => {
          let warned = false;
          while (!done && !stop.now) {
            site.send(LINK_PING);
            await d.sleep(LINK_BEAT_MS);
            if (done) return;
            const since = now() - (lastPong || openedAt);
            if (pongs > 0 && since > LINK_PONG_LATE_MS) { d.log(`No answer from CompCue for ${Math.round(since / 1000)} s. Connecting again.`); return finish("silent"); }
            if (!pongs && !warned && since > LINK_PONG_LATE_MS) { warned = true; d.log("This CompCue site does not answer heartbeats (an older version). Staying connected."); }
          }
        })();
      },
      message(text) {
        if (text === LINK_PONG) { lastPong = now(); pongs++; return; }
        const m = parseMessage<ToLink>(toLink, text);
        if (!m) return;
        if (m.t === "pong") { lastPong = now(); pongs++; return; }
        if (m.t === "bye") { if (m.reason === "update") { d.log("This version is too old. Get the newest one from the CompCue site."); finish("update"); } return; }
        if (m.t === "game") { void answerGame(client.reader, phase).then((r) => send({ t: "res", id: m.id, ...r })); return; }
        void answerGet(client.reader, m.path, phase).then((r) => send({ t: "res", id: m.id, ...r }));
      },
      close(code, reason) {
        const lasted = opened ? ` after ${Math.round((now() - openedAt) / 1000)} s` : "";
        if (!done) d.log(`Connection to CompCue ${opened ? "closed" : "failed"} (${code}${reason ? ` ${reason}` : ""})${lasted}.`);
        if (code === 401 || code === 4001) { d.log("This computer was removed on the CompCue site. Pair it again."); return finish("unpaired"); }
        finish(opened ? "ok" : "site-closed");
      },
    });
  });
}
