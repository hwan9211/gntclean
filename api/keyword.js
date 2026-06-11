import crypto from "crypto";

function makeHeader(method, uri, key, secret, cid) {
  const ts  = Date.now().toString();
  const sig = crypto.createHmac("sha256", secret).update(`${ts}.${method}.${uri}`).digest("base64");
  return {
    "Content-Type": "application/json; charset=UTF-8",
    "X-Timestamp":  ts, "X-API-KEY": key, "X-Customer": cid, "X-Signature": sig,
  };
}

function fmtDate(d) { return d.toISOString().slice(0,10); }
function getDateRange(period) {
  const end=new Date(), start=new Date(); let timeUnit="date";
  switch(period){
    case "day":     start.setDate(end.getDate()-1);        timeUnit="date";  break;
    case "week":    start.setDate(end.getDate()-7);         timeUnit="date";  break;
    case "month":   start.setMonth(end.getMonth()-1);       timeUnit="date";  break;
    case "quarter": start.setMonth(end.getMonth()-3);       timeUnit="week";  break;
    case "half":    start.setMonth(end.getMonth()-6);       timeUnit="month"; break;
    case "year":    start.setFullYear(end.getFullYear()-1); timeUnit="month"; break;
    default:        start.setMonth(end.getMonth()-1);       timeUnit="date";
  }
  return { startDate:fmtDate(start), endDate:fmtDate(end), timeUnit };
}

function isRelated(input, candidate) {
  const a=input.replace(/\s/g,"").toLowerCase();
  const b=candidate.replace(/\s/g,"").toLowerCase();
  if(!b||!a) return false;
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
  if(!res.ok) throw new Error(`API 오류 (${res.status})`);
  return (await res.json()).keywordList||[];
}

async function fetchTrend(kw, startDate, endDate, timeUnit, gender, ages, device) {
  const cid=process.env.NAVER_CLIENT_ID, csec=process.env.NAVER_CLIENT_SECRET;
  if(!cid||!csec) return null;
  try {
    const res=await fetch("https://openapi.naver.com/v1/datalab/shopping/category/keywords/ratio",{
      method:"POST",
      headers:{"Content-Type":"application/json","X-Naver-Client-Id":cid,"X-Naver-Client-Secret":csec},
      body:JSON.stringify({startDate,endDate,timeUnit,keyword:[{name:kw,param:[kw]}],device:device||"",gender:gender||"",ages:ages||[]}),
    });
    if(!res.ok) return null;
    return (await res.json()).results?.[0]?.data||null;
  } catch { return null; }
}

async function fetchDemoData(kw, startDate, endDate) {
  const cid=process.env.NAVER_CLIENT_ID, csec=process.env.NAVER_CLIENT_SECRET;
  if(!cid||!csec) return null;
  try {
    const call=(gender)=>fetch("https://openapi.naver.com/v1/datalab/shopping/category/keywords/ratio",{
      method:"POST",
      headers:{"Content-Type":"application/json","X-Naver-Client-Id":cid,"X-Naver-Client-Secret":csec},
      body:JSON.stringify({startDate,endDate,timeUnit:"month",keyword:[{name:kw,param:[kw]}],device:"",gender,ages:[]}),
    });
    const [rm,rf]=await Promise.all([call("m"),call("f")]);
    if(!rm.ok||!rf.ok) return null;
    const dm=await rm.json(), df=await rf.json();
    const mr=dm.results?.[0]?.data?.reduce((s,d)=>s+d.ratio,0)||0;
    const fr=df.results?.[0]?.data?.reduce((s,d)=>s+d.ratio,0)||0;
    const tot=mr+fr||1;
    return {maleRatio:Math.round(mr/tot*100),femaleRatio:Math.round(fr/tot*100)};
  } catch { return null; }
}

async function fetchShoppingBrands(kw) {
  const cid=process.env.NAVER_CLIENT_ID, csec=process.env.NAVER_CLIENT_SECRET;
  if(!cid||!csec) return {brands:[],hasBrands:false};
  try {
    const res=await fetch(
      `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(kw)}&display=20&sort=sim`,
      {headers:{"X-Naver-Client-Id":cid,"X-Naver-Client-Secret":csec}}
    );
    if(!res.ok) return {brands:[],hasBrands:false};
    const data=await res.json();
    const seen=new Set();
    const brands=(data.items||[]).map((item,i)=>({
      rank:i+1,title:item.title.replace(/<[^>]+>/g,""),
      brand:item.brand||item.mallName||"-",price:Number(item.lprice)||0,
      mallName:item.mallName||"-",image:item.image||"",link:item.link||"",
      reviewCount:Number(item.reviewCount)||0,category:item.category1||"",
    })).filter(item=>{if(seen.has(item.mallName))return false;seen.add(item.mallName);return true;}).slice(0,8);
    return {brands,hasBrands:true};
  } catch { return {brands:[],hasBrands:false}; }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET, OPTIONS");
  if(req.method==="OPTIONS") return res.status(200).end();
  const {kw,period="month",gender="",ages="",device=""}=req.query;
  if(!kw) return res.status(400).json({error:"키워드를 입력해주세요"});
  const KEY=process.env.NAVER_API_KEY, SEC=process.env.NAVER_SECRET_KEY, CID=process.env.NAVER_CUSTOMER_ID;
  if(!KEY||!SEC||!CID) return res.status(500).json({error:"API 환경변수가 설정되지 않았습니다"});
  try {
    const {startDate,endDate,timeUnit}=getDateRange(period);
    const agesArr=ages?ages.split(",").filter(Boolean):[];
    const [rawList,trendData,demoData,shopData]=await Promise.all([
      fetchKeywords(kw,KEY,SEC,CID),
      fetchTrend(kw,startDate,endDate,timeUnit,gender,agesArr,device),
      fetchDemoData(kw,startDate,endDate),
      fetchShoppingBrands(kw),
    ]);
    const kwLower=kw.replace(/\s/g,"").toLowerCase();
    let related=rawList.filter(item=>isRelated(kw,item.relKeyword||""));
    if(related.length<5) related=rawList.filter(item=>{
      const tot=(Number(item.monthlyPcQcCnt)||0)+(Number(item.monthlyMobileQcCnt)||0);
      return isRelated(kw,item.relKeyword||"")||tot>=5000;
    });
    const list=related.map(item=>{
      const pc=Number(item.monthlyPcQcCnt)||0, mobile=Number(item.monthlyMobileQcCnt)||0, total=pc+mobile;
      return {keyword:item.relKeyword,total,pc,mobile,mobileRatio:total?Math.round(mobile/total*100):0,competition:item.compIdx||"-"};
    }).sort((a,b)=>b.total-a.total).slice(0,20);
    const mi=list.findIndex(i=>i.keyword.replace(/\s/g,"").toLowerCase()===kwLower);
    if(mi>0){const[m]=list.splice(mi,1);list.unshift(m);}
    return res.status(200).json({keyword:kw,period,startDate,endDate,list,
      trend:trendData,hasTrend:!!trendData,demo:demoData,hasDemo:!!demoData,
      brands:shopData.brands,hasBrands:shopData.hasBrands});
  } catch(e) { return res.status(500).json({error:e.message}); }
}
