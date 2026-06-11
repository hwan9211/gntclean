import crypto from "crypto";

function makeHeader(method, uri, key, secret, cid) {
  const ts = Date.now().toString();
  const sig = crypto.createHmac("sha256", secret).update(`${ts}.${method}.${uri}`).digest("base64");
  return { "Content-Type":"application/json; charset=UTF-8","X-Timestamp":ts,"X-API-KEY":key,"X-Customer":cid,"X-Signature":sig };
}

function isRelated(input, candidate) {
  if(!candidate) return false;
  const a=input.replace(/\s/g,"").toLowerCase();
  const b=candidate.replace(/\s/g,"").toLowerCase();
  if(b.includes(a)||a.includes(b)) return true;
  for(let len=2;len<=Math.min(a.length,4);len++)
    for(let i=0;i<=a.length-len;i++)
      if(b.includes(a.slice(i,i+len))) return true;
  return false;
}

async function fetchKeywords(kw, key, secret, cid) {
  const uri="/keywordstool";
  const res=await fetch(`https://api.naver.com${uri}?hintKeywords=${encodeURIComponent(kw)}&showDetail=1`,
    {headers:makeHeader("GET",uri,key,secret,cid)});
  if(!res.ok) throw new Error(`검색광고 API 오류 (${res.status})`);
  return (await res.json()).keywordList||[];
}


// 카테고리별 주요 브랜드 DB
const BRAND_DB = {
  "물티슈":    ["베베숲","브라운물티슈","하기스","유한킴벌리","보솜이","마미포코","크린베이비","아토팜","네추럴퍼프","더마앤모어"],
  "캡슐세제":  ["피죤","퍼실","다우니","에코버","리파인","세탁조교","너무달콤","버블클린"],
  "세탁세제":  ["피죤","퍼실","아리엘","비트","해피홈","옥시","라벤더","제온"],
  "섬유유연제":["피죤","다우니","퍼실","스너글","베르나르","샤프란"],
  "아기로션":  ["아토팜","베베숲","보솜이","세타필","존슨","네추럴퍼프","더마앤모어"],
  "주방세제":  ["자연퐁","트리오","참그린","옥시","퐁퐁","레몬에이드"],
  "default":   ["LG생활건강","애경","유한킴벌리","피죤","옥시"],
};

function getBrandList(kw) {
  for(const [key, brands] of Object.entries(BRAND_DB)) {
    if(kw.includes(key)) return brands;
  }
  return BRAND_DB.default;
}

// 브랜드별 시장 분석 — 브랜드명으로 직접 검색해 total 수집
async function fetchBrandAnalysis(kw, cid, csec) {
  if(!cid||!csec) return [];
  const brands = getBrandList(kw);
  
  // 5개씩 배치로 나눠서 병렬 호출 (타임아웃 방지)
  const batch1 = brands.slice(0, 5);
  const batch2 = brands.slice(5);

  async function fetchOne(brand) {
    try {
      const q = `${brand} ${kw}`;
      const res = await fetch(
        `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(q)}&display=10&sort=sim`,
        {headers:{"X-Naver-Client-Id":cid,"X-Naver-Client-Secret":csec}}
      );
      if(!res.ok) return null;
      const data = await res.json();
      if(!data.total || data.total === 0) return null;
      const brandItems = (data.items||[]).filter(item =>
        item.title.replace(/<[^>]+>/g,"").toLowerCase().includes(brand.toLowerCase())
      );
      if(brandItems.length === 0) return null;
      const prices = brandItems.map(i=>Number(i.lprice)||0).filter(p=>p>500).sort((a,b)=>a-b);
      return {
        brand,
        total: data.total,
        minPrice: prices[0]||0,
        avgPrice: prices.length>0 ? Math.round(prices.reduce((a,b)=>a+b,0)/prices.length) : 0,
        topTitle: brandItems[0]?.title.replace(/<[^>]+>/g,"")||"",
        image: brandItems[0]?.image||"",
        link: brandItems[0]?.link||"",
      };
    } catch { return null; }
  }

  const r1 = await Promise.all(batch1.map(fetchOne));
  const r2 = batch2.length > 0 ? await Promise.all(batch2.map(fetchOne)) : [];
  const results = [...r1, ...r2];

  return results
    .filter(r => r && r.total > 0)
    .sort((a,b) => b.total - a.total);
}



