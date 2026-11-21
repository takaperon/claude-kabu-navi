# Claude株ナビ — 日本株スイングトレードの検証・シグナルアプリ

個人利用。iPhone Safari の PWA として使う予定（画面は後で作る）。

## 運用ルール（オーナーの指定）
- PC不要・ターミナル不要。iPhoneだけで使えること
- J-Quants はオーナーの判断で 2026-11-05 にライトプラン（月1,650円）へ変更済み。それ以外は月0円。許可なくこれ以上の有料プランにしない
- このリポジトリは **公開（Public）**。GitHub Actions の無料枠を使うため
- KITAICHI・KYOTEI・格差ナビには触らない

## データの扱い（公開リポジトリなので厳守）
- **本物のお金の情報は公開しない（2026-11-18 オーナーの指示「全部隠して。筒抜けにしないで」）**：金額・上限額・損益・保有は平文でコミット・ログ・公開ファイルに出さない。
  メモやコミット文にも金額を書かない。2026-12 にリポジトリを非公開にする予定（オーナー）
  reports ブランチの過去の live.json は履歴ごと削除済み（2026-11-18 強制push）。main の過去のコミットには少額の上限額が残る（別セッションが同時に push しているため書き換えは見送り。非公開化で解消）。
  reports ブランチは強制pushしたので、古いローカルの reports から push・pull --rebase しない（必ず fetch し直してから）
- データ源：J-Quants API V2（ライトプラン：過去5年・遅延なし、1分60リクエストまで）
- APIキーは GitHub Secrets の `JQUANTS_API_KEY` のみ。コード・ログ・コミットに絶対出さない
- **株価などJ-Quantsの生データはリポジトリにコミットしない**（再配布にならないように）。
  Actions キャッシュに暗号化して保存する
- Actions のログは公開されるので、個別銘柄の価格を出力しない。件数や集計値だけ
- `reports` ブランチに置くのは自前の集計結果（勝率・平均損益など）だけ
- **ウィブルSDKのログ（2026-11-18 点検で発覚）**：SDKは独自ハンドラでエラー時にリクエスト全体（アクセストークン・口座ID・数量）をログに出す。
  basicConfig(WARNING) では止まらなかった（11/10〜17 の live-check・live-trade・us-ipo の34回分に出ていた。ログは削除）。
  対策：各スクリプトで logging.disable(logging.CRITICAL)、ワークフローは `bash scripts/quiet.sh python ...` で実行（自前の `{"` 行だけ表示、失敗時は伏せ字の末尾だけ）。
  ウィブルを使う新しいスクリプトも必ずこの2つをそろえる。日本株の株価API（403確定）は呼ばない

## FX（2026-10-31〜、オーナーの指示で株と並行して検証）
- 株とデータ・結果を混ぜない（scripts/fx/、data-fx/、reports/fx-*.json）
- 為替データは Stooq（日足）、取れない時は FRED（終値のみ）。金利は FRED。データ本体はコミットしない
- レバレッジ1・2・5・10・25倍を並べ、ロスカット回数と不足金（借金）を必ず出す
- 実際のお金は使わない。まず検証→仮想売買

## 米国株（2026-11-06〜、オーナーの指示）
- 日本株とデータ・結果を混ぜない（scripts/us/、data-us/、reports/us-*.json）
- 銘柄：S&P500構成銘柄（Wikipedia の一覧。生存者バイアスあり）。株価：Tiingo 無料枠（Secrets の TIINGO_API_KEY）
- 決算発表日時：SEC EDGAR の 8-K（Item 2.02）。EPS・売上：SEC XBRL companyfacts（10-Q/10-Kの値を発表時点の数字とみなす）
- SECへの連絡先メールは Secrets の `SEC_CONTACT_EMAIL`（公開のステータス・ログには出さない。noreplyアドレスは拒否された）
- アナリスト予想・サプライズ・発表タイミング：Alpha Vantage 無料枠（Secrets の `ALPHAVANTAGE_API_KEY`、1日25社）。data-us/av/ に暗号化キャッシュ。そろうまで約3週間
- Tiingo 無料枠は1時間50回・1か月500銘柄まで。株価は7日以上古い銘柄だけ取り直す
- ナスダックのサイトは規約で自動取得禁止なので使わない
- 決算への反応（2026-11-14〜）：発表後最初の取引日の値動き（前日終値→終値）が+10%以上なら翌取引日の始値で買い20日保有。予想データなしで全銘柄検証でき、
  前半+85%/後半+40%（空き資金をSPYに置くと+139%/+71%、SPYは+49%/+36%）。us-backtest.yml で検証だけ単独実行できる
