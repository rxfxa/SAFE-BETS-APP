/* Safe Bets — 🎲 Simulator module (sim.js)
   Plays every game out 100,000 times, play by play, with a model calibrated to the app's engine (window.SB):
     soccer  minute by minute (90' + stoppage), goal intensity rising late in halves, game-state push, red cards, goalscorers
     NHL     30-second ticks over 3 periods (empty net late), 5-minute 3v3 overtime, shootout
     NBA     possession by possession (~99 each, 0/1/2/3 points), mild "garbage time / comeback" mean reversion, overtime
     NFL/CFB drive by drive (TD + XP / 2-pt, FG, punts, turnovers, safeties, defensive scores, two-minute drill, kneel-downs, OT)
   Calibration: soccer/NHL goal rates are solved with an exact dynamic program over the same tick model so that expected goals
   per side and the draw (regulation-tie) chance equal the engine's score grid; NBA/NFL/CFB strengths are solved with seeded
   pilot runs so the home-win chance and mean total equal the engine's. Agreement on those targets is by construction (not an
   independent check); the sim adds the spread of outcomes, play-level markets (half-time, key numbers, first goal) and what-ifs
   that move the play-level parameters from there. All numbers are model estimates.
   Runs happen in a Web Worker made from an inline Blob (same source as SIMCORE below); without Workers a time-sliced
   requestAnimationFrame loop runs the same generator on the main thread. */
