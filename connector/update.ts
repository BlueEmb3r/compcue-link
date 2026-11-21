/**
 * Updates for the copies that no store updates (the Mac app from the installer).
 *
 * Releases live on GitHub (BlueEmb3r/compcue-link). Each one carries version.json; the helper reads it every half hour
 * from that fixed address, never from the CompCue site, so the site cannot push code to a player's machine.
 * The site may say "a newer version is out" (a version number, on connect): that only makes the helper look here sooner.
 * On a Mac the update is the release's own installer run again with --update: it checks the download against the
 * release's SHA256SUMS, swaps the app and starts it. The token and settings are kept.
 */
import { spawn } from "node:child_process";
import { olderThan } from "../src/shared/link.js";

export const RELEASES = "https://github.com/BlueEmb3r/compcue-link/releases/latest/download";

/** The newer version's number, or null (up to date, offline, or an answer that is not a version). */
export async function checkForUpdate(current: string, get: (url: string) => Promise<unknown> = fetchJson): Promise<string | null> {
  try {
    const j = (await get(`${RELEASES}/version.json`)) as { version?: unknown };
    const v = typeof j?.version === "string" && /^\d+\.\d+\.\d+$/.test(j.version) ? j.version : null;
    return v && olderThan(current, v) ? v : null;
  } catch { return null; }
}
async function fetchJson(url: string): Promise<unknown> {
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

/** True when this helper runs inside the Mac app the installer made (the only copy that updates itself). */
export const inMacApp = (execPath: string = process.execPath, platform: string = process.platform) => platform === "darwin" && /\.app\/Contents\/MacOS\/[^/]+$/.test(execPath);

/** Start the release's installer in update mode, detached: it replaces and restarts the app this helper runs in. */
export function runMacUpdate(log: (l: string) => void): boolean {
  if (!inMacApp()) return false;
  try {
    const child = spawn("/bin/sh", ["-c", `curl -fsSL "${RELEASES}/install.sh" | sh -s -- --update`], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch (e) { log(`Update could not start (${e instanceof Error ? e.message : e}).`); return false; }
}
