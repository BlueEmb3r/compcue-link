/**
 * CompCue Link: the wire between the small helper on a player's computer and the site.
 *
 * The helper finds the League client (server/live/lockfile.ts), reads it on 127.0.0.1 (lcu.ts, lcuSocket.ts)
 * and holds ONE outbound WebSocket to the site. Nothing listens on the player's machine. Over that socket:
 *   helper -> site   hello, client (League open or closed), event (a client event), res (answer to a get)
 *   site -> helper   get (read one allowlisted path), bye
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

/** While a game is being played the helper forwards nothing but the phase itself (Riot: no in-game help). */
export const QUIET_PHASES = ["InProgress", "Reconnect"];

export const fromLink = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), v: z.number().int(), version: z.string().max(40), platform: z.string().max(20) }),
  z.object({ t: z.literal("client"), up: z.boolean(), via: z.enum(["lockfile", "process"]).optional() }),
  z.object({ t: z.literal("event"), uri: z.string().max(200), eventType: z.string().max(20), data: z.unknown() }),
  z.object({ t: z.literal("res"), id: z.number().int(), status: z.number().int(), body: z.unknown().optional() }),
]);
export type FromLink = z.infer<typeof fromLink>;

export const toLink = z.discriminatedUnion("t", [
  z.object({ t: z.literal("get"), id: z.number().int(), path: z.string().max(200) }),
  z.object({ t: z.literal("bye"), reason: z.string().max(200), minVersion: z.string().max(40).optional() }),
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
