import crypto from "crypto";

function makeHeader(method, uri, key, secret, cid) {
  const ts = Date.now().toString();
  const sig = crypto.createHmac("sha256", secret).update(`${ts}.${method}.${uri}`).digest("base64");
  return {
    "Content-Type": "application/json; charset=UTF-8",
    "X-Timestamp": ts, "X-API-KEY": key, "X-Customer": cid, "X-Signature": sig,
  };
}

// 형태소 공유 여부로 연관성 판단
function isRelated(input, candidate) {
  if (!candidate) return false;
  const a = input.replace(/\s/g, "").toLowerCase();
  const b = candidate.replace(/\s/g, "").toLowerCase();
  if (b.includes(a) || a.includes(b)) return true;
  for (let len = 2; len <= Math.min(a.length, 4); len++)
    for (let i = 0; i <= a.length - len; i++)
      if (b.includes(a.slice(i, i + len))) return true;
  return false;
}

async function fetchKeywords(kw, key, secret, cid) {
  const uri = "/keywordstool";
  const res = await fetch(
    `https://api.naver.com${uri}?hintKeywords=${encodeURIComponent(kw)}&showDetail=1`,
    { headers: makeHeader("GET", uri, key, secret, cid) }
  );
  if (!res.ok) throw new Error(`네이버 API 오류 (${res.status})`);
  return (await res.json()).keywordList || [];
}

// 키워드 비교용 — 여러 키워드 병렬 조회
async function fetchMultiple(kws, key, secret, cid) {
  const results = await Promise.all(kws.map(kw => fetchKeywords(kw, key, secret, cid)));
  return kws.map((kw, i) => {
    const kwL = kw.replace(/\s/g, "").toLowerCase();
    const main = results[i].find(item =>
      (item.relKeyword || "").replace(/\s/g, "").toLowerCase() === kwL
    ) || results[i][0];
    if (!main) return { keyword: kw, total: 0, pc: 0, mobile: 0, mobileRatio: 0, competition: "-" };
    const pc = Number(main.monthlyPcQcCnt) || 0;
    const mobile = Number(main.monthlyMobileQcCnt) || 0;
    const total = pc + mobile;
    return { keyword: kw, total, pc, mobile, mobileRatio: total ? Math.round(mobile / total * 100) : 0, competition: main.compIdx || "-" };
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { kw, compare } = req.query;
  if (!kw) return res.status(400).json({ error: "키워드를 입력해주세요" });

  const KEY = process.env.NAVER_API_KEY;
  const SEC = process.env.NAVER_SECRET_KEY;
  const CID = process.env.NAVER_CUSTOMER_ID;
  if (!KEY || !SEC || !CID) return res.status(500).json({ error: "API 환경변수가 설정되지 않았습니다" });

  try {
    const rawList = await fetchKeywords(kw, KEY, SEC, CID);
    const kwL = kw.replace(/\s/g, "").toLowerCase();

    // 연관 키워드 필터링
    let related = rawList.filter(item => isRelated(kw, item.relKeyword || ""));
    if (related.length < 5) {
      related = rawList.filter(item => {
        const tot = (Number(item.monthlyPcQcCnt) || 0) + (Number(item.monthlyMobileQcCnt) || 0);
        return isRelated(kw, item.relKeyword || "") || tot >= 3000;
      });
    }

    const list = related.map(item => {
      const pc = Number(item.monthlyPcQcCnt) || 0;
      const mobile = Number(item.monthlyMobileQcCnt) || 0;
      const total = pc + mobile;
      return {
        keyword: item.relKeyword,
        total, pc, mobile,
        mobileRatio: total ? Math.round(mobile / total * 100) : 0,
        competition: item.compIdx || "-",
      };
    }).sort((a, b) => b.total - a.total).slice(0, 25);

    // 메인 키워드 맨 앞
    const mi = list.findIndex(i => i.keyword.replace(/\s/g, "").toLowerCase() === kwL);
    if (mi > 0) { const [m] = list.splice(mi, 1); list.unshift(m); }

    // 비교 키워드
    let compareData = null;
    if (compare) {
      const compareKws = compare.split(",").map(k => k.trim()).filter(Boolean).slice(0, 2);
      const allKws = [kw, ...compareKws];
      compareData = await fetchMultiple(allKws, KEY, SEC, CID);
    }

    return res.status(200).json({ keyword: kw, list, compareData });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
