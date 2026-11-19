# ウィブルAPIの配当・決算カレンダーで「増配の発表」を拾えるかの確認（2026-11-19、オーナー「J-Quantsの代わりになるか確かめよう」）
# 読み取りだけ（注文なし）。J-Quants で見つけた最近の増配（jp-events.json）と、ウィブルの配当カレンダーを突き合わせる。
#  ① 増配の発表日に declare_date の行があるか（一致するか）
#  ② 発表の何日後に出てくるか（その日のうちに拾えるか）
#  ③ 増配が無い銘柄にも同じような行が出るか（見分けられるか）
#  ④ 1回の呼び出しで何銘柄まで聞けるか（全銘柄を毎日調べられるか）
# 公開は日付・件数・配当の増減率だけ（株価・口座の情報は出さない）
import json, logging, os, sys, time, inspect, random
from datetime import datetime, timezone, date, timedelta
logging.disable(logging.CRITICAL)

out = {"checkedAt": datetime.now(timezone.utc).isoformat(), "error": None}
os.makedirs("reports-out", exist_ok=True)
def save():
    json.dump(out, open("reports-out/jp-divprobe.json", "w"), ensure_ascii=False, indent=1)
    print(json.dumps({"ok": out.get("error") is None, "summary": out.get("summary")}, ensure_ascii=False))

def dstr(v):
    if v in (None, ""): return None
    if isinstance(v, (int, float)) or (isinstance(v, str) and v.isdigit()):
        v = int(v); v = v / 1000 if v > 1e11 else v
        return datetime.fromtimestamp(v, timezone.utc).date().isoformat()
    return str(v)[:10]

try:
    from webull.core.client import ApiClient
    from webull.trade.trade_client import TradeClient
    from webull.data.data_client import DataClient
    api = ApiClient(os.environ["WEBULL_APP_KEY"], os.environ["WEBULL_APP_SECRET"], "jp")
    api.set_token_dir(os.environ.get("WEBULL_OPENAPI_TOKEN_DIR", ".wbtoken"))
    TradeClient(api)
    data = DataClient(api)
    fu = data.fundamentals
    out["signature"] = {fn: str(inspect.signature(getattr(fu, fn))) for fn in ("get_dividend_calendar", "get_earnings_calendar") if hasattr(fu, fn)}
    out["methods"] = sorted(m for m in dir(fu) if not m.startswith("_"))[:40]

    ev = json.load(open("jp-events.json"))["list"]
    today = date.today()
    recent = [x for x in ev if x["e"] >= (today - timedelta(days=80)).isoformat()]
    random.seed(1)
    pick = sorted(recent, key=lambda x: x["e"], reverse=True)[:40]
    evcodes = {x["c"] for x in ev if x["e"] >= (today - timedelta(days=400)).isoformat()}
    allcodes = sorted({x["c"] for x in ev})
    ctrl = [c for c in allcodes if c not in evcodes]
    random.shuffle(ctrl); ctrl = ctrl[:15]

    pace = {"sleep": 1.0, "retries": 0, "calls": 0, "t0": time.time()}
    def call(fn):
        for k in range(6):
            try:
                pace["calls"] += 1
                r = fn(); time.sleep(pace["sleep"]); return r
            except Exception as e:
                if "TOO_MANY" in (type(e).__name__ + str(getattr(e, "error_code", ""))):
                    pace["retries"] += 1; pace["sleep"] = min(pace["sleep"] * 2, 16); time.sleep(pace["sleep"] * 2); continue
                raise
        raise RuntimeError("rate-limited")
    def cal(code):
        r = call(lambda: fu.get_dividend_calendar(code, "JP_STOCK"))
        if r.status_code != 200: return None, r.status_code
        j = r.json()
        rows = j if isinstance(j, list) else (j.get("data") or j.get("list") or j.get("result") or [])
        return rows, 200

    res, keys_seen, statuses, ctl = [], set(), {}, []
    for x in pick:
        rows, st = cal(x["c"]); statuses[st] = statuses.get(st, 0) + 1
        item = {"c": x["c"], "buyDay": x["e"], "rows": None}
        if rows is not None:
            for r in rows: keys_seen.update(r.keys())
            rs = sorted(({"declare": dstr(r.get("declare_date")), "ex": dstr(r.get("ex_div_date")), "type": r.get("div_type"), "amt": r.get("amount")} for r in rows), key=lambda z: z["declare"] or "")
            item["rows"] = len(rs)
            # 買う日の前の7日以内に発表された行（＝増配の発表と同じ日か）
            near = [z for z in rs if z["declare"] and (date.fromisoformat(x["e"]) - date.fromisoformat(z["declare"])).days in range(0, 8)]
            item["declareNear"] = [z["declare"] for z in near]
            item["lagDays"] = [(date.fromisoformat(z["declare"]) - date.fromisoformat(x["e"])).days for z in rs if z["declare"] and abs((date.fromisoformat(z["declare"]) - date.fromisoformat(x["e"])).days) <= 40]
            item["types"] = sorted({str(z["type"]) for z in rs})
            # 同じ種類の前の行と比べた配当の増減率（配当額そのものは出さない）
            ch = []
            for k, z in enumerate(rs):
                prev = [p for p in rs[:k] if p["type"] == z["type"] and p["amt"]]
                try:
                    if prev and z["amt"]: ch.append({"declare": z["declare"], "chg": round(float(z["amt"]) / float(prev[-1]["amt"]) - 1, 3)})
                except Exception: pass
            item["chg"] = ch[-3:]
            item["declares"] = [z["declare"] for z in rs][-6:]
            item["exDates"] = [z["ex"] for z in rs][-6:]
        res.append(item)
    for c in ctrl:
        rows, st = cal(c)
        if rows is None: ctl.append({"c": c, "status": st}); continue
        ds = sorted(dstr(r.get("declare_date")) or "" for r in rows)
        ctl.append({"c": c, "rows": len(rows), "declares": ds[-4:]})
    out["rowKeys"] = sorted(keys_seen)
    out["statuses"] = statuses
    out["events"] = res
    out["control"] = ctl
    # 何銘柄まで一度に聞けるか（カンマ区切り）
    try:
        r = call(lambda: fu.get_dividend_calendar(",".join(x["c"] for x in pick[:5]), "JP_STOCK"))
        j = r.json() if r.status_code == 200 else None
        rows = j if isinstance(j, list) else ((j or {}).get("data") or [])
        out["multiSymbol"] = {"status": r.status_code, "rows": len(rows) if rows is not None else None, "symbols": sorted({str(z.get("symbol")) for z in rows if isinstance(z, dict)})[:10]}
    except Exception as e:
        out["multiSymbol"] = {"error": type(e).__name__}
    got = [r for r in res if r["rows"] is not None]
    hit = [r for r in got if r["declareNear"]]
    lags = [l for r in got for l in r["lagDays"]]
    out["pace"] = {"finalSleepSec": pace["sleep"], "retries": pace["retries"], "calls": pace["calls"], "sec": round(time.time() - pace["t0"])}
    out["summary"] = {"events": len(res), "answered": len(got), "matchedWithin7days": len(hit),
                      "eventsNewestBuyDay": pick[0]["e"] if pick else None, "controlAnswered": sum(1 for c in ctl if c.get("rows") is not None)}
except Exception as e:
    try: out["events"] = res; out["control"] = ctl if 'ctl' in dir() else None; out["pace"] = pace
    except Exception: pass
    out["error"] = type(e).__name__ + (":" + str(getattr(e, "error_code", "")) if getattr(e, "error_code", None) else "")
save()
