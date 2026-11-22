# CompCue Link

The small helper that lets [CompCue](https://compcue.aflince.com) see your League of Legends champ select, so its
draft coach can give you pick and ban options live. This repository is everything that runs on your computer.

## What it does

1. Waits until the League client is open and finds it (its `lockfile`).
2. Keeps one outbound connection to the CompCue site, recognised by the token from pairing.
3. Answers the site's read requests from a fixed list, and forwards three client events.

## What it cannot do

- **It only reads.** The only calls it can make to the client are GET requests on the paths in
  [`src/shared/link.ts`](src/shared/link.ts) (`ALLOWED_GETS`): game phase, lobby, champ select, your summoner,
  your champions and mastery, recent games and ranked stats of players the client shows you. There is no
  message that picks, bans, accepts a queue or clicks anything.
- **It listens on nothing.** No port is opened on your computer.
- **The client's port and password never leave your computer.**
- **It sends only what the coach uses.** Every answer is cut down first (`minimize` in `src/shared/link.ts`): chat tokens and
  the game server's address and keys never leave your computer.
- **It only talks to the CompCue site over https.**
- **During a game it reads one thing, and only when the site asks: the scoreboard.** The champion, side, level and
  items of the ten players (what you see with Tab), from the game's own local API on your computer, for your own
  build options (`minimizeGame` in `src/shared/link.ts`). No names, no scores, no gold. From the League client it
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

On Windows there are two copies, and neither opens a console window. A tray icon next to the clock shows the state, opens
CompCue, shows the log and quits. The helper inside is built without a console (`--windows-hide-console`) and writes to
`%APPDATA%\CompCue\link.log`.

- **Microsoft Store:** the Store installs it, starts it with Windows and updates it.
- **`CompCueLink-windows.zip` (release page):** extract the whole folder anywhere you can write and open
  `CompCueLink.exe`. It starts with Windows (the tray menu switches that off), registers the site's "Connect this PC"
  button for your user, and updates itself from the GitHub release when League is closed (the download is checked
  against the release's `SHA256SUMS`; only the two program files are taken from it). The file is not code-signed, so
  Windows SmartScreen asks once: More info, Run anyway.

`compcue-link-windows-x64.exe` is the command-line build (for `--version`, `--status`, scripts) and does open a console.

The token is stored in `%APPDATA%\CompCue\link.json` (Windows) or `~/Library/Application Support/CompCue/link.json`
(Mac). You can also remove this computer on the site under "Connected computers".

## Build it yourself

```
npm ci
npm run typecheck
npm run build        # needs Bun: one executable in dist/
```

## Where the code lives

| File | Job |
| --- | --- |
| `connector/main.ts` | Command line: token file, browser, sockets |
| `connector/link.ts` | The loop: find the client, connect, answer reads, forward events |
| `src/shared/link.ts` | The contract with the site: allowlist, message shapes, pairing codes |
| `server/live/lockfile.ts` | Finds the running League client on Windows and Mac |
| `server/live/lcu.ts`, `lcuSocket.ts` | Read-only requests and the event socket on 127.0.0.1 |

These files are exported from CompCue's main repository, where they are developed and tested. Please open issues here.

CompCue is not endorsed by Riot Games and does not reflect the views or opinions of Riot Games or anyone officially
involved in producing or managing Riot Games properties. Riot Games and all associated properties are trademarks or
registered trademarks of Riot Games, Inc.