async function fetchTrend(kw, startDate, endDate) {
  const cid=process.env.NAVER_CLIENT_ID, csec=process.env.NAVER_CLIENT_SECRET;
  if(!cid||!csec) return null;
  try {
    const res=await fetch("https://openapi.naver.com/v1/datalab/search",{
      method:"POST",
      headers:{"Content-Type":"application/json","X-Naver-Client-Id":cid,"X-Naver-Client-Secret":csec},
      body:JSON.stringify({
        startDate, endDate, timeUnit:"week",
        keywordGroups:[{groupName:kw, keywords:[kw]}]
      }),
    });
    if(!res.ok) return null;
    const data = await res.json();
    return data.results?.[0]?.data || null;
  } catch { return null; }
}

async function fetchShopData(kw) {
  const cid=process.env.NAVER_CLIENT_ID, csec=process.env.NAVER_CLIENT_SECRET;
  if(!cid||!csec) return null;
  try {
    // 연관성 높은 순 + 낮은가격순 두 번 호출해서 합산
    const [simRes, lowRes] = await Promise.all([
      fetch(`https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(kw)}&display=40&sort=sim`,
        {headers:{"X-Naver-Client-Id":cid,"X-Naver-Client-Secret":csec}}),
      fetch(`https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(kw)}&display=40&sort=asc`,
        {headers:{"X-Naver-Client-Id":cid,"X-Naver-Client-Secret":csec}}),
    ]);
    if(!simRes.ok) return null;
    const simData = await simRes.json();
    const lowData = lowRes.ok ? await lowRes.json() : {items:[]};

    // 전체 상품 풀 합산 (중복 productId 제거)
    const allRaw = [...(simData.items||[]), ...(lowData.items||[])];
    const seen = new Set();
    const deduped = allRaw.filter(item => {
      const key = item.productId || item.link;
      if(seen.has(key)) return false;
      seen.add(key); return true;
    });

    // 매핑 + 필터링 (500원 미만 단품 제거)
    const items = deduped
      .filter(item => Number(item.lprice) >= 500)
      .map(item => ({
        title:    item.title.replace(/<[^>]+>/g,""),
        brand:    item.brand || "",
        mallName: item.mallName || "-",
        lprice:   Number(item.lprice) || 0,
        hprice:   Number(item.hprice) || 0,
        image:    item.image || "",
        link:     item.link || "",
        category1: item.category1 || "",
        category2: item.category2 || "",
        productId: item.productId || item.link,
      }));

    // 가격 통계 — IQR로 이상값 제거
    const prices = items.map(i=>i.lprice).filter(p=>p>0).sort((a,b)=>a-b);
    let priceStats = null;
    if(prices.length > 0) {
      const q1 = prices[Math.floor(prices.length*0.25)];
      const q3 = prices[Math.floor(prices.length*0.75)];
      const iqr = q3 - q1;
      const valid = prices.filter(p => p >= Math.max(500, q1-iqr*1.5) && p <= q3+iqr*1.5);
      const fp = valid.length > 3 ? valid : prices;
      priceStats = {
        min:    Math.min(...fp),
        max:    Math.max(...fp),
        avg:    Math.round(fp.reduce((a,b)=>a+b,0)/fp.length),
        median: fp[Math.floor(fp.length/2)],
        count:  items.length,
        // 가격대 구간별 상품수
        bands: {
          under5k:  fp.filter(p=>p<5000).length,
          k5to10:   fp.filter(p=>p>=5000&&p<10000).length,
          k10to20:  fp.filter(p=>p>=10000&&p<20000).length,
          k20to30:  fp.filter(p=>p>=20000&&p<30000).length,
          over30k:  fp.filter(p=>p>=30000).length,
        }
      };
    }

    // 브랜드 집계 — brand 필드 우선, 없으면 mallName
    const brandMap = {};
    items.forEach(item => {
      // brand가 있고 의미있는 경우 우선 사용
      const b = (item.brand && item.brand.length > 0) ? item.brand : item.mallName;
      if(!b || b==="-") return;
      if(!brandMap[b]) brandMap[b] = {
        brand: b, count: 0,
        prices: [], categories: new Set(),
        image: item.image, link: item.link,
        titles: [],
      };
      brandMap[b].count++;
      if(item.lprice > 0) brandMap[b].prices.push(item.lprice);
      if(item.category2) brandMap[b].categories.add(item.category2);
      if(brandMap[b].titles.length < 2) brandMap[b].titles.push(item.title);
    });

    const brands = Object.values(brandMap)
      .sort((a,b) => b.count - a.count)
      .slice(0, 6)
      .map((b, i) => {
        const sp = b.prices.sort((a,c)=>a-c);
        return {
          rank: i+1,
          brand: b.brand,
          count: b.count,
          minPrice: sp.length > 0 ? sp[0] : 0,
          avgPrice: sp.length > 0 ? Math.round(sp.reduce((a,c)=>a+c,0)/sp.length) : 0,
          categories: [...b.categories].slice(0,2).join(', '),
          image: b.image,
          link: b.link,
          sample: b.titles[0] || "",
        };
      });

    // 상위 노출 상품 Top8 (sim 기준)
    const topItems = items.slice(0, 8);

    return { items: topItems, priceStats, brands };
  } catch(e) { console.error('shopData error:',e.message); return null; }
}

