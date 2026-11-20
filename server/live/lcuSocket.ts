/**
 * The League client's event socket (WAMP 1.0 over wss on the same port and password as its REST API).
 * We subscribe to champ select and game flow, so a lock, hover or phase change reaches the server the
 * moment the client knows it, instead of on the next poll. Read-only: we only ever send subscriptions.
 *
 * Message shapes: subscribe = [5, "OnJsonApiEvent_<path with / as _>"]; event = [8, topic, { data, eventType, uri }].
 */
import WebSocket from "ws";
import type { ClientCreds } from "./lockfile.js";

export interface LcuEvent { uri: string; eventType: "Create" | "Update" | "Delete" | string; data: unknown }
export const TOPICS = ["/lol-champ-select/v1/session", "/lol-gameflow/v1/gameflow-phase", "/lol-lobby/v2/lobby"];
export const topicOf = (uri: string) => `OnJsonApiEvent${uri.replace(/\//g, "_")}`;
export const subscribeFrames = (uris: string[] = TOPICS) => uris.map((u) => JSON.stringify([5, topicOf(u)]));

/** One socket frame -> the event it carries, or null (welcome frames, empty keep-alives, anything malformed). */
export function parseFrame(text: string): LcuEvent | null {
  if (!text) return null;
  let m: unknown;
  try { m = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(m) || m[0] !== 8 || typeof m[2] !== "object" || !m[2]) return null;
  const p = m[2] as { uri?: unknown; eventType?: unknown; data?: unknown };
  if (typeof p.uri !== "string") return null;
  return { uri: p.uri, eventType: typeof p.eventType === "string" ? p.eventType : "Update", data: p.data };
}

export class LcuSocket {
  private ws: WebSocket | null = null;
  private closed = false;
  /** true between a successful open and the close: events are flowing */
  up = false;
  constructor(private creds: ClientCreds, private onEvent: (e: LcuEvent) => void, private onDown: (reason: string) => void = () => {}, private onUp: () => void = () => {}) {}

  open() {
    if (this.ws || this.closed) return;
    const ws = new WebSocket(`wss://127.0.0.1:${this.creds.port}/`, "wamp", {
      headers: { Authorization: `Basic ${Buffer.from(`riot:${this.creds.password}`).toString("base64")}` },
      // loopback only, self-signed Riot certificate (same as the REST reads in lcu.ts)
      rejectUnauthorized: false, handshakeTimeout: 4000,
    });
    this.ws = ws;
    ws.on("open", () => { this.up = true; for (const f of subscribeFrames()) ws.send(f); this.onUp(); });
    ws.on("message", (raw) => { const e = parseFrame(String(raw)); if (e) this.onEvent(e); });
    const down = (reason: string) => { if (this.ws !== ws) return; this.ws = null; const was = this.up; this.up = false; if (was || !this.closed) this.onDown(reason); };
    ws.on("close", (code) => down(`closed ${code}`));
    ws.on("error", (e) => { try { ws.terminate(); } catch { /* already gone */ } down(`error: ${String((e as Error)?.message ?? e).slice(0, 80)}`); });
  }
  close() { this.closed = true; this.up = false; const ws = this.ws; this.ws = null; try { ws?.terminate(); } catch { /* already gone */ } }
}
