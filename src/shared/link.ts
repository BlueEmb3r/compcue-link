/**
 * CompCue Link: the wire between the small helper on a player's computer and the site.
 *
 * The helper finds the League client (server/live/lockfile.ts), reads it on 127.0.0.1 (lcu.ts, lcuSocket.ts)
 * and holds ONE outbound WebSocket to the site. Nothing listens on the player's machine. Over that socket:
 *   helper -> site   hello, client (League open or closed), event (a client event), res (answer to a get), ping
 *   site -> helper   get (read one allowlisted path), game (read the scoreboard during a game), bye, pong
 *
 * Heartbeat: the helper sends LINK_PING every LINK_BEAT_MS and the site answers LINK_PONG. Cloudflare answers
 * WebSocket protocol pings at its edge, so those keep coming back even when the server behind the socket is gone
 * (a redeploy); the text ping has to reach the site's own code (hosted: the Durable Object's auto-response, which
 * does not wake it), so a missing pong means the site lost this socket and the helper dials again. The site drops
 * a helper that announced a beat (hello.beat) and has been silent for LINK_SILENT_MS.
 *
 * This file is the whole contract, pure and shared by both ends:
 * - ALLOWED_GETS / ALLOWED_TOPICS: everything the helper will ever read from the client. It is enforced
 *   inside the helper, so the site (even a broken or hostile one) cannot make it read anything else, and
 *   it is the endpoint list registered with Riot. Read-only: there is no message that writes to the client.
 * - the message shapes, checked with zod on arrival (each end treats the other as untrusted input).
 * - pairing codes (the short code a player confirms in the browser).
 */
import { z } from "zod";

export const LINK_PROTOCOL = 1;
/** The heartbeat, exact strings (the hosted Durable Object answers it with setWebSocketAutoResponse, which matches text exactly). */
export const LINK_PING = '{"t":"ping"}';
export const LINK_PONG = '{"t":"pong"}';
/** How often the helper pings; it reconnects when no pong came for LINK_PONG_LATE_MS (after it has seen one). */
export const LINK_BEAT_MS = 15_000;
export const LINK_PONG_LATE_MS = 40_000;
/** The site drops a beating helper it has not heard from for this long. */
export const LINK_SILENT_MS = 50_000;
/** Largest message either end accepts (a champ select session is about 10 KB, a match history page under 400 KB). */
export const LINK_MAX_BYTES = 1024 * 1024;

const PUUID = "[0-9a-f-]{20,80}";
/** Every client path the helper may GET. Anything else is refused on the player's machine. */
export const ALLOWED_GETS: RegExp[] = [
  /^\/lol-gameflow\/v1\/gameflow-phase$/,
  /^\/lol-gameflow\/v1\/session$/,
  /^\/lol-champ-select\/v1\/session$/,
  /^\/lol-lobby\/v2\/lobby$/,
  /^\/lol-summoner\/v1\/current-summoner$/,
  /^\/riotclient\/region-locale$/,
  /^\/lol-champions\/v1\/owned-champions-minimal$/,
  /^\/lol-champion-mastery\/v1\/local-player\/champion-mastery$/,
  new RegExp(`^/lol-match-history/v1/products/lol/(current-summoner|${PUUID})/matches\\?begIndex=0&endIndex=(20|40)$`),
  new RegExp(`^/lol-ranked/v1/ranked-stats/${PUUID}$`),
];
export const allowedGet = (path: string): boolean => typeof path === "string" && path.length < 200 && ALLOWED_GETS.some((r) => r.test(path));

/** Client event topics the helper forwards (the same three the local app subscribes to). */
export const ALLOWED_TOPICS = ["/lol-champ-select/v1/session", "/lol-gameflow/v1/gameflow-phase", "/lol-lobby/v2/lobby"];
export const allowedTopic = (uri: string): boolean => ALLOWED_TOPICS.includes(uri);

// ---- data minimisation: what leaves the player's computer ----------------------------------------------------

/**
 * Keys that never leave the computer, wherever they appear: the client keeps chat tokens and the game server's
 * address and keys in the same objects as the draft, and the site has no use for any of them.
 */
