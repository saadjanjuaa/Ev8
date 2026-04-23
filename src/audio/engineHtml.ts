// Nissan GT-R R35 VR38DETT — Twin-Turbo V6 synthesizer
// Sonic signature:
//   • V6 firing pattern (3 power strokes / crank revolution)
//   • Twin-turbo compressor whine rising sharply with RPM
//   • Blow-off valve "pssh" on throttle lift
//   • Metallic, clipped exhaust crackle at high RPM
//   • More even harmonic balance than a V8 (less "potato" burble)

export const ENGINE_HTML = `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>*{margin:0;padding:0}body{background:transparent}</style>
</head><body><script>
(function(){
'use strict';

var IDLE_RPM = 720;
var MAX_RPM  = 8000;
var RED_RPM  = 7400;

var ctx           = null;
var nodes         = {};
var engineActive  = false;
var currentRPM    = IDLE_RPM;
var targetRPM     = IDLE_RPM;
var currentThrottle = 0;
var lastThrottle  = 0;
var rafId         = null;
var lastTs        = 0;
var bovCooldown   = 0;
var popCooldown   = 0;

function clamp(v,lo,hi){return v<lo?lo:v>hi?hi:v;}

/* ── Hard-clip distortion (more digital/aggressive than V8 soft-clip) ────── */
function makeHardClip(drive) {
  var N = 512, c = new Float32Array(N);
  for (var i = 0; i < N; i++) {
    var x = (i * 2 / N) - 1;
    var y = x * drive;
    // Asymmetric: slightly harder negative clip (exhaust backpressure character)
    if (y > 0)  y = 1 - Math.exp(-y);
    else        y = -(1 - Math.exp(y * 0.85)) * 1.1;
    c[i] = clamp(y / drive, -1, 1);
  }
  return c;
}

/* ── White noise buffer ──────────────────────────────────────────────────── */
function makeNoise(ctx) {
  var len = ctx.sampleRate * 4;
  var buf = ctx.createBuffer(1, len, ctx.sampleRate);
  var d   = buf.getChannelData(0);
  for (var i = 0; i < len; i++) d[i] = Math.random()*2-1;
  var s = ctx.createBufferSource();
  s.buffer = buf; s.loop = true; s.start(0);
  return s;
}

/* ── VR38DETT Fourier series ─────────────────────────────────────────────── */
// V6 at 60° bank angle creates stronger even harmonics than a cross-plane V8.
// The twin-turbo compresses the exhaust pulse, emphasising mid harmonics.
function makeGTRWave(ctx) {
  var H  = 14;
  var re = new Float32Array(H+1);
  var im = new Float32Array(H+1);
  // Tuned to match recorded GTR spectral analysis
  re[1]  = 1.00;   // fundamental — less dominant than V8
  re[2]  = 0.62;   // 2nd ← V6 character (strong even harmonic)
  re[3]  = 0.58;   // 3rd
  re[4]  = 0.34;
  re[5]  = 0.50;   // 5th ← twin-scroll scavenging emphasis
  re[6]  = 0.22;
  re[7]  = 0.28;
  re[8]  = 0.12;
  re[9]  = 0.18;
  re[10] = 0.07;
  re[11] = 0.13;
  re[12] = 0.05;
  // Asymmetric phase gives directional exhaust feel
  im[2]  =  0.18;
  im[4]  = -0.11;
  im[6]  =  0.07;
  return ctx.createPeriodicWave(re, im, {disableNormalization: false});
}

// V6: 3 power strokes per crank revolution
function fireHz(rpm)  { return (rpm / 60) * 3; }

// Twin-turbo compressor whine — two slightly different pitches
function turbo1Hz(f)  { return 180 + Math.pow(f, 1.4) * 3800; }
function turbo2Hz(f)  { return 168 + Math.pow(f, 1.4) * 3550; }

/* ── Build audio graph ───────────────────────────────────────────────────── */
function init() {
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  var t  = ctx.currentTime;
  var hz = fireHz(IDLE_RPM);
  var f0 = 0; // rpmFrac at init

  /* ── Output chain ── */
  nodes.master = ctx.createGain();
  nodes.master.gain.setValueAtTime(0, t);
  nodes.master.connect(ctx.destination);

  nodes.comp = ctx.createDynamicsCompressor();
  nodes.comp.threshold.value = -9;
  nodes.comp.knee.value      = 8;
  nodes.comp.ratio.value     = 3.5;
  nodes.comp.attack.value    = 0.002;
  nodes.comp.release.value   = 0.1;
  nodes.comp.connect(nodes.master);

  // High shelf — GTR has sizzle in the 5–10 kHz range
  nodes.hiShelf = ctx.createBiquadFilter();
  nodes.hiShelf.type = 'highshelf';
  nodes.hiShelf.frequency.value = 6000;
  nodes.hiShelf.gain.value = 1.5;
  nodes.hiShelf.connect(nodes.comp);

  // Mid presence
  nodes.presence = ctx.createBiquadFilter();
  nodes.presence.type = 'peaking';
  nodes.presence.frequency.value = 550;
  nodes.presence.Q.value = 0.8;
  nodes.presence.gain.value = 5;
  nodes.presence.connect(nodes.hiShelf);

  // Final LP — tame ultra-high freq noise
  nodes.finalLP = ctx.createBiquadFilter();
  nodes.finalLP.type = 'lowpass';
  nodes.finalLP.frequency.value = 7000;
  nodes.finalLP.Q.value = 0.6;
  nodes.finalLP.connect(nodes.presence);

  // HP — remove subsonic mud (GTR is tighter in the low end vs V8)
  nodes.outputHP = ctx.createBiquadFilter();
  nodes.outputHP.type = 'highpass';
  nodes.outputHP.frequency.value = 70;
  nodes.outputHP.Q.value = 0.8;
  nodes.outputHP.connect(nodes.finalLP);

  // Post-distortion LP
  nodes.postLP = ctx.createBiquadFilter();
  nodes.postLP.type = 'lowpass';
  nodes.postLP.frequency.value = 3000;
  nodes.postLP.Q.value = 0.5;
  nodes.postLP.connect(nodes.outputHP);

  // Hard-clip distortion (GTR = more "digital" sounding than a V8)
  nodes.dist = ctx.createWaveShaper();
  nodes.dist.curve = makeHardClip(3.5);
  nodes.dist.oversample = '4x';
  nodes.dist.connect(nodes.postLP);

  // Drive gain
  nodes.drive = ctx.createGain();
  nodes.drive.gain.value = 2.5;
  nodes.drive.connect(nodes.dist);

  // Engine oscillator mix
  nodes.engMix = ctx.createGain();
  nodes.engMix.gain.value = 0.5;
  nodes.engMix.connect(nodes.drive);

  /* ── Main engine oscillator (V6 wave) ── */
  var wave = makeGTRWave(ctx);
  nodes.oscA = ctx.createOscillator();
  nodes.oscA.setPeriodicWave(wave);
  nodes.oscA.frequency.setValueAtTime(hz, t);

  nodes.gainA = ctx.createGain();
  nodes.gainA.gain.setValueAtTime(0.75, t);
  nodes.oscA.connect(nodes.gainA);
  nodes.gainA.connect(nodes.engMix);

  /* ── Sub oscillator — crank frequency (hz/3) — lighter than V8 ── */
  nodes.oscSub = ctx.createOscillator();
  nodes.oscSub.type = 'sine';
  nodes.oscSub.frequency.setValueAtTime(hz / 3, t);
  nodes.gainSub = ctx.createGain();
  nodes.gainSub.gain.setValueAtTime(0.30, t);  // less sub than V8
  nodes.oscSub.connect(nodes.gainSub);
  nodes.gainSub.connect(nodes.engMix);

  /* ── Slight wow LFO — mechanical character ── */
  nodes.wowLFO = ctx.createOscillator();
  nodes.wowLFO.frequency.value = 3.1;
  nodes.wowAmt = ctx.createGain();
  nodes.wowAmt.gain.value = 0.8;
  nodes.wowLFO.connect(nodes.wowAmt);
  nodes.wowAmt.connect(nodes.oscA.frequency);

  /* ══ TWIN-TURBO WHINE ══════════════════════════════════════════════════ */
  // Two oscillators (turbo 1 and 2), both with resonant filters
  // They combine to give that distinctive layered GTR whine

  // Turbo 1
  nodes.turbo1 = ctx.createOscillator();
  nodes.turbo1.type = 'sawtooth';
  nodes.turbo1.frequency.setValueAtTime(turbo1Hz(f0), t);

  nodes.turbo1Filter = ctx.createBiquadFilter();
  nodes.turbo1Filter.type = 'bandpass';
  nodes.turbo1Filter.frequency.setValueAtTime(turbo1Hz(f0), t);
  nodes.turbo1Filter.Q.value = 18; // Very resonant — that metallic whine quality

  nodes.turbo1Gain = ctx.createGain();
  nodes.turbo1Gain.gain.setValueAtTime(0, t); // silent at idle

  nodes.turbo1.connect(nodes.turbo1Filter);
  nodes.turbo1Filter.connect(nodes.turbo1Gain);

  // Turbo 2 (slightly different pitch — second turbo)
  nodes.turbo2 = ctx.createOscillator();
  nodes.turbo2.type = 'sawtooth';
  nodes.turbo2.frequency.setValueAtTime(turbo2Hz(f0), t);

  nodes.turbo2Filter = ctx.createBiquadFilter();
  nodes.turbo2Filter.type = 'bandpass';
  nodes.turbo2Filter.frequency.setValueAtTime(turbo2Hz(f0), t);
  nodes.turbo2Filter.Q.value = 15;

  nodes.turbo2Gain = ctx.createGain();
  nodes.turbo2Gain.gain.setValueAtTime(0, t);

  nodes.turbo2.connect(nodes.turbo2Filter);
  nodes.turbo2Filter.connect(nodes.turbo2Gain);

  // Turbo mix → bypass distortion, goes straight to output HP
  nodes.turboMix = ctx.createGain();
  nodes.turboMix.gain.value = 1;
  nodes.turbo1Gain.connect(nodes.turboMix);
  nodes.turbo2Gain.connect(nodes.turboMix);
  nodes.turboMix.connect(nodes.outputHP);

  /* ══ INDUCTION NOISE (pressurized air rushing through intake) ══════════ */
  nodes.induction = makeNoise(ctx);
  nodes.inductionHP = ctx.createBiquadFilter();
  nodes.inductionHP.type = 'highpass';
  nodes.inductionHP.frequency.value = 1000;
  nodes.inductionBP = ctx.createBiquadFilter();
  nodes.inductionBP.type = 'bandpass';
  nodes.inductionBP.frequency.value = 3000;
  nodes.inductionBP.Q.value = 0.6;
  nodes.inductionGain = ctx.createGain();
  nodes.inductionGain.gain.value = 0;

  nodes.induction.connect(nodes.inductionHP);
  nodes.inductionHP.connect(nodes.inductionBP);
  nodes.inductionBP.connect(nodes.inductionGain);
  nodes.inductionGain.connect(nodes.finalLP);

  /* ══ EXHAUST CRACKLE / POPS ════════════════════════════════════════════ */
  nodes.popNoise = makeNoise(ctx);
  nodes.popFilter = ctx.createBiquadFilter();
  nodes.popFilter.type = 'bandpass';
  nodes.popFilter.frequency.value = 1200;
  nodes.popFilter.Q.value = 5;
  nodes.popGain = ctx.createGain();
  nodes.popGain.gain.setValueAtTime(0, t);
  nodes.popNoise.connect(nodes.popFilter);
  nodes.popFilter.connect(nodes.popGain);
  nodes.popGain.connect(nodes.comp);

  /* ══ BLOW-OFF VALVE ═══════════════════════════════════════════════════ */
  // BOV = that "pssh" / "whoosh" sound when you lift off at high boost
  nodes.bovNoise = makeNoise(ctx);
  nodes.bovHP = ctx.createBiquadFilter();
  nodes.bovHP.type = 'highpass';
  nodes.bovHP.frequency.value = 600;
  nodes.bovFilter = ctx.createBiquadFilter();
  nodes.bovFilter.type = 'bandpass';
  nodes.bovFilter.frequency.value = 1500;
  nodes.bovFilter.Q.value = 2.5;
  nodes.bovGain = ctx.createGain();
  nodes.bovGain.gain.setValueAtTime(0, t);

  nodes.bovNoise.connect(nodes.bovHP);
  nodes.bovHP.connect(nodes.bovFilter);
  nodes.bovFilter.connect(nodes.bovGain);
  nodes.bovGain.connect(nodes.comp);

  // Start oscillators
  nodes.oscA.start();
  nodes.oscSub.start();
  nodes.wowLFO.start();
  nodes.turbo1.start();
  nodes.turbo2.start();

  engineActive = true;
  lastTs = performance.now();

  // Startup: brief blip to ~900, settle at idle
  targetRPM = 920;
  setTimeout(function(){ targetRPM = IDLE_RPM; }, 800);

  setTimeout(function(){
    nodes.master.gain.setTargetAtTime(0.88, ctx.currentTime, 0.4);
  }, 60);

  startLoop();
}

/* ── Blow-off valve trigger ─────────────────────────────────────────────── */
function triggerBOV(intensity) {
  if (!ctx) return;
  var t   = ctx.currentTime;
  var dur = 0.12 + intensity * 0.2; // longer BOV at higher boost
  var vol = 0.35 + intensity * 0.5;

  nodes.bovFilter.frequency.cancelScheduledValues(t);
  nodes.bovFilter.frequency.setValueAtTime(1800 + intensity * 1200, t);
  nodes.bovFilter.frequency.exponentialRampToValueAtTime(350, t + dur);

  nodes.bovGain.gain.cancelScheduledValues(t);
  nodes.bovGain.gain.setValueAtTime(0, t);
  nodes.bovGain.gain.linearRampToValueAtTime(vol, t + 0.015);
  nodes.bovGain.gain.exponentialRampToValueAtTime(0.001, t + dur);
}

/* ── Exhaust pop trigger ────────────────────────────────────────────────── */
function triggerPop() {
  if (!ctx) return;
  var t    = ctx.currentTime;
  var freq = 900 + Math.random() * 800;
  nodes.popFilter.frequency.setValueAtTime(freq, t);
  nodes.popGain.gain.cancelScheduledValues(t);
  nodes.popGain.gain.setValueAtTime(0, t);
  nodes.popGain.gain.linearRampToValueAtTime(0.45, t + 0.006);
  nodes.popGain.gain.exponentialRampToValueAtTime(0.001, t + 0.04 + Math.random()*0.03);
}

/* ── Main update loop ───────────────────────────────────────────────────── */
function startLoop() {
  if (rafId) cancelAnimationFrame(rafId);
  lastTs = performance.now();

  function loop(ts) {
    var dt = Math.min((ts - lastTs) / 1000, 0.08);
    lastTs = ts;

    // Engine inertia — turbocharged engines have slightly slower RPM response
    var diff = targetRPM - currentRPM;
    var rate = diff > 0 ? 3.8 : 2.5;
    currentRPM += diff * rate * dt;
    currentRPM = clamp(currentRPM, IDLE_RPM * 0.93, MAX_RPM);

    // BOV: triggered on sharp throttle drop while at high RPM / boost
    if (bovCooldown > 0) {
      bovCooldown -= dt;
    } else if (lastThrottle > 0.45 && currentThrottle < 0.15 && currentRPM > 2800) {
      var boostIntensity = clamp((currentRPM - 2500) / 4500, 0, 1);
      triggerBOV(boostIntensity);
      bovCooldown = 0.6;
    }

    // Exhaust pop / crackle on decel (less frequent than BOV)
    if (popCooldown > 0) {
      popCooldown -= dt;
    } else if (currentRPM > 3500 && targetRPM < currentRPM - 400) {
      var popChance = clamp((currentRPM - 3000) / 4000, 0, 1) * 0.5;
      if (Math.random() < popChance) {
        triggerPop();
        popCooldown = 0.05 + Math.random() * 0.1;
      }
    }

    lastThrottle = currentThrottle;
    updateNodes(currentRPM, currentThrottle);
    rafId = requestAnimationFrame(loop);
  }

  rafId = requestAnimationFrame(loop);
}

/* ── Update all audio parameters ────────────────────────────────────────── */
function updateNodes(rpm, thr) {
  if (!ctx || !engineActive) return;
  var t    = ctx.currentTime;
  var tau  = 0.022;
  var hz   = fireHz(rpm);
  var frac = clamp((rpm - IDLE_RPM) / (MAX_RPM - IDLE_RPM), 0, 1);

  // ── Engine oscillators ──
  nodes.oscA.frequency.setTargetAtTime(hz, t, tau);
  nodes.oscSub.frequency.setTargetAtTime(hz / 3, t, tau);

  var gA   = 0.65 + frac * 0.20 + thr * 0.12;
  var gSub = 0.30 - frac * 0.18; // sub drops away at high RPM (less burbly)
  nodes.gainA.gain.setTargetAtTime(clamp(gA, 0.1, 1), t, tau);
  nodes.gainSub.gain.setTargetAtTime(clamp(gSub, 0.02, 0.4), t, tau);

  // Drive & distortion — GTR sounds more compressed/digital at high throttle
  var distDrive = 3.0 + thr * 5.5 + frac * 2.5;
  nodes.dist.curve = makeHardClip(distDrive);
  nodes.drive.gain.setTargetAtTime(2.2 + thr * 3.2 + frac * 1.8, t, tau);
  nodes.engMix.gain.setTargetAtTime(0.42 + thr * 0.18, t, tau);

  // Post-distortion LP brightens at high RPM
  nodes.postLP.frequency.setTargetAtTime(1600 + frac * 3500 + thr * 1200, t, tau);

  // ── Twin-turbo whine ──
  // Volume: barely audible at idle, dominant at high RPM/boost
  var turboVol = Math.pow(frac, 1.2) * 0.55 + thr * frac * 0.35;
  var t1hz     = turbo1Hz(frac);
  var t2hz     = turbo2Hz(frac);

  nodes.turbo1.frequency.setTargetAtTime(t1hz, t, tau);
  nodes.turbo1Filter.frequency.setTargetAtTime(t1hz, t, tau);
  nodes.turbo2.frequency.setTargetAtTime(t2hz, t, tau);
  nodes.turbo2Filter.frequency.setTargetAtTime(t2hz, t, tau);

  nodes.turbo1Gain.gain.setTargetAtTime(clamp(turboVol, 0, 0.8), t, tau);
  nodes.turbo2Gain.gain.setTargetAtTime(clamp(turboVol * 0.85, 0, 0.7), t, tau);

  // ── Induction noise (increases dramatically with boost/throttle) ──
  var indVol  = Math.pow(frac, 1.5) * 0.2 + thr * frac * 0.18;
  var indFreq = 1500 + frac * 5000 + thr * 2000;
  nodes.inductionGain.gain.setTargetAtTime(clamp(indVol, 0, 0.4), t, tau);
  nodes.inductionBP.frequency.setTargetAtTime(indFreq, t, tau);
  nodes.inductionHP.frequency.setTargetAtTime(600 + frac * 1200, t, tau);

  // ── EQ shifts ──
  nodes.presence.frequency.setTargetAtTime(400 + frac * 400, t, tau);
  nodes.presence.gain.setTargetAtTime(4 + thr * 5, t, tau);
  nodes.finalLP.frequency.setTargetAtTime(4500 + frac * 3500, t, tau);

  // ── Rev limiter ──
  if (rpm > RED_RPM) {
    var limAtten = 1 - ((rpm - RED_RPM) / (MAX_RPM - RED_RPM)) * 0.5;
    nodes.master.gain.setTargetAtTime(0.88 * limAtten, t, 0.008);
  } else {
    nodes.master.gain.setTargetAtTime(0.88, t, tau);
  }
}

/* ── Message handler ────────────────────────────────────────────────────── */
function onMsg(evt) {
  var raw = evt.data, msg;
  try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch(e){ return; }
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'start':
      if (!ctx) {
        init();
      } else if (ctx.state === 'suspended') {
        ctx.resume().then(function(){
          nodes.master.gain.setTargetAtTime(0.88, ctx.currentTime, 0.3);
          engineActive = true;
          startLoop();
        });
      }
      break;
    case 'stop':
      if (ctx && engineActive) {
        engineActive = false;
        if (rafId){ cancelAnimationFrame(rafId); rafId = null; }
        nodes.master.gain.setTargetAtTime(0, ctx.currentTime, 0.7);
      }
      break;
    case 'setRPM':
      targetRPM      = clamp(msg.rpm      || IDLE_RPM, IDLE_RPM, MAX_RPM);
      currentThrottle = clamp(msg.throttle || 0, 0, 1);
      break;
  }
}

window.addEventListener('message', onMsg);
document.addEventListener('message', onMsg);

function postRN(d){
  try{ if(window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(d)); }catch(e){}
}
postRN({type:'ready'});
})();
</script></body></html>`;
