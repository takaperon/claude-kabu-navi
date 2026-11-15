# 本番の自動売買（米国株・少額）。2026-11-15〜、オーナーの指示で3万円から。
# 仮想売買（scripts/us/paper.mjs）と同じ信号で、ウィブル証券に本物の注文を出す。
#
# 安全装置（どれか1つでも当てはまれば新しく買わない）
#   1) live/config.json の enabled が true でないと何もしない（iPhoneのブラウザで false にすれば即停止）
#   2) mode が "dry" のあいだは注文を出さず、出す予定の注文を記録するだけ
#   3) 使うお金の上限 maxUsd（初期200ドル≒3万円）。1銘柄はその10%まで、同時に最大10銘柄
#   4) 1日の損失上限：前回より dailyLossStopPct% 以上減っていたら、その日は新規の買いをしない（売りはする）
#   5) エラーが maxErrors 回続いたら halted（停止）にして、以後は何もしない。解除は config の resetHalt を true に
#   6) 1回の実行で出す注文は最大10件（申請時の申告「1日10注文未満」に合わせる）
#
# 公開リポジトリなので、口座番号・残高・数量・金額はログにも公開ファイルにも出さない。銘柄名・損益率・件数だけ。
import json, logging, math, os, sys, time, uuid
from datetime import datetime, timezone, timedelta

logging.basicConfig(level=logging.WARNING)
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CFG = json.load(open(os.path.join(ROOT, "live", "config.json")))
STATE_F = os.environ.get("LIVE_STATE", ".livestate/state.json")
PAPER_F = os.environ.get("US_PAPER", "us-paper.json")
MODE_OVERRIDE = os.environ.get("LIVE_MODE", "").strip()  # 手動実行の時だけ（dry / test）
os.makedirs("reports-out", exist_ok=True)
os.makedirs(os.path.dirname(STATE_F), exist_ok=True)

ET = timezone(timedelta(hours=-5))  # 判定用のおおまかな米東部時間（夏時間のずれは下の取引時間チェックで吸収）
today = datetime.now(timezone.utc).astimezone(ET).date().isoformat()
# NYSE休場日（2026〜2027）
HOLIDAYS = {"2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24"}

pub = {"runAt": datetime.now(timezone.utc).isoformat(), "date": today, "mode": None, "enabled": bool(CFG.get("enabled")), "status": "start",
       "orders": [], "skipped": [], "holdings": [], "closed": [], "notes": []}

def save_pub():
    with open("reports-out/live.json", "w") as f:
        json.dump(pub, f, ensure_ascii=False, indent=2)
    print(json.dumps({k: pub[k] for k in ("date", "mode", "status", "notes")}, ensure_ascii=False))

st = json.load(open(STATE_F)) if os.path.exists(STATE_F) else {"positions": [], "closed": [], "errors": 0, "halted": False, "lastEquity": None, "startEquity": None, "lastRunDate": None, "testDone": False}

def save_state():
    json.dump(st, open(STATE_F, "w"))

def finish(status):
    pub["status"] = status
    pub["halted"] = st.get("halted", False)
    pub["holdings"] = [{"t": p["t"], "name": p.get("name"), "entryDate": p["entryDate"], "daysHeld": p["held"], "daysLeft": max(0, p["hold"] - p["held"]),
                        "unrealPct": p.get("unrealPct")} for p in st["positions"]]
    pub["closed"] = st["closed"][-30:][::-1]
    if st.get("startEquity") and st.get("lastEquity"):
        pub["returnPct"] = round((st["lastEquity"] / st["startEquity"] - 1) * 100, 1)
    save_state(); save_pub()

mode = MODE_OVERRIDE or CFG.get("mode", "dry")
pub["mode"] = mode
if CFG.get("resetHalt"):
    st["halted"] = False; st["errors"] = 0
if not CFG.get("enabled"):
    finish("disabled"); sys.exit(0)
if st.get("halted"):
    pub["notes"].append("エラーが続いたため停止中（config の resetHalt で解除）"); finish("halted"); sys.exit(0)
if mode != "dry" and (today in HOLIDAYS or datetime.now(timezone.utc).astimezone(ET).weekday() >= 5):  # dry は注文を出さないので休日も確認に使える
    finish("market-closed"); sys.exit(0)

MAX_USD = float(CFG.get("maxUsd", 200))
PER_POS = MAX_USD * 0.10
MAX_POS = 10
MAX_ORDERS = 10
LOSS_STOP = float(CFG.get("dailyLossStopPct", 5)) / 100
MAX_ERR = int(CFG.get("maxErrors", 3))

def num(x):
    try: return float(x)
    except Exception: return None

