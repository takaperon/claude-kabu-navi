// J-Quants API V2 の最小クライアント（Freeプラン：1分5リクエスト）
const BASE = 'https://api.jquants.com/v2';
const MIN_INTERVAL_MS = 13000; // 1分5回 → 12秒間隔＋余裕
let lastAt = 0;
let requestCount = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function getOnce(path, params) {
  const key = process.env.JQUANTS_API_KEY;
  if (!key) throw new ApiError(0, 'JQUANTS_API_KEY がありません');
  const wait = lastAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastAt = Date.now();
  requestCount++;
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { 'x-api-key': key, 'Accept-Encoding': 'gzip' } });
  if (res.status === 200) return res.json();
  if (res.status === 210) return { data: [] };
  let msg = '';
  try {
    msg = (await res.json()).message ?? '';
  } catch {}
  throw new ApiError(res.status, msg);
}

async function get(path, params) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await getOnce(path, params);
    } catch (e) {
      if (e.status === 429 && attempt < 5) {
        await sleep(130000);
        continue;
      }
      if ((e.status >= 500 || e.status === undefined) && attempt < 3) {
        await sleep(30000);
        continue;
      }
      throw e;
    }
  }
}

// pagination_key がなくなるまで data を連結
export async function getAll(path, params) {
  const out = [];
  let pk;
  do {
    const j = await get(path, { ...params, pagination_key: pk });
    if (Array.isArray(j.data)) out.push(...j.data);
    pk = j.pagination_key;
  } while (pk);
  return out;
}

export const stats = () => ({ requestCount });
