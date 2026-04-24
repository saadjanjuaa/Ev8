export const ENGINE_HTML = `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{margin:0;padding:0}html,body{width:100%;height:100%;background:transparent;overflow:hidden}</style>
</head><body><script>
(function(){
'use strict';

var ctx=null, nodes={}, active=false, samplesReady=false;
var sampleBank=[]; /* [{rpm, buf, src, gain}] sorted by rpm ascending */
var curRPM=800, tgtRPM=800, curThr=0;
var rafId=null, lastTs=0;

function clamp(v,a,b){return v<a?a:v>b?b:v;}

/* ──────────────────────────────────────────────────────────────────────
   Audio graph:  sample crossfade  →  engineMix  →  compressor  →  master
   Gear-shift / blip effects bypass the crossfade and hit comp directly.
────────────────────────────────────────────────────────────────────── */
function buildGraph(){
  nodes.master=ctx.createGain(); nodes.master.gain.value=0;
  nodes.master.connect(ctx.destination);

  nodes.comp=ctx.createDynamicsCompressor();
  nodes.comp.threshold.value=-10; nodes.comp.knee.value=12;
  nodes.comp.ratio.value=3.2; nodes.comp.attack.value=0.004;
  nodes.comp.release.value=0.14; nodes.comp.connect(nodes.master);

  nodes.bass=ctx.createBiquadFilter();
  nodes.bass.type='peaking'; nodes.bass.frequency.value=110;
  nodes.bass.Q.value=0.7; nodes.bass.gain.value=4; nodes.bass.connect(nodes.comp);

  nodes.hi=ctx.createBiquadFilter();
  nodes.hi.type='highshelf'; nodes.hi.frequency.value=3500;
  nodes.hi.gain.value=-1; nodes.hi.connect(nodes.bass);

  nodes.engineMix=ctx.createGain(); nodes.engineMix.gain.value=0.9;
  nodes.engineMix.connect(nodes.hi);
}

/* Decode data URIs and wire each sample through its own loop + gain node */
function loadSamples(list){
  sampleBank=[];
  var pending=list.length;
  list.forEach(function(item){
    fetch(item.dataUri)
      .then(function(r){return r.arrayBuffer();})
      .then(function(ab){return ctx.decodeAudioData(ab);})
      .then(function(buf){
        var src=ctx.createBufferSource();
        src.buffer=buf; src.loop=true;
        var g=ctx.createGain(); g.gain.value=0;
        src.connect(g); g.connect(nodes.engineMix);
        src.start(0);
        sampleBank.push({rpm:item.rpm, buf:buf, src:src, gain:g});
      })
      .catch(function(e){ postRN({type:'decodeError', rpm:item.rpm, err:String(e)}); })
      .finally(function(){
        pending--;
        if(pending===0){
          sampleBank.sort(function(a,b){return a.rpm-b.rpm;});
          samplesReady=true;
          postRN({type:'samplesReady', count:sampleBank.length});
        }
      });
  });
}

/* Crossfade: find 2 neighbouring samples, blend gain + pitch both toward target */
function applyRPM(rpm){
  if(!samplesReady||sampleBank.length===0||!ctx) return;
  var t=ctx.currentTime, tau=0.04;
  var lo=sampleBank[0], hi=sampleBank[sampleBank.length-1];
  for(var i=0;i<sampleBank.length-1;i++){
    if(rpm>=sampleBank[i].rpm && rpm<=sampleBank[i+1].rpm){
      lo=sampleBank[i]; hi=sampleBank[i+1]; break;
    }
  }
  if(rpm<=sampleBank[0].rpm){ lo=hi=sampleBank[0]; }
  else if(rpm>=sampleBank[sampleBank.length-1].rpm){
    lo=hi=sampleBank[sampleBank.length-1];
  }
  var blend = (lo===hi) ? 0 : (rpm-lo.rpm)/(hi.rpm-lo.rpm);

  sampleBank.forEach(function(s){
    var wantGain=0, wantRate=1;
    if(s===lo && s===hi){ wantGain=1; wantRate=rpm/s.rpm; }
    else if(s===lo){ wantGain=1-blend; wantRate=rpm/s.rpm; }
    else if(s===hi){ wantGain=blend;   wantRate=rpm/s.rpm; }
    wantRate=clamp(wantRate,0.5,2.0);
    s.gain.gain.setTargetAtTime(wantGain, t, tau);
    s.src.playbackRate.setTargetAtTime(wantRate, t, tau);
  });
}

/* Gear shift clunk: clutch duck + short mechanical click, different pitch up/down */
function gearShift(dir){
  if(!ctx||!active) return;
  var t=ctx.currentTime;
  nodes.engineMix.gain.cancelScheduledValues(t);
  nodes.engineMix.gain.setValueAtTime(0.9,t);
  nodes.engineMix.gain.linearRampToValueAtTime(0.25, t+0.05);
  nodes.engineMix.gain.linearRampToValueAtTime(0.9,  t+0.22);

  var click=ctx.createOscillator(); click.type='square';
  click.frequency.value = dir==='down' ? 120 : 78;
  var cF=ctx.createBiquadFilter();
  cF.type='bandpass';
  cF.frequency.value = dir==='down' ? 260 : 150;
  cF.Q.value=5;
  var cG=ctx.createGain(); cG.gain.value=0;
  click.connect(cF); cF.connect(cG); cG.connect(nodes.comp);
  click.start(t);
  cG.gain.setValueAtTime(0,t);
  cG.gain.linearRampToValueAtTime(0.40, t+0.008);
  cG.gain.exponentialRampToValueAtTime(0.001, t+0.13);
  click.stop(t+0.15);
}

function startLoop(){
  if(rafId) cancelAnimationFrame(rafId);
  lastTs=performance.now();
  function loop(ts){
    var dt=Math.min((ts-lastTs)/1000,0.08); lastTs=ts;
    var diff=tgtRPM-curRPM;
    curRPM += diff * (diff>0 ? 4.5 : 2.6) * dt;
    applyRPM(curRPM);
    rafId=requestAnimationFrame(loop);
  }
  rafId=requestAnimationFrame(loop);
}

function onMsg(evt){
  var msg; try{msg=JSON.parse(evt.data);}catch(e){return;}
  if(!msg||!msg.type) return;
  switch(msg.type){
    case 'init':
      if(!ctx){
        ctx=new(window.AudioContext||window.webkitAudioContext)();
        buildGraph();
      }
      if(msg.samples && !samplesReady) loadSamples(msg.samples);
      break;
    case 'start':
      if(!ctx||!samplesReady) return;
      ctx.resume().then(function(){
        active=true;
        tgtRPM=1100; setTimeout(function(){tgtRPM=800;},500);
        nodes.master.gain.cancelScheduledValues(ctx.currentTime);
        nodes.master.gain.setTargetAtTime(0.9, ctx.currentTime, 0.12);
        startLoop();
      });
      break;
    case 'stop':
      active=false;
      if(rafId){cancelAnimationFrame(rafId);rafId=null;}
      if(ctx){
        nodes.master.gain.cancelScheduledValues(ctx.currentTime);
        nodes.master.gain.setTargetAtTime(0, ctx.currentTime, 0.35);
      }
      curRPM=800; tgtRPM=800; curThr=0;
      break;
    case 'setRPM':
      tgtRPM=clamp(msg.rpm||800, 600, 8500);
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
