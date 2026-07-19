#!/bin/bash
set -e

PROJECT_DIR="/home/pi/nankaibusmap"
cd "$PROJECT_DIR"

echo "=== 更新開始: $(date '+%Y-%m-%d %H:%M:%S') ==="

# 前回の自動生成データが残っていてもpullを止めない
git restore \
  data/nankai/buses.json \
  data/nankai/gps.json \
  data/nankai/bus-no-gps.json \
  data/nankai/bus-errors.json \
  2>/dev/null || true

git pull --rebase origin main

/usr/bin/node scraper.js

git add \
  data/nankai/buses.json \
  data/nankai/gps.json \
  data/nankai/bus-no-gps.json \
  data/nankai/bus-errors.json

if git diff --cached --quiet; then
  echo "更新なし"
  exit 0
fi

git commit -m "Pi自動更新 $(date '+%Y-%m-%d %H:%M:%S')"
git pull --rebase origin main
git push origin main

echo "=== 更新完了: $(date '+%Y-%m-%d %H:%M:%S') ==="
