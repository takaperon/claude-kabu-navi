# 本番の自動売買の設定（iPhoneのブラウザで編集できます）

`config.json` を GitHub の画面で開き、鉛筆マークで編集 → Commit changes。

- `enabled`：`false` にすると、次の実行から何もしなくなります（緊急停止）
- `mode`：`dry`（注文を出さず、出す予定だけ記録）／`live`（本物の注文を出す）
- 使ってよいお金の上限（ドル）は公開しないため、ここではなく GitHub の Settings → Secrets and variables → Actions の `LIVE_MAX_USD` で変えます
- 本番の成績は合言葉（Secrets の `LIVE_VIEW_PASS`）で暗号化して公開しています。アプリで合言葉を入れると見られます
- `dailyLossStopPct`：前回より何%減ったら、その日は新しく買わないか
- `maxErrors`：エラーが何回続いたら止めるか
- `resetHalt`：エラーで止まった後、`true` にすると再開（再開したら `false` に戻す）
