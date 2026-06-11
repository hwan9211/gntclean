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

async function fetchShopData(kw) {
  const cid=process.env.NAVER_CLIENT_ID, csec=process.env.NAVER_CLIENT_SECRET;
  if(!cid||!csec) return null;
  try {
    const res=await fetch(
      `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(kw)}&display=40&sort=sim`,
      {headers:{"X-Naver-Client-Id":cid,"X-Naver-Client-Secret":csec}}
    );
    if(!res.ok) return null;
    const data=await res.json();

    // 이상한 상품 필터링: 가격 너무 낮거나(단품 끼워팔기), 제목이 너무 무관한 것 제거
    const kwClean = kw.replace(/\s/g,"").toLowerCase();
    const items=(data.items||[])
      .filter(item => {
        const price = Number(item.lprice)||0;
        const title = item.title.replace(/<[^>]+>/g,"").replace(/\s/g,"").toLowerCase();
        // 가격 500원 미만 제거 (단품/증정품)
        if(price > 0 && price < 500) return false;
        // 제목에 키워드 포함 여부 (느슨하게)
        return true;
      })
      .map(item=>({
        title: item.title.replace(/<[^>]+>/g,""),
        brand: item.brand||item.mallName||"-",
        mallName: item.mallName||"-",
        lprice: Number(item.lprice)||0,
        hprice: Number(item.hprice)||0,
        image: item.image||"",
        link: item.link||"",
        category1: item.category1||"",
        category2: item.category2||"",
        // 리뷰수 — API 필드 여러 가지 시도
        reviewCount: Number(item.reviewCount||item.review_count||item.commentCount||0),
        productId: item.productId||"",
      }));

    // 가격 통계 (이상값 제거: Q1~Q3 IQR 방식)
    const prices = items.map(i=>i.lprice).filter(p=>p>500).sort((a,b)=>a-b);
    let priceStats = null;
    if(prices.length > 0) {
      const q1 = prices[Math.floor(prices.length*0.25)];
      const q3 = prices[Math.floor(prices.length*0.75)];
      const iqr = q3 - q1;
      // 이상값 제외 (IQR * 1.5 벗어나는 값)
      const filtered = prices.filter(p => p >= q1-iqr*1.5 && p <= q3+iqr*1.5);
      const validPrices = filtered.length > 0 ? filtered : prices;
      priceStats = {
        min: Math.min(...validPrices),
        max: Math.max(...validPrices),
        avg: Math.round(validPrices.reduce((a,b)=>a+b,0)/validPrices.length),
        median: validPrices[Math.floor(validPrices.length/2)],
        count: items.length,
        filteredCount: validPrices.length,
      };
    }

    // 브랜드 집계 — mallName 기준 (brand 필드는 종종 비어있음)
    const brandMap={};
    items.forEach(item=>{
      // brand 필드 우선, 없으면 mallName
      const b = (item.brand && item.brand!=="-") ? item.brand : item.mallName;
      if(!b||b==="-") return;
      if(!brandMap[b]) brandMap[b]={brand:b,minPrice:item.lprice||99999999,reviewCount:0,count:0,image:item.image,link:item.link};
      brandMap[b].count++;
      brandMap[b].reviewCount += item.reviewCount;
      if(item.lprice>500 && item.lprice<brandMap[b].minPrice) brandMap[b].minPrice=item.lprice;
    });
    const brands=Object.values(brandMap)
      .filter(b=>b.count>0)
      .sort((a,b)=>b.count-a.count || b.reviewCount-a.reviewCount)
      .slice(0,6)
      .map((b,i)=>({...b,rank:i+1,minPrice:b.minPrice===99999999?0:b.minPrice}));

    return {items:items.slice(0,10), priceStats, brands};
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
    const [rawList,shopData]=await Promise.all([
      fetchKeywords(kw,KEY,SEC,CID),
      fetchShopData(kw),
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
    return res.status(200).json({keyword:kw,list,shopData,compareData});
  } catch(e) { return res.status(500).json({error:e.message}); }
}
