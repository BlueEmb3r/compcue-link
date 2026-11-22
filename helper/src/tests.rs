//! The helper against the site's own rules. contract.json is written by the app's TypeScript
//! (scripts/link/contract.ts in the app's repository): every case there is one the TypeScript answered, and this
//! program must answer the same. If these fail after the contract changed, change src/contract.rs to match.
use crate::contract::*;
use serde_json::{json, Value};

fn cases(name: &str) -> Vec<Value> {
    let all: Value = serde_json::from_str(include_str!("../contract.json")).expect("contract.json");
    all[name].as_array().unwrap_or_else(|| panic!("no cases for {name}")).clone()
}
fn text(v: &Value) -> &str {
    v.as_str().expect("text")
}

#[test]
fn version_and_constants() {
    let all: Value = serde_json::from_str(include_str!("../contract.json")).unwrap();
    assert_eq!(all["version"], crate::session::VERSION, "Cargo.toml's version is the app's LINK_VERSION");
    let c = &all["constants"];
    assert_eq!(c["LINK_PROTOCOL"], LINK_PROTOCOL);
    assert_eq!(c["LINK_PING"], LINK_PING);
    assert_eq!(c["LINK_PONG"], LINK_PONG);
    assert_eq!(c["LINK_BEAT_MS"], LINK_BEAT_MS);
    assert_eq!(c["LINK_PONG_LATE_MS"], LINK_PONG_LATE_MS);
    assert_eq!(c["LINK_MAX_BYTES"], LINK_MAX_BYTES);
    assert_eq!(c["ALLOWED_TOPICS"], json!(ALLOWED_TOPICS));
    assert_eq!(c["QUIET_PHASES"], json!(QUIET_PHASES));
    assert_eq!(c["GAME_PHASE"], GAME_PHASE);
    assert_eq!(c["UPDATE_BUSY"], json!(UPDATE_BUSY));
    assert_eq!(c["subscribe"], json!(subscribe_frames()));
}

#[test]
fn the_allowlist() {
    for c in cases("allowedGet") {
        assert_eq!(allowed_get(text(&c["path"])), c["ok"], "path {}", c["path"]);
    }
    for c in cases("allowedTopic") {
        assert_eq!(allowed_topic(text(&c["uri"])), c["ok"], "topic {}", c["uri"]);
    }
    for c in cases("gate") {
        assert_eq!(json!(gate(text(&c["path"]), text(&c["phase"]))), c["status"], "{} in {}", c["path"], c["phase"]);
    }
}

#[test]
fn what_leaves_the_computer() {
    for c in cases("minimize") {
        let out = minimize(text(&c["path"]), &c["body"]);
        assert_eq!(out, c["out"], "{} with {}", c["path"], c["body"]);
        // and in the same order, so both helpers send the same bytes
        assert_eq!(out.to_string(), c["out"].to_string());
    }
    for c in cases("minimizeGame") {
        assert_eq!(minimize_game(&c["body"]).unwrap_or(Value::Null), c["out"], "game {}", c["body"]);
    }
}

#[test]
fn the_site_it_may_talk_to() {
    for c in cases("siteAllowed") {
        assert_eq!(site_allowed(text(&c["site"])), c["ok"], "site {}", c["site"]);
    }
}

#[test]
fn what_the_site_may_say() {
    for c in cases("toLink") {
        let got = match parse_to_link(text(&c["raw"])) {
            None => Value::Null,
            Some(ToLink::Get { id, path }) => json!({ "t": "get", "id": id.as_f64(), "path": path }),
            Some(ToLink::Bye { reason }) => json!({ "t": "bye", "reason": reason }),
            Some(ToLink::Pong) => json!({ "t": "pong" }),
            Some(ToLink::Game { id }) => json!({ "t": "game", "id": id.as_f64() }),
            Some(ToLink::Latest { version }) => json!({ "t": "latest", "version": version }),
        };
        let mut want = c["out"].clone();
        if let Some(o) = want.as_object_mut() {
            o.remove("minVersion"); // checked, not used
            if let Some(id) = o.get("id").and_then(|i| i.as_f64()) {
                o.insert("id".into(), json!(id));
            }
        }
        assert_eq!(got, want, "message {}", c["raw"]);
    }
}

#[test]
fn the_client_s_own_texts() {
    for c in cases("frame") {
        let got = parse_frame(text(&c["raw"])).map(|(uri, event_type, data)| {
            let mut o = json!({ "uri": uri, "eventType": event_type });
            if let Some(d) = data {
                o["data"] = d;
            }
            o
        });
        assert_eq!(got.unwrap_or(Value::Null), c["out"], "frame {}", c["raw"]);
    }
    for c in cases("lockfile") {
        let got = parse_lockfile(text(&c["text"])).map(|(port, password)| json!({ "port": port, "password": password }));
        assert_eq!(got.unwrap_or(Value::Null), c["out"], "lockfile {}", c["text"]);
    }
    for c in cases("commandLine") {
        let got = parse_command_line(text(&c["cmd"])).map(|(port, password, dir)| json!({ "port": port, "password": password, "installDir": dir }));
        assert_eq!(got.unwrap_or(Value::Null), c["out"], "command line {}", c["cmd"]);
    }
}

#[test]
fn codes_versions_and_updates() {
    for c in cases("normalizeCode") {
        assert_eq!(normalize_code(text(&c["s"])), text(&c["out"]), "code {}", c["s"]);
    }
    for c in cases("olderThan") {
        assert_eq!(older_than(text(&c["a"]), text(&c["b"])), c["out"], "{} older than {}", c["a"], c["b"]);
    }
    for c in cases("mayUpdate") {
        assert_eq!(may_update(text(&c["state"]), c["phase"].as_str()), c["ok"], "update while {} in {}", c["state"], c["phase"]);
    }
    assert!(good_token("abcDEF_-0123456789xyz") && !good_token("short") && !good_token("has space in it 0123456789"));
}
