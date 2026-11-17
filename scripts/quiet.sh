#!/usr/bin/env bash
# 公開ログ対策（2026-11-18）：ウィブルSDKなどの出力は公開のActionsログに出さない。
# コマンドの出力はすべてランナー内の一時ファイルへ（アップロードもコミットもしない）。
# ログに出すのは、自分のスクリプトが print した1行のJSON（{" で始まる行）だけ。
# 失敗した時だけ、原因が分かるように末尾を「伏せ字にしてから」出す。
#   使い方: bash scripts/quiet.sh python scripts/live/check.py
set -u
LOG="$(mktemp)"
"$@" >"$LOG" 2>&1
code=$?
grep -E '^\{"' "$LOG" || true
if [ "$code" -ne 0 ]; then
  echo "失敗（終了コード $code）。出力の末尾（伏せ字済み）："
  tail -n 30 "$LOG" | sed -E \
    -e 's/[0-9a-fA-F]{24,}/***/g' \
    -e 's/[0-9]{6,}/***/g' \
    -e 's/("x-[a-z-]*"[[:space:]]*:[[:space:]]*")[^"]*/\1***/g' \
    -e 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/***@***/g'
fi
rm -f "$LOG"
exit "$code"