- 米国株の仮想売買（2026-11-14〜）：scripts/us/paper.mjs（30万円換算・最大10銘柄×10%・空き資金はSPY・税20.315%）。us.yml の中で毎朝実行。
  公開は reports/us-paper.json（銘柄・日付・損益率のみ）。SECの決算一覧は毎日、companyfacts は新しい発表があった時か30日ごと。
  Tiingo は SPY・直近7日に決算・保有・候補の銘柄を毎日優先して取る
- 設定の自動選択（2026-11-14〜、オーナーの指示「最適解を導き出すのも株ナビの仕事」）：backtest.mjs が反応しきい値{5,7,10,15%}×保有{5,10,20,40日}×空き資金{現金・SPYが200日線より上の時だけSPY・常にSPY}の48通りを試し、
  前半・後半ともSPY超え・最大の減り30%以内の中で min(前半年率, 後半年率) が最大のものを data-us/choice.json に書く。us.yml は backtest→paper の順で、paper はこれを使う（保有中の銘柄は買った時の日数のまま）
- 米国IPO（2026-11-16、オーナーの提案）：scripts/us/ipo.py ＋ us-ipo.yml（SEC 424B4→今の銘柄コード→SPAC除外→ウィブル日足で上場初日を確認、598社 2022-02〜）。
  結論：前半・後半とも安定して勝つ形なし。初値で買って持つと20日で中央値-12.5%/-8.4%。初日デイトレは前半平均+8.5%でも中央値-3.2%（一部の大化けだけ）で後半-1.2%。採用しない。
  要因分析（同日）：上場前に分かる募集額が1000万ドル未満は前半・後半とも大きく負け、2億ドル以上はほぼ五分（優位なし）。初日の売買代金は引けまで分からないので初値買いには使えない。詳細は research/log.md
- ウィブルAPIの株価：相場情報の「Nasdaq Basic - Non Display」（API用・無料、ノンプロ申告済み 2026-11-16）で米国株の日足（最大1200本）・スナップショットが取れる。日本株は不可
- 公開ファイルには秘密を出さない：us-fetch-status.json は書き出す前にキー・メールを伏せる（2026-11-14 Alpha Vantageのエラー文にキーが入っていて漏れた。履歴は消去済み、ログには残るのでキー再発行を依頼）
- 米東部9:30より前の発表は当日始値、それ以降は翌営業日始値で買う。手数料0（ウィブル）＋滑り0.1%。為替は未考慮

## 本番の自動売買（準備中）
- 証券会社：ウィブル証券（2026-11-09 口座開設、同日 OpenAPI 利用申請。審査は最短1〜2営業日）。日本株・米国株の株式・ETFをAPIで注文できる
- App Key / App Secret は GitHub Secrets のみ。2FAはオン（初回だけアプリでSMS承認。15日間APIを使わないとトークン失効）
- 申請時に申告した内容に合わせる：スイングトレード・1日10注文未満・1銘柄10%まで最大10銘柄・保有日数で必ず売却。
  **本番前に必ず作る**：1日の損失上限での新規停止、エラー連続時の自動停止（キルスイッチ）。注文部分は公式Python SDK
