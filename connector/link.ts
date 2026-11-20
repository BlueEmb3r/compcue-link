/**
 * CompCue Link, the helper on a player's computer. All it does:
 *   1. wait until the League client is open (server/live/lockfile.ts: the same finder the local app uses)
 *   2. hold one outbound WebSocket to the site, recognised by the token from pairing
 *   3. answer the site's read requests from the allowlist (src/shared/link.ts) and forward three client events
 *
 * Read-only by construction: the only calls it can make to the client are GETs on ALLOWED_GETS. Nothing listens
 * on this computer, the client's port and password never leave it, and while a game is being played it goes
 * quiet (only the game phase and the already-locked teams can be read). No connection to the site exists
 * while League is closed. Every body is cut down before it is sent (minimize): chat tokens, the game server's
 * address and keys and anything else the site does not use stay on this computer.
 *
 * Side effects come in as `deps`, so tests run it against a fake client and a fake site (tests/link.test.ts).
 */
import { allowedGet, allowedTopic, LINK_PROTOCOL, minimize, parseMessage, QUIET_PHASES, toLink, type FromLink, type ToLink } from "../src/shared/link.js";
import type { ClientReader } from "../server/live/lcu.js";
import type { LcuEvent } from "../server/live/lcuSocket.js";

export const LINK_VERSION = "0.1.0";

/** Reads allowed in every phase (the phase itself, and the session that names the locked teams at game start). */
const ALWAYS = ["/lol-gameflow/v1/gameflow-phase", "/lol-gameflow/v1/session"];

export interface SiteSocket { send(text: string): void; close(): void }
export interface SiteHandlers { open(): void; message(text: string): void; close(code: number): void }
export interface LinkDeps {
  /** the running League client, or null (found again on every call) */
  findClient(): Promise<{ reader: ClientReader; events(on: (e: LcuEvent) => void, down: () => void): { close(): void } } | null>;
  /** open the socket to the site with this token; `status` 401 on close means the token no longer works */
  dial(token: string, h: SiteHandlers): SiteSocket;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  platform: string;
}

export type LinkEnd = "unpaired" | "update" | "stopped";

/** One answer to a `get`, as the helper decides it. Exported for the allowlist tests. */
export async function answerGet(reader: ClientReader, path: string, phase: string): Promise<{ status: number; body?: unknown }> {
  if (!allowedGet(path)) return { status: 403 };
  if (QUIET_PHASES.includes(phase) && !ALWAYS.includes(path)) return { status: 409 };
  try { return { status: 200, body: minimize(path, await reader.get<unknown>(path)) }; }
  catch (e) { const s = (e as { status?: unknown })?.status; return { status: typeof s === "number" ? s : 502 }; }
}

/**
 * Runs until the token is refused ("unpaired": pair again), the site asks for a newer helper ("update"),
 * or `stop` is set.
 */
export async function runLink(token: string, d: LinkDeps, stop: { now: boolean } = { now: false }): Promise<LinkEnd> {
  let backoff = 1000;
  while (!stop.now) {
    const client = await d.findClient().catch(() => null);
    if (!client) { await d.sleep(3000); continue; }
    d.log("League client found. Connecting to CompCue.");
    const end = await session(token, client, d, stop);
    if (end === "unpaired" || end === "update") return end;
    if (end === "ok") backoff = 1000; else backoff = Math.min(backoff * 2, 60_000);
    if (!stop.now) await d.sleep(end === "client-closed" ? 1000 : backoff);
  }
  return "stopped";
}

type SessionEnd = "unpaired" | "update" | "client-closed" | "site-closed" | "ok";

function session(token: string, client: NonNullable<Awaited<ReturnType<LinkDeps["findClient"]>>>, d: LinkDeps, stop: { now: boolean }): Promise<SessionEnd> {
  return new Promise((resolve) => {
    let phase = "None", done = false, opened = false, events: { close(): void } | null = null, check: Promise<void> | null = null;
    const finish = (end: SessionEnd) => { if (done) return; done = true; events?.close(); try { site.close(); } catch { /* already closed */ } resolve(end); };
    const send = (m: FromLink) => { if (!done) site.send(JSON.stringify(m)); };
    const site: SiteSocket = d.dial(token, {
      open() {
        opened = true;
        send({ t: "hello", v: LINK_PROTOCOL, version: LINK_VERSION, platform: d.platform });
        send({ t: "client", up: true, via: client.reader.via === "process" ? "process" : "lockfile" });
        d.log("Connected. You can go back to the CompCue page.");
        events = client.events((e) => {
          if (!allowedTopic(e.uri)) return;
          if (e.uri === "/lol-gameflow/v1/gameflow-phase" && typeof e.data === "string") phase = e.data;
          else if (QUIET_PHASES.includes(phase)) return;
          send({ t: "event", uri: e.uri, eventType: e.eventType, data: minimize(e.uri, e.data) });
        }, () => { /* the event socket dropped: the liveness check below decides whether the client is gone */ });
        // the client's own lifetime: when it stops answering, tell the site and leave (no idle connection)
        check = (async () => {
          while (!done && !stop.now) {
            await d.sleep(5000);
            if (done) return;
            const r = await answerGet(client.reader, "/lol-gameflow/v1/gameflow-phase", "None");
            if (r.status === 200 && typeof r.body === "string") phase = r.body;
            else if (r.status === 502) { send({ t: "client", up: false }); d.log("League client closed."); return finish("client-closed"); }
          }
          if (stop.now) finish("ok");
        })();
        void check;
      },
      message(text) {
        const m = parseMessage<ToLink>(toLink, text);
        if (!m) return;
        if (m.t === "bye") { if (m.reason === "update") { d.log("This version is too old. Get the newest one from the CompCue site."); finish("update"); } return; }
        void answerGet(client.reader, m.path, phase).then((r) => send({ t: "res", id: m.id, ...r }));
      },
      close(code) {
        if (code === 401 || code === 4001) { d.log("This computer was removed on the CompCue site. Pair it again."); return finish("unpaired"); }
        finish(opened ? "ok" : "site-closed");
      },
    });
  });
}
