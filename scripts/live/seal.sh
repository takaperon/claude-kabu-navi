#!/usr/bin/env bash
# 本番の成績（reports-out/live.json）を公開前に封をする（2026-11-18〜、オーナーの指示「全部隠して」）
# - Secrets の LIVE_VIEW_PASS があれば、それで暗号化して reports-out/live.enc（base64・1行）にする。
#   形式は openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -salt（アプリが WebCrypto で同じ手順で復号する）
# - 無ければ、中身は出さず「動いているか」だけの最小限にする
# どちらの場合も平文の live.json は消す（公開ブランチに置かない）
set -eu
IN=reports-out/live.json
[ -f "$IN" ] || exit 0
if [ -n "${LIVE_VIEW_PASS:-}" ]; then
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 -salt -a -A -pass env:LIVE_VIEW_PASS -in "$IN" -out reports-out/live.enc
  rm -f "$IN"
  echo '{"sealed": true}'
else
  python3 - "$IN" <<'EOF'
import json, sys
p = sys.argv[1]; j = json.load(open(p))
keep = {k: j.get(k) for k in ("runAt", "date", "mode", "enabled", "status", "halted")}
keep["sealed"] = False
keep["note"] = "合言葉（Secrets の LIVE_VIEW_PASS）が未設定なので、成績は公開していません"
json.dump(keep, open("reports-out/live.min.json", "w"), ensure_ascii=False, indent=2)
EOF
  rm -f "$IN"
  echo '{"sealed": false}'
fi