- 本物のお金は、仮想売買で成績を確認してから（オーナーの資金準備は年末ごろ）
- 2026-11-10 API承認・キー発行（Secrets：`WEBULL_APP_KEY` / `WEBULL_APP_SECRET`）。接続確認OK（現物口座1つ、残高・保有の読み取り成功）
- scripts/live/check.py ＋ .github/workflows/live-check.yml：読み取りのみの接続確認。毎朝08:40 JSTに実行してトークンを維持。
  トークンは WEBULL_APP_SECRET で暗号化して Actions キャッシュ（webull-token-）。公開の reports/live-check.json は成否と件数だけ
- **ウィブルは日本株の単元未満株に未対応（アプリもAPIも。2026-11-12 FAQで確認）＝日本株は100株単位**。米国株は端株OK（1ドル〜、通常時間のみ）。
  日本株APIの注文は成行・指値のみ（逆指値・寄付/引け指定なし）、通常取引時間内のみ。売りは15:25〜15:30（引けの板寄せ）に成行で出して引け値に近づける想定
- 100株単位の検証：fetch.mjs が data/raw/{date}.json（調整前の始値・終値）も保存。backtest.mjs の lotSim（資金30万〜300万×最大銘柄数1〜10）
- ウィブルAPIのマーケットデータ（株価）は購読が必要で403。決算予定・配当予定・EPS予想（前後半年）は取れる。
  ただし配当カレンダーは増配の発表を40件中10件しか見分けられず、J-Quants の開示の代わりにならない（2026-11-19 確認、research/log.md）。日本株の板・歩み値は「JPX Full Quotes Non-display」（月330円、オーナー検討中・未契約）
- **本番エンジン（2026-11-15〜、オーナーの指示で米国株・少額から）**：scripts/live/trade.py ＋ .github/workflows/live-trade.yml（平日 14:50 UTC＝米国の取引開始後）。
  設定は live/config.json（enabled／mode=dry・test・live／使うお金の上限は公開しない（Secrets の LIVE_MAX_USD。無いと売買しない）／dailyLossStopPct=5／maxErrors=3／resetHalt）。iPhoneのGitHub画面で編集して止められる。
  信号は reports/us-paper.json の nextBuys と settings.hold。売りは保有日数に達した翌取引日の寄り付き後（仮想は引け）。空き資金はSPY（2026-11-17〜）。
  注文：order_v3、market US、MARKET、CORE、entrust_type QTY（端数4桁）、account_tax_type SPECIFIC（必須。無いと417）。値段は1株の preview の estimated_cost で取る（株価データは購読が要るため）。
  AMOUNT（金額指定）は preview で 0 が返り項目名不明なので使わない。状態は Actions キャッシュ webull-live-（WEBULL_APP_SECRET で暗号化）。公開は reports/live.enc（Secrets の LIVE_VIEW_PASS で暗号化、scripts/live/seal.sh。アプリで合言葉を入れて復号）。合言葉が無い時は reports/live.min.json（状態だけ）
- 2026-11-17 01:10 JST 接続テスト成功（SPY 少額：買い・売りとも FILLED）→ mode=live で本番開始。初回の売りは約定数量で出して417（保有数量超え）。
  売る数量は口座の get_account_position の available_quantity を上限にする。NY 10:30以降は新しく買わない。定期実行は 14:50 と予備 15:12 UTC（11/16 は 14:50 が飛ばされた）。
  特別注文（config の special：1回だけ指値で買い翌日の寄りで売る）の仕組みあり（ANT用に作ったがオーナー判断で取りやめ）
- 2026-11-17 空いているお金をSPYに置く（config の idleSpy、オーナーOK）。買う株が出たらSPYを必要分だけ売る。SPYの数量は口座の保有（available_quantity・cost_price）で確かめる。
  値段は Nasdaq Basic のスナップショット（close）。preview の estimated_cost は約3%高めに出るので予備だけ。余力不足は preview で止めてエラーにしない
- SDK：pip の `webull-openapi-python-sdk`（region "jp"、本番 api.webull.co.jp、テスト jp-openapi-alb.uat.webullbroker.com）

