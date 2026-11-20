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
# 2026-11-18：ウィブルSDKは独自のハンドラでエラー時にリクエスト全体（アクセストークン・口座ID）をログに出していた。
# 公開リポジトリのActionsログは誰でも読めるので、ログ出力そのものを全部止める（自分の結果は print で出す）
logging.disable(logging.CRITICAL)
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
                v = float(b.get("volume") or 0)
                if o > 0 and c > 0: out.append((d, o, c, v))
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
dates_all = sorted({x2[0] for x in ipos for x2 in x["b"]})
split_date = dates_all[int(len(dates_all) * 0.6)] if dates_all else "2025-01-01"
spy_c = {r[0]: r[2] for r in spy}

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
# ---------- 5) 跳ねた要因の分析（2026-11-16 オーナーの指摘「跳ねた要因は何だったのか」） ----------
# 各IPOの特徴（買う時点で分かるもの）ごとに、初日（初値→引け）と20日（初値→20日目の引け）の成績を分ける
# 特徴：初値の水準・業種・上場年・その時のS&P500の調子（前日終値が200日平均より上か）・上場前の公開価格（424B4から読む）に対する初値の上げ幅
spy_d = [r[0] for r in spy]; spy_cl = [r[2] for r in spy]
def spy_up(d):
    k = max((i for i, x in enumerate(spy_d) if x < d), default=None)
    if k is None or k < 199: return None
    return spy_cl[k] > sum(spy_cl[k - 199:k + 1]) / 200

def offer_price(cik, d424):
    # 424B4 の表紙の「public offering price ... $xx.xx per share」を読む（読めなければ None）
    try:
        idx = json.loads(sec_get(f"https://data.sec.gov/submissions/CIK{cik:010d}.json"))
        rec = idx.get("filings", {}).get("recent", {})
        for f, fd, acc, doc in zip(rec.get("form", []), rec.get("filingDate", []), rec.get("accessionNumber", []), rec.get("primaryDocument", [])):
            if f != "424B4" or fd != d424: continue
            html = sec_get(f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc.replace('-', '')}/{doc}").decode("latin-1")
            txt = re.sub(r"<[^>]+>", " ", html[:400000]); txt = re.sub(r"&nbsp;|&#160;", " ", txt); txt = re.sub(r"\s+", " ", txt)
            head = txt[:30000]
            ms = re.search(r"([\d,]{6,})\s+(?:shares|ordinary shares|common shares|class a (?:common|ordinary) (?:stock|shares)|american depositary shares|ADSs)", head, re.I)
            shares = float(ms.group(1).replace(",", "")) if ms else None
            m = re.search(r"(?:initial )?public offering price[^$]{0,120}\$\s?(\d{1,4}(?:\.\d{1,2})?)\s*per (?:share|ADS|American Depositary)", txt, re.I) \
                or re.search(r"offering price (?:of|is) \$\s?(\d{1,4}(?:\.\d{1,2})?)", txt, re.I)
            return (float(m.group(1)) if m else None, shares)
    except Exception:
        return (None, None)
    return (None, None)

offer_ok = 0
for x in ipos:
    b = x["b"]
    x["d1"] = oc(b[0][1], b[0][2])
    x["h20"] = hold(b, 0, 20)
    x["o2o"] = (b[1][1] * (1 - SLIP)) / (b[0][1] * (1 + SLIP)) - 1
    x["spyUp"] = spy_up(x["first"])
    op, sh = offer_price(x["cik"], x["d424"])
    x["deal"] = op * sh if (op and sh and 1e5 < op * sh < 5e10) else None
    x["c2o"] = (b[1][1] * (1 - SLIP)) / (b[0][2] * (1 + SLIP)) - 1
    x["c20"] = ((b[20][2] * (1 - SLIP)) / (b[0][2] * (1 + SLIP)) - 1) if len(b) > 20 else None
    if op and not (0.1 < b[0][1] / op < 20): op = None  # 読み違い（ワラント価格など）を除く
    x["pop"] = (b[0][1] / op - 1) if op else None
    x["offer"] = op
    if op: offer_ok += 1
status["offerPriceParsed"] = offer_ok

def summ2(a):
    a = [r for r in a if r is not None and r == r]
    if not a: return {"n": 0}
    s = sorted(a)
    return {"n": len(a), "winRate": round(sum(1 for r in a if r > 0) / len(a), 3), "avgRet": round(sum(a) / len(a), 4), "median": round(statistics.median(a), 4)}

