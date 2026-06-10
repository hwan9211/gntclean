import crypto from "crypto";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { kw } = req.query;
  if (!kw) return res.status(400).json({ error: "키워드를 입력해주세요" });

  const API_KEY     = process.env.NAVER_API_KEY;
  const SECRET_KEY  = process.env.NAVER_SECRET_KEY;
  const CUSTOMER_ID = process.env.NAVER_CUSTOMER_ID;

  if (!API_KEY || !SECRET_KEY || !CUSTOMER_ID) {
    return res.status(500).json({ error: "API 환경변수가 설정되지 않았습니다" });
  }

  const timestamp = Date.now().toString();
  const method    = "GET";
  const uri       = "/keywordstool";
  const msg       = `${timestamp}.${method}.${uri}`;

  const signature = crypto
    .createHmac("sha256", SECRET_KEY)
    .update(msg)
    .digest("base64");

  const url = `https://api.naver.com${uri}?hintKeywords=${encodeURIComponent(kw)}&showDetail=1`;

  try {
    const naverRes = await fetch(url, {
      headers: {
        "Content-Type":  "application/json; charset=UTF-8",
        "X-Timestamp":   timestamp,
        "X-API-KEY":     API_KEY,
        "X-Customer":    CUSTOMER_ID,
        "X-Signature":   signature,
      },
    });

    if (!naverRes.ok) {
      const err = await naverRes.text();
      return res.status(naverRes.status).json({ error: `네이버 API 오류: ${err}` });
    }

    const data = await naverRes.json();
    const list = (data.keywordList || []).slice(0, 10).map((item) => {
      const pc     = Number(item.monthlyPcQcCnt)     || 0;
      const mobile = Number(item.monthlyMobileQcCnt) || 0;
      const total  = pc + mobile;
      return {
        keyword:      item.relKeyword,
        total,
        pc,
        mobile,
        mobileRatio:  total ? Math.round((mobile / total) * 100) : 0,
        competition:  item.compIdx   || "-",
        cpc:          item.avgMonthlyBudget || "-",
        impressions:  item.monthlyAvgImprCnt || "-",
        clicks:       item.monthlyAvgClkCnt  || "-",
        ctr:          item.monthlyAvgCtr     || "-",
      };
    });

    return res.status(200).json({ keyword: kw, list });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
