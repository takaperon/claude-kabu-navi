# ウィブル証券APIの接続確認（読み取りだけ。注文は出さない）
# 公開リポジトリなので、口座番号・残高・トークンはログにもファイルにも出さない。成否と件数だけ
import json, logging, os, sys, time
from datetime import datetime, timezone

logging.basicConfig(level=logging.WARNING)
# 2026-11-18：ウィブルSDKは独自のハンドラでエラー時にリクエスト全体（アクセストークン・口座ID）をログに出していた。
# 公開リポジトリのActionsログは誰でも読めるので、ログ出力そのものを全部止める（自分の結果は print で出す）
logging.disable(logging.CRITICAL)
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
                if isinstance(j, dict):  # 形の確認：項目名と、中の一覧の長さ（値段は出さない）
                    item["keys"] = sorted(list(j.keys()))[:15]
                    for kk, vv in j.items():
                        if isinstance(vv, list):
                            item["listKey"] = kk; j = vv
                            if vv and isinstance(vv[0], dict): item["rowKeys"] = sorted(list(vv[0].keys()))[:15]
                            break
                if isinstance(j, list):
                    item["rows"] = len(j)
                    if j and isinstance(j[0], dict): item["barKeys"] = sorted(list(j[0].keys()))[:15]
                    def _d(x):
                        v = x.get("time") or x.get("date") or x.get("trade_date") or x.get("timestamp") or ""
                        if isinstance(v, (int, float)) or (isinstance(v, str) and v.isdigit()):
                            v = int(v); v = v / 1000 if v > 1e11 else v
                            return datetime.fromtimestamp(v, timezone.utc).date().isoformat()
                        return str(v)[:10]
                    ds = sorted(_d(x) for x in j if isinstance(x, dict))
                    ds = [d for d in ds if d]
                    if ds: item["from"], item["to"] = ds[0], ds[-1]
            else:
                try: item["msg"] = str(r.json().get("message") or r.json().get("msg") or r.json().get("error_code"))[:120]
                except Exception: item["msg"] = r.text[:120]
            probes[name] = item
        except Exception as e:
            probes[name] = {"error": type(e).__name__, "msg": str(e)[:120]}
    md = data.market_data
    # 日本株の株価（JP_STOCK）は購読なしで403が確定済み（2026-11-12）。毎回エラーになりSDKがリクエストをログに出すので外した
    probe("us_daily_AAPL", lambda: md.get_history_bar("AAPL", "US_STOCK", "D", count="1200"), rows=lambda j: (j.get("result") or [{}])[0].get("result", []))
    probe("us_snapshot_AAPL", lambda: md.get_snapshot("AAPL", "US_STOCK"))
    probe("us_daily_RDDT", lambda: md.get_history_bar("RDDT", "US_STOCK", "D", count="1200"), rows=lambda j: (j.get("result") or [{}])[0].get("result", []))  # 2024年上場（IPOの検証に使えるか）
    probe("us_earnings_AAPL", lambda: data.fundamentals.get_earnings_calendar("AAPL", "US_STOCK"))
    probe("jp_earnings_7203", lambda: data.fundamentals.get_earnings_calendar("7203", "JP_STOCK"))
    probe("jp_dividend_7203", lambda: data.fundamentals.get_dividend_calendar("7203", "JP_STOCK"))
    probe("us_forecast_eps_AAPL", lambda: data.fundamentals.get_forecast_eps("AAPL", "US_STOCK"))
    out["dataProbes"] = probes
    # 注文の形の確認（preview＝見積もりだけで、注文は出ない）。米国株を金額指定・端数で買えるか
    if os.getenv("PREVIEW_PROBE") == "1" and accts:
        import uuid
        pv = {}
        base = {"combo_type": "NORMAL", "symbol": "SPY", "instrument_type": "EQUITY", "market": "US", "order_type": "MARKET",
                "support_trading_session": "CORE", "side": "BUY", "time_in_force": "DAY", "account_tax_type": "SPECIFIC"}
        variants = {
            "amount_total_cash_amount": {"entrust_type": "AMOUNT", "total_cash_amount": "5"},
            "amount_amount": {"entrust_type": "AMOUNT", "amount": "5"},
            "amount_cash_amount": {"entrust_type": "AMOUNT", "cash_amount": "5"},
            "qty_fraction": {"entrust_type": "QTY", "quantity": "0.01"},
            "qty_one": {"entrust_type": "QTY", "quantity": "1"},
        }
        for name, v in variants.items():
            try:
                r = trade.order_v3.preview_order(aid, [{**base, **v, "client_order_id": uuid.uuid4().hex}])
                item = {"status": r.status_code}
                try:
                    j = r.json()
                    item["msg"] = str(j.get("message") or j.get("msg") or j.get("error_code") or "")[:160]
                    if r.status_code == 200 and isinstance(j, dict): item["estimated_cost"] = str(j.get("estimated_cost"))[:20]  # 5ドル分の見積もり額だけ（口座情報ではない）
                except Exception:
                    item["msg"] = r.text[:160]
                pv[name] = item
            except Exception as e:
                pv[name] = {"error": type(e).__name__, "msg": str(e)[:160]}
        out["previewProbes"] = pv
except Exception as e:  # エラー文には識別子が入りうるので、種類とコードだけ
    out["error"] = type(e).__name__ + (":" + str(getattr(e, "error_code", "")) if getattr(e, "error_code", None) else "")
save()