def group(keyfn):
    g = {}
    for x in ipos:
        k = keyfn(x)
        if k is None: continue
        half = "train" if x["first"] < split_date else "test"
        g.setdefault(k, {"train": [], "test": []})[half].append(x)
    return {k: {h: {"day1": summ2([x["d1"] for x in v[h]]), "nextOpen": summ2([x["o2o"] for x in v[h]]), "hold20": summ2([x["h20"] for x in v[h]])} for h in ("train", "test")} for k, v in sorted(g.items())}

def deal_bucket(x):  # 募集額＝公開価格×株数（424B4の表紙。上場前に分かる）
    v = x["deal"]
    return None if not v else "a:1000万ドル未満" if v < 1e7 else "b:1000万〜5000万ドル" if v < 5e7 else "c:5000万〜2億ドル" if v < 2e8 else "d:2億ドル以上"
def group2(keyfn):  # 初日の引けで買う形（初日の売買代金が分かってから買う）
    g = {}
    for x in ipos:
        k = keyfn(x)
        if k is None: continue
        half = "train" if x["first"] < split_date else "test"
        g.setdefault(k, {"train": [], "test": []})[half].append(x)
    return {k: {h: {"closeToNextOpen": summ2([x["c2o"] for x in v[h]]), "closeHold20": summ2([x["c20"] for x in v[h]])} for h in ("train", "test")} for k, v in sorted(g.items())}
def px_bucket(x):
    o = x["offer"] or x["b"][0][1]
    return "a:5ドル未満" if o < 5 else "b:5〜10ドル" if o < 10 else "c:10〜20ドル" if o < 20 else "d:20ドル以上"
def pop_bucket(x):
    p = x["pop"]
    if p is None: return None
    return "a:公開価格より下で初値" if p < 0 else "b:0〜+20%" if p < 0.2 else "c:+20〜50%" if p < 0.5 else "d:+50〜100%" if p < 1 else "e:+100%以上"
def sector(x):
    s = x.get("sic", "").lower()
    if any(w in s for w in ("pharmaceutical", "biological", "medical", "surgical", "diagnostic", "health")): return "医薬・医療"
    if any(w in s for w in ("software", "computer", "data processing", "semiconductor", "electronic", "prepackaged")): return "IT・半導体"
    if any(w in s for w in ("bank", "finance", "insurance", "investment", "credit", "real estate", "security brokers")): return "金融・不動産"
    if any(w in s for w in ("retail", "eating", "apparel", "food", "beverage", "hotel", "amusement")): return "小売・消費"
    return "その他"
def dollar_vol(x):  # 初日の売買代金（初日の引けで分かる。翌朝売り・20日持ちの判断用）
    v = x["b"][0][3] * x["b"][0][2]
    return None if not v else "a:1000万ドル未満" if v < 1e7 else "b:1000万〜1億ドル" if v < 1e8 else "c:1億ドル以上"

# 大化け（初日+50%以上）とそれ以外で、特徴の割合を比べる
big = [x for x in ipos if x["d1"] >= 0.5]
def share(a, fn):
    out = {}
    for x in a:
        k = fn(x); out[k] = out.get(k, 0) + 1
    return {k: round(v / len(a), 3) for k, v in sorted(out.items(), key=lambda kv: str(kv[0]))} if a else {}
factors = {
    "note": "買う時点で分かる特徴ごとの成績（初日=初値→引け、nextOpen=初値→2日目の寄り、hold20=初値→20日目の引け。滑り片道0.1%）。公開価格は424B4の表紙から読めたものだけ",
    "byPrice": group(px_bucket), "byPop": group(pop_bucket), "bySector": group(sector), "byYear": group(lambda x: x["first"][:4]),
    "bySpyTrend": group(lambda x: None if x["spyUp"] is None else ("S&P500が200日平均より上" if x["spyUp"] else "S&P500が200日平均より下")),
    "byDay1DollarVolume": group(dollar_vol),
    "byDealSize": group(deal_bucket),
    "closeBuyByDay1DollarVolume": group2(dollar_vol),
    "dealParsed": sum(1 for x in ipos if x["deal"]),
    "caution": "初値の水準（byPrice）と公開価格からの上げ幅（byPop）は、上場後の株式併合で日足の値段が調整されている銘柄があり当てにならない。売買代金と募集額（公開価格×株数）は併合の影響を受けない",
    "bigMovers": {"count": len(big), "rule": "初日に初値→引けで+50%以上",
                  "priceShare": share(big, px_bucket), "priceShareAll": share(ipos, px_bucket),
                  "sectorShare": share(big, sector), "sectorShareAll": share(ipos, sector),
                  "list": [{"t": x["t"], "first": x["first"], "sector": sector(x), "price": px_bucket(x)[2:], "day1Pct": round(x["d1"] * 100, 1),
                            "hold20Pct": None if x["h20"] is None else round(x["h20"] * 100, 1)} for x in sorted(big, key=lambda x: -x["d1"])[:30]]},
}

