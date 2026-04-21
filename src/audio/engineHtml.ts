// Self-contained Web Audio API V8 engine synthesizer
// Runs inside a hidden WebView for real-time audio synthesis

export const ENGINE_HTML = `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: transparent; }
</style>
</head>
<body>
<script>
(function () {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────────
  var IDLE_RPM   = 820;
  var MAX_RPM    = 7200;
  var RED_RPM    = 6500;

  // ── State ──────────────────────────────────────────────────────────────────
  var ctx            = null;
  var nodes          = {};
  var engineActive   = false;
  var currentRPM     = IDLE_RPM;
  var targetRPM      = IDLE_RPM;
  var currentThrottle = 0;
  var rafId          = null;
  var lastTs         = 0;
  var lastDeccelRPM  = 0;
  var popCooldown    = 0;

  // ── Helpers ────────────────────────────────────────────────────────────────
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // Asymmetric soft-clipper — gives organic, non-digital distortion
  function makeDistCurve(amount) {
    var N = 512;
    var c = new Float32Array(N);
    for (var i = 0; i < N; i++) {
      var x = (i * 2 / N) - 1;
      if (x >= 0) {
        c[i] = 1 - Math.pow(1 - x, amount * 0.009 + 1.4);
      } else {
        c[i] = -(1 - Math.pow(1 + x, amount * 0.013 + 1.6));
      }
    }
    return c;
  }

  // Looping white-noise buffer source
  function makeNoise(ctx) {
    var len  = ctx.sampleRate * 4;
    var buf  = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    var src  = ctx.createBufferSource();
    src.buffer = buf;
    src.loop   = true;
    src.start(0);
    return src;
  }

  /*  V8 cross-plane Fourier series
   *  The cross-plane V8 is famous for its uneven exhaust-pulse grouping:
   *  pulses arrive in a 90-270-90-270 pattern which enriches the 3rd and 7th
   *  harmonics above what you'd get from a flat-plane or inline engine.
   *  We bake that character into a PeriodicWave so every oscillator instance
   *  carries it automatically.
   */
  function makeV8Wave(ctx) {
    var H   = 20;
    var re  = new Float32Array(H + 1);
    var im  = new Float32Array(H + 1);

    // Harmonic amplitudes — tuned to match a big-block V8 exhaust spectrum
    re[1]  = 1.00;   // fundamental (the main "note")
    re[2]  = 0.45;   // 2nd
    re[3]  = 0.95;   // 3rd  ← dominant cross-plane overtone
    re[4]  = 0.22;
    re[5]  = 0.55;   // 5th  ← second strong odd
    re[6]  = 0.14;
    re[7]  = 0.38;   // 7th  ← cross-plane character
    re[8]  = 0.10;
    re[9]  = 0.22;
    re[10] = 0.08;
    re[11] = 0.16;
    re[12] = 0.06;
    re[13] = 0.12;
    re[14] = 0.04;
    re[15] = 0.09;

    // Small phase shifts on even harmonics give asymmetric wave-shape (like real exhaust)
    im[2]  =  0.08;
    im[4]  = -0.06;
    im[6]  =  0.04;

    return ctx.createPeriodicWave(re, im, { disableNormalization: false });
  }

  // Firing frequency for a 4-stroke V8: 4 power strokes per crank revolution
  function fireHz(rpm) { return (rpm / 60) * 4; }

  // ── Init audio graph ───────────────────────────────────────────────────────
  function init() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();

    var t  = ctx.currentTime;
    var hz = fireHz(IDLE_RPM);

    // ── Output chain: mix → drive → dist → postLP → outputHP → EQ → comp → master ──

    nodes.master = ctx.createGain();
    nodes.master.gain.setValueAtTime(0, t);
    nodes.master.connect(ctx.destination);

    nodes.comp = ctx.createDynamicsCompressor();
    nodes.comp.threshold.value = -10;
    nodes.comp.knee.value      = 10;
    nodes.comp.ratio.value     = 3.5;
    nodes.comp.attack.value    = 0.003;
    nodes.comp.release.value   = 0.12;
    nodes.comp.connect(nodes.master);

    // Presence / body peak
    nodes.eqMid = ctx.createBiquadFilter();
    nodes.eqMid.type      = 'peaking';
    nodes.eqMid.frequency.value = 380;
    nodes.eqMid.Q.value   = 0.9;
    nodes.eqMid.gain.value = 5;
    nodes.eqMid.connect(nodes.comp);

    // Gentle high-shelf air
    nodes.eqAir = ctx.createBiquadFilter();
    nodes.eqAir.type      = 'highshelf';
    nodes.eqAir.frequency.value = 5000;
    nodes.eqAir.gain.value = -4;
    nodes.eqAir.connect(nodes.eqMid);

    // Final low pass — tames fizz from hard distortion
    nodes.finalLP = ctx.createBiquadFilter();
    nodes.finalLP.type = 'lowpass';
    nodes.finalLP.frequency.value = 4200;
    nodes.finalLP.Q.value = 0.65;
    nodes.finalLP.connect(nodes.eqAir);

    // Output high pass — remove subsonic rumble
    nodes.outputHP = ctx.createBiquadFilter();
    nodes.outputHP.type = 'highpass';
    nodes.outputHP.frequency.value = 42;
    nodes.outputHP.Q.value = 0.7;
    nodes.outputHP.connect(nodes.finalLP);

    // Post-distortion LP — shapes the distortion character
    nodes.postLP = ctx.createBiquadFilter();
    nodes.postLP.type = 'lowpass';
    nodes.postLP.frequency.value = 2200;
    nodes.postLP.Q.value = 0.5;
    nodes.postLP.connect(nodes.outputHP);

    // WaveShaper — the core growl/rasp
    nodes.dist = ctx.createWaveShaper();
    nodes.dist.curve      = makeDistCurve(75);
    nodes.dist.oversample = '4x';
    nodes.dist.connect(nodes.postLP);

    // Pre-distortion drive gain (higher = more saturation)
    nodes.drive = ctx.createGain();
    nodes.drive.gain.value = 2.8;
    nodes.drive.connect(nodes.dist);

    // Engine mix bus
    nodes.engMix = ctx.createGain();
    nodes.engMix.gain.value = 0.45;
    nodes.engMix.connect(nodes.drive);

    // ── Main V8 oscillator ──
    var wave = makeV8Wave(ctx);
    nodes.oscA = ctx.createOscillator();
    nodes.oscA.setPeriodicWave(wave);
    nodes.oscA.frequency.setValueAtTime(hz, t);
    nodes.gainA = ctx.createGain();
    nodes.gainA.gain.setValueAtTime(0.72, t);
    nodes.oscA.connect(nodes.gainA);
    nodes.gainA.connect(nodes.engMix);

    // ── Sub oscillator at crank frequency (hz/4) — the deep "potato" burble ──
    nodes.oscSub = ctx.createOscillator();
    nodes.oscSub.type = 'sine';
    nodes.oscSub.frequency.setValueAtTime(hz / 4, t);
    nodes.gainSub = ctx.createGain();
    nodes.gainSub.gain.setValueAtTime(0.55, t);
    nodes.oscSub.connect(nodes.gainSub);
    nodes.gainSub.connect(nodes.engMix);

    // ── Half-frequency sawtooth (hz/2) — the mid "chug" ──
    nodes.oscHalf = ctx.createOscillator();
    nodes.oscHalf.type = 'sawtooth';
    nodes.oscHalf.frequency.setValueAtTime(hz / 2, t);
    nodes.gainHalf = ctx.createGain();
    nodes.gainHalf.gain.setValueAtTime(0.38, t);
    nodes.oscHalf.connect(nodes.gainHalf);
    nodes.gainHalf.connect(nodes.engMix);

    // ── Amplitude modulation for cross-plane "burble" unevenness ──
    // LFO at crank frequency modulates the main osc gain → irregular pulse feel
    nodes.burbleLFO = ctx.createOscillator();
    nodes.burbleLFO.type = 'sine';
    nodes.burbleLFO.frequency.setValueAtTime(hz / 4, t);
    nodes.burbleAmt = ctx.createGain();
    nodes.burbleAmt.gain.setValueAtTime(0.14, t);
    nodes.burbleLFO.connect(nodes.burbleAmt);
    nodes.burbleAmt.connect(nodes.gainA.gain); // AM on the main oscillator

    // ── Second LFO for subtle wow (mechanical character) ──
    nodes.wowLFO = ctx.createOscillator();
    nodes.wowLFO.frequency.value = 2.7;
    nodes.wowAmt = ctx.createGain();
    nodes.wowAmt.gain.value = 0.6;
    nodes.wowLFO.connect(nodes.wowAmt);
    nodes.wowAmt.connect(nodes.oscA.frequency);

    // ── Induction / exhaust noise ──
    nodes.noise = makeNoise(ctx);

    nodes.noiseHP = ctx.createBiquadFilter();
    nodes.noiseHP.type = 'highpass';
    nodes.noiseHP.frequency.value = 600;

    nodes.noiseBP = ctx.createBiquadFilter();
    nodes.noiseBP.type = 'bandpass';
    nodes.noiseBP.frequency.value = 1800;
    nodes.noiseBP.Q.value = 0.7;

    nodes.noiseGain = ctx.createGain();
    nodes.noiseGain.gain.value = 0.025;

    nodes.noise.connect(nodes.noiseHP);
    nodes.noiseHP.connect(nodes.noiseBP);
    nodes.noiseBP.connect(nodes.noiseGain);
    nodes.noiseGain.connect(nodes.finalLP);  // Goes past distortion (exhaust hiss)

    // ── Exhaust pop synthesis chain ──
    // Short bandpass burst used for decel pops/crackles
    nodes.popGain = ctx.createGain();
    nodes.popGain.gain.setValueAtTime(0, t);
    nodes.popFilter = ctx.createBiquadFilter();
    nodes.popFilter.type = 'bandpass';
    nodes.popFilter.frequency.value = 900;
    nodes.popFilter.Q.value = 6;
    nodes.popGain.connect(nodes.popFilter);
    nodes.popFilter.connect(nodes.comp);

    // Pop noise source (separate looping noise for clean triggering)
    nodes.popNoise = makeNoise(ctx);
    nodes.popNoise.connect(nodes.popGain);

    // ── Start everything ──
    nodes.oscA.start();
    nodes.oscSub.start();
    nodes.oscHalf.start();
    nodes.burbleLFO.start();
    nodes.wowLFO.start();

    engineActive = true;
    lastTs = performance.now();

    // Startup rev: briefly bump to ~1200 RPM then settle at idle
    targetRPM = 1350;
    setTimeout(function () { targetRPM = IDLE_RPM; }, 900);

    // Fade in after tiny delay (iOS AudioContext needs a tick)
    setTimeout(function () {
      nodes.master.gain.setTargetAtTime(0.88, ctx.currentTime, 0.35);
    }, 80);

    startLoop();
  }

  // ── Exhaust pop trigger ────────────────────────────────────────────────────
  function triggerPop() {
    if (!ctx || !engineActive) return;
    var t = ctx.currentTime;
    var freq = 700 + Math.random() * 600;
    nodes.popFilter.frequency.setValueAtTime(freq, t);
    nodes.popGain.gain.cancelScheduledValues(t);
    nodes.popGain.gain.setValueAtTime(0, t);
    nodes.popGain.gain.linearRampToValueAtTime(0.55, t + 0.008);
    nodes.popGain.gain.exponentialRampToValueAtTime(0.001, t + 0.06 + Math.random() * 0.04);
  }

  // ── Main update loop ───────────────────────────────────────────────────────
  function startLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    lastTs = performance.now();

    function loop(ts) {
      var dt = Math.min((ts - lastTs) / 1000, 0.08);
      lastTs = ts;

      // Engine inertia — rises faster than it falls (like a real engine)
      var diff = targetRPM - currentRPM;
      var rate = diff > 0 ? 4.5 : 2.8;
      currentRPM += diff * rate * dt;
      currentRPM = clamp(currentRPM, IDLE_RPM * 0.92, MAX_RPM);

      // Deceleration pop/crackle — high RPM lift-off
      if (popCooldown > 0) {
        popCooldown -= dt;
      } else if (currentRPM > 2800 && targetRPM < currentRPM - 350) {
        var popChance = (currentRPM - 2000) / 5000;
        if (Math.random() < popChance * 0.55) {
          triggerPop();
          popCooldown = 0.04 + Math.random() * 0.12;
        }
      }

      updateNodes(currentRPM, currentThrottle, dt);
      rafId = requestAnimationFrame(loop);
    }

    rafId = requestAnimationFrame(loop);
  }

  // ── Update all audio parameters ────────────────────────────────────────────
  function updateNodes(rpm, throttle, dt) {
    if (!ctx || !engineActive) return;

    var t      = ctx.currentTime;
    var tau    = 0.025; // time-constant for setTargetAtTime smoothing
    var hz     = fireHz(rpm);
    var frac   = clamp((rpm - IDLE_RPM) / (MAX_RPM - IDLE_RPM), 0, 1);
    var thr    = clamp(throttle, 0, 1);

    // Oscillator frequencies
    nodes.oscA.frequency.setTargetAtTime(hz, t, tau);
    nodes.oscSub.frequency.setTargetAtTime(hz / 4, t, tau);
    nodes.oscHalf.frequency.setTargetAtTime(hz / 2, t, tau);
    nodes.burbleLFO.frequency.setTargetAtTime(hz / 4, t, tau);

    // Harmonic balance shifts with RPM
    // Low RPM: thick sub + chug  /  High RPM: main osc + harmonics dominate
    var gA    = 0.65 + frac * 0.25 + thr * 0.15;
    var gSub  = 0.55 - frac * 0.30;
    var gHalf = 0.38 - frac * 0.18;
    var bAmt  = 0.14 - frac * 0.09;   // burble depth falls at high rpm

    nodes.gainA.gain.setTargetAtTime(clamp(gA, 0.1, 1), t, tau);
    nodes.gainSub.gain.setTargetAtTime(clamp(gSub, 0.05, 0.7), t, tau);
    nodes.gainHalf.gain.setTargetAtTime(clamp(gHalf, 0.05, 0.5), t, tau);
    nodes.burbleAmt.gain.setTargetAtTime(clamp(bAmt, 0.02, 0.2), t, tau);

    // Drive and distortion — more throttle = more growl
    var distAmt = 65 + thr * 185 + frac * 70;
    nodes.dist.curve = makeDistCurve(distAmt);

    var driveAmt = 2.4 + thr * 2.6 + frac * 1.8;
    nodes.drive.gain.setTargetAtTime(clamp(driveAmt, 1, 8), t, tau);

    // Engine mix
    nodes.engMix.gain.setTargetAtTime(0.38 + thr * 0.22 + frac * 0.08, t, tau);

    // Post-distortion LP opens with RPM and throttle (air volume)
    var postLPFreq = 1400 + frac * 2200 + thr * 900;
    nodes.postLP.frequency.setTargetAtTime(postLPFreq, t, tau);

    // Final LP brightens slightly with high RPM
    nodes.finalLP.frequency.setTargetAtTime(3200 + frac * 2000, t, tau);

    // Induction / exhaust noise
    var noiseAmt  = 0.018 + frac * 0.14 + thr * 0.09;
    var noisePeak = 1000 + frac * 3500 + thr * 1200;
    nodes.noiseGain.gain.setTargetAtTime(clamp(noiseAmt, 0, 0.35), t, tau);
    nodes.noiseBP.frequency.setTargetAtTime(noisePeak, t, tau);
    nodes.noiseHP.frequency.setTargetAtTime(350 + frac * 900, t, tau);

    // Presence EQ
    nodes.eqMid.frequency.setTargetAtTime(300 + frac * 350, t, tau);
    nodes.eqMid.gain.setTargetAtTime(4 + thr * 5, t, tau);

    // Rev-limiter attenuation near redline
    if (rpm > RED_RPM) {
      var limAtten = 1 - ((rpm - RED_RPM) / (MAX_RPM - RED_RPM)) * 0.45;
      nodes.master.gain.setTargetAtTime(0.88 * limAtten, t, 0.008);
    } else {
      nodes.master.gain.setTargetAtTime(0.88, t, tau);
    }
  }

  // ── Message handler ────────────────────────────────────────────────────────
  function onMessage(evt) {
    var raw = evt.data;
    var msg;
    try { msg = typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch (e) { return; }
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'start':
        if (!ctx) {
          init();
        } else if (ctx.state === 'suspended') {
          ctx.resume().then(function () {
            nodes.master.gain.setTargetAtTime(0.88, ctx.currentTime, 0.3);
            engineActive = true;
            startLoop();
          });
        }
        break;

      case 'stop':
        if (ctx && engineActive) {
          engineActive = false;
          if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
          nodes.master.gain.setTargetAtTime(0, ctx.currentTime, 0.6);
        }
        break;

      case 'setRPM':
        targetRPM      = clamp(msg.rpm      || IDLE_RPM, IDLE_RPM, MAX_RPM);
        currentThrottle = clamp(msg.throttle || 0,        0,        1);
        break;
    }
  }

  window.addEventListener('message', onMessage);
  document.addEventListener('message', onMessage);

  // Tell React Native we are ready
  function postRN(data) {
    try {
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify(data));
      }
    } catch (e) {}
  }
  postRN({ type: 'ready' });
})();
</script>
</body>
</html>`;
