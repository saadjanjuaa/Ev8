export const ENGINE_HTML = `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{margin:0;padding:0}html,body{width:100%;height:100%;background:transparent;overflow:hidden}</style>
</head><body><script>
(function(){
'use strict';

/* ════════════════════════════════════════════════════════════════════════
   PHYSICAL ENGINE SYNTHESIS — combustion-event scheduler.

   A real engine sound = combustion impulses fired at exactly fireHz, each
   resonating through the exhaust geometry. We replicate that physically:

     1. Pre-render one "combustion burst" buffer (45 ms shaped pink-noise)
     2. A look-ahead scheduler triggers a BufferSource at every
        1/fireHz interval — the JS heartbeat of the engine.
     3. Bursts share a resonance chain (LP + exhaust peak) that gives the
        GT-R / RB26 its straight-pipe "voice".

   Result: at idle you hear distinct thuds; at high RPM they blur into a
   roar — exactly like a real engine.
══════════════════════════════════════════════════════════════════════════ */

var IDLE=800, MAX=8000, RED=7000;
var ctx=null, nodes={}, active=false;
var burstBuf=null;
var curRPM=IDLE, tgtRPM=IDLE, curThr=0, lastThr=0;
var rafId=null, lastTs=0;
var bovCD=0, popCD=0;

/* Scheduler state */
var nextFire=0, schedTimer=null;
var SCHED_AHEAD=0.1;   /* schedule ~100ms ahead */
var SCHED_INT=25;      /* re-check every 25ms */
var MAX_NODES=40;      /* hard cap on concurrent burst nodes */
var liveNodes=0;

function clamp(v,a,b){return v<a?a:v>b?b:v;}
function fireHz(rpm){return (rpm/60)*3;}        /* inline-6: 3 firings/rev */
function crankHz(rpm){return rpm/60;}
function t1Hz(f){return 180+Math.pow(f,1.3)*3600;}
function t2Hz(f){return 165+Math.pow(f,1.3)*3400;}

/* ── Pink-noise generator state shared for static layers ── */
function makePinkNoise() {
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

/* ── Combustion burst: 45ms shaped pink noise.
   Fast attack (~0.6ms) + exponential decay = the characteristic "thump" of
   one cylinder firing through a straight pipe. ── */
function makeBurst(){
  var sr=ctx.sampleRate, dur=0.045;
  var len=Math.floor(sr*dur);
  var buf=ctx.createBuffer(1,len,sr), d=buf.getChannelData(0);
  var b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
  for(var i=0;i<len;i++){
    var t=i/sr;
    /* Two-stage envelope:
       attack window ramps in over 0.6ms;
       decay = exp(-t*30) gives ~33ms decay-to-near-silence.
       Slight 130 Hz ripple = the characteristic exhaust "ring" of one bang. */
    var atk=Math.min(1, t/0.0006);
    var dec=Math.exp(-t*30);
    var ring=1+Math.sin(2*Math.PI*130*t)*0.20;
    var env=atk*dec*ring;
    var w=Math.random()*2-1;
    b0=0.99886*b0+w*0.0555179; b1=0.99332*b1+w*0.0750759;
    b2=0.96900*b2+w*0.1538520; b3=0.86650*b3+w*0.3104856;
    b4=0.55000*b4+w*0.5329522; b5=-0.7616*b5-w*0.0168980;
    var noise=clamp((b0+b1+b2+b3+b4+b5+b6+w*0.5362)*0.11,-1,1);
    b6=w*0.115926;
    d[i]=noise*env*2.4;
  }
  return buf;
}

/* ── Exhaust-pipe IR for short reverb (~250ms) ── */
function makeExhaustIR(){
  var sr=ctx.sampleRate, len=Math.floor(sr*0.25);
  var buf=ctx.createBuffer(2,len,sr);
  for(var ch=0;ch<2;ch++){
    var d=buf.getChannelData(ch), echoLag=Math.floor(0.018*sr);
    for(var i=0;i<len;i++){
      var t=i/sr, dec=Math.exp(-t*22);
      var er=(i>echoLag)?d[i-echoLag]*0.35:0;
      d[i]=((Math.random()*2-1)*dec+er)*(ch===0?1:0.85);
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

/* ── Build audio graph ── */
function buildGraph(){
  var t=ctx.currentTime;

  nodes.master=ctx.createGain(); nodes.master.gain.setValueAtTime(0,t);
  nodes.master.connect(ctx.destination);

  nodes.comp=ctx.createDynamicsCompressor();
  nodes.comp.threshold.value=-9; nodes.comp.knee.value=10;
  nodes.comp.ratio.value=3.5; nodes.comp.attack.value=0.004;
  nodes.comp.release.value=0.13; nodes.comp.connect(nodes.master);

  /* Output EQ */
  nodes.hi=ctx.createBiquadFilter();
  nodes.hi.type='highshelf'; nodes.hi.frequency.value=4000;
  nodes.hi.gain.value=-2; nodes.hi.connect(nodes.comp);

  nodes.pres=ctx.createBiquadFilter();
  nodes.pres.type='peaking'; nodes.pres.frequency.value=550;
  nodes.pres.Q.value=0.9; nodes.pres.gain.value=4; nodes.pres.connect(nodes.hi);

  nodes.bass=ctx.createBiquadFilter();
  nodes.bass.type='peaking'; nodes.bass.frequency.value=95;
  nodes.bass.Q.value=0.7; nodes.bass.gain.value=8; nodes.bass.connect(nodes.pres);

  /* Reverb (short room) */
  nodes.reverb=ctx.createConvolver(); nodes.reverb.buffer=makeExhaustIR();
  nodes.reverbWet=ctx.createGain(); nodes.reverbWet.gain.value=0.45;
  nodes.reverbDry=ctx.createGain(); nodes.reverbDry.gain.value=0.78;
  nodes.reverbDry.connect(nodes.bass);
  nodes.reverbWet.connect(nodes.reverb); nodes.reverb.connect(nodes.bass);

  /* Saturation (warmth + grit) */
  nodes.sat=ctx.createWaveShaper();
  nodes.sat.curve=makeSat(2.6); nodes.sat.oversample='2x';
  nodes.satDrive=ctx.createGain(); nodes.satDrive.gain.value=1.8;
  nodes.satDrive.connect(nodes.sat);
  nodes.sat.connect(nodes.reverbDry); nodes.sat.connect(nodes.reverbWet);

  /* ── ENGINE MIX (combustion bursts + sub + texture all converge here) ── */
  nodes.engineMix=ctx.createGain(); nodes.engineMix.gain.value=0.85;
  nodes.engineMix.connect(nodes.satDrive);

  /* Shared resonance chain — every combustion burst flows through this.
     This is where the "engine voice" lives:
       harmBP  (Q≈4, tracks 3×fireHz)  → the inline-6 bark / pitch
       exhBP   (fixed 150 Hz, +9 dB)    → straight-pipe fundamental
       resLP   (cutoff opens with RPM)  → keeps the sound from getting hissy
  */
  nodes.resHP=ctx.createBiquadFilter();
  nodes.resHP.type='highpass'; nodes.resHP.frequency.value=55;
  nodes.resHP.Q.value=0.5; nodes.resHP.connect(nodes.engineMix);

  nodes.resLP=ctx.createBiquadFilter();
  nodes.resLP.type='lowpass'; nodes.resLP.frequency.setValueAtTime(2200,t);
  nodes.resLP.Q.value=0.9; nodes.resLP.connect(nodes.resHP);

  nodes.exhBP=ctx.createBiquadFilter();
  nodes.exhBP.type='peaking'; nodes.exhBP.frequency.value=150;
  nodes.exhBP.Q.value=2.0; nodes.exhBP.gain.value=9;
  nodes.exhBP.connect(nodes.resLP);

  nodes.harmBP=ctx.createBiquadFilter();
  nodes.harmBP.type='peaking';
  nodes.harmBP.frequency.setValueAtTime(3*fireHz(IDLE),t);
  nodes.harmBP.Q.value=4; nodes.harmBP.gain.value=7;
  nodes.harmBP.connect(nodes.exhBP);

  /* burstMix is the input port for every combustion BufferSource. */
  nodes.burstMix=ctx.createGain(); nodes.burstMix.gain.value=1;
  nodes.burstMix.connect(nodes.harmBP);

  /* ── Sub-bass thump at crank frequency ── */
  nodes.oscSub=ctx.createOscillator(); nodes.oscSub.type='sine';
  nodes.oscSub.frequency.setValueAtTime(crankHz(IDLE),t);
  nodes.gainSub=ctx.createGain(); nodes.gainSub.gain.value=0.5;
  nodes.oscSub.connect(nodes.gainSub); nodes.gainSub.connect(nodes.engineMix);
  nodes.oscSub.start();

  /* ── Background pink-noise floor (very subtle, prevents silence "gap") ── */
  var pinkFloor=makePinkNoise();
  nodes.floorLP=ctx.createBiquadFilter();
  nodes.floorLP.type='lowpass'; nodes.floorLP.frequency.value=600;
  nodes.floorG=ctx.createGain(); nodes.floorG.gain.value=0.05;
  pinkFloor.connect(nodes.floorLP); nodes.floorLP.connect(nodes.floorG);
  nodes.floorG.connect(nodes.engineMix);

  /* ── Twin turbo whine (kick in above ~3000 RPM) ── */
  nodes.t1=ctx.createOscillator(); nodes.t1.type='sawtooth';
  nodes.t1.frequency.setValueAtTime(t1Hz(0),t);
  nodes.t1f=ctx.createBiquadFilter(); nodes.t1f.type='bandpass';
  nodes.t1f.frequency.setValueAtTime(t1Hz(0),t); nodes.t1f.Q.value=28;
  nodes.t1g=ctx.createGain(); nodes.t1g.gain.setValueAtTime(0,t);
  nodes.t1.connect(nodes.t1f); nodes.t1f.connect(nodes.t1g);
  nodes.t1g.connect(nodes.bass);

  nodes.t2=ctx.createOscillator(); nodes.t2.type='sawtooth';
  nodes.t2.frequency.setValueAtTime(t2Hz(0),t);
  nodes.t2f=ctx.createBiquadFilter(); nodes.t2f.type='bandpass';
  nodes.t2f.frequency.setValueAtTime(t2Hz(0),t); nodes.t2f.Q.value=20;
  nodes.t2g=ctx.createGain(); nodes.t2g.gain.setValueAtTime(0,t);
  nodes.t2.connect(nodes.t2f); nodes.t2f.connect(nodes.t2g);
  nodes.t2g.connect(nodes.bass);

  /* ── BOV (sweeping pink noise on throttle release) ── */
  var pinkBOV=makePinkNoise();
  nodes.bovHP=ctx.createBiquadFilter(); nodes.bovHP.type='highpass';
  nodes.bovHP.frequency.value=400;
  nodes.bovF=ctx.createBiquadFilter(); nodes.bovF.type='bandpass';
  nodes.bovF.frequency.value=1200; nodes.bovF.Q.value=2.2;
  nodes.bovG=ctx.createGain(); nodes.bovG.gain.setValueAtTime(0,t);
  pinkBOV.connect(nodes.bovHP); nodes.bovHP.connect(nodes.bovF);
  nodes.bovF.connect(nodes.bovG); nodes.bovG.connect(nodes.comp);

  /* ── Exhaust pop (short noise burst, mainly on decel) ── */
  var pinkPop=makePinkNoise();
  nodes.popF=ctx.createBiquadFilter(); nodes.popF.type='bandpass';
  nodes.popF.frequency.value=820; nodes.popF.Q.value=3;
  nodes.popG=ctx.createGain(); nodes.popG.gain.setValueAtTime(0,t);
  pinkPop.connect(nodes.popF); nodes.popF.connect(nodes.popG);
  nodes.popG.connect(nodes.comp);

  [nodes.t1,nodes.t2].forEach(function(o){o.start();});
}

/* ── Fire one combustion burst at the given AudioContext time ── */
function fireBurst(when){
  if(liveNodes>=MAX_NODES) return;
  var src=ctx.createBufferSource();
  src.buffer=burstBuf;
  /* Tiny detune gives every burst a slightly different character — kills
     the "perfect repeat" robotic quality. */
  src.detune.value=(Math.random()-0.5)*40;
  /* Per-burst gain dipped slightly for variation */
  var g=ctx.createGain();
  g.gain.value=0.85+Math.random()*0.30;
  src.connect(g); g.connect(nodes.burstMix);
  src.start(when);
  liveNodes++;
  src.onended=function(){ liveNodes--; src.disconnect(); g.disconnect(); };
}

/* ── Look-ahead scheduler: keeps a steady stream of combustion bursts
       fired at the exact firing-frequency interval. ── */
function scheduleBursts(){
  if(!active||!ctx||!burstBuf) return;
  var now=ctx.currentTime;
  var interval=1/fireHz(curRPM);
  /* Don't drift back: if we fell behind, snap to "now" */
  if(nextFire<now-0.01) nextFire=now+0.01;
  var horizon=now+SCHED_AHEAD;
  while(nextFire<horizon){
    fireBurst(nextFire);
    nextFire+=interval;
  }
}

/* ── BOV ── */
function triggerBOV(intensity){
  if(!ctx||!active) return;
  var t=ctx.currentTime, dur=0.13+intensity*0.30, vol=0.55+intensity*0.45;
  nodes.bovF.frequency.cancelScheduledValues(t);
  nodes.bovF.frequency.setValueAtTime(1500+intensity*1500,t);
  nodes.bovF.frequency.exponentialRampToValueAtTime(280,t+dur);
  nodes.bovG.gain.cancelScheduledValues(t);
  nodes.bovG.gain.setValueAtTime(0,t);
  nodes.bovG.gain.linearRampToValueAtTime(vol,t+0.012);
  nodes.bovG.gain.exponentialRampToValueAtTime(0.001,t+dur);
}

/* ── Exhaust pop ── */
function triggerPop(){
  if(!ctx||!active) return;
  var t=ctx.currentTime;
  nodes.popF.frequency.setValueAtTime(450+Math.random()*900,t);
  nodes.popG.gain.cancelScheduledValues(t);
  nodes.popG.gain.setValueAtTime(0,t);
  nodes.popG.gain.linearRampToValueAtTime(0.75,t+0.005);
  nodes.popG.gain.exponentialRampToValueAtTime(0.001,t+0.045+Math.random()*0.04);
}

/* ── Gear shift: clutch duck + pitched click ── */
function gearShift(dir){
  if(!ctx||!active) return;
  var t=ctx.currentTime;
  /* Volume duck */
  nodes.master.gain.cancelScheduledValues(t);
  nodes.master.gain.setValueAtTime(0.9,t);
  nodes.master.gain.linearRampToValueAtTime(0.30,t+0.045);
  nodes.master.gain.linearRampToValueAtTime(0.9,t+0.22);
  /* Click */
  var click=ctx.createOscillator(); click.type='square';
  click.frequency.value=dir==='down'?115:78;
  var cF=ctx.createBiquadFilter(); cF.type='bandpass';
  cF.frequency.value=dir==='down'?260:160; cF.Q.value=5;
  var cG=ctx.createGain(); cG.gain.value=0;
  click.connect(cF); cF.connect(cG); cG.connect(nodes.comp);
  click.start(t);
  cG.gain.setValueAtTime(0,t);
  cG.gain.linearRampToValueAtTime(0.40,t+0.008);
  cG.gain.exponentialRampToValueAtTime(0.001,t+0.13);
  click.stop(t+0.15);
}

/* ── Per-frame parameter updates (track RPM smoothly to target) ── */
function startLoop(){
  if(rafId) cancelAnimationFrame(rafId);
  lastTs=performance.now();
  function loop(ts){
    var dt=Math.min((ts-lastTs)/1000,0.08); lastTs=ts;
    var diff=tgtRPM-curRPM;
    curRPM+=diff*(diff>0?4.5:2.6)*dt;
    curRPM=clamp(curRPM,IDLE*0.95,MAX);

    /* BOV trigger */
    if(bovCD>0) bovCD-=dt;
    else if(lastThr>0.30&&curThr<0.07&&curRPM>1900){
      triggerBOV(clamp((curRPM-1500)/4500,0,1));
      bovCD=0.6;
    }
    /* Pop trigger */
    if(popCD>0) popCD-=dt;
    else if(curRPM>2400&&tgtRPM<curRPM-300){
      if(Math.random()<clamp((curRPM-2200)/4200,0,1)*0.7){
        triggerPop(); popCD=0.025+Math.random()*0.06;
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

  /* Resonance chain tracks RPM */
  nodes.harmBP.frequency.setTargetAtTime(3*hz,t,tau);
  nodes.harmBP.gain.setTargetAtTime(7+curThr*4,t,tau);
  nodes.resLP.frequency.setTargetAtTime(1800+frac*3500+curThr*800,t,tau);
  nodes.exhBP.gain.setTargetAtTime(9-frac*3,t,tau);

  /* Sub follows crank, fades at high RPM */
  nodes.oscSub.frequency.setTargetAtTime(crankHz(curRPM),t,tau);
  nodes.gainSub.gain.setTargetAtTime(0.55-frac*0.25,t,tau);

  /* Saturation opens with throttle */
  nodes.satDrive.gain.setTargetAtTime(1.5+curThr*2.6+frac*1.0,t,tau);

  /* Engine mix ducks a bit at idle so each thud reads clearly */
  nodes.engineMix.gain.setTargetAtTime(0.75+frac*0.15+curThr*0.10,t,tau);

  /* Reverb wetter under load */
  nodes.reverbWet.gain.setTargetAtTime(0.40+curThr*0.30,t,tau);
  nodes.reverbDry.gain.setTargetAtTime(0.78-curThr*0.10,t,tau);

  /* Texture floor — a hint louder at high RPM */
  nodes.floorG.gain.setTargetAtTime(0.04+frac*0.04,t,tau);

  /* Turbo whine */
  var turboBase=Math.pow(clamp(frac-0.10,0,1)/0.90,1.5);
  var turboVol=turboBase*0.45+curThr*turboBase*0.45;
  var tf1=t1Hz(frac), tf2=t2Hz(frac);
  nodes.t1.frequency.setTargetAtTime(tf1,t,tau);
  nodes.t1f.frequency.setTargetAtTime(tf1,t,tau);
  nodes.t2.frequency.setTargetAtTime(tf2,t,tau);
  nodes.t2f.frequency.setTargetAtTime(tf2,t,tau);
  nodes.t1g.gain.setTargetAtTime(clamp(turboVol,0,0.75),t,tau);
  nodes.t2g.gain.setTargetAtTime(clamp(turboVol*0.78,0,0.6),t,tau);

  /* Rev-limiter ducking */
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
        tgtRPM=1100; setTimeout(function(){tgtRPM=IDLE;},550);
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
      if(ctx) nodes.master.gain.setTargetAtTime(0,ctx.currentTime,0.4);
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