# ---------- 6) 上場後の長めの値動き（2026-11-20 オーナー「ANTをどこかで仕込みたい」） ----------
# 初日の引けを1として、上場からn取引日目の終値（S&P500との差も）。ロックアップ（180日＝約124取引日）の前後も見る
# 大型（募集額2億ドル以上・10億ドル以上）と全体で分ける。今も上場している銘柄だけなので、甘めに出る（生存者バイアス）
def after_ipo(sel):
    days = [5, 10, 20, 40, 60, 90, 124, 150, 180, 250]
    path, entries, lows, lock = {}, {}, [], {"before10": [], "after10": [], "after20": []}
    for x in sel:
        b = x["b"]; c0 = b[0][2]; s0 = spy_c.get(b[0][0])
        if not (c0 and c0 > 0): continue
        for n in days:
            if n < len(b):
                r = b[n][2] / c0 - 1; sn = spy_c.get(b[n][0])
                rel = r - (sn / s0 - 1) if (s0 and sn) else None
                path.setdefault(n, {"ret": [], "rel": []}); path[n]["ret"].append(r)
                if rel is not None: path[n]["rel"].append(rel)
        if len(b) > 250:
            k = min(range(1, 251), key=lambda i: b[i][2]); lows.append(k)
            for e in (1, 20, 40, 60, 90, 124, 150):  # e日目の寄りで買って250日目の引けまで（S&P500との差）
                se, sx = spy_c.get(b[e - 1][0]), spy_c.get(b[250][0])
                r = oc(b[e][1], b[250][2]); rel = r - (sx / se - 1) if (se and sx) else None
                if rel is not None: entries.setdefault(e, []).append(rel)
        if len(b) > 145:
            def rel(i, j):
                si, sj = spy_c.get(b[i][0]), spy_c.get(b[j][0])
                return (b[j][2] / b[i][2] - 1) - (sj / si - 1) if (si and sj and b[i][2] > 0) else None
            for k2, (i, j) in {"before10": (114, 124), "after10": (124, 134), "after20": (124, 144)}.items():
                v = rel(i, j)
                if v is not None: lock[k2].append(v)
    med = lambda a: round(statistics.median(a), 4) if a else None
    up = lambda a: round(sum(1 for v in a if v > 0) / len(a), 3) if a else None
    return {"n": len(sel),
            "path": {n: {"n": len(v["ret"]), "medRet": med(v["ret"]), "upShare": up(v["ret"]), "medVsSpy": med(v["rel"])} for n, v in sorted(path.items())},
            "lowestDay": {"n": len(lows), "median": med(lows), "share_le20": up([1 if v <= 20 else -1 for v in lows]), "share_ge124": up([1 if v >= 124 else -1 for v in lows])},
            "entryToDay250VsSpy": {e: {"n": len(v), "med": med(v), "avg": round(sum(v) / len(v), 4), "beatSpy": up(v)} for e, v in sorted(entries.items())},
            "lockupVsSpy": {k: {"n": len(v), "med": med(v), "avg": round(sum(v) / len(v), 4) if v else None} for k, v in lock.items()}}
afterIpo = {"note": "初日の終値＝基準。path=上場からn取引日目（124日≒ロックアップの180日）。entryToDay250VsSpy=e日目の寄りで買って250日目の引けまでのS&P500との差。lockupVsSpy=124日目の前後10・20日。今も上場している銘柄だけ（甘め）",
            "all": after_ipo(ipos), "deal200m": after_ipo([x for x in ipos if (x["deal"] or 0) >= 2e8]), "deal1b": after_ipo([x for x in ipos if (x["deal"] or 0) >= 1e9])}

# 比較：同じ日にS&P500を寄り→引け／引け→翌朝 で持った平均（滑りなし）
out = {
    "generatedAt": datetime.now(timezone.utc).isoformat(), "status": status,
    "period": {"from": dates_all[0] if dates_all else None, "split": split_date, "to": dates_all[-1] if dates_all else None},
    "note": "今も上場している米国IPOだけ（廃止は含まない）・SPAC除外・ウィブルの日足（Nasdaq Basic）・滑り片道0.1%",
    "runs": runs,
    "factors": factors,
    "afterIpo": afterIpo,
    "byYear": {y: sum(1 for x in ipos if x["first"].startswith(y)) for y in sorted({x["first"][:4] for x in ipos})},
}
json.dump(out, open("reports-out/us-ipo.json", "w"), ensure_ascii=False, indent=2)
print(json.dumps(status))
