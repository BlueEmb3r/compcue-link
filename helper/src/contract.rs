//! The whole contract with the site, the same rules as the site's TypeScript (src/shared/link.ts in the app):
//! what the helper may read from the League client, what is cut out before anything leaves this computer, and the
//! messages on the wire. `contract.json` holds the TypeScript's own answers; `cargo test` checks this file gives
//! the same ones, so the two can not drift apart unnoticed.
//!
//! Read-only by construction: there is no message that writes to the client, and every path is checked here, on
//! the player's machine, so the site (even a broken or hostile one) can not make the helper read anything else.
use serde_json::{Map, Value};

pub const LINK_PROTOCOL: i64 = 1;
/// The heartbeat, exact strings.
pub const LINK_PING: &str = r#"{"t":"ping"}"#;
pub const LINK_PONG: &str = r#"{"t":"pong"}"#;
pub const LINK_BEAT_MS: u64 = 15_000;
pub const LINK_PONG_LATE_MS: u64 = 40_000;
/// Largest message either end accepts.
pub const LINK_MAX_BYTES: usize = 1024 * 1024;

const P_PHASE: &str = "/lol-gameflow/v1/gameflow-phase";
const P_FLOW: &str = "/lol-gameflow/v1/session";
const P_SELECT: &str = "/lol-champ-select/v1/session";
const P_LOBBY: &str = "/lol-lobby/v2/lobby";

/// Paths read as they are.
const EXACT: [&str; 8] = [
    P_PHASE,
    P_FLOW,
    P_SELECT,
    P_LOBBY,
    "/lol-summoner/v1/current-summoner",
    "/riotclient/region-locale",
    "/lol-champions/v1/owned-champions-minimal",
    "/lol-champion-mastery/v1/local-player/champion-mastery",
];

/// A player id as the client writes it: 20 to 80 of 0-9, a-f and "-".
fn puuid(s: &str) -> bool {
    (20..=80).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
}

/// Every client path the helper may GET. Anything else is refused on the player's machine.
pub fn allowed_get(path: &str) -> bool {
    if path.len() >= 200 {
        return false;
    }
    if EXACT.contains(&path) {
        return true;
    }
    if let Some(rest) = path.strip_prefix("/lol-match-history/v1/products/lol/") {
        for tail in ["/matches?begIndex=0&endIndex=20", "/matches?begIndex=0&endIndex=40"] {
            if let Some(who) = rest.strip_suffix(tail) {
                return who == "current-summoner" || puuid(who);
            }
        }
        return false;
    }
    if let Some(who) = path.strip_prefix("/lol-ranked/v1/ranked-stats/") {
        return puuid(who);
    }
    false
}

/// Client event topics the helper forwards.
pub const ALLOWED_TOPICS: [&str; 3] = [P_SELECT, P_PHASE, P_LOBBY];
pub fn allowed_topic(uri: &str) -> bool {
    ALLOWED_TOPICS.contains(&uri)
}

/// Reads allowed in every phase (the phase itself, and the session that names the locked teams at game start).
const ALWAYS: [&str; 2] = [P_PHASE, P_FLOW];
/// While a game is being played the helper forwards nothing from the League client but the phase itself.
pub const QUIET_PHASES: [&str; 2] = ["InProgress", "Reconnect"];
pub const GAME_PHASE: &str = "InProgress";
/// What the helper answers before it reads anything: 403 (not on the list), 409 (quiet during a game), or None (it reads).
pub fn gate(path: &str, phase: &str) -> Option<u16> {
    if !allowed_get(path) {
        return Some(403);
    }
    if QUIET_PHASES.contains(&phase) && !ALWAYS.contains(&path) {
        return Some(409);
    }
    None
}

/// Phases an update must never interrupt: a queue about to pop, a champ select, a game.
pub const UPDATE_BUSY: [&str; 6] = ["Matchmaking", "ReadyCheck", "ChampSelect", "GameStart", "InProgress", "Reconnect"];

/// May the helper replace and restart itself now? Yes with no League client; with one, only once its phase is known and idle.
pub fn may_update(state: &str, phase: Option<&str>) -> bool {
    if state == "waiting" || state == "pairing" {
        return true;
    }
    state == "connected" && phase.map_or(false, |p| !UPDATE_BUSY.contains(&p))
}

/// Keys that never leave the computer, wherever they appear (compared without case).
const NEVER: [&str; 20] = [
    "mucjwtdto",
    "multiuserchatjwt",
    "multiuserchatpassword",
    "multiuserchatid",
    "playercredentials",
    "encryptionkey",
    "observerencryptionkey",
    "observerserverip",
    "observerserverport",
    "serverip",
    "serverport",
    "password",
    "gameclient",
    "chatdetails",
    "chatroomname",
    "chatroompassword",
    "idtoken",
    "accesstoken",
    "entitlementstoken",
    "summonerinternalname",
];
fn never(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    NEVER.contains(&k.as_str()) || k == "accountid"
}

