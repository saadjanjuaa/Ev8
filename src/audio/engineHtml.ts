import { ENGINE_CORE_SRC } from './engineCore';

/**
 * Lydverten. Kjøres i en usynlig WebView fordi det er den eneste måten å få
 * ekte sanntidssyntese på i React Native — Web Audio med AudioWorklet gir oss
 * en dedikert lydtråd som ikke påvirkes av at UI-tråden jobber.
 *
 * All motorfysikk kjører INNE i worklet-en (se engineCore.ts). Appen sender
 * bare fart og akselerasjon inn, og får turtall/gir/gass tilbake til UI-et.
 * Det betyr at lyden er glitchefri selv om React rerenderer, og at den
 * fortsetter å spille når skjermen står stille.
 *
 * ScriptProcessorNode er fallback for weberøvere uten AudioWorklet. Samme
 * DSP-kode, bare kjørt på hovedtråden med større buffer.
 */

const PAGE = String.raw`<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>
  html,body{margin:0;padding:0;width:100%;height:100%;background:#000;overflow:hidden}
</style>
</head>
<body>
<script>
/* ─── DSP-kjernen settes inn her ─── */
/*__ENGINE_CORE__*/

(function () {
  'use strict';

  var ctx = null, node = null, core = null, mode = 'none', started = false;
  var pending = [];          /* meldinger mottatt før lyden er bygget */
  var lastPost = 0;

  function post(o) {
    try {
      if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(o));
    } catch (e) { /* ignorer */ }
  }

  function fail(where, e) {
    post({ t: 'error', where: where, msg: (e && e.message) ? e.message : String(e) });
  }

  /* ══════════════════════════════════════════════════════════
     Worklet-koden. Bygges som blob slik at alt ligger i én fil.
     ══════════════════════════════════════════════════════════ */
  function workletSource() {
    return CORE_TEXT + '\n' +
      'class EngineProcessor extends AudioWorkletProcessor {' +
      '  constructor() {' +
      '    super();' +
      '    this.core = createEngineCore(sampleRate);' +
      '    this.acc = 0;' +
      '    this.port.onmessage = (e) => { this.handle(e.data); };' +
      '  }' +
      '  handle(m) {' +
      '    if (!m) return;' +
      '    if (m.t === "input") this.core.setInput(m.s, m.a);' +
      '    else if (m.t === "profile") this.core.setProfile(m.p);' +
      '    else if (m.t === "start") this.core.start();' +
      '    else if (m.t === "stop") this.core.stop();' +
      '    else if (m.t === "throttle") this.core.setThrottleOverride(m.v);' +
      '  }' +
      '  process(inputs, outputs) {' +
      '    var out = outputs[0];' +
      '    if (!out || out.length < 2) return true;' +
      '    var n = out[0].length;' +
      '    this.core.render(out[0], out[1], n);' +
      '    this.acc += n;' +
      '    if (this.acc >= 2048) { this.acc = 0; this.port.postMessage(this.core.snapshot()); }' +
      '    return true;' +
      '  }' +
      '}' +
      'registerProcessor("ev8-engine", EngineProcessor);';
  }

  function sendState(s) {
    var now = Date.now();
    if (now - lastPost < 35 && !(s.events && s.events.length)) return;
    lastPost = now;
    post({
      t: 'state',
      rpm: Math.round(s.rpm),
      gear: s.gear,
      gears: s.gears,
      speed: s.speed,
      throttle: Math.round(s.throttle * 100) / 100,
      accel: Math.round(s.accel * 100) / 100,
      state: s.state,
      shifting: s.shifting,
      limiter: s.limiter,
      events: s.events
    });
  }

  /* ══════════════════════════════════════════════════════════
     Bygg lydgrafen
     ══════════════════════════════════════════════════════════ */
  function build() {
    if (ctx) return Promise.resolve();
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { fail('context', new Error('Web Audio mangler')); return Promise.reject(); }

    try {
      ctx = new AC({ latencyHint: 'interactive' });
    } catch (e) {
      try { ctx = new AC(); } catch (e2) { fail('context', e2); return Promise.reject(e2); }
    }

    var useWorklet = !!(ctx.audioWorklet && ctx.audioWorklet.addModule && window.AudioWorkletNode);
    if (!useWorklet) return buildScriptProcessor();

    var src = workletSource();

    /* Ulike weberøvere godtar ulike URL-typer for addModule. Prøv i tur og
       orden, og fall til slutt tilbake på ScriptProcessor. */
    function tryUrls(urls, i) {
      if (i >= urls.length) return Promise.reject(new Error('ingen URL-form virket'));
      var u;
      try { u = urls[i](); } catch (e) { return tryUrls(urls, i + 1); }
      if (!u) return tryUrls(urls, i + 1);
      return ctx.audioWorklet.addModule(u).then(
        function () { return u; },
        function () { return tryUrls(urls, i + 1); }
      );
    }

    return tryUrls([
      function () { return URL.createObjectURL(new Blob([src], { type: 'text/javascript' })); },
      function () { return 'data:text/javascript;charset=utf-8,' + encodeURIComponent(src); },
    ], 0).then(function (url) {
      try { if (url.indexOf('blob:') === 0) URL.revokeObjectURL(url); } catch (e) { }
      node = new AudioWorkletNode(ctx, 'ev8-engine', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2]
      });
      node.port.onmessage = function (e) { sendState(e.data); };
      node.connect(ctx.destination);
      mode = 'worklet';
      flush();
      post({ t: 'ready', mode: mode, sr: ctx.sampleRate });
    }).catch(function (e) {
      if (mode === 'worklet') return;      /* allerede i gang — ikke lag lyd to ganger */
      post({ t: 'warn', msg: 'AudioWorklet feilet (' + (e && e.message) + '), bruker fallback' });
      return buildScriptProcessor();
    });
  }

  function buildScriptProcessor() {
    try {
      core = createEngineCore(ctx.sampleRate);
      var maker = ctx.createScriptProcessor || ctx.createJavaScriptNode;
      var sp;
      try { sp = maker.call(ctx, 2048, 0, 2); }
      catch (e) { sp = maker.call(ctx, 2048, 1, 2); }
      var acc = 0;
      sp.onaudioprocess = function (ev) {
        var ob = ev.outputBuffer;
        var l = ob.getChannelData(0), r = ob.getChannelData(1);
        core.render(l, r, ob.length);
        acc += ob.length;
        if (acc >= 2048) { acc = 0; sendState(core.snapshot()); }
      };
      sp.connect(ctx.destination);
      node = sp;
      mode = 'script';
      flush();
      post({ t: 'ready', mode: mode, sr: ctx.sampleRate });
      return Promise.resolve();
    } catch (e) {
      fail('scriptprocessor', e);
      return Promise.reject(e);
    }
  }

  function send(m) {
    if (mode === 'worklet' && node) node.port.postMessage(m);
    else if (mode === 'script' && core) {
      if (m.t === 'input') core.setInput(m.s, m.a);
      else if (m.t === 'profile') core.setProfile(m.p);
      else if (m.t === 'start') core.start();
      else if (m.t === 'stop') core.stop();
      else if (m.t === 'throttle') core.setThrottleOverride(m.v);
    } else pending.push(m);
  }

  function flush() {
    var q = pending; pending = [];
    for (var i = 0; i < q.length; i++) send(q[i]);
  }

  /* ══════════════════════════════════════════════════════════
     Broen mot React Native
     ══════════════════════════════════════════════════════════ */
  function onMessage(ev) {
    var m;
    try { m = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data; }
    catch (e) { return; }
    if (!m || !m.t) return;

    if (m.t === 'start') {
      started = true;
      build().then(function () {
        if (ctx && ctx.state !== 'running') {
          return ctx.resume().catch(function (e) { fail('resume', e); });
        }
      }).then(function () {
        send({ t: 'start' });
      }).catch(function () { });
      return;
    }

    if (m.t === 'resume') {
      if (ctx && ctx.state !== 'running') ctx.resume().catch(function () { });
      return;
    }

    if (m.t === 'stop') { started = false; send({ t: 'stop' }); return; }

    send(m);
  }

  window.addEventListener('message', onMessage);
  document.addEventListener('message', onMessage);

  /* iOS krever av og til en berøring for å låse opp lyden */
  function unlock() { if (ctx && ctx.state === 'suspended') ctx.resume().catch(function () { }); }
  document.addEventListener('touchstart', unlock, { passive: true });
  document.addEventListener('touchend', unlock, { passive: true });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && started) unlock();
  });

  post({ t: 'boot' });
})();
</script>
</body>
</html>`;

/**
 * Kjernen legges inn både som global funksjon (for ScriptProcessor-fallback)
 * og som tekst (for å bygge worklet-blobben).
 */
const CORE_BLOCK =
  ENGINE_CORE_SRC +
  '\nvar CORE_TEXT = ' +
  JSON.stringify(ENGINE_CORE_SRC) +
  ';\n';

export const ENGINE_HTML = PAGE.replace('/*__ENGINE_CORE__*/', () => CORE_BLOCK);
