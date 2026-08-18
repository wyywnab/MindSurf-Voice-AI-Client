#!/usr/bin/env bash

set -euo pipefail

project_dir="$(cd "$(dirname "$0")/.." && pwd)"
app_path="$project_dir/src-tauri/target/debug/bundle/macos/MindSurf Voice AI.app"
entitlements_path="$project_dir/src-tauri/Entitlements.plist"
launch_services="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

if pgrep -f "$app_path/Contents/MacOS/mindsurf-voice-ai" >/dev/null; then
  echo "MindSurf Voice AI is still running. Quit it from the tray or app menu before rebuilding." >&2
  exit 1
fi

cd "$project_dir"
npm run tauri build -- --debug --bundles app --no-sign

codesign \
  --force \
  --deep \
  --sign - \
  --identifier org.sast.mindsurf \
  --entitlements "$entitlements_path" \
  "$app_path"
codesign --verify --deep --strict --verbose=2 "$app_path"
"$launch_services" -f "$app_path"

echo "Built and ad-hoc signed: $app_path"
echo "Registered mindsurf:// with macOS LaunchServices."
echo "The signature hash changes after every rebuild. Reset and re-grant MindSurf permissions before testing a rebuilt app."