(function(){
'use strict';
const SB=window.SB;
if(!SB||!(SB.version>=2)||typeof SB.registerTab!=='function'){console.warn('sim.js: window.SB v2 API not found');return;}

/* ============================== SIMCORE (runs in the worker AND on the main thread) ==============================
   Must not reference anything outside itself: its source is stringified into the worker blob. */
function SIMCORE(){
'use strict';
function rng(seed){let a=seed>>>0;return function(){a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
function hashStr(s){let h=2166136261;s=String(s);for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;}
function nrand(R){let u=R();if(u<1e-12)u=1e-12;return Math.sqrt(-2*Math.log(u))*Math.cos(6.283185307179586*R());}
function erf(x){const t=1/(1+.3275911*Math.abs(x));const y=1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-.284496736)*t+.254829592)*t*Math.exp(-x*x);return x>=0?y:-y;}
const Phi=z=>.5*(1+erf(z/Math.SQRT2));
function invNorm(p){p=Math.min(1-1e-9,Math.max(1e-9,p));const a=[-39.6968302866538,220.946098424521,-275.928510446969,138.357751867269,-30.6647980661472,2.50662827745924],b=[-54.4760987982241,161.585836858041,-155.698979859887,66.8013118877197,-13.2806815528857],c=[-.00778489400243029,-.322396458041136,-2.40075827716184,-2.54973253934373,4.37466414146497,2.93816398269878],d=[.00778469570904146,.32246712907004,2.445134137143,3.75440866190742];
  if(p<.02425){const q=Math.sqrt(-2*Math.log(p));return(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);}
  if(p>1-.02425){const q=Math.sqrt(-2*Math.log(1-p));return-(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);}
  const q=p-.5,r=q*q;return(((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);}
const clamp=(x,a,b)=>x<a?a:x>b?b:x;
const N_SIMS=100000;

/* ---------------- goals sports: tick model ---------------- */
const GC=13; // dynamic-program goal cap per side (mass beyond is ~1e-9)
// soccer constants: game state (leading / trailing / level=kap calibrated), red cards (team down a man, opponent), stoppage time
const SOC={LEAD:.97,TRAIL:1.06,DOWN:.72,UP:1.22,RED:.055/96,HALF:[.92,1.08],STOP:1.25,
  S:[[0,.08,.2,.27,.22,.13,.1],[0,0,0,.06,.12,.18,.2,.17,.13,.08,.06]]};
// NHL: 30-second ticks; empty net in the last 2.5 minutes when trailing by 1-2; OT 3v3 10 ticks, ~60% decided in OT
const NHLC={LEAD:.97,TRAIL:1.06,PER:[.93,1.05,1.02],EN:5,ENT:2.2,ENL:3.5,OTT:10,POT:.6,BACKUP:1.15};
const socW=(half,m)=>SOC.HALF[half]*(.8+.4*(m-1)/44);
let SEQ=null;
function soccerSeq(){ // flat schedule: {t:'reg',half,min,w} ×45, {t:'stop',half,w,P}, {t:'ht'}, …
  if(SEQ)return SEQ;const s=[];
  for(let half=0;half<2;half++){for(let m=1;m<=45;m++)s.push({t:'reg',half,min:half*45+m,w:socW(half,m)});
    s.push({t:'stop',half,w:SOC.HALF[half]*SOC.STOP,P:SOC.S[half],min:half*45+45});if(!half)s.push({t:'ht'});}
  return SEQ=s;}
function stateRates(P,w,h,a,r,en,out){ // per-tick goal probabilities for (home, away)
  const C=P.sport==='nhl'?NHLC:SOC,d=h-a;let mh=P.sh*w,ma=P.sa*w;
  if(d===0){mh*=P.kap;ma*=P.kap;}else if(d>0){mh*=C.LEAD;ma*=C.TRAIL;}else{mh*=C.TRAIL;ma*=C.LEAD;}
  if(r&1){mh*=SOC.DOWN;ma*=SOC.UP;}if(r&2){ma*=SOC.DOWN;mh*=SOC.UP;}
  if(en&&d!==0&&d>=-2&&d<=2){if(d<0){mh*=NHLC.ENT;ma*=NHLC.ENL;}else{ma*=NHLC.ENT;mh*=NHLC.ENL;}}
  const s=mh+ma;if(s>.6){mh*=.6/s;ma*=.6/s;}out[0]=mh;out[1]=ma;}
/* Exact dynamic program over the tick model. State = (x, r, h, a): x = extra dimension (mode 1: half-time category ×
   first-goal team for soccer extras), r = red-card bits, h/a goals. Returns the final distribution.
   start (soccer, mode 0 only; optional) = in-play state {min, h, a, r}: min minutes played (45 = half-time, so the first-half
   stoppage is skipped too; 90 = only second-half stoppage left), score h-a, red-card bits r (1 home, 2 away down a man). */
function goalsDP(P,mode,start){
  const NX=mode?30:1,G2=GC*GC,NS=NX*4*G2,rr=new Float64Array(2),soc=P.sport==='soccer',RED=soc&&P.reds!==false?SOC.RED:0;
  let cur=new Float64Array(NS),nxt=new Float64Array(NS);const st=soc&&!mode&&start?start:null;
  if(st)cur[(st.r&3)*G2+clamp(st.h|0,0,GC-2)*GC+clamp(st.a|0,0,GC-2)]=1;else cur[mode?(9*3)*4*G2:0]=1;
  const gx=(x,team)=>{if(!mode)return x;const c=(x/3)|0,f=x%3;return c*3+(f||team+1);};
  const ND=2*GC-1,RT=new Float64Array(4*ND*2);
  function step(src,dst,w,en){dst.fill(0);
    // the rates depend only on the goal difference and the red-card bits: tabulate them once per tick
    for(let r=0;r<4;r++)for(let d=1-GC;d<GC;d++){stateRates(P,w,d>0?d:0,d<0?-d:0,r,en,rr);const i=(r*ND+d+GC-1)*2;RT[i]=rr[0];RT[i+1]=rr[1];}
    for(let x=0;x<NX;x++)for(let r=0;r<4;r++){const base=(x*4+r)*G2;
      for(let h=0;h<GC;h++)for(let a=0;a<GC;a++){const m=src[base+h*GC+a];if(m<1e-14)continue;
        const ri=(r*ND+h-a+GC-1)*2,ph=RT[ri],pa=RT[ri+1],prh=(r&1)?0:RED,pra=(r&2)?0:RED;
        dst[base+h*GC+a]+=m*(1-ph-pa-prh-pra);
        const xh=gx(x,0),xa=gx(x,1);
        dst[(xh*4+r)*G2+Math.min(h+1,GC-1)*GC+a]+=m*ph;
        dst[(xa*4+r)*G2+h*GC+Math.min(a+1,GC-1)]+=m*pa;
        if(prh)dst[(x*4+(r|1))*G2+h*GC+a]+=m*prh;if(pra)dst[(x*4+(r|2))*G2+h*GC+a]+=m*pra;}}}
  function forceRed(bit){for(let x=0;x<NX;x++)for(let r=0;r<4;r++){if(r&bit)continue;const s=(x*4+r)*G2,t=(x*4+(r|bit))*G2;for(let i=0;i<G2;i++){cur[t+i]+=cur[s+i];cur[s+i]=0;}}}
  const sw=()=>{const t=cur;cur=nxt;nxt=t;};
  if(soc){
    for(const tk of soccerSeq()){
      if(st&&((tk.t==='reg'&&tk.min<=st.min)||(tk.t==='stop'&&tk.half===0&&st.min>=45)))continue;
      if(tk.t==='reg'){if(P.fr&&P.fr.min===tk.min)forceRed(P.fr.bit);step(cur,nxt,tk.w,false);sw();}
      else if(tk.t==='stop'){const acc=new Float64Array(NS);for(let k=1;k<tk.P.length;k++){step(cur,nxt,tk.w,false);sw();const pk=tk.P[k];if(pk)for(let i=0;i<NS;i++)acc[i]+=pk*cur[i];}cur=acc;nxt=new Float64Array(NS);}
      else if(tk.t==='ht'&&mode){const out=new Float64Array(NS); // x: c=9 (pre-HT) -> c = HT category
        for(let x=0;x<NX;x++){const f=x%3;for(let r=0;r<4;r++)for(let h=0;h<GC;h++)for(let a=0;a<GC;a++){const m=cur[(x*4+r)*G2+h*GC+a];if(!m)continue;
          const c=(h>a?0:h===a?1:2)*3+Math.min(h+a,2);out[((c*3+f)*4+r)*G2+h*GC+a]+=m;}}cur=out;}
    }
  } else {
    for(let t=0;t<120;t++){step(cur,nxt,NHLC.PER[(t/40)|0],t>=120-NHLC.EN);sw();}
  }
  return {S:cur,NX,G2};}
// (half-time category x first-goal team) x final score grid for the soccer SIM legs, red-card states merged: E[x*G2 + h*GC + a]
function extGrid(P){const dp=goalsDP(P,1),G2=GC*GC,E=new Float64Array(30*G2);
  for(let x=0;x<30;x++)for(let r=0;r<4;r++){const b=(x*4+r)*G2;for(let i=0;i<G2;i++)E[x*G2+i]+=dp.S[b+i];}return E;}
function dpSummary(dp){const {S,NX,G2}=dp,F=new Float64Array(G2);
  for(let x=0;x<NX;x++)for(let r=0;r<4;r++){const b=(x*4+r)*G2;for(let i=0;i<G2;i++)F[i]+=S[b+i];}
  let eh=0,ea=0,H=0,D=0,A=0;for(let h=0;h<GC;h++)for(let a=0;a<GC;a++){const p=F[h*GC+a];eh+=h*p;ea+=a*p;if(h>a)H+=p;else if(h===a)D+=p;else A+=p;}
  return {F,eh,ea,H,D,A};}
function totalW(sport){if(sport==='nhl'){let s=0;for(let t=0;t<120;t++)s+=NHLC.PER[(t/40)|0];return s;}let s=0;for(const tk of soccerSeq()){if(tk.t==='reg')s+=tk.w;else if(tk.t==='stop'){let e=0;for(let k=1;k<tk.P.length;k++)e+=k*tk.P[k];s+=e*tk.w;}}return s;}
/* calibration: multiplicative fixed point on (home rate, away rate, level-state multiplier) until the DP's expected goals
   per side and draw chance equal the engine's grid (soccer: full time; NHL: regulation). */
function* calibGoalsGen(sport,tg){
  /* targets: the engine's home-win / draw / away-win split and total goals (fallback: per-side goals + draw).
     Inner loop: for a level-state multiplier kap, fixed-point on total scale + home/away ratio. Outer: secant on log(kap)
     for the draw chance, kept inside a bracket (bisection when a secant step leaves it). */
  const W=totalW(sport),T=tg.eh+tg.ea,useHA=tg.H>0&&tg.A>0;let P={sport,sh:tg.eh/W,sa:tg.ea/W,kap:1},s=null,n=0;
  function* inner(kap){P.kap=kap;let u=Math.log(P.sh*P.sa)/2,v=Math.log(P.sh/P.sa),prev=null;const lt=Math.log(tg.H/tg.A);
    for(let it=0;it<60;it++){s=dpSummary(goalsDP(P,0));n++;yield n;
      if(useHA){const eT=Math.log(T/(s.eh+s.ea)),gv=Math.log(s.H/s.A)-lt;if(Math.abs(eT)<2e-5&&Math.abs(gv)<2e-5)break;
        let sl=prev&&Math.abs(v-prev.v)>1e-9?(gv-prev.g)/(v-prev.v):2.2;sl=clamp(sl,.5,8);prev={v,g:gv};
        u+=eT;v-=clamp(gv/sl,-1,1);P.sh=Math.exp(u+v/2);P.sa=Math.exp(u-v/2);continue;}
      else{const e1=tg.eh/s.eh,e2=tg.ea/s.ea;P.sh*=e1;P.sa*=e2;if(Math.abs(e1-1)<1e-6&&Math.abs(e2-1)<1e-6)break;}}
    return s.D-tg.D;}
  let lo=Math.log(.15),hi=Math.log(6),x0=0,f0=yield* inner(1),x1=f0>0?.15:-.15,f1=yield* inner(Math.exp(x1)),best={x:Math.abs(f0)<Math.abs(f1)?x0:x1,f:Math.min(Math.abs(f0),Math.abs(f1))};
  // D falls as kap rises: f(x) decreasing
  for(const [x,f] of [[x0,f0],[x1,f1]]){if(f>0)lo=Math.max(lo,x);else hi=Math.min(hi,x);}
  for(let k=0;k<40&&best.f>3e-5;k++){let x=f1!==f0?x1-f1*(x1-x0)/(f1-f0):(lo+hi)/2;if(!(x>lo&&x<hi))x=(lo+hi)/2;
    const f=yield* inner(Math.exp(x));if(f>0)lo=x;else hi=x;x0=x1;f0=f1;x1=x;f1=f;if(Math.abs(f)<best.f)best={x,f:Math.abs(f)};}
  if(Math.abs(x1-best.x)>1e-12)yield* inner(Math.exp(best.x));
  return {sh:P.sh,sa:P.sa,kap:P.kap,iters:n,fitH:s.H,fitD:s.D,fitA:s.A,fitEh:s.eh,fitEa:s.ea};}
const drain=it=>{let r;while(!(r=it.next()).done);return r.value;};
function calibGoals(sport,tg){return drain(calibGoalsGen(sport,tg));}
// any calibration as a generator (yields while it works, returns the base parameters)
function calibGen(spec,pilot){const sp=spec.sport;return sp==='soccer'||sp==='nhl'?calibGoalsGen(sp,spec.tg):calibMarginGen(sp,spec.tg,hashStr(spec.gid+'|pilot'),pilot||16000);}

/* ---------------- margin sports constants ---------------- */
const NBAC={BASE:1.08,P3:.125,P2:.33,P1:.045,REV:.06,PACE:99,PSD:1,CAP:20};
/* football: per-drive TD / FG rates (scaled by team strength), late-game kicking (KFG / KTD: the last KL drives of the 2nd half
   when level or trailing by 1-3 -> play for the field goal; OTFG: first OT possession), mild game-state reversion REV (leader
   protects the lead, trailer presses; keeps the margin spread near the engine's), SIG = per-game strength noise. */
const FBC={nfl:{TD:.2,FG:.185,SAF:.003,DTD:.011,XP:.955,TWO:.48,DR:[[10,.2],[11,.35],[12,.3],[13,.15]],OTTD:1.1,KL:5,KFG:2.2,KTD:.7,OTFG:2,REV:.12,RCAP:17,SIG:0},
          ncaaf:{TD:.27,FG:.13,SAF:.003,DTD:.012,XP:.975,TWO:.45,DR:[[12,.2],[13,.35],[14,.3],[15,.15]],OTTD:1.2,KL:3,KFG:1.4,KTD:.9,OTFG:1,REV:0,RCAP:21,SIG:.13}};
const GO2=new Set([-2,-5,-10,1,5]);
const HA={soccer:.35,nhl:.2,nba:2.5,nfl:1.8,ncaaf:3}; // typical home edge in margin units (for the home-advantage what-if)

/* ---------------- parameters = calibrated base + what-if ---------------- */
function applyWI(spec,base){
  const wi=spec.wi||{},sp=spec.sport,P={sport:sp};
  const dm=(+wi.str||0)+((wi.ha==null?1:+wi.ha)-1)*HA[sp],tempo=1+(+wi.tempo||0);
  if(sp==='soccer'||sp==='nhl'){
    const T=(spec.tg.eh+spec.tg.ea)||2.6,dx=dm/T;
    P.sh=base.sh*Math.exp(dx)*tempo;P.sa=base.sa*Math.exp(-dx)*tempo;P.kap=base.kap;P.reds=true;
    P.sc=[spec.scorers&&spec.scorers[0]||[],spec.scorers&&spec.scorers[1]||[]].map(l=>l.map(x=>({...x})));
    if(sp==='soccer'&&wi.out){for(let t=0;t<2;t++){const L=P.sc[t],i=L.findIndex(x=>x.id===wi.out);if(i>=0){const s=L[i].share;
      if(t===0)P.sh*=1-s;else P.sa*=1-s;L.splice(i,1);for(const x of L)x.share=x.share/(1-s);}}}
    if(sp==='soccer'&&(wi.red===0||wi.red===1))P.fr={bit:wi.red?2:1,min:clamp(Math.round(+wi.redMin||60),1,90)};
    if(sp==='nhl'&&(wi.gk===0||wi.gk===1)){if(wi.gk===0)P.sa*=NHLC.BACKUP;else P.sh*=NHLC.BACKUP;}
    P.q=spec.tg.q==null?.5:spec.tg.q;
    if(sp==='nhl'){const r=P.sh/(P.sh+P.sa),r0=base.sh/(base.sh+base.sa);P.q=clamp(P.q+.6*(r-r0),.25,.75);}
    P.cum=P.sc.map(L=>{let c=0;return L.map(x=>(c+=x.share));});
  } else {
    const T=spec.tg.T||50,dx=dm/T;P.g=base.g*tempo;P.x=base.x+dx;
    if(sp==='nba')P.pace=wi.pace?+wi.pace:NBAC.PACE;else P.wx=wi.wx?1:0;
  }
  return P;}

/* ---------------- one simulated game ----------------
   rec receives: h,a final; hh,ha half-time (NHL: after the 1st period); fg first goal team (0 none,1 home,2 away);
   x = 0 regulation, 1 OT, 2 shootout (NHL) / OT (others); anyH/anyA scorer bitmasks; fs first scorer code.
   ev (optional) receives the play-by-play for the Watch view: {steps:[{c:clock,h,a}], log:[{i,c,k,team,txt,h,a}]} */
function simSoccer(P,R,rec,ev,gm){
  let h=0,a=0,r=0,fg=0,fs=-9,anyH=0,anyA=0,i=0;const rr=new Float64Array(2),RED=P.reds?SOC.RED:0,cum=P.cum,sc=P.sc;
  function pick(t){const c=cum[t],u=R();for(let j=0;j<c.length;j++)if(u<c[j])return j;return -1;}
  function tick(w,clk,minute){stateRates(P,w,h,a,r,false,rr);const u=R(),ph=rr[0],pa=rr[1];
    if(u<ph+pa){const t=u<ph?0:1;if(t)a++;else h++;const j=pick(t);if(j>=0){if(t)anyA|=1<<j;else anyH|=1<<j;}
      if(!fg){fg=t+1;fs=j<0?-1-t:t*32+j;}
      if(gm)gm[t*20+Math.min(19,((minute-1)/5)|0)]++;
      if(ev)ev.log.push({i,c:clk,k:'goal',team:t,who:j>=0?sc[t][j].name:null,h,a});}
    else if(RED){const v=u-ph-pa;
      if(!(r&1)&&v<RED){r|=1;if(ev)ev.log.push({i,c:clk,k:'red',team:0,h,a});}
      else if(!(r&2)&&v>=RED&&v<2*RED){r|=2;if(ev)ev.log.push({i,c:clk,k:'red',team:1,h,a});}}
    if(ev)ev.steps.push({c:clk,h,a});i++;}
  for(const tk of soccerSeq()){
    if(tk.t==='reg'){if(P.fr&&P.fr.min===tk.min&&!(r&P.fr.bit)){r|=P.fr.bit;if(ev)ev.log.push({i,c:tk.min+"'",k:'red',team:P.fr.bit===1?0:1,h,a,forced:1});}tick(tk.w,tk.min+"'",tk.min);}
    else if(tk.t==='stop'){let u=R(),L=1;for(let k=1;k<tk.P.length;k++){u-=tk.P[k];if(u<0){L=k;break;}L=k;}
      if(ev)ev.log.push({i,c:tk.min+"'",k:'added',n:L,h,a});
      for(let k=1;k<=L;k++)tick(tk.w,tk.min+'+'+k+"'",tk.min);}
    else if(tk.t==='ht'){rec.hh=h;rec.ha=a;if(ev)ev.log.push({i,c:'HT',k:'ht',h,a});}}
  rec.h=h;rec.a=a;rec.fg=fg;rec.fs=fs;rec.anyH=anyH;rec.anyA=anyA;rec.x=0;
  if(ev)ev.log.push({i,c:'FT',k:'ft',h,a});}
function simNHL(P,R,rec,ev,gm){
  let h=0,a=0,fg=0,i=0;const rr=new Float64Array(2);
  const clk=t=>{const per=((t/40)|0)+1,s=1200-((t%40)+1)*30;return 'P'+per+' '+Math.floor(s/60)+':'+String(s%60).padStart(2,'0');};
  for(let t=0;t<120;t++){const per=(t/40)|0;stateRates(P,NHLC.PER[per],h,a,0,t>=120-NHLC.EN,rr);const u=R();
    if(u<rr[0]+rr[1]){const tm=u<rr[0]?0:1;if(tm)a++;else h++;if(!fg)fg=tm+1;if(gm)gm[tm*20+Math.min(14,(t/8)|0)]++;
      if(ev){const d0=tm?(a-1)-h:(h-1)-a;ev.log.push({i,c:clk(t),k:'goal',team:tm,h,a,en:t>=120-NHLC.EN&&d0>=1&&d0<=2?1:0});}}
    if(ev){ev.steps.push({c:clk(t),h,a});if(t%40===39)ev.log.push({i,c:'End P'+(per+1),k:'per',h,a});}
    if(t===39){rec.hh=h;rec.ha=a;}i++;}
  let x=0;
  if(h===a){const q=P.q,pt=1-Math.pow(1-NHLC.POT,1/NHLC.OTT);x=2;
    if(ev)ev.log.push({i,c:'OT',k:'ot',h,a});
    for(let k=0;k<NHLC.OTT;k++){const u=R();const s=300-(k+1)*30;
      if(ev)ev.steps.push({c:'OT '+Math.floor(s/60)+':'+String(s%60).padStart(2,'0'),h,a});
      if(u<pt){x=1;if(u<pt*q)h++;else a++;if(!fg)fg=(u<pt*q)?1:2;if(ev){ev.steps[ev.steps.length-1].h=h;ev.steps[ev.steps.length-1].a=a;ev.log.push({i,c:'OT',k:'goal',team:u<pt*q?0:1,h,a,ot:1});}i++;break;}i++;}
    if(x===2){const hw=R()<q;
      if(ev){const rounds=soRounds(R,hw);let sh=0,sa=0;for(const rd of rounds){sh+=rd[0];sa+=rd[1];ev.steps.push({c:'SO',h,a});ev.log.push({i,c:'SO',k:'so',sh,sa,h,a,r0:rd[0],r1:rd[1]});i++;}}
      if(hw)h++;else a++;if(ev){ev.steps.push({c:'SO',h,a});ev.log.push({i,c:'SO',k:'sow',team:hw?0:1,h,a});i++;}}}
  rec.h=h;rec.a=a;rec.fg=fg;rec.x=x;rec.anyH=0;rec.anyA=0;rec.fs=-1;
  if(ev)ev.log.push({i:Math.max(0,i-1),c:'Final'+(x===1?' (OT)':x===2?' (SO)':''),k:'ft',h,a});}
function soRounds(R,hw){ // plausible shootout rounds ending with the chosen winner (rejection sampling, display only)
  for(let tries=0;tries<500;tries++){const out=[];let sh=0,sa=0;
    for(let k=0;k<20;k++){const x=R()<.32?1:0,y=R()<.32?1:0;out.push([x,y]);sh+=x;sa+=y;
      if(k<2){const left=2-k;if(sh>sa+left||sa>sh+left)break;}else if(sh!==sa)break;}
    if(sh!==sa&&(sh>sa)===hw)return out;}
  return [[hw?1:0,hw?0:1]];}
function simNBA(P,R,rec,ev){
  const eH=P.g*Math.exp(P.x),eA=P.g*Math.exp(-P.x),C=NBAC;
  const pace=clamp(Math.round(P.pace+C.PSD*nrand(R)),80,120);let h=0,a=0,off=R()<.5?0:1,i=0,x=0;
  function poss(team,clk){const lead=team?a-h:h-a;const e=(team?eA:eH)*(1-C.REV*clamp(lead,-C.CAP,C.CAP)/C.CAP),k=e/C.BASE,u=R();
    const pts=u<C.P3*k?3:u<(C.P3+C.P2)*k?2:u<(C.P3+C.P2+C.P1)*k?1:0;
    if(team)a+=pts;else h+=pts;
    if(ev){ev.steps.push({c:clk,h,a});if(pts)ev.log.push({i,c:clk,k:'pts',team,pts,h,a});}i++;}
  const fmt=s=>Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0');
  for(let qn=0;qn<4;qn++){const nq=Math.floor(pace/4)+(qn<pace%4?1:0),tot=2*nq;
    for(let j=0;j<tot;j++){poss(off,ev?'Q'+(qn+1)+' '+fmt(720*(1-(j+1)/tot)):'');off^=1;}
    if(qn===1){rec.hh=h;rec.ha=a;}if(ev)ev.log.push({i:i-1,c:'End Q'+(qn+1),k:'per',h,a});}
  let ot=0;while(h===a&&ot<8){ot++;x=1;const n=Math.max(8,Math.round(pace*5/48)),tot=2*n;if(ev)ev.log.push({i,c:'OT'+(ot>1?ot:''),k:'ot',h,a});
    for(let j=0;j<tot;j++){poss(off,ev?'OT'+(ot>1?ot:'')+' '+fmt(300*(1-(j+1)/tot)):'');off^=1;}}
  if(h===a){if(R()<.5)h++;else a++;} // 8 overtimes level: a coin flip (never happens in practice)
  rec.h=h;rec.a=a;rec.x=x;rec.fg=0;rec.anyH=0;rec.anyA=0;rec.fs=-1;
  if(ev)ev.log.push({i:Math.max(0,i-1),c:'Final'+(x?' (OT)':''),k:'ft',h,a});}
function simFB(P,R,rec,ev){
  const C=FBC[P.sport]||FBC.nfl,xg=P.x+(C.SIG?C.SIG*nrand(R):0),aH=P.g*Math.exp(xg),aA=P.g*Math.exp(-xg),wxTD=P.wx?.8:1,wxFG=P.wx?.97:1;
  let h=0,a=0,i=0,x=0;const rcv=R()<.5?0:1;
  function nDrives(){let u=R();for(const [n,p] of C.DR){u-=p;if(u<0)return n;}return C.DR[C.DR.length-1][0];}
  function score(team,pts){if(team)a+=pts;else h+=pts;}
  function drive(team,half,idx,nd,clk,ot){
    const diff=team?a-h:h-a,late=half===1&&idx>=nd-4,last=idx===nd-1,fin=half===1&&last;let s=team?aA:aH;
    if(fin&&diff>0&&!ot){if(ev){ev.steps.push({c:clk,h,a});ev.log.push({i,c:clk,k:'kneel',team,h,a});}i++;return 0;}
    let pTD=Math.min(.62,C.TD*s*wxTD*(ot?C.OTTD:1)),pFG=Math.min(.42,C.FG*Math.sqrt(s)*wxFG);
    if(C.REV&&!ot){const f=1-C.REV*clamp(diff,-C.RCAP,C.RCAP)/C.RCAP;pTD*=f;pFG*=f;}
    if(last&&!ot){pTD*=.55;pFG*=1.15;}
    if(!ot&&half===1&&idx>=nd-C.KL&&diff>=-3&&diff<=0){pFG*=C.KFG;pTD*=C.KTD;}
    if(ot&&C.OTFG!==1)pFG*=C.OTFG;
    if(fin&&diff<=-4&&diff>=-8){pTD+=pFG*.35;pFG=0;}
    if(pTD+pFG>.9){const k=.9/(pTD+pFG);pTD*=k;pFG*=k;}
    const u=R();let kind='none',pts=0;
    if(u<pTD){kind='td';score(team,6);const d2=diff+6;
      if(late&&GO2.has(d2)){if(R()<C.TWO){score(team,2);kind='td2';}else kind='td2x';}
      else if(R()<C.XP){score(team,1);kind='td1';}else kind='td0';}
    else if(u<pTD+pFG){kind='fg';score(team,3);}
    else if(u<pTD+pFG+C.SAF){kind='saf';score(team^1,2);}
    else if(u<pTD+pFG+C.SAF+C.DTD){kind='dtd';score(team^1,7);}
    else kind=R()<.62?'punt':R()<.75?'to':'downs';
    if(ev){ev.steps.push({c:clk,h,a});ev.log.push({i,c:clk,k:'drive',kind,team,h,a});}i++;
    return kind;}
  const qclk=(half,idx,nd)=>{const f=(idx+1)/nd,q=half*2+(f<=.5?1:2),s=Math.round(900*(1-(f<=.5?f*2:(f-.5)*2)));return 'Q'+q+' '+Math.floor(s/60)+':'+String(s%60).padStart(2,'0');};
  for(let half=0;half<2;half++){const nd=nDrives();let team=half?rcv^1:rcv;
    for(let d=0;d<nd;d++){drive(team,half,d,nd,ev?qclk(half,d,nd):'',false);team^=1;}
    if(!half){rec.hh=h;rec.ha=a;if(ev)ev.log.push({i:i-1,c:'Half',k:'ht',h,a});}}
  if(h===a){x=1;if(ev)ev.log.push({i,c:'OT',k:'ot',h,a});
    if(P.sport==='ncaaf'){for(let rd=1;rd<=12&&h===a;rd++){for(let t=0;t<2;t++){const s=t?aA:aH,u=R();
        if(rd>=3){if(u<.45)score(t,2);}else if(u<Math.min(.7,.45*s))score(t,R()<C.XP?7:6);else if(u<Math.min(.7,.45*s)+.3)score(t,3);
        if(ev){ev.steps.push({c:'OT'+rd,h,a});ev.log.push({i,c:'OT'+rd,k:'otp',team:t,h,a});}i++;}}
      if(h===a){if(R()<.5)h+=2;else a+=2;}}
    else {let team=R()<.5?0:1;drive(team,1,0,9,'OT',true);drive(team^1,1,0,9,'OT',true);
      for(let k=0;k<2&&h===a;k++){team^=1;drive(team,1,0,9,'OT',true);}}}
  rec.h=h;rec.a=a;rec.x=x;rec.fg=0;rec.anyH=0;rec.anyA=0;rec.fs=-1;
  if(ev)ev.log.push({i:Math.max(0,i-1),c:'Final'+(x?' (OT)':''),k:'ft',h,a});}
function simOne(P,R,rec,ev,gm){const s=P.sport;if(s==='soccer')return simSoccer(P,R,rec,ev,gm);if(s==='nhl')return simNHL(P,R,rec,ev,gm);if(s==='nba')return simNBA(P,R,rec,ev);return simFB(P,R,rec,ev);}

/* margin-sport calibration: seeded pilot runs (common random numbers) adjust overall strength g (-> mean total) and
   home split x (-> home-win chance, secant steps) until both match the engine. */
function* marginStatsGen(P,n,seed,chunk){const R=rng(seed),rec={};let hw=0,tot=0,m1=0,m2=0;
  for(let k=0;k<n;k++){simOne(P,R,rec);const d=rec.h-rec.a;if(d>0)hw++;tot+=rec.h+rec.a;m1+=d;m2+=d*d;if(chunk&&(k+1)%chunk===0)yield k;}
  const mm=m1/n;return {ph:hw/n,tot:tot/n,mm,sdm:Math.sqrt(Math.max(1,m2/n-mm*mm))};}
function marginStats(P,n,seed){return drain(marginStatsGen(P,n,seed,0));}
function* calibMarginGen(sport,tg,seed,n){
  const T=tg.T||50,ph=clamp(tg.ph,.003,.997);
  const P={sport,g:sport==='nba'?T/2/NBAC.PACE:1,x:(tg.mu||0)/T,pace:NBAC.PACE,wx:0};
  if(sport!=='nba')P.g=T/(sport==='nfl'?45.5:56);
  let prev=null,st=null;
  for(let it=0;it<7;it++){st=yield* marginStatsGen(P,n,seed,2000);
    const eT=T/st.tot;P.g*=Math.pow(eT,sport==='nba'?1:1.15);
    let slope=null;if(prev&&Math.abs(P.x-prev.x)>1e-7&&Math.abs(st.ph-prev.ph)>1e-5)slope=(st.ph-prev.ph)/(P.x-prev.x);
    const an=Math.exp(-.5*Math.pow(invNorm(clamp(st.ph,.005,.995)),2))/2.5066*st.tot/st.sdm;
    if(!(slope>an*.25&&slope<an*4))slope=an;
    const cur={x:P.x,ph:st.ph};P.x+=clamp((ph-st.ph)/slope,-.3,.3);prev=cur;
    if(Math.abs(st.ph-ph)<.0015&&Math.abs(eT-1)<.002)break;}
  return {g:P.g,x:P.x,fitPh:st.ph,fitT:st.tot,fitSdm:st.sdm};}

/* ---------------- jobs (generators: yield after each chunk; the caller decides the chunk budget) ---------------- */
// 'run': calibrate (unless params given) then simulate N games, recording per-sim arrays + checkpoints for convergence
function* runJob(msg,ctl){
  const spec=msg.spec,N=msg.N||N_SIMS,sp=spec.sport;let base=msg.base;
  if(!base){const g=calibGen(spec,msg.pilot);let r;while(!(r=g.next()).done)yield {phase:'calib',done:0};base=r.value;}
  const P=applyWI(spec,base),R=rng(msg.seed>>>0),rec={};
  const ext=msg.ext&&sp==='soccer'?extGrid(applyWI({sport:sp,tg:spec.tg,wi:{},scorers:[[],[]]},base)):null;
  const H=new Int16Array(N),A=new Int16Array(N),HH=new Int16Array(N),HA=new Int16Array(N),X=new Int8Array(N),FG=new Int8Array(N);
  const nsH=P.sc?P.sc[0].length:0,nsA=P.sc?P.sc[1].length:0,anyC=new Int32Array(nsH+nsA),firstC=new Int32Array(nsH+nsA+3),gm=new Int32Array(40);
  const line=spec.line||2.5,cpEvery=msg.cpEvery||1000,cps=[];let hw=0,dr=0,aw=0,ov=0,k=0;const t0=Date.now();
  const exF=(msg.ex||[]).map(c=>exFn(c,line)),nex=exF.length,exC=new Int32Array(nex);
  while(k<N){const end=Math.min(N,k+(ctl.budget||2000));
    for(;k<end;k++){simOne(P,R,rec,null,gm);const h=rec.h,a=rec.a;H[k]=h;A[k]=a;HH[k]=rec.hh;HA[k]=rec.ha;X[k]=rec.x;FG[k]=rec.fg;
      if(h>a)hw++;else if(h===a)dr++;else aw++;if(h+a>line)ov++;
      for(let j=0;j<nex;j++)if(exF[j](rec))exC[j]++;
      if(nsH||nsA){for(let j=0;j<nsH;j++)if(rec.anyH>>j&1)anyC[j]++;for(let j=0;j<nsA;j++)if(rec.anyA>>j&1)anyC[nsH+j]++;
        const f=rec.fs;if(f===-1)firstC[nsH+nsA]++;else if(f===-2)firstC[nsH+nsA+1]++;else if(f>=0)firstC[f<32?f:nsH+(f-32)]++;if(!rec.fg)firstC[nsH+nsA+2]++;}
      if((k+1)%cpEvery===0)cps.push([k+1,hw,dr,aw,ov]);}
    yield {phase:'run',done:k,hw,dr,aw,ov,cps:cps.splice(0),ms:Date.now()-t0};}
  return {N,H,A,HH,HA,X,FG,anyC,firstC,gm,exC:nex?exC:null,ext,P:{...P,sc:null,cum:null},base,hw,dr,aw,ov,ms:Date.now()-t0,transfer:[H.buffer,A.buffer,HH.buffer,HA.buffer,X.buffer,FG.buffer]};}
/* 'parlay': every game in the slip is simulated once per iteration so same-game legs are correlated.
   legs: {gi (game index), t:'tab', w, tab:Uint8Array over (h,a) | t:'sim', code | t:'bern', p}
         | {gi, t:'cond', tab:Float32Array P(all custom legs hit | h,a)} */
function* parlayJob(msg,ctl){
  const games=msg.games,N=msg.N||N_SIMS,R=rng(msg.seed>>>0),Ps=[],recs=[];
  for(const gs of games){let base=gs.base;
    if(!base){const g=calibGen(gs.spec,msg.pilot);let r;while(!(r=g.next()).done)yield {phase:'calib'};base=r.value;}
    gs.base=base;Ps.push(applyWI(gs.spec,base));recs.push({});}
  const legs=msg.legs,nl=legs.length,legHit=new Int32Array(nl);let hits=0,k=0;const cps=[],t0=Date.now();
  const bases=games.map(g=>g.base);
  while(k<N){const end=Math.min(N,k+(ctl.budget||2000));
    for(;k<end;k++){for(let j=0;j<Ps.length;j++)simOne(Ps[j],R,recs[j]);
      let all=1;
      for(let j=0;j<nl;j++){const L=legs[j],r=recs[L.gi];let ok=0;
        if(L.t==='tab'){const W=L.w,hh=Math.min(r.h,W-1),aa=Math.min(r.a,W-1);ok=L.tab[hh*W+aa];}
        else if(L.t==='sim')ok=simLeg(L.code,r)?1:0;
        else if(L.t==='scorer')ok=((L.team?r.anyA:r.anyH)>>L.bit)&1;
        else if(L.t==='first')ok=r.fs===L.team*32+L.bit?1:0;
        else if(L.t==='bern')ok=R()<L.p?1:0;
        else if(L.t==='cond'){const W=L.w,hh=Math.min(r.h,W-1),aa=Math.min(r.a,W-1);ok=R()<L.tab[hh*W+aa]?1:0;}
        if(ok)legHit[j]++;else all=0;}
      hits+=all;if((k+1)%1000===0)cps.push([k+1,hits]);}
    yield {phase:'run',done:k,hits,cps:cps.splice(0),ms:Date.now()-t0};}
  return {N,hits,legHit,bases,ms:Date.now()-t0};}
function simLeg(code,r){const hc=r.hh>r.ha?0:r.hh===r.ha?1:2,ft=r.h>r.a?0:r.h===r.a?1:2,ht=r.hh+r.ha;
  switch(code){case 'HTH':return hc===0;case 'HTD':return hc===1;case 'HTA':return hc===2;
    case 'HTO0.5':return ht>=1;case 'HTO1.5':return ht>=2;case 'FGH':return r.fg===1;case 'FGA':return r.fg===2;
    case 'GBH':return ht>=1&&r.h+r.a-ht>=1;}
  if(code.startsWith('HTFT-')){const m={H:0,D:1,A:2};return hc===m[code[5]]&&ft===m[code[6]];}
  return false;}
// 'bank': flat-stake bankroll paths. Ruin = bankroll below one stake before the last bet.
function* bankJob(msg,ctl){
  const N=msg.N||N_SIMS,p=msg.p,dec=msg.dec,S=msg.stake,B0=msg.bank,nb=msg.bets,R=rng(msg.seed>>>0),end=new Float64Array(N);let ruin=0,k=0;const t0=Date.now();
  const per=Math.max(50,Math.floor(2e6/Math.max(1,nb)));
  while(k<N){const e=Math.min(N,k+Math.min(per,ctl.budget?ctl.budget*4:per));
    for(;k<e;k++){let b=B0,j=0;for(;j<nb;j++){if(b<S-1e-9){ruin++;break;}b+=R()<p?S*(dec-1):-S;}end[k]=b;}
    yield {phase:'run',done:k,ms:Date.now()-t0};}
  return {N,end,ruin,transfer:[end.buffer]};}
function* calibJob(msg){const g=calibGen(msg.spec,msg.pilot);let r;while(!(r=g.next()).done)yield {phase:'calib'};return {base:r.value};}
/* extra (non-engine) markets counted per simulated game. r = {h,a,hh,ha,x,fg}; L = main total line (1st-half line = L/2). */
function exFn(c,L){const L1=Math.floor(L/2)+.5,res=(x,y)=>x>y?0:x===y?1:2,M={H:0,D:1,A:2};
  switch(c){
    case 'HTH':case 'P1H':case '1HH':return r=>r.hh>r.ha;case 'HTD':case 'P1D':case '1HD':return r=>r.hh===r.ha;case 'HTA':case 'P1A':case '1HA':return r=>r.ha>r.hh;
    case 'HTO0.5':return r=>r.hh+r.ha>=1;case 'HTO1.5':case 'P1O1.5':return r=>r.hh+r.ha>=2;case '1HO':return r=>r.hh+r.ha>L1;
    case 'FGH':return r=>r.fg===1;case 'FGA':return r=>r.fg===2;case 'FGN':return r=>r.fg===0;
    case 'RH':return r=>r.x===0&&r.h>r.a;case 'RA':return r=>r.x===0&&r.a>r.h;case 'RD':case 'OT':return r=>r.x>0;case 'SO':return r=>r.x===2;
    case 'K3':return r=>Math.abs(r.h-r.a)===3;case 'K7':return r=>Math.abs(r.h-r.a)===7;case 'K10':return r=>Math.abs(r.h-r.a)===10;case 'TIE':return r=>r.h===r.a;}
  if(/^HTFT-[HDA]{2}$/.test(c)){const a=M[c[5]],b=M[c[6]];return r=>res(r.hh,r.ha)===a&&res(r.h,r.a)===b;}
  return ()=>false;}
function makeJob(msg,ctl){return msg.cmd==='calib'?calibJob(msg):msg.cmd==='parlay'?parlayJob(msg,ctl):msg.cmd==='bank'?bankJob(msg,ctl):runJob(msg,ctl);}
return {rng,hashStr,nrand,Phi,invNorm,GC,SOC,NHLC,NBAC,FBC,HA,N_SIMS,goalsDP,dpSummary,calibGoals,calibGoalsGen,calibMarginGen,calibGen,marginStats,applyWI,simOne,simLeg,exFn,extGrid,makeJob,soccerSeq};
}
/* ============================== end SIMCORE ============================== */

const CORE=SIMCORE();
function workerMain(){
  let ctl={budget:2500};
  self.onmessage=e=>{const msg=e.data;if(!msg||!msg.cmd)return;
    try{const it=CORE.makeJob(msg,ctl);let r,last=0;
      while(!(r=it.next()).done){const v=r.value,now=Date.now();if(v.phase!=='run'&&now-last<80)continue;last=now;self.postMessage({id:msg.id,type:'progress',v});}
      const res=r.value,tr=res.transfer||[];delete res.transfer;self.postMessage({id:msg.id,type:'done',res},tr);}
    catch(err){self.postMessage({id:msg.id,type:'error',msg:String(err&&err.stack||err)});}};
}
const WORKER_SRC='"use strict";const CORE=('+SIMCORE.toString()+')();('+workerMain.toString()+')();';

/* ============================== main-thread module ============================== */
const NSIM=SB.NSIM||100000;
const MODELV='m2'; // bump when the play model or calibration changes (invalidates stored calibrations)
const esc=SB.esc,store=SB.store;
const fmtN=n=>Math.round(n).toLocaleString('en-US');
const pc1=p=>(p*100).toFixed(1)+'%';
const pcS=p=>p>=.995||p<.005?(p*100).toFixed(2)+'%':(p*100).toFixed(1)+'%';
const ci95=(p,n)=>1.96*Math.sqrt(Math.max(p*(1-p),1e-12)/n);
const SPORTICON={soccer:'⚽',nba:'🏀',nfl:'🏈',nhl:'🏒',ncaaf:'🎓'};
const SPORTNAME={soccer:'Soccer',nba:'NBA',nfl:'NFL',nhl:'NHL',ncaaf:'College FB'};
const GOALS=sp=>sp==='soccer'||sp==='nhl';
const UNIT=sp=>GOALS(sp)?'goals':'points';

/* ---------- module state (survives re-renders; DATA reloads are handled by looking games up by id) ---------- */
const S={mode:store.get('sim.mode','game'),gid:store.get('sim.gid',null),wi:{},pickOpen:false,pq:'',wiOpen:false,plegs:null,
  bank:{price:'',stake:10,bets:100,bank:store.get('bankroll',100),src:'sim',custom:''}};
let lastParams=null;
const RUN={active:false,kind:null,gid:null,stage:0,stages:1,label:'',phase:'',done:0,N:NSIM,rate:0,cps:[],t0:0,err:null,cancelled:false};
const CACHE=new Map();    // results per game + what-if + data stamp (aggregates only)
// calibrated play-model parameters per game + engine targets. Calibration is deterministic from the targets, so it is kept in
// sessionStorage (keyed by model version + targets) and a reload doesn't pay for it again.
const BASE=(()=>{const m=new Map(),K='sb.simBase.'+MODELV;let t=null;
  try{const o=JSON.parse(sessionStorage.getItem(K)||'{}');for(const k of Object.keys(o))m.set(k,o[k]);}catch(e){}
  const set=m.set.bind(m);
  m.set=(k,v)=>{set(k,v);if(!t)t=setTimeout(()=>{t=null;try{const o={};for(const [a,b] of [...m].slice(-150))o[a]=b;sessionStorage.setItem(K,JSON.stringify(o));}catch(e){}},400);return m;};
  return m;})();
let PAR=null,BANK=null;   // last parlay / bankroll results
const DBG={maxGap:0,clicksDuringRun:0,runs:0,worker:null,local:0};
window.__sim={CORE,S,RUN,CACHE,BASE,DBG,get PAR(){return PAR},get BANK(){return BANK},get W(){return W},parAgree:R=>parAgree(R),liveCalc:(g,b,L)=>liveCalc(g,b,L),tsig:g=>tsig(g)};

/* ---------- engine bridge ---------- */
function gamesList(){return (SB.DATA.games||[]).filter(g=>SB.priced(g)&&SB.fit(g)).sort((a,b)=>SB.startMs(a)-SB.startMs(b));}
const BIG=/Champions League|Premier League|La Liga|^NBA$|^NFL$/;
function defaultGame(){const L=gamesList();if(!L.length)return null;const soon=SB.startMs(L[0])+36*3600e3;
  return L.find(g=>BIG.test(g.comp)&&SB.startMs(g)<=soon)||L.find(g=>BIG.test(g.comp))||L[0];}
function curGame(){let g=S.gid&&SB.gameById(S.gid);if(!g||!SB.priced(g)||!SB.fit(g)){g=defaultGame();S.gid=g?g.id:null;}return g;}
function normName(s){return String(s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/\b(fc|cf|afc|sc|ac|ssc|as|club|de|calcio)\b/g,'').replace(/[^a-z0-9]+/g,' ').trim();}
let SCIDX=null,SCSRC=null;
function scorerTeams(){const sc=SB.DATA.scorers;if(sc===SCSRC)return SCIDX;SCSRC=sc;SCIDX=[];
  const seen=new Set(),walk=(o,d)=>{if(!o||typeof o!=='object'||d>4||seen.has(o))return;seen.add(o);
    if(Array.isArray(o.players)&&(o.team||o.name||o.abbr)){SCIDX.push(o);return;}
    for(const v of Array.isArray(o)?o:Object.values(o))walk(v,d+1);};
  walk(sc,0);return SCIDX;}
function teamScorers(team,comp){const T=scorerTeams();if(!T||!T.length)return [];
  const n=normName(team.name);let t=T.find(x=>normName(x.team||x.name)===n);
  if(!t)t=T.find(x=>x.abbr===team.abbr&&(!x.comp||[].concat(x.comp).includes(comp)));
  if(!t)t=T.find(x=>{const m=normName(x.team||x.name);return m&&n&&(m.includes(n)||n.includes(m))&&m.length>3&&n.length>3;});
  if(!t)return [];
  const OUT=/out|injur|susp|unavail|left|loan/i;
  const ps=(t.players||[]).filter(p=>p&&p.name&&!OUT.test(p.status||'')&&(+p.goals>0||+p.share>0));
  if(!ps.length)return [];
  const sum=ps.reduce((s,p)=>s+(+p.goals||0),0);
  const tg=+t.teamGoals>0?Math.max(+t.teamGoals,sum):Math.max(sum/.65,sum+3);
  let L=ps.map(p=>({id:String(p.id||normName(p.name)),name:String(p.name),share:+p.share>0?+p.share:(+p.goals||0)/tg}))
    .map(p=>({...p,share:Math.min(.45,p.share)})).sort((a,b)=>b.share-a.share).slice(0,12);
  const tot=L.reduce((s,p)=>s+p.share,0);if(tot>.85)L=L.map(p=>({...p,share:p.share*.85/tot}));
  return L;}
function targetsOf(g){const m=SB.fit(g);if(!m)return null;
  if(m.kind==='goals'){const M=SB.scoreMatrix(g);if(!M)return null;let D=0,H=0,A=0;const n=M.n;
    for(let h=0;h<n;h++)for(let a=0;a<n;a++){const p=M.P[h*n+a];if(h>a)H+=p;else if(h===a)D+=p;else A+=p;}
    return {eh:M.eh,ea:M.ea,H,D,A,q:M.otHome!=null?M.otHome:null};}
  return {ph:SB.p1(g,'H'),T:m.T,mu:m.mu,sd:m.sd,tsd:m.tsd};}
function mainLine(g){if(g.sport==='soccer')return 2.5;if(g.sport==='nhl')return 5.5;const m=SB.fit(g);return Math.floor(m.T)+.5;}
function specFor(g,wi){const tg=targetsOf(g);return {gid:g.id,sport:g.sport,tg,wi:wi||{},line:mainLine(g),scorers:g.sport==='soccer'?soccerScorers(g,tg):null};}
// goal shares per team. When the soccer module prices anytime-scorer legs ("G:<id>"), each share is set so the sim's
// anytime chance matches it (P = 1 - exp(-share * team expected goals)); otherwise shares come from season goals.
function soccerScorers(g,tg){return [[g.home,tg&&tg.eh],[g.away,tg&&tg.ea]].map(([team,lam])=>{
  let L=teamScorers(team,g.comp);
  if(lam>0)L=L.map(p=>{let q=0;try{q=SB.p1(g,'G:'+p.id);}catch(e){}return q>0&&q<.99?{...p,share:Math.min(.6,-Math.log(1-q)/lam),src:'engine'}:p;});
  const tot=L.reduce((s,p)=>s+p.share,0);if(tot>.9)L=L.map(p=>({...p,share:p.share*.9/tot}));return L;});}
const tsig=g=>g.id+'|'+JSON.stringify(targetsOf(g));
function wiKey(wi){const o={};for(const k of Object.keys(wi||{}).sort()){const v=wi[k];if(v===''||v==null||v===false||v===-1)continue;if(k==='ha'&&+v===1)continue;if((k==='str'||k==='tempo')&&!+v)continue;if(k==='redMin'&&!(wi.red===0||wi.red===1))continue;o[k]=v;}return JSON.stringify(o)==='{}'?'':JSON.stringify(o);}
const ckey=(g,wk)=>tsig(g)+'|'+(SB.DATA.updated||'')+'|'+wk+'|'+JSON.stringify(specFor(g).scorers||'');

/* ---------- job runner: inline-Blob Web Worker, fallback = time-sliced rAF loop on the main thread ---------- */
const runner={w:null,ok:typeof Worker!=='undefined'&&typeof Blob!=='undefined'&&typeof URL!=='undefined',cur:null,seq:0,
  worker(){if(this.w)return this.w;try{const u=URL.createObjectURL(new Blob([WORKER_SRC],{type:'text/javascript'}));this.w=new Worker(u);
      this.w.onmessage=e=>this.onmsg(e.data);this.w.onerror=e=>{e.preventDefault&&e.preventDefault();this.fail('worker error');};DBG.worker=true;}
    catch(e){this.ok=false;this.w=null;DBG.worker=false;}return this.w;},
  start(msg,h){this.cancel();const id=++this.seq;msg={...msg,id};const job={id,msg,h,last:performance.now(),dead:false};this.cur=job;
    if(this.ok&&this.worker()){job.mode='worker';this.w.postMessage(msg);
      job.wd=setInterval(()=>{if(this.cur!==job||job.mode!=='worker')return clearInterval(job.wd);if(performance.now()-job.last>5000){clearInterval(job.wd);console.warn('sim.js: worker silent, using the main thread');this.ok=false;this.kill();this.local(job);}},1000);}
    else this.local(job);
    return id;},
  onmsg(d){const job=this.cur;if(!job||!d||d.id!==job.id)return;job.last=performance.now();
    if(d.type==='progress')job.h.progress&&job.h.progress(d.v);
    else if(d.type==='done'){clearInterval(job.wd);this.cur=null;job.h.done(d.res);}
    else if(d.type==='error'){clearInterval(job.wd);this.cur=null;console.error('sim worker:',d.msg);job.h.error&&job.h.error(d.msg);}},
  fail(why){const job=this.cur;if(job)clearInterval(job.wd);this.kill();this.ok=false;DBG.worker=false;if(job&&!job.dead){console.warn('sim.js: '+why+', using the main thread');this.local(job);}},
  kill(){if(this.w){try{this.w.terminate();}catch(e){}this.w=null;}},
  local(job){clearInterval(job.wd);job.mode='local';DBG.local++;const ctl={budget:400};let it;
    try{it=CORE.makeJob(job.msg.cmd==='run'||job.msg.cmd==='calib'?{...job.msg,pilot:8000}:job.msg,ctl);}catch(e){job.h.error&&job.h.error(String(e));return;}
    const frame=()=>{if(job.dead||this.cur!==job)return;const t0=performance.now();let r,v=null;
      try{do{r=it.next();if(!r.done)v=r.value;}while(!r.done&&performance.now()-t0<9);}catch(e){this.cur=null;console.error(e);job.h.error&&job.h.error(String(e));return;}
      if(r.done){this.cur=null;job.h.done(r.value);return;}
      if(v)job.h.progress&&job.h.progress(v);requestAnimationFrame(frame);};
    requestAnimationFrame(frame);},
  cancel(){const job=this.cur;if(!job)return false;job.dead=true;clearInterval(job.wd);this.cur=null;if(job.mode==='worker')this.kill();return true;}};
// frame-gap monitor while a run is active (used by the tests to prove the UI stays responsive)
function gapMon(){let last=performance.now();const f=()=>{const n=performance.now();if(RUN.active)DBG.maxGap=Math.max(DBG.maxGap,n-last);last=n;if(RUN.active)requestAnimationFrame(f);};requestAnimationFrame(f);}

/* ---------- running a game simulation (baseline first when a what-if needs a comparison) ---------- */
function startGameRun(){const g=curGame();if(!g)return;if(RUN.active)return;
  const wk=wiKey(S.wi),queue=[];
  if(wk&&!CACHE.has(ckey(g,'')))queue.push({wi:{},wk:'',label:'Baseline'});
  queue.push({wi:{...S.wi},wk,label:wk?'What-if':'Baseline'});
  Object.assign(RUN,{active:true,kind:'game',gid:g.id,wi:{...S.wi},stage:0,stages:queue.length,cps:[],done:0,rate:0,err:null,cancelled:false,phase:'Starting',t0:performance.now(),sy:window.scrollY});
  DBG.maxGap=0;DBG.runs++;gapMon();
  const next=()=>{const it=queue[RUN.stage];const gg=SB.gameById(RUN.gid);if(!gg){finishRun('This game is no longer available.');return;}
    const spec=specFor(gg,it.wi),bk=tsig(gg),base=BASE.get(bk)||null;RUN.label=it.label;RUN.cps=[];RUN.done=0;RUN.phase=base?'Simulating':'Calibrating to the engine';RUN.ts=performance.now();
    paintRun();
    runner.start({cmd:'run',spec,base,N:NSIM,seed:SB.hashStr(gg.id+'|run'),cpEvery:1000,ex:extrasFor(gg).map(x=>x.code),ext:gg.sport==='soccer'&&!EXT.has(bk)},{
      progress(v){if(v.phase==='calib'){RUN.phase='Calibrating to the engine';}else{RUN.phase='Simulating';RUN.done=v.done;
          if(v.cps&&v.cps.length)RUN.cps.push(...v.cps);RUN.rate=v.ms>0?v.done/(v.ms/1000):0;}
        schedPaint();},
      done(res){const g2=SB.gameById(RUN.gid);if(!g2){finishRun('This game is no longer available.');return;}
        BASE.set(bk,res.base);if(res.N!==NSIM){finishRun('Run ended early.');return;}
        if(res.ext&&!EXT.has(bk))EXT.set(bk,{E:res.ext,GC:CORE.GC,G2:CORE.GC*CORE.GC,marg:{}}); // SIM-leg grid, built in the worker
        RUN.done=res.N;RUN.rate=res.ms>0?res.N/(res.ms/1000):RUN.rate;
        const ta=performance.now();CACHE.set(ckey(g2,it.wk),aggregate(g2,res,spec,RUN.cps.slice()));trimCache();DBG.aggMs=performance.now()-ta;
        RUN.stage++;if(RUN.stage<RUN.stages)next();else finishRun(null);},
      error(m){finishRun('The simulation failed: '+m);}});};
  next();}
function finishRun(err){RUN.active=false;RUN.err=err;const t=performance.now();rerender();DBG.renderMs=performance.now()-t;if(!err)revealSummary();}
// after a run on a phone: bring the win/draw/loss summary into view, unless the user scrolled during the run
function revealSummary(){const el=document.getElementById('smSum');if(!el||S.mode!=='game'||RUN.gid!==S.gid)return;
  if(Math.abs(window.scrollY-(RUN.sy||0))>4)return;const r=el.getBoundingClientRect(),bar=window.innerHeight-90;
  if(r.top>8&&r.top+Math.min(r.height,180)<=bar)return;try{el.scrollIntoView({block:'nearest',behavior:'smooth'});}catch(e){}}
function cancelRun(){if(!RUN.active)return;DBG.clicksDuringRun++;runner.cancel();const k=RUN.kind;RUN.active=false;RUN.cancelled=k!=='calib';RUN.err=null;if(k==='calib')W.loading=false;rerender();SB.toast('Simulation cancelled');}
function trimCache(){while(CACHE.size>16)CACHE.delete(CACHE.keys().next().value);}

/* ---------- aggregation (main thread, once per finished run) ---------- */
function extrasFor(g){const H=g.home.abbr,A=g.away.abbr,sp=g.sport,X=[];let line=2.5;try{line=mainLine(g);}catch(e){}
  const add=(group,code,label,fn,simLeg)=>X.push({group,code,label,fn:CORE.exFn(code,line),simLeg:!!simLeg});
  if(sp==='soccer'){
    add('Half-time','HTH',`${H} lead at half-time`,(r)=>r.hh>r.ha,1);add('Half-time','HTD','Level at half-time',r=>r.hh===r.ha,1);add('Half-time','HTA',`${A} lead at half-time`,r=>r.ha>r.hh,1);
    add('Half-time','HTO0.5','1+ first-half goals',r=>r.hh+r.ha>=1,1);add('Half-time','HTO1.5','2+ first-half goals',r=>r.hh+r.ha>=2,1);
    const nm={H,D:'Draw',A},res=(x,y)=>x>y?'H':x===y?'D':'A';
    for(const a of 'HDA')for(const b of 'HDA')add('Half-time / full-time',`HTFT-${a}${b}`,`${nm[a]} / ${nm[b]}`,r=>res(r.hh,r.ha)===a&&res(r.h,r.a)===b,1);
    add('First goal','FGH',`${H} score first`,r=>r.fg===1,1);add('First goal','FGA',`${A} score first`,r=>r.fg===2,1);add('First goal','FGN','No goals',r=>r.fg===0);
  } else if(sp==='nhl'){
    add('Regulation (60 min)','RH',`${H} win in regulation`,r=>r.x===0&&r.h>r.a);add('Regulation (60 min)','RD','Tied after 60 min',r=>r.x>0);add('Regulation (60 min)','RA',`${A} win in regulation`,r=>r.x===0&&r.a>r.h);
    add('Overtime','OT','Goes to overtime',r=>r.x>0);add('Overtime','SO','Decided by shootout',r=>r.x===2);
    add('1st period','P1H',`${H} lead after 1st`,r=>r.hh>r.ha);add('1st period','P1D','Level after 1st',r=>r.hh===r.ha);add('1st period','P1A',`${A} lead after 1st`,r=>r.ha>r.hh);
    add('1st period','P1O1.5','Over 1.5 goals in the 1st',r=>r.hh+r.ha>1.5);
  } else {
    const L=Math.floor(line/2)+.5;
    add('1st half','1HH',`${H} lead at half`,r=>r.hh>r.ha);add('1st half','1HD','Tied at half',r=>r.hh===r.ha);add('1st half','1HA',`${A} lead at half`,r=>r.ha>r.hh);
    add('1st half','1HO',`1st half over ${L}`,r=>r.hh+r.ha>L);add('Overtime','OT','Goes to overtime',r=>r.x>0);
    if(sp!=='nba'){add('Key numbers','K3','Decided by exactly 3',r=>Math.abs(r.h-r.a)===3);add('Key numbers','K7','Decided by exactly 7',r=>Math.abs(r.h-r.a)===7);add('Key numbers','K10','Decided by exactly 10',r=>Math.abs(r.h-r.a)===10);}
    if(sp==='nfl')add('Overtime','TIE','Ends in a tie',r=>r.h===r.a);
  }
  return X;}
function aggregate(g,res,spec,cps){
  const N=res.N,H=res.H,A=res.A,sp=g.sport,goals=GOALS(sp);let sh=0,sa=0,big=false;
  const hist=new Int32Array(65536); // final-score histogram (scores < 256; a Map handles anything larger)
  for(let i=0;i<N;i++){const h=H[i],a=A[i];sh+=h;sa+=a;if(h<256&&a<256&&h>=0&&a>=0)hist[h*256+a]++;else big=true;}
  const cl=[];for(let k=0;k<65536;k++)if(hist[k])cl.push([k>>8,k&255,hist[k]]);
  if(big){const m=new Map();for(let i=0;i<N;i++){const h=H[i],a=A[i];if(!(h<256&&a<256&&h>=0&&a>=0)){const k=h*4096+a;m.set(k,(m.get(k)||0)+1);}}for(const [k,c] of m)cl.push([Math.floor(k/4096),k%4096,c]);}
  const mk=SB.marketsFor(g).map(m=>{let c=0;for(const [h,a,n] of cl)if(goals?m.f(h,a):m.f(h-a,h+a))c+=n;return {key:m.key,group:m.group,label:m.label,sim:c/N,model:SB.p1(g,m.key),cs:m.cs||null};});
  const r={};const ex=extrasFor(g).map((x,j)=>{let c=0;
    if(res.exC&&res.exC.length>j)c=res.exC[j]; // counted inside the worker run
    else for(let i=0;i<N;i++){r.h=H[i];r.a=A[i];r.hh=res.HH[i];r.ha=res.HA[i];r.x=res.X[i];r.fg=res.FG[i];if(x.fn(r))c++;}
    return {key:'SIM:'+x.code,code:x.code,group:x.group,label:x.label,sim:c/N,model:x.simLeg?simLegProb(g,x.code):null,simLeg:x.simLeg};});
  const sc=[];if(spec.scorers){const nh=spec.scorers[0].length,P=res.P;
    const list=[...spec.scorers[0].map((p,i)=>({...p,team:0,i})),...spec.scorers[1].map((p,i)=>({...p,team:1,i:nh+i}))];
    const outId=spec.wi&&spec.wi.out;const keep=list.filter(p=>p.id!==outId);
    // anyC/firstC indexes follow the (possibly star-out-filtered) per-team lists the worker used
    const used=[spec.scorers[0].filter(p=>p.id!==outId),spec.scorers[1].filter(p=>p.id!==outId)],uh=used[0].length;
    used[0].forEach((p,i)=>sc.push({id:p.id,name:p.name,team:0,any:res.anyC[i]/N,first:res.firstC[i]/N}));
    used[1].forEach((p,i)=>sc.push({id:p.id,name:p.name,team:1,any:res.anyC[uh+i]/N,first:res.firstC[uh+i]/N}));
    const nn=uh+used[1].length;sc.otherFirst=[res.firstC[nn]/N,res.firstC[nn+1]/N];void keep;void P;}
  const mh=new Map(),th=new Map();for(const [h,a,n] of cl){mh.set(h-a,(mh.get(h-a)||0)+n);th.set(h+a,(th.get(h+a)||0)+n);}
  let heat=null;if(goals){const n=6;heat={n,c:new Float64Array(n*n)};for(const [h,a,c] of cl)if(h<n&&a<n)heat.c[h*n+a]=c/N;}
  return {gid:g.id,sport:sp,N,ms:res.ms,wk:wiKey(spec.wi),wi:spec.wi,hw:res.hw/N,dr:res.dr/N,aw:res.aw/N,ov:res.ov/N,line:spec.line,avgH:sh/N,avgA:sa/N,
    mk,ex,sc,mh:[...mh],th:[...th],heat,gm:Array.from(res.gm||[]),cps,P:res.P,base:res.base,at:Date.now()};}

/* ---------- SIM leg type: half-time, HT/FT and first-goal markets for soccer, priced by an exact DP of the play model ---------- */
const EXT=new Map();
function extTable(g){if(!g||g.sport!=='soccer'||!SB.fit(g))return null;const k=tsig(g);if(EXT.has(k))return EXT.get(k);
  const tg=targetsOf(g);let base=BASE.get(k);if(!base){base=CORE.calibGoals('soccer',tg);BASE.set(k,base);}
  const E=CORE.extGrid(CORE.applyWI({sport:'soccer',tg,wi:{},scorers:[[],[]]},base)),GC=CORE.GC,G2=GC*GC;
  const T={E,GC,G2,marg:{}};EXT.set(k,T);if(EXT.size>40)EXT.delete(EXT.keys().next().value);return T;}
function extInd(code,x,h,a){const c=(x/3)|0,f=x%3,hc=(c/3)|0,ht=c%3;
  switch(code){case 'HTH':return hc===0;case 'HTD':return hc===1;case 'HTA':return hc===2;case 'HTO0.5':return ht>=1;case 'HTO1.5':return ht>=2;case 'FGH':return f===1;case 'FGA':return f===2;}
  if(/^HTFT-[HDA]{2}$/.test(code)){const m={H:0,D:1,A:2};const ft=h>a?0:h===a?1:2;return hc===m[code[5]]&&ft===m[code[6]];}return false;}
const SIMCODES=new Set(['HTH','HTD','HTA','HTO0.5','HTO1.5','FGH','FGA',...['HH','HD','HA','DH','DD','DA','AH','AD','AA'].map(x=>'HTFT-'+x)]);
function extCond(g,codes){const T=extTable(g);if(!T)return null;const {E,GC,G2}=T;
  const fn=(h,a)=>{if(h>=GC||a>=GC)return marg();let den=0,num=0;for(let x=0;x<30;x++){const m=E[x*G2+h*GC+a];if(!m)continue;den+=m;let ok=true;for(const c of codes)if(!extInd(c,x,h,a)){ok=false;break;}if(ok)num+=m;}
    return den>1e-13?num/den:marg();};
  let mg=null;const marg=()=>{if(mg!=null)return mg;let s=0;for(let x=0;x<30;x++)for(let h=0;h<GC;h++)for(let a=0;a<GC;a++){const m=E[x*G2+h*GC+a];if(!m)continue;let ok=true;for(const c of codes)if(!extInd(c,x,h,a)){ok=false;break;}if(ok)s+=m;}return mg=s;};
  return fn;}
function simLegProb(g,code){const f=extCond(g,[code]);if(!f)return 0;const O=SB.outcomes(g);if(!O)return 0;let s=0;for(let i=0;i<O.n;i++)s+=O.p[i]*f(O.h[i],O.a[i]);return Math.min(1,Math.max(0,s));}
function simLegLabel(code,g){const H=g?g.home.abbr:'Home',A=g?g.away.abbr:'Away';const x=extrasFor(g||{home:{abbr:H},away:{abbr:A},sport:'soccer'}).find(e=>e.code===code);
  return x?(x.group==='Half-time / full-time'?'HT/FT '+x.label:x.label):code;}
SB.registerLegType('SIM',{
  label(key,g){return simLegLabel(String(key).slice(4),g);},
  prob(g,key){const c=String(key).slice(4);return g&&g.sport==='soccer'&&SIMCODES.has(c)?simLegProb(g,c):0;},
  condMany(g,keys){const cs=keys.map(k=>String(k).slice(4));if(!g||g.sport!=='soccer'||!cs.every(c=>SIMCODES.has(c)))return ()=>0;return extCond(g,cs);},
  cond(g,key){const c=String(key).slice(4);if(!g||g.sport!=='soccer'||!SIMCODES.has(c))return ()=>0;return extCond(g,[c]);}
});

/* ---------- styles (existing theme tokens only; works in light + dark) ---------- */
function injectCSS(){if(document.getElementById('sim-css'))return;const st=document.createElement('style');st.id='sim-css';st.textContent=`
.sm{min-width:0}
.sm h2{margin-top:14px}
.sm .panel{min-width:0;overflow:hidden}
.sm-lead{font-size:13.5px;color:var(--mute);line-height:1.5;margin:-4px 2px 12px}
.sm-modes{margin:0 0 12px}
.sm-modes button{font-size:14px;padding:9px 2px;white-space:nowrap;min-width:0}
@media(max-width:400px){.sm-modes button{font-size:13px}}
.sm-pick{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px;cursor:pointer;color:var(--text);font:inherit;margin-bottom:12px;box-shadow:var(--shadow)}
.sm-pick .sm-pt{flex:1;min-width:0}
.sm-pick b{display:block;font-size:16px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sm-pick .sm-pt span{display:block;font-size:12.5px;color:var(--dim);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sm-pick i{font-style:normal;font-size:13px;font-weight:800;color:var(--blue);flex:none}
.sm-gl{max-height:360px;overflow-y:auto;margin-top:8px;border-top:1px solid var(--line);overscroll-behavior:contain}
.sm-gh{position:sticky;top:0;background:var(--card);font-size:12px;font-weight:800;color:var(--mute);text-transform:uppercase;letter-spacing:.4px;padding:9px 2px 5px;z-index:1}
.sm-gi{display:flex;align-items:center;gap:8px;width:100%;border:0;border-top:1px solid var(--line);background:none;color:var(--text);font:inherit;text-align:left;padding:9px 2px;cursor:pointer;min-width:0}
.sm-gi.on{background:var(--soft)}
.sm-gi .t{flex:1;min-width:0;font-size:14.5px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sm-gi .w{flex:none;font-size:12px;color:var(--dim);font-weight:600}
.sm-runrow{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.sm-runrow .btn{flex:1 1 auto}
.sm-runrow .btn.ghost{flex:0 0 auto}
.sm-prog{height:10px;border-radius:6px;background:var(--soft);overflow:hidden;margin-top:12px}
.sm-prog div{height:100%;background:var(--accent2);width:0;transition:width .12s linear}
.sm-stat{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:12.5px;color:var(--mute);font-weight:700;margin-top:6px}
.sm-stat b{color:var(--text);font-family:'JetBrains Mono',monospace}
.sm-svg{width:100%;height:auto;max-height:230px;display:block;margin:8px auto 0;overflow:visible}
.sm-svg text{font:600 10px Inter,system-ui,sans-serif;fill:var(--dim)}
.sm-leg{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;font-weight:700;color:var(--mute);margin-top:4px}
.sm-leg i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:4px;vertical-align:-1px}
.sm-kpis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:10px}
.sm-kpis div{background:var(--soft);border-radius:10px;padding:9px 8px;min-width:0}
.sm-kpis b{display:block;font-size:clamp(13px,3.9vw,15.5px);font-weight:800;font-family:'JetBrains Mono',monospace;overflow-wrap:anywhere;line-height:1.25}
.sm-kpis span{display:block;font-size:11.5px;color:var(--dim);font-weight:700}
.sm-wdl{display:grid;grid-template-columns:minmax(0,74px) minmax(0,1fr) auto;gap:8px;align-items:center;padding:6px 0;font-size:13.5px;font-weight:700}
.sm-wdl .nm{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sm-wdl .tr{position:relative;height:14px;border-radius:7px;background:var(--soft);overflow:visible}
.sm-wdl .tr div{height:100%;border-radius:7px}
.sm-wdl .tr s{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--text);border-radius:1px}
.sm-wdl .v{font-family:'JetBrains Mono',monospace;font-size:13px;text-align:right;white-space:nowrap}
.sm-wdl .v small{display:block;font-family:Inter,system-ui,sans-serif;font-size:11px;color:var(--dim);font-weight:600}
.sm-heat{display:grid;grid-template-columns:20px repeat(6,minmax(0,1fr));gap:3px;margin-top:8px}
.sm-heat .hh{font-size:11px;font-weight:800;color:var(--dim);text-align:center;align-self:center;min-width:0}
.sm-heat .c{border-radius:7px;padding:5px 0;text-align:center;min-width:0;border:1px solid var(--line)}
.sm-heat .c b{display:block;font-size:12px;font-weight:800;color:var(--text)}
.sm-heat .c span{display:block;font-size:9.5px;font-weight:700;color:var(--mute)}
.sm-tbl .sm-row{display:grid;grid-template-columns:minmax(0,1fr) 64px 46px 34px;gap:6px;align-items:center;padding:8px 0;border-top:1px solid var(--line)}
.sm-tbl .sm-row:first-child{border-top:0}
.sm-row .l{min-width:0}
.sm-row .l b{display:block;font-size:14px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sm-row .l span{display:block;font-size:11.5px;color:var(--dim);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sm-row .p{text-align:right;font-family:'JetBrains Mono',monospace;font-weight:800;font-size:13.5px;white-space:nowrap}
.sm-row .p small{display:block;font-family:Inter,system-ui,sans-serif;font-size:10.5px;color:var(--dim);font-weight:600}
.sm-row .d{text-align:right;font-family:'JetBrains Mono',monospace;font-weight:700;font-size:12px;color:var(--mute);white-space:nowrap}
.sm-row .d.big{color:var(--amber)}.sm-row .d.up{color:var(--yes)}.sm-row .d.dn{color:var(--no)}
.sm-add{width:32px;height:32px;border-radius:9px;border:0;background:var(--yesbg);color:var(--text);font-weight:900;font-size:17px;cursor:pointer;line-height:1}
.sm-add.in{background:var(--accent2);color:#000}
.sm-add:disabled{opacity:.35;cursor:default}
.sm-th{display:grid;grid-template-columns:minmax(0,1fr) 64px 46px 34px;gap:6px;font-size:11px;font-weight:800;color:var(--dim);text-transform:uppercase;letter-spacing:.3px;padding:2px 0 4px}
.sm-th span:nth-child(2),.sm-th span:nth-child(3){text-align:right}
.sm details{background:var(--card);border:1px solid var(--line);border-radius:14px;margin-bottom:10px;min-width:0}
.sm summary{cursor:pointer;padding:12px 14px;font-weight:800;font-size:15px;list-style:none;display:flex;justify-content:space-between;gap:8px;align-items:center}
.sm summary::-webkit-details-marker{display:none}
.sm summary small{font-size:12px;color:var(--dim);font-weight:700}
.sm summary:after{content:'▾';color:var(--dim);font-size:13px;transition:transform .15s}
.sm details[open] summary:after{transform:rotate(180deg)}
.sm details>.in{padding:0 14px 12px;min-width:0}
.sm-sl{display:grid;grid-template-columns:minmax(0,1fr);gap:2px;padding:9px 0;border-top:1px solid var(--line)}
.sm-sl:first-child{border-top:0}
.sm-sl label{display:flex;justify-content:space-between;gap:8px;font-size:13.5px;font-weight:700}
.sm-sl label output{font-family:'JetBrains Mono',monospace;font-size:12.5px;color:var(--blue);text-align:right}
.sm-sl input[type=range]{width:100%;accent-color:var(--accent2);height:28px}
.sm-sl select{width:100%;background:var(--soft);border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px;font:600 14px Inter,system-ui,sans-serif;margin-top:4px}
.sm-sl .chk{display:flex;align-items:center;gap:10px;font-size:14px;font-weight:700;cursor:pointer}
.sm-sl .chk input{width:20px;height:20px;accent-color:var(--accent2)}
.sm-sb{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:10px;align-items:center;text-align:center;padding:4px 0 2px}
.sm-sb .tm{display:flex;flex-direction:column;align-items:center;gap:5px;min-width:0;font-weight:800;font-size:13px}
.sm-sb .tm span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.sm-sb .sc{font:800 40px 'JetBrains Mono',monospace;letter-spacing:-1px;line-height:1}
.sm-sb .ck{display:block;font:700 13px Inter,system-ui,sans-serif;color:var(--blue);margin-top:6px;letter-spacing:0}
.sm-ctl{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px}
.sm-ctl .btn{padding:10px 12px;font-size:14px;flex:1 1 auto}
.sm-ctl .seg{flex:1 1 150px}
.sm-ctl .seg button{padding:8px 4px;font-size:13.5px}
.sm-tk{max-height:300px;overflow-y:auto;margin-top:10px;border-top:1px solid var(--line);overscroll-behavior:contain}
.sm-tk div{display:flex;gap:10px;padding:7px 2px;border-bottom:1px solid var(--line);font-size:13.5px;line-height:1.35;align-items:baseline}
.sm-tk div b{flex:none;font-family:'JetBrains Mono',monospace;font-size:11.5px;color:var(--dim);min-width:58px}
.sm-tk div.hl{font-weight:700}
.sm-tk div.new{animation:smfl .8s ease-out}
@keyframes smfl{from{background:var(--yesbg)}to{background:transparent}}
.sm-big{font:800 38px 'JetBrains Mono',monospace;line-height:1.05}
.sm-pl{display:flex;gap:8px;align-items:flex-start;padding:8px 0;border-top:1px solid var(--line);font-size:14px}
.sm-pl:first-child{border-top:0}
.sm-pl .t{flex:1;min-width:0}.sm-pl .t b{display:block;font-weight:700}.sm-pl .t span{display:block;font-size:12px;color:var(--dim);font-weight:600}
.sm-pl .p{flex:none;text-align:right;font-family:'JetBrains Mono',monospace;font-weight:800;font-size:13px}
.sm-pl .p small{display:block;font-family:Inter,system-ui,sans-serif;font-size:11px;color:var(--dim);font-weight:600}
.sm-flag{display:inline-block;font-size:10.5px;font-weight:800;padding:1px 6px;border-radius:5px;background:var(--amberbg);color:var(--amber);margin-left:4px;vertical-align:1px}
.sm-ok{display:inline-block;font-size:10.5px;font-weight:800;padding:1px 6px;border-radius:5px;background:var(--yesbg);color:var(--yes);margin-left:4px;vertical-align:1px}
.sm-g2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px}
@media(max-width:400px){.sm-tbl .sm-row,.sm-th{grid-template-columns:minmax(0,1fr) 58px 42px 34px}.sm-row .l b,.sm-row .l span{white-space:normal;overflow-wrap:anywhere}}
.sm-other{display:flex;align-items:center;gap:6px;background:var(--amberbg);border:1px solid var(--line);border-radius:12px;padding:6px 6px 6px 12px;margin:0 0 12px;min-width:0}
.sm-other .t{flex:1;min-width:0;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sm-other .btn{flex:none;padding:7px 10px;font-size:13px}
.sm details.sm-conv{background:none;border:0;border-radius:0;margin:8px 0 0}
.sm details.sm-conv summary{padding:8px 0 2px;font-size:13.5px;color:var(--mute)}
.sm-resw.sm-stale>*:not(#smStale){opacity:.55;transition:opacity .15s}
.sm-step{display:flex;justify-content:space-between;align-items:center;gap:6px;background:var(--soft);border-radius:10px;padding:6px 6px 6px 10px;min-width:0}
.sm-step>span{font-size:13px;font-weight:700;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sm-step div{display:flex;align-items:center;gap:6px;flex:none}
.sm-step b{font:800 18px 'JetBrains Mono',monospace;min-width:16px;text-align:center}
.sm-step .btn{padding:4px 0;width:34px;height:34px;font-size:18px;line-height:1}
.sm-chk{display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:700;cursor:pointer;min-width:0}
.sm-chk input{width:20px;height:20px;accent-color:var(--accent2);flex:none}
.sm-lrow{display:grid;grid-template-columns:minmax(0,1fr) 62px 64px;gap:6px;align-items:center;padding:7px 0;border-top:1px solid var(--line)}
.sm-lt .sm-lrow:first-child{border-top:0}
.sm-lrow .l{min-width:0}.sm-lrow .l b{display:block;font-size:14px;font-weight:700;overflow-wrap:anywhere}.sm-lrow .l span{display:block;font-size:11.5px;color:var(--dim);font-weight:600}
.sm-lrow .p{text-align:right;font-family:'JetBrains Mono',monospace;font-weight:800;font-size:13.5px;white-space:nowrap}
.sm-lrow .o{text-align:right;font-family:'JetBrains Mono',monospace;font-weight:700;font-size:12.5px;color:var(--blue);white-space:nowrap}
.sm .fl input{min-width:0}
@media(min-width:760px){.sm-cols{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start}.sm-cols>*{min-width:0}}
`;document.head.appendChild(st);}

/* ---------- small SVG charts ---------- */
const COL={h:'var(--yes)',d:'var(--amber)',a:'var(--no)',m:'var(--text)'};
function convSVG(cps,g,N){
  const W=340,H=170,pl=36,pr=8,pt=8,pb=20,iw=W-pl-pr,ih=H-pt-pb;
  const draws=g.sport==='soccer';
  const ser=[{i:1,c:COL.h,m:SB.p1(g,'H'),n:g.home.abbr+' win'}];if(draws)ser.push({i:2,c:COL.d,m:SB.p1(g,'D'),n:'Draw'});ser.push({i:3,c:COL.a,m:SB.p1(g,'A'),n:g.away.abbr+' win'});
  const pts=cps.filter(c=>c[0]>=1000);
  let lo=1,hi=0;for(const s of ser){lo=Math.min(lo,s.m);hi=Math.max(hi,s.m);for(const c of pts){const p=c[s.i]/c[0],e=ci95(p,c[0]);lo=Math.min(lo,p-e);hi=Math.max(hi,p+e);}}
  lo=Math.max(0,lo-.02);hi=Math.min(1,hi+.02);if(hi-lo<.1){const m=(hi+lo)/2;lo=Math.max(0,m-.05);hi=Math.min(1,m+.05);}
  const X=n=>pl+iw*n/N,Y=p=>pt+ih*(1-(p-lo)/(hi-lo));
  let o=`<svg class="sm-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Convergence of simulated win chances toward the engine as the number of sims grows">`;
  for(let k=0;k<=4;k++){const p=lo+(hi-lo)*k/4,y=Y(p);o+=`<line x1="${pl}" x2="${W-pr}" y1="${y}" y2="${y}" style="stroke:var(--line)" stroke-width="1"/><text x="${pl-4}" y="${y+3}" text-anchor="end">${(p*100).toFixed(0)}%</text>`;}
  for(let k=0;k<=4;k++){const n=N*k/4;o+=`<text x="${X(n)}" y="${H-5}" text-anchor="${k===0?'start':k===4?'end':'middle'}">${n?fmtN(n/1000)+'k':'0'}</text>`;}
  for(const s of ser){
    o+=`<line x1="${pl}" x2="${W-pr}" y1="${Y(s.m)}" y2="${Y(s.m)}" style="stroke:${s.c}" stroke-width="1.2" stroke-dasharray="4 3" opacity=".9"/>`;
    if(pts.length>1){const up=pts.map(c=>{const p=c[s.i]/c[0];return X(c[0]).toFixed(1)+','+Y(Math.min(1,p+ci95(p,c[0]))).toFixed(1);}),dn=pts.map(c=>{const p=c[s.i]/c[0];return X(c[0]).toFixed(1)+','+Y(Math.max(0,p-ci95(p,c[0]))).toFixed(1);}).reverse();
      o+=`<polygon points="${up.join(' ')} ${dn.join(' ')}" style="fill:${s.c}" opacity=".16"/>`;
      o+=`<polyline points="${pts.map(c=>X(c[0]).toFixed(1)+','+Y(c[s.i]/c[0]).toFixed(1)).join(' ')}" fill="none" style="stroke:${s.c}" stroke-width="2"/>`;}}
  o+='</svg>';
  o+=`<div class="sm-leg">${ser.map(s=>`<span><i style="background:${s.c}"></i>${esc(s.n)}</span>`).join('')}<span style="color:var(--dim)">dashed = engine · band = 95% range</span></div>`;
  return o;}
function histSVG(sim,model,lab,opts){ // sim/model: arrays of {x, p}; bars = sim, dots = engine model
  const W=340,H=130,pl=6,pr=6,pt=8,pb=18,iw=W-pl-pr,ih=H-pt-pb;const n=sim.length;if(!n)return '';
  const mx=Math.max(...sim.map(s=>s.p),...(model||[]).map(s=>s.p),1e-6),bw=iw/n;
  let o=`<svg class="sm-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(lab)}">`;
  sim.forEach((s,i)=>{const h=ih*s.p/mx;o+=`<rect x="${(pl+i*bw+bw*.12).toFixed(1)}" y="${(pt+ih-h).toFixed(1)}" width="${Math.max(.6,bw*.76).toFixed(1)}" height="${h.toFixed(1)}" rx="${bw>8?2:0}" style="fill:${s.hl?'var(--amber)':'var(--accent2)'}"/>`;});
  if(model&&model.length){o+=`<polyline fill="none" style="stroke:var(--text)" stroke-width="1.4" points="${model.map((m,i)=>(pl+i*bw+bw/2).toFixed(1)+','+(pt+ih-ih*m.p/mx).toFixed(1)).join(' ')}"/>`;}
  const step=Math.max(1,Math.ceil(n/(opts&&opts.ticks||8)));
  const nice=[1,2,5,10,15,20,25,50],st2=opts&&opts.mod?nice.find(v=>v>=step)||step:step;
  sim.forEach((s,i)=>{if(opts&&opts.mod?(s.x%st2===0):i%step===0)o+=`<text x="${(pl+i*bw+bw/2).toFixed(1)}" y="${H-5}" text-anchor="middle">${esc(s.lab!=null?s.lab:s.x)}</text>`;});
  return o+'</svg>';}

/* ---------- picker ---------- */
function gameLine(g){return `${g.home.abbr} vs ${g.away.abbr}`;}
function pickerHTML(g){
  const head=g?`<button class="sm-pick" data-a="pick" aria-expanded="${S.pickOpen}" aria-label="Choose a game to simulate">${SB.abBox(g.home)}<div class="sm-pt"><b>${esc(g.home.name)} vs ${esc(g.away.name)}</b><span>${SPORTICON[g.sport]||''} ${esc(g.comp)} · ${esc(SB.when(g))}</span></div><i>${S.pickOpen?'Close':'Change'}</i></button>`
    :`<div class="empty">No upcoming priced games right now. Check back after the next data update.</div>`;
  if(!S.pickOpen)return head;
  return head+`<div class="panel" style="margin-top:-4px"><input type="text" id="smPq" placeholder="Search team, league or sport" aria-label="Search games" value="${esc(S.pq)}" autocomplete="off"><div class="sm-gl" id="smGl">${pickerList()}</div></div>`;}
function pickerList(){
  const q=S.pq.toLowerCase().trim(),L=gamesList().filter(x=>!q||(x.home.name+' '+x.away.name+' '+x.home.abbr+' '+x.away.abbr+' '+x.comp+' '+SPORTNAME[x.sport]).toLowerCase().includes(q));
  const groups=new Map();for(const x of L){const k=(SPORTNAME[x.sport]||x.sport)+(x.sport==='soccer'?' · '+x.comp:'');if(!groups.has(k))groups.set(k,{icon:SPORTICON[x.sport]||'',list:[]});groups.get(k).list.push(x);}
  const order=[...groups.keys()].sort((a,b)=>{const r=s=>s.startsWith('Soccer')?0:1;return r(a)-r(b)||a.localeCompare(b);});
  return order.length?order.map(k=>{const G=groups.get(k);return `<div class="sm-gh">${G.icon} ${esc(k)} · ${G.list.length}</div>`+G.list.map(x=>`<button class="sm-gi${x.id===S.gid?' on':''}" data-a="choose" data-gid="${esc(x.id)}">${SB.abBox(x.home)}<span class="t">${esc(x.home.name)} vs ${esc(x.away.name)}</span><span class="w">${esc(SB.when(x).replace(' · ',' '))}</span></button>`).join('');}).join(''):'<div class="note" style="padding:12px 2px">No games match.</div>';}

/* ---------- what-if controls ---------- */
function wiDefs(g){const sp=g.sport,goals=GOALS(sp),H=g.home.abbr;
  const D=[{k:'str',type:'range',min:goals?-1:-10,max:goals?1:10,step:goals?.05:.5,def:0,label:`${H} strength shift`,
      out:v=>!+v?'Model':`${+v>0?'+':''}${(+v).toFixed(goals?2:1)} ${UNIT(sp)} to ${H}`},
    {k:'tempo',type:'range',min:-.25,max:.25,step:.05,def:0,label:'Tempo / scoring level',out:v=>!+v?'Model':`${+v>0?'+':''}${Math.round(v*100)}% ${UNIT(sp)}`},
    {k:'ha',type:'range',min:0,max:2,step:.1,def:1,label:'Home advantage',out:v=>+v===1?'100% (model)':+v===0?'0% (neutral venue)':Math.round(v*100)+'%'}];
  if(sp==='soccer'){const sc=specFor(g).scorers;const opts=[['','Nobody']];sc.forEach((L,t)=>L.forEach(p=>opts.push([p.id,`${p.name} (${t?g.away.abbr:H}) · ${Math.round(p.share*100)}% of team goals`])));
    D.push({k:'out',type:'select',label:'Star player out',opts,def:'',note:opts.length>1?'Removes his share of his team’s goal rate.':'No goalscorer data for these teams yet.'});
    D.push({k:'red',type:'select',label:'Red card',opts:[['-1','No forced red card'],['0',`${H} player sent off`],['1',`${g.away.abbr} player sent off`]],def:-1,num:1});
    D.push({k:'redMin',type:'range',min:1,max:90,step:1,def:60,label:'Red card minute',out:v=>Math.round(v)+"'"});}
  if(sp==='nhl')D.push({k:'gk',type:'select',label:'Backup goalie starts',opts:[['-1','Both starters'],['0',`${H} backup in net`],['1',`${g.away.abbr} backup in net`]],def:-1,num:1});
  if(sp==='nba')D.push({k:'pace',type:'range',min:88,max:112,step:1,def:CORE.NBAC.PACE,label:'Pace (possessions per team)',out:v=>+v===CORE.NBAC.PACE?CORE.NBAC.PACE+' (model)':String(v)});
  if(sp==='nfl'||sp==='ncaaf')D.push({k:'wx',type:'check',label:'Bad weather / low scoring',def:false,note:'Wind and rain: fewer touchdowns, shakier kicks.'});
  return D;}
function wiVal(d){const v=S.wi[d.k];return v==null?d.def:v;}
function wiHTML(g){const D=wiDefs(g),wk=wiKey(S.wi);
  return `<details id="smWi" ${S.wiOpen?'open':''}><summary>🎛️ What-if controls <small>${wk?'tweaks set':'model settings'}</small></summary><div class="in">
  <div class="note" style="margin:0 0 6px">Move the play-level model away from the engine, then run again. Every market shows its change against the baseline run (same random numbers, so differences come from your tweak).</div>
  ${D.map(d=>{const v=wiVal(d),id='smw_'+d.k;
    if(d.type==='range')return `<div class="sm-sl"><label for="${id}">${esc(d.label)}<output id="${id}_o">${esc(d.out(v))}</output></label><input type="range" id="${id}" data-wi="${d.k}" min="${d.min}" max="${d.max}" step="${d.step}" value="${v}"></div>`;
    if(d.type==='select')return `<div class="sm-sl"><label for="${id}">${esc(d.label)}</label><select id="${id}" data-wi="${d.k}" ${d.num?'data-num="1"':''}>${d.opts.map(([k,l])=>`<option value="${esc(k)}" ${String(v)===String(k)?'selected':''}>${esc(l)}</option>`).join('')}</select>${d.note?`<div class="note" style="margin-top:4px">${esc(d.note)}</div>`:''}</div>`;
    return `<div class="sm-sl"><label class="chk"><input type="checkbox" id="${id}" data-wi="${d.k}" ${v?'checked':''}>${esc(d.label)}</label>${d.note?`<div class="note" style="margin-top:2px">${esc(d.note)}</div>`:''}</div>`;}).join('')}
  <div class="sm-runrow" style="margin-top:8px"><button class="btn ghost" data-a="wireset">Reset to model</button></div></div></details>`;}

/* ---------- game simulator view ---------- */
function runLabel(){return wiKey(S.wi)?'▶ Run what-if · 100,000 sims':'▶ Run 100,000 sims';}
function runBoxHTML(g){
  const busy=RUN.active&&RUN.kind==='game'&&RUN.gid===g.id;
  const res=CACHE.get(ckey(g,wiKey(S.wi)))||(!busy&&!wiKey(S.wi)?null:null);
  const cps=busy?RUN.cps:(res?res.cps:null);
  const done=busy?RUN.done:res?res.N:0,frac=done/NSIM;
  const stage=busy&&RUN.stages>1?` · ${RUN.label} ${RUN.stage+1}/${RUN.stages}`:'';
  let st='';
  if(busy)st=`<div class="sm-stat" aria-live="polite"><span>${esc(RUN.phase)}${esc(stage)}</span><span><b>${fmtN(done)}</b> / ${fmtN(NSIM)} sims · <b>${fmtN(RUN.rate)}</b>/s</span></div>`;
  else if(res)st=`<div class="sm-stat"><span>Done: ${fmtN(res.N)} simulated games</span><span>${(res.ms/1000).toFixed(2)} s · <b>${fmtN(res.N/Math.max(.001,res.ms/1000))}</b> sims/s</span></div>`;
  else if(RUN.err&&RUN.gid===g.id)st=`<div class="sm-stat"><span style="color:var(--no)">${esc(RUN.err)}</span></div>`;
  else if(RUN.cancelled&&RUN.gid===g.id)st=`<div class="sm-stat"><span>Cancelled. Nothing was saved from that run.</span></div>`;
  else if(RUN.active)st=`<div class="sm-stat"><span>Another simulation is running. Wait for it, or cancel it above.</span></div>`;
  else st=`<div class="sm-stat"><span>Ready: ${SPORTICON[g.sport]} ${esc(playDesc(g.sport))}</span></div>`;
  // live chart while running; afterwards it folds away so the answer sits right under the Run button
  const conv=cps&&cps.length?convSVG(cps,g,NSIM):'',open=S.convOpen!=null?S.convOpen:window.innerWidth>=760;
  return `<div class="sm-prog" role="progressbar" aria-label="Simulation progress" aria-valuemin="0" aria-valuemax="${NSIM}" aria-valuenow="${done}"><div style="width:${(frac*100).toFixed(1)}%"></div></div>${st}${busy?conv:conv?`<details class="sm-conv" ${open?'open':''}><summary>How the ${fmtN(NSIM)} runs converged</summary>${conv}</details>`:''}`;}
/* another simulation (other game, parlay, bankroll) is running while this view is open: say so and offer View / Cancel */
function ownsRun(){if(!RUN.active)return true;const k=RUN.kind;
  if(S.mode==='parlay')return k==='parlay'||k==='bank';if(S.mode==='watch'||S.mode==='live')return k==='calib'&&RUN.gid===S.gid;
  return k==='game'&&RUN.gid===S.gid;}
function otherRunInner(){const g=RUN.gid&&SB.gameById(RUN.gid),k=RUN.kind;
  const what=k==='parlay'?'your parlay':k==='bank'?'bankrolls':k==='calib'?(g?'calibrating '+gameLine(g):'calibrating'):g?gameLine(g):'a game';
  const pc=k==='calib'||RUN.phase!=='Simulating'?'preparing…':Math.min(99,Math.floor(RUN.done/NSIM*100))+'%';
  return `<span class="t">⏳ ${k==='calib'?'':'Simulating '}<b>${esc(what)}</b> · ${pc}</span><button class="btn ghost" data-a="view">View</button><button class="btn ghost" data-a="cancel">Cancel</button>`;}
function otherRunHTML(){return RUN.active&&!ownsRun()?`<div class="sm-other" id="smOther" role="status">${otherRunInner()}</div>`:'';}
function viewRun(){const k=RUN.kind;if(!RUN.active)return;
  if(k==='parlay'||k==='bank')S.mode='parlay';
  else if(RUN.gid){if(RUN.gid!==S.gid){S.gid=RUN.gid;W.playing=false;W.ev=null;stopTimer();S.wi={};}
    if(k==='game'){S.mode='game';S.wi={...(RUN.wi||{})};}else S.mode=RUN.view||'watch';}
  S.pickOpen=false;saveUI();rerender();}
function playDesc(sp){return {soccer:'minute by minute, 90 minutes + stoppage time',nhl:'3 periods in 30-second ticks, then 3-on-3 OT and a shootout',nba:'possession by possession (~99 each), with overtime',nfl:'drive by drive (~11–12 each), with overtime',ncaaf:'drive by drive (~13 each), with college overtime'}[sp]||'';}
function gameHTML(g){if(!g)return '';
  const busy=RUN.active;const mine=busy&&RUN.kind==='game'&&RUN.gid===g.id;
  return `${otherRunHTML()}<div class="panel" id="smRunPanel"><div class="sm-runrow"><button class="btn" id="smRun" data-a="run" ${busy?'disabled':''}>${esc(runLabel())}</button><button class="btn ghost" id="smCancel" data-a="cancel" ${mine?'':'hidden'}>Cancel</button></div>
    <div id="smRunBox">${runBoxHTML(g)}</div></div>${wiHTML(g)}<div id="smRes">${resultsHTML(g)}</div>`;}
function deltaCell(d,se,wi){const a=Math.abs(d)*100;const cls=a<.05?'':wi?(d>0?'up':'dn'):Math.abs(d)>Math.max(.01,2.5*se)?'big':'';return `<span class="d ${cls}" title="difference in percentage points">${d>=0?'+':'−'}${a.toFixed(1)}</span>`;}
function wdlHTML(g,R,B){
  const rows=[[g.home.abbr+' win',R.hw,SB.p1(g,'H'),COL.h,B&&B.hw]];if(g.sport==='soccer')rows.push(['Draw',R.dr,SB.p1(g,'D'),COL.d,B&&B.dr]);rows.push([g.away.abbr+' win',R.aw,SB.p1(g,'A'),COL.a,B&&B.aw]);
  if(g.sport==='nfl'&&R.dr>0)rows.push(['Tie',R.dr,0,COL.d,B&&B.dr]);
  return rows.map(([n,p,m,c,b])=>`<div class="sm-wdl"><span class="nm">${esc(n)}</span><div class="tr" aria-hidden="true"><div style="width:${(p*100).toFixed(1)}%;background:${c}"></div>${m>0?`<s style="left:calc(${(m*100).toFixed(1)}% - 1px)" title="engine"></s>`:''}</div><span class="v">${pc1(p)}<small>${b!=null?'base '+pc1(b):m>0?'engine '+pc1(m):''}</small></span></div>`).join('');}
function heatHTML(g,R){if(!R.heat)return '';const n=R.heat.n,O=SB.outcomes(g),mp=new Float64Array(n*n);
  if(O)for(let i=0;i<O.n;i++){const h=O.h[i],a=O.a[i];if(h<n&&a<n)mp[h*n+a]+=O.p[i];}
  let mx=0;for(const v of R.heat.c)mx=Math.max(mx,v);
  let o=`<div class="sec">Final scores (sim, engine below)</div><div class="note" style="margin-top:-4px">Rows = ${esc(g.home.abbr)} goals, columns = ${esc(g.away.abbr)} goals${g.sport==='nhl'?', final score incl. the OT/shootout goal':''}.</div><div class="sm-heat" role="table" aria-label="Correct score heatmap"><span class="hh"></span>`;
  for(let a=0;a<n;a++)o+=`<span class="hh">${a}${a===n-1?'':''}</span>`;
  for(let h=0;h<n;h++){o+=`<span class="hh">${h}</span>`;for(let a=0;a<n;a++){const v=R.heat.c[h*n+a],t=mx?Math.round(8+70*v/mx):0;
    o+=`<div class="c" style="background:color-mix(in srgb,var(--accent2) ${t}%,var(--card))" title="${esc(g.home.abbr)} ${h}-${a} ${esc(g.away.abbr)}"><b>${v>=.0995?Math.round(v*100):(v*100).toFixed(1)}</b><span>${(mp[h*n+a]*100).toFixed(1)}</span></div>`;}}
  return o+'</div>';}
function distHTML(g,R){const sp=g.sport,goals=GOALS(sp),N=R.N;
  const mh=new Map(R.mh),th=new Map(R.th);let mm=null,tm=null;
  if(goals){const O=SB.outcomes(g);mm=new Map();tm=new Map();if(O)for(let i=0;i<O.n;i++){const d=O.h[i]-O.a[i],t=O.h[i]+O.a[i];mm.set(d,(mm.get(d)||0)+O.p[i]);tm.set(t,(tm.get(t)||0)+O.p[i]);}}
  const m=SB.fit(g);
  const nb=(x,mu,sd,w)=>CORE.Phi((x+w/2-mu)/sd)-CORE.Phi((x-w/2-mu)/sd);
  const mr=goals?[-5,5]:sp==='nba'?[-35,35]:[-31,31];
  const pmOf=d=>m.pm&&Math.abs(d)<=m.kmax?m.pm[d+m.kmax]:nb(d,m.mu,m.sd,1);
  const sim=[],mod=[];for(let d=mr[0];d<=mr[1];d++){sim.push({x:d,p:(mh.get(d)||0)/N,hl:!goals&&sp!=='nba'&&(Math.abs(d)===3||Math.abs(d)===7),lab:d>0?'+'+d:d});mod.push({x:d,p:goals?(mm.get(d)||0):pmOf(d)});}
  const bw=goals?1:sp==='nba'?5:3;const T=goals?(R.avgH+R.avgA):m.T,span=goals?(sp==='nhl'?[0,12]:[0,8]):[Math.max(0,Math.round((T-3*m.tsd)/bw)*bw),Math.round((T+3*m.tsd)/bw)*bw];
  const ts=[],tmd=[];for(let x=span[0];x<=span[1];x+=bw){let p=0;for(let k=x;k<x+bw;k++)p+=(th.get(k)||0)/N;ts.push({x,p,lab:x});tmd.push({x,p:goals?(tm.get(x)||0):nb(x+(bw-1)/2,m.T,m.tsd,bw)});}
  return `<div class="sec">${esc(g.home.abbr)} winning margin</div>${histSVG(sim,mod,'Winning margin distribution: bars are simulated, the line is the engine model',{ticks:goals?11:7,mod:1})}
  ${!goals&&sp!=='nba'?`<div class="note" style="margin-top:2px">Amber bars = margins of 3 and 7. Field goals and touchdowns make these key numbers stand out in a drive-level sim${m.pm?'; the line is the engine’s key-number model':'; the engine’s smooth curve can’t show them'}.</div>`:''}
  <div class="sec">Total ${esc(UNIT(sp))}</div>${histSVG(ts,tmd,'Total distribution: bars are simulated, the line is the engine model',{ticks:8})}
  <div class="sm-leg"><span><i style="background:var(--accent2)"></i>simulated</span><span><i style="background:var(--text);height:2px;vertical-align:3px"></i>engine model</span></div>`;}
function gmHTML(g,R){if(!R.gm||!R.gm.length||g.sport==='nba'||g.sport==='nfl'||g.sport==='ncaaf')return '';
  const soc=g.sport==='soccer',nb=soc?18:15,tot=R.gm.reduce((s,v)=>s+v,0)||1,sim=[];
  // soccer: 5-minute buckets (stoppage time is recorded in the 41-45' and 86-90' buckets); NHL: 4-minute buckets, 5 per period
  for(let i=0;i<nb;i++){const v=(R.gm[i]+R.gm[20+i])/tot;sim.push({x:i,p:v,lab:soc?(i%3===2?((i+1)*5)+(i===8||i===17?'+':"'"):''):(i%5===2?'P'+((i/5|0)+1):'')});}
  return `<div class="sec">When goals are scored</div>${histSVG(sim,null,'Share of simulated goals by game time',{ticks:nb})}<div class="note" style="margin-top:2px">${soc?'5-minute buckets; the 45+ and 90+ bars include stoppage time. Intensity rises late in each half.':'4-minute buckets, 5 per period (regulation goals); the last bucket includes empty-net goals.'}</div>`;}
const CALKEYS=new Set(['H','D','A','DC1X','DCX2','DC12']); // calibration targets: equal to the engine by construction
function marketRows(g,R,B){
  const goals=GOALS(g.sport),groups=new Map(),N=R.N;
  for(const m of R.mk){if(!groups.has(m.group))groups.set(m.group,[]);groups.get(m.group).push({...m,eng:1});}
  for(const x of R.ex){if(!groups.has(x.group))groups.set(x.group,[]);groups.get(x.group).push({...x,eng:0});}
  const bmap=B?new Map([...B.mk,...B.ex].map(x=>[x.key,x.sim])):null;
  let o='',i=0;let gsum=0,gn=0,inb=0;
  let close=0;for(const m of R.mk){if(CALKEYS.has(m.key))continue;const d=m.sim-m.model;gsum+=Math.abs(d);gn++;if(Math.abs(d)<=Math.max(ci95(m.model,N),.002))inb++;if(Math.abs(d)<=.015)close++;}
  for(const [grp,rows] of groups){
    const open=S.dOpen[grp]!=null?S.dOpen[grp]:(i<3||grp==='Half-time');i++;
    o+=`<details data-grp="${esc(grp)}" ${open?'open':''}><summary>${esc(grp)} <small>${rows.length}</small></summary><div class="in sm-tbl"><div class="sm-th"><span>Market</span><span>${B?'What-if':'Sim'}</span><span>${B?'Δ base':'Δ eng'}</span><span></span></div>`;
    for(const m of rows){const se=Math.sqrt(Math.max(m.sim*(1-m.sim),1e-9)/N);const key=m.eng?m.key:('SIM:'+m.code);
      const addable=m.eng?SB.priced(g):m.simLeg;const ins=addable&&SB.inSlip(g.id,key);
      const ref=B?bmap.get(m.key):m.model;
      const sub=B?`base ${ref!=null?pcS(ref):'—'}${m.model!=null?' · engine '+pcS(m.model):''} · fair ${SB.fmtOdds(m.sim)}`:`${m.model!=null?'engine '+pcS(m.model)+' · ':''}fair ${SB.fmtOdds(m.sim)}`;
      o+=`<div class="sm-row"><div class="l"><b>${esc(m.label)}</b><span>${sub}</span></div><span class="p">${pcS(m.sim)}<small>±${(ci95(m.sim,N)*100).toFixed(1)}</small></span>${ref!=null?deltaCell(m.sim-ref,se,!!B):'<span class="d">—</span>'}<button class="sm-add${ins?' in':''}" data-a="add" data-gid="${esc(g.id)}" data-key="${esc(key)}" aria-label="${ins?'Remove':'Add'} ${esc(m.label)} ${ins?'from':'to'} parlay slip" ${addable?'':'disabled'}>${ins?'✓':'+'}</button></div>`;}
    o+='</div></details>';}
  return {html:o,avg:gn?gsum/gn:0,n:gn,inb,close};}
function scorerHTML(g,R,B){if(!R.sc||!R.sc.length)return g.sport==='soccer'?`<details><summary>Goalscorers <small>no data</small></summary><div class="in note">No goalscorer data for these teams yet, so every goal is credited to “Other”.</div></details>`:'';
  const bmap=B&&B.sc?new Map(B.sc.map(x=>[x.id,x.any])):null;
  const rows=R.sc.slice().sort((a,b)=>b.any-a.any).map(p=>{const key='G:'+p.id,eng=SB.p1(g,key),ins=SB.inSlip(g.id,key),ref=bmap?bmap.get(p.id):eng>0?eng:null;
    return `<div class="sm-row"><div class="l"><b>${esc(p.name)} <span style="display:inline;color:var(--dim)">${esc(p.team?g.away.abbr:g.home.abbr)}</span></b><span>first scorer ${pcS(p.first)} · fair ${SB.fmtOdds(p.any)}${eng>0&&!B?' · engine '+pcS(eng):''}</span></div><span class="p">${pcS(p.any)}<small>±${(ci95(p.any,R.N)*100).toFixed(1)}</small></span>${ref!=null?deltaCell(p.any-ref,Math.sqrt(p.any*(1-p.any)/R.N),!!bmap):'<span class="d">—</span>'}<button class="sm-add${ins?' in':''}" data-a="add" data-gid="${esc(g.id)}" data-key="${esc(key)}" aria-label="Add ${esc(p.name)} to score" ${eng>0&&SB.openG(g)?'':'disabled title="Scorer legs need the soccer module"'}>${ins?'✓':'+'}</button></div>`;}).join('');
  return `<details data-grp="scorers" ${S.dOpen.scorers===false?'':'open'}><summary>Anytime goalscorer <small>${R.sc.length} players</small></summary><div class="in sm-tbl"><div class="note" style="margin:0 0 6px">Each simulated goal is credited to a player by his share of team goals (matched to the soccer module’s scorer prices when it has them); the rest go to “Other”.</div>${rows}</div></details>`;}
function resultsHTML(g){
  const wk=wiKey(S.wi);let R=CACHE.get(ckey(g,wk)),B=wk?CACHE.get(ckey(g,'')):null,stale=false;
  if(!R&&wk&&B){R=B;B=null;stale=true;}
  if(!R)return `<div class="empty">Tap <b>Run 100,000 sims</b> to play this game out 100,000 times. You’ll get win chances, a score heatmap, margin and total charts, and every market from the engine with the simulated chance next to it.</div>`;
  const tbl=marketRows(g,R,B);const H=g.home.abbr,A=g.away.abbr,dp=GOALS(g.sport)?2:1;
  return `<div class="sm-resw${stale?' sm-stale':''}" data-wk="${esc(stale?'':R.wk)}">${stale?'<div class="lineup" id="smStale"><span>These are the baseline results. Tap <b>Run what-if</b> to apply your tweaks.</span></div>':''}
  <div class="sm-cols"><div class="panel" id="smSum"><div class="tt">${B?'What-if vs baseline':'100,000 simulated games'}</div>
    <div class="sm-kpis"><div><b>${R.avgH.toFixed(dp)}<wbr>–${R.avgA.toFixed(dp)}</b><span>avg score ${esc(H)}–${esc(A)}</span></div><div><b>${(R.avgH+R.avgA).toFixed(dp)}</b><span>avg total${B?' (base '+(B.avgH+B.avgA).toFixed(dp)+')':' (engine '+engTotal(g).toFixed(dp)+')'}</span></div><div><b>${pc1(R.ov)}</b><span>over ${R.line}</span></div></div>
    <div style="margin-top:10px">${wdlHTML(g,R,B)}</div>
    ${B?'':`<div class="note">Win${g.sport==='soccer'?'/draw':''} chances and the average total match the engine by design: the play model is tuned to them. On the other ${tbl.n} engine markets, ${tbl.close} land within 1.5 points (average gap ${(tbl.avg*100).toFixed(2)} points)${tbl.close===tbl.n?', so the two models are consistent there':''}. Bigger gaps point to play-level effects like pace, game state or overtime. Ticks = engine.</div>`}
    ${heatHTML(g,R)}</div>
  <div class="panel">${distHTML(g,R)}${gmHTML(g,R)}</div></div>
  <h2>Markets <small>${B?'what-if vs baseline':'sim vs engine'} · tap + to add</small></h2>${tbl.html}${scorerHTML(g,R,B)}
  <div class="note">Sim % = share of the 100,000 simulated games where the market won (±95% range). Fair odds come from the sim %. All chances are model estimates, not guarantees.</div></div>`;}
function engTotal(g){const m=SB.fit(g);if(!m)return 0;if(m.kind==='margin')return m.T;const O=SB.outcomes(g);let s=0;for(let i=0;i<O.n;i++)s+=(O.h[i]+O.a[i])*O.p[i];return s;}

/* ---------- progress painting (rAF-throttled; touches only the run box) ---------- */
let paintQ=false;
function schedPaint(){if(paintQ)return;paintQ=true;requestAnimationFrame(()=>{paintQ=false;paintRun();});}
function syncRunButtons(){const busy=RUN.active,r=document.getElementById('smRun'),c=document.getElementById('smCancel');
  if(r){r.disabled=busy;r.textContent=runLabel();}if(c)c.hidden=!(busy&&RUN.kind==='game'&&RUN.gid===S.gid);}
function paintRun(){syncRunButtons();const ob=document.getElementById('smOther');if(ob)ob.innerHTML=otherRunInner();const box=document.getElementById(RUN.kind==='parlay'?'smParBox':RUN.kind==='bank'?'smBankBox':'smRunBox');if(!box)return;
  if(RUN.kind==='game'){const g=SB.gameById(RUN.gid);if(g&&g.id===S.gid)box.innerHTML=runBoxHTML(g);}
  else if(RUN.kind==='parlay')box.innerHTML=parBoxHTML();else if(RUN.kind==='bank')box.innerHTML=bankBoxHTML();}

/* ---------- watch one game ---------- */
const W={gid:null,ev:null,pos:0,playing:false,speed:1,timer:null,n:0,flash:-1,wk:''};
const STEPMS={soccer:240,nhl:110,nba:85,nfl:700,ncaaf:650};
function stopTimer(){if(W.timer){clearTimeout(W.timer);W.timer=null;}}
/* calibrated base for a game. Missing: calibrate off the main thread (worker job, kind 'calib') and call back; while another
   run holds the worker, goals sports calibrate inline (an exact DP, tens of ms) and margin sports return null. */
function ensureBase(g,view,cb){const k=tsig(g);let b=BASE.get(k);if(b)return b;
  if(RUN.active){if(!GOALS(g.sport))return null;b=CORE.calibGoals(g.sport,targetsOf(g));BASE.set(k,b);return b;}
  Object.assign(RUN,{active:true,kind:'calib',gid:g.id,view,err:null,phase:'Preparing',done:0});
  runner.start({cmd:'calib',spec:specFor(g,{})},{done(r){RUN.active=false;BASE.set(k,r.base);if(cb)cb();else rerender();},
    error(m){RUN.active=false;W.loading=false;SB.toast('Could not calibrate this game: '+esc(m));rerender();}});
  return null;}
function watchNew(){const g=curGame();if(!g)return;stopTimer();
  const base=ensureBase(g,'watch',()=>{W.loading=false;watchNew();});
  if(!base){if(!(RUN.active&&RUN.kind==='calib')){SB.toast('Finish or cancel the current run first.');return;}
    W.gid=g.id;W.ev=null;W.loading=true;W.playing=false;rerender();return;}
  const P=CORE.applyWI(specFor(g,S.wi),base),ev={steps:[],log:[]},rec={};
  CORE.simOne(P,CORE.rng((Date.now()^(++W.n*2654435761))>>>0),rec,ev);
  Object.assign(W,{gid:g.id,ev,pos:0,playing:true,flash:-1,loading:false,wk:wiKey(S.wi)});rerender();watchLoop();}
function watchLoop(){stopTimer();if(!W.playing||!W.ev)return;const g=SB.gameById(W.gid);if(!g){W.playing=false;return;}
  const last=W.ev.steps.length-1;if(W.pos>=last){W.playing=false;paintWatch();return;}
  W.timer=setTimeout(()=>{W.timer=null; // pause when the view is gone (other tab) or the page is hidden; ▶ Play resumes
    if(!document.getElementById('smWBody')||document.hidden){W.playing=false;return;}
    W.pos=Math.min(last,W.pos+1);paintWatch();watchLoop();},STEPMS[g.sport]/W.speed);}
document.addEventListener('visibilitychange',()=>{if(document.hidden&&W.playing){W.playing=false;stopTimer();paintWatch();}});
function logText(g,e){const T=t=>t?g.away.abbr:g.home.abbr,sc=` <span style="color:var(--dim)">${e.h}–${e.a}</span>`;
  switch(e.k){
    case 'goal':return (g.sport==='nhl'?'🚨 ':'⚽ ')+`<b>${esc(T(e.team))} goal</b>${e.who?' · '+esc(e.who):g.sport==='soccer'?' · Other':''}${e.en?' (empty net)':''}${e.ot?' · OT winner':''}${sc}`;
    case 'red':return `🟥 Red card · ${esc(T(e.team))}${e.forced?' (what-if)':''}`;
    case 'added':return `⏱️ ${e.n} minute${e.n>1?'s':''} added`;
    case 'ht':return `<b>Half-time</b>${sc}`;case 'per':return `<b>${esc(e.c)}</b>${sc}`;
    case 'ot':return `<b>Overtime</b>${g.sport==='nhl'?' · 3-on-3, sudden death':''}`;
    case 'so':return `🎯 Shootout: ${esc(g.home.abbr)} ${e.r0?'✅':'❌'} · ${esc(g.away.abbr)} ${e.r1?'✅':'❌'} <span style="color:var(--dim)">(${e.sh}–${e.sa})</span>`;
    case 'sow':return `🏆 <b>${esc(T(e.team))} win the shootout</b>${sc}`;
    case 'ft':return `🏁 <b>${esc(g.sport==='soccer'?'Full-time':e.c)}</b>${sc}`;
    case 'pts':return `🏀 ${esc(T(e.team))} ${e.pts===3?'<b>3-pointer</b>':e.pts===2?'2 points':'free throw'}${sc}`;
    case 'kneel':return `🧎 ${esc(T(e.team))} take a knee${sc}`;
    case 'otp':return `🏈 ${esc(T(e.team))} OT possession${sc}`;
    case 'drive':{const D={td1:'🏈 <b>Touchdown</b> + extra point',td0:'🏈 <b>Touchdown</b>, extra point missed',td2:'🏈 <b>Touchdown</b> + 2-point conversion',td2x:'🏈 <b>Touchdown</b>, 2-point try fails',fg:'🥅 <b>Field goal</b>',saf:'🛡️ <b>Safety</b> (defense +2)',dtd:'↩️ <b>Defensive touchdown</b>',punt:'Punt',to:'Turnover',downs:'Turnover on downs'};
      return `${esc(T(e.team))} drive: ${D[e.kind]||esc(e.kind)}${sc}`;}}
  return esc(e.k);}
function flowSVG(g){const st=W.ev.steps,n=st.length;if(n<2)return '';const pos=W.pos,Wd=340,H=70,pl=4,pr=4;let mx=1;for(const s of st)mx=Math.max(mx,Math.abs(s.h-s.a));
  const X=i=>pl+(Wd-pl-pr)*i/(n-1),Y=d=>H/2-(H/2-6)*d/mx;
  const pts=[];for(let i=0;i<=pos;i++)pts.push(X(i).toFixed(1)+','+Y(st[i].h-st[i].a).toFixed(1));
  return `<svg class="sm-svg" viewBox="0 0 ${Wd} ${H}" role="img" aria-label="Game flow: ${esc(g.home.abbr)} margin over time"><line x1="${pl}" x2="${Wd-pr}" y1="${H/2}" y2="${H/2}" style="stroke:var(--line)"/><text x="${pl}" y="10">${esc(g.home.abbr)} ahead</text><text x="${pl}" y="${H-2}">${esc(g.away.abbr)} ahead</text><polyline fill="none" style="stroke:var(--accent2)" stroke-width="2" points="${pts.join(' ')}"/></svg>`;}
function watchHTML(g){if(!g)return '';
  const has=W.ev&&W.gid===g.id;
  return `<div class="panel" id="smWatch">${has?'':`<div class="note" style="margin:0 0 10px">Watch one simulated game unfold, ${esc(playDesc(g.sport))}. It uses the same calibrated model as the 100,000-run simulator${wiKey(S.wi)?' and your what-if tweaks':''}. One game is one random draw, not a prediction.</div>`}
    <div id="smWBody">${watchBody(g)}</div></div>${wiHTML(g)}`;}
function watchBody(g){
  const has=W.ev&&W.gid===g.id;if(W.loading)return '<div class="note">Calibrating to the engine…</div>';
  if(!has)return `<button class="btn full" data-a="wnew">▶ Play a simulated game</button>`;
  const st=W.ev.steps[W.pos]||{c:'',h:0,a:0},last=W.ev.steps.length-1,ended=W.pos>=last;
  const log=W.ev.log.filter(e=>e.i<=W.pos||ended).reverse();
  return `<div class="sm-sb" aria-live="polite"><div class="tm">${SB.abBox(g.home)}<span>${esc(g.home.name)}</span></div><div><div class="sc">${st.h}–${st.a}</div><span class="ck">${esc(ended?(W.ev.log[W.ev.log.length-1]||{}).c||'Final':st.c)}</span></div><div class="tm">${SB.abBox(g.away)}<span>${esc(g.away.name)}</span></div></div>
    ${flowSVG(g)}
    <div class="sm-ctl"><button class="btn" data-a="wplay" aria-label="${W.playing?'Pause':'Play'}">${W.playing?'⏸ Pause':ended?'🔁 Replay':'▶ Play'}</button>
      <div class="seg" role="group" aria-label="Playback speed">${[1,4,16].map(s=>`<button data-a="wspeed" data-s="${s}" class="${W.speed===s?'on':''}" aria-pressed="${W.speed===s}">${s}×</button>`).join('')}</div>
      <button class="btn ghost" data-a="wskip" ${ended?'disabled':''}>⏭ Skip to end</button><button class="btn ghost" data-a="wnew">🎲 New game</button></div>
    <div class="sm-tk" id="smTk">${log.map((e,i)=>`<div class="${/goal|ft|sow|ht/.test(e.k)||e.kind&&e.kind.startsWith('td')?'hl':''}"><b>${esc(e.k==='ft'||e.k==='ht'||e.k==='per'?'':e.c)}</b><span>${logText(g,e)}</span></div>`).join('')||'<div><span style="color:var(--dim)">Kick-off…</span></div>'}</div>`;}
function paintWatch(){const b=document.getElementById('smWBody');const g=SB.gameById(W.gid);if(!b||!g||g.id!==S.gid)return;b.innerHTML=watchBody(g);}


/* ---------- ⏱ Live: in-play fair prices for soccer (exact DP from the current minute / score / red cards) ---------- */
function liveState(g){if(!S.live||S.live.gid!==g.id)S.live={gid:g.id,min:60,h:0,a:0,rh:false,ra:false};return S.live;}
const minLabel=m=>m<=0?"Kick-off":m===45?'Half-time':m>=90?"90' · stoppage to come":m+"'";
function liveCalc(g,base,L){const P=CORE.applyWI(specFor(g,S.wi),base);delete P.fr; // a forced-red what-if is replaced by the live red-card toggles
  return CORE.dpSummary(CORE.goalsDP(P,0,{min:L.min,h:L.h,a:L.a,r:(L.rh?1:0)|(L.ra?2:0)}));}
function liveHTML(g){if(!g)return '';
  if(g.sport!=='soccer')return `<div class="panel"><div class="note" style="margin:0">⏱ Live fair prices work for soccer matches. Pick a soccer game above to set the minute, score and red cards.</div></div>`;
  const L=liveState(g),H=g.home.abbr,A=g.away.abbr;
  const step=(k,lab)=>`<div class="sm-step"><span>${esc(lab)}</span><div><button class="btn ghost" data-a="lstep" data-k="${k}" data-d="-1" aria-label="${esc(lab)} one goal fewer">−</button><b id="smL${k}">${L[k]}</b><button class="btn ghost" data-a="lstep" data-k="${k}" data-d="1" aria-label="${esc(lab)} one goal more">+</button></div></div>`;
  return `<div class="panel" id="smLive"><div class="tt">Live fair prices</div><div class="note" style="margin:2px 0 8px">Set where the match stands. The rest of the game is worked out exactly from our play model (the same one the 100,000-run simulator uses${wiKey(S.wi)?', with your what-if tweaks':''}). Fair live price from our model given the score and minute. Live books move fast and add margin.</div>
    <div class="sm-sl" style="border-top:0"><label for="smLmin">Minutes played<output id="smLmin_o">${esc(minLabel(L.min))}</output></label><input type="range" id="smLmin" data-l="min" min="0" max="90" step="1" value="${L.min}"></div>
    <div class="sec" style="margin-top:4px">Score now</div><div class="sm-g2">${step('h',H)}${step('a',A)}</div>
    <div class="sm-g2" style="margin-top:6px"><label class="chk sm-chk"><input type="checkbox" data-l="rh" ${L.rh?'checked':''}>🟥 ${esc(H)} down to 10</label><label class="chk sm-chk"><input type="checkbox" data-l="ra" ${L.ra?'checked':''}>🟥 ${esc(A)} down to 10</label></div>
    <div id="smLiveOut">${liveOut(g)}</div></div>${wiHTML(g)}`;}
function liveOut(g){const L=liveState(g),k=tsig(g);
  let base=BASE.get(k);if(!base&&RUN.active&&RUN.kind!=='calib')base=ensureBase(g,'live');
  if(!base){if(!RUN.active)queueMicrotask(()=>{if(!RUN.active&&!BASE.get(k)&&S.mode==='live'&&S.gid===g.id)ensureBase(g,'live',null);});
    return '<div class="note" id="smLiveWait">Calibrating to the engine…</div>';}
  const s=liveCalc(g,base,L),GC=CORE.GC,F=s.F,H=g.home.abbr,A=g.away.abbr,c=L.h+L.a;
  const sum=f=>{let t=0;for(let h=0;h<GC;h++)for(let a=0;a<GC;a++){const p=F[h*GC+a];if(p>0&&f(h,a))t+=p;}return Math.min(1,Math.max(0,t));};
  const row=(lab,p,sub)=>`<div class="sm-lrow"><span class="l"><b>${esc(lab)}</b>${sub?`<span>${sub}</span>`:''}</span><span class="p">${pcS(p)}</span><span class="o">${p>1e-6&&p<1-1e-9?esc(SB.fmtOdds(p)):p>=1-1e-9?'won':'—'}</span></div>`;
  const pre=k2=>{try{return 'pre-match '+pc1(SB.p1(g,k2));}catch(e){return '';}};
  let o=`<div class="sec">Result (90 minutes + stoppage)</div><div class="sm-lt">${row(H+' win',s.H,pre('H'))}${row('Draw',s.D,pre('D'))}${row(A+' win',s.A,pre('A'))}</div>`;
  o+=`<div class="sec">Total goals (full match, incl. the ${c} already scored)</div><div class="sm-lt">${[.5,1.5,2.5].map(x=>{const ln=c+x;return row('Over '+ln,sum((h,a)=>h+a>ln))+row('Under '+ln,sum((h,a)=>h+a<ln));}).join('')}
    ${row('Both teams score',sum((h,a)=>h>0&&a>0),L.h>0&&L.a>0?'already landed':'')}</div>`;
  const cs=[];for(let h=L.h;h<GC-1;h++)for(let a=L.a;a<GC-1;a++){const p=F[h*GC+a];if(p>1e-9)cs.push([h,a,p]);}cs.sort((x,y)=>y[2]-x[2]);
  o+=`<div class="sec">Most likely final scores</div><div class="sm-lt">${cs.slice(0,6).map(([h,a,p])=>row(`${H} ${h}–${a} ${A}`,p)).join('')}</div>`;
  // the slip, priced live: this game's legs over the live final-score grid, other games at their pre-match chance
  const slip=SB.slip||[],mine=slip.filter(l=>l.gid===g.id);
  if(mine.length){const others=slip.filter(l=>l.gid!==g.id),ok=l=>SB.evalMarket(g,l.key,0,0)!=null&&SB.evalMarket(g,l.key,1,1)!=null;
    const rows=mine.map(l=>{let lab=l.label||l.key;try{lab=SB.legLabel(l)||lab;}catch(e){}
      return ok(l)?row(lab,sum((h,a)=>!!SB.evalMarket(g,l.key,h,a)),'live'):`<div class="sm-lrow"><span class="l"><b>${esc(lab)}</b><span>needs data the score can’t give</span></span><span class="p">n/a live</span><span class="o"></span></div>`;}).join('');
    const all=mine.every(ok);let po=1;try{po=others.length?SB.parlayProb(others).p:1;}catch(e){po=0;}
    const joint=all?sum((h,a)=>mine.every(l=>SB.evalMarket(g,l.key,h,a))):null,lp=joint==null?null:joint*po;let prem=null;try{prem=SB.parlayProb(slip).p;}catch(e){}
    o+=`<div class="sec">Your slip, live</div><div class="sm-lt">${rows}</div>`;
    o+=lp==null?`<div class="note">A leg from this game can’t be priced from the score alone (scorer, half-time or player legs), so there is no live parlay chance.</div>`
      :`<div class="sm-kpis"><div><b>${pcS(lp)}</b><span>live parlay chance</span></div><div><b>${lp>1e-6?esc(SB.fmtOdds(lp)):'—'}</b><span>fair live price</span></div><div><b>${prem!=null?pcS(prem):'—'}</b><span>pre-match chance</span></div></div>
        <div class="note">${others.length?(others.length>1?`${others.length} legs from other games keep their pre-match chances. `:'1 leg from another game keeps its pre-match chance. '):''}To lock in part of a win, compare this with a live cash-out or hedge price in <a data-a="hedge" style="color:var(--blue);cursor:pointer;font-weight:700">Odds Tools → Hedge</a>.</div>`;}
  else o+=`<div class="note">Add legs from this match to your slip to see their live chances here.</div>`;
  return o+`<div class="note">Model estimates from the pre-match fit, not a live feed: injuries, momentum and tactics after kick-off aren’t in it.</div>`;}
function paintLive(){const g=curGame(),b=document.getElementById('smLiveOut');if(!g||!b||S.mode!=='live')return;const L=liveState(g);
  const o=document.getElementById('smLmin_o');if(o)o.textContent=minLabel(L.min);for(const k of ['h','a']){const e=document.getElementById('smL'+k);if(e)e.textContent=L[k];}
  b.innerHTML=liveOut(g);}

/* ---------- parlay simulator + bankroll ---------- */
function parLegs(){const L=S.plegs&&S.plegs.length?S.plegs:SB.slip;return (L||[]).map(l=>({gid:l.gid,key:l.key,label:l.label,sport:l.sport}));}
function legInfo(l){const g=SB.gameById(l.gid);let lab=l.label||l.key;try{lab=SB.legLabel(l)||lab;}catch(e){}return {g,lab,p:g||/^[PU]:/.test(l.key)?SB.p1(g,l.key):0};}
function buildParlayMsg(legs){
  const games=[],gi=new Map(),out=[],notes=[],condKeys=new Map(),legRef=[];
  const gidx=g=>{if(!gi.has(g.id)){gi.set(g.id,games.length);games.push({gid:g.id,spec:specFor(g,{}),base:BASE.get(tsig(g))||null});}return gi.get(g.id);};
  legs.forEach((l,j)=>{const {g,lab,p}=legInfo(l),key=String(l.key);
    if(/^[PU]:/.test(key)){out.push({t:'bern',p,gi:0});legRef.push({j,how:'engine'});notes.push(`“${lab}”: player props are priced by the engine and drawn independently (the game sim has no player stats).`);return;}
    if(!g){out.push({t:'bern',p:0,gi:0});legRef.push({j,how:'gone'});notes.push(`“${lab}”: game no longer in the feed.`);return;}
    if(!SB.priced(g)&&!key.includes(':')){out.push({t:'bern',p,gi:0});legRef.push({j,how:'engine'});return;}
    if(key.startsWith('SIM:')&&g.sport==='soccer'){out.push({t:'sim',code:key.slice(4),gi:gidx(g)});legRef.push({j,how:'sim'});return;}
    if(key.includes(':')){
      if(key.startsWith('G:')&&g.sport==='soccer'){const sc=specFor(g).scorers,first=key.startsWith('G:1st:'),id=key.slice(first?6:2);
        for(let t=0;t<2;t++){const b=sc[t].findIndex(x=>x.id===id);if(b>=0){out.push({t:first?'first':'scorer',team:t,bit:b,gi:gidx(g)});legRef.push({j,how:'sim'});return;}}}
      // custom legs that settle on the final score (e.g. SX team unders) are settled exactly by the sim like engine markets
      if(g.sport==='soccer'&&SB.evalMarket(g,key,0,0)!=null&&SB.evalMarket(g,key,2,1)!=null){const W2=16,tab=new Uint8Array(W2*W2);
        for(let h=0;h<W2;h++)for(let a=0;a<W2;a++)tab[h*W2+a]=SB.evalMarket(g,key,h,a)?1:0;
        out.push({t:'tab',w:W2,tab,gi:gidx(g)});legRef.push({j,how:'sim'});return;}
      if(g.sport==='soccer'){if(!condKeys.has(g.id))condKeys.set(g.id,[]);condKeys.get(g.id).push(key);legRef.push({j,how:'cond'});notes.push(`“${lab}”: the sim can’t settle this leg type, so it uses the engine’s chance given each simulated final score (keeps the correlation).`);return;}
      out.push({t:'bern',p,gi:0});legRef.push({j,how:'engine'});notes.push(`“${lab}”: settled with the engine’s chance, drawn independently.`);return;}
    const W2=GOALS(g.sport)?16:230,tab=new Uint8Array(W2*W2);
    for(let h=0;h<W2;h++)for(let a=0;a<W2;a++)tab[h*W2+a]=SB.evalMarket(g,key,h,a)?1:0;
    out.push({t:'tab',w:W2,tab,gi:gidx(g)});legRef.push({j,how:'sim'});});
  for(const [gid,keys] of condKeys){const g=SB.gameById(gid),Wc=11,tab=new Float32Array(Wc*Wc);
    for(let h=0;h<Wc;h++)for(let a=0;a<Wc;a++){const cs=h<=4&&a<=4?`CS${h}-${a}`:h>a?'CSOH':h===a?'CSOD':'CSOA';const pc=SB.p1(g,cs);tab[h*Wc+a]=pc>0?Math.min(1,SB.probOf(g,[...keys,cs])/pc):0;}
    out.push({t:'cond',w:Wc,tab,gi:gidx(g),group:keys});}
  return {games,legs:out,notes:[...new Set(notes)],legRef};}
function startParlay(){if(RUN.active)return;const legs=parLegs();if(!legs.length)return;
  const m=buildParlayMsg(legs),eng=SB.parlayProb(legs);
  Object.assign(RUN,{active:true,kind:'parlay',gid:null,done:0,rate:0,cps:[],err:null,cancelled:false,phase:'Starting',stage:0,stages:1});DBG.maxGap=0;gapMon();rerender();
  const sig=JSON.stringify(legs.map(l=>l.gid+'|'+l.key));
  runner.start({cmd:'parlay',games:m.games,legs:m.legs,N:NSIM,seed:SB.hashStr(sig)},{
    progress(v){if(v.phase==='calib')RUN.phase='Calibrating to the engine';else{RUN.phase='Simulating';RUN.done=v.done;if(v.cps)RUN.cps.push(...v.cps);RUN.rate=v.ms>0?v.done/(v.ms/1000):0;}schedPaint();},
    done(res){res.bases.forEach((b,i)=>{const g=SB.gameById(m.games[i].gid);if(g&&b)BASE.set(tsig(g),b);});
      const per=legs.map((l,j)=>{const ref=m.legRef[j];let k=-1;if(ref.how!=='cond'){let c=0;for(let q=0;q<j;q++)if(m.legRef[q].how!=='cond')c++;k=c;}return {...legInfo(l),how:ref.how,sim:k>=0?res.legHit[k]/res.N:null};});
      PAR={sig,N:res.N,hit:res.hits/res.N,eng:eng.p,indep:eng.indep,per,notes:m.notes,cps:RUN.cps.slice(),ms:res.ms};RUN.active=false;rerender();},
    error(e){RUN.active=false;RUN.err='The parlay simulation failed: '+e;rerender();}});}
function parBoxHTML(){const busy=RUN.active&&RUN.kind==='parlay';if(!busy)return '';
  return `<div class="sm-prog" role="progressbar" aria-label="Parlay simulation progress" aria-valuemin="0" aria-valuemax="${NSIM}" aria-valuenow="${RUN.done}"><div style="width:${(RUN.done/NSIM*100).toFixed(1)}%"></div></div><div class="sm-stat" aria-live="polite"><span>${esc(RUN.phase)}</span><span><b>${fmtN(RUN.done)}</b> / ${fmtN(NSIM)} · <b>${fmtN(RUN.rate)}</b>/s</span></div>`;}
function parlayHTML(){const legs=parLegs(),sig=JSON.stringify(legs.map(l=>l.gid+'|'+l.key)),busy=RUN.active&&RUN.kind==='parlay',R=PAR&&PAR.sig===sig?PAR:null;
  const fromParams=S.plegs&&S.plegs.length;
  let o=`<div class="panel"><div class="tt">Parlay simulator</div><div class="note" style="margin:2px 0 8px">Plays every game in the parlay 100,000 times. Each game is simulated once per run, so legs from the same game move together (a home win and over 2.5 often come together).</div>`;
  if(fromParams)o+=`<div class="lineup">Simulating the parlay you opened here. <a data-a="useslip" style="color:var(--blue);cursor:pointer;font-weight:700">Use my slip instead</a></div>`;
  if(!legs.length)return o+`<div class="empty" style="margin-top:8px">Your slip is empty. Add legs from any game, or from the market table in the game simulator (tap +).<br><button class="btn" data-a="mode" data-m="game" style="margin-top:12px">Open the game simulator</button></div></div>`;
  o+=legs.map((l,j)=>{const {g,lab,p}=legInfo(l);const pr=R&&R.per[j]; // R.sig === this slip, so R.per follows the same leg order
    return `<div class="sm-pl"><div class="t"><b>${esc(lab)}</b><span>${g?esc(gameLine(g))+' · '+esc(g.comp):''}${pr&&pr.how==='cond'?'<span class="sm-flag">engine conditional</span>':pr&&pr.how==='engine'?'<span class="sm-flag">engine chance</span>':''}</span></div><div class="p">${pr&&pr.sim!=null?pc1(pr.sim):pc1(p)}<small>${pr&&pr.sim!=null?'engine '+pc1(p):'engine'}</small></div></div>`;}).join('');
  o+=`<div class="sm-runrow" style="margin-top:10px"><button class="btn" data-a="prun" ${RUN.active?'disabled':''}>▶ Simulate parlay · 100,000×</button><button class="btn ghost" data-a="cancel" ${busy?'':'hidden'}>Cancel</button></div><div id="smParBox">${parBoxHTML()}</div>`;
  if(RUN.err&&RUN.kind==='parlay'&&!busy)o+=`<div class="note" style="color:var(--no)">${esc(RUN.err)}</div>`;
  if(R){const v=parAgree(R),e=v.e;
    o+=`<div class="sm-kpis" style="margin-top:12px"><div><b>${pcS(R.hit)}</b><span>sim hit rate ±${(e*100).toFixed(e<.0005?2:1)}</span></div><div><b>${pcS(R.eng)}</b><span>engine (parlayProb)</span></div><div><b>${v.rel==null?'—':(v.rel>=0?'+':'−')+Math.round(Math.abs(v.rel)*100)+'%'}</b><span>sim vs engine</span></div></div>
    <div class="sm-kpis"><div><b>${R.hit>0?SB.fmtOdds(R.hit):'—'}</b><span>fair price (sim)</span></div><div><b>${R.eng>0?SB.fmtOdds(R.eng):'—'}</b><span>fair price (engine)</span></div><div><b>${R.indep>0?SB.fmtOdds(R.indep):'—'}</b><span>if legs were unrelated</span></div></div>
    <div class="note" id="smAgree">${v.ok?`<span class="sm-ok">consistent</span> The play-level sim and the engine’s correlation-aware price are within ${v.rel==null?'sampling noise':Math.max(1,Math.round(Math.abs(v.rel)*100))+'%'} of each other here.`:`<span class="sm-flag">differs</span> The two models differ by ${v.rel==null?'a lot':Math.round(Math.abs(v.rel)*100)+'%'} on this parlay (sim ${R.hit>0?esc(SB.fmtOdds(R.hit)):'—'} vs engine ${R.eng>0?esc(SB.fmtOdds(R.eng)):'—'}), so its price depends on the model: treat it with extra care.`} Neither is a guarantee. Multiplying the legs as if unrelated would give ${pcS(R.indep)}.</div>`;
    if(R.notes.length)o+=`<div class="note">${R.notes.map(esc).join('<br>')}</div>`;
    if(R.cps&&R.cps.length>1)o+=parConv(R);}
  return o+'</div>'+bankHTML(R);}
/* sim vs engine on a parlay: relative tolerance (8% of the price) or 2.5 standard errors, whichever is wider. An absolute
   floor would call almost any long parlay "consistent". */
function parAgree(R){const e=ci95(R.hit,R.N),d=R.hit-R.eng,rel=R.eng>1e-9?d/R.eng:null;
  return {e,rel,ok:R.eng>1e-9&&Math.abs(d)<=Math.max(2.5*e/1.96,.08*R.eng)};}
function parConv(R){const W=340,H=120,pl=36,pr=8,pt=8,pb=18,iw=W-pl-pr,ih=H-pt-pb,pts=R.cps.filter(c=>c[0]>=1000);let lo=1,hi=0;
  for(const c of pts){const p=c[1]/c[0],e=ci95(p,c[0]);lo=Math.min(lo,p-e,R.eng);hi=Math.max(hi,p+e,R.eng);}lo=Math.max(0,lo-.01);hi=Math.min(1,hi+.01);
  const X=n=>pl+iw*n/R.N,Y=p=>pt+ih*(1-(p-lo)/(hi-lo));
  return `<svg class="sm-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Parlay hit rate converging to the engine price">${[0,.5,1].map(k=>{const p=lo+(hi-lo)*k;return `<line x1="${pl}" x2="${W-pr}" y1="${Y(p)}" y2="${Y(p)}" style="stroke:var(--line)"/><text x="${pl-4}" y="${Y(p)+3}" text-anchor="end">${(p*100).toFixed(1)}%</text>`;}).join('')}
  <line x1="${pl}" x2="${W-pr}" y1="${Y(R.eng)}" y2="${Y(R.eng)}" style="stroke:var(--text)" stroke-dasharray="4 3"/>
  <polygon opacity=".16" style="fill:var(--accent2)" points="${pts.map(c=>{const p=c[1]/c[0];return X(c[0]).toFixed(1)+','+Y(Math.min(1,p+ci95(p,c[0]))).toFixed(1);}).join(' ')} ${pts.map(c=>{const p=c[1]/c[0];return X(c[0]).toFixed(1)+','+Y(Math.max(0,p-ci95(p,c[0]))).toFixed(1);}).reverse().join(' ')}"/>
  <polyline fill="none" style="stroke:var(--accent2)" stroke-width="2" points="${pts.map(c=>X(c[0]).toFixed(1)+','+Y(c[1]/c[0]).toFixed(1)).join(' ')}"/><text x="${W-pr}" y="${H-4}" text-anchor="end">${fmtN(R.N)} sims</text></svg><div class="sm-leg"><span><i style="background:var(--accent2)"></i>sim hit rate (95% band)</span><span style="color:var(--dim)">dashed = engine</span></div>`;}
function bankP(R){const b=S.bank;if(b.src==='custom'){const v=parseFloat(String(b.custom).replace('%',''));return v>0&&v<100?v/100:null;}if(!R)return null;return b.src==='engine'?R.eng:R.hit;}
function bankHTML(R){const b=S.bank,p=bankP(R);
  const dec=SB.parseOdds(b.price),ev=p!=null&&dec?SB.ev(p,dec):null,kf=+store.get('kellyFrac',.25)||.25,kel=p!=null&&dec?SB.kelly(p,dec,kf):0;
  return `<div class="panel"><div class="tt">Bankroll simulator</div><div class="note" style="margin:2px 0 8px">Bet the same stake on this parlay again and again at your book’s price. 100,000 bankroll paths show the spread of outcomes.</div>
  <div class="sm-g2"><label class="fl"><span>Book price (any format)</span><input type="text" id="smBp" data-b="price" value="${esc(b.price)}" placeholder="${R&&R.eng>0?'fair '+esc(SB.fmtOdds(R.eng)):'+250, 3.5, 5/2'}" autocomplete="off" inputmode="text"></label><label class="fl"><span>Stake per bet</span><input type="number" id="smBs" data-b="stake" value="${esc(b.stake)}" min="0.01" step="any" inputmode="decimal"></label>
  <label class="fl"><span>Number of bets</span><input type="number" id="smBn" data-b="bets" value="${esc(b.bets)}" min="1" max="2000" step="1" inputmode="numeric"></label><label class="fl"><span>Starting bankroll</span><input type="number" id="smBb" data-b="bank" value="${esc(b.bank)}" min="1" step="any" inputmode="decimal"></label></div>
  <div class="sm-sl" style="border:0;padding-bottom:0"><label>Hit chance to use</label><div class="seg" role="group" aria-label="Hit chance source">${[['sim','Sim'],['engine','Engine'],['custom','My own']].map(([k,l])=>`<button data-a="bsrc" data-s="${k}" class="${b.src===k?'on':''}" aria-pressed="${b.src===k}">${l}</button>`).join('')}</div>
  ${b.src==='custom'?`<input type="text" id="smBc" data-b="custom" value="${esc(b.custom)}" placeholder="e.g. 32%" aria-label="Your hit chance" style="margin-top:8px">`:''}</div>
  <div class="kvs" id="smBkv">${bankKV(p,dec,ev,kel,kf)}</div>
  <button class="btn full" data-a="brun" ${RUN.active||p==null||!dec?'disabled':''}>▶ Simulate 100,000 bankrolls</button>${!String(b.price).trim()?'<div class="note" id="smBpNote">Type your book’s price to run. The fair price is a break-even line, not what a book pays.</div>':''}${p==null?`<div class="note">${S.bank.src==='custom'?'Enter your hit chance, e.g. 32%.':'Run the parlay simulator first (or pick “My own”).'}</div>`:''}
  <div id="smBankBox">${bankBoxHTML()}</div></div>`;}
function bankKV(p,dec,ev,kel,kf){const b=S.bank;if(!String(b.price||'').trim())return '';if(p==null||!dec)return dec?'':`<div class="kv"><span>Price</span><b>enter a valid price</b></div>`;
  return `<div class="kv"><span>Hit chance used</span><b>${pc1(p)}</b></div><div class="kv ${ev>=0?'kpos':'kneg'}"><span>EV per bet</span><b>${ev>=0?'+':'−'}${Math.abs(ev*b.stake).toFixed(2)} (${(ev*100).toFixed(1)}%)</b></div>
  <div class="kv"><span>Break-even price</span><b>${SB.fmtOdds(p)} or better</b></div><div class="kv"><span>${Math.round(kf*100)}% Kelly stake</span><b>${kel>0?(kel*b.bank).toFixed(2):'no edge: skip'}</b></div>`;}
function startBank(){if(RUN.active)return;const R=PAR&&PAR.sig===JSON.stringify(parLegs().map(l=>l.gid+'|'+l.key))?PAR:null,p=bankP(R),dec=SB.parseOdds(S.bank.price);
  const b=S.bank,stake=+b.stake,bets=Math.round(+b.bets),bank=+b.bank;
  if(p==null||!dec){SB.toast('Enter a valid price and hit chance.');return;}
  if(!(stake>0)||!(bets>=1&&bets<=2000)||!(bank>=stake)){SB.toast('Stake must be above 0, bets 1–2,000, bankroll at least one stake.');return;}
  Object.assign(RUN,{active:true,kind:'bank',done:0,rate:0,err:null,phase:'Simulating',cancelled:false});DBG.maxGap=0;gapMon();rerender();
  runner.start({cmd:'bank',p,dec,stake,bets,bank,N:NSIM,seed:SB.hashStr('bank|'+p+'|'+dec+'|'+stake+'|'+bets+'|'+bank)},{
    progress(v){RUN.done=v.done;RUN.rate=v.ms>0?v.done/(v.ms/1000):0;schedPaint();},
    done(res){const e=Array.from(res.end).sort((x,y)=>x-y),N=res.N,q=f=>e[Math.min(N-1,Math.floor(f*N))];let s=0,pr=0;for(const v of e){s+=v;if(v>bank)pr++;}
      BANK={p,dec,stake,bets,bank,N,median:q(.5),p5:q(.05),p95:q(.95),mean:s/N,ruin:res.ruin/N,profit:pr/N,min:e[0],max:e[N-1],hist:bankHist(e,bank)};RUN.active=false;rerender();},
    error(m){RUN.active=false;RUN.err=m;rerender();}});}
function bankHist(e,b0){const lo=e[Math.floor(e.length*.002)],hi=e[Math.floor(e.length*.998)],nb=28,w=(hi-lo)/nb||1,c=new Array(nb).fill(0);
  for(const v of e){const i=Math.min(nb-1,Math.max(0,Math.floor((v-lo)/w)));c[i]++;}
  return c.map((n,i)=>({x:lo+i*w,p:n/e.length,hl:lo+(i+1)*w<=b0,lab:i%7===0?Math.round(lo+i*w):''}));}
function bankBoxHTML(){const busy=RUN.active&&RUN.kind==='bank';
  if(busy)return `<div class="sm-prog" role="progressbar" aria-label="Bankroll simulation progress" aria-valuemin="0" aria-valuemax="${NSIM}" aria-valuenow="${RUN.done}"><div style="width:${(RUN.done/NSIM*100).toFixed(1)}%"></div></div><div class="sm-stat"><span>Simulating bankrolls</span><span><b>${fmtN(RUN.done)}</b> / ${fmtN(NSIM)}</span></div>`;
  const B=BANK;if(!B)return '';const m=v=>(v<0?'−':'')+Math.abs(v).toFixed(2);
  return `<div class="sec">After ${fmtN(B.bets)} bets of ${m(B.stake)} at ${esc(SB.fmtPrice(B.dec))} (${pc1(B.p)} hit chance)</div>
  ${histSVG(B.hist,null,'Distribution of ending bankrolls',{ticks:4})}<div class="sm-leg"><span><i style="background:var(--amber)"></i>ended below the starting bankroll</span><span><i style="background:var(--accent2)"></i>ended above</span></div>
  <div class="kvs"><div class="kv"><span>Median ending bankroll</span><b>${m(B.median)}</b></div><div class="kv"><span>5th – 95th percentile</span><b>${m(B.p5)} – ${m(B.p95)}</b></div><div class="kv"><span>Average</span><b>${m(B.mean)}</b></div>
  <div class="kv ${B.profit>=.5?'kpos':'kneg'}"><span>Chance of finishing up</span><b>${pc1(B.profit)}</b></div><div class="kv ${B.ruin>.05?'kneg':''}"><span>Risk of ruin (can’t afford the next bet)</span><b>${pc1(B.ruin)}</b></div></div>
  <div class="note">Flat stakes, independent bets, the same price each time. Real results vary; these are model estimates.</div>`;}

/* ---------- tab render + wiring ---------- */
const MODES=[['game','🎲 Game'],['watch','📺 Watch'],['live','⏱ Live'],['parlay','🎯 Parlay']];
function saveUI(){store.set('sim.mode',S.mode);if(S.gid)store.set('sim.gid',S.gid);}
function render(main,params){
  if(params!==lastParams){lastParams=params;const p=params||{};
    if(p.gid&&SB.gameById(p.gid)){if(p.gid!==S.gid){S.wi={};}S.gid=p.gid;if(!p.legs&&!p.mode)S.mode='game';}
    if(Array.isArray(p.legs)&&p.legs.length){S.plegs=p.legs;S.mode='parlay';}
    if(p.mode&&MODES.some(m=>m[0]===p.mode))S.mode=p.mode;saveUI();}
  if(!MODES.some(m=>m[0]===S.mode))S.mode='game';
  injectCSS();
  const g=S.mode==='parlay'?null:curGame();
  let body;
  if(S.mode==='parlay')body=parlayHTML();
  else body=pickerHTML(g)+(g?(S.mode==='watch'?watchHTML(g):S.mode==='live'?liveHTML(g):gameHTML(g)):'');
  if(S.mode!=='game')body=otherRunHTML()+body;
  main.innerHTML=`<div id="simRoot" class="sm"><h2>🎲 Simulator <small>${fmtN(NSIM)} games · play by play</small></h2>
    <p class="sm-lead">Each game is played out ${fmtN(NSIM)} times, play by play, with a model tuned to match our engine’s win chances and total. It shows the spread of outcomes and markets the engine doesn’t price directly; it is not a second opinion on the engine. All results are model estimates, not guarantees.</p>
    <div class="seg sm-modes" role="tablist" aria-label="Simulator mode">${MODES.map(([k,l])=>`<button role="tab" aria-selected="${S.mode===k}" class="${S.mode===k?'on':''}" data-a="mode" data-m="${k}">${l}</button>`).join('')}</div>${body}</div>`;
  wire(main.querySelector('#simRoot'));
  if(S.mode==='watch'&&W.playing&&!W.timer)watchLoop();}
function rerender(){const root=document.getElementById('simRoot');if(!root)return;const M=SB.$('main');if(M&&M.contains(root))render(M,lastParams);}
function wire(root){if(!root)return;
  root.addEventListener('click',e=>{const b=e.target.closest('[data-a]');if(!b||!root.contains(b)||b.disabled)return;const a=b.dataset.a;if(RUN.active)DBG.clicksDuringRun++;
    switch(a){
      case 'mode':S.mode=b.dataset.m;if(S.mode!=='watch'){W.playing=false;stopTimer();}saveUI();rerender();break;
      case 'pick':S.pickOpen=!S.pickOpen;rerender();if(S.pickOpen){const i=document.getElementById('smPq');if(i)i.focus({preventScroll:true});}break;
      case 'choose':if(b.dataset.gid!==S.gid){S.gid=b.dataset.gid;S.wi={};W.playing=false;W.ev=null;stopTimer();}S.pickOpen=false;S.pq='';saveUI();rerender();break;
      case 'run':startGameRun();break;
      case 'cancel':cancelRun();break;
      case 'view':viewRun();break;
      case 'lstep':{const g=curGame();if(!g)break;const L=liveState(g),k=b.dataset.k;L[k]=Math.max(0,Math.min(9,L[k]+(+b.dataset.d||0)));paintLive();break;}
      case 'hedge':SB.goTab('odds');break;
      case 'add':{const gid=b.dataset.gid,key=b.dataset.key,was=SB.inSlip(gid,key),r=SB.toggleLeg(gid,key);
        if(!r&&!was)SB.toast('This leg can’t be added right now.');else if(r)SB.toast('Added to your parlay slip');syncAdds();break;}
      case 'wireset':S.wi={};rerender();break;
      case 'wnew':watchNew();break;
      case 'wplay':if(!W.ev)break;if(W.pos>=W.ev.steps.length-1&&!W.playing){W.pos=0;W.playing=true;}else W.playing=!W.playing;paintWatch();watchLoop();break;
      case 'wspeed':W.speed=+b.dataset.s||1;paintWatch();if(W.playing)watchLoop();break;
      case 'wskip':if(!W.ev)break;W.pos=W.ev.steps.length-1;W.playing=false;stopTimer();paintWatch();break;
      case 'prun':startParlay();break;
      case 'useslip':S.plegs=null;rerender();break;
      case 'bsrc':S.bank.src=b.dataset.s;rerender();break;
      case 'brun':startBank();break;}});
  root.addEventListener('input',e=>{const t=e.target;
    if(t.id==='smPq'){S.pq=t.value;const l=document.getElementById('smGl');if(l)l.innerHTML=pickerList();return;}
    if(t.dataset.l){const g=curGame();if(!g)return;const L=liveState(g);if(t.dataset.l==='min')L.min=Math.max(0,Math.min(90,Math.round(+t.value)));else L[t.dataset.l]=!!t.checked;paintLive();return;}
    if(t.dataset.wi){const g=curGame();if(!g)return;const d=wiDefs(g).find(x=>x.k===t.dataset.wi);if(!d)return;
      let v=d.type==='check'?t.checked:d.type==='select'?(d.num?+t.value:t.value):+t.value;S.wi[d.k]=v;
      const o=document.getElementById('smw_'+d.k+'_o');if(o&&d.out)o.textContent=d.out(v);
      const rb=document.getElementById('smRun');if(rb)rb.textContent=runLabel();
      if(S.mode==='live')paintLive();else markStale(g);return;}
    if(t.dataset.b){S.bank[t.dataset.b]=t.value;if(t.dataset.b==='bank'){const v=+t.value;if(v>0)store.set('bankroll',v);}
      const R=PAR&&PAR.sig===JSON.stringify(parLegs().map(l=>l.gid+'|'+l.key))?PAR:null,p=bankP(R),dec=SB.parseOdds(S.bank.price),kf=+store.get('kellyFrac',.25)||.25;
      const kv=document.getElementById('smBkv');if(kv)kv.innerHTML=bankKV(p,dec,p!=null&&dec?SB.ev(p,dec):null,p!=null&&dec?SB.kelly(p,dec,kf):0,kf);
      const br=root.querySelector('[data-a="brun"]');if(br)br.disabled=RUN.active||p==null||!dec;
      const bn=document.getElementById('smBpNote');if(bn)bn.hidden=!!String(S.bank.price).trim();}});
  root.addEventListener('change',e=>{const t=e.target;if(t.dataset&&t.dataset.wi&&(t.type==='checkbox'||t.tagName==='SELECT')){/* handled on input */}});
  root.addEventListener('toggle',e=>{const d=e.target;if(d.id==='smWi')S.wiOpen=d.open;else if(d.classList&&d.classList.contains('sm-conv'))S.convOpen=d.open;else if(d.dataset&&d.dataset.grp)S.dOpen[d.dataset.grp]=d.open;},true);}
/* what-if controls moved after a run: show the cached result for the new settings, else mark the shown numbers as stale */
function markStale(g){const w=document.querySelector('#smRes .sm-resw');if(!w)return;const wk=wiKey(S.wi),shown=w.dataset.wk||'';
  if(wk!==shown&&CACHE.has(ckey(g,wk))){const r=document.getElementById('smRes');if(r)r.innerHTML=resultsHTML(g);return;}
  const st=wk!==shown;w.classList.toggle('sm-stale',st);const b=document.getElementById('smStale');
  if(st&&!b)w.insertAdjacentHTML('afterbegin',`<div class="lineup" id="smStale"><span>Settings changed: tap <b>${wk?'Run what-if':'Run 100,000 sims'}</b> to update these numbers.</span></div>`);
  else if(!st&&b)b.remove();}
function syncAdds(){document.querySelectorAll('#simRoot .sm-add[data-key]').forEach(b=>{const ins=SB.inSlip(b.dataset.gid,b.dataset.key);b.classList.toggle('in',ins);b.textContent=ins?'✓':'+';});}
S.dOpen={};

SB.on('slip',()=>{if(!document.getElementById('simRoot'))return;if(S.mode==='parlay'&&!S.plegs&&!RUN.active)rerender();else if(S.mode==='live')paintLive();else syncAdds();});
SB.registerTab({key:'sim',label:'🎲 Simulator',after:'trending',render});
})();
