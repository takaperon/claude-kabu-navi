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
except Exception as e:
    out["webull"]["error"] = type(e).__name__ + ": " + clean(e)

# ---- Tiingo（IEXの場中データ）----
key = os.environ.get("TIINGO_API_KEY", "")
for label, sd, ed in [("2022", "2022-03-01", "2022-03-04"), ("2024", "2024-03-01", "2024-03-05"), ("recent", "2026-11-10", "2026-11-14")]:
    try:
        u = f"https://api.tiingo.com/iex/SPY/prices?startDate={sd}&endDate={ed}&resampleFreq=5min&columns=open,high,low,close&token={key}"
        rows = json.loads(urllib.request.urlopen(urllib.request.Request(u, headers={"Content-Type": "application/json"}), timeout=60).read())
        out["tiingo"][label] = {"bars": len(rows), "first": rows[0]["date"][:16] if rows else None, "last": rows[-1]["date"][:16] if rows else None}
    except Exception as e:
        out["tiingo"][label] = {"error": type(e).__name__ + ": " + clean(e)}
    time.sleep(2)

# ---- Alpha Vantage（月を指定して過去の分足）----
akey = os.environ.get("ALPHAVANTAGE_API_KEY", "")
try:
    u = f"https://www.alphavantage.co/query?function=TIME_SERIES_INTRADAY&symbol=SPY&interval=5min&month=2023-03&outputsize=full&apikey={akey}"
    j = json.loads(urllib.request.urlopen(u, timeout=60).read())
    ser = j.get("Time Series (5min)") or {}
    ks = sorted(ser.keys())
    out["alphavantage"] = {"bars": len(ser), "first": ks[0] if ks else None, "last": ks[-1] if ks else None, "note": clean(j.get("Information") or j.get("Note") or j.get("Error Message") or "")}
except Exception as e:
    out["alphavantage"] = {"error": type(e).__name__ + ": " + clean(e)}

json.dump(out, open("reports-out/us-intraday-probe.json", "w"), ensure_ascii=False, indent=1)
print(json.dumps({"probe": "done", "webull_keys": list(out["webull"].keys())}))
