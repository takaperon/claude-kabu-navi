# 米国株の「場中の値段（分足）」がどこから・どれだけ過去まで取れるかを調べる（2026-11-18、オーナーの指示「別枠で場中に売る形を検証」）
# 値段そのものは出さない。本数・日付の範囲・エラーの種類だけを reports-out/us-intraday-probe.json に書く
import inspect, json, logging, os, re, time, urllib.request
from datetime import datetime, timezone
logging.disable(logging.CRITICAL)  # ウィブルSDKがリクエスト全体をログに出すのを止める（CLAUDE.md）
os.makedirs("reports-out", exist_ok=True)
out = {"at": datetime.now(timezone.utc).isoformat(), "webull": {}, "tiingo": {}, "alphavantage": {}}
SECRETS = [os.environ.get(k, "") for k in ("TIINGO_API_KEY", "ALPHAVANTAGE_API_KEY", "WEBULL_APP_KEY", "WEBULL_APP_SECRET")]
def clean(s):
    s = str(s)
    for v in SECRETS:
        if v: s = s.replace(v, "***")
    return re.sub(r"[0-9a-fA-F]{24,}", "***", s)[:160]
def tday(t):
    if isinstance(t, str) and t.isdigit(): t = int(t)
    if isinstance(t, (int, float)): return datetime.fromtimestamp(t / 1000 if t > 1e11 else t, timezone.utc).strftime("%Y-%m-%d %H:%M")
    return str(t)[:16]

# ---- ウィブル（Nasdaq Basic・API用・無料）----
try:
    from webull.core.client import ApiClient
    from webull.data.data_client import DataClient
    api = ApiClient(os.environ["WEBULL_APP_KEY"], os.environ["WEBULL_APP_SECRET"], "jp")
    api.set_token_dir(os.environ.get("WEBULL_OPENAPI_TOKEN_DIR", ".wbtoken"))
    md = DataClient(api).market_data
    out["webull"]["signature"] = str(inspect.signature(md.get_history_bar))
    for ts in ["M1", "M5", "M15", "M30", "M60", "H1", "1m", "5m"]:
        try:
            r = md.get_history_bar("SPY", "US_STOCK", ts, count="1200")
            res = (r.json().get("result") or [{}])[0].get("result") or [] if r.status_code == 200 else []
            times = sorted(tday(b.get("time")) for b in res)
            out["webull"][ts] = {"status": r.status_code, "bars": len(res), "first": times[0] if times else None, "last": times[-1] if times else None, "keys": sorted(res[0].keys()) if res else None}
        except Exception as e:
            out["webull"][ts] = {"error": type(e).__name__ + ": " + clean(e)}
        time.sleep(0.5)
    # 過去の日を指定できるか（start_time / end_time の形を試す）
    from datetime import timezone as _tz
    t0 = int(datetime(2023, 3, 1, tzinfo=_tz.utc).timestamp()); t1 = int(datetime(2023, 3, 10, tzinfo=_tz.utc).timestamp())
    for label, kw in [("ms", {"start_time": str(t0 * 1000), "end_time": str(t1 * 1000)}), ("sec", {"start_time": str(t0), "end_time": str(t1)}),
                      ("iso", {"start_time": "2023-03-01", "end_time": "2023-03-10"}), ("end_ms_only", {"end_time": str(t1 * 1000)})]:
        try:
            r = md.get_history_bar("SPY", "US_STOCK", "M5", count="1200", **kw)
            res = (r.json().get("result") or [{}])[0].get("result") or [] if r.status_code == 200 else []
            times = sorted(tday(b.get("time")) for b in res)
            out["webull"]["hist_" + label] = {"status": r.status_code, "bars": len(res), "first": times[0] if times else None, "last": times[-1] if times else None}
        except Exception as e:
            out["webull"]["hist_" + label] = {"error": type(e).__name__ + ": " + clean(e)}
        time.sleep(0.5)
except Exception as e:
    out["webull"]["error"] = type(e).__name__ + ": " + clean(e)

# ---- Tiingo（IEXの場中データ）----
key = os.environ.get("TIINGO_API_KEY", "")
for label, sd, ed in [("2022_1min", "2022-03-01", "2022-03-02")]:
    try:
        u = f"https://api.tiingo.com/iex/SPY/prices?startDate={sd}&endDate={ed}&resampleFreq=1min&columns=open,high,low,close&token={key}"
        rows = json.loads(urllib.request.urlopen(urllib.request.Request(u, headers={"Content-Type": "application/json"}), timeout=60).read())
        out["tiingo"][label] = {"bars": len(rows), "first": rows[0]["date"][:16] if rows else None, "last": rows[-1]["date"][:16] if rows else None}
    except Exception as e:
        out["tiingo"][label] = {"error": type(e).__name__ + ": " + clean(e)}
    time.sleep(2)

json.dump(out, open("reports-out/us-intraday-probe.json", "w"), ensure_ascii=False, indent=1)
print(json.dumps({"probe": "done", "webull_keys": list(out["webull"].keys())}))