try:
    from webull.core.client import ApiClient
    from webull.trade.trade_client import TradeClient
    api = ApiClient(os.environ["WEBULL_APP_KEY"], os.environ["WEBULL_APP_SECRET"], "jp")
    api.set_token_dir(os.environ.get("WEBULL_OPENAPI_TOKEN_DIR", ".wbtoken"))
    trade = TradeClient(api)
    accts = trade.account_v2.get_account_list().json() or []
    if not accts: raise RuntimeError("no account")
    aid = accts[0]["account_id"]

    def base(symbol, side, qty):
        return {"combo_type": "NORMAL", "client_order_id": uuid.uuid4().hex, "symbol": symbol, "instrument_type": "EQUITY", "market": "US",
                "order_type": "MARKET", "quantity": qty, "support_trading_session": "CORE", "side": side, "time_in_force": "DAY",
                "entrust_type": "QTY", "account_tax_type": "SPECIFIC"}

    def price(symbol):
        # 株価データは購読が必要なので、1株の買い注文の「見積もり（preview）」から今の値段を知る（注文は出ない）
        r = trade.order_v3.preview_order(aid, [base(symbol, "BUY", "1")])
        return num(r.json().get("estimated_cost")) if r.status_code == 200 else None

    def place(symbol, side, qty, why):
        o = base(symbol, side, qty)
        rec = {"t": symbol, "side": side, "why": why, "qtyDigits": len(qty.split(".")[1]) if "." in qty else 0}
        if mode != "live" and not (mode == "test" and symbol == "SPY"):
            rec["sent"] = False
            try:  # 出さない注文も、見積もり（preview）で形が正しいかだけ確かめる
                r = trade.order_v3.preview_order(aid, [o]); rec["previewOk"] = r.status_code == 200
            except Exception as e:
                rec["previewOk"] = False; rec["previewErr"] = str(e)[:100]
            pub["orders"].append(rec); return o["client_order_id"]
        r = trade.order_v3.place_order(aid, [o])
        rec["sent"] = True; rec["ok"] = r.status_code == 200
        pub["orders"].append(rec)
        if r.status_code != 200: raise RuntimeError(f"order failed {r.status_code}")
        return o["client_order_id"]

    def filled(cid, wait=60):
        # 約定するまで最大 wait 秒待つ。約定した数量と平均値段（状態ファイルにだけ保存）
        t0 = time.time()
        while time.time() - t0 < wait:
            r = trade.order_v3.get_order_detail(aid, cid)
            if r.status_code == 200:
                j = r.json() or {}
                items = j.get("orders") or j.get("items") or [j]
                o = items[0] if items else {}
                status = str(o.get("status") or o.get("order_status") or "")
                q = num(o.get("filled_quantity") or o.get("filled_qty"))
                p = num(o.get("filled_price") or o.get("avg_filled_price") or o.get("average_price"))
                if status.upper() in ("FILLED", "PARTIAL_FILLED") and q:
                    return q, p, status
                if status.upper() in ("CANCELLED", "FAILED", "REJECTED"):
                    return 0, None, status
                st.setdefault("detailKeys", sorted(list(o.keys()))[:40])
            time.sleep(5)
        return None, None, "timeout"

    # ---------- 新しい取引日：保有日数を1つ進める ----------
    new_day = st.get("lastRunDate") != today
    if new_day:
        for p in st["positions"]: p["held"] += 1

    # ---------- 時価と1日の損失チェック ----------
    pv = 0.0
    for p in st["positions"]:
        px = price(p["t"])
        if px:
            p["unrealPct"] = round((px / p["entryPx"] - 1) * 100, 1) if p.get("entryPx") else None
            pv += px * p["qty"]
    bal = trade.account_v2.get_account_balance(aid)
    cash_usd = None
    if bal.status_code == 200:
        bj = bal.json() or {}
        st["balanceKeys"] = sorted(list(bj.keys()))[:40]  # 中身ではなく項目名だけ（形の確認用）
        for c in bj.get("account_currency_assets") or bj.get("currency_assets") or []:
            if str(c.get("currency")) == "USD":
                cash_usd = num(c.get("cash_balance") or c.get("buying_power") or c.get("available_cash") or c.get("settled_cash"))
    used = sum(p["qty"] * (p.get("entryPx") or 0) for p in st["positions"])
    budget_left = max(0.0, MAX_USD - used)
    equity = pv + budget_left  # このシステムが預かっている分（上限内）だけで測る
    if new_day:
        if st.get("startEquity") is None: st["startEquity"] = MAX_USD
        stop_buys = st.get("lastEquity") and equity < st["lastEquity"] * (1 - LOSS_STOP)
        st["lastEquity"] = equity
    else:
        stop_buys = False
    if stop_buys: pub["notes"].append(f"前回より{int(LOSS_STOP*100)}%以上減ったので、今日は新しく買いません")

    n_orders = 0
    # ---------- 売り：保有日数に達したもの ----------
    for p in list(st["positions"]):
        if p["held"] < p["hold"] or n_orders >= MAX_ORDERS: continue
        cid = place(p["t"], "SELL", f"{p['qty']:.4f}".rstrip("0").rstrip("."), f"{p['hold']}取引日たった")
        n_orders += 1
        if mode == "live":
            q, px, s = filled(cid)
            if not q: pub["notes"].append(f"{p['t']} の売りが約定しませんでした（{s}）。次回もう一度売ります"); continue
        else:
            px = price(p["t"])
        ret = round(((px or p["entryPx"]) / p["entryPx"] - 1) * 100, 1) if p.get("entryPx") else None
        st["closed"].append({"t": p["t"], "name": p.get("name"), "entryDate": p["entryDate"], "exitDate": today, "retPct": ret})
        st["positions"].remove(p)

    # ---------- 買い：仮想売買の「今夜買う」銘柄 ----------
    paper = json.load(open(PAPER_F)) if os.path.exists(PAPER_F) else {}
    hold = int((paper.get("settings") or {}).get("hold") or 20)
    for b in paper.get("nextBuys", []):
        if stop_buys: pub["skipped"].append({"t": b["t"], "why": "1日の損失上限"}); continue
        if len(st["positions"]) >= MAX_POS: pub["skipped"].append({"t": b["t"], "why": "10銘柄まで"}); continue
        if n_orders >= MAX_ORDERS: pub["skipped"].append({"t": b["t"], "why": "1日の注文数の上限"}); continue
        if any(p["t"] == b["t"] for p in st["positions"]): continue
        used = sum(p["qty"] * (p.get("entryPx") or 0) for p in st["positions"])
        avail = cash_usd if (cash_usd is not None and mode != "dry") else PER_POS  # dry は口座の残高に関係なく形だけ確認
        amt = min(PER_POS, MAX_USD - used, avail)
        if amt < 2: pub["skipped"].append({"t": b["t"], "why": "使えるお金が足りない"}); continue
        px = price(b["t"])
        if not px: pub["skipped"].append({"t": b["t"], "why": "値段を確認できない"}); continue
        qty = math.floor(amt / px * 10000) / 10000
        if qty <= 0: continue
        cid = place(b["t"], "BUY", f"{qty:.4f}".rstrip("0").rstrip("."), b.get("reason", ""))
        n_orders += 1
        if mode == "live":
            q, fpx, s = filled(cid)
            if not q: pub["notes"].append(f"{b['t']} の買いが約定しませんでした（{s}）"); continue
            qty, px = q, fpx or px
        st["positions"].append({"t": b["t"], "name": b.get("name"), "qty": qty, "entryPx": px, "entryDate": today, "held": 0, "hold": hold, "dry": mode != "live"})
        if cash_usd is not None: cash_usd -= qty * px

    # ---------- テスト：SPYを5ドル分買って、すぐ売る（つながるかの確認） ----------
    if mode == "test" and not st.get("testDone"):
        q5 = math.floor(5 / (price("SPY") or 1e9) * 10000) / 10000
        if q5 > 0:
            cid = place("SPY", "BUY", f"{q5:.4f}".rstrip("0").rstrip("."), "接続テスト（5ドル）")
            q, fpx, s = filled(cid, 90)
            pub["notes"].append(f"テストの買い：{s}")
            if q:
                cid2 = place("SPY", "SELL", f"{q:.4f}".rstrip("0").rstrip("."), "接続テストの売り")
                q2, _, s2 = filled(cid2, 90)
                pub["notes"].append(f"テストの売り：{s2}")
                st["testDone"] = bool(q2)

    if mode != "live":  # dry / test のあいだは、出したことにした保有は状態に残さない（本番開始時にまっさらにする）
        st["positions"] = [p for p in st["positions"] if not p.get("dry")]
        if mode == "dry": st["closed"] = [c for c in st["closed"] if False]
    st["lastRunDate"] = today
    st["errors"] = 0
    finish("ok")
except Exception as e:
    st["errors"] = st.get("errors", 0) + 1
    if st["errors"] >= MAX_ERR:
        st["halted"] = True
        pub["notes"].append(f"エラーが{MAX_ERR}回続いたので停止しました")
    msg = str(e)[:160]
    for secret in (os.environ.get("WEBULL_APP_KEY"), os.environ.get("WEBULL_APP_SECRET"), globals().get("aid")):
        if secret: msg = msg.replace(str(secret), "***")
    import re
    msg = re.sub(r"\b\d{6,}\b", "***", msg)  # 口座番号らしき長い数字は伏せる
    pub["error"] = type(e).__name__ + ": " + msg
    finish("error")
    sys.exit(0)
