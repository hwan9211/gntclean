import crypto from "crypto";

function makeHeader(method, uri, key, secret, cid) {
  const ts  = Date.now().toString();
  const sig = crypto.createHmac("sha256", secret).update(`${ts}.${method}.${uri}`).digest("base64");
  return {
    "Content-Type": "application/json; charset=UTF-8",
    "X-Timestamp":  ts,
    "X-API-KEY":    key,
    "X-Customer":   cid,
    "X-Signature":  sig,
  };
}

// 네이버 데이터랩 쇼핑인사이트 API (기간별 트렌드)
async function fetchTrend(keyword, startDate, endDate, timeUnit, gender, ages, device) {
  const url   = "https://openapi.naver.com/v1/datalab/shopping/category/keywords/ratio";
  const cid   = process.env.NAVER_CLIENT_ID;
  const csec  = process.env.NAVER_CLIENT_SECRET;
  if (!cid || !csec) return null;

  const body = {
    startDate,
    endDate,
    timeUnit,
    keyword: [{ name: keyword, param: [keyword] }],
    device:  device || "",
    gender:  gender || "",
    ages:    ages   || [],
  };

  try {
    const res = await fetch(url, {
      method:  "POST",
      headers: {
        "Content-Type":          "application/json",
        "X-Naver-Client-Id":     cid,
        "X-Naver-Client-Secret": csec,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.results?.[0]?.data || null;
  } catch { return null; }
}

// 네이버 검색광고 API - 키워드 검색량
async function fetchKeywords(keyword, key, secret, cid) {
  const uri = "/keywordstool";
  const url = `https://api.naver.com${uri}?hintKeywords=${encodeURIComponent(keyword)}&showDetail=1`;
  const res = await fetch(url, { headers: makeHeader("GET", uri, key, secret, cid) });
  if (!res.ok) throw new Error(`네이버 API 오류 ${res.status}`);
  const data = await res.json();
  return data.keywordList || [];
}

// 네이버 검색광고 API - 캠페인 보고서에서 실제 CPC 조회
async function fetchCpcFromReport(keyword, key, secret, cid) {
  try {
    const uri = "/stats";
    const end   = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - 30);
    const fmt = d => d.toISOString().slice(0, 10);
    const url = `https://api.naver.com${uri}?datePreset=last30Days&fields=clkCnt,impCnt,salesAmt,ctr,cpc&timeRange=%7B"since":"${fmt(start)}","until":"${fmt(end)}"%7D`;
    const res = await fetch(url, { headers: makeHeader("GET", uri, key, secret, cid) });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.[0]?.cpc || null;
  } catch { return null; }
}

// 날짜 계산 헬퍼
function getDateRange(period) {
  const end   = new Date();
  const start = new Date();
  const fmt   = d => d.toISOString().slice(0, 10);
  let timeUnit = "date";

  switch (period) {
    case "day":     start.setDate(end.getDate() - 1);    timeUnit = "date";  break;
    case "week":    start.setDate(end.getDate() - 7);    timeUnit = "date";  break;
    case "month":   start.setMonth(end.getMonth() - 1);  timeUnit = "date";  break;
    case "quarter": start.setMonth(end.getMonth() - 3);  timeUnit = "week";  break;
    case "half":    start.setMonth(end.getMonth() - 6);  timeUnit = "month"; break;
    case "year":    start.setFullYear(end.getFullYear()-1); timeUnit = "month"; break;
    default:        start.setMonth(end.getMonth() - 1);  timeUnit = "date";  break;
  }
  return { startDate: fmt(start), endDate: fmt(end), timeUnit };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { kw, period = "month", gender = "", ages = "", device = "" } = req.query;
  if (!kw) return res.status(400).json({ error: "키워드를 입력해주세요" });

  const API_KEY     = process.env.NAVER_API_KEY;
  const SECRET_KEY  = process.env.NAVER_SECRET_KEY;
  const CUSTOMER_ID = process.env.NAVER_CUSTOMER_ID;
  if (!API_KEY || !SECRET_KEY || !CUSTOMER_ID)
    return res.status(500).json({ error: "API 환경변수가 설정되지 않았습니다" });

  try {
    const kwLower = kw.replace(/\s/g, "").toLowerCase();
    const { startDate, endDate, timeUnit } = getDateRange(period);
    const agesArr = ages ? ages.split(",") : [];

    // 병렬 요청
    const [rawList, trendData, cpcFromReport] = await Promise.all([
      fetchKeywords(kw, API_KEY, SECRET_KEY, CUSTOMER_ID),
      fetchTrend(kw, startDate, endDate, timeUnit, gender, agesArr, device),
      fetchCpcFromReport(kw, API_KEY, SECRET_KEY, CUSTOMER_ID),
    ]);

    // 연관 키워드 필터링 + 정렬
    const list = rawList
      .filter(item => {
        const rel = (item.relKeyword || "").replace(/\s/g, "").toLowerCase();
        const tot = (Number(item.monthlyPcQcCnt)||0) + (Number(item.monthlyMobileQcCnt)||0);
        return rel.includes(kwLower) || kwLower.includes(rel) || tot >= 100;
      })
      .map(item => {
        const pc     = Number(item.monthlyPcQcCnt)     || 0;
        const mobile = Number(item.monthlyMobileQcCnt) || 0;
        const total  = pc + mobile;
        const cpc    = Number(item.avgMonthlyBudget)   || 0;
        return {
          keyword:     item.relKeyword,
          total, pc, mobile,
          mobileRatio: total ? Math.round(mobile / total * 100) : 0,
          competition: item.compIdx || "-",
          cpc:         cpc > 0 ? cpc : (cpcFromReport || null),
          impressions: Number(item.monthlyAvgImprCnt) || 0,
          clicks:      Number(item.monthlyAvgClkCnt)  || 0,
          ctr:         Number(item.monthlyAvgCtr)     || 0,
        };
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, 20);

    // 메인 키워드를 맨 앞으로
    const mi = list.findIndex(i => i.keyword.replace(/\s/g,"").toLowerCase() === kwLower);
    if (mi > 0) { const [m] = list.splice(mi, 1); list.unshift(m); }

    // 네이버쇼핑 상위 브랜드
    let brands = [];
    try {
      const cid  = process.env.NAVER_CLIENT_ID;
      const csec = process.env.NAVER_CLIENT_SECRET;
      if (cid && csec) {
        const shopRes = await fetch(
          `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(kw)}&display=10&sort=sim`,
          { headers: { "X-Naver-Client-Id": cid, "X-Naver-Client-Secret": csec } }
        );
        if (shopRes.ok) {
          const shopData = await shopRes.json();
          const seen = new Set();
          brands = (shopData.items || []).map((item, idx) => ({
            rank:     idx + 1,
            title:    item.title.replace(/<[^>]+>/g, ""),
            brand:    item.brand || item.mallName || "-",
            price:    Number(item.lprice) || 0,
            mallName: item.mallName || "-",
            image:    item.image || "",
            link:     item.link  || "",
            reviewCount: Number(item.reviewCount) || 0,
          })).filter(item => {
            if (seen.has(item.mallName)) return false;
            seen.add(item.mallName);
            return true;
          }).slice(0, 5);
        }
      }
    } catch { /* 무시 */ }

    return res.status(200).json({
      keyword: kw,
      period,
      startDate,
      endDate,
      list,
      trend: trendData,   // 데이터랩 트렌드 (기간/성별/연령 필터 적용)
      brands,
      hasTrend: !!trendData,
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