fn strip(v: &Value, depth: usize) -> Value {
    if depth > 12 {
        return v.clone();
    }
    match v {
        Value::Array(a) => Value::Array(a.iter().map(|x| strip(x, depth + 1)).collect()),
        Value::Object(o) => {
            let mut out = Map::new();
            for (k, x) in o {
                if !never(k) {
                    out.insert(k.clone(), strip(x, depth + 1));
                }
            }
            Value::Object(out)
        }
        _ => v.clone(),
    }
}

fn pick(o: Option<&Value>, keys: &[&str]) -> Value {
    let mut out = Map::new();
    if let Some(Value::Object(m)) = o {
        for k in keys {
            if let Some(x) = m.get(*k) {
                out.insert((*k).to_string(), x.clone());
            }
        }
    }
    Value::Object(out)
}

const PLAYER_KEYS: [&str; 6] = ["puuid", "championId", "gameName", "tagLine", "selectedPosition", "team"];

/// The body of one read or event, cut down to what the site uses before it is sent.
pub fn minimize(path: &str, body: &Value) -> Value {
    if !body.is_object() && !body.is_array() {
        return body.clone();
    }
    let p = path.split('?').next().unwrap_or("");
    if p == P_SELECT {
        return strip(&pick(Some(body), &["localPlayerCellId", "myTeam", "theirTeam", "actions", "bans", "timer", "isSpectating", "gameId"]), 0);
    }
    if p == P_LOBBY {
        let members = match body.get("members") {
            Some(Value::Array(a)) => a.iter().map(|m| pick(Some(m), &["puuid"])).collect(),
            _ => Vec::new(),
        };
        let mut out = Map::new();
        out.insert("members".into(), Value::Array(members));
        return Value::Object(out);
    }
    if p == P_FLOW {
        let gd = body.get("gameData");
        let team = |t: Option<&Value>| match t {
            Some(Value::Array(a)) => Value::Array(a.iter().map(|x| pick(Some(x), &PLAYER_KEYS)).collect()),
            _ => Value::Array(Vec::new()),
        };
        let mut g = Map::new();
        g.insert("queue".into(), pick(gd.and_then(|g| g.get("queue")), &["id"]));
        g.insert("teamOne".into(), team(gd.and_then(|g| g.get("teamOne"))));
        g.insert("teamTwo".into(), team(gd.and_then(|g| g.get("teamTwo"))));
        let mut out = Map::new();
        out.insert("gameData".into(), Value::Object(g));
        return Value::Object(out);
    }
    strip(body, 0)
}

/// The scoreboard of the game in progress, cut to champion, side, level and item ids. None when it is not a list.
pub fn minimize_game(body: &Value) -> Option<Value> {
    let list = body.as_array()?;
    Some(Value::Array(
        list.iter()
            .take(12)
            .map(|p| {
                let mut o = match pick(Some(p), &["championName", "rawChampionName", "team", "level"]) {
                    Value::Object(m) => m,
                    _ => Map::new(),
                };
                let items = match p.get("items") {
                    Some(Value::Array(a)) => a.iter().take(12).map(|i| pick(Some(i), &["itemID"])).collect(),
                    _ => Vec::new(),
                };
                o.insert("items".into(), Value::Array(items));
                Value::Object(o)
            })
            .collect(),
    ))
}

/// The site this helper may talk to: https only, or plain http on this same computer (development).
pub fn site_allowed(site: &str) -> bool {
    let Ok(u) = url::Url::parse(site) else { return false };
    if !u.username().is_empty() || u.password().is_some() {
        return false;
    }
    match u.scheme() {
        "https" => true,
        "http" => matches!(u.host_str(), Some("127.0.0.1") | Some("localhost") | Some("[::1]")),
        _ => false,
    }
}

fn is_version(v: &str) -> bool {
    let parts: Vec<&str> = v.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}
pub fn version_shaped(v: &str) -> bool {
    is_version(v)
}

/// What the site may say to the helper.
#[derive(Debug, PartialEq)]
pub enum ToLink {
    Get { id: Value, path: String },
    Bye { reason: String },
    Pong,
    Game { id: Value },
    Latest { version: String },
}

fn int(v: Option<&Value>) -> Option<Value> {
    let v = v?;
    let n = v.as_f64()?;
    // a whole number a JavaScript site can hold exactly; it is sent back as it came
    if n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 {
        Some(v.clone())
    } else {
        None
    }
}
fn short(v: Option<&Value>, max: usize) -> Option<String> {
    let s = v?.as_str()?;
    // the site counts UTF-16 units; this is never more generous than that
    (s.encode_utf16().count() <= max).then(|| s.to_string())
}

