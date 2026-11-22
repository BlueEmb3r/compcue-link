//! CompCue Link, the helper on a player's computer.
//!   compcue-link                    pair on first run, then keep running
//!   --setup <key>                   pair with the one-time key from the install command (nothing to confirm)
//!   --pair-only                     pair, then exit (the installer uses it before it starts the app)
//!   --claim-only                    with --setup: trade the key, exit 0 when this computer is paired (the Windows app)
//!   --status                        print where the running helper stands
//!   --unpair                        forget this computer's token
//!   --site <url>  --version
//!
//! Files, all in one folder only this user can read (%APPDATA%\CompCue, ~/Library/Application Support/CompCue):
//!   link.json    the token for the site          status.json  what the tray or menu bar app shows
//!   link.lock    the running helper's pid         link.log     the last lines it printed (never the token)
//!
//! On Windows it is a program without a console (no window ever opens); started from a terminal it still prints there.
#![cfg_attr(windows, windows_subsystem = "windows")]

mod client;
mod contract;
mod session;
mod update;

use serde_json::{json, Value};
use session::VERSION;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

/// The platform's name as the site knows it.
pub const PLATFORM: &str = if cfg!(windows) { "win32" } else if cfg!(target_os = "macos") { "darwin" } else { "linux" };

fn say(line: &str) {
    // no console (the Windows build has none unless started from one) means nowhere to print: never an error
    let _ = writeln!(std::io::stdout(), "{line}");
}

#[derive(Default, Clone)]
struct Status {
    state: String,
    code: Option<String>,
    update: Option<String>,
}

