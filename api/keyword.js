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

// 날짜 포맷
function fmt(d) { return d.toISOString().slice(0, 10); }
function getDateRange(period) {
  const end = new Date(), start = new Date();
  let timeUnit = "date";
  switch(period) {
    case "day":     start.setDate(end.getDate()-1);       timeUnit="date";  break;
    case "week":    start.setDate(end.getDate()-7);        timeUnit="date";  break;
    case "month":   start.setMonth(end.getMonth()-1);      timeUnit="date";  break;
    case "quarter": start.setMonth(end.getMonth()-3);      timeUnit="week";  break;
    case "half":    start.setMonth(end.getMonth()-6);      timeUnit="month"; break;
    case "year":    start.setFullYear(end.getFullYear()-1);timeUnit="month"; break;
    default:        start.setMonth(end.getMonth()-1);      timeUnit="date";  break;
  }
  return { startDate: fmt(start), endDate: fmt(end), timeUnit };
}

// 키워드 검색량 조회
async function fetchKeywords(kw, key, secret, cid) {
  const uri = "/keywordstool";
  const url = `https://api.naver.com${uri}?hintKeywords=${encodeURIComponent(kw)}&showDetail=1`;
  const res = await fetch(url, { headers: makeHeader("GET", uri, key, secret, cid) });
  if (!res.ok) throw new Error(`키워드 API 오류 (${res.status})`);
  return (await res.json()).keywordList || [];
}

// 실제 집행 데이터: 캠페인 보고서에서 CPC/노출/클릭 가져오기
async function fetchCampaignStats(key, secret, cid, startDate, endDate) {
  try {
    const uri = "/ncc/campaigns";
    const camRes = await fetch(`https://api.naver.com${uri}`, {
      headers: makeHeader("GET", uri, key, secret, cid)
    });
    if (!camRes.ok) return null;
    const campaigns = await camRes.json();
    if (!Array.isArray(campaigns) || !campaigns.length) return null;

    // 활성 캠페인 ID 수집
    const ids = campaigns
      .filter(c => c.status === "ELIGIBLE" || c.status === "PAUSED")
      .slice(0, 5)
      .map(c => c.nccCampaignId);
    if (!ids.length) return null;

    // 보고서 API
    const statUri = "/stat/campaigns";
    const body = {
      ids,
      fields: ["clkCnt", "impCnt", "salesAmt", "ctr", "cpc", "ror", "convAmt"],
      timeRange: { since: startDate, until: endDate },
      timeUnit: "summaryDay",
    };
    const statRes = await fetch(`https://api.naver.com${statUri}`, {
      method: "POST",
      headers: makeHeader("POST", statUri, key, secret, cid),
      body: JSON.stringify(body),
    });
    if (!statRes.ok) return null;
    const statData = await statRes.json();
    if (!statData?.data?.length) return null;

    // 합산
    const totals = statData.data.reduce((acc, d) => ({
      clkCnt:  (acc.clkCnt  || 0) + (Number(d.clkCnt)  || 0),
      impCnt:  (acc.impCnt  || 0) + (Number(d.impCnt)  || 0),
      salesAmt:(acc.salesAmt|| 0) + (Number(d.salesAmt)|| 0),
    }), {});
    const avgCpc = totals.clkCnt > 0 ? Math.round(totals.salesAmt / totals.clkCnt) : null;
    const avgCtr = totals.impCnt > 0 ? totals.clkCnt / totals.impCnt : null;
    return { ...totals, cpc: avgCpc, ctr: avgCtr };
  } catch { return null; }
}

