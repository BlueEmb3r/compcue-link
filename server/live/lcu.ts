/**
 * Read-only access to the League client's local API (LCU).
 *
 * It runs on 127.0.0.1 with a self-signed Riot certificate, so certificate checks are relaxed for
 * these loopback requests only (never for the Riot web API). We only ever send GET requests: the
 * app reads what the client already shows you and never picks, bans or clicks anything.
 */
import https from "node:https";
import type { ClientCreds } from "./lockfile.js";

const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

export class HttpError extends Error { constructor(readonly status: number, msg: string) { super(msg); } }

function getJson<T>(port: number, path: string, auth?: string, timeoutMs = 2500): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: "127.0.0.1", port, path, method: "GET", agent, timeout: timeoutMs,
      headers: { Accept: "application/json", ...(auth ? { Authorization: `Basic ${Buffer.from(`riot:${auth}`).toString("base64")}` } : {}) } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if ((res.statusCode ?? 500) >= 400) return reject(new HttpError(res.statusCode ?? 500, `${path} -> ${res.statusCode}`));
        try { resolve(body ? JSON.parse(body) : (null as T)); } catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => req.destroy(new Error(`timeout ${path}`)));
    req.on("error", reject);
    req.end();
  });
}

/**
 * What the live service needs from a League client: read a path. The client on this machine (Lcu) and a
 * client reached through a player's CompCue Link (server/link/remote.ts) both are one.
 */
export interface ClientReader {
  get<T>(path: string): Promise<T>;
  /** null on 404 instead of throwing */
  maybe<T>(path: string): Promise<T | null>;
  /** how the client was found (shown on the Live page) */
  readonly via: ClientCreds["via"] | "link";
}

export class Lcu implements ClientReader {
  constructor(readonly creds: ClientCreds) {}
  get via() { return this.creds.via; }
  get<T>(path: string): Promise<T> { return getJson<T>(this.creds.port, path, this.creds.password); }
  /** null on 404 (e.g. no champ select session right now) instead of throwing. */
  async maybe<T>(path: string): Promise<T | null> {
    try { return await this.get<T>(path); } catch (e) { if (e instanceof HttpError && e.status === 404) return null; throw e; }
  }
}