/// One message from the site, or None (too long, not JSON, not one of the shapes). The site is untrusted input.
pub fn parse_to_link(raw: &str) -> Option<ToLink> {
    if raw.is_empty() || raw.encode_utf16().count() > LINK_MAX_BYTES {
        return None;
    }
    let j: Value = serde_json::from_str(raw).ok()?;
    let o = j.as_object()?;
    match o.get("t")?.as_str()? {
        "get" => Some(ToLink::Get { id: int(o.get("id"))?, path: short(o.get("path"), 200)? }),
        "bye" => {
            let reason = short(o.get("reason"), 200)?;
            if let Some(m) = o.get("minVersion") {
                short(Some(m), 40)?;
            }
            Some(ToLink::Bye { reason })
        }
        "pong" => Some(ToLink::Pong),
        "game" => Some(ToLink::Game { id: int(o.get("id"))? }),
        "latest" => {
            let version = o.get("version")?.as_str()?;
            is_version(version).then(|| ToLink::Latest { version: version.to_string() })
        }
        _ => None,
    }
}

/// "KDA-4F7Q": what the site sent, upper case, letters and digits only, 7 of them; "" when it is not a code.
pub fn normalize_code(s: &str) -> String {
    let c: String = s.to_uppercase().chars().filter(|c| c.is_ascii_uppercase() || c.is_ascii_digit()).collect();
    if c.len() == 7 {
        format!("{}-{}", &c[..3], &c[3..])
    } else {
        String::new()
    }
}

/// Is `version` older than `min`? (three numbers; anything that is not a number counts as 0)
pub fn older_than(version: &str, min: &str) -> bool {
    let n = |v: &str| -> Vec<u64> {
        v.split('.')
            .map(|x| {
                let digits: String = x.trim_start().chars().take_while(|c| c.is_ascii_digit()).collect();
                digits.parse().unwrap_or(0)
            })
            .collect()
    };
    let (a, b) = (n(version), n(min));
    for i in 0..3 {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x < y;
        }
    }
    false
}

/// A token as the site makes them.
pub fn good_token(t: &str) -> bool {
    (20..=200).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

// ---- finding the client: the two texts it leaves ----------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct Creds {
    pub port: u16,
    pub password: String,
    pub install_dir: Option<String>,
    /// "lockfile" or "process"
    pub via: &'static str,
}

/// `LeagueClient:<pid>:<port>:<password>:<protocol>`
pub fn parse_lockfile(text: &str) -> Option<(u16, String)> {
    let parts: Vec<&str> = text.trim().split(':').collect();
    if parts.len() < 5 {
        return None;
    }
    let port: u16 = parts[2].parse().ok().filter(|p| *p > 0)?;
    if parts[3].is_empty() {
        return None;
    }
    Some((port, parts[3].to_string()))
}

fn flag(cmd: &str, key: &str) -> Option<String> {
    let needle = format!("--{key}=");
    let rest = &cmd[cmd.find(&needle)? + needle.len()..];
    let v = if let Some(q) = rest.strip_prefix('"') {
        let end = q.find('"')?;
        &q[..end]
    } else {
        let end = rest.find(|c: char| c.is_whitespace() || c == '"').unwrap_or(rest.len());
        &rest[..end]
    };
    (!v.is_empty()).then(|| v.to_string())
}

/// Port, password and install folder from a LeagueClientUx command line.
pub fn parse_command_line(cmd: &str) -> Option<(u16, String, Option<String>)> {
    let port: u16 = flag(cmd, "app-port")?.parse().ok().filter(|p| *p > 0)?;
    let password = flag(cmd, "remoting-auth-token")?;
    Some((port, password, flag(cmd, "install-directory")))
}

/// One frame of the client's event socket -> (uri, eventType, data if it carries any), or None.
pub fn parse_frame(text: &str) -> Option<(String, String, Option<Value>)> {
    let m: Value = serde_json::from_str(text).ok()?;
    let a = m.as_array()?;
    if a.first()?.as_i64()? != 8 {
        return None;
    }
    let p = a.get(2)?.as_object()?;
    let uri = p.get("uri")?.as_str()?.to_string();
    let event_type = p.get("eventType").and_then(|e| e.as_str()).unwrap_or("Update").to_string();
    Some((uri, event_type, p.get("data").cloned()))
}

pub fn subscribe_frames() -> Vec<String> {
    ALLOWED_TOPICS.iter().map(|u| format!(r#"[5,"OnJsonApiEvent{}"]"#, u.replace('/', "_"))).collect()
}
