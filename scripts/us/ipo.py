# 米国IPO（新規上場）銘柄の短期売買の検証（2026-11-16〜、オーナーの提案）
# 1) SEC の四半期インデックスから 424B4（公開価格が決まった最終目論見書）を集める
# 2) 今の銘柄コード一覧（SEC company_tickers.json）と結びつけ、SPAC（SIC 6770）を除く
# 3) ウィブルのAPI（Nasdaq Basic・API用、無料）から日足を取り、上場初日＝最初の日足の日。424B4の日付と近いものだけをIPOとみなす
# 4) 日本株と同じ形の売買ルールを試し、前半・後半に分けて集計
# 生の株価は保存・公開しない。公開の reports-out/us-ipo.json は件数・損益率の集計だけ
# 注意：今も上場している銘柄だけ（上場廃止になったIPOは入らない＝甘めに出る）。ウィブルの日足は最大1200本（約4.8年）
import json, logging, os, re, time, statistics
from datetime import datetime, timezone, date, timedelta
import urllib.request, gzip

logging.basicConfig(level=logging.WARNING)
UA = f"ClaudeKabuNavi {os.environ.get('SEC_CONTACT_EMAIL', '').strip()}"
SLIP = 0.001
os.makedirs("reports-out", exist_ok=True)
status = {"startedAt": datetime.now(timezone.utc).isoformat()}

def sec_get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=60) as r:
        b = r.read()
        if r.headers.get("Content-Encoding") == "gzip": b = gzip.decompress(b)
    time.sleep(0.15)
    return b

# ---------- 1) 424B4 の一覧（2021年10月〜） ----------
today = date.today()
filings = {}  # cik -> 最初の424B4の日付
for y in range(2021, today.year + 1):
    for q in range(1, 5):
        if y == 2021 and q < 4: continue
        if date(y, 3 * q - 2, 1) > today: break
        try:
            txt = sec_get(f"https://www.sec.gov/Archives/edgar/full-index/{y}/QTR{q}/form.idx").decode("latin-1")
        except Exception as e:
            status.setdefault("indexErrors", []).append(f"{y}Q{q}:{type(e).__name__}")
            continue
        for line in txt.splitlines():
            if not line.startswith("424B4 "): continue
            m = re.search(r"\s(\d{3,10})\s+(\d{4}-\d{2}-\d{2})\s", line)
            if not m: continue
            cik, d = int(m.group(1)), m.group(2)
            if cik not in filings or d < filings[cik]: filings[cik] = d
status["filings424B4"] = len(filings)

# ---------- 2) 今の銘柄コードと結びつけ、SPACを除く ----------
tick = json.loads(sec_get("https://www.sec.gov/files/company_tickers.json"))
cik2t = {}
for v in tick.values():
    cik2t.setdefault(int(v["cik_str"]), (v["ticker"], v["title"]))
cands = []
for cik, d in filings.items():
    if cik not in cik2t: continue
    t, name = cik2t[cik]
    if not re.fullmatch(r"[A-Z]{1,5}", t): continue  # ユニット・ワラント等（記号入り）は除く
    cands.append({"cik": cik, "t": t, "name": name, "d424": d})
status["withTicker"] = len(cands)
kept = []
for c in cands:
    try:
        sub = json.loads(sec_get(f"https://data.sec.gov/submissions/CIK{c['cik']:010d}.json"))
    except Exception:
        continue
    if str(sub.get("sic")) == "6770": continue  # SPAC
    ex = [str(x) for x in (sub.get("exchanges") or [])]
    if not any(x in ("Nasdaq", "NYSE", "NYSE American", "NYSE MKT") for x in ex): continue
    c["sic"] = str(sub.get("sicDescription") or "")
    kept.append(c)
status["nonSpacListed"] = len(kept)

# ---------- 3) ウィブルの日足 ----------
from webull.core.client import ApiClient
from webull.data.data_client import DataClient
api = ApiClient(os.environ["WEBULL_APP_KEY"], os.environ["WEBULL_APP_SECRET"], "jp")
api.set_token_dir(os.environ.get("WEBULL_OPENAPI_TOKEN_DIR", ".wbtoken"))
md = DataClient(api).market_data

def bars(sym):
    for attempt in range(3):
        try:
            r = md.get_history_bar(sym, "US_STOCK", "D", count="1200")
            if r.status_code != 200: return None
            res = (r.json().get("result") or [{}])[0].get("result") or []
            out = []
            for b in res:
                tv = b.get("time")
                if isinstance(tv, str) and tv.isdigit(): tv = int(tv)
                if isinstance(tv, (int, float)):
                    tv = tv / 1000 if tv > 1e11 else tv
                    d = datetime.fromtimestamp(tv, timezone.utc).date().isoformat()
                else:
                    d = str(tv)[:10]
                o, c = float(b.get("open") or 0), float(b.get("close") or 0)
                if o > 0 and c > 0: out.append((d, o, c))
            out.sort()
            return out
        except Exception as e:
            status["lastBarError"] = type(e).__name__
            time.sleep(2)
    return None

