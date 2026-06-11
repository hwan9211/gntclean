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

// 쇼핑 검색 — 상품 목록 + 가격 데이터
async function fetchShopData(kw) {
  const cid=process.env.NAVER_CLIENT_ID, csec=process.env.NAVER_CLIENT_SECRET;
  if(!cid||!csec) return null;
  try {
    const res=await fetch(
      `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(kw)}&display=30&sort=sim`,
      {headers:{"X-Naver-Client-Id":cid,"X-Naver-Client-Secret":csec}}
    );
    if(!res.ok) return null;
    const data=await res.json();
    const items=(data.items||[]).map(item=>({
      title: item.title.replace(/<[^>]+>/g,""),
      brand: item.brand||item.mallName||"-",
      mallName: item.mallName||"-",
      lprice: Number(item.lprice)||0,
      hprice: Number(item.hprice)||0,
      image: item.image||"",
      link: item.link||"",
      category1: item.category1||"",
      category2: item.category2||"",
      reviewCount: Number(item.reviewCount)||0,
      productId: item.productId||"",
    }));
    // 가격 통계
    const prices=items.map(i=>i.lprice).filter(p=>p>0);
    const priceStats = prices.length>0 ? {
      min: Math.min(...prices),
      max: Math.max(...prices),
      avg: Math.round(prices.reduce((a,b)=>a+b,0)/prices.length),
      median: prices.sort((a,b)=>a-b)[Math.floor(prices.length/2)],
      count: prices.length,
    } : null;
    // 브랜드 Top5 (중복 제거, 리뷰순)
    const brandMap={};
    items.forEach(item=>{
      const b=item.brand!=="-"?item.brand:item.mallName;
      if(!brandMap[b]) brandMap[b]={brand:b,minPrice:item.lprice,maxPrice:item.hprice||item.lprice,reviewCount:item.reviewCount,count:0,image:item.image,link:item.link,titles:[]};
      brandMap[b].count++;
      brandMap[b].reviewCount+=item.reviewCount;
      brandMap[b].titles.push(item.title);
      if(item.lprice>0&&item.lprice<brandMap[b].minPrice) brandMap[b].minPrice=item.lprice;
    });
    const brands=Object.values(brandMap).sort((a,b)=>b.reviewCount-a.reviewCount).slice(0,6).map((b,i)=>({...b,rank:i+1}));
    return {items:items.slice(0,10),priceStats,brands};
  } catch(e) { return null; }
}

// 비교용 다중 키워드
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
      const cKws=compare.split(",").map(k=>k.trim()).filter(Boolean).slice(0,2);
      compareData=await fetchMultiple([kw,...cKws],KEY,SEC,CID);
    }
    return res.status(200).json({keyword:kw,list,shopData,compareData});
  } catch(e) { return res.status(500).json({error:e.message}); }
}
