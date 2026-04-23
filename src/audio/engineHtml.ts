// GT-R R35 VR38DETT — improved synthesis
// Key improvements over previous version:
//   • Synthetic convolution reverb (exhaust pipe resonance)
//   • Pink noise (1/f spectrum — far more natural than white noise)
//   • Very high-Q turbo whine (Q=35) for metallic ring
//   • FM synthesis on engine oscillator for organic character
//   • Engine/turbo balance crossfades at ~3000 RPM
//   • AudioContext created at load, resumed on start

export const ENGINE_HTML = `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{margin:0;padding:0}html,body{width:100%;height:100%;background:transparent;overflow:hidden}</style>
</head><body><script>
(function(){
'use strict';

var IDLE = 720, MAX = 8000, RED = 7400;

var ctx = null, nodes = {}, active = false;
var curRPM = IDLE, tgtRPM = IDLE, curThr = 0, lastThr = 0;
var rafId = null, lastTs = 0, bovCD = 0, popCD = 0;

function clamp(v,a,b){return v<a?a:v>b?b:v;}

/* ── Pink noise (Paul Kellett's method — much more natural than white) ── */
function makePink(ctx) {
  var sr = ctx.sampleRate, len = sr * 4;
  var buf = ctx.createBuffer(1, len, sr);
  var d = buf.getChannelData(0);
  var b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
  for (var i=0;i<len;i++) {
    var w = Math.random()*2-1;
    b0=0.99886*b0+w*0.0555179; b1=0.99332*b1+w*0.0750759;
    b2=0.96900*b2+w*0.1538520; b3=0.86650*b3+w*0.3104856;
    b4=0.55000*b4+w*0.5329522; b5=-0.7616*b5-w*0.0168980;
    d[i]=clamp((b0+b1+b2+b3+b4+b5+b6+w*0.5362)*0.11,-1,1);
    b6=w*0.115926;
  }
  var s=ctx.createBufferSource(); s.buffer=buf; s.loop=true; s.start(0);
  return s;
}

/* ── Synthetic exhaust impulse response (pipe resonance reverb) ── */
function makeExhaustIR(ctx) {
  var sr = ctx.sampleRate;
  var len = Math.floor(sr * 0.22); // 220ms tight reverb
  var buf = ctx.createBuffer(2, len, sr);
  for (var ch=0;ch<2;ch++) {
    var d = buf.getChannelData(ch);
    for (var i=0;i<len;i++) {
      var t = i/sr;
      var pre = 0.004; // 4ms pre-delay (pipe travel time)
      if (t < pre) { d[i]=0; continue; }
      var decay = Math.exp(-(t-pre)*28);
      // Early reflection at ~12ms (secondary pipe resonance)
      var er = (i > Math.floor(0.012*sr)) ? d[i-Math.floor(0.012*sr)]*0.28 : 0;
      d[i] = ((Math.random()*2-1)*decay + er) * (ch===0 ? 1 : 0.92);
    }
  }
  return buf;
}

/* ── Hard-clip distortion (GT-R: compressed/digital feel) ── */
function makeClip(drive) {
  var N=512, c=new Float32Array(N);
  for (var i=0;i<N;i++) {
    var x=(i*2/N)-1, y=x*drive;
    if (y>0)  y=1-Math.exp(-y);
    else      y=-(1-Math.exp(y*0.82))*1.12;
    c[i]=clamp(y/drive,-1,1);
  }
  return c;
}

/* ── GT-R V6 Fourier wave ── */
function makeGTRWave(ctx) {
  var H=14, re=new Float32Array(H+1), im=new Float32Array(H+1);
  re[1]=1.00; re[2]=0.62; re[3]=0.55; re[4]=0.32;
  re[5]=0.48; re[6]=0.20; re[7]=0.25; re[8]=0.10;
  re[9]=0.16; re[10]=0.07; re[11]=0.12; re[12]=0.05;
  im[2]=0.18; im[4]=-0.11; im[6]=0.07;
  return ctx.createPeriodicWave(re, im, {disableNormalization:false});
}

function fireHz(rpm){return (rpm/60)*3;}
function t1Hz(f){return 160+Math.pow(f,1.35)*3900;}
function t2Hz(f){return 150+Math.pow(f,1.35)*3650;}

/* ── Build graph ── */
function buildGraph() {
  if (!ctx) return;
  var t=ctx.currentTime, hz=fireHz(IDLE);

  /* output chain */
  nodes.master=ctx.createGain(); nodes.master.gain.setValueAtTime(0,t);
  nodes.master.connect(ctx.destination);

  nodes.comp=ctx.createDynamicsCompressor();
  nodes.comp.threshold.value=-9; nodes.comp.knee.value=8;
  nodes.comp.ratio.value=3.5; nodes.comp.attack.value=0.002;
  nodes.comp.release.value=0.1; nodes.comp.connect(nodes.master);

  nodes.hiShelf=ctx.createBiquadFilter();
  nodes.hiShelf.type='highshelf'; nodes.hiShelf.frequency.value=5500;
  nodes.hiShelf.gain.value=2; nodes.hiShelf.connect(nodes.comp);

  nodes.pres=ctx.createBiquadFilter();
  nodes.pres.type='peaking'; nodes.pres.frequency.value=520;
  nodes.pres.Q.value=0.85; nodes.pres.gain.value=5;
  nodes.pres.connect(nodes.hiShelf);

  nodes.finalLP=ctx.createBiquadFilter();
  nodes.finalLP.type='lowpass'; nodes.finalLP.frequency.value=7000;
  nodes.finalLP.Q.value=0.6; nodes.finalLP.connect(nodes.pres);

  /* ── Exhaust convolution reverb ── */
  nodes.reverb=ctx.createConvolver();
  nodes.reverb.buffer=makeExhaustIR(ctx);
  nodes.reverbGain=ctx.createGain(); nodes.reverbGain.gain.value=0.45;
  nodes.reverbDry=ctx.createGain(); nodes.reverbDry.gain.value=0.7;
  // reverb only on engine oscillators (not turbo/BOV)
  nodes.reverbDry.connect(nodes.finalLP);
  nodes.reverbGain.connect(nodes.reverb);
  nodes.reverb.connect(nodes.finalLP);

  nodes.outputHP=ctx.createBiquadFilter();
  nodes.outputHP.type='highpass'; nodes.outputHP.frequency.value=65;
  nodes.outputHP.Q.value=0.8; nodes.outputHP.connect(nodes.reverbDry);
  nodes.outputHP.connect(nodes.reverbGain);

  nodes.postLP=ctx.createBiquadFilter();
  nodes.postLP.type='lowpass'; nodes.postLP.frequency.value=3000;
  nodes.postLP.Q.value=0.5; nodes.postLP.connect(nodes.outputHP);

  nodes.dist=ctx.createWaveShaper();
  nodes.dist.curve=makeClip(3.5); nodes.dist.oversample='4x';
  nodes.dist.connect(nodes.postLP);

  nodes.drive=ctx.createGain(); nodes.drive.gain.value=2.6;
  nodes.drive.connect(nodes.dist);

  nodes.engMix=ctx.createGain(); nodes.engMix.gain.value=0.48;
  nodes.engMix.connect(nodes.drive);

  /* ── FM engine oscillator (modulator adds organic complexity) ── */
  var wave=makeGTRWave(ctx);
  nodes.oscA=ctx.createOscillator(); nodes.oscA.setPeriodicWave(wave);
  nodes.oscA.frequency.setValueAtTime(hz,t);
  // FM modulator at half firing freq — subtle warble
  nodes.fmMod=ctx.createOscillator(); nodes.fmMod.type='sine';
  nodes.fmMod.frequency.setValueAtTime(hz/2,t);
  nodes.fmAmt=ctx.createGain(); nodes.fmAmt.gain.value=1.8; // FM depth in Hz
  nodes.fmMod.connect(nodes.fmAmt);
  nodes.fmAmt.connect(nodes.oscA.frequency);

  nodes.gainA=ctx.createGain(); nodes.gainA.gain.setValueAtTime(0.72,t);
  nodes.oscA.connect(nodes.gainA); nodes.gainA.connect(nodes.engMix);

  /* ── Sub (crank frequency) — less dominant than V8 ── */
  nodes.oscSub=ctx.createOscillator(); nodes.oscSub.type='sine';
  nodes.oscSub.frequency.setValueAtTime(hz/3,t);
  nodes.gainSub=ctx.createGain(); nodes.gainSub.gain.setValueAtTime(0.28,t);
  nodes.oscSub.connect(nodes.gainSub); nodes.gainSub.connect(nodes.engMix);

  /* ── Twin turbo whine (very high Q — metallic ring) ── */
  // Each turbo: sawtooth → very narrow bandpass → gain
  nodes.t1=ctx.createOscillator(); nodes.t1.type='sawtooth';
  nodes.t1.frequency.setValueAtTime(t1Hz(0),t);
  nodes.t1f=ctx.createBiquadFilter(); nodes.t1f.type='bandpass';
  nodes.t1f.frequency.setValueAtTime(t1Hz(0),t); nodes.t1f.Q.value=35;
  nodes.t1g=ctx.createGain(); nodes.t1g.gain.setValueAtTime(0,t);
  nodes.t1.connect(nodes.t1f); nodes.t1f.connect(nodes.t1g);

  nodes.t2=ctx.createOscillator(); nodes.t2.type='sawtooth';
  nodes.t2.frequency.setValueAtTime(t2Hz(0),t);
  nodes.t2f=ctx.createBiquadFilter(); nodes.t2f.type='bandpass';
  nodes.t2f.frequency.setValueAtTime(t2Hz(0),t); nodes.t2f.Q.value=28;
  nodes.t2g=ctx.createGain(); nodes.t2g.gain.setValueAtTime(0,t);
  nodes.t2.connect(nodes.t2f); nodes.t2f.connect(nodes.t2g);

  // Turbo mix → bypass exhaust reverb (heard from intake/intercooler)
  nodes.turboMix=ctx.createGain(); nodes.turboMix.gain.value=1;
  nodes.t1g.connect(nodes.turboMix); nodes.t2g.connect(nodes.turboMix);
  nodes.turboMix.connect(nodes.finalLP);

  /* ── Induction noise (pink noise, rises sharply with boost) ── */
  nodes.pink=makePink(ctx);
  nodes.indHP=ctx.createBiquadFilter(); nodes.indHP.type='highpass';
  nodes.indHP.frequency.value=900;
  nodes.indBP=ctx.createBiquadFilter(); nodes.indBP.type='bandpass';
  nodes.indBP.frequency.value=3000; nodes.indBP.Q.value=0.7;
  nodes.indG=ctx.createGain(); nodes.indG.gain.value=0;
  nodes.pink.connect(nodes.indHP); nodes.indHP.connect(nodes.indBP);
  nodes.indBP.connect(nodes.indG); nodes.indG.connect(nodes.finalLP);

  /* ── Exhaust pop/crackle ── */
  nodes.popN=makePink(ctx);
  nodes.popF=ctx.createBiquadFilter(); nodes.popF.type='bandpass';
  nodes.popF.frequency.value=1100; nodes.popF.Q.value=5;
  nodes.popG=ctx.createGain(); nodes.popG.gain.setValueAtTime(0,t);
  nodes.popN.connect(nodes.popF); nodes.popF.connect(nodes.popG);
  nodes.popG.connect(nodes.comp);

  /* ── BOV (blow-off valve) ── */
  nodes.bovN=makePink(ctx);
  nodes.bovHP=ctx.createBiquadFilter(); nodes.bovHP.type='highpass';
  nodes.bovHP.frequency.value=500;
  nodes.bovF=ctx.createBiquadFilter(); nodes.bovF.type='bandpass';
  nodes.bovF.frequency.value=1400; nodes.bovF.Q.value=2.8;
  nodes.bovG=ctx.createGain(); nodes.bovG.gain.setValueAtTime(0,t);
  nodes.bovN.connect(nodes.bovHP); nodes.bovHP.connect(nodes.bovF);
  nodes.bovF.connect(nodes.bovG); nodes.bovG.connect(nodes.comp);

  /* start all oscillators */
  [nodes.oscA,nodes.oscSub,nodes.fmMod,nodes.t1,nodes.t2].forEach(function(o){o.start();});
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

function startLoop() {
  if (rafId) cancelAnimationFrame(rafId);
  lastTs=performance.now();
  function loop(ts) {
    var dt=Math.min((ts-lastTs)/1000,0.08); lastTs=ts;
    var diff=tgtRPM-curRPM;
    curRPM+=diff*(diff>0?3.8:2.4)*dt;
    curRPM=clamp(curRPM,IDLE*0.93,MAX);

    if (bovCD>0) bovCD-=dt;
    else if (lastThr>0.45&&curThr<0.12&&curRPM>2500) {
      triggerBOV(clamp((curRPM-2000)/4500,0,1));
      bovCD=0.65;
    }
    if (popCD>0) popCD-=dt;
    else if (curRPM>3200&&tgtRPM<curRPM-400) {
      if (Math.random()<clamp((curRPM-2800)/4000,0,1)*0.55) {
        triggerPop(); popCD=0.04+Math.random()*0.09;
      }
    }
    lastThr=curThr;
    update(curRPM,curThr);
    rafId=requestAnimationFrame(loop);
  }
  rafId=requestAnimationFrame(loop);
}

function update(rpm,thr) {
  if (!ctx||!active) return;
  var t=ctx.currentTime, tau=0.02;
  var hz=fireHz(rpm);
  var frac=clamp((rpm-IDLE)/(MAX-IDLE),0,1);

  // Engine oscillators
  nodes.oscA.frequency.setTargetAtTime(hz,t,tau);
  nodes.oscSub.frequency.setTargetAtTime(hz/3,t,tau);
  nodes.fmMod.frequency.setTargetAtTime(hz/2,t,tau);
  nodes.fmAmt.gain.setTargetAtTime(1.5+frac*4,t,tau); // FM depth rises with RPM

  // Engine gain fades as turbo takes over above ~3000 RPM
  var engDom = clamp(1-Math.pow(frac,0.7)*0.65, 0.35, 1);
  nodes.gainA.gain.setTargetAtTime(0.65*engDom+thr*0.1,t,tau);
  nodes.gainSub.gain.setTargetAtTime(0.28*engDom,t,tau);
  nodes.engMix.gain.setTargetAtTime(0.42+thr*0.16,t,tau);

  // Drive & distortion
  nodes.dist.curve=makeClip(3.2+thr*5+frac*2.5);
  nodes.drive.gain.setTargetAtTime(2.3+thr*3+frac*1.8,t,tau);
  nodes.postLP.frequency.setTargetAtTime(1400+frac*3600+thr*1400,t,tau);

  // Reverb dry/wet shift slightly with throttle
  nodes.reverbGain.gain.setTargetAtTime(0.4+thr*0.25,t,tau);
  nodes.reverbDry.gain.setTargetAtTime(0.75-thr*0.1,t,tau);

  // Twin turbo whine — dominant at high RPM
  // Volume curve: barely audible until ~2000 RPM, then rises steeply
  var turboBase = Math.pow(clamp(frac-0.1,0,1)/0.9,1.4);
  var turboVol  = turboBase*0.7 + thr*turboBase*0.4;
  var tf1=t1Hz(frac), tf2=t2Hz(frac);
  nodes.t1.frequency.setTargetAtTime(tf1,t,tau);
  nodes.t1f.frequency.setTargetAtTime(tf1,t,tau);
  nodes.t2.frequency.setTargetAtTime(tf2,t,tau);
  nodes.t2f.frequency.setTargetAtTime(tf2,t,tau);
  nodes.t1g.gain.setTargetAtTime(clamp(turboVol,0,0.9),t,tau);
  nodes.t2g.gain.setTargetAtTime(clamp(turboVol*0.82,0,0.75),t,tau);

  // Induction noise (rises sharply under boost / high RPM)
  var indVol=Math.pow(frac,1.6)*0.22+thr*frac*0.2;
  nodes.indG.gain.setTargetAtTime(clamp(indVol,0,0.45),t,tau);
  nodes.indBP.frequency.setTargetAtTime(1200+frac*5000+thr*2000,t,tau);
  nodes.indHP.frequency.setTargetAtTime(500+frac*1000,t,tau);

  // EQ
  nodes.pres.frequency.setTargetAtTime(380+frac*380,t,tau);
  nodes.pres.gain.setTargetAtTime(4+thr*5,t,tau);
  nodes.finalLP.frequency.setTargetAtTime(4000+frac*4000,t,tau);

  // Rev limiter
  if (rpm>RED) {
    nodes.master.gain.setTargetAtTime(0.88*(1-(rpm-RED)/(MAX-RED)*0.5),t,0.007);
  } else {
    nodes.master.gain.setTargetAtTime(0.88,t,tau);
  }
}

/* ── Message handler ── */
function onMsg(evt) {
  var msg; try{msg=JSON.parse(evt.data);}catch(e){return;}
  if (!msg||!msg.type) return;
  switch(msg.type) {
    case 'start':
      if (!ctx) {
        ctx=new (window.AudioContext||window.webkitAudioContext)();
        buildGraph();
        // Try to resume (may require user gesture on iOS, but attempt anyway)
        ctx.resume().then(function(){
          tgtRPM=920;
          setTimeout(function(){tgtRPM=IDLE;},800);
          setTimeout(function(){nodes.master.gain.setTargetAtTime(0.88,ctx.currentTime,0.4);},60);
          active=true; startLoop();
        });
      } else if (ctx.state==='suspended') {
        ctx.resume().then(function(){
          nodes.master.gain.setTargetAtTime(0.88,ctx.currentTime,0.3);
          active=true; startLoop();
        });
      } else if (!active) {
        nodes.master.gain.setTargetAtTime(0.88,ctx.currentTime,0.3);
        active=true; startLoop();
      }
      break;
    case 'stop':
      active=false;
      if (rafId){cancelAnimationFrame(rafId);rafId=null;}
      if (ctx) nodes.master.gain.setTargetAtTime(0,ctx.currentTime,0.7);
      curRPM=IDLE; tgtRPM=IDLE; curThr=0; lastThr=0;
      break;
    case 'setRPM':
      tgtRPM=clamp(msg.rpm||IDLE,IDLE,MAX);
      curThr=clamp(msg.throttle||0,0,1);
      break;
  }
}
window.addEventListener('message',onMsg);
document.addEventListener('message',onMsg);

// Also try to unlock on any touch in the WebView (iOS safety net)
document.addEventListener('touchstart',function(){
  if (ctx&&ctx.state==='suspended') ctx.resume();
},{passive:true});

function postRN(d){try{if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify(d));}catch(e){}}
postRN({type:'ready'});
})();
</script></body></html>`;
