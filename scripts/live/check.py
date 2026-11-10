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
except Exception as e:  # エラー文には識別子が入りうるので、種類とコードだけ
    out["error"] = type(e).__name__ + (":" + str(getattr(e, "error_code", "")) if getattr(e, "error_code", None) else "")
save()
