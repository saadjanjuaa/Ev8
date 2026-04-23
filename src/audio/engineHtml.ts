import { ENGINE_SAMPLE_B64 } from './engineSample';

// BASE_RPM: the RPM the recorded sample sounds most natural at.
// R34 GT-R RB26DETT (inline-6) — NFS MW2012 sample estimated at ~3500 RPM.
// playbackRate = currentRPM / BASE_RPM  →  pitch scales with RPM.
const BASE_RPM = 3500;

export const ENGINE_HTML = `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{margin:0;padding:0}html,body{width:100%;height:100%;background:transparent;overflow:hidden}</style>
</head><body><script>
(function(){
'use strict';

var BASE_RPM = ${BASE_RPM};
var IDLE = 720, MAX = 7000, RED = 6800;

var ctx = null, nodes = {}, active = false;
var audioBuffer = null;           // decoded PCM — cached after first decode
var source = null;                // current BufferSourceNode
var curRPM = IDLE, tgtRPM = IDLE, curThr = 0, lastThr = 0;
var rafId = null, lastTs = 0, bovCD = 0, popCD = 0;

function clamp(v,a,b){return v<a?a:v>b?b:v;}

/* ── Decode the embedded MP3 once, then cache the AudioBuffer ── */
var rawBuf = (function(){
  var b64 = '${ENGINE_SAMPLE_B64}';
  var bin = atob(b64);
  var buf = new ArrayBuffer(bin.length);
  var view = new Uint8Array(buf);
  for (var i=0;i<bin.length;i++) view[i] = bin.charCodeAt(i);
  return buf;
})();

function postRN(d){
  try{ if(window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(d)); }catch(e){}
}

/* ── Build the audio graph (call after ctx is created) ── */
function buildGraph() {
  var t = ctx.currentTime;

  /* master */
  nodes.master = ctx.createGain();
  nodes.master.gain.setValueAtTime(0, t);
  nodes.master.connect(ctx.destination);

  /* compressor */
  nodes.comp = ctx.createDynamicsCompressor();
  nodes.comp.threshold.value = -10;
  nodes.comp.knee.value = 8;
  nodes.comp.ratio.value = 3.5;
  nodes.comp.attack.value = 0.003;
  nodes.comp.release.value = 0.09;
  nodes.comp.connect(nodes.master);

  /* hi-shelf air */
  nodes.air = ctx.createBiquadFilter();
  nodes.air.type = 'highshelf';
  nodes.air.frequency.value = 6000;
  nodes.air.gain.value = 2.5;
  nodes.air.connect(nodes.comp);

  /* presence peak */
  nodes.pres = ctx.createBiquadFilter();
  nodes.pres.type = 'peaking';
  nodes.pres.frequency.value = 550;
  nodes.pres.Q.value = 0.9;
  nodes.pres.gain.value = 5;
  nodes.pres.connect(nodes.air);

  /* main LP — opens with RPM, simulates real tonal shift */
  nodes.mainLP = ctx.createBiquadFilter();
  nodes.mainLP.type = 'lowpass';
  nodes.mainLP.frequency.setValueAtTime(1800, t);
  nodes.mainLP.Q.value = 0.65;
  nodes.mainLP.connect(nodes.pres);

  /* sample gain — amplitude follows RPM+throttle */
  nodes.sampleGain = ctx.createGain();
  nodes.sampleGain.gain.setValueAtTime(0.6, t);
  nodes.sampleGain.connect(nodes.mainLP);

  /* ── Twin turbo whine (synthesised, layered on top) ── */
  function makeT(freq, Q) {
    var osc = ctx.createOscillator(); osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, t);
    var flt = ctx.createBiquadFilter(); flt.type = 'bandpass';
    flt.frequency.setValueAtTime(freq, t); flt.Q.value = Q;
    var g = ctx.createGain(); g.gain.setValueAtTime(0, t);
    osc.connect(flt); flt.connect(g); g.connect(nodes.comp);
    osc.start();
    return { osc:osc, flt:flt, g:g };
  }
  nodes.t1 = makeT(160, 35);
  nodes.t2 = makeT(150, 28);

  /* ── Exhaust pop/crackle ── */
  nodes.popSrc = makePink();
  nodes.popF = ctx.createBiquadFilter(); nodes.popF.type = 'bandpass';
  nodes.popF.frequency.value = 1100; nodes.popF.Q.value = 5;
  nodes.popG = ctx.createGain(); nodes.popG.gain.setValueAtTime(0, t);
  nodes.popSrc.connect(nodes.popF); nodes.popF.connect(nodes.popG);
  nodes.popG.connect(nodes.comp);

  /* ── BOV ── */
  nodes.bovSrc = makePink();
  nodes.bovHP = ctx.createBiquadFilter(); nodes.bovHP.type = 'highpass';
  nodes.bovHP.frequency.value = 500;
  nodes.bovF = ctx.createBiquadFilter(); nodes.bovF.type = 'bandpass';
  nodes.bovF.frequency.value = 1400; nodes.bovF.Q.value = 2.8;
  nodes.bovG = ctx.createGain(); nodes.bovG.gain.setValueAtTime(0, t);
  nodes.bovSrc.connect(nodes.bovHP); nodes.bovHP.connect(nodes.bovF);
  nodes.bovF.connect(nodes.bovG); nodes.bovG.connect(nodes.comp);
}

function makePink() {
  var sr = ctx.sampleRate, len = sr*4;
  var buf = ctx.createBuffer(1, len, sr);
  var d = buf.getChannelData(0);
  var b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
  for (var i=0;i<len;i++){
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

/* ── Start the BufferSource loop ── */
function startSource() {
  if (source) { try{ source.stop(); }catch(e){} source.disconnect(); }
  source = ctx.createBufferSource();
  source.buffer = audioBuffer;
  source.loop = true;
  source.playbackRate.setValueAtTime(IDLE / BASE_RPM, ctx.currentTime);
  source.connect(nodes.sampleGain);
  source.start(0);
}

/* ── RAF update loop ── */
function startLoop() {
  if (rafId) cancelAnimationFrame(rafId);
  lastTs = performance.now();
  function loop(ts) {
    var dt = Math.min((ts-lastTs)/1000, 0.08); lastTs = ts;
    var diff = tgtRPM - curRPM;
    curRPM += diff*(diff>0?3.8:2.4)*dt;
    curRPM = clamp(curRPM, IDLE*0.93, MAX);

    /* BOV trigger */
    if (bovCD>0) bovCD-=dt;
    else if (lastThr>0.45&&curThr<0.12&&curRPM>2500) {
      triggerBOV(clamp((curRPM-2000)/4500,0,1));
      bovCD=0.65;
    }
    /* exhaust pop trigger */
    if (popCD>0) popCD-=dt;
    else if (curRPM>3000&&tgtRPM<curRPM-400) {
      if (Math.random()<clamp((curRPM-2800)/4000,0,1)*0.55) {
        triggerPop(); popCD=0.04+Math.random()*0.09;
      }
    }
    lastThr = curThr;
    update(curRPM, curThr);
    rafId = requestAnimationFrame(loop);
  }
  rafId = requestAnimationFrame(loop);
}

function t1Hz(f){return 160+Math.pow(f,1.35)*3900;}
function t2Hz(f){return 150+Math.pow(f,1.35)*3650;}

function update(rpm, thr) {
  if (!ctx||!active||!source) return;
  var t = ctx.currentTime, tau = 0.05;
  var frac = clamp((rpm-IDLE)/(MAX-IDLE), 0, 1);

  /* playback rate = RPM ratio (pitch shifts with RPM) */
  var rate = clamp(rpm/BASE_RPM, 0.08, 2.5);
  source.playbackRate.setTargetAtTime(rate, t, tau);

  /* sample gain: quieter at idle, full volume at high RPM/throttle */
  var sVol = 0.45 + frac*0.45 + thr*0.1;
  nodes.sampleGain.gain.setTargetAtTime(clamp(sVol,0,1), t, tau);

  /* LP opens with RPM — more treble at high revs */
  nodes.mainLP.frequency.setTargetAtTime(1400+frac*8600, t, tau);

  /* presence freq shift */
  nodes.pres.frequency.setTargetAtTime(420+frac*360, t, tau);
  nodes.pres.gain.setTargetAtTime(4+thr*4, t, tau);

  /* turbo whine */
  var turboBase = Math.pow(clamp(frac-0.12,0,1)/0.88, 1.4);
  var turboVol = turboBase*0.65 + thr*turboBase*0.35;
  var tf1=t1Hz(frac), tf2=t2Hz(frac);
  nodes.t1.osc.frequency.setTargetAtTime(tf1,t,tau);
  nodes.t1.flt.frequency.setTargetAtTime(tf1,t,tau);
  nodes.t2.osc.frequency.setTargetAtTime(tf2,t,tau);
  nodes.t2.flt.frequency.setTargetAtTime(tf2,t,tau);
  nodes.t1.g.gain.setTargetAtTime(clamp(turboVol,0,0.9),t,tau);
  nodes.t2.g.gain.setTargetAtTime(clamp(turboVol*0.82,0,0.75),t,tau);

  /* rev limiter flutter */
  if (rpm>RED) {
    nodes.master.gain.setTargetAtTime(0.88*(1-(rpm-RED)/(MAX-RED)*0.5),t,0.006);
  } else {
    nodes.master.gain.setTargetAtTime(0.88, t, tau);
  }
}

function triggerBOV(intensity) {
  if (!ctx||!active) return;
  var t=ctx.currentTime, dur=0.1+intensity*0.25, vol=0.3+intensity*0.6;
  nodes.bovF.frequency.cancelScheduledValues(t);
  nodes.bovF.frequency.setValueAtTime(1600+intensity*1400,t);
  nodes.bovF.frequency.exponentialRampToValueAtTime(300,t+dur);
  nodes.bovG.gain.cancelScheduledValues(t);
  nodes.bovG.gain.setValueAtTime(0,t);
  nodes.bovG.gain.linearRampToValueAtTime(vol,t+0.012);
  nodes.bovG.gain.exponentialRampToValueAtTime(0.001,t+dur);
}

function triggerPop() {
  if (!ctx||!active) return;
  var t=ctx.currentTime;
  nodes.popF.frequency.setValueAtTime(800+Math.random()*900,t);
  nodes.popG.gain.cancelScheduledValues(t);
  nodes.popG.gain.setValueAtTime(0,t);
  nodes.popG.gain.linearRampToValueAtTime(0.5,t+0.005);
  nodes.popG.gain.exponentialRampToValueAtTime(0.001,t+0.035+Math.random()*0.03);
}

/* ── Message handler ── */
function onMsg(evt) {
  var msg; try{msg=JSON.parse(evt.data);}catch(e){return;}
  if (!msg||!msg.type) return;

  switch(msg.type) {

    case 'start':
      if (!ctx) {
        ctx = new (window.AudioContext||window.webkitAudioContext)();
        buildGraph();
      }
      ctx.resume().then(function(){
        if (audioBuffer) {
          /* already decoded — just restart */
          active = true;
          startSource();
          nodes.master.gain.setTargetAtTime(0.88, ctx.currentTime, 0.4);
          startLoop();
        } else {
          /* first time — decode MP3 */
          ctx.decodeAudioData(rawBuf.slice(0), function(buf){
            audioBuffer = buf;
            active = true;
            startSource();
            /* idle startup rev */
            tgtRPM = 950;
            setTimeout(function(){ tgtRPM = IDLE; }, 700);
            nodes.master.gain.setTargetAtTime(0.88, ctx.currentTime, 0.4);
            startLoop();
          }, function(e){ console.error('decode error', e); });
        }
      });
      break;

    case 'stop':
      active = false;
      if (rafId){ cancelAnimationFrame(rafId); rafId=null; }
      if (ctx) nodes.master.gain.setTargetAtTime(0, ctx.currentTime, 0.5);
      if (source){ try{ source.stop(ctx.currentTime+0.6); }catch(e){} }
      curRPM=IDLE; tgtRPM=IDLE; curThr=0; lastThr=0;
      break;

    case 'setRPM':
      tgtRPM = clamp(msg.rpm||IDLE, IDLE, MAX);
      curThr = clamp(msg.throttle||0, 0, 1);
      break;
  }
}

window.addEventListener('message', onMsg);
document.addEventListener('message', onMsg);
document.addEventListener('touchstart', function(){
  if (ctx&&ctx.state==='suspended') ctx.resume();
}, {passive:true});

/* Signal ready immediately — audio decode happens on first START press */
postRN({type:'ready'});
})();
</script></body></html>`;
