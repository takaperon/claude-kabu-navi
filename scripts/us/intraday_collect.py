# 米国株の場中（5分足）を集める（2026-11-18〜、オーナーの指示「別枠で、場中に売る形を検証」）
# 対象：reports/us-events.json（決算の翌日に+5%以上上げた銘柄と、次の取引日＝買う日）。買う日から約20取引日分（28暦日）の5分足を Tiingo（IEX）から取る
# Tiingo 無料枠は1時間50回なので、1回の実行で最大40件。毎時動かして少しずつためる。データ本体は暗号化キャッシュだけ（コミットしない）
import json, os, re, sys, time, urllib.request
from datetime import date, timedelta
KEY = os.environ.get("TIINGO_API_KEY", "")
DIR = "data-us-intraday"
os.makedirs(DIR, exist_ok=True)
MAX = int(os.environ.get("MAX_REQ", "40"))
ev = json.load(open("us-events.json"))["events"]
# +10%以上（今のルールの対象）から先に、新しい順に
ev.sort(key=lambda e: (e["re"] < 10, e["entry"]), reverse=False)
ev = sorted(ev, key=lambda e: (0 if e["re"] >= 10 else 1, e["entry"]))
done = set(f[:-5] for f in os.listdir(DIR) if f.endswith(".json"))
st = {"have": len(done), "fetched": 0, "empty": 0, "errors": 0, "lastError": None, "stoppedBy": None}
def clean(s): return re.sub(re.escape(KEY), "***", str(s))[:160] if KEY else str(s)[:160]
for e in ev:
    k = f"{e['t']}_{e['entry']}"
    if k in done: continue
    if st["fetched"] + st["empty"] + st["errors"] >= MAX: st["stoppedBy"] = "max"; break
    sd = e["entry"]; ed = (date.fromisoformat(sd) + timedelta(days=28)).isoformat()
    u = f"https://api.tiingo.com/iex/{e['t'].replace('.', '-')}/prices?startDate={sd}&endDate={ed}&resampleFreq=5min&columns=open,high,low,close&token={KEY}"
    try:
        rows = json.loads(urllib.request.urlopen(urllib.request.Request(u, headers={"Content-Type": "application/json"}), timeout=60).read())
        bars = [[r["date"][:16], r["open"], r["high"], r["low"], r["close"]] for r in rows if r.get("open")]
        json.dump(bars, open(f"{DIR}/{k}.json", "w"))
        st["fetched" if bars else "empty"] += 1
    except Exception as x:
        st["errors"] += 1; st["lastError"] = type(x).__name__ + ": " + clean(x)
        if "429" in str(x) or "limit" in str(x).lower(): st["stoppedBy"] = "limit"; break
    time.sleep(1.5)
st["have"] = len([f for f in os.listdir(DIR) if f.endswith(".json")]); st["total"] = len(ev)
print(json.dumps({"collect": st}))
json.dump(st, open("collect-status.json", "w"))
