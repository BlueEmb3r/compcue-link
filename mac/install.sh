#!/bin/sh
# CompCue Link for Mac: install, or update.
#
#   curl -fsSL <address from the CompCue page> | sh -s -- <one-time key> [site]
#   ... | sh -s -- --update          replace the app with the newest release, keep the pairing
#
# What it does, and nothing else:
#   1. downloads the app for this Mac from the GitHub release and checks it against the release's SHA256SUMS
#   2. puts "CompCue Link.app" in ~/Applications (no administrator password, nothing outside your home folder)
#   3. makes it start at login (~/Library/LaunchAgents/com.compcue.link.plist; switch it off in the app's menu)
#   4. connects it to the CompCue account whose page gave you the command, and starts it
# Remove everything again with uninstall.sh (same folder as this file in the repository).
set -eu

KEY="${1:-}"
SITE="${2:-${COMPCUE_SITE:-https://compcue.aflince.com}}"
UPDATE=0
if [ "$KEY" = "--update" ]; then UPDATE=1; KEY=""; fi
BASE="${COMPCUE_RELEASE_URL:-https://github.com/BlueEmb3r/compcue-link/releases/latest/download}"
APP="$HOME/Applications/CompCue Link.app"
AGENT="$HOME/Library/LaunchAgents/com.compcue.link.plist"
LABEL="com.compcue.link"

say() { printf '%s\n' "$*"; }
fail() { say "CompCue Link was not installed: $*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "this installer is for Macs."
case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) fail "this Mac's processor is not supported." ;;
esac
# the key and the site come from a copied command: accept only their expected shapes
case "$KEY" in *[!A-Za-z0-9_-]*) fail "the install command looks damaged. Copy it again from the CompCue page." ;; esac
case "$SITE" in
  https://*|http://127.0.0.1:*|http://localhost:*) ;;
  *) fail "the site address must be https." ;;
esac
case "$SITE" in *[!A-Za-z0-9.:/_-]*) fail "the site address looks damaged." ;; esac

ZIP="CompCueLink-mac-$ARCH.zip"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "Downloading CompCue Link..."
curl -fL --proto '=https,http' --progress-bar -o "$TMP/$ZIP" "$BASE/$ZIP" || fail "the download failed. Check your connection and try again."
curl -fsSL --proto '=https,http' -o "$TMP/SHA256SUMS" "$BASE/SHA256SUMS" || fail "the download failed. Check your connection and try again."
WANT="$(awk -v f="$ZIP" '$2 == f || $2 == "*" f { print $1 }' "$TMP/SHA256SUMS")"
GOT="$(shasum -a 256 "$TMP/$ZIP" | awk '{ print $1 }')"
[ -n "$WANT" ] && [ "$WANT" = "$GOT" ] || fail "the download did not match the release. Nothing was changed."

# stop the copy that is running (the token and settings stay where they are)
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
pkill -x CompCueLink 2>/dev/null || true
pkill -x compcue-link 2>/dev/null || true

mkdir -p "$HOME/Applications" "$TMP/out"
ditto -x -k "$TMP/$ZIP" "$TMP/out"
[ -x "$TMP/out/CompCue Link.app/Contents/MacOS/CompCueLink" ] || fail "the download was not the app. Nothing was changed."
rm -rf "$APP"
mv "$TMP/out/CompCue Link.app" "$APP"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

# start at login, unless the player switched it off in the menu before this update
if [ "$UPDATE" = 0 ] || [ -f "$AGENT" ]; then
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$AGENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$APP/Contents/MacOS/CompCueLink</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Interactive</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
</dict>
</plist>
PLIST
fi

# connect it to the account that gave the command (no code to confirm)
if [ -n "$KEY" ]; then
  COMPCUE_NO_BROWSER=1 "$APP/Contents/MacOS/compcue-link" --site "$SITE" --setup "$KEY" --pair-only >/dev/null 2>&1 &
  PAIR=$!
  # the short way answers in a second or two; if the key ran out the app shows a code to confirm instead
  i=0; while kill -0 "$PAIR" 2>/dev/null && [ "$i" -lt 8 ]; do sleep 1; i=$((i + 1)); done
  kill "$PAIR" 2>/dev/null || true
fi

if [ "$SITE" != "https://compcue.aflince.com" ]; then
  # another site (self-hosting, development): the app is started with it every time
  /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables dict" -c "Add :EnvironmentVariables:COMPCUE_SITE string $SITE" "$AGENT" 2>/dev/null || true
  COMPCUE_SITE="$SITE" open "$APP" --env "COMPCUE_SITE=$SITE" 2>/dev/null || COMPCUE_SITE="$SITE" open "$APP"
else
  open "$APP"
fi

if [ "$UPDATE" = 1 ]; then say "CompCue Link is up to date."; else
  say ""
  say "Done. CompCue Link is in your menu bar and starts with your Mac."
  say "Open League and go back to the CompCue page."
fi
