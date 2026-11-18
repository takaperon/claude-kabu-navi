# 米国株：買ったあとの場中（5分足）で売り方を比べる（2026-11-18〜、オーナーの指示「途中で売り抜けないのが嫌。別枠で検証」）
# 対象：決算の翌日に+5%以上（+10%以上を今のルールとして別に集計）。買う日の最初の5分足の始値で買う（滑り0.1%）
# 売り方：20取引日目の引け（今）／利益確定の指値（+X%）／損切り（-Y%。逆指値が無いので届いた足の始値か損切り値の低い方、さらに0.2%不利）／
#        高値から Z% 下がったら売る（同じ）。同じ5分足の中で両方に届いたら損切りが先（悪い方に倒す）
# 注意：Tiingo の IEX 取引所の約定だけで作った足（全体の数%）なので、実際の値段と少しずれる。公開は集計値だけ
import json, os, statistics
DIR = "data-us-intraday"
SLIP = 0.001
ev = {f"{e['t']}_{e['entry']}": e for e in json.load(open("us-events.json"))["events"]}
def summ(a):
    if not a: return {"n": 0}
    s = sorted(a)
    return {"n": len(a), "avg": round(sum(a) / len(a), 4), "med": round(statistics.median(a), 4), "win": round(sum(1 for x in a if x > 0) / len(a), 3), "p10": round(s[len(s) // 10], 4)}
RULES = [("base", {})] + [(f"tp{x}", {"tp": x / 100}) for x in (5, 10, 15, 20, 30)] + [(f"sl{y}", {"sl": y / 100}) for y in (5, 8, 10, 15)] + \
        [(f"trail{z}", {"trail": z / 100}) for z in (5, 8, 10, 15)] + [(f"tp{x}_sl{y}", {"tp": x / 100, "sl": y / 100}) for x in (10, 20) for y in (8, 10)] + \
        [(f"tp20_trail{z}", {"tp": 0.2, "trail": z / 100}) for z in (8, 10)]
res = {name: {"all5": {"train": [], "test": []}, "re10": {"train": [], "test": []}, "days": {"train": [], "test": []}} for name, _ in RULES}
used = 0
for f in os.listdir(DIR):
    if not f.endswith(".json"): continue
    k = f[:-5]; e = ev.get(k)
    if not e: continue
    bars = json.load(open(f"{DIR}/{f}"))
    if not bars: continue
    bars.sort()
    days = sorted({b[0][:10] for b in bars})
    if not days or days[0] != e["entry"] or len(days) < 20: continue  # 買う日の足が無い・20日分ない
    days = days[:20]
    bars = [b for b in bars if b[0][:10] in set(days)]
    entry = bars[0][1] * (1 + SLIP)
    if not entry > 0: continue
    used += 1
    last_close = [b for b in bars if b[0][:10] == days[-1]][-1][4]
    for name, r in RULES:
        px, held = last_close * (1 - SLIP), 20
        peak = bars[0][1]
        for b in bars:
            t, o, h, l, c = b
            stop = None
            if "sl" in r: stop = entry / (1 + SLIP) * (1 - r["sl"])
            if "trail" in r:
                ts = peak * (1 - r["trail"]); stop = max(stop or 0, ts)
            if stop and l <= stop:
                px = min(o, stop) * (1 - SLIP - 0.002); held = days.index(t[:10]) + 1; break
            if "tp" in r and h >= entry / (1 + SLIP) * (1 + r["tp"]):
                px = max(o, entry / (1 + SLIP) * (1 + r["tp"])) * (1 - SLIP); held = days.index(t[:10]) + 1; break
            peak = max(peak, h)
        ret = px / entry - 1
        res[name]["all5"][e["half"]].append(ret)
        if e["re"] >= 10: res[name]["re10"][e["half"]].append(ret)
        res[name]["days"][e["half"]].append(held)
out = {"note": "決算の翌日に+5%以上の銘柄を次の日の最初の5分足で買う。20取引日まで。Tiingo IEX の5分足（実際の値段と少しずれる）。同じ足で両方届いたら損切りが先", "events": used,
       "rules": {name: {"all5": {h: summ(v["all5"][h]) for h in ("train", "test")}, "re10": {h: summ(v["re10"][h]) for h in ("train", "test")},
                        "avgDays": {h: round(sum(v["days"][h]) / len(v["days"][h]), 1) if v["days"][h] else None for h in ("train", "test")}} for name, v in res.items()}}
os.makedirs("reports-out", exist_ok=True)
json.dump(out, open("reports-out/us-intraday.json", "w"), ensure_ascii=False, indent=1)
print(json.dumps({"eval": used}))
