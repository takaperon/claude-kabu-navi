// 「プロの判断」の特徴を計算する（検証 scripts/pro.mjs と仮想売買 scripts/paper.mjs で同じ定義を使う）
// すべてシグナル日 k の終値までに分かる情報。寄り付きの特徴（gap・mgap）は検証側だけで使う
//   q(j)   : その銘柄の j 日目の値段 {o,h,l,c,va}（無ければ null）
//   rawO(j): その銘柄の j 日目の調整前の始値（無ければ NaN）
//   mkt    : { r(j): 市場全体の日次の動き, idx(j): 市場全体の指数, ma(j,n): 指数のn日平均 }
//   ev     : detectEvents のイベント（kind, score, detail, dd, dt）
//   ctx    : { sameKinds: 同じ会社・同じ開示日のイベントの種類（Set）, crowd: 同じ日の同じ種類のイベント数, isTradingDay: dd が取引日か }
export const closeTime = (dd) => (dd >= '2024-11-05' ? '15:30' : '15:00'); // 東証の大引けは 2024-11-05 から 15:30

export function proFeatures(ev, k, q, rawO, mkt, ctx) {
  const c = q(k)?.c;
  const at = (j, f) => { const x = q(j); return x ? x[f] : NaN; };
  let rs = 0, rs2 = 0, rn = 0, rg = 0, rgn = 0, va = 0, van = 0, cs = 0, cn = 0;
  for (let j = k - 19; j <= k; j++) {
    const r = at(j, 'c') / at(j - 1, 'c') - 1;
    if (Number.isFinite(r)) { rs += r; rs2 += r * r; rn++; }
    const g = (at(j, 'h') - at(j, 'l')) / at(j - 1, 'c');
    if (Number.isFinite(g)) { rg += g; rgn++; }
    const v = at(j, 'va'); if (Number.isFinite(v)) { va += v; van++; }
  }
  for (let j = k - 24; j <= k; j++) { const x = at(j, 'c'); if (Number.isFinite(x)) { cs += x; cn++; } }
  const raw = rawO(k);
  const timing = !ctx.isTradingDay ? 'holiday' : (ev.dt && ev.dt.slice(0, 5) < closeTime(ev.dd) ? 'intraday' : 'afterClose');
  return {
    size: Math.min(ev.score, 3),
    withOther: ev.kind === 'div_up' ? (ctx.sameKinds.has('earn_up') ? 1 : 0) : (ctx.sameKinds.has('div_up') ? 1 : 0),
    withDown: ctx.sameKinds.has('earn_down') ? 1 : 0,
    nextYear: ev.detail?.nextYear ? 1 : 0,
    yield: ev.kind === 'div_up' && ev.detail?.now > 0 && raw > 0 ? Math.min(ev.detail.now / raw, 0.15) : NaN,
    timing,
    react0: c / at(k - 1, 'c') - 1,
    run5: c / at(k - 5, 'c') - 1,
    run20: c / at(k - 20, 'c') - 1,
    ma25: cn === 25 ? c / (cs / 25) - 1 : NaN,
    vol20: rn > 5 ? Math.sqrt(Math.max(0, rs2 / rn - (rs / rn) ** 2)) : NaN,
    atr: rgn > 5 ? rg / rgn : NaN,
    liq: van === 20 ? Math.log10(va / 20) : NaN,
    crowd: Math.log2(ctx.crowd || 1),
    mkt1: mkt.r(k),
    mkt5: mkt.idx(k) / mkt.idx(k - 5) - 1,
    mktTrend: mkt.idx(k) / mkt.ma(k, 25) - 1,
  };
}

// 検証が前半だけで選んだ「効く特徴」（rules）で点数をつける
//   rules = { chosen: [{ key, side: 'is1'|'high'|'low', cut }], useIntra: bool }
export function proScore(f, rules) {
  if (!rules) return 0;
  let s = 0;
  for (const c of rules.chosen ?? []) {
    const v = f[c.key];
    if (c.side === 'is1') { if (v === 1) s++; }
    else if (Number.isFinite(v) && (c.side === 'high' ? v >= c.cut : v <= c.cut)) s++;
  }
  if (rules.useIntra && f.timing === 'intraday') s++;
  return s;
}