pub struct Ctx {
    pub site: String,
    dir: PathBuf,
    status: Mutex<Status>,
    /// the League client's phase as last read, None until the first read of a connection
    league_phase: Mutex<Option<String>>,
    hint: mpsc::UnboundedSender<String>,
    http: reqwest::Client,
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

/// 2026-11-22T01:02:03.456Z
fn iso(ms: u128) -> String {
    let (secs, millis) = ((ms / 1000) as i64, ms % 1000);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // days since 1970-01-01 to a date (Howard Hinnant's civil_from_days)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let (d, m) = (doy - (153 * mp + 2) / 5 + 1, if mp < 10 { mp + 3 } else { mp - 9 });
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// Write a file only this user can read.
fn write_private(path: &PathBuf, text: &str) -> std::io::Result<()> {
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    o.open(path)?.write_all(text.as_bytes())
}

impl Ctx {
    fn file(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    /// The console, and a small file the tray app and bug reports can read.
    pub fn log(&self, line: &str) {
        say(&format!("[CompCue Link] {line}"));
        let mut o = std::fs::OpenOptions::new();
        o.append(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.mode(0o600);
        }
        if let Ok(mut f) = o.open(self.file("link.log")) {
            let _ = f.write_all(format!("{} {line}\n", iso(now_ms())).as_bytes());
        }
    }

    /// One small file, rewritten when something changes.
    fn write_status(&self, s: &Status) {
        let mut j = json!({ "state": s.state });
        if let Some(c) = &s.code {
            j["code"] = json!(c);
        }
        if let Some(u) = &s.update {
            j["update"] = json!(u);
        }
        j["site"] = json!(self.site);
        j["version"] = json!(VERSION);
        j["pid"] = json!(std::process::id());
        j["at"] = json!(now_ms() as u64);
        let _ = write_private(&self.file("status.json"), &j.to_string());
    }
    fn set(&self, change: impl FnOnce(&mut Status)) {
        let mut s = self.status.lock().unwrap();
        change(&mut s);
        if s.state != "pairing" {
            s.code = None;
        }
        self.write_status(&s);
    }
    /// Where the helper stands (only written when it changed).
    pub fn state(&self, state: &str) {
        if self.status.lock().unwrap().state == state {
            return;
        }
        // a new connection knows nothing about the client's phase until its first read (within 5 s)
        if state == "connected" {
            *self.league_phase.lock().unwrap() = None;
        }
        self.set(|s| s.state = state.to_string());
    }
    pub fn phase(&self, phase: &str) {
        *self.league_phase.lock().unwrap() = Some(phase.to_string());
    }
    /// The site says a newer helper is out: a hint only, the updater looks at the release address itself.
    pub fn latest(&self, version: &str) {
        let _ = self.hint.send(version.to_string());
    }
    fn may_update(&self) -> bool {
        let state = self.status.lock().unwrap().state.clone();
        contract::may_update(&state, self.league_phase.lock().unwrap().as_deref())
    }

    // ---- the token
    fn load(&self) -> Option<String> {
        let j: Value = serde_json::from_str(&std::fs::read_to_string(self.file("link.json")).ok()?).ok()?;
        let token = j.get("token")?.as_str()?;
        (j.get("site")?.as_str()? == self.site && !token.is_empty()).then(|| token.to_string())
    }
    fn save(&self, token: &str) {
        let _ = write_private(&self.file("link.json"), &json!({ "site": self.site, "token": token }).to_string());
    }
    fn forget(&self) {
        let _ = std::fs::remove_file(self.file("link.json"));
    }

    async fn post(&self, path: &str, body: Value) -> Result<reqwest::Response, String> {
        self.http.post(format!("{}{path}", self.site)).json(&body).timeout(Duration::from_secs(15)).send().await.map_err(|e| if e.is_timeout() { "no answer".to_string() } else { "no connection".to_string() })
    }

    /// The short way: the one-time key from the install command. None when it no longer works (then the code is used).
    async fn claim(&self, key: &str) -> Option<String> {
        let mut me = me();
        me["key"] = json!(key);
        match self.post("/api/link/claim", me).await {
            Err(e) => {
                self.log(&format!("Can't reach {} ({e}).", self.site));
                None
            }
            Ok(r) if !r.status().is_success() => {
                self.log("That install command ran out. Pairing with a code instead.");
                None
            }
            Ok(r) => {
                let j: Value = r.json().await.ok()?;
                let token = j.get("token")?.as_str().filter(|t| contract::good_token(t))?;
                self.save(token);
                self.log("Paired.");
                Some(token.to_string())
            }
        }
    }

    /// The code way: a short code the player confirms in the browser. Returns the token.
    async fn pair(&self) -> String {
        loop {
            match self.pair_once().await {
                Ok(Some(token)) => return token,
                Ok(None) => self.log("The code ran out. Here is a new one."),
                Err(e) => {
                    self.set(|s| s.state = "offline".into());
                    self.log(&format!("Can't reach {} ({e}). Trying again in 15 s.", self.site));
                    tokio::time::sleep(Duration::from_secs(15)).await;
                }
            }
        }
    }
    async fn pair_once(&self) -> Result<Option<String>, String> {
        let r = self.post("/api/link/start", me()).await?;
        if !r.status().is_success() {
            return Err(format!("start -> {}", r.status().as_u16()));
        }
        let s: Value = r.json().await.map_err(|_| "unexpected answer")?;
        // nothing the site sent is printed or opened as it came: the code must have the code's shape, and the
        // page address is built here from the site this helper was started with
        let code = match s.get("code") {
            Some(Value::String(c)) => contract::normalize_code(c),
            Some(c) => contract::normalize_code(&c.to_string()),
            None => String::new(),
        };
        let device = s.get("device").and_then(|d| d.as_str()).filter(|d| d.encode_utf16().count() <= 200);
        let (Some(device), false) = (device, code.is_empty()) else { return Err("unexpected answer".into()) };
        let url = format!("{}/#/link?code={code}", self.site);
        self.set(|s| {
            s.state = "pairing".into();
            s.code = Some(code.clone());
        });
        self.log(&format!("Confirm this code in your browser: {code}"));
        self.log(&format!("If the page did not open, go to {url}"));
        open_browser(&url);
        let expires = s.get("expiresInMs").and_then(|e| e.as_f64()).filter(|e| e.is_finite() && *e > 0.0).unwrap_or(0.0);
        let until = tokio::time::Instant::now() + Duration::from_millis((expires as u64).min(15 * 60_000));
        while tokio::time::Instant::now() < until {
            tokio::time::sleep(Duration::from_secs(2)).await;
            // paired meanwhile from the site's "Connect this PC" button (the app claimed a one-time key): use that
            if let Some(token) = self.load() {
                self.log("Paired.");
                return Ok(Some(token));
            }
            let t = self.post("/api/link/token", json!({ "device": device })).await?;
            match t.status().as_u16() {
                200 => {
                    let j: Value = t.json().await.map_err(|_| "unexpected answer")?;
                    let token = j.get("token").and_then(|t| t.as_str()).filter(|t| contract::good_token(t)).ok_or("unexpected answer")?;
                    self.save(token);
                    self.log("Paired.");
                    return Ok(Some(token.to_string()));
                }
                410 => break,
                _ => {}
            }
        }
        Ok(None)
    }
}

fn me() -> Value {
    json!({ "platform": PLATFORM, "name": gethostname::gethostname().to_string_lossy() })
}

fn open_browser(url: &str) {
    if std::env::var("COMPCUE_NO_BROWSER").as_deref() == Ok("1") {
        return;
    }
    let mut cmd;
    if cfg!(windows) {
        cmd = std::process::Command::new("rundll32");
        cmd.args(["url.dll,FileProtocolHandler", url]);
    } else {
        cmd = std::process::Command::new(if cfg!(target_os = "macos") { "open" } else { "xdg-open" });
        cmd.arg(url);
    }
    // the code is printed too, so a browser that does not open is not an error
    let _ = cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn();
}

/// Is a process with this id running?
fn alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        // signal 0 sends nothing: it only asks. "Not permitted" still means the process is there.
        let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
        r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return false;
            }
            let mut code = 0u32;
            let ok = GetExitCodeProcess(h, &mut code) != 0;
            CloseHandle(h);
            ok && code == STILL_ACTIVE as u32
        }
    }
}

