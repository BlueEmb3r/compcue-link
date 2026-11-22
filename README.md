# CompCue Link

The small helper that lets [CompCue](https://compcue.aflince.com) see your League of Legends champ select, so its
draft coach can give you pick and ban options live. This repository is everything that runs on your computer.

## What it does

1. Waits until the League client is open and finds it (its `lockfile`).
2. Keeps one outbound connection to the CompCue site, recognised by the token from pairing.
3. Answers the site's read requests from a fixed list, and forwards three client events.

## What it cannot do

- **It only reads.** The only calls it can make to the client are GET requests on the paths in
  [`helper/src/contract.rs`](helper/src/contract.rs) (`allowed_get`): game phase, lobby, champ select, your summoner,
  your champions and mastery, recent games and ranked stats of players the client shows you. There is no
  message that picks, bans, accepts a queue or clicks anything.
- **It listens on nothing.** No port is opened on your computer.
- **The client's port and password never leave your computer.**
- **It sends only what the coach uses.** Every answer is cut down first (`minimize` in `helper/src/contract.rs`): chat tokens and
  the game server's address and keys never leave your computer.
- **It only talks to the CompCue site over https.**
- **During a game it reads one thing, and only when the site asks: the scoreboard.** The champion, side, level and
  items of the ten players (what you see with Tab), from the game's own local API on your computer, for your own
  build options (`minimize_game` in `helper/src/contract.rs`). No names, no scores, no gold. From the League client it
  still forwards only the game phase.
- **It never touches the game process or its memory.** It uses only the League client's local HTTP API.

## Use

Run it, confirm the code it shows on the CompCue page that opens, then open League. From then on it connects by
itself whenever League is open.

```
compcue-link                 # pair on first run, then keep running
compcue-link --unpair        # forget this computer's token
compcue-link --site <url>    # another CompCue server (self-hosting, development)
compcue-link --version
```

### Windows

Download **`CompCueLink.exe`** from the [latest release](https://github.com/BlueEmb3r/compcue-link/releases/latest) and
open it. That is the only file to run. (Or get CompCue Link in the Microsoft Store, which installs and updates it.)

- No console window ever opens. An icon next to the clock shows the state, opens CompCue, shows the log and quits.
- Opened from anywhere, it puts itself in `%LOCALAPPDATA%\CompCue`, adds a Start menu entry, and starts with Windows
  (the menu switches that off). The download can be deleted afterwards.
- It updates itself from the GitHub release when League is closed. The download is checked against the release's
  `SHA256SUMS` before it is used.
- "Remove from this PC…" in the menu (or `CompCueLink.exe --remove`) takes all of it away again.
- The file is not code-signed, so Windows SmartScreen asks once: More info, Run anyway.

`CompCueLink-windows.zip` on the release page is only there so copies of version 0.4.4 can update themselves.

The token is stored in `%APPDATA%\CompCue\link.json` (Windows) or `~/Library/Application Support/CompCue/link.json`
(Mac). You can also remove this computer on the site under "Connected computers".

## Build it yourself

```
cargo test  --manifest-path helper/Cargo.toml             # the helper against the site's contract
cargo build --release --manifest-path helper/Cargo.toml   # one small executable in helper/target/release/
npm ci && node test/smoke.mjs helper/target/release/compcue-link   # the real executable against a fake client and site
```

The Windows tray program and the Mac menu bar app are built by [the workflow](.github/workflows/build.yml), which
also shows every step as commands.

## Where the code lives

| File | Job |
| --- | --- |
| `helper/src/contract.rs` | The rules: the allowlist, what is cut out of every answer, the messages it accepts |
| `helper/src/client.rs` | The League client on 127.0.0.1: finding it, GET requests, its event socket |
| `helper/src/session.rs` | The loop: find the client, connect to the site, answer reads, forward events |
| `helper/src/main.rs`, `update.rs` | Command line, token and status files, pairing, looking for updates |
| `helper/contract.json` | The site's own answers for a long list of cases; `cargo test` checks the helper gives the same |
| `windows/CompCueLink.cs` | The Windows tray program (it starts the helper; it never talks to League or the site) |
| `mac/CompCueLink.swift` | The Mac menu bar app (the same job) |

The helper is written in Rust (a few MB; it was a 115 MB bundled JavaScript runtime before 0.5.0). These files are
exported from CompCue's main repository, where they are developed and tested. Please open issues here.

CompCue is not endorsed by Riot Games and does not reflect the views or opinions of Riot Games or anyone officially
involved in producing or managing Riot Games properties. Riot Games and all associated properties are trademarks or
registered trademarks of Riot Games, Inc.
