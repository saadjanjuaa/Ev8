export const ENGINE_HTML = `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{margin:0;padding:0}html,body{width:100%;height:100%;background:transparent;overflow:hidden}</style>
</head><body><script>
(function(){
'use strict';

/* ════════════════════════════════════════════════════════════════════════
   RB26DETT PHYSICAL ENGINE SYNTHESIS
   Technique sourced from engine-sim (github.com/ange-yaghi/engine-sim):

   1.  Combustion pressure pulses fired at exact firing frequency
   2.  Exhaust pipe transit delay  (DelayNode, L/c = 1.75 ms)
   3.  Pipe resonances shaped by physical geometry:
         primary header 600 mm → 286 Hz
         collector      400 mm → 429 Hz
   4.  Derivative-style envelope on each burst (rate-of-pressure-change)
   5.  Timing jitter ±0.5 ms (engine-sim jitter filter equivalent)
   6.  Two-tap exhaust IR mirrors 18 ms + 30 ms pipe reflections

   RB26DETT: inline-6, 3 firing events / revolution
════════════════════════════════════════════════════════════════════════ */

var IDLE=800, MAX=8000, RED=7000;

/* RB26DETT exhaust geometry */
var PRIMARY_LEN = 0.60;                              /* m  */
var COLLECTOR_LEN = 0.40;                            /* m  */
var C_SND = 343;                                     /* m/s */
var PIPE_DELAY    = PRIMARY_LEN  / C_SND;            /* 1.75 ms */
var PRIMARY_RES   = C_SND / (2 * PRIMARY_LEN);      /* 286 Hz  */
var COLLECTOR_RES = C_SND / (2 * COLLECTOR_LEN);    /* 429 Hz  */

var ctx=null, nodes={}, active=false;
var burstBuf=null;
var curRPM=IDLE, tgtRPM=IDLE, curThr=0, lastThr=0;
var rafId=null, lastTs=0;
var bovCD=0, popCD=0;

/* Scheduler */
var nextFire=0, schedTimer=null;
var SCHED_AHEAD=0.10;
var SCHED_INT=25;
var MAX_NODES=48;
var liveNodes=0;

function clamp(v,a,b){return v<a?a:v>b?b:v;}
function fireHz(rpm){return (rpm/60)*3;}    /* inline-6: 3 firings/rev */
function crankHz(rpm){return rpm/60;}
function turboF1(f){return 190+Math.pow(f,1.2)*4200;}
function turboF2(f){return 175+Math.pow(f,1.2)*3900;}

/* ── Looping pink noise source ── */
function makePinkNoise(){
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

/* ── Combustion burst: 60 ms shaped pink noise.
   Envelope = derivative of a cylinder pressure pulse (engine-sim technique):
     - Linear rise to 0.5 ms (pressure rising fastest = loudest transient)
     - Exp decay at 35/s (~28 ms time-constant) = pressure settling
     - 286 Hz sine ring × exp(-22t) = primary header resonance excited by pulse
   This gives the "crack-then-ring" that real exhausts produce, rather than
   the blob-shaped burst we had before.                                     ── */
function makeBurst(){
  var sr=ctx.sampleRate, dur=0.060;
  var len=Math.floor(sr*dur);
  var buf=ctx.createBuffer(1,len,sr), d=buf.getChannelData(0);
  var b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
  var T_PEAK=0.0005;
  for(var i=0;i<len;i++){
    var t=i/sr;
    var body=Math.min(t/T_PEAK,1)*Math.exp(-t*35);
    var ring=Math.sin(2*Math.PI*PRIMARY_RES*t)*Math.exp(-t*22)*0.32;
    var env=body+ring;
    var w=Math.random()*2-1;
    b0=0.99886*b0+w*0.0555179; b1=0.99332*b1+w*0.0750759;
    b2=0.96900*b2+w*0.1538520; b3=0.86650*b3+w*0.3104856;
    b4=0.55000*b4+w*0.5329522; b5=-0.7616*b5-w*0.0168980;
    var noise=clamp((b0+b1+b2+b3+b4+b5+b6+w*0.5362)*0.11,-1,1);
    b6=w*0.115926;
    d[i]=noise*env*2.8;
  }
  return buf;
}

/* ── Exhaust IR: two echo taps at 18 ms (primary) and 30 ms (collector) ──
   Mirrors the physical reflections in engine-sim's impulse response wav.   ── */
function makeExhaustIR(){
  var sr=ctx.sampleRate, len=Math.floor(sr*0.22);
  var buf=ctx.createBuffer(2,len,sr);
  for(var ch=0;ch<2;ch++){
    var d=buf.getChannelData(ch);
    var tap1=Math.floor(0.018*sr), tap2=Math.floor(0.030*sr);
    for(var i=0;i<len;i++){
      var t=i/sr, dec=Math.exp(-t*20);
      var e1=(i>tap1)?d[i-tap1]*0.38:0;
      var e2=(i>tap2)?d[i-tap2]*0.20:0;
      d[i]=((Math.random()*2-1)*dec+e1+e2)*(ch===0?1:0.82);
    }
  }
  return buf;
}

function makeSat(drive){
  var N=512, c=new Float32Array(N);
  for(var i=0;i<N;i++){
    var x=(i*2/N)-1;
    c[i]=clamp(Math.tanh(x*drive),-1,1);
  }
  return c;
}

/* ── Build audio graph ──
   Signal flow (engine-sim inspired):
     burstMix
       → exhDelay   (pipe transit: 1.75 ms)
       → harmBP     (tracks 3×fireHz overtone)
       → exhPrimary (286 Hz, fixed pipe resonance)
       → exhCollector (429 Hz, fixed collector resonance)
       → resLP / resHP
       → engineMix → satDrive → sat → reverb → bass EQ → comp → master ── */
function buildGraph(){
  var t=ctx.currentTime;

  nodes.master=ctx.createGain(); nodes.master.gain.setValueAtTime(0,t);
  nodes.master.connect(ctx.destination);

  /* Compressor (leveling, engine-sim levelerFilter equivalent) */
  nodes.comp=ctx.createDynamicsCompressor();
  nodes.comp.threshold.value=-7; nodes.comp.knee.value=8;
  nodes.comp.ratio.value=2.8; nodes.comp.attack.value=0.003;
  nodes.comp.release.value=0.09; nodes.comp.connect(nodes.master);

  /* Output EQ */
  nodes.hi=ctx.createBiquadFilter();
  nodes.hi.type='highshelf'; nodes.hi.frequency.value=4500; nodes.hi.gain.value=-3;
  nodes.hi.connect(nodes.comp);

  nodes.pres=ctx.createBiquadFilter();
  nodes.pres.type='peaking'; nodes.pres.frequency.value=480;
  nodes.pres.Q.value=0.8; nodes.pres.gain.value=5; nodes.pres.connect(nodes.hi);

  nodes.bass=ctx.createBiquadFilter();
  nodes.bass.type='peaking'; nodes.bass.frequency.value=88;
  nodes.bass.Q.value=0.65; nodes.bass.gain.value=9; nodes.bass.connect(nodes.pres);

  /* Short exhaust-pipe reverb */
  nodes.reverb=ctx.createConvolver(); nodes.reverb.buffer=makeExhaustIR();
  nodes.reverbWet=ctx.createGain(); nodes.reverbWet.gain.value=0.42;
  nodes.reverbDry=ctx.createGain(); nodes.reverbDry.gain.value=0.80;
  nodes.reverbDry.connect(nodes.bass);
  nodes.reverbWet.connect(nodes.reverb); nodes.reverb.connect(nodes.bass);

  /* Saturation (warmth + RB26 grit) */
  nodes.sat=ctx.createWaveShaper();
  nodes.sat.curve=makeSat(2.8); nodes.sat.oversample='2x';
  nodes.satDrive=ctx.createGain(); nodes.satDrive.gain.value=1.8;
  nodes.satDrive.connect(nodes.sat);
  nodes.sat.connect(nodes.reverbDry); nodes.sat.connect(nodes.reverbWet);

  /* Engine mix */
  nodes.engineMix=ctx.createGain(); nodes.engineMix.gain.value=0.85;
  nodes.engineMix.connect(nodes.satDrive);

  /* HP gate */
  nodes.resHP=ctx.createBiquadFilter();
  nodes.resHP.type='highpass'; nodes.resHP.frequency.value=50; nodes.resHP.Q.value=0.5;
  nodes.resHP.connect(nodes.engineMix);

  /* LP opens with RPM */
  nodes.resLP=ctx.createBiquadFilter();
  nodes.resLP.type='lowpass'; nodes.resLP.frequency.setValueAtTime(2000,t);
  nodes.resLP.Q.value=0.85; nodes.resLP.connect(nodes.resHP);

  /* Collector resonance 429 Hz — fixed pipe geometry */
  nodes.exhCollector=ctx.createBiquadFilter();
  nodes.exhCollector.type='peaking'; nodes.exhCollector.frequency.value=COLLECTOR_RES;
  nodes.exhCollector.Q.value=3.0; nodes.exhCollector.gain.value=6;
  nodes.exhCollector.connect(nodes.resLP);

  /* Primary header resonance 286 Hz — fixed pipe geometry */
  nodes.exhPrimary=ctx.createBiquadFilter();
  nodes.exhPrimary.type='peaking'; nodes.exhPrimary.frequency.value=PRIMARY_RES;
  nodes.exhPrimary.Q.value=2.5; nodes.exhPrimary.gain.value=10;
  nodes.exhPrimary.connect(nodes.exhCollector);

  /* Harmonic BP tracks RPM-dependent firing overtone (3×fireHz) */
  nodes.harmBP=ctx.createBiquadFilter();
  nodes.harmBP.type='peaking';
  nodes.harmBP.frequency.setValueAtTime(3*fireHz(IDLE),t);
  nodes.harmBP.Q.value=4.5; nodes.harmBP.gain.value=8;
  nodes.harmBP.connect(nodes.exhPrimary);

  /* Exhaust pipe transit delay — DelayNode equivalent of engine-sim delay filter */
  nodes.exhDelay=ctx.createDelay(0.020);
  nodes.exhDelay.delayTime.value=PIPE_DELAY;
  nodes.exhDelay.connect(nodes.harmBP);

  /* Burst mix — all combustion BufferSources land here */
  nodes.burstMix=ctx.createGain(); nodes.burstMix.gain.value=1.0;
  nodes.burstMix.connect(nodes.exhDelay);

  /* Sub-bass at crank frequency */
  nodes.oscSub=ctx.createOscillator(); nodes.oscSub.type='sine';
  nodes.oscSub.frequency.setValueAtTime(crankHz(IDLE),t);
  nodes.gainSub=ctx.createGain(); nodes.gainSub.gain.value=0.52;
  nodes.oscSub.connect(nodes.gainSub); nodes.gainSub.connect(nodes.engineMix);
  nodes.oscSub.start();

  /* Pink-noise floor (prevents dead silence between idle bursts) */
  var pinkFloor=makePinkNoise();
  nodes.floorLP=ctx.createBiquadFilter();
  nodes.floorLP.type='lowpass'; nodes.floorLP.frequency.value=600;
  nodes.floorG=ctx.createGain(); nodes.floorG.gain.value=0.05;
  pinkFloor.connect(nodes.floorLP); nodes.floorLP.connect(nodes.floorG);
  nodes.floorG.connect(nodes.engineMix);

  /* Twin turbo whine */
  nodes.t1=ctx.createOscillator(); nodes.t1.type='sawtooth';
  nodes.t1.frequency.setValueAtTime(turboF1(0),t);
  nodes.t1f=ctx.createBiquadFilter(); nodes.t1f.type='bandpass';
  nodes.t1f.frequency.setValueAtTime(turboF1(0),t); nodes.t1f.Q.value=30;
  nodes.t1g=ctx.createGain(); nodes.t1g.gain.setValueAtTime(0,t);
  nodes.t1.connect(nodes.t1f); nodes.t1f.connect(nodes.t1g); nodes.t1g.connect(nodes.bass);

  nodes.t2=ctx.createOscillator(); nodes.t2.type='sawtooth';
  nodes.t2.frequency.setValueAtTime(turboF2(0),t);
  nodes.t2f=ctx.createBiquadFilter(); nodes.t2f.type='bandpass';
  nodes.t2f.frequency.setValueAtTime(turboF2(0),t); nodes.t2f.Q.value=22;
  nodes.t2g=ctx.createGain(); nodes.t2g.gain.setValueAtTime(0,t);
  nodes.t2.connect(nodes.t2f); nodes.t2f.connect(nodes.t2g); nodes.t2g.connect(nodes.bass);

  /* BOV */
  var pinkBOV=makePinkNoise();
  nodes.bovHP=ctx.createBiquadFilter(); nodes.bovHP.type='highpass'; nodes.bovHP.frequency.value=350;
  nodes.bovF=ctx.createBiquadFilter(); nodes.bovF.type='bandpass';
  nodes.bovF.frequency.value=1200; nodes.bovF.Q.value=2.2;
  nodes.bovG=ctx.createGain(); nodes.bovG.gain.setValueAtTime(0,t);
  pinkBOV.connect(nodes.bovHP); nodes.bovHP.connect(nodes.bovF);
  nodes.bovF.connect(nodes.bovG); nodes.bovG.connect(nodes.comp);

  /* Exhaust pop */
  var pinkPop=makePinkNoise();
  nodes.popF=ctx.createBiquadFilter(); nodes.popF.type='bandpass';
  nodes.popF.frequency.value=820; nodes.popF.Q.value=3;
  nodes.popG=ctx.createGain(); nodes.popG.gain.setValueAtTime(0,t);
  pinkPop.connect(nodes.popF); nodes.popF.connect(nodes.popG); nodes.popG.connect(nodes.comp);

  [nodes.t1,nodes.t2].forEach(function(o){o.start();});
}

/* ── Fire one combustion burst.
   Jitter ±0.5 ms = engine-sim jitter filter.
   Gain 0.80–1.20 = cylinder-to-cylinder variation.                        ── */
function fireBurst(when){
  if(liveNodes>=MAX_NODES) return;
  var jitter=(Math.random()-0.5)*0.001;
  var t=Math.max(ctx.currentTime,when+jitter);
  var src=ctx.createBufferSource();
  src.buffer=burstBuf;
  src.detune.value=(Math.random()-0.5)*35;
  var g=ctx.createGain();
  g.gain.value=0.80+Math.random()*0.40;
  src.connect(g); g.connect(nodes.burstMix);
  src.start(t);
  liveNodes++;
  src.onended=function(){ liveNodes--; src.disconnect(); g.disconnect(); };
}

/* ── Look-ahead burst scheduler ── */
function scheduleBursts(){
  if(!active||!ctx||!burstBuf) return;
  var now=ctx.currentTime;
  var interval=1/fireHz(curRPM);
  if(nextFire<now-0.01) nextFire=now+0.01;
  var horizon=now+SCHED_AHEAD;
  while(nextFire<horizon){ fireBurst(nextFire); nextFire+=interval; }
}

/* ── BOV: sweeping bandpass noise on throttle release ── */
function triggerBOV(intensity){
  if(!ctx||!active) return;
  var t=ctx.currentTime, dur=0.12+intensity*0.32, vol=0.60+intensity*0.45;
  nodes.bovF.frequency.cancelScheduledValues(t);
  nodes.bovF.frequency.setValueAtTime(1600+intensity*1600,t);
  nodes.bovF.frequency.exponentialRampToValueAtTime(260,t+dur);
  nodes.bovG.gain.cancelScheduledValues(t);
  nodes.bovG.gain.setValueAtTime(0,t);
  nodes.bovG.gain.linearRampToValueAtTime(vol,t+0.010);
  nodes.bovG.gain.exponentialRampToValueAtTime(0.001,t+dur);
}

/* ── Exhaust pop ── */
function triggerPop(){
  if(!ctx||!active) return;
  var t=ctx.currentTime;
  nodes.popF.frequency.setValueAtTime(400+Math.random()*1000,t);
  nodes.popG.gain.cancelScheduledValues(t);
  nodes.popG.gain.setValueAtTime(0,t);
  nodes.popG.gain.linearRampToValueAtTime(0.80,t+0.005);
  nodes.popG.gain.exponentialRampToValueAtTime(0.001,t+0.045+Math.random()*0.05);
}

/* ── Gear shift: volume duck + mechanical thunk ── */
function gearShift(dir){
  if(!ctx||!active) return;
  var t=ctx.currentTime;
  nodes.master.gain.cancelScheduledValues(t);
  nodes.master.gain.setValueAtTime(0.9,t);
  nodes.master.gain.linearRampToValueAtTime(0.28,t+0.04);
  nodes.master.gain.linearRampToValueAtTime(0.9,t+0.21);
  var click=ctx.createOscillator(); click.type='square';
  click.frequency.value=dir==='down'?110:72;
  var cF=ctx.createBiquadFilter(); cF.type='bandpass';
  cF.frequency.value=dir==='down'?250:155; cF.Q.value=5;
  var cG=ctx.createGain(); cG.gain.value=0;
  click.connect(cF); cF.connect(cG); cG.connect(nodes.comp);
  click.start(t);
  cG.gain.setValueAtTime(0,t);
  cG.gain.linearRampToValueAtTime(0.45,t+0.008);
  cG.gain.exponentialRampToValueAtTime(0.001,t+0.14);
  click.stop(t+0.16);
}

/* ── rAF loop — smooth RPM tracking + trigger BOV/pops ── */
function startLoop(){
  if(rafId) cancelAnimationFrame(rafId);
  lastTs=performance.now();
  function loop(ts){
    var dt=Math.min((ts-lastTs)/1000,0.08); lastTs=ts;
    var diff=tgtRPM-curRPM;
    curRPM+=diff*(diff>0?4.5:2.6)*dt;
    curRPM=clamp(curRPM,IDLE*0.95,MAX);

    if(bovCD>0) bovCD-=dt;
    else if(lastThr>0.28&&curThr<0.06&&curRPM>1800){
      triggerBOV(clamp((curRPM-1400)/4600,0,1));
      bovCD=0.55;
    }
    if(popCD>0) popCD-=dt;
    else if(curRPM>2200&&tgtRPM<curRPM-280){
      if(Math.random()<clamp((curRPM-2000)/4000,0,1)*0.72){
        triggerPop(); popCD=0.022+Math.random()*0.055;
      }
    }
    lastThr=curThr;
    updateParams();
    rafId=requestAnimationFrame(loop);
  }
  rafId=requestAnimationFrame(loop);
}

function updateParams(){
  if(!ctx||!active) return;
  var t=ctx.currentTime, tau=0.05;
  var hz=fireHz(curRPM);
  var frac=clamp((curRPM-IDLE)/(MAX-IDLE),0,1);

  /* Harmonic BP tracks firing overtone with RPM */
  nodes.harmBP.frequency.setTargetAtTime(3*hz,t,tau);
  nodes.harmBP.gain.setTargetAtTime(8+curThr*4,t,tau);

  /* Pipe resonances are fixed by geometry; gain falls slightly at high RPM
     as overlapping bursts blur the distinct ring */
  nodes.exhPrimary.gain.setTargetAtTime(10-frac*3,t,tau);
  nodes.exhCollector.gain.setTargetAtTime(6-frac*2,t,tau);

  /* LP opens with RPM — allows more top-end crackle at high revs */
  nodes.resLP.frequency.setTargetAtTime(1800+frac*3800+curThr*900,t,tau);

  /* Sub bass */
  nodes.oscSub.frequency.setTargetAtTime(crankHz(curRPM),t,tau);
  nodes.gainSub.gain.setTargetAtTime(0.55-frac*0.25,t,tau);

  /* Saturation */
  nodes.satDrive.gain.setTargetAtTime(1.5+curThr*2.8+frac*1.0,t,tau);

  /* Engine mix */
  nodes.engineMix.gain.setTargetAtTime(0.75+frac*0.15+curThr*0.10,t,tau);

  /* Reverb */
  nodes.reverbWet.gain.setTargetAtTime(0.38+curThr*0.28,t,tau);
  nodes.reverbDry.gain.setTargetAtTime(0.80-curThr*0.10,t,tau);

  /* Pink floor */
  nodes.floorG.gain.setTargetAtTime(0.04+frac*0.04,t,tau);

  /* Turbo whine — exponential spool like real compressor */
  var turboBase=Math.pow(clamp(frac-0.08,0,1)/0.92,1.4);
  var turboVol=turboBase*0.50+curThr*turboBase*0.48;
  var tf1=turboF1(frac), tf2=turboF2(frac);
  nodes.t1.frequency.setTargetAtTime(tf1,t,tau);
  nodes.t1f.frequency.setTargetAtTime(tf1,t,tau);
  nodes.t2.frequency.setTargetAtTime(tf2,t,tau);
  nodes.t2f.frequency.setTargetAtTime(tf2,t,tau);
  nodes.t1g.gain.setTargetAtTime(clamp(turboVol,0,0.78),t,tau);
  nodes.t2g.gain.setTargetAtTime(clamp(turboVol*0.75,0,0.62),t,tau);

  /* Rev limiter */
  if(curRPM>RED){
    nodes.master.gain.setTargetAtTime(0.9*(1-(curRPM-RED)/(MAX-RED)*0.55),t,0.005);
  } else {
    nodes.master.gain.setTargetAtTime(0.9,t,tau);
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
        burstBuf=makeBurst();
        buildGraph();
      }
      ctx.resume().then(function(){
        active=true;
        nextFire=ctx.currentTime+0.04;
        tgtRPM=1100; setTimeout(function(){tgtRPM=IDLE;},580);
        nodes.master.gain.cancelScheduledValues(ctx.currentTime);
        nodes.master.gain.setTargetAtTime(0.9,ctx.currentTime,0.12);
        startLoop();
        if(schedTimer) clearInterval(schedTimer);
        schedTimer=setInterval(scheduleBursts,SCHED_INT);
      });
      break;
    case 'stop':
      active=false;
      if(rafId){cancelAnimationFrame(rafId);rafId=null;}
      if(schedTimer){clearInterval(schedTimer);schedTimer=null;}
      if(ctx) nodes.master.gain.setTargetAtTime(0,ctx.currentTime,0.40);
      curRPM=IDLE; tgtRPM=IDLE; curThr=0; lastThr=0;
      break;
    case 'setRPM':
      tgtRPM=clamp(msg.rpm||IDLE,IDLE*0.5,MAX+200);
      curThr=clamp(msg.throttle||0,0,1);
      break;
    case 'gearUp':   gearShift('up');   break;
    case 'gearDown': gearShift('down'); break;
  }
}

window.addEventListener('message',onMsg);
document.addEventListener('message',onMsg);
document.addEventListener('touchstart',function(){
  if(ctx&&ctx.state==='suspended') ctx.resume();
},{passive:true});

function postRN(d){
  try{ if(window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(d)); }catch(e){}
}
postRN({type:'ready'});
})();
</script></body></html>`;