async function fetchMultiple(kws, key, secret, cid) {
  const results=await Promise.all(kws.map(kw=>fetchKeywords(kw,key,secret,cid)));
  return kws.map((kw,i)=>{
    const kwL=kw.replace(/\s/g,"").toLowerCase();
    const main=results[i].find(item=>(item.relKeyword||"").replace(/\s/g,"").toLowerCase()===kwL)||results[i][0];
    if(!main) return {keyword:kw,total:0,pc:0,mobile:0,mobileRatio:0,competition:"-"};
    const pc=Number(main.monthlyPcQcCnt)||0, mobile=Number(main.monthlyMobileQcCnt)||0, total=pc+mobile;
    return {keyword:kw,total,pc,mobile,mobileRatio:total?Math.round(mobile/total*100):0,competition:main.compIdx||"-"};
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET, OPTIONS");
  if(req.method==="OPTIONS") return res.status(200).end();
  const {kw,compare}=req.query;
  if(!kw) return res.status(400).json({error:"키워드를 입력해주세요"});
  const KEY=process.env.NAVER_API_KEY, SEC=process.env.NAVER_SECRET_KEY, CID=process.env.NAVER_CUSTOMER_ID;
  if(!KEY||!SEC||!CID) return res.status(500).json({error:"API 환경변수가 설정되지 않았습니다"});
  try {
    const kwL=kw.replace(/\s/g,"").toLowerCase();
    const CLIENT_ID=process.env.NAVER_CLIENT_ID, CLIENT_SEC=process.env.NAVER_CLIENT_SECRET;
    const [rawList,shopData,brandAnalysis,trendData]=await Promise.all([
      fetchKeywords(kw,KEY,SEC,CID),
      fetchShopData(kw),
      fetchBrandAnalysis(kw, CLIENT_ID, CLIENT_SEC),
      fetchTrend(kw, new Date(Date.now()-30*24*60*60*1000).toISOString().slice(0,10), new Date().toISOString().slice(0,10)),
    ]);
    let related=rawList.filter(item=>isRelated(kw,item.relKeyword||""));
    if(related.length<5) related=rawList.filter(item=>{
      const tot=(Number(item.monthlyPcQcCnt)||0)+(Number(item.monthlyMobileQcCnt)||0);
      return isRelated(kw,item.relKeyword||"")||tot>=3000;
    });
    const list=related.map(item=>{
      const pc=Number(item.monthlyPcQcCnt)||0, mobile=Number(item.monthlyMobileQcCnt)||0, total=pc+mobile;
      return {keyword:item.relKeyword,total,pc,mobile,mobileRatio:total?Math.round(mobile/total*100):0,competition:item.compIdx||"-"};
    }).sort((a,b)=>b.total-a.total).slice(0,25);
    const mi=list.findIndex(i=>i.keyword.replace(/\s/g,"").toLowerCase()===kwL);
    if(mi>0){const[m]=list.splice(mi,1);list.unshift(m);}
    let compareData=null;
    if(compare){
      const cKws=compare.split(",").map(k=>k.trim()).filter(Boolean).slice(0,4);
      compareData=await fetchMultiple([kw,...cKws],KEY,SEC,CID);
    }
    return res.status(200).json({keyword:kw,list,shopData,brandAnalysis,trendData,compareData});
  } catch(e) { return res.status(500).json({error:e.message}); }
}
