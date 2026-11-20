#!/bin/sh
# Remove CompCue Link from this Mac: the app, its login item, its token and its log.
set -eu
launchctl bootout "gui/$(id -u)/com.compcue.link" 2>/dev/null || true
pkill -x CompCueLink 2>/dev/null || true
pkill -x compcue-link 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.compcue.link.plist"
rm -rf "$HOME/Applications/CompCue Link.app" "$HOME/Library/Application Support/CompCue"
echo "CompCue Link was removed. You can also remove this Mac on the CompCue page under Connected computers."
