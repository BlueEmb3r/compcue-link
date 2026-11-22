//! What the helper does once this computer is paired:
//!   1. wait until the League client is open
//!   2. hold one outbound WebSocket to the site, recognised by the token from pairing
//!   3. answer the site's read requests from the allowlist and forward three client events
//!
//! Nothing listens on this computer, the client's port and password never leave it, and while a game is being
//! played it goes quiet (only the game phase and the already-locked teams can be read), except for one read the
//! site may ask for: the scoreboard (champion, side, level and items), for the player's own build options.
//! No connection to the site exists while League is closed. Every body is cut down before it is sent.
use crate::client::{self, ClientEvent, ReadError, Reader};
use crate::contract::{self, Creds, ToLink};
use crate::Ctx;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub enum LinkEnd {
    Unpaired,
    Update,
}

enum SessionEnd {
    Unpaired,
    Update,
    ClientClosed,
    SiteClosed,
    Silent,
    Ok,
}

/// One answer to a `get`, as the helper decides it: (status, body).
pub async fn answer_get(reader: &Reader, path: &str, phase: &str) -> (u16, Option<Value>) {
    if let Some(refused) = contract::gate(path, phase) {
        return (refused, None);
    }
    match reader.get(path).await {
        Ok(body) => (200, Some(contract::minimize(path, &body))),
        Err(ReadError::Status(s)) => (s, None),
        Err(ReadError::Failed) => (502, None),
    }
}

/// One answer to a `game`: the scoreboard, only while a game is being played, cut down before it leaves.
pub async fn answer_game(reader: &Reader, phase: &str) -> (u16, Option<Value>) {
    if phase != contract::GAME_PHASE {
        return (409, None);
    }
    match reader.game().await.as_ref().and_then(contract::minimize_game) {
        Some(body) => (200, Some(body)),
        None => (404, None),
    }
}

fn res(id: &Value, (status, body): (u16, Option<Value>)) -> String {
    let mut m = json!({ "t": "res", "id": id, "status": status });
    if let Some(b) = body {
        m["body"] = b;
    }
    m.to_string()
}

/// Runs until the token is refused (pair again) or the site asks for a newer helper.
pub async fn run_link(token: &str, ctx: &Arc<Ctx>) -> LinkEnd {
    let (mut backoff, mut refused) = (1000u64, 0u32);
    loop {
        let Some(creds) = client::find_client().await else {
            ctx.state("waiting");
            tokio::time::sleep(Duration::from_secs(3)).await;
            continue;
        };
        ctx.log("League client found. Connecting to CompCue.");
        ctx.state("connecting");
        let end = session(token, creds, ctx).await;
        // a site that is restarting can refuse a token once: forget it only when it refuses twice in a row
        if matches!(end, SessionEnd::Unpaired) {
            refused += 1;
            if refused < 2 {
                ctx.log("The site did not accept this computer. Trying once more.");
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
        } else {
            refused = 0;
        }
        match end {
            SessionEnd::Unpaired => {
                ctx.state("pairing");
                return LinkEnd::Unpaired;
            }
            SessionEnd::Update => {
                ctx.state("update");
                return LinkEnd::Update;
            }
            _ => {}
        }
        ctx.state(if matches!(end, SessionEnd::SiteClosed) { "offline" } else { "waiting" });
        // the site restarting (a new version going out) is normal: come back quickly, never wait more than 15 s
        if matches!(end, SessionEnd::Ok | SessionEnd::Silent) {
            backoff = 1000;
        } else {
            backoff = (backoff * 2).min(15_000);
        }
        let jitter = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos() as u64 % 500).unwrap_or(0);
        tokio::time::sleep(Duration::from_millis(if matches!(end, SessionEnd::ClientClosed) { 1000 } else { backoff + jitter })).await;
    }
}

