#!/bin/bash

set -e

PROJECT_DIR="/home/pi/nankaibusmap"
cd "$PROJECT_DIR"

echo "=== 更新開始: $(date '+%Y-%m-%d %H:%M:%S') ==="

git pull --rebase origin main

/usr/bin/node scraper.js

git add \
  buses.json \
  bus-gps.json \
  bus-no-gps.json \
  bus-errors.json

if git diff --cached --quiet; then
  echo "更新なし"
  exit 0
fi

git commit -m "Pi自動更新 $(date '+%Y-%m-%d %H:%M:%S')"
git pull --rebase origin main
git push origin main

echo "=== 更新完了: $(date '+%Y-%m-%d %H:%M:%S') ==="
