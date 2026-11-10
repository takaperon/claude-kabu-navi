# ウィブル証券APIの接続確認（読み取りだけ。注文は出さない）
# 公開リポジトリなので、口座番号・残高・トークンはログにもファイルにも出さない。成否と件数だけ
import json, logging, os, sys, time
from datetime import datetime, timezone

logging.basicConfig(level=logging.WARNING)  # SDKの詳細ログ（口座情報を含みうる）を出さない
out = {"checkedAt": datetime.now(timezone.utc).isoformat(), "keyPresent": bool(os.getenv("WEBULL_APP_KEY")) and bool(os.getenv("WEBULL_APP_SECRET")),
       "tokenReady": False, "accounts": None, "accountTypes": None, "balanceOk": None, "positionsOk": None, "error": None}
os.makedirs("reports-out", exist_ok=True)

def save():
    with open("reports-out/live-check.json", "w") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(json.dumps(out, ensure_ascii=False))

if not out["keyPresent"]:
    out["error"] = "no-key"; save(); sys.exit(0)

try:
    from webull.core.client import ApiClient
    from webull.trade.trade_client import TradeClient
    api = ApiClient(os.environ["WEBULL_APP_KEY"], os.environ["WEBULL_APP_SECRET"], "jp")
    api.set_token_dir(os.environ.get("WEBULL_OPENAPI_TOKEN_DIR", ".wbtoken"))
    t0 = time.time()
    trade = TradeClient(api)  # 2段階認証：ここでトークンを作り、アプリでの承認を最大5分待つ
    out["tokenReady"] = True
    out["tokenWaitSec"] = round(time.time() - t0)
    res = trade.account_v2.get_account_list()
    out["accountListStatus"] = res.status_code
    if res.status_code == 200:
        accts = res.json() or []
        out["accounts"] = len(accts)
        out["accountTypes"] = sorted({str(a.get("account_type") or a.get("account_class") or "?") for a in accts})
        if accts:
            aid = accts[0].get("account_id")
            out["balanceOk"] = trade.account_v2.get_account_balance(aid).status_code == 200
            out["positionsOk"] = trade.account_v2.get_account_position(aid).status_code == 200
    # データが取れるかの確認（2026-11-10〜）。価格は出さず、成否・件数・期間だけ記録する
    from webull.data.data_client import DataClient
    data = DataClient(api)
    probes = {}
    def probe(name, fn, rows=lambda j: j):
        try:
            r = fn()
            item = {"status": r.status_code}
            if r.status_code == 200:
                j = rows(r.json())
                if isinstance(j, list):
                    item["rows"] = len(j)
                    ds = sorted(str(x.get("time") or x.get("date") or x.get("trade_date") or "")[:10] for x in j if isinstance(x, dict))
                    ds = [d for d in ds if d]
                    if ds: item["from"], item["to"] = ds[0], ds[-1]
            else:
                try: item["msg"] = str(r.json().get("message") or r.json().get("msg") or r.json().get("error_code"))[:120]
                except Exception: item["msg"] = r.text[:120]
            probes[name] = item
        except Exception as e:
            probes[name] = {"error": type(e).__name__, "msg": str(e)[:120]}
    md = data.market_data
    probe("jp_daily_7203", lambda: md.get_history_bar("7203", "JP_STOCK", "D", count="1200"))
    probe("jp_snapshot_7203", lambda: md.get_snapshot("7203", "JP_STOCK"))
    probe("us_daily_AAPL", lambda: md.get_history_bar("AAPL", "US_STOCK", "D", count="1200"))
    probe("us_earnings_AAPL", lambda: data.fundamentals.get_earnings_calendar("AAPL", "US_STOCK"))
    probe("jp_earnings_7203", lambda: data.fundamentals.get_earnings_calendar("7203", "JP_STOCK"))
    probe("jp_dividend_7203", lambda: data.fundamentals.get_dividend_calendar("7203", "JP_STOCK"))
    probe("us_forecast_eps_AAPL", lambda: data.fundamentals.get_forecast_eps("AAPL", "US_STOCK"))
    out["dataProbes"] = probes
except Exception as e:  # エラー文には識別子が入りうるので、種類とコードだけ
    out["error"] = type(e).__name__ + (":" + str(getattr(e, "error_code", "")) if getattr(e, "error_code", None) else "")
save()
