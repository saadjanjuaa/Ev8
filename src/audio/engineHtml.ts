export const ENGINE_HTML = `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{margin:0;padding:0}html,body{width:100%;height:100%;background:transparent;overflow:hidden}</style>
</head><body><script>
(function(){
'use strict';

var IDLE=720, MAX=7000, RED=6500;
var ctx=null, nodes={}, active=false;
var curRPM=IDLE, tgtRPM=IDLE, curThr=0, lastThr=0;
var rafId=null, lastTs=0, bovCD=0, popCD=0;

function clamp(v,a,b){return v<a?a:v>b?b:v;}

/* ── Pink noise ── */
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

/* ── Exhaust pipe IR (tight resonant reverb) ── */
function makeExhaustIR() {
  var sr=ctx.sampleRate, len=Math.floor(sr*0.28);
  var buf=ctx.createBuffer(2,len,sr);
  for(var ch=0;ch<2;ch++){
    var d=buf.getChannelData(ch);
    for(var i=0;i<len;i++){
      var t=i/sr, pre=0.005;
      if(t<pre){d[i]=0;continue;}
      var decay=Math.exp(-(t-pre)*22); // longer decay = more pipe resonance
      var er=(i>Math.floor(0.014*sr))?d[i-Math.floor(0.014*sr)]*0.35:0;
      d[i]=((Math.random()*2-1)*decay+er)*(ch===0?1:0.88);
    }
  }
  return buf;
}

/* ── Soft saturation (warmer than hard clip) ── */
function makeSat(drive) {
  var N=512, c=new Float32Array(N);
  for(var i=0;i<N;i++){
    var x=(i*2/N)-1, y=x*drive;
    // tanh-like soft clip — keeps harmonics without harsh buzz
    c[i]=clamp((3*y-(y*y*y))/(2+Math.abs(y)*0.5)/drive,-1,1);
  }
  return c;
}

/* ── RB26DETT inline-6 Fourier wave (deep bark character) ── */
function makeRB26Wave() {
  var H=10, re=new Float32Array(H+1), im=new Float32Array(H+1);
  // Strong fundamental + 3rd harmonic = inline-6 bark
  // Reduced high harmonics = less whine, more depth
  re[1]=1.00; re[2]=0.28; re[3]=0.82; re[4]=0.10;
  re[5]=0.22; re[6]=0.06; re[7]=0.12; re[8]=0.04;
  re[9]=0.07; re[10]=0.03;
  // Phase offsets for asymmetry (combustion is not symmetric)
  im[2]=0.15; im[3]=0.22; im[5]=-0.10;
  return ctx.createPeriodicWave(re, im, {disableNormalization:false});
}

function fireHz(rpm){return (rpm/60)*3;} // inline-6: 3 firings/rev
function t1Hz(f){return 180+Math.pow(f,1.3)*3600;}
function t2Hz(f){return 165+Math.pow(f,1.3)*3400;}

/* ── Build audio graph ── */
function buildGraph() {
  var t=ctx.currentTime, hz=fireHz(IDLE);

  /* master → destination */
  nodes.master=ctx.createGain(); nodes.master.gain.setValueAtTime(0,t);
  nodes.master.connect(ctx.destination);

  /* compressor */
  nodes.comp=ctx.createDynamicsCompressor();
  nodes.comp.threshold.value=-8; nodes.comp.knee.value=10;
  nodes.comp.ratio.value=3; nodes.comp.attack.value=0.003;
  nodes.comp.release.value=0.12; nodes.comp.connect(nodes.master);

  /* hi-shelf (subtle air) */
  nodes.hiShelf=ctx.createBiquadFilter();
  nodes.hiShelf.type='highshelf'; nodes.hiShelf.frequency.value=6000;
  nodes.hiShelf.gain.value=1.5; nodes.hiShelf.connect(nodes.comp);

  /* presence peak — exhaust bark */
  nodes.pres=ctx.createBiquadFilter();
  nodes.pres.type='peaking'; nodes.pres.frequency.value=480;
  nodes.pres.Q.value=0.9; nodes.pres.gain.value=5;
  nodes.pres.connect(nodes.hiShelf);

  /* bass boost — depth and weight */
  nodes.bass=ctx.createBiquadFilter();
  nodes.bass.type='peaking'; nodes.bass.frequency.value=110;
  nodes.bass.Q.value=0.7; nodes.bass.gain.value=7;
  nodes.bass.connect(nodes.pres);

  /* main LP */
  nodes.finalLP=ctx.createBiquadFilter();
  nodes.finalLP.type='lowpass'; nodes.finalLP.frequency.value=6500;
  nodes.finalLP.Q.value=0.55; nodes.finalLP.connect(nodes.bass);

  /* exhaust reverb */
  nodes.reverb=ctx.createConvolver(); nodes.reverb.buffer=makeExhaustIR();
  nodes.reverbGain=ctx.createGain(); nodes.reverbGain.gain.value=0.55;
  nodes.reverbDry=ctx.createGain(); nodes.reverbDry.gain.value=0.65;
  nodes.reverbDry.connect(nodes.finalLP);
  nodes.reverbGain.connect(nodes.reverb); nodes.reverb.connect(nodes.finalLP);

  nodes.outputHP=ctx.createBiquadFilter();
  nodes.outputHP.type='highpass'; nodes.outputHP.frequency.value=60;
  nodes.outputHP.Q.value=0.7;
  nodes.outputHP.connect(nodes.reverbDry); nodes.outputHP.connect(nodes.reverbGain);

  /* saturation */
  nodes.postLP=ctx.createBiquadFilter();
  nodes.postLP.type='lowpass'; nodes.postLP.frequency.value=2800;
  nodes.postLP.Q.value=0.45; nodes.postLP.connect(nodes.outputHP);

  nodes.dist=ctx.createWaveShaper();
  nodes.dist.curve=makeSat(2.8); nodes.dist.oversample='4x';
  nodes.dist.connect(nodes.postLP);

  nodes.drive=ctx.createGain(); nodes.drive.gain.value=2.2;
  nodes.drive.connect(nodes.dist);

  nodes.engMix=ctx.createGain(); nodes.engMix.gain.value=0.52;
  nodes.engMix.connect(nodes.drive);

  /* ── Main oscillator (RB26 wave) ── */
  var wave=makeRB26Wave();
  nodes.oscA=ctx.createOscillator(); nodes.oscA.setPeriodicWave(wave);
  nodes.oscA.frequency.setValueAtTime(hz,t);

  /* FM modulator — organic warble */
  nodes.fmMod=ctx.createOscillator(); nodes.fmMod.type='sine';
  nodes.fmMod.frequency.setValueAtTime(hz*0.5,t);
  nodes.fmAmt=ctx.createGain(); nodes.fmAmt.gain.value=1.2;
  nodes.fmMod.connect(nodes.fmAmt); nodes.fmAmt.connect(nodes.oscA.frequency);

  /* AM modulator at firing frequency — creates combustion pulse/throb
     gainA.gain = 0.48 (DC) + amOsc*0.30 → pulses between 0.18 and 0.78 */
  nodes.gainA=ctx.createGain(); nodes.gainA.gain.setValueAtTime(0.48,t);
  nodes.oscA.connect(nodes.gainA); nodes.gainA.connect(nodes.engMix);

  nodes.amOsc=ctx.createOscillator(); nodes.amOsc.type='sawtooth';
  nodes.amOsc.frequency.setValueAtTime(hz,t); // sawtooth = sharp attack per firing
  nodes.amAmt=ctx.createGain(); nodes.amAmt.gain.value=0.30;
  nodes.amOsc.connect(nodes.amAmt); nodes.amAmt.connect(nodes.gainA.gain);

  /* Second osc detuned +4 cents — thickness / beating */
  nodes.oscB=ctx.createOscillator(); nodes.oscB.setPeriodicWave(wave);
  nodes.oscB.frequency.setValueAtTime(hz*1.0023,t); // +4 cents
  nodes.gainB=ctx.createGain(); nodes.gainB.gain.setValueAtTime(0.32,t);
  nodes.oscB.connect(nodes.gainB); nodes.gainB.connect(nodes.engMix);

  /* Sub — crank frequency, heavy and deep */
  nodes.oscSub=ctx.createOscillator(); nodes.oscSub.type='sine';
  nodes.oscSub.frequency.setValueAtTime(hz/3,t);
  nodes.gainSub=ctx.createGain(); nodes.gainSub.gain.setValueAtTime(0.55,t);
  nodes.oscSub.connect(nodes.gainSub); nodes.gainSub.connect(nodes.engMix);

  /* ── Twin turbo whine ── */
  nodes.t1=ctx.createOscillator(); nodes.t1.type='sawtooth';
  nodes.t1.frequency.setValueAtTime(t1Hz(0),t);
  nodes.t1f=ctx.createBiquadFilter(); nodes.t1f.type='bandpass';
  nodes.t1f.frequency.setValueAtTime(t1Hz(0),t); nodes.t1f.Q.value=30;
  nodes.t1g=ctx.createGain(); nodes.t1g.gain.setValueAtTime(0,t);
  nodes.t1.connect(nodes.t1f); nodes.t1f.connect(nodes.t1g);

  nodes.t2=ctx.createOscillator(); nodes.t2.type='sawtooth';
  nodes.t2.frequency.setValueAtTime(t2Hz(0),t);
  nodes.t2f=ctx.createBiquadFilter(); nodes.t2f.type='bandpass';
  nodes.t2f.frequency.setValueAtTime(t2Hz(0),t); nodes.t2f.Q.value=22;
  nodes.t2g=ctx.createGain(); nodes.t2g.gain.setValueAtTime(0,t);
  nodes.t2.connect(nodes.t2f); nodes.t2f.connect(nodes.t2g);

  nodes.turboMix=ctx.createGain(); nodes.turboMix.gain.value=1;
  nodes.t1g.connect(nodes.turboMix); nodes.t2g.connect(nodes.turboMix);
  nodes.turboMix.connect(nodes.finalLP);

  /* ── Induction noise ── */
  nodes.pink=makePink();
  nodes.indHP=ctx.createBiquadFilter(); nodes.indHP.type='highpass';
  nodes.indHP.frequency.value=800;
  nodes.indBP=ctx.createBiquadFilter(); nodes.indBP.type='bandpass';
  nodes.indBP.frequency.value=2800; nodes.indBP.Q.value=0.65;
  nodes.indG=ctx.createGain(); nodes.indG.gain.value=0;
  nodes.pink.connect(nodes.indHP); nodes.indHP.connect(nodes.indBP);
  nodes.indBP.connect(nodes.indG); nodes.indG.connect(nodes.finalLP);

  /* ── Exhaust pop/crackle ── */
  nodes.popN=makePink();
  nodes.popF=ctx.createBiquadFilter(); nodes.popF.type='bandpass';
  nodes.popF.frequency.value=900; nodes.popF.Q.value=4;
  nodes.popG=ctx.createGain(); nodes.popG.gain.setValueAtTime(0,t);
  nodes.popN.connect(nodes.popF); nodes.popF.connect(nodes.popG);
  nodes.popG.connect(nodes.comp);

  /* ── BOV ── */
  nodes.bovN=makePink();
  nodes.bovHP=ctx.createBiquadFilter(); nodes.bovHP.type='highpass';
  nodes.bovHP.frequency.value=400;
  nodes.bovF=ctx.createBiquadFilter(); nodes.bovF.type='bandpass';
  nodes.bovF.frequency.value=1200; nodes.bovF.Q.value=2.5;
  nodes.bovG=ctx.createGain(); nodes.bovG.gain.setValueAtTime(0,t);
  nodes.bovN.connect(nodes.bovHP); nodes.bovHP.connect(nodes.bovF);
  nodes.bovF.connect(nodes.bovG); nodes.bovG.connect(nodes.comp);

  [nodes.oscA,nodes.oscB,nodes.oscSub,nodes.fmMod,nodes.amOsc,nodes.t1,nodes.t2]
    .forEach(function(o){o.start();});
}

/* ── BOV ── */
function triggerBOV(intensity) {
  if(!ctx||!active) return;
  var t=ctx.currentTime, dur=0.12+intensity*0.28, vol=0.55+intensity*0.55;
  nodes.bovF.frequency.cancelScheduledValues(t);
  nodes.bovF.frequency.setValueAtTime(1400+intensity*1600,t);
  nodes.bovF.frequency.exponentialRampToValueAtTime(280,t+dur);
  nodes.bovG.gain.cancelScheduledValues(t);
  nodes.bovG.gain.setValueAtTime(0,t);
  nodes.bovG.gain.linearRampToValueAtTime(vol,t+0.01);
  nodes.bovG.gain.exponentialRampToValueAtTime(0.001,t+dur);
}

/* ── Exhaust pop ── */
function triggerPop() {
  if(!ctx||!active) return;
  var t=ctx.currentTime;
  nodes.popF.frequency.setValueAtTime(600+Math.random()*800,t);
  nodes.popG.gain.cancelScheduledValues(t);
  nodes.popG.gain.setValueAtTime(0,t);
  nodes.popG.gain.linearRampToValueAtTime(0.65,t+0.004);
  nodes.popG.gain.exponentialRampToValueAtTime(0.001,t+0.04+Math.random()*0.04);
}

/* ── Gear shift clunk ── */
function triggerGearShift() {
  if(!ctx||!active) return;
  var t=ctx.currentTime;
  // Low-frequency clunk via pop node
  nodes.popF.frequency.setValueAtTime(90+Math.random()*60,t);
  nodes.popF.Q.value=3;
  nodes.popG.gain.cancelScheduledValues(t);
  nodes.popG.gain.setValueAtTime(0,t);
  nodes.popG.gain.linearRampToValueAtTime(0.5,t+0.006);
  nodes.popG.gain.exponentialRampToValueAtTime(0.001,t+0.14);
  nodes.popF.Q.value=4; // restore
  // Brief volume dip — clutch in/out feel
  nodes.master.gain.cancelScheduledValues(t);
  nodes.master.gain.setValueAtTime(0.88,t);
  nodes.master.gain.linearRampToValueAtTime(0.28,t+0.04);
  nodes.master.gain.linearRampToValueAtTime(0.88,t+0.20);
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
    else if(lastThr>0.30&&curThr<0.08&&curRPM>1800){
      triggerBOV(clamp((curRPM-1500)/4000,0,1));
      bovCD=0.7;
    }
    if(popCD>0) popCD-=dt;
    else if(curRPM>2500&&tgtRPM<curRPM-350){
      if(Math.random()<clamp((curRPM-2200)/4000,0,1)*0.65){
        triggerPop(); popCD=0.03+Math.random()*0.08;
      }
    }
    lastThr=curThr;
    update(curRPM,curThr);
    rafId=requestAnimationFrame(loop);
  }
  rafId=requestAnimationFrame(loop);
}

function update(rpm,thr){
  if(!ctx||!active) return;
  var t=ctx.currentTime, tau=0.04;
  var hz=fireHz(rpm);
  var frac=clamp((rpm-IDLE)/(MAX-IDLE),0,1);

  /* engine oscillators */
  nodes.oscA.frequency.setTargetAtTime(hz,t,tau);
  nodes.oscB.frequency.setTargetAtTime(hz*1.0023,t,tau);
  nodes.oscSub.frequency.setTargetAtTime(hz/3,t,tau);
  nodes.fmMod.frequency.setTargetAtTime(hz*0.5,t,tau);
  nodes.amOsc.frequency.setTargetAtTime(hz,t,tau);

  /* AM depth increases with RPM — more pulse at high revs */
  nodes.amAmt.gain.setTargetAtTime(0.22+frac*0.18,t,tau);
  nodes.fmAmt.gain.setTargetAtTime(0.8+frac*2.2,t,tau);

  /* engine/turbo crossfade — engine dominant below 2500 RPM */
  var engDom=clamp(1-Math.pow(frac,0.65)*0.60,0.38,1);
  nodes.gainA.gain.setTargetAtTime(0.48*engDom+thr*0.10,t,tau); // DC part
  nodes.gainB.gain.setTargetAtTime(0.30*engDom,t,tau);
  nodes.gainSub.gain.setTargetAtTime(0.55*engDom+0.10,t,tau); // keep sub audible

  nodes.engMix.gain.setTargetAtTime(0.48+thr*0.18,t,tau);
  nodes.drive.gain.setTargetAtTime(2.0+thr*2.8+frac*1.5,t,tau);
  nodes.dist.curve=makeSat(2.4+thr*3.8+frac*2.0);
  nodes.postLP.frequency.setTargetAtTime(1600+frac*3800+thr*1200,t,tau);

  /* reverb opens with throttle (more exhaust resonance under load) */
  nodes.reverbGain.gain.setTargetAtTime(0.45+thr*0.3,t,tau);
  nodes.reverbDry.gain.setTargetAtTime(0.70-thr*0.08,t,tau);

  /* turbo — only from ~2000 RPM upward */
  var turboBase=Math.pow(clamp(frac-0.08,0,1)/0.92,1.5);
  var turboVol=turboBase*0.55+thr*turboBase*0.45;
  var tf1=t1Hz(frac), tf2=t2Hz(frac);
  nodes.t1.frequency.setTargetAtTime(tf1,t,tau);
  nodes.t1f.frequency.setTargetAtTime(tf1,t,tau);
  nodes.t2.frequency.setTargetAtTime(tf2,t,tau);
  nodes.t2f.frequency.setTargetAtTime(tf2,t,tau);
  nodes.t1g.gain.setTargetAtTime(clamp(turboVol,0,0.85),t,tau);
  nodes.t2g.gain.setTargetAtTime(clamp(turboVol*0.80,0,0.70),t,tau);

  /* induction noise */
  var indVol=Math.pow(frac,1.8)*0.18+thr*frac*0.22;
  nodes.indG.gain.setTargetAtTime(clamp(indVol,0,0.40),t,tau);
  nodes.indBP.frequency.setTargetAtTime(1000+frac*4500+thr*1800,t,tau);

  /* EQ — presence shifts up with RPM */
  nodes.pres.frequency.setTargetAtTime(360+frac*320,t,tau);
  nodes.pres.gain.setTargetAtTime(4+thr*4.5,t,tau);
  nodes.bass.gain.setTargetAtTime(8-frac*4,t,tau); // bass rolls off at high RPM
  nodes.finalLP.frequency.setTargetAtTime(3800+frac*3800,t,tau);

  /* rev limiter */
  if(rpm>RED){
    nodes.master.gain.setTargetAtTime(0.88*(1-(rpm-RED)/(MAX-RED)*0.55),t,0.005);
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
        tgtRPM=950; setTimeout(function(){tgtRPM=IDLE;},700);
        setTimeout(function(){nodes.master.gain.setTargetAtTime(0.88,ctx.currentTime,0.35);},50);
        active=true; startLoop();
      });
      break;
    case 'stop':
      active=false;
      if(rafId){cancelAnimationFrame(rafId);rafId=null;}
      if(ctx) nodes.master.gain.setTargetAtTime(0,ctx.currentTime,0.6);
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