ipos, fails, notIpo = [], 0, 0
spy = bars("SPY") or []
earliest = spy[0][0] if spy else "2022-02-01"
for c in kept:
    b = bars(c["t"])
    time.sleep(0.25)
    if not b: fails += 1; continue
    first = b[0][0]
    # 上場初日：ウィブルの日足の最初の日。日足の取れる期間の初日なら上場はもっと前なので除く
    if first <= earliest: notIpo += 1; continue
    gap = (date.fromisoformat(first) - date.fromisoformat(c["d424"])).days
    if gap < -3 or gap > 10: notIpo += 1; continue  # 424B4 と上場日が離れている＝追加の売り出しなど
    if len(b) < 3: continue
    ipos.append({**c, "first": first, "b": b})
status.update({"barFails": fails, "notIpo": notIpo, "ipos": len(ipos)})

# ---------- 4) 売買ルール ----------
dates_all = sorted({d for x in ipos for d, _, _ in x["b"]})
split_date = dates_all[int(len(dates_all) * 0.6)] if dates_all else "2025-01-01"
spy_c = {d: c for d, o, c in spy}

def oc(o, c): return (c * (1 - SLIP)) / (o * (1 + SLIP)) - 1
def run(name, fn):
    per = {"train": [], "test": []}
    for x in ipos:
        r = fn(x["b"])
        if r is None: continue
        d, ret = r
        if ret is None or not (ret == ret): continue
        per["train" if d < split_date else "test"].append(ret)
    def summ(a):
        if not a: return {"n": 0}
        return {"n": len(a), "winRate": round(sum(1 for r in a if r > 0) / len(a), 3), "avgRet": round(sum(a) / len(a), 4),
                "median": round(statistics.median(a), 4), "p10": round(sorted(a)[len(a) // 10], 4), "p90": round(sorted(a)[len(a) * 9 // 10], 4)}
    return {"name": name, "train": summ(per["train"]), "test": summ(per["test"])}

def hold(b, i, n):  # i日目の始値で買い、n日目の終値で売る
    j = i + n - 1
    if j >= len(b): return None
    return oc(b[i][1], b[j][2])

runs = {
    "day1_dt": run("上場初日：初値で買って引けで売る", lambda b: (b[0][0], oc(b[0][1], b[0][2]))),
    "day1_overnight": run("上場初日の引けで買って、2日目の寄りで売る", lambda b: (b[0][0], (b[1][1] * (1 - SLIP)) / (b[0][2] * (1 + SLIP)) - 1)),
    "day1_open_day2_open": run("初値で買って、2日目の寄りで売る", lambda b: (b[0][0], (b[1][1] * (1 - SLIP)) / (b[0][1] * (1 + SLIP)) - 1)),
    "day1_open_day2_close": run("初値で買って、2日目の引けで売る", lambda b: (b[0][0], hold(b, 0, 2))),
    "day2_dt": run("上場2日目にデイトレ", lambda b: (b[1][0], oc(b[1][1], b[1][2]))),
    "day3_dt": run("上場3日目にデイトレ", lambda b: (b[2][0], oc(b[2][1], b[2][2]))),
    "day1_up_day2_dt": run("初日に初値より上で引けた銘柄を、2日目にデイトレ", lambda b: (b[1][0], oc(b[1][1], b[1][2])) if b[0][2] > b[0][1] else None),
    "day1_down_day2_dt": run("初日に初値より下で引けた銘柄を、2日目にデイトレ", lambda b: (b[1][0], oc(b[1][1], b[1][2])) if b[0][2] < b[0][1] else None),
    "day1_up_overnight": run("初日に初値より上で引けた銘柄を、引けで買って翌朝売る", lambda b: (b[0][0], (b[1][1] * (1 - SLIP)) / (b[0][2] * (1 + SLIP)) - 1) if b[0][2] > b[0][1] else None),
    "day1_down_overnight": run("初日に初値より下で引けた銘柄を、引けで買って翌朝売る", lambda b: (b[0][0], (b[1][1] * (1 - SLIP)) / (b[0][2] * (1 + SLIP)) - 1) if b[0][2] < b[0][1] else None),
    "day1_open_hold5": run("初値で買って5日持つ", lambda b: (b[0][0], hold(b, 0, 5))),
    "day1_open_hold20": run("初値で買って20日持つ", lambda b: (b[0][0], hold(b, 0, 20))),
    "day2_open_hold20": run("2日目の寄りで買って20日持つ", lambda b: (b[1][0], hold(b, 1, 20))),
    "day21_open_hold20": run("上場1か月後の寄りで買って20日持つ", lambda b: (b[21][0], hold(b, 21, 20)) if len(b) > 41 else None),
    "day1_up_hold20": run("初日に初値より上で引けた銘柄を、2日目の寄りで買って20日持つ", lambda b: (b[1][0], hold(b, 1, 20)) if b[0][2] > b[0][1] else None),
}
# 比較：同じ日にS&P500を寄り→引け／引け→翌朝 で持った平均（滑りなし）
out = {
    "generatedAt": datetime.now(timezone.utc).isoformat(), "status": status,
    "period": {"from": dates_all[0] if dates_all else None, "split": split_date, "to": dates_all[-1] if dates_all else None},
    "note": "今も上場している米国IPOだけ（廃止は含まない）・SPAC除外・ウィブルの日足（Nasdaq Basic）・滑り片道0.1%",
    "runs": runs,
    "byYear": {y: sum(1 for x in ipos if x["first"].startswith(y)) for y in sorted({x["first"][:4] for x in ipos})},
}
json.dump(out, open("reports-out/us-ipo.json", "w"), ensure_ascii=False, indent=2)
print(json.dumps(status))
