# 米国株（S&P500）：本日の値上がり・値下がりランキング（2026-11-18〜、オーナーの要望）
# ウィブルAPIのスナップショット（Nasdaq Basic・API用・無料）で、S&P500全銘柄の前日比を取る。live-check の中で毎朝（米国の引け後）実行
# 公開するのは銘柄・名前・業種・上げ下げの率だけ（値段は出さない）
import json, logging, os, re, time, urllib.request
from datetime import datetime, timezone
logging.basicConfig(level=logging.WARNING)
# 2026-11-18：ウィブルSDKは独自のハンドラでエラー時にリクエスト全体（アクセストークン・口座ID）をログに出していた。
# 公開リポジトリのActionsログは誰でも読めるので、ログ出力そのものを全部止める（自分の結果は print で出す）
logging.disable(logging.CRITICAL)
os.makedirs("reports-out", exist_ok=True)
GICS_JA = {"Information Technology": "情報技術", "Health Care": "ヘルスケア", "Financials": "金融", "Consumer Discretionary": "一般消費財", "Communication Services": "通信サービス", "Industrials": "資本財", "Consumer Staples": "生活必需品", "Energy": "エネルギー", "Utilities": "公益", "Real Estate": "不動産", "Materials": "素材"}
GICS = list(GICS_JA)
out = {"updatedAt": datetime.now(timezone.utc).isoformat(), "error": None}

def save():
    json.dump(out, open("reports-out/movers-us.json", "w"), ensure_ascii=False, indent=1)
    print(json.dumps({k: out.get(k) for k in ("date", "count", "error", "batchOk", "single")}, ensure_ascii=False))

try:
    req = urllib.request.Request("https://en.wikipedia.org/w/index.php?title=List_of_S%26P_500_companies&action=raw", headers={"User-Agent": "ClaudeKabuNavi/1.0"})
    t = urllib.request.urlopen(req, timeout=60).read().decode("utf-8")
    uni = []
    for row in t.split("\n|-"):
        m = re.search(r"\{\{(?:NyseSymbol|NasdaqSymbol|nyse|nasdaq|Nyse|Nasdaq)\|([A-Z.\-]+)\}\}", row)
        if not m: continue
        nm = re.search(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]", row)
        sec = next((g for g in GICS if g in row), None)  # 業種（GICSの11分類）
        uni.append({"t": m.group(1), "name": (nm.group(2) or nm.group(1)).strip() if nm else m.group(1), "sector": GICS_JA.get(sec)})
    out["universe"] = len(uni)
    if len(uni) < 400: raise RuntimeError(f"universe {len(uni)}")

    from webull.core.client import ApiClient
    from webull.data.data_client import DataClient
    api = ApiClient(os.environ["WEBULL_APP_KEY"], os.environ["WEBULL_APP_SECRET"], "jp")
    api.set_token_dir(os.environ.get("WEBULL_OPENAPI_TOKEN_DIR", ".wbtoken"))
    md = DataClient(api).market_data
    num = lambda v: float(v) if v not in (None, "") else None
    snap = {}
    def rows_of(r):
        j = r.json()
        return j if isinstance(j, list) else (j.get("result") or j.get("data") or [j])
    syms = [u["t"] for u in uni]
    out["batchOk"] = 0; out["single"] = 0
    for i in range(0, len(syms), 20):
        part = syms[i:i + 20]
        try:
            r = md.get_snapshot(",".join(part), "US_STOCK")
            ok = r.status_code == 200 and len(rows_of(r)) > 1
        except Exception:
            ok = False
        if ok:
            out["batchOk"] += 1
            for x in rows_of(r):
                if x.get("symbol"): snap[x["symbol"]] = x
        else:
            for s in part:  # まとめて取れなければ1銘柄ずつ
                try:
                    r = md.get_snapshot(s, "US_STOCK")
                    if r.status_code == 200:
                        rr = rows_of(r)
                        if rr: snap[s] = rr[0]; out["single"] += 1
                except Exception:
                    pass
                time.sleep(0.1)
        time.sleep(0.2)
    lst, last = [], None
    for u in uni:
        x = snap.get(u["t"])
        if not x: continue
        c, ch = num(x.get("close")), num(x.get("change"))
        if not c or ch is None or c - ch <= 0: continue
        pct = round((c / (c - ch) - 1) * 100, 1)
        lst.append({"t": u["t"], "name": u["name"], "sector": u["sector"], "pct": pct})
        lt = x.get("last_trade_time")
        if lt and (last is None or str(lt) > str(last)): last = lt
    lst.sort(key=lambda z: -z["pct"])
    if isinstance(last, (int, float)) or (isinstance(last, str) and last.isdigit()):
        last = datetime.fromtimestamp(int(last) / (1000 if int(last) > 1e11 else 1), timezone.utc).date().isoformat()
    out.update({"date": str(last)[:10] if last else None, "count": len(lst), "note": "S&P500構成銘柄（Wikipediaの一覧）。ウィブルの相場情報（Nasdaq Basic）",
                "avgPct": round(sum(z["pct"] for z in lst) / len(lst), 2) if lst else None, "up": sum(1 for z in lst if z["pct"] > 0), "down": sum(1 for z in lst if z["pct"] < 0),
                "gainers": lst[:20], "losers": lst[-10:][::-1]})
except Exception as e:
    out["error"] = type(e).__name__ + ": " + str(e)[:120]
save()