// 데이터랩 트렌드
async function fetchTrend(kw, startDate, endDate, timeUnit, gender, ages, device) {
  const cid = process.env.NAVER_CLIENT_ID, csec = process.env.NAVER_CLIENT_SECRET;
  if (!cid || !csec) return null;
  try {
    const res = await fetch("https://openapi.naver.com/v1/datalab/shopping/category/keywords/ratio", {
      method: "POST",
      headers: { "Content-Type":"application/json","X-Naver-Client-Id":cid,"X-Naver-Client-Secret":csec },
      body: JSON.stringify({ startDate, endDate, timeUnit,
        keyword:[{ name:kw, param:[kw] }], device:device||"", gender:gender||"", ages:ages||[] }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.results?.[0]?.data || null;
  } catch { return null; }
}

// 쇼핑 상위 브랜드
async function fetchBrands(kw) {
  const cid = process.env.NAVER_CLIENT_ID, csec = process.env.NAVER_CLIENT_SECRET;
  if (!cid || !csec) return [];
  try {
    const res = await fetch(
      `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(kw)}&display=20&sort=sim`,
      { headers: { "X-Naver-Client-Id":cid, "X-Naver-Client-Secret":csec } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    const seen = new Set();
    return (data.items||[]).map((item,i)=>({
      rank: i+1,
      title: item.title.replace(/<[^>]+>/g,""),
      brand: item.brand || item.mallName || "-",
      price: Number(item.lprice)||0,
      mallName: item.mallName||"-",
      image: item.image||"",
      link: item.link||"",
      reviewCount: Number(item.reviewCount)||0,
    })).filter(item => {
      if(seen.has(item.mallName)) return false;
      seen.add(item.mallName); return true;
    }).slice(0,5);
  } catch { return []; }
}

// 키워드 관련성 판단 — 입력 키워드와 형태소 공유 여부 체크
function isRelated(inputKw, relKw) {
  const a = inputKw.replace(/\s/g,"").toLowerCase();
  const b = relKw.replace(/\s/g,"").toLowerCase();

  // 직접 포함 관계
  if(b.includes(a) || a.includes(b)) return true;

  // 2글자 이상 공통 부분 문자열
  for(let len=2; len<=a.length; len++) {
    for(let i=0; i<=a.length-len; i++) {
      if(b.includes(a.slice(i,i+len))) return true;
    }
  }
  return false;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if(req.method==="OPTIONS") return res.status(200).end();

  const { kw, period="month", gender="", ages="", device="" } = req.query;
  if(!kw) return res.status(400).json({ error:"키워드를 입력해주세요" });

  const KEY = process.env.NAVER_API_KEY;
  const SEC = process.env.NAVER_SECRET_KEY;
  const CID = process.env.NAVER_CUSTOMER_ID;
  if(!KEY||!SEC||!CID) return res.status(500).json({ error:"API 환경변수가 설정되지 않았습니다" });

  try {
    const { startDate, endDate, timeUnit } = getDateRange(period);
    const agesArr = ages ? ages.split(",").filter(Boolean) : [];

    // 병렬 요청
    const [rawList, campaignStats, trendData, brands] = await Promise.all([
      fetchKeywords(kw, KEY, SEC, CID),
      fetchCampaignStats(KEY, SEC, CID, startDate, endDate),
      fetchTrend(kw, startDate, endDate, timeUnit, gender, agesArr, device),
      fetchBrands(kw),
    ]);

    // 연관 키워드 필터링 — 관련성 있는 것만
    const list = rawList
      .filter(item => {
        const rel = item.relKeyword || "";
        const tot = (Number(item.monthlyPcQcCnt)||0) + (Number(item.monthlyMobileQcCnt)||0);
        // 관련 키워드 OR 검색량 500 이상 (최소 의미있는 볼륨)
        return isRelated(kw, rel) || tot >= 500;
      })
      .map(item => {
        const pc     = Number(item.monthlyPcQcCnt)    || 0;
        const mobile = Number(item.monthlyMobileQcCnt)|| 0;
        const total  = pc + mobile;
        const cpc    = Number(item.avgMonthlyBudget)  || 0;
        return {
          keyword:     item.relKeyword,
          total, pc, mobile,
          mobileRatio: total ? Math.round(mobile/total*100) : 0,
          competition: item.compIdx || "-",
          // CPC: 키워드툴 값 없으면 캠페인 보고서 값 사용
          cpc:    cpc > 0 ? cpc : (campaignStats?.cpc || null),
          impressions: Number(item.monthlyAvgImprCnt) || 0,
          clicks:      Number(item.monthlyAvgClkCnt)  || 0,
          ctr:         Number(item.monthlyAvgCtr)     || 0,
        };
      })
      .sort((a,b) => b.total - a.total)
      .slice(0, 20);

    // 메인 키워드 맨 앞
    const kwL = kw.replace(/\s/g,"").toLowerCase();
    const mi  = list.findIndex(i => i.keyword.replace(/\s/g,"").toLowerCase() === kwL);
    if(mi > 0) { const [m]=list.splice(mi,1); list.unshift(m); }

    return res.status(200).json({
      keyword: kw, period, startDate, endDate,
      list, brands, trend: trendData, hasTrend: !!trendData,
      campaignStats, // 실제 집행 데이터
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
