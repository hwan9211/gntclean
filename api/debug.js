export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const KEY = process.env.NAVER_API_KEY;
  const SEC = process.env.NAVER_SECRET_KEY;
  const CID = process.env.NAVER_CUSTOMER_ID;
  const CLIENT_ID = process.env.NAVER_CLIENT_ID;
  const CLIENT_SEC = process.env.NAVER_CLIENT_SECRET;

  const result = {
    env: {
      NAVER_API_KEY:      KEY     ? `✅ 등록됨 (${KEY.slice(0,6)}...)` : "❌ 없음",
      NAVER_SECRET_KEY:   SEC     ? `✅ 등록됨 (${SEC.slice(0,6)}...)` : "❌ 없음",
      NAVER_CUSTOMER_ID:  CID     ? `✅ 등록됨 (${CID})` : "❌ 없음",
      NAVER_CLIENT_ID:    CLIENT_ID  ? `✅ 등록됨 (${CLIENT_ID.slice(0,8)}...)` : "❌ 없음",
      NAVER_CLIENT_SECRET:CLIENT_SEC ? `✅ 등록됨 (${CLIENT_SEC.slice(0,6)}...)` : "❌ 없음",
    },
    tests: {}
  };

  // 네이버 쇼핑 검색 API 테스트
  if (CLIENT_ID && CLIENT_SEC) {
    try {
      const shopRes = await fetch(
        "https://openapi.naver.com/v1/search/shop.json?query=물티슈&display=3&sort=sim",
        { headers: { "X-Naver-Client-Id": CLIENT_ID, "X-Naver-Client-Secret": CLIENT_SEC } }
      );
      const shopData = await shopRes.json();
      if (shopRes.ok) {
        result.tests.shopping_api = `✅ 성공 (상품 ${shopData.items?.length}개 조회)`;
        result.tests.shopping_sample = shopData.items?.slice(0,2).map(i => ({
          title: i.title.replace(/<[^>]+>/g,""),
          price: i.lprice,
          mall: i.mallName
        }));
      } else {
        result.tests.shopping_api = `❌ 실패 (${shopRes.status}): ${JSON.stringify(shopData)}`;
      }
    } catch(e) {
      result.tests.shopping_api = `❌ 오류: ${e.message}`;
    }

    // 데이터랩 API 테스트
    try {
      const end = new Date(), start = new Date();
      start.setMonth(end.getMonth()-1);
      const fmt = d => d.toISOString().slice(0,10);
      const dlRes = await fetch(
        "https://openapi.naver.com/v1/datalab/shopping/category/keywords/ratio",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Naver-Client-Id": CLIENT_ID,
            "X-Naver-Client-Secret": CLIENT_SEC
          },
          body: JSON.stringify({
            startDate: fmt(start), endDate: fmt(end), timeUnit: "date",
            keyword: [{ name: "물티슈", param: ["물티슈"] }],
            device: "", gender: "", ages: []
          })
        }
      );
      const dlData = await dlRes.json();
      if (dlRes.ok) {
        result.tests.datalab_api = `✅ 성공 (데이터 ${dlData.results?.[0]?.data?.length}개)`;
      } else {
        result.tests.datalab_api = `❌ 실패 (${dlRes.status}): ${JSON.stringify(dlData)}`;
      }
    } catch(e) {
      result.tests.datalab_api = `❌ 오류: ${e.message}`;
    }
  } else {
    result.tests.shopping_api = "⚠️ CLIENT_ID/SECRET 없어서 테스트 불가";
    result.tests.datalab_api  = "⚠️ CLIENT_ID/SECRET 없어서 테스트 불가";
  }

  return res.status(200).json(result);
}
