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
# 2026-11-18：ウィブルSDKは独自のハンドラでエラー時にリクエスト全体（アクセストークン・口座ID）をログに出していた。
# 公開リポジトリのActionsログは誰でも読めるので、ログ出力そのものを全部止める（自分の結果は print で出す）
logging.disable(logging.CRITICAL)
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
from zoneinfo import ZoneInfo
_ny = datetime.now(timezone.utc).astimezone(ZoneInfo("America/New_York"))
NY_HM = _ny.strftime("%H:%M")
if mode != "dry" and not ("09:30" <= NY_HM < "16:00"):  # 取引時間外は注文しない（設定の変更で動いた時など）
    pub["notes"].append(f"米国の取引時間外（ニューヨーク {NY_HM}）なので何もしません"); finish("market-closed"); sys.exit(0)

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

    def base(symbol, side, qty, limit=None):
        o = {"combo_type": "NORMAL", "client_order_id": uuid.uuid4().hex, "symbol": symbol, "instrument_type": "EQUITY", "market": "US",
             "order_type": "MARKET", "quantity": qty, "support_trading_session": "CORE", "side": side, "time_in_force": "DAY",
             "entrust_type": "QTY", "account_tax_type": "SPECIFIC"}
        if limit:
            o["order_type"] = "LIMIT"; o["limit_price"] = f"{limit:.2f}"
        return o

    from webull.data.data_client import DataClient
    md = DataClient(api).market_data
    def price(symbol):
        # 今の値段：Nasdaq Basic（API用・無料）のスナップショットの最新値。
        # 取れない時だけ、1株の買い注文の見積もり（preview）を使う（見積もりは約3%上乗せされていて高めに出る。2026-11-17 確認）
        try:
            r = md.get_snapshot(symbol, "US_STOCK")
            if r.status_code == 200:
                j = r.json()
                rows = j if isinstance(j, list) else (j.get("result") or j.get("data") or [j])
                v = num((rows[0] or {}).get("close")) if rows else None
                if v and v > 0: return v
        except Exception:
            pass
        r = trade.order_v3.preview_order(aid, [base(symbol, "BUY", "1")])
        return num(r.json().get("estimated_cost")) if r.status_code == 200 else None

    def place(symbol, side, qty, why, limit=None, force_send=False):
        o = base(symbol, side, qty, limit)
        rec = {"t": symbol, "side": side, "why": why, "qtyDigits": len(qty.split(".")[1]) if "." in qty else 0}
        if mode != "live" and not (mode == "test" and symbol == "SPY") and not force_send:
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

    def pos_qty(symbol):
        r = trade.account_v2.get_account_position(aid)
        if r.status_code != 200: return None
        j = r.json()
        items = j if isinstance(j, list) else (j.get("holdings") or j.get("positions") or j.get("items") or j.get("data") or [])
        if items and isinstance(items[0], dict):
            pub["positionKeys"] = sorted(items[0].keys())[:40]  # 項目名だけ（値は出さない）
        for it in items:
            sym = it.get("symbol") or (it.get("instrument") or {}).get("symbol") or (it.get("ticker") or {}).get("symbol")
            if str(sym).upper() != symbol: continue
            for k in ("available_quantity", "available_qty", "sellable_quantity", "quantity", "qty", "position", "holding_quantity"):
                v = num(it.get(k))
                if v is not None:
                    pub.setdefault("positionQtyKey", k); st.setdefault("_cost", {})[symbol] = num(it.get("cost_price")); return v
        return 0.0

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
    def get_cash():
        bal = trade.account_v2.get_account_balance(aid)
        if bal.status_code != 200: return None
        bj = bal.json() or {}
        st["balanceKeys"] = sorted(list(bj.keys()))[:40]  # 中身ではなく項目名だけ（形の確認用）
        for c in bj.get("account_currency_assets") or bj.get("currency_assets") or []:
            if str(c.get("currency")) == "USD":
                return num(c.get("cash_balance") or c.get("buying_power") or c.get("available_cash") or c.get("settled_cash"))
        return None
    cash_usd = get_cash()
    # 空いているお金はSPYに置く（2026-11-17 オーナーOK。検証の1位の形）。このシステムが買ったSPYの数量・元値は状態にだけ持つ
    IDLE_SPY = bool(CFG.get("idleSpy")) and mode == "live"
    spy_px = price("SPY") if (st.get("spyQty") or IDLE_SPY) else None
    if mode == "live" and spy_px:
        # 状態ファイルが古い・失われた時に備え、SPYの数量は口座の保有で確かめる（このシステムの上限内の分だけ自分のものとみなす）
        acct = pos_qty("SPY")
        if acct is not None:
            mine = min(acct, MAX_USD * 1.1 / spy_px)
            if abs(mine - st.get("spyQty", 0.0)) > 1e-4:
                cp = (st.get("_cost") or {}).get("SPY")
                st["spyCost"] = mine * cp if cp else (st.get("spyCost", 0.0) if st.get("spyQty") else mine * spy_px)
                st["spyQty"] = mine
    spy_q = st.get("spyQty", 0.0)
    spy_val = spy_q * (spy_px or 0)
    pub["usdCashFound"] = bool(cash_usd and cash_usd > 0)  # 金額は出さず、ドルの残高が読めたかだけ
    pub["usdCashEnough"] = bool(cash_usd and cash_usd >= MAX_USD * 0.9)
    used = sum(p["qty"] * (p.get("entryPx") or 0) for p in st["positions"])
    budget_left = max(0.0, MAX_USD - used - st.get("spyCost", 0.0))
    equity = pv + spy_val + budget_left  # このシステムが預かっている分（上限内）だけで測る
    if st.get("maxUsdSeen") != MAX_USD:  # 上限を変えた時は、損益の基準も新しい上限で測り直す（200→180の変更で-10%と出ていた）
        st["maxUsdSeen"] = MAX_USD; st["startEquity"] = MAX_USD; st["lastEquity"] = None
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
        sq = p["qty"]
        if mode == "live":  # 売る数量は口座の「売れる数量」を超えないように（2026-11-17 のテストで約定数量より少なかった）
            have = pos_qty(p["t"])
            if have is not None: sq = min(sq, have)
            if not sq or sq <= 0: pub["notes"].append(f"{p['t']}：口座に売れる数量がありません"); continue
        cid = place(p["t"], "SELL", f"{math.floor(sq * 10000) / 10000:.4f}".rstrip("0").rstrip("."), f"{p['hold']}取引日たった")
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
    late = NY_HM >= "10:30"  # 仮想売買は「寄り付きで買う」前提。寄りから大きく離れた時間には買わない（定期実行が遅れた時・設定変更で動いた時）
    for b in paper.get("nextBuys", []):
        if late and mode != "dry": pub["skipped"].append({"t": b["t"], "why": "寄り付きから時間がたっている（NY 10:30以降）"}); continue
        if stop_buys: pub["skipped"].append({"t": b["t"], "why": "1日の損失上限"}); continue
        if len(st["positions"]) >= MAX_POS: pub["skipped"].append({"t": b["t"], "why": "10銘柄まで"}); continue
        if n_orders >= MAX_ORDERS: pub["skipped"].append({"t": b["t"], "why": "1日の注文数の上限"}); continue
        if any(p["t"] == b["t"] for p in st["positions"]): continue
        used = sum(p["qty"] * (p.get("entryPx") or 0) for p in st["positions"])
        want = min(PER_POS, MAX_USD - used)
        if mode == "live" and st.get("spyQty", 0) > 0 and (cash_usd or 0) < want and n_orders < MAX_ORDERS - 1:
            # 現金が足りなければ、置いておいたSPYを必要な分だけ売る
            spx = price("SPY")
            have = pos_qty("SPY")
            sq = min(st["spyQty"], have if have is not None else st["spyQty"], (want - (cash_usd or 0)) / (spx or 1e9) * 1.02)
            sq = math.floor(sq * 10000) / 10000
            if sq > 0:
                cid = place("SPY", "SELL", f"{sq:.4f}".rstrip("0").rstrip("."), f"{b['t']} を買うお金をSPYから出す")
                n_orders += 1
                q, fpx, s = filled(cid)
                if q:
                    st["spyCost"] = st.get("spyCost", 0.0) * (1 - q / st["spyQty"]); st["spyQty"] = max(0.0, st["spyQty"] - q)
                    time.sleep(3); cash_usd = get_cash()
                else:
                    pub["notes"].append(f"SPYの売りが約定しませんでした（{s}）")
        avail = cash_usd if (cash_usd is not None and mode != "dry") else PER_POS  # dry は口座の残高に関係なく形だけ確認
        amt = min(want, avail)
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

    # ---------- オーナーの指示による1回だけの特別注文（自動売買のルールとは別枠） ----------
    # live/config.json の "special"：{"id","t","usd","offerPrice","limitMult","buyDate","sell":"nextOpen"}
    # 買い：buyDate の取引時間中、値段（見積もり）が 公開価格×limitMult 以下なら指値で買う。上回れば買わずに次の回を待つ。15:30（NY）を過ぎたら見送り
    # 売り：買った次の取引日の最初の実行（寄り付き後）で成行で売る。test / live のどちらでも本物の注文を出す（dry は見積もりだけ）
    sp = CFG.get("special") or {}
    sps = st.setdefault("special", {})
    if sp.get("id") and mode != "dry":
        rec = sps.setdefault(sp["id"], {"state": "waiting"})
        pub["special"] = {"t": sp["t"], "state": rec["state"]}
        if rec["state"] == "waiting":
            if today > sp["buyDate"]:
                rec["state"] = "skipped"; pub["notes"].append(f"{sp['t']}：買う日を過ぎたので見送りました")
            elif today == sp["buyDate"]:
                op = num(sp.get("offerPrice"))
                if not op:
                    pub["notes"].append(f"{sp['t']}：公開価格がまだ設定されていないので買いません")
                else:
                    lim = round(op * float(sp.get("limitMult", 1.3)), 2)
                    px = None
                    try: px = price(sp["t"])
                    except Exception: px = None
                    if not px:
                        pub["notes"].append(f"{sp['t']}：まだ取引が始まっていない（値段を確認できない）。次の回にもう一度確認します")
                        if NY_HM >= "15:30": rec["state"] = "skipped"; pub["notes"].append(f"{sp['t']}：取引時間の終わりまでに買えなかったので見送りました")
                    elif px > lim:
                        pub["notes"].append(f"{sp['t']}：値段が上限（公開価格の{sp.get('limitMult', 1.3)}倍）を超えているので買いません")
                        if NY_HM >= "15:30": rec["state"] = "skipped"; pub["notes"].append(f"{sp['t']}：最後まで上限を超えていたので見送りました")
                    else:
                        usd = min(float(sp["usd"]), cash_usd if cash_usd is not None else float(sp["usd"]))
                        qty = math.floor(usd / lim * 10000) / 10000  # 上限の値段で買えても予算に収まる数量
                        qs = f"{qty:.4f}".rstrip("0").rstrip(".")
                        pv_ok = False
                        try: pv_ok = trade.order_v3.preview_order(aid, [base(sp["t"], "BUY", qs, lim)]).status_code == 200
                        except Exception: pv_ok = False
                        if not pv_ok and math.floor(qty) >= 1:  # 端株の指値が通らなければ、1株単位で指値
                            qs = str(math.floor(qty)); pub["notes"].append(f"{sp['t']}：端株の指値が通らないので1株単位で注文します")
                        elif not pv_ok:
                            qs = None; pub["notes"].append(f"{sp['t']}：指値の注文の形が通りませんでした（見積もりで拒否）。次の回にもう一度試します")
                        if qs:
                            cid = place(sp["t"], "BUY", qs, "オーナーの指示（1回だけ）", limit=lim, force_send=True)
                            n_orders += 1
                            q, fpx, s = filled(cid, 120)
                            pub["notes"].append(f"{sp['t']} の買い：{s}")
                            if q:
                                rec.update({"state": "held", "qty": q, "entryPx": fpx or px, "entryDate": today})
                            elif s in ("CANCELLED", "FAILED", "REJECTED"):
                                pub["notes"].append(f"{sp['t']}：注文が通りませんでした。次の回にもう一度試します")
                            else:
                                rec.update({"state": "ordered", "cid": cid, "entryDate": today})
        elif rec["state"] == "ordered":  # 指値が出たまま。約定したか確認
            q, fpx, s = filled(rec["cid"], 30)
            if q: rec.update({"state": "held", "qty": q, "entryPx": fpx})
            elif today > rec["entryDate"] or s in ("CANCELLED", "FAILED", "REJECTED"): rec["state"] = "skipped"; pub["notes"].append(f"{sp['t']}：指値が約定しないまま終わりました（{s}）")
            pub["notes"].append(f"{sp['t']} の指値：{s}")
        elif rec["state"] == "held" and today > rec["entryDate"] and sp.get("sell") == "nextOpen":
            cid = place(sp["t"], "SELL", f"{rec['qty']:.4f}".rstrip("0").rstrip("."), "翌日の寄りで売る（オーナーの指示）", force_send=True)
            n_orders += 1
            q, fpx, s = filled(cid, 120)
            pub["notes"].append(f"{sp['t']} の売り：{s}")
            if q:
                ret = round(((fpx or price(sp["t"]) or rec["entryPx"]) / rec["entryPx"] - 1) * 100, 1) if rec.get("entryPx") else None
                rec.update({"state": "sold", "exitDate": today, "retPct": ret})
                st["closed"].append({"t": sp["t"], "name": "特別注文（オーナーの指示）", "entryDate": rec["entryDate"], "exitDate": today, "retPct": ret})
        if rec.get("entryPx") and rec["state"] == "held":
            try:
                cp = price(sp["t"]); rec["unrealPct"] = round((cp / rec["entryPx"] - 1) * 100, 1) if cp else None
            except Exception: pass
        pub["special"] = {"t": sp["t"], "state": rec["state"], "entryDate": rec.get("entryDate"), "exitDate": rec.get("exitDate"),
                          "retPct": rec.get("retPct"), "unrealPct": rec.get("unrealPct")}

    # ---------- 空いているお金をSPYへ（その日の売買が終わった後） ----------
    if IDLE_SPY and not stop_buys and n_orders < MAX_ORDERS and not any(r.get("state") in ("waiting", "ordered", "held") for r in (st.get("special") or {}).values() if CFG.get("special")):
        cash_usd = get_cash()
        used = sum(p["qty"] * (p.get("entryPx") or 0) for p in st["positions"])
        spx = price("SPY")
        room = MAX_USD - used - st.get("spyQty", 0.0) * (spx or 0)  # 上限の中で、まだSPYに入れていない分
        add = min(room, (cash_usd or 0) - 1)  # 1ドルは残す
        q0 = math.floor(add / spx * 10000) / 10000 if spx and add >= 5 else 0
        if q0 > 0:
            try: pv_ok = trade.order_v3.preview_order(aid, [base("SPY", "BUY", f"{q0:.4f}".rstrip("0").rstrip("."))]).status_code == 200
            except Exception: pv_ok = False
            if not pv_ok: pub["notes"].append("SPYに置く分の買いは、口座の買付余力が足りないので見送りました"); q0 = 0
        if q0 > 0:
            cid = place("SPY", "BUY", f"{q0:.4f}".rstrip("0").rstrip("."), "空いているお金をSPYに置く")
            n_orders += 1
            q, fpx, s = filled(cid)
            if q:
                st["spyQty"] = st.get("spyQty", 0.0) + q; st["spyCost"] = st.get("spyCost", 0.0) + q * (fpx or spx)
            else:
                pub["notes"].append(f"SPYの買いが約定しませんでした（{s}）")
    if st.get("spyQty"):
        spx = price("SPY")
        pub["idleSpy"] = {"inSpyPct": round(st["spyQty"] * (spx or 0) / MAX_USD * 100, 1),
                          "spyUnrealPct": round((st["spyQty"] * spx / st["spyCost"] - 1) * 100, 1) if (spx and st.get("spyCost")) else None}

    # ---------- テスト：SPYを5ドル分買って、すぐ売る（つながるかの確認） ----------
    # 2026-11-17：初回は買いが約定したが、売りで「保有数量を超えている」（417）。約定数量の読み違いか、端株の反映待ち。
    # 売る数量は口座の保有（get_account_position）から読み、テストで買った分（約5ドル）を超えない分だけ売る
    if mode == "test" and not st.get("testDone"):
        spx = price("SPY") or 0
        have = pos_qty("SPY")
        if not st.get("testBought") and have and spx and have * spx <= 6:  # 前回のテストで買って売れ残った分（5ドル程度）だけ
            st["testBought"] = True; st["testQty"] = have
            pub["notes"].append("前回のテストで買ったSPYが残っているので、売りだけ行います")
        if not st.get("testBought"):
            q5 = math.floor(5 / (spx or 1e9) * 10000) / 10000
            if q5 > 0:
                cid = place("SPY", "BUY", f"{q5:.4f}".rstrip("0").rstrip("."), "接続テスト（5ドル）")
                q, fpx, s = filled(cid, 90)
                pub["notes"].append(f"テストの買い：{s}")
                if q:
                    st["testBought"] = True; st["testQty"] = q
                    time.sleep(10)
                    have = pos_qty("SPY")
        if st.get("testBought"):
            sell_q = min(x for x in (have, st.get("testQty")) if x is not None) if have is not None else None
            sell_q = math.floor((sell_q or 0) * 10000) / 10000
            if sell_q > 0:
                cid2 = place("SPY", "SELL", f"{sell_q:.4f}".rstrip("0").rstrip("."), "接続テストの売り")
                q2, _, s2 = filled(cid2, 90)
                pub["notes"].append(f"テストの売り：{s2}")
                if q2: st["testDone"] = True
            else:
                pub["notes"].append("テストの売り：口座の保有数量をまだ読めません（次回もう一度）")
        pub["detailKeys"] = st.get("detailKeys")  # 注文詳細の項目名だけ（値は出さない）

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