## 場中の足（2026-11-18〜）
- 日本株：yfinance（Yahoo!、無料・口座なし・非公式）。scripts/jp/intraday_*.py ＋ jp-intraday.yml（毎時）。1時間足は約3年、5分足は60日。データは暗号化キャッシュ jp-intraday-（JQUANTS_API_KEY で暗号化）。足に引けの板寄せが入らないので、引けまで持つ分は J-Quants の正式な終値を使う
- 米国株：Tiingo IEX の5分足（us-intraday.yml、毎時40件）
- 状況ごとの売買ルール：scripts/playbook.py（日米共通。前半で状況ごとに選び、後半で確かめる）

## 相場の状態と提案（2026-11-20〜、オーナーの指摘「下がりそうだから買わない、上がりそうだから買う、も入れ込んで提案しないとダメ」）
- scripts/us/regime.mjs（us.yml・us-backtest.yml）→ reports/regime-us.json：最高値からの下げ・200日平均・20日の動き・VIX・政策金利の半年の動き・10年金利の3か月の動き・50日平均より上の銘柄の割合・6日続落。
  FRED（DFF・DGS10・VIXCLS、キー不要）。状態ごとに SPY の20・60日と、今のルールの20日の成績（前半・後半）
- 毎朝のニュース調査で today と成績表を読み、「今日の相場の判断と提案（いつもどおり／減らす／増やす）」を根拠つきで報告に入れる。本物のお金の設定はオーナーのOKの後
- 前もって日付が分かる発表（FOMC：scripts/us/macro.mjs → reports/macro-us.json、日程は2027年まで一覧で持つ）も、保有の売る予定日までに来るかを毎朝見て提案に入れる（2026-11-20 オーナー「ちゃんとそういうことも加味して提案するように」）。
  FOMC の結論（2026-11-20）：今のルールの個別株は会合の前に売らない方が良かった（前半-1.9%/後半-0.4%）。SPYは利上げ局面の会合の2日で平均-0.4%（14回、後半で未確認）
- 日本株：scripts/macro-jp.mjs（update.yml）→ reports/macro-jp.json。日銀の決定日・FOMCの次の東証の日の市場全体と増配デイトレ。2026-11-21 の結論：見送る理由は無い（日銀の日はむしろ強い）
- 増配の理由（2026-11-21〜）：pro.mjs の divreason-jp.json・reasonSims。理由は点数に混ぜない（混ぜると悪化）。「業種が弱っている時は見送る」を試験中 real30_dt_pro_sec で並走
- 2026-11-20 の結論：今のルールはどの状態でもS&P500を上回った。強い怖さ（VIX 30以上・広がり30%未満）の後のSPYは良かった。10年金利の3か月+0.5%以上は要注意

## 検証の方針
- 過去検証に未来の情報を混ぜない（シグナルは当日終値まで、エントリーは翌日始値）
- 生存者バイアスに注意（今上場している銘柄だけで検証している）
- 期間を前半（学習）と後半（テスト）に分け、両方で成績を出す。テストで再現したものだけ採用
- 手数料は0円（SOR注文で無料の証券会社前提）＋滑り0.1%/片道を見込む
- 全銘柄平均（何も考えずに買った場合）と比べて上回るかを必ず確認
- 利益を保証する表現は使わない。画面だけで「完成」と報告しない
- 結論を出す前に「なぜそうなったか」まで掘る（2026-11-16 オーナーの指摘「そういうところが詰めが甘い」）：
  平均と中央値がずれる・一部の銘柄だけ大きく勝つ等の時は、勝った（負けた）銘柄の共通点（価格帯・業種・時期・相場・売買代金など）で分けて調べてから「採用しない」を決める。
  オーナーの言った形（例「初値で買って翌日売る」）がぴったり検証済みか確認し、近い形で代用しない

