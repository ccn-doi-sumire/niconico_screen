#!/bin/bash
# Double-click to start the overlay on macOS. Quit from the 💬 menu bar icon or with Ctrl+C here.
#   ./start-mac.command        main screen (the one with the menu bar)
#   ./start-mac.command 1      second screen
#   ./start-mac.command -1     every screen
cd "$(dirname "$0")" || exit 1
exec osascript -l JavaScript overlay/mac-overlay.js "$@"
