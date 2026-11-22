//! The League client on this computer: finding it, reading it (GET only), and its event socket.
//!
//! The client runs on 127.0.0.1 with a self-signed Riot certificate, so certificate checks are off for these
//! loopback connections only (never for the CompCue site or GitHub). Nothing here can send anything but a GET
//! and the three event subscriptions.
use crate::contract::{self, Creds};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

/// The game client's local API while a game runs (fixed by Riot).
const GAME_PORT: u16 = 2999;

/// Install folders to try, most likely first. LEAGUE_PATH (env) always wins.
fn candidate_dirs() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut add = |p: PathBuf| {
        if !out.contains(&p) {
            out.push(p)
        }
    };
    if let Some(p) = std::env::var_os("LEAGUE_PATH").filter(|p| !p.is_empty()) {
        add(PathBuf::from(p));
    }
    if cfg!(target_os = "macos") {
        add(PathBuf::from("/Applications/League of Legends.app/Contents/LoL"));
        if let Some(home) = std::env::var_os("HOME") {
            add(Path::new(&home).join("Applications/League of Legends.app/Contents/LoL"));
        }
    } else if cfg!(windows) {
        for d in ["C", "D", "E", "F"] {
            add(PathBuf::from(format!("{d}:\\Riot Games\\League of Legends")));
        }
        for k in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(pf) = std::env::var_os(k).filter(|p| !p.is_empty()) {
                add(Path::new(&pf).join("Riot Games").join("League of Legends"));
            }
        }
    }
    out
}

fn read_lockfile(dir: &Path) -> Option<(u16, String)> {
    // the lockfile is briefly locked while the client starts: then there is nothing to read yet
    contract::parse_lockfile(&std::fs::read_to_string(dir.join("lockfile")).ok()?)
}

/// Command lines of running LeagueClientUx processes.
async fn client_command_lines() -> Vec<String> {
    let mut cmd;
    if cfg!(windows) {
        cmd = tokio::process::Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"name='LeagueClientUx.exe'\" | Select-Object -ExpandProperty CommandLine"]);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: this program has no console and must not flash one
    } else {
        cmd = tokio::process::Command::new("ps");
        cmd.args(["-A", "-ww", "-o", "args="]);
    }
    cmd.stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null()).kill_on_drop(true);
    let out = match tokio::time::timeout(Duration::from_secs(4), cmd.output()).await {
        Ok(Ok(o)) => String::from_utf8_lossy(&o.stdout).into_owned(),
        _ => return Vec::new(),
    };
    out.lines().filter(|l| l.contains("--app-port=") && (cfg!(windows) || l.contains("LeagueClientUx"))).map(str::to_string).collect()
}

/// Locate the running client. None when League is not running (no lockfile, no process).
pub async fn find_client() -> Option<Creds> {
    for dir in candidate_dirs() {
        if let Some((port, password)) = read_lockfile(&dir) {
            return Some(Creds { port, password, install_dir: Some(dir.to_string_lossy().into_owned()), via: "lockfile" });
        }
    }
    for line in client_command_lines().await {
        if let Some((port, password, install_dir)) = contract::parse_command_line(&line) {
            // prefer the lockfile in the reported folder (it has the current password if the client restarted)
            if let Some(dir) = &install_dir {
                if let Some((port, password)) = read_lockfile(Path::new(dir)) {
                    return Some(Creds { port, password, install_dir, via: "lockfile" });
                }
            }
            return Some(Creds { port, password, install_dir, via: "process" });
        }
    }
    None
}

/// What a read can come back as: the body, the client's own error status, or no answer at all.
pub enum ReadError {
    Status(u16),
    Failed,
}

/// Read-only access to the client: one function, and it sends GET.
#[derive(Clone)]
pub struct Reader {
    creds: Creds,
    http: reqwest::Client,
}

impl Reader {
    pub fn new(creds: Creds) -> Self {
        // loopback only: the Riot certificate is self-signed, and every address below is built here with 127.0.0.1
        let http = reqwest::Client::builder().danger_accept_invalid_certs(true).no_proxy().build().expect("http client");
        Reader { creds, http }
    }
    pub fn via(&self) -> &'static str {
        self.creds.via
    }
    fn basic(&self) -> String {
        format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("riot:{}", self.creds.password)))
    }

    async fn get_json(&self, port: u16, path: &str, auth: Option<String>, timeout: Duration) -> Result<Value, ReadError> {
        let mut req = self.http.get(format!("https://127.0.0.1:{port}{path}")).header("Accept", "application/json").timeout(timeout);
        if let Some(a) = auth {
            req = req.header("Authorization", a);
        }
        let res = req.send().await.map_err(|_| ReadError::Failed)?;
        let status = res.status().as_u16();
        if status >= 400 {
            return Err(ReadError::Status(status));
        }
        let text = res.text().await.map_err(|_| ReadError::Failed)?;
        if text.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text).map_err(|_| ReadError::Failed)
    }

    /// One path of the League client. The caller has already checked it against the allowlist (contract::allowed_get).
    pub async fn get(&self, path: &str) -> Result<Value, ReadError> {
        self.get_json(self.creds.port, path, Some(self.basic()), Duration::from_millis(2500)).await
    }

    /// The game's own local API (port 2999, loopback, no password): one fixed read, the player list. None when no game answers.
    pub async fn game(&self) -> Option<Value> {
        self.get_json(GAME_PORT, "/liveclientdata/playerlist", None, Duration::from_millis(1500)).await.ok()
    }
}

