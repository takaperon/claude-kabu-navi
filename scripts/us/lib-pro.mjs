// 米国株「プロの判断」の特徴（検証 scripts/us/pro.mjs と仮想売買 scripts/us/paper.mjs で同じ定義を使う）
// s = { O,H,L,C,V,RC: 共通の日付に並べた配列, sec: {eps,rev}, av: [...] }、r = 反応日のインデックス、SPC = SPYの終値の配列、day = 発表日
// すべて反応日 r の終値までに分かる情報
export const sma = (A, k, n) => { if (k < n - 1) return NaN; let s = 0; for (let j = k - n + 1; j <= k; j++) s += A[j]; return s / n; };
export function yoy(series, end) {
  const cur = (series ?? []).find((x) => x.end === end); if (!cur) return null;
  const t = Date.parse(end);
  const prev = series.find((x) => { const g = (t - Date.parse(x.end)) / 864e5; return g >= 330 && g <= 400; });
  return prev && prev.val > 0 ? cur.val / prev.val - 1 : null;
}
export function usFeatures(s, r, SPC, day) {
  let rs = 0, rs2 = 0, rn = 0, rg = 0, rgn = 0;
  for (let k = r - 20; k <= r - 1; k++) { const x = s.C[k] / s.C[k - 1] - 1; if (Number.isFinite(x)) { rs += x; rs2 += x * x; rn++; } const g = (s.H[k] - s.L[k]) / s.C[k - 1]; if (Number.isFinite(g)) { rg += g; rgn++; } }
  let hi252 = -Infinity; for (let k = Math.max(0, r - 252); k < r; k++) if (s.H[k] > hi252) hi252 = s.H[k];
  const t = Date.parse(day);
  const q = (s.sec?.eps ?? []).filter((x) => { const g = (t - Date.parse(x.end)) / 864e5; return g >= 0 && g <= 120; }).at(-1);
  const av = (s.av ?? []).find((x) => x.rd && Math.abs(Date.parse(x.rd) - t) / 864e5 <= 3);
  const re = s.C[r] / s.C[r - 1] - 1;
  return {
    re: Math.min(re, 0.6),
    gapPart: s.O[r] / s.C[r - 1] - 1,
    intraday: s.C[r] / s.O[r] - 1,
    closePos: s.H[r] > s.L[r] ? (s.C[r] - s.L[r]) / (s.H[r] - s.L[r]) : NaN,
    volSurge: Math.log2(s.V[r] / sma(s.V, r - 1, 20)),
    epsG: q ? (yoy(s.sec.eps, q.end) ?? NaN) : NaN,
    revG: q ? (yoy(s.sec.rev ?? [], q.end) ?? NaN) : NaN,
    surprise: av && Number.isFinite(av.spp) ? Math.max(-100, Math.min(100, av.spp)) / 100 : NaN,
    run20: s.C[r - 1] / s.C[r - 21] - 1,
    hi52: s.C[r] / hi252 - 1,
    ma50: s.C[r] / sma(s.C, r, 50) - 1,
    vol20: rn > 5 ? Math.sqrt(Math.max(0, rs2 / rn - (rs / rn) ** 2)) : NaN,
    atr: rgn > 5 ? rg / rgn : NaN,
    liq: Math.log10(sma(s.C, r, 20) * sma(s.V, r, 20)),
    spyTrend: SPC[r] / sma(SPC, r, 200) - 1, spy1: SPC[r] / SPC[r - 1] - 1, spy5: SPC[r] / SPC[r - 5] - 1,
  };
}
// 前半だけで選んだ「効く特徴」の点数。rules.chosen = [{ key, side: 'high'|'low', cut }]
export function usScore(f, rules) {
  let n = 0;
  for (const c of rules?.chosen ?? []) { const v = f[c.key]; if (Number.isFinite(v) && (c.side === 'high' ? v >= c.cut : v <= c.cut)) n++; }
  return n;
}
export const US_LABEL = {
  re: ['反応日の上げが大きい', '反応日の上げが小さい'], gapPart: ['寄り付きで大きく跳ねた', '寄り付きの跳ねが小さい'], intraday: ['場中も買われた', '寄りから引けは伸びなかった'],
  closePos: ['高値引け', '高値から押して引けた'], volSurge: ['出来高が急増', '出来高が少なめ'], epsG: ['EPSが大きく伸びた', 'EPSの伸びが小さい'], revG: ['売上が大きく伸びた', '売上の伸びが小さい'],
  surprise: ['予想を大きく上回った', '予想との差が小さい'], run20: ['発表前に上げていた', '発表前に上げていない'], hi52: ['52週高値の近く', '52週高値から遠い'],
  ma50: ['50日線より大きく上', '50日線の近く'], vol20: ['値動きが荒い', '値動きが静か'], atr: ['値幅が大きい', '値幅が小さい'], liq: ['売買代金が大きい', '売買代金が小さい'],
  spyTrend: ['S&P500が上向き', 'S&P500が200日平均の近く'], spy1: ['S&P500も上げた日', 'S&P500が下げた日'], spy5: ['S&P500が5日で上げている', 'S&P500が5日で下げている'],
};