## 仮想売買（2026-11-06〜）
- scripts/paper.mjs：毎営業日の引け後に、前日までのシグナルを始値で仮想購入→保有日数で終値売却→新しい開示から翌営業日の候補
- 状態（価格入り）は data/paper/state.json（暗号化キャッシュ）。公開の reports/paper.json は銘柄名・日付・損益率だけ
- シグナル判定は scripts/lib/events.mjs をバックテストと共通で使う
- 「朝高く始まった時だけ買う」版（*_gap）も並走。寄り前の気配で判断できる前提（厳密には寄り付き値を見てから買う形なので少し甘い）
- 本番想定（2026-11-12〜）：real30_div_gap（30万円・100株単位・2銘柄、増配＋朝高・5日）と real30_dt（30万円・100株単位・3銘柄、増配デイトレ）。
  100株の必要資金は data/raw の調整前始値。過去5年の100株検証：前者 30万→約173万（最大の減り-19.8%）、後者 30万→約109万（-12.9%）。年末に比べて本番を決める
- IPO（2026-11-16〜、オーナーの提案）：backtest.mjs の ipo（上場日＝データ途中で初めて始値がついた日、424銘柄）。デイトレ・初値買い・保有はどれも負け。
  唯一「初日の引けで買い→翌朝の寄りで売る」が前半+0.91%/後半+1.75%（勝率51/53%、最大の減り4%/2%）。paper.mjs の state.ipoNight（30万円・100株・2銘柄）で仮想売買、公開は paper.json の ipoNight
- デイトレは日足で測れる「寄りで買って引けで売る」だけ。分足はJ-Quantsのアドオン（月5,500円）が必要で、オーナー未承認

## プロの判断（2026-11-17〜、オーナーの指示「機械的すぎる。もっと専門性を持って、突き詰めて」）
- 検証：scripts/pro.mjs（日本株、update.yml で毎日。data/paper/pro-choice.json に前半だけで選んだ特徴を保存）・scripts/us/pro.mjs（us.yml・us-backtest.yml。data-us/pro-choice.json）
- 特徴の計算は検証と仮想売買で共通：scripts/lib/pro-features.mjs・scripts/us/lib-pro.mjs。点数＝前半で選んだ「効く特徴」に当てはまる数
- 仮想売買の試験中：日本 real30_dt_pro（点数2以上・マイナスなら最長10日持ち越し・30万円3銘柄）、real30_div_pro（点数1以上・5日）、米国 pro（+5%以上・点数3以上・40日）
- 結果は research/log.md。一番効くのは日本は「増配後の配当利回り」、米国は「反応の大きさ・出来高急増・EPS/売上の伸び」

## アプリ画面（2026-11-06〜）
- app/ の1ファイルPWA（index.html）。GitHub Pages で公開（.github/workflows/pages.yml）
- データは raw.githubusercontent.com の reports ブランチ（paper.json / backtest.json / news/）を直接読む。ニュースは毎朝07:47 JSTの定期タスク（2026-11-10〜、土日も）
- 上部の切り替えで日本株／米国株（2026-11-14〜。米国は reports/us-paper.json と us-backtest.json）。デザイン：株券モチーフ（藍・金の地紋）。初心者向けに用語は点線下線でタップ解説。銘柄コードは4桁表示