/// What the event socket says.
pub enum ClientEvent {
    /// the socket is open and subscribed
    Up,
    Event { uri: String, event_type: String, data: Option<Value> },
    /// the socket closed or could not open
    Down,
}

/// Accepts the client's self-signed certificate. Used for wss://127.0.0.1 only.
#[derive(Debug)]
struct Loopback(Arc<rustls::crypto::CryptoProvider>);
impl rustls::client::danger::ServerCertVerifier for Loopback {
    fn verify_server_cert(&self, _: &rustls::pki_types::CertificateDer<'_>, _: &[rustls::pki_types::CertificateDer<'_>], _: &rustls::pki_types::ServerName<'_>, _: &[u8], _: rustls::pki_types::UnixTime) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(&self, m: &[u8], c: &rustls::pki_types::CertificateDer<'_>, d: &rustls::DigitallySignedStruct) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(m, c, d, &self.0.signature_verification_algorithms)
    }
    fn verify_tls13_signature(&self, m: &[u8], c: &rustls::pki_types::CertificateDer<'_>, d: &rustls::DigitallySignedStruct) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(m, c, d, &self.0.signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// One life of the client's event socket (WAMP 1.0 over wss, same port and password as its REST API): subscribe to
/// the three topics, pass events on, say Down when it ends. The only thing ever sent is the subscriptions.
pub async fn events_once(creds: &Creds, out: &mpsc::UnboundedSender<ClientEvent>) {
    let run = async {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let tls = rustls::ClientConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()
            .ok()?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(Loopback(provider)))
            .with_no_client_auth();
        let mut req = format!("wss://127.0.0.1:{}/", creds.port).into_client_request().ok()?;
        let auth = format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("riot:{}", creds.password)));
        req.headers_mut().insert("Authorization", auth.parse().ok()?);
        req.headers_mut().insert("Sec-WebSocket-Protocol", "wamp".parse().ok()?);
        let connect = tokio_tungstenite::connect_async_tls_with_config(req, None, false, Some(tokio_tungstenite::Connector::Rustls(Arc::new(tls))));
        let (mut ws, _) = tokio::time::timeout(Duration::from_secs(4), connect).await.ok()?.ok()?;
        for f in contract::subscribe_frames() {
            ws.send(Message::text(f)).await.ok()?;
        }
        let _ = out.send(ClientEvent::Up);
        while let Some(Ok(m)) = ws.next().await {
            match m {
                Message::Text(t) => {
                    if let Some((uri, event_type, data)) = contract::parse_frame(t.as_str()) {
                        if out.send(ClientEvent::Event { uri, event_type, data }).is_err() {
                            break;
                        }
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        Some(())
    };
    let _ = run.await;
    let _ = out.send(ClientEvent::Down);
}

/// The event socket for as long as the receiver lives: opened again when it drops (the client restarting its
/// socket, a wake from sleep) after 2 s, then 5 s, then every 10 s.
pub async fn events(creds: Creds, out: mpsc::UnboundedSender<ClientEvent>) {
    let mut tries = 0u32;
    loop {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut was_up = false;
        let once = events_once(&creds, &tx);
        tokio::pin!(once);
        let mut ended = false;
        // pass everything on as it comes, and remember whether this life of the socket ever opened
        loop {
            tokio::select! {
                _ = &mut once, if !ended => { ended = true; }
                e = rx.recv() => match e {
                    Some(e) => {
                        if matches!(e, ClientEvent::Up) { was_up = true; }
                        let last = matches!(e, ClientEvent::Down);
                        if out.send(e).is_err() { return; }
                        if last { break; }
                    }
                    None => break,
                },
            }
        }
        if was_up {
            tries = 0;
        }
        tokio::time::sleep(Duration::from_secs(match tries { 0 => 2, 1 => 5, _ => 10 })).await;
        tries += 1;
        if out.is_closed() {
            return;
        }
    }
}
