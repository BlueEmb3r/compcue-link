/**
 * Finding the running League client (LCU) on macOS and Windows.
 *
 * The client writes a `lockfile` into its install folder while it runs:
 *   LeagueClient:<pid>:<port>:<password>:<protocol>
 * If the install folder is not where we expect, the same port and password are on the
 * LeagueClientUx process command line (--app-port=, --remoting-auth-token=, --install-directory=).
 *
 * Everything here is pure or takes its side effects as arguments, so the path logic is unit-tested
 * for both platforms on any machine (tests/live-lockfile.test.ts).
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface ClientCreds { port: number; password: string; protocol: string; pid?: number; installDir?: string; via: "lockfile" | "process" }
export type Platform = "darwin" | "win32" | "linux";

/** Install folders to try, most likely first. LEAGUE_PATH (env) always wins. */
export function candidateDirs(platform: Platform, env: Record<string, string | undefined> = {}): string[] {
  const out: string[] = [];
  if (env.LEAGUE_PATH) out.push(env.LEAGUE_PATH);
  if (platform === "darwin") {
    out.push("/Applications/League of Legends.app/Contents/LoL");
    if (env.HOME) out.push(`${env.HOME}/Applications/League of Legends.app/Contents/LoL`);
  } else if (platform === "win32") {
    const drives = ["C", "D", "E", "F"];
    for (const d of drives) out.push(`${d}:\\Riot Games\\League of Legends`);
    for (const pf of [env.ProgramFiles, env["ProgramFiles(x86)"]].filter(Boolean)) out.push(`${pf}\\Riot Games\\League of Legends`);
  }
  return [...new Set(out)];
}

/** Join with the platform's separator, so Windows paths stay Windows paths when tested on a Mac. */
export const joinFor = (platform: Platform, dir: string, file: string) => (platform === "win32" ? path.win32.join(dir, file) : path.posix.join(dir, file));

export function parseLockfile(text: string): Omit<ClientCreds, "via"> | null {
  const parts = text.trim().split(":");
  if (parts.length < 5) return null;
  const [, pid, port, password, protocol] = parts;
  const p = Number(port);
  if (!Number.isInteger(p) || p <= 0 || !password) return null;
  return { pid: Number(pid) || undefined, port: p, password, protocol: protocol || "https" };
}

/** Pull port, token and install folder out of a LeagueClientUx command line (macOS ps or Windows CIM output). */
export function parseCommandLine(cmd: string): Omit<ClientCreds, "via"> | null {
  const get = (k: string) => cmd.match(new RegExp(`--${k}=(?:"([^"]+)"|([^\\s"]+))`))?.slice(1).find(Boolean);
  const port = Number(get("app-port"));
  const password = get("remoting-auth-token");
  if (!Number.isInteger(port) || port <= 0 || !password) return null;
  const installDir = get("install-directory");
  return { port, password, protocol: "https", installDir };
}

type Exec = (file: string, args: string[]) => Promise<string>;
const execText: Exec = (file, args) => new Promise((resolve) => {
  execFile(file, args, { timeout: 4000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (_e, stdout) => resolve(String(stdout ?? "")));
});

/** Command lines of running LeagueClientUx processes. */
export async function clientCommandLines(platform: Platform, exec: Exec = execText): Promise<string[]> {
  if (platform === "win32") {
    const out = await exec("powershell.exe", ["-NoProfile", "-Command",
      "Get-CimInstance Win32_Process -Filter \"name='LeagueClientUx.exe'\" | Select-Object -ExpandProperty CommandLine"]);
    return out.split(/\r?\n/).filter((l) => l.includes("--app-port="));
  }
  const out = await exec("ps", ["-A", "-ww", "-o", "args="]);
  return out.split("\n").filter((l) => /LeagueClientUx/.test(l) && l.includes("--app-port="));
}

export interface FindDeps {
  platform?: Platform;
  env?: Record<string, string | undefined>;
  exists?: (p: string) => boolean;
  read?: (p: string) => string;
  exec?: Exec;
}

/** Locate the running client. Returns null when League is not running (no lockfile, no process). */
export async function findClient(deps: FindDeps = {}): Promise<ClientCreds | null> {
  const platform = deps.platform ?? (process.platform as Platform);
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const read = deps.read ?? ((p: string) => readFileSync(p, "utf8"));
  for (const dir of candidateDirs(platform, env)) {
    const f = joinFor(platform, dir, "lockfile");
    if (!exists(f)) continue;
    try {
      const c = parseLockfile(read(f));
      if (c) return { ...c, installDir: dir, via: "lockfile" };
    } catch { /* lockfile is briefly locked while the client starts; fall through */ }
  }
  for (const line of await clientCommandLines(platform, deps.exec)) {
    const c = parseCommandLine(line);
    if (c) {
      // prefer the lockfile in the reported folder (it has the current password if the client restarted)
      if (c.installDir) {
        const f = joinFor(platform, c.installDir, "lockfile");
        try { if (exists(f)) { const lf = parseLockfile(read(f)); if (lf) return { ...lf, installDir: c.installDir, via: "lockfile" }; } } catch { /* use the command line */ }
      }
      return { ...c, via: "process" };
    }
  }
  return null;
}
