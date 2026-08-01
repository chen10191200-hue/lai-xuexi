#!/bin/zsh
set -euo pipefail

root="${0:A:h}"
app="$root/来学习.app"
contents="$app/Contents"

rm -rf "$app"
mkdir -p "$contents/MacOS" "$contents/Resources/assets"
swiftc "$root/StudyApp.swift" -framework Cocoa -framework WebKit -framework UserNotifications -o "$contents/MacOS/Study"
cp "$root/Info.plist" "$contents/Info.plist"
cp "$root/index.html" "$root/app.js" "$root/style.css" "$contents/Resources/"
cp "$root/assets/study-icon-v2-final.png" "$contents/Resources/assets/"
cp "$root/assets/StudyIconV2.icns" "$contents/Resources/"
echo "已生成：$app"
