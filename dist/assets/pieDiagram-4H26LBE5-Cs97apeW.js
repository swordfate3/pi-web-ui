import{t as e}from"./ordinal-hYBb2elL.js";import{t}from"./arc-ClN8geVm.js";import{Ft as n,It as r,N as i,Nn as a,Pn as o,Qt as s,R as c,an as l,cn as u,in as d,rn as f,sn as p,tn as m,vn as h,vt as g,xn as _,xt as v,yn as y}from"./index-mG-O4xec.js";import{t as b}from"./mermaid-parser.core-CMOMY3S9.js";import{t as x}from"./chunk-4BX2VUAB-DVsS62AA.js";function S(e,t){return t<e?-1:t>e?1:t>=e?0:NaN}function C(e){return e}function w(){var e=C,t=S,i=null,a=r(0),o=r(n),s=r(0);function c(r){var c,l=(r=v(r)).length,u,d,f=0,p=Array(l),m=Array(l),h=+a.apply(this,arguments),g=Math.min(n,Math.max(-n,o.apply(this,arguments)-h)),_,y=Math.min(Math.abs(g)/l,s.apply(this,arguments)),b=y*(g<0?-1:1),x;for(c=0;c<l;++c)(x=m[p[c]=c]=+e(r[c],c,r))>0&&(f+=x);for(t==null?i!=null&&p.sort(function(e,t){return i(r[e],r[t])}):p.sort(function(e,n){return t(m[e],m[n])}),c=0,d=f?(g-l*b)/f:0;c<l;++c,h=_)u=p[c],x=m[u],_=h+(x>0?x*d:0)+b,m[u]={data:r[u],index:c,value:x,startAngle:h,endAngle:_,padAngle:y};return m}return c.value=function(t){return arguments.length?(e=typeof t==`function`?t:r(+t),c):e},c.sortValues=function(e){return arguments.length?(t=e,i=null,c):t},c.sort=function(e){return arguments.length?(i=e,t=null,c):i},c.startAngle=function(e){return arguments.length?(a=typeof e==`function`?e:r(+e),c):a},c.endAngle=function(e){return arguments.length?(o=typeof e==`function`?e:r(+e),c):o},c.padAngle=function(e){return arguments.length?(s=typeof e==`function`?e:r(+e),c):s},c}var T=f.pie,E={sections:new Map,showData:!1,config:T},D=E.sections,O=E.showData,k=structuredClone(T),A={getConfig:a(()=>structuredClone(k),`getConfig`),clear:a(()=>{D=new Map,O=E.showData,s()},`clear`),setDiagramTitle:_,getDiagramTitle:u,setAccTitle:y,getAccTitle:l,setAccDescription:h,getAccDescription:d,addSection:a(({label:e,value:t})=>{if(t<0)throw Error(`"${e}" has invalid value: ${t}. Negative values are not allowed in pie charts. All slice values must be >= 0.`);D.has(e)||(D.set(e,t),o.debug(`added new section: ${e}, with value: ${t}`))},`addSection`),getSections:a(()=>D,`getSections`),setShowData:a(e=>{O=e},`setShowData`),getShowData:a(()=>O,`getShowData`)},j=a((e,t)=>{x(e,t),t.setShowData(e.showData),e.sections.map(t.addSection)},`populateDb`),M={parse:a(async e=>{let t=await b(`pie`,e);o.debug(t),j(t,A)},`parse`)},N=a(e=>`
  .pieCircle{
    stroke: ${e.pieStrokeColor};
    stroke-width : ${e.pieStrokeWidth};
    opacity : ${e.pieOpacity};
  }
  .pieOuterCircle{
    stroke: ${e.pieOuterStrokeColor};
    stroke-width: ${e.pieOuterStrokeWidth};
    fill: none;
  }
  .pieTitleText {
    text-anchor: middle;
    font-size: ${e.pieTitleTextSize};
    fill: ${e.pieTitleTextColor};
    font-family: ${e.fontFamily};
  }
  .slice {
    font-family: ${e.fontFamily};
    fill: ${e.pieSectionTextColor};
    font-size:${e.pieSectionTextSize};
    // fill: white;
  }
  .legend text {
    fill: ${e.pieLegendTextColor};
    font-family: ${e.fontFamily};
    font-size: ${e.pieLegendTextSize};
  }
`,`getStyles`),P=a(e=>{let t=[...e.values()].reduce((e,t)=>e+t,0),n=[...e.entries()].map(([e,t])=>({label:e,value:t})).filter(e=>e.value/t*100>=1);return w().value(e=>e.value).sort(null)(n)},`createPieArcs`),F={parser:M,db:A,renderer:{draw:a((n,r,a,s)=>{o.debug(`rendering pie chart
`+n);let l=s.db,u=p(),d=i(l.getConfig(),u.pie),f=g(r),h=f.append(`g`);h.attr(`transform`,`translate(225,225)`);let{themeVariables:_}=u,[v]=c(_.pieOuterStrokeWidth);v??=2;let y=d.textPosition,b=t().innerRadius(0).outerRadius(185),x=t().innerRadius(185*y).outerRadius(185*y);h.append(`circle`).attr(`cx`,0).attr(`cy`,0).attr(`r`,185+v/2).attr(`class`,`pieOuterCircle`);let S=l.getSections(),C=P(S),w=[_.pie1,_.pie2,_.pie3,_.pie4,_.pie5,_.pie6,_.pie7,_.pie8,_.pie9,_.pie10,_.pie11,_.pie12],T=0;S.forEach(e=>{T+=e});let E=C.filter(e=>(e.data.value/T*100).toFixed(0)!==`0`),D=e(w).domain([...S.keys()]);h.selectAll(`mySlices`).data(E).enter().append(`path`).attr(`d`,b).attr(`fill`,e=>D(e.data.label)).attr(`class`,`pieCircle`),h.selectAll(`mySlices`).data(E).enter().append(`text`).text(e=>(e.data.value/T*100).toFixed(0)+`%`).attr(`transform`,e=>`translate(`+x.centroid(e)+`)`).style(`text-anchor`,`middle`).attr(`class`,`slice`);let O=h.append(`text`).text(l.getDiagramTitle()).attr(`x`,0).attr(`y`,-400/2).attr(`class`,`pieTitleText`),k=[...S.entries()].map(([e,t])=>({label:e,value:t})),A=h.selectAll(`.legend`).data(k).enter().append(`g`).attr(`class`,`legend`).attr(`transform`,(e,t)=>{let n=22*k.length/2;return`translate(216,`+(t*22-n)+`)`});A.append(`rect`).attr(`width`,18).attr(`height`,18).style(`fill`,e=>D(e.label)).style(`stroke`,e=>D(e.label)),A.append(`text`).attr(`x`,22).attr(`y`,14).text(e=>l.getShowData()?`${e.label} [${e.value}]`:e.label);let j=512+Math.max(...A.selectAll(`text`).nodes().map(e=>e?.getBoundingClientRect().width??0)),M=O.node()?.getBoundingClientRect().width??0,N=450/2-M/2,F=450/2+M/2,I=Math.min(0,N),L=Math.max(j,F)-I;f.attr(`viewBox`,`${I} 0 ${L} 450`),m(f,450,L,d.useMaxWidth)},`draw`)},styles:N};export{F as diagram};