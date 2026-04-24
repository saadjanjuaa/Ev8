export const ENGINE_HTML = `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{margin:0;padding:0}html,body{width:100%;height:100%;background:transparent;overflow:hidden}</style>
</head><body><script>
(function(){
'use strict';

var IDLE=720, MAX=7000, RED=6500;
var ctx=null, nodes={}, active=false;
var harmFilts=[];
var curRPM=IDLE, tgtRPM=IDLE, curThr=0, lastThr=0;
var rafId=null, lastTs=0, bovCD=0, popCD=0;

function clamp(v,a,b){return v<a?a:v>b?b:v;}

/*
  CORE SYNTHESIS PHILOSOPHY
  ─────────────────────────
  Real engines sound organic because combustion impulses drive the
  acoustic resonances of the exhaust/intake system — it is fundamentally
  FILTERED NOISE, not a clean oscillator.

  Architecture:
    pinkNoise → 8 resonant bandpass filters (harmonics of fireHz)
    → engMix → saturation → reverb → EQ → compressor → master

  Each filter is tuned to harmonic n × fireHz(rpm).
  Harmonic 3 is dominant (RB26 inline-6 bark character).
  Q increases with RPM → more "singing" ring at high revs vs woody
  thump at idle. Natural noise variation prevents the robotic quality.
*/

/* Harmonic profile: {n=harmonic, baseQ, amp} */
var HARM = [
  {n:1, q:7,  a:1.00},
  {n:2, q:5,  a:0.28},
  {n:3, q:14, a:0.95},  /* 3rd dominant — RB26 bark */
  {n:4, q:4,  a:0.13},
  {n:5, q:9,  a:0.32},
  {n:6, q:3,  a:0.09},
  {n:7, q:7,  a:0.18},
  {n:8, q:2,  a:0.06},
];

/* ── Pink noise (4-second looping buffer, Paul Kellett method) ── */
function makePink() {
  var sr=ctx.sampleRate, len=sr*4;
  var buf=ctx.createBuffer(1,len,sr), d=buf.getChannelData(0);
  var b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
  for(var i=0;i<len;i++){
    var w=Math.random()*2-1;
    b0=0.99886*b0+w*0.0555179; b1=0.99332*b1+w*0.0750759;
    b2=0.96900*b2+w*0.1538520; b3=0.86650*b3+w*0.3104856;
    b4=0.55000*b4+w*0.5329522; b5=-0.7616*b5-w*0.0168980;
    d[i]=clamp((b0+b1+b2+b3+b4+b5+b6+w*0.5362)*0.11,-1,1);
    b6=w*0.115926;
  }
  var s=ctx.createBufferSource(); s.buffer=buf; s.loop=true; s.start(0);
  return s;
}

/* ── Exhaust pipe IR — straight-pipe resonant character ── */
function makeExhaustIR() {
  var sr=ctx.sampleRate, len=Math.floor(sr*0.32);
  var buf=ctx.createBuffer(2,len,sr);
  for(var ch=0;ch<2;ch++){
    var d=buf.getChannelData(ch);
    for(var i=0;i<len;i++){
      var t=i/sr, pre=0.004;
      if(t<pre){d[i]=0;continue;}
      var dec=Math.exp(-(t-pre)*18);
      var er=(i>Math.floor(0.016*sr))?d[i-Math.floor(0.016*sr)]*0.40:0;
      d[i]=((Math.random()*2-1)*dec+er)*(ch===0?1:0.86);
    }
  }
  return buf;
}

/* ── Warm tape-style soft saturation ── */
function makeSat(drive) {
  var N=512, c=new Float32Array(N);
  for(var i=0;i<N;i++){
    var x=(i*2/N)-1;
    var y=Math.tanh(x*drive);
    c[i]=clamp(y,-1,1);
  }
  return c;
}

function fireHz(rpm){return (rpm/60)*3;}
function t1Hz(f){return 180+Math.pow(f,1.3)*3600;}
function t2Hz(f){return 165+Math.pow(f,1.3)*3400;}

/* ── Build audio graph ── */
function buildGraph() {
  var t=ctx.currentTime, hz=fireHz(IDLE);
  harmFilts=[];

  /* master */
  nodes.master=ctx.createGain(); nodes.master.gain.setValueAtTime(0,t);
  nodes.master.connect(ctx.destination);

  nodes.comp=ctx.createDynamicsCompressor();
  nodes.comp.threshold.value=-8; nodes.comp.knee.value=10;
  nodes.comp.ratio.value=3; nodes.comp.attack.value=0.003;
  nodes.comp.release.value=0.12; nodes.comp.connect(nodes.master);

  /* EQ chain */
  nodes.hiShelf=ctx.createBiquadFilter();
  nodes.hiShelf.type='highshelf'; nodes.hiShelf.frequency.value=6500;
  nodes.hiShelf.gain.value=1; nodes.hiShelf.connect(nodes.comp);

  /* Exhaust fixed resonance — the "voice" of a straight-pipe exhaust.
     This peak stays at a fixed frequency regardless of RPM, giving
     the engine a consistent character (just like a real exhaust pipe). */
  nodes.exhaust=ctx.createBiquadFilter();
  nodes.exhaust.type='peaking'; nodes.exhaust.frequency.value=750;
  nodes.exhaust.Q.value=1.8; nodes.exhaust.gain.value=8;
  nodes.exhaust.connect(nodes.hiShelf);

  nodes.pres=ctx.createBiquadFilter();
  nodes.pres.type='peaking'; nodes.pres.frequency.value=450;
  nodes.pres.Q.value=0.8; nodes.pres.gain.value=5;
  nodes.pres.connect(nodes.exhaust);

  nodes.bass=ctx.createBiquadFilter();
  nodes.bass.type='peaking'; nodes.bass.frequency.value=100;
  nodes.bass.Q.value=0.65; nodes.bass.gain.value=8;
  nodes.bass.connect(nodes.pres);

  nodes.finalLP=ctx.createBiquadFilter();
  nodes.finalLP.type='lowpass'; nodes.finalLP.frequency.value=6000;
  nodes.finalLP.Q.value=0.5; nodes.finalLP.connect(nodes.bass);

  /* reverb */
  nodes.reverb=ctx.createConvolver(); nodes.reverb.buffer=makeExhaustIR();
  nodes.reverbGain=ctx.createGain(); nodes.reverbGain.gain.value=0.6;
  nodes.reverbDry=ctx.createGain(); nodes.reverbDry.gain.value=0.6;
  nodes.reverbDry.connect(nodes.finalLP);
  nodes.reverbGain.connect(nodes.reverb); nodes.reverb.connect(nodes.finalLP);

  nodes.outputHP=ctx.createBiquadFilter();
  nodes.outputHP.type='highpass'; nodes.outputHP.frequency.value=55;
  nodes.outputHP.Q.value=0.65;
  nodes.outputHP.connect(nodes.reverbDry); nodes.outputHP.connect(nodes.reverbGain);

  /* saturation */
  nodes.postLP=ctx.createBiquadFilter();
  nodes.postLP.type='lowpass'; nodes.postLP.frequency.value=2500;
  nodes.postLP.Q.value=0.4; nodes.postLP.connect(nodes.outputHP);

  nodes.dist=ctx.createWaveShaper();
  nodes.dist.curve=makeSat(2.5); nodes.dist.oversample='4x';
  nodes.dist.connect(nodes.postLP);

  nodes.drive=ctx.createGain(); nodes.drive.gain.value=2.0;
  nodes.drive.connect(nodes.dist);

  nodes.engMix=ctx.createGain(); nodes.engMix.gain.value=0.55;
  nodes.engMix.connect(nodes.drive);

  /* ── Harmonic resonator bank (the core engine tone) ──────────────
     Pink noise → N narrow bandpass filters, each at n×fireHz.
     The noise keeps the sound organic; the Q gives each harmonic its ring.
  ── */
  var pinkEng=makePink();
  for(var i=0;i<HARM.length;i++){
    var h=HARM[i];
    var flt=ctx.createBiquadFilter();
    flt.type='bandpass';
    flt.frequency.setValueAtTime(hz*h.n,t);
    flt.Q.value=h.q;
    var g=ctx.createGain();
    g.gain.setValueAtTime(h.a*0.55,t);
    pinkEng.connect(flt); flt.connect(g); g.connect(nodes.engMix);
    harmFilts.push({flt:flt, g:g, h:h});
  }

  /* ── Sub-bass (crank frequency sine — low rumble) ── */
  nodes.oscSub=ctx.createOscillator(); nodes.oscSub.type='sine';
  nodes.oscSub.frequency.setValueAtTime(hz/3,t);
  nodes.gainSub=ctx.createGain(); nodes.gainSub.gain.setValueAtTime(0.60,t);
  nodes.oscSub.connect(nodes.gainSub); nodes.gainSub.connect(nodes.engMix);
  nodes.oscSub.start();

  /* ── Twin turbo whine ── */
  nodes.t1=ctx.createOscillator(); nodes.t1.type='sawtooth';
  nodes.t1.frequency.setValueAtTime(t1Hz(0),t);
  nodes.t1f=ctx.createBiquadFilter(); nodes.t1f.type='bandpass';
  nodes.t1f.frequency.setValueAtTime(t1Hz(0),t); nodes.t1f.Q.value=28;
  nodes.t1g=ctx.createGain(); nodes.t1g.gain.setValueAtTime(0,t);
  nodes.t1.connect(nodes.t1f); nodes.t1f.connect(nodes.t1g);

  nodes.t2=ctx.createOscillator(); nodes.t2.type='sawtooth';
  nodes.t2.frequency.setValueAtTime(t2Hz(0),t);
  nodes.t2f=ctx.createBiquadFilter(); nodes.t2f.type='bandpass';
  nodes.t2f.frequency.setValueAtTime(t2Hz(0),t); nodes.t2f.Q.value=20;
  nodes.t2g=ctx.createGain(); nodes.t2g.gain.setValueAtTime(0,t);
  nodes.t2.connect(nodes.t2f); nodes.t2f.connect(nodes.t2g);

  nodes.turboMix=ctx.createGain(); nodes.turboMix.gain.value=1;
  nodes.t1g.connect(nodes.turboMix); nodes.t2g.connect(nodes.turboMix);
  nodes.turboMix.connect(nodes.finalLP);

  /* ── Induction air noise (whoosh under boost) ── */
  var pinkInd=makePink();
  nodes.indHP=ctx.createBiquadFilter(); nodes.indHP.type='highpass';
  nodes.indHP.frequency.value=900;
  nodes.indBP=ctx.createBiquadFilter(); nodes.indBP.type='bandpass';
  nodes.indBP.frequency.value=2800; nodes.indBP.Q.value=0.6;
  nodes.indG=ctx.createGain(); nodes.indG.gain.value=0;
  pinkInd.connect(nodes.indHP); nodes.indHP.connect(nodes.indBP);
  nodes.indBP.connect(nodes.indG); nodes.indG.connect(nodes.finalLP);

  /* ── Exhaust pops and BOV (each gets its own pink noise source) ── */
  var pinkPop=makePink();
  nodes.popF=ctx.createBiquadFilter(); nodes.popF.type='bandpass';
  nodes.popF.frequency.value=850; nodes.popF.Q.value=3.5;
  nodes.popG=ctx.createGain(); nodes.popG.gain.setValueAtTime(0,t);
  pinkPop.connect(nodes.popF); nodes.popF.connect(nodes.popG);
  nodes.popG.connect(nodes.comp);

  var pinkBOV=makePink();
  nodes.bovHP=ctx.createBiquadFilter(); nodes.bovHP.type='highpass';
  nodes.bovHP.frequency.value=400;
  nodes.bovF=ctx.createBiquadFilter(); nodes.bovF.type='bandpass';
  nodes.bovF.frequency.value=1200; nodes.bovF.Q.value=2.2;
  nodes.bovG=ctx.createGain(); nodes.bovG.gain.setValueAtTime(0,t);
  pinkBOV.connect(nodes.bovHP); nodes.bovHP.connect(nodes.bovF);
  nodes.bovF.connect(nodes.bovG); nodes.bovG.connect(nodes.comp);

  [nodes.t1,nodes.t2].forEach(function(o){o.start();});
}

/* ── BOV ── */
function triggerBOV(intensity) {
  if(!ctx||!active) return;
  var t=ctx.currentTime, dur=0.12+intensity*0.28, vol=0.60+intensity*0.50;
  nodes.bovF.frequency.cancelScheduledValues(t);
  nodes.bovF.frequency.setValueAtTime(1400+intensity*1600,t);
  nodes.bovF.frequency.exponentialRampToValueAtTime(260,t+dur);
  nodes.bovG.gain.cancelScheduledValues(t);
  nodes.bovG.gain.setValueAtTime(0,t);
  nodes.bovG.gain.linearRampToValueAtTime(vol,t+0.01);
  nodes.bovG.gain.exponentialRampToValueAtTime(0.001,t+dur);
}

/* ── Exhaust pop ── */
function triggerPop() {
  if(!ctx||!active) return;
  var t=ctx.currentTime;
  nodes.popF.frequency.setValueAtTime(500+Math.random()*900,t);
  nodes.popG.gain.cancelScheduledValues(t);
  nodes.popG.gain.setValueAtTime(0,t);
  nodes.popG.gain.linearRampToValueAtTime(0.70,t+0.004);
  nodes.popG.gain.exponentialRampToValueAtTime(0.001,t+0.045+Math.random()*0.04);
}

/* ── Gear shift clunk + volume dip ── */
function triggerGearShift() {
  if(!ctx||!active) return;
  var t=ctx.currentTime;
  nodes.popF.frequency.setValueAtTime(80+Math.random()*50,t);
  nodes.popG.gain.cancelScheduledValues(t);
  nodes.popG.gain.setValueAtTime(0,t);
  nodes.popG.gain.linearRampToValueAtTime(0.55,t+0.007);
  nodes.popG.gain.exponentialRampToValueAtTime(0.001,t+0.15);
  nodes.master.gain.cancelScheduledValues(t);
  nodes.master.gain.setValueAtTime(0.88,t);
  nodes.master.gain.linearRampToValueAtTime(0.25,t+0.045);
  nodes.master.gain.linearRampToValueAtTime(0.88,t+0.22);
}

/* ── RAF update loop ── */
function startLoop() {
  if(rafId) cancelAnimationFrame(rafId);
  lastTs=performance.now();
  function loop(ts){
    var dt=Math.min((ts-lastTs)/1000,0.08); lastTs=ts;
    var diff=tgtRPM-curRPM;
    curRPM+=diff*(diff>0?4.2:2.8)*dt;
    curRPM=clamp(curRPM,IDLE*0.93,MAX);

    if(bovCD>0) bovCD-=dt;
    else if(lastThr>0.28&&curThr<0.07&&curRPM>1800){
      triggerBOV(clamp((curRPM-1500)/4000,0,1));
      bovCD=0.65;
    }
    if(popCD>0) popCD-=dt;
    else if(curRPM>2200&&tgtRPM<curRPM-300){
      if(Math.random()<clamp((curRPM-2000)/4000,0,1)*0.70){
        triggerPop(); popCD=0.025+Math.random()*0.07;
      }
    }
    lastThr=curThr;
    update(curRPM,curThr);
    rafId=requestAnimationFrame(loop);
  }
  rafId=requestAnimationFrame(loop);
}

/* ── Per-frame parameter update ── */
function update(rpm,thr){
  if(!ctx||!active) return;
  var t=ctx.currentTime, tau=0.05;
  var hz=fireHz(rpm);
  var frac=clamp((rpm-IDLE)/(MAX-IDLE),0,1);
  var engDom=clamp(1-Math.pow(frac,0.65)*0.55,0.40,1);

  /* Harmonic resonators — frequency and Q track RPM */
  for(var i=0;i<harmFilts.length;i++){
    var hf=harmFilts[i], h=hf.h;
    var freq=hz*h.n;
    hf.flt.frequency.setTargetAtTime(freq,t,tau);
    /* Q rises with RPM: more "singing" ring at high revs */
    hf.flt.Q.value=h.q*(0.55+frac*0.80);
    /* Higher harmonics (n≥5) grow with RPM — high-rev scream character */
    var ampScale = h.n<=3 ? engDom : engDom*(0.25+frac*0.90);
    hf.g.gain.setTargetAtTime(h.a*0.55*ampScale+thr*h.a*0.08,t,tau);
  }

  /* Sub */
  nodes.oscSub.frequency.setTargetAtTime(hz/3,t,tau);
  nodes.gainSub.gain.setTargetAtTime(0.60*engDom+0.08,t,tau);

  /* Saturation opens with throttle and RPM */
  nodes.engMix.gain.setTargetAtTime(0.50+thr*0.22,t,tau);
  nodes.drive.gain.setTargetAtTime(1.8+thr*3.0+frac*1.5,t,tau);
  nodes.dist.curve=makeSat(2.2+thr*3.5+frac*1.8);
  nodes.postLP.frequency.setTargetAtTime(1400+frac*4000+thr*1200,t,tau);

  /* Reverb — more wet under load (exhaust resonance) */
  nodes.reverbGain.gain.setTargetAtTime(0.50+thr*0.35,t,tau);
  nodes.reverbDry.gain.setTargetAtTime(0.68-thr*0.10,t,tau);

  /* Fixed exhaust resonance peak — stays at 750 Hz regardless of RPM */
  nodes.exhaust.gain.setTargetAtTime(7+thr*4,t,tau);

  /* Turbo whine */
  var turboBase=Math.pow(clamp(frac-0.08,0,1)/0.92,1.6);
  var turboVol=turboBase*0.50+thr*turboBase*0.50;
  var tf1=t1Hz(frac), tf2=t2Hz(frac);
  nodes.t1.frequency.setTargetAtTime(tf1,t,tau);
  nodes.t1f.frequency.setTargetAtTime(tf1,t,tau);
  nodes.t2.frequency.setTargetAtTime(tf2,t,tau);
  nodes.t2f.frequency.setTargetAtTime(tf2,t,tau);
  nodes.t1g.gain.setTargetAtTime(clamp(turboVol,0,0.80),t,tau);
  nodes.t2g.gain.setTargetAtTime(clamp(turboVol*0.78,0,0.65),t,tau);

  /* Induction whoosh */
  var indVol=Math.pow(frac,2.0)*0.16+thr*frac*0.24;
  nodes.indG.gain.setTargetAtTime(clamp(indVol,0,0.38),t,tau);
  nodes.indBP.frequency.setTargetAtTime(900+frac*5000+thr*1800,t,tau);

  /* Bass rolls off at high RPM (engine loses low end above 4k) */
  nodes.bass.gain.setTargetAtTime(9-frac*5,t,tau);
  nodes.pres.frequency.setTargetAtTime(340+frac*350,t,tau);
  nodes.pres.gain.setTargetAtTime(4+thr*4,t,tau);
  nodes.finalLP.frequency.setTargetAtTime(3500+frac*4000,t,tau);

  /* Rev limiter */
  if(rpm>RED){
    nodes.master.gain.setTargetAtTime(0.88*(1-(rpm-RED)/(MAX-RED)*0.60),t,0.005);
  } else {
    nodes.master.gain.setTargetAtTime(0.88,t,tau);
  }
}

/* ── Message handler ── */
function onMsg(evt){
  var msg; try{msg=JSON.parse(evt.data);}catch(e){return;}
  if(!msg||!msg.type) return;
  switch(msg.type){
    case 'start':
      if(!ctx){
        ctx=new(window.AudioContext||window.webkitAudioContext)();
        buildGraph();
      }
      ctx.resume().then(function(){
        tgtRPM=960; setTimeout(function(){tgtRPM=IDLE;},650);
        setTimeout(function(){nodes.master.gain.setTargetAtTime(0.88,ctx.currentTime,0.3);},40);
        active=true; startLoop();
      });
      break;
    case 'stop':
      active=false;
      if(rafId){cancelAnimationFrame(rafId);rafId=null;}
      if(ctx) nodes.master.gain.setTargetAtTime(0,ctx.currentTime,0.55);
      curRPM=IDLE; tgtRPM=IDLE; curThr=0; lastThr=0;
      break;
    case 'setRPM':
      tgtRPM=clamp(msg.rpm||IDLE,IDLE,MAX);
      curThr=clamp(msg.throttle||0,0,1);
      break;
    case 'gearShift':
      triggerGearShift();
      break;
  }
}
window.addEventListener('message',onMsg);
document.addEventListener('message',onMsg);
document.addEventListener('touchstart',function(){
  if(ctx&&ctx.state==='suspended') ctx.resume();
},{passive:true});

function postRN(d){try{if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify(d));}catch(e){}}
postRN({type:'ready'});
})();
</script></body></html>`;