const NEVER = /^(mucJwtDto|multiUserChatJWT|multiUserChatPassword|multiUserChatId|playerCredentials|encryptionKey|observerEncryptionKey|observerServerIp|observerServerPort|serverIp|serverPort|password|gameClient|chatDetails|chatRoomName|chatRoomPassword|idToken|accessToken|entitlementsToken|summonerInternalName|accountId)$/i;
function strip(v: unknown, depth = 0): unknown {
  if (depth > 12 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => strip(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!NEVER.test(k)) out[k] = strip(x, depth + 1);
  return out;
}
const pick = (o: unknown, keys: string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  if (o && typeof o === "object") for (const k of keys) if (k in (o as object)) out[k] = (o as Record<string, unknown>)[k];
  return out;
};
const PLAYER_KEYS = ["puuid", "championId", "gameName", "tagLine", "selectedPosition", "team"];
/**
 * The body of one read or event, cut down to what the site uses before it is sent. The three objects that carry
 * more than the draft are cut to named fields (the champ select session, the lobby, the game flow session);
 * everything loses the NEVER keys.
 */
export function minimize(path: string, body: unknown): unknown {
  if (body === null || typeof body !== "object") return body;
  const p = path.split("?")[0];
  if (p === "/lol-champ-select/v1/session") return strip(pick(body, ["localPlayerCellId", "myTeam", "theirTeam", "actions", "bans", "timer", "isSpectating", "gameId"]));
  if (p === "/lol-lobby/v2/lobby") {
    const members = (body as { members?: unknown }).members;
    return { members: Array.isArray(members) ? members.map((m) => pick(m, ["puuid"])) : [] };
  }
  if (p === "/lol-gameflow/v1/session") {
    const gd = (body as { gameData?: { queue?: unknown; teamOne?: unknown; teamTwo?: unknown } }).gameData;
    const team = (t: unknown) => (Array.isArray(t) ? t.map((x) => pick(x, PLAYER_KEYS)) : []);
    return { gameData: { queue: pick(gd?.queue, ["id"]), teamOne: team(gd?.teamOne), teamTwo: team(gd?.teamTwo) } };
  }
  return strip(body);
}

/** The site this helper may talk to: https only, or plain http on this same computer (development). */
export function siteAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.username || u.password) return false;
    return u.protocol === "https:" || (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname));
  } catch { return false; }
}

/**
 * While a game is being played the helper forwards nothing from the League client but the phase itself.
 * The one thing it reads during a game is the scoreboard (below), and only when the site asks.
 */
export const QUIET_PHASES = ["InProgress", "Reconnect"];

/**
 * The scoreboard of the game in progress: the one read outside the League client. It is the game's own local
 * API on the player's computer (https://127.0.0.1:2999/liveclientdata/playerlist), what the player sees with Tab.
 * The site cannot name a path: the `game` message has none, the helper reads exactly this, only while the phase
 * is InProgress, and sends only champion, side, level and item ids (no names, no scores, no gold).
 */
export const GAME_PHASE = "InProgress";
export function minimizeGame(body: unknown): unknown {
  if (!Array.isArray(body)) return null;
  return body.slice(0, 12).map((p) => ({
    ...pick(p, ["championName", "rawChampionName", "team", "level"]),
    items: Array.isArray((p as { items?: unknown })?.items) ? (p as { items: unknown[] }).items.slice(0, 12).map((i) => pick(i, ["itemID"])) : [],
  }));
}

export const fromLink = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), v: z.number().int(), version: z.string().max(40), platform: z.string().max(20), beat: z.number().int().min(1000).max(600_000).optional(),
    // game: this helper can read the scoreboard during a game (the `game` message)
    game: z.boolean().optional() }),
  // events: whether the client's event socket is up on the helper's side (false: the site falls back to reading)
  z.object({ t: z.literal("client"), up: z.boolean(), via: z.enum(["lockfile", "process"]).optional(), events: z.boolean().optional() }),
  z.object({ t: z.literal("ping") }),
  z.object({ t: z.literal("event"), uri: z.string().max(200), eventType: z.string().max(20), data: z.unknown() }),
  z.object({ t: z.literal("res"), id: z.number().int(), status: z.number().int(), body: z.unknown().optional() }),
]);
export type FromLink = z.infer<typeof fromLink>;

export const toLink = z.discriminatedUnion("t", [
  z.object({ t: z.literal("get"), id: z.number().int(), path: z.string().max(200) }),
  z.object({ t: z.literal("bye"), reason: z.string().max(200), minVersion: z.string().max(40).optional() }),
  z.object({ t: z.literal("pong") }),
  // read the scoreboard of the game in progress (no path: the helper reads one fixed thing); answered with `res`
  z.object({ t: z.literal("game"), id: z.number().int() }),
]);
export type ToLink = z.infer<typeof toLink>;

export function parseMessage<T>(schema: { safeParse: (x: unknown) => { success: boolean; data?: T } }, raw: string): T | null {
  if (!raw || raw.length > LINK_MAX_BYTES) return null;
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return null; }
  const r = schema.safeParse(j);
  return r.success ? (r.data as T) : null;
}

// ---- pairing: a short code the player confirms in the browser -------------------------------------------------

/** No 0/O, 1/I/L, so the code reads the same on screen and aloud. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_TTL_MS = 10 * 60_000;
/** "KDA-4F7Q" style: 7 characters from 31 (about 27 billion), valid for 10 minutes, a few tries per browser. */
export function userCode(randomBytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < 7; i++) s += CODE_ALPHABET[randomBytes[i] % CODE_ALPHABET.length];
  return `${s.slice(0, 3)}-${s.slice(3)}`;
}
export const normalizeCode = (s: string): string => {
  const c = String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return c.length === 7 ? `${c.slice(0, 3)}-${c.slice(3)}` : "";
};

/** Semver-ish compare for the site's "this helper is too old" check. */
export function olderThan(version: string, min: string): boolean {
  const n = (v: string) => v.split(".").map((x) => parseInt(x, 10) || 0);
  const a = n(version), b = n(min);
  for (let i = 0; i < 3; i++) { if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0); }
  return false;
}
