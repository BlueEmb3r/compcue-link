//! Updates for the copies that no store updates.
//!
//! Releases live on GitHub (BlueEmb3r/compcue-link). Each one carries version.json; the helper reads it every half
//! hour from that fixed address, never from the CompCue site, so the site cannot push code to a player's machine.
//! The site may say "a newer version is out" (a version number, on connect): that only makes the helper look here
//! sooner. A hinted release that is not up yet is looked for every 2 minutes for an hour.
//!
//! On a Mac the update is the release's own installer run again with --update: it checks the download against the
//! release's SHA256SUMS, swaps the app and starts it. On Windows the helper only writes the newer version into
//! status.json: the tray app installs it (the zip copy), or the Microsoft Store does.
//! Never during a queue, a champ select or a game (contract::may_update): a newer version found then waits and is
//! tried again every 2 minutes, so it goes in as soon as the player is back in the client.
use crate::contract::{older_than, version_shaped};
use crate::session::VERSION;
use crate::Ctx;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

pub const RELEASES: &str = "https://github.com/BlueEmb3r/compcue-link/releases/latest/download";

/// The newer version's number, or None (up to date, offline, or an answer that is not a version).
async fn check_for_update(http: &reqwest::Client) -> Option<String> {
    let r = http.get(format!("{RELEASES}/version.json")).timeout(Duration::from_secs(15)).send().await.ok()?;
    if !r.status().is_success() {
        return None;
    }
    let j: serde_json::Value = r.json().await.ok()?;
    let v = j.get("version")?.as_str()?;
    (version_shaped(v) && older_than(VERSION, v)).then(|| v.to_string())
}

/// True when this helper runs inside the Mac app the installer made (the only copy that updates itself this way).
fn in_mac_app() -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    match exe.rsplit_once('/') {
        Some((dir, name)) => !name.is_empty() && dir.ends_with(".app/Contents/MacOS"),
        None => false,
    }
}

/// Start the release's installer in update mode, on its own: it replaces and restarts the app this helper runs in.
fn run_mac_update(ctx: &Ctx) -> bool {
    if !in_mac_app() {
        return false;
    }
    let mut cmd = std::process::Command::new("/bin/sh");
    cmd.args(["-c", &format!("curl -fsSL \"{RELEASES}/install.sh\" | sh -s -- --update")]);
    cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // its own session, so it outlives this helper (which the installer stops)
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    match cmd.spawn() {
        Ok(_) => true,
        Err(e) => {
            ctx.log(&format!("Update could not start ({e})."));
            false
        }
    }
}

pub async fn run(ctx: Arc<Ctx>, mut hints: mpsc::UnboundedReceiver<String>) {
    let http = reqwest::Client::new();
    let mut pending: Option<String> = None;
    let mut hinted: Option<(String, Instant)> = None;
    let first = tokio::time::sleep(Duration::from_secs(20));
    tokio::pin!(first);
    let mut first_done = false;
    let start = tokio::time::Instant::now();
    let mut every = tokio::time::interval_at(start + Duration::from_secs(30 * 60), Duration::from_secs(30 * 60));
    let mut soon = tokio::time::interval_at(start + Duration::from_secs(120), Duration::from_secs(120));

    loop {
        let mut look = false;
        tokio::select! {
            _ = &mut first, if !first_done => { first_done = true; look = true; }
            _ = every.tick() => { look = true; }
            _ = soon.tick() => {
                if let Some((v, until)) = &hinted {
                    if Instant::now() > *until || pending.as_deref().map_or(false, |p| !older_than(p, v)) { hinted = None; }
                }
                look = hinted.is_some();
            }
            Some(v) = hints.recv() => {
                let known = pending.as_deref().map_or(false, |p| !older_than(p, &v)) || hinted.as_ref().map_or(false, |(h, _)| *h == v);
                if older_than(VERSION, &v) && !known {
                    hinted = Some((v, Instant::now() + Duration::from_secs(3600)));
                    look = true;
                }
            }
        }
        if look {
            if let Some(latest) = check_for_update(&http).await {
                if pending.as_deref() != Some(latest.as_str()) {
                    ctx.log(&format!("Version {latest} is out."));
                }
                ctx.set(|s| s.update = Some(latest.clone()));
                pending = Some(latest);
            }
        }
        if pending.is_some() && ctx.may_update() && run_mac_update(&ctx) {
            ctx.log("Updating now. CompCue Link restarts by itself.");
        }
    }
}