## ニュースの当たり外れ（2026-11-11〜）
- scripts/news-eval.mjs：reports ブランチの news/*.json の銘柄（+/-）を、調査日の始値で買い→1・5・20営業日後の終値で、全銘柄平均との差で判定。update.yml の中で実行
- 企業発表は J-Quants の開示（/fins/summary）と照合し、会社予想の営業利益・配当の変化率を付ける（ブログ等の数字の裏取り）
- 公開の reports/news-eval.json は損益率・件数だけ
- 調査で読めるサイト（2026-11-11 テスト）：s.kabutan.jp（スマホ版。PC版 kabutan.jp は不可）、traders.co.jp、media-ir.com、oanda.jp、NHKの記事ページ、act1.co.jp、scan.netsecurity.ne.jp、security-next.com、米国は thestreet・gvwire・stocktitan。
  読めない：TDnet（robots.txtで禁止）、ロイター日本語版、日経、時事、みんかぶ、Yahoo!ニュース、fisco、Japan Times

## 値上がりランキングと「上がった理由」の学習（2026-11-18〜、オーナーの要望）
- 日本：scripts/movers.mjs（update.yml）→ reports/movers-jp.json（売買代金1億円以上・100円以上、上位20・下位10、前日〜当日の開示を印に）
- 米国：scripts/live/movers.py（live-check.yml、毎朝08:40 JST）→ reports/movers-us.json（S&P500、ウィブルのスナップショットの前日比）
- 理由の調査：毎朝のニュース調査で、前の取引日の値上がり上位10（日米）と値下がり上位5の理由を調べ、reports の movers/YYYY-MM-DD.json に
  {date, items:[{market:'jp'|'us', code|t, pct, cat, reason, sources, confidence}]}。cat は 決算・上方修正・増配・自社株買い・提携/買収/TOB・新製品/受注・テーマ/思惑・
  アナリスト評価・需給（指数採用など）・悪材料の出尽くし・不明 のどれか。本文を読めず理由が分からなければ「不明」（推測で埋めない）。値動きを見る前の時点の情報だけで書く
- 学習：scripts/movers-eval.mjs（update.yml）→ reports/movers-eval.json。A) 過去5年の値上がり上位20を、開示の種類・上げ幅・翌朝の寄り付きで分け、次の日の寄りで買った後の1・5・20日（全銘柄平均との差）。
  B) 調べた理由（cat）ごとに同じ成績を積み上げる。週次研究で読み、効く形があれば仮想売買の試験中に

## 前もって分かる日付（2026-11-18〜、オーナーの提案「確実にこの日、という日は早くて1か月前に発表される。前もって予測しておく」）
- 決算発表予定日：fetch.mjs が J-Quants /fins/earnings-date を公表日ごとに data/earndate/{date}.json（[Code, PubDate, SchDate, FQName, FYE]）に保存。
  PubDate より後にしか予定日を知らなかった扱いで、scripts/earnpre.mjs が決算前の値動きを検証 → reports/earnpre-jp.json
- 会社ごとの行事（セール・新製品発表・説明会・月次売上・指数の入れ替えなど）：毎朝のニュース調査で、記事に「将来の日付」が出ていたら reports の events/calendar.json に
  {date, market, code|t, name, type, title, announcedOn, sources} で追記（重複しない）。行事の前後の値動きは、件数がたまってから検証

## 定期の調査・研究の動かし方（2026-11-17〜）
- 定期タスク（新しいセッション）はこのリポジトリが sources に無く、push が git proxy で 403（add_repo ツールも無い）。11/14〜17 のニュースはこのため未保存
- 毎朝のニュース調査・週次研究は、push できる元のチャット（セッション）で send_later を毎回予約し直して実行する。定期タスク2つは停止中（プロンプトは手順書として残す）

## 週次研究（2026-11-16〜、オーナーの指示「自己成長を続けて。違う角度で試すとか」）
- 定期タスク「Claude株ナビ 週次研究」（毎週日曜 13:37 JST）：点検 → research/log.md の未着手の角度から1〜3個を検証 → 有望なら仮想売買に「試験中」で追加 → 記録・報告
- 本物のお金の設定（live/config.json、scripts/live/trade.py）は研究では変えない。本番への反映は提案してオーナーの確認を取る
- 試したことは必ず research/log.md に追記（同じ仮説を繰り返さない）
- オーナーの指示「やってるフリや架空の情報は無し」：報告する数字は Actions で実際に動いた出力から読んだものだけ（出どころのファイル・コミットを記録）。動かなかった・失敗した時は「できなかった」と理由をそのまま報告する

## 開発環境メモ
- 開発用の作業環境からは J-Quants に直接つながらず、Actions API も使えない
- main への push で Actions が動き、結果を `reports` ブランチに書き戻す。それを git fetch して読む