async fn session(token: &str, creds: Creds, ctx: &Arc<Ctx>) -> SessionEnd {
    let reader = Reader::new(creds.clone());

    // ---- the one socket to the site
    let url = format!("{}/api/link/ws", ctx.site.replacen("http", "ws", 1));
    let failed = |code: u16, why: &str| ctx.log(&format!("Connection to CompCue failed ({code}{}{why}).", if why.is_empty() { "" } else { " " }));
    let Ok(mut req) = url.into_client_request() else {
        failed(1006, "bad address");
        return SessionEnd::SiteClosed;
    };
    let Ok(bearer) = format!("Bearer {token}").parse() else { return SessionEnd::Unpaired };
    req.headers_mut().insert("Authorization", bearer);
    let config = WebSocketConfig::default().max_message_size(Some(contract::LINK_MAX_BYTES)).max_frame_size(Some(contract::LINK_MAX_BYTES));
    let dial = tokio_tungstenite::connect_async_tls_with_config(req, Some(config), false, None);
    let mut ws = match tokio::time::timeout(Duration::from_secs(10), dial).await {
        Ok(Ok((ws, _))) => ws,
        Ok(Err(WsError::Http(r))) => {
            let code = r.status().as_u16();
            failed(if code == 401 { 401 } else { 1006 }, &format!("HTTP {code}"));
            if code == 401 {
                ctx.log("This computer was removed on the CompCue site. Pair it again.");
                return SessionEnd::Unpaired;
            }
            return SessionEnd::SiteClosed;
        }
        Ok(Err(e)) => {
            failed(1006, &e.to_string().chars().take(120).collect::<String>());
            return SessionEnd::SiteClosed;
        }
        Err(_) => {
            failed(1006, "no answer");
            return SessionEnd::SiteClosed;
        }
    };

    let opened_at = Instant::now();
    let via = if reader.via() == "process" { "process" } else { "lockfile" };
    let mut phase = String::from("None");
    let mut events_up: Option<bool> = None;
    let (mut last_pong, mut pongs, mut warned): (Option<Instant>, u32, bool) = (None, 0, false);
    // any frame from the site, pings included: a restarted site can leave this socket half open
    let mut heard = Instant::now();

    let client_msg = |events_up: Option<bool>| {
        let mut m = json!({ "t": "client", "up": true, "via": via });
        if let Some(e) = events_up {
            m["events"] = json!(e);
        }
        m.to_string()
    };

    let hello = json!({ "t": "hello", "v": contract::LINK_PROTOCOL, "version": VERSION, "platform": crate::PLATFORM, "beat": contract::LINK_BEAT_MS, "game": true, "clash": true }).to_string();
    // everything that ends the session leaves through `end`; a failed send means the socket is gone
    macro_rules! send {
        ($text:expr) => {
            if ws.send(Message::text($text)).await.is_err() {
                break closed(ctx, opened_at, 1006, "");
            }
        };
    }
    fn closed(ctx: &Ctx, opened_at: Instant, code: u16, reason: &str) -> SessionEnd {
        ctx.log(&format!("Connection to CompCue closed ({code}{}{reason}) after {} s.", if reason.is_empty() { "" } else { " " }, opened_at.elapsed().as_secs_f64().round() as u64));
        if code == 401 || code == 4001 {
            ctx.log("This computer was removed on the CompCue site. Pair it again.");
            return SessionEnd::Unpaired;
        }
        SessionEnd::Ok
    }

    // the client's event socket, the reads the site asks for, and the 5 s look at the client all run beside this loop
    let (ev_tx, mut ev_rx) = mpsc::unbounded_channel::<ClientEvent>();
    let (ans_tx, mut ans_rx) = mpsc::unbounded_channel::<String>();
    let (look_tx, mut look_rx) = mpsc::unbounded_channel::<(u16, Option<Value>)>();
    let mut events_task: Option<tokio::task::JoinHandle<()>> = None;
    let mut beat = tokio::time::interval(Duration::from_millis(contract::LINK_BEAT_MS));
    beat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut look = tokio::time::interval_at(tokio::time::Instant::now() + Duration::from_secs(5), Duration::from_secs(5));
    look.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut first_beat = true;
    let mut greeted = false;

    let end = loop {
        if !greeted {
            greeted = true;
            send!(hello.clone());
            send!(client_msg(events_up));
            ctx.log("Connected. You can go back to the CompCue page.");
            ctx.state("connected");
            events_task = Some(tokio::spawn(client::events(creds.clone(), ev_tx.clone())));
        }
        tokio::select! {
            m = ws.next() => {
                heard = Instant::now();
                let text = match m {
                    Some(Ok(Message::Text(t))) => t.as_str().to_string(),
                    Some(Ok(Message::Close(f))) => {
                        let (code, reason) = f.map(|f| (u16::from(f.code), f.reason.as_str().to_string())).unwrap_or((1005, String::new()));
                        break closed(ctx, opened_at, code, &reason);
                    }
                    Some(Ok(_)) => continue,
                    Some(Err(_)) | None => break closed(ctx, opened_at, 1006, ""),
                };
                if text == contract::LINK_PONG { last_pong = Some(Instant::now()); pongs += 1; continue; }
                match contract::parse_to_link(&text) {
                    None => {}
                    Some(ToLink::Pong) => { last_pong = Some(Instant::now()); pongs += 1; }
                    Some(ToLink::Bye { reason }) => {
                        if reason == "update" {
                            ctx.log("This version is too old. Get the newest one from the CompCue site.");
                            break SessionEnd::Update;
                        }
                    }
                    Some(ToLink::Latest { version }) => ctx.latest(&version),
                    Some(ToLink::Game { id }) => {
                        let (reader, phase, tx) = (reader.clone(), phase.clone(), ans_tx.clone());
                        tokio::spawn(async move { let _ = tx.send(res(&id, answer_game(&reader, &phase).await)); });
                    }
                    Some(ToLink::Get { id, path }) => {
                        let (reader, phase, tx) = (reader.clone(), phase.clone(), ans_tx.clone());
                        tokio::spawn(async move { let _ = tx.send(res(&id, answer_get(&reader, &path, &phase).await)); });
                    }
                }
            }
            Some(answer) = ans_rx.recv() => { send!(answer); }
            Some(e) = ev_rx.recv() => match e {
                ClientEvent::Up => {
                    if events_up != Some(true) {
                        if events_up == Some(false) { ctx.log("League client events are back."); }
                        events_up = Some(true);
                        send!(client_msg(events_up));
                    }
                }
                ClientEvent::Down => {
                    if events_up != Some(false) {
                        events_up = Some(false);
                        ctx.log("League client events stopped. Reading it directly until they come back.");
                        send!(client_msg(events_up));
                    }
                }
                ClientEvent::Event { uri, event_type, data } => {
                    if !contract::allowed_topic(&uri) { continue; }
                    match (&uri[..], &data) {
                        ("/lol-gameflow/v1/gameflow-phase", Some(Value::String(p))) => { phase = p.clone(); ctx.phase(&phase); }
                        _ => if contract::QUIET_PHASES.contains(&phase.as_str()) { continue; },
                    }
                    let mut m = json!({ "t": "event", "uri": uri, "eventType": event_type });
                    if let Some(d) = data { m["data"] = contract::minimize(&uri, &d); }
                    send!(m.to_string());
                }
            },
            // the client's own lifetime: when it stops answering, tell the site and leave (no idle connection)
            _ = look.tick() => {
                let (reader, tx) = (reader.clone(), look_tx.clone());
                tokio::spawn(async move { let _ = tx.send(answer_get(&reader, "/lol-gameflow/v1/gameflow-phase", "None").await); });
            }
            Some(seen) = look_rx.recv() => match seen {
                (200, Some(Value::String(p))) => { phase = p; ctx.phase(&phase); }
                (502, _) => {
                    let _ = ws.send(Message::text(json!({ "t": "client", "up": false }).to_string())).await;
                    ctx.log("League client closed.");
                    break SessionEnd::ClientClosed;
                }
                _ => {}
            },
            // the heartbeat: ping every beat; once the site has answered one, a site that stops answering is gone
            _ = beat.tick() => {
                if !first_beat {
                    let since = last_pong.unwrap_or(opened_at).elapsed();
                    if pongs > 0 && since > Duration::from_millis(contract::LINK_PONG_LATE_MS) {
                        ctx.log(&format!("No answer from CompCue for {} s. Connecting again.", since.as_secs_f64().round() as u64));
                        break SessionEnd::Silent;
                    }
                    if pongs == 0 && !warned && since > Duration::from_millis(contract::LINK_PONG_LATE_MS) {
                        warned = true;
                        ctx.log("This CompCue site does not answer heartbeats (an older version). Staying connected.");
                    }
                    if heard.elapsed() > Duration::from_secs(45) { break closed(ctx, opened_at, 1006, "no answer to pings"); }
                }
                first_beat = false;
                send!(contract::LINK_PING);
                if ws.send(Message::Ping(Vec::new().into())).await.is_err() { break closed(ctx, opened_at, 1006, ""); }
            }
        }
    };
    if let Some(t) = events_task {
        t.abort();
    }
    let _ = tokio::time::timeout(Duration::from_secs(2), ws.close(None)).await;
    end
}