fn data_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("COMPCUE_DIR").filter(|d| !d.is_empty()) {
        return PathBuf::from(d);
    }
    let home = || PathBuf::from(std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default());
    if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(home).join("CompCue")
    } else if cfg!(target_os = "macos") {
        home().join("Library").join("Application Support").join("CompCue")
    } else {
        std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".config")).join("compcue")
    }
}

fn main() {
    // started from a terminal on Windows: print there (a program without a console has to ask for its parent's)
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
        AttachConsole(ATTACH_PARENT_PROCESS);
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    let has = |k: &str| args.iter().any(|a| a == k);
    let arg = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned();
    if has("--version") {
        say(VERSION);
        return;
    }

    let site = arg("--site").or_else(|| std::env::var("COMPCUE_SITE").ok().filter(|s| !s.is_empty())).unwrap_or_else(|| "https://compcue.aflince.com".into());
    let site = site.trim_end_matches('/').to_string();
    // the token is only ever sent to this site: refuse anything but https (plain http only on this same computer)
    if !contract::site_allowed(&site) {
        let _ = writeln!(std::io::stderr(), "[CompCue Link] {site} is not allowed: the site must be https.");
        std::process::exit(1);
    }
    let dir = data_dir();
    {
        let mut b = std::fs::DirBuilder::new();
        b.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            b.mode(0o700);
        }
        let _ = b.create(&dir);
    }

    let _ = rustls::crypto::ring::default_provider().install_default();
    let (hint, hints) = mpsc::unbounded_channel();
    let ctx = Arc::new(Ctx {
        site,
        dir,
        status: Mutex::new(Status { state: "pairing".into(), ..Default::default() }),
        league_phase: Mutex::new(None),
        hint,
        // straight to the site: what a proxy variable says is not for this program (the League client is on this computer)
        http: reqwest::Client::builder().no_proxy().build().expect("http client"),
    });

    if has("--status") {
        say(&std::fs::read_to_string(ctx.file("status.json")).unwrap_or_else(|_| r#"{"state":"stopped"}"#.into()));
        return;
    }
    if has("--unpair") {
        ctx.forget();
        say("[CompCue Link] This computer is no longer paired.");
        return;
    }

    // a log that grew past 512 KB starts again
    if std::fs::metadata(ctx.file("link.log")).map(|m| m.len() > 512 * 1024).unwrap_or(false) {
        let _ = std::fs::remove_file(ctx.file("link.log"));
    }

    // ---- one helper per user: a second start leaves the first alone
    let pair_only = has("--pair-only") || has("--claim-only");
    if !pair_only {
        let other: u32 = std::fs::read_to_string(ctx.file("link.lock")).ok().and_then(|t| t.trim().parse().ok()).unwrap_or(0);
        if other != 0 && other != std::process::id() && alive(other) {
            say("[CompCue Link] Already running.");
            return;
        }
        let _ = write_private(&ctx.file("link.lock"), &std::process::id().to_string());
    }

    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
    rt.block_on(async move {
        if !pair_only {
            // asked to stop (Ctrl+C, the menu bar app quitting): leave the lock and say so in the status file
            let c = ctx.clone();
            tokio::spawn(async move {
                stop_signal().await;
                if std::fs::read_to_string(c.file("link.lock")).ok().as_deref() == Some(&std::process::id().to_string()) {
                    let _ = std::fs::remove_file(c.file("link.lock"));
                }
                c.set(|s| s.state = "stopped".into());
                std::process::exit(0);
            });
        }

        ctx.log(&format!("version {VERSION}, site {}", ctx.site));
        if let Some(key) = arg("--setup") {
            if ctx.load().is_none() {
                ctx.claim(&key).await;
            }
        }
        // the Windows app's "Connect this PC": trade the key and say whether it worked, nothing else
        if has("--claim-only") {
            std::process::exit(if ctx.load().is_some() { 0 } else { 1 });
        }
        if pair_only {
            if ctx.load().is_none() {
                ctx.pair().await;
            }
            std::process::exit(0);
        }

        if std::env::var("COMPCUE_NO_UPDATE").as_deref() != Ok("1") {
            tokio::spawn(update::run(ctx.clone(), hints));
        }

        loop {
            let token = match ctx.load() {
                Some(t) => t,
                None => ctx.pair().await,
            };
            ctx.set(|s| s.state = "waiting".into());
            ctx.log("Waiting for the League client.");
            match session::run_link(&token, &ctx).await {
                session::LinkEnd::Update => tokio::time::sleep(Duration::from_secs(3600)).await,
                session::LinkEnd::Unpaired => ctx.forget(),
            }
        }
    });
}

async fn stop_signal() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("signal");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[cfg(test)]
mod tests;
