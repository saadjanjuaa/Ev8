/**
 * EV8 — fysisk lydmodell av en V8-motor.
 *
 * Denne strengen kjøres BÅDE som AudioWorkletProcessor (lydtråd, sample-nøyaktig)
 * og som ScriptProcessor-fallback. Derfor er den ren ES5-JS uten avhengigheter.
 *
 * Modellen er ikke en «motorlyd-sample som pitches opp/ned» — den simulerer:
 *
 *   1. Veivakselen sample for sample (grader, ikke sekunder).
 *   2. Åtte sylindre som fyrer hver 90° i ekte tenningsrekkefølge.
 *      Crossplane-V8 (1-8-4-3-6-5-7-2) gir UJEVN tenning per bank
 *      (270-180-90-180 grader) — det er nettopp denne ujevnheten som lager
 *      den amerikanske V8-rumlingen. Flatplane gir jevn 180° og eksotisk hyl.
 *   3. Eksosgeometri som bølgeleder: header per bank -> H-rør -> midtrør ->
 *      potte -> enderør. Refleksjonene lager de virkelige rørresonansene.
 *   4. Forbrenningspuls (blowdown) + pumpestrøm + turbulensstøy per sylinder,
 *      med sylindervariasjon og tenningsjitter, slik at det aldri blir «synth».
 *   5. Smell/spraking i eksosen (uforbrent drivstoff) matet INN i røret, slik at
 *        de arver rørets klang i stedet for å ligge oppå som en effekt.
 *   6. Girkasse med clutch-slure, opp-/nedgir med tenningskutt og mellomgass.
 *
 * All fysikk kjører i lydtråden, slik at lyden ikke hakker om UI-tråden henger.
 */
export const ENGINE_CORE_SRC = String.raw`
'use strict';

function createEngineCore(SR) {

  var PI = Math.PI, TAU = PI * 2, invSR = 1 / SR;
  var C_AIR = 343;                 /* lydhastighet m/s */
  var OPEN_DEG = 250;              /* eksosventil åpen, veivgrader */

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* ── rask hvit støy (xorshift32) ── */
  var seed = 2463534242;
  function nrnd() {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed = seed | 0;
    return seed / 2147483648;
  }
  function urnd() { return nrnd() * 0.5 + 0.5; }

  /* ── oppslagstabeller ──
     Den innerste løkka kjøres 48 000 ganger i sekundet, ganger 8 sylindre.
     Math.sin/Math.exp der inne koster mer enn hele resten av modellen, så
     de er byttet ut med tabeller med lineær interpolasjon. */
  var SIN_N = 2048;
  var SIN_T = new Float32Array(SIN_N + 1);
  for (var si = 0; si <= SIN_N; si++) SIN_T[si] = Math.sin((si / SIN_N) * 2 * PI);
  /** p = fase i omdreininger (0..1), ikke radianer */
  function sinT(p) {
    p = p - Math.floor(p);
    var x = p * SIN_N, i = x | 0, f = x - i;
    var a = SIN_T[i];
    return a + (SIN_T[i + 1] - a) * f;
  }

  var EXP_MAX = 14, EXP_N = 1024;
  var EXP_T = new Float32Array(EXP_N + 1);
  for (var ei = 0; ei <= EXP_N; ei++) EXP_T[ei] = Math.exp(-(ei / EXP_N) * EXP_MAX);
  /** exp(-x) for x >= 0 */
  function expT(x) {
    if (x >= EXP_MAX) return 0;
    var v = x * (EXP_N / EXP_MAX), i = v | 0, f = v - i;
    var a = EXP_T[i];
    return a + (EXP_T[i + 1] - a) * f;
  }

  /* ── fraksjonell forsinkelseslinje (bølgeleder) ── */
  function Delay(maxLen) {
    this.b = new Float32Array(maxLen | 0);
    this.n = maxLen | 0;
    this.i = 0;
  }
  Delay.prototype.read = function (d) {
    if (d < 1) d = 1; else if (d > this.n - 2) d = this.n - 2;
    var p = this.i - d;
    while (p < 0) p += this.n;
    var i0 = p | 0, f = p - i0, i1 = i0 + 1;
    if (i1 >= this.n) i1 = 0;
    var a = this.b[i0];
    return a + (this.b[i1] - a) * f;
  };
  Delay.prototype.write = function (v) {
    this.b[this.i] = v;
    this.i++; if (this.i >= this.n) this.i = 0;
  };

  /* ── en-polet lavpass (demping i røret) ── */
  function OnePole() { this.z = 0; }
  OnePole.prototype.lp = function (x, a) { this.z += a * (x - this.z); return this.z; };
  function poleA(fHz) { return clamp(1 - Math.exp(-TAU * fHz * invSR), 0, 1); }

  /* ── biquad (RBJ) ── */
  function BQ() {
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
  }
  BQ.prototype.run = function (x) {
    var y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  };
  BQ.prototype.norm = function (b0, b1, b2, a0, a1, a2) {
    var inv = 1 / a0;
    this.b0 = b0 * inv; this.b1 = b1 * inv; this.b2 = b2 * inv;
    this.a1 = a1 * inv; this.a2 = a2 * inv;
  };
  BQ.prototype.lowpass = function (f, q) {
    f = clamp(f, 20, SR * 0.45);
    var w = TAU * f * invSR, cs = Math.cos(w), al = Math.sin(w) / (2 * q);
    this.norm((1 - cs) / 2, 1 - cs, (1 - cs) / 2, 1 + al, -2 * cs, 1 - al);
  };
  BQ.prototype.highpass = function (f, q) {
    f = clamp(f, 10, SR * 0.45);
    var w = TAU * f * invSR, cs = Math.cos(w), al = Math.sin(w) / (2 * q);
    this.norm((1 + cs) / 2, -(1 + cs), (1 + cs) / 2, 1 + al, -2 * cs, 1 - al);
  };
  BQ.prototype.bandpass = function (f, q) {
    f = clamp(f, 20, SR * 0.45);
    var w = TAU * f * invSR, cs = Math.cos(w), sn = Math.sin(w), al = sn / (2 * q);
    this.norm(al, 0, -al, 1 + al, -2 * cs, 1 - al);
  };
  BQ.prototype.peaking = function (f, q, dB) {
    f = clamp(f, 20, SR * 0.45);
    var A = Math.pow(10, dB / 40);
    var w = TAU * f * invSR, cs = Math.cos(w), al = Math.sin(w) / (2 * q);
    this.norm(1 + al * A, -2 * cs, 1 - al * A, 1 + al / A, -2 * cs, 1 - al / A);
  };
  BQ.prototype.lowshelf = function (f, dB) {
    f = clamp(f, 20, SR * 0.45);
    var A = Math.pow(10, dB / 40), w = TAU * f * invSR;
    var cs = Math.cos(w), sn = Math.sin(w), al = sn / 2 * Math.sqrt(2), s2 = 2 * Math.sqrt(A) * al;
    this.norm(
      A * ((A + 1) - (A - 1) * cs + s2),
      2 * A * ((A - 1) - (A + 1) * cs),
      A * ((A + 1) - (A - 1) * cs - s2),
      (A + 1) + (A - 1) * cs + s2,
      -2 * ((A - 1) + (A + 1) * cs),
      (A + 1) + (A - 1) * cs - s2
    );
  };
  BQ.prototype.highshelf = function (f, dB) {
    f = clamp(f, 20, SR * 0.45);
    var A = Math.pow(10, dB / 40), w = TAU * f * invSR;
    var cs = Math.cos(w), sn = Math.sin(w), al = sn / 2 * Math.sqrt(2), s2 = 2 * Math.sqrt(A) * al;
    this.norm(
      A * ((A + 1) + (A - 1) * cs + s2),
      -2 * A * ((A - 1) + (A + 1) * cs),
      A * ((A + 1) + (A - 1) * cs - s2),
      (A + 1) - (A - 1) * cs + s2,
      2 * ((A - 1) - (A + 1) * cs),
      (A + 1) - (A - 1) * cs - s2
    );
  };

  /* ── tilstandsvariabelt filter (Chamberlin) ──
     Frekvensen kan moduleres per sample uten å regne om koeffisienter,
     som er akkurat det avblåsingsventilens nedadgående sveip trenger. */
  function SVF() { this.lp = 0; this.bp = 0; }
  SVF.prototype.band = function (x, f, q) {
    this.lp += f * this.bp;
    var hp = x - this.lp - q * this.bp;
    this.bp += f * hp;
    if (this.bp > 8) this.bp = 8; else if (this.bp < -8) this.bp = -8;
    return this.bp;
  };
  /** frekvenskoeffisient til SVF-en, uten Math.sin i lydsløyfa */
  function svfF(hz) {
    var f = 2 * sinT(clamp(hz, 20, SR * 0.32) * invSR * 0.5);
    return f > 1.4 ? 1.4 : f;
  }

  /* ── Schroeder-allpass (potte-diffusjon) ── */
  function AP(lenSamples, g) {
    this.d = new Delay((lenSamples | 0) + 4);
    this.len = lenSamples;
    this.g = g;
  }
  AP.prototype.run = function (x) {
    var dl = this.d.read(this.len);
    var v = x + this.g * dl;
    this.d.write(v);
    return dl - this.g * v;
  };

  /* ═══════════════════════════════════════════════════════════════════
     KONFIGURASJON (settes fra JS-siden via setProfile)
     ═══════════════════════════════════════════════════════════════════ */
  var cfg = {
    /* bank (0/1) for hver av de 8 tenningene, 90° fra hverandre.
       Crossplane small-block (1-8-4-3-6-5-7-2), bank A = 1,3,5,7 */
    banks: [0, 1, 1, 0, 1, 0, 0, 1],
    idleRpm: 720,
    maxRpm: 6400,
    limitRpm: 6100,
    headerLen: 0.86,        /* m — lengre = dypere brøl */
    midLen: 1.75,           /* m */
    reflection: 0.68,       /* refleksjon header -> samlerør */
    midReflection: 0.45,
    damping: 3000,          /* Hz — rørdemping */
    muffler: 0.5,           /* 0 = rett rør, 1 = stille */
    crossover: 0.34,        /* H-rør: hvor mye bankene deler */
    burn: 0.052,            /* pulsens avklingning per veivgrad — høyere = kortere,
                               skarpere puls med mer stillhet imellom */
    turbo: 0.0,             /* 0-1: kompressorhyl og avblåsingsventil */
    punch: 0.9,             /* transientløft — hvor tydelig hver tenning står fram */
    growl: 6.5,             /* dB — lavhylle under 120 Hz */
    rumble: 5.0,            /* dB @ 62 Hz — der V8-rumlingen sitter */
    rasp: 4.0,              /* dB @ 1.3 kHz, skaleres med gass */
    intake: 0.45,
    whine: 0.0,             /* kompressorhyl (0 = naturlig aspirert) */
    popRate: 1.0,
    popGain: 1.0,
    idleLope: 1.0,
    combVar: 1.0,           /* sylindervariasjon */
    gears: [3.42, 2.14, 1.45, 1.09, 0.85, 0.69],
    finalDrive: 3.31,
    tireCirc: 2.02,         /* m per hjulomdreining */
    accelFull: 4.3,         /* m/s² — maks akselerasjon fra stillstand */
    powerRef: 62,           /* m²/s³ — effekt/masse, gir effektgrensen */
    shiftUpLow: 2450,       /* girpunkt ved 0 % gass */
    shiftUpHigh: 6000,      /* girpunkt ved 100 % gass */
    torquePeak: 3600,
    /* Lydbilde: 0 = ren utvendig mikrofon, 1 = ren kupemikrofon.
       Verdier imellom er en ekte blanding av begge, ikke et mellomting. */
    cabin: 0.55,
    volume: 0.85
  };

  /* ═══ tilstand ═══ */
  var ST_OFF = 0, ST_CRANK = 1, ST_RUN = 2, ST_STOP = 3;
  var state = ST_OFF;

  var crank = 0;                       /* veivvinkel 0..720° */
  var rpm = 0, rpmTarget = 0, rpmPrev = 0;
  var gear = 0, gearTime = 0;
  var speed = 0, speedIn = 0, speedPrev = 0, accel = 0, accelIn = 0;
  var throttle = 0, throttleOverride = -1;
  var fuelCut = 1, fuelCutT = 0;
  var shiftT = 0, shiftDir = 0, blipT = 0;
  var limiterT = 0;
  var crankT = 0, crankDur = 0.8, stopT = 0;
  var idleWob = 0, idleWobTarget = 0, idleWobT = 0;
  var starterAmp = 0;

  var fireAng = [0, 90, 180, 270, 360, 450, 540, 630];
  var cylTrim = new Float32Array(8);   /* fast avvik: ingen motor er perfekt */
  var cylAmp = new Float32Array(8);    /* variasjon fra syklus til syklus */
  var cylDec = new Float32Array(8);    /* forbrenningen brenner litt ulikt hver gang */
  var cylJit = new Float32Array(8);    /* tenningsjitter */
  var prevPh = new Float32Array(8);
  for (var ci = 0; ci < 8; ci++) {
    cylTrim[ci] = 1 + nrnd() * 0.06;
    cylAmp[ci] = cylTrim[ci];
    cylDec[ci] = 0.052;   /* settes fra cfg.burn ved første syklus */
    cylJit[ci] = nrnd() * 0.7;
    prevPh[ci] = 0;
  }

  /* ═══ lydgraf ═══ */
  var MAXD = (SR * 0.05) | 0;
  var hdrA = new Delay(MAXD), hdrB = new Delay(MAXD);
  var hdrLPA = new OnePole(), hdrLPB = new OnePole();
  var midL = new Delay(MAXD), midR = new Delay(MAXD);
  var midLPL = new OnePole(), midLPR = new OnePole();
  var mufLPL = new OnePole(), mufLPR = new OnePole();
  var turbA = new OnePole(), turbB = new OnePole();
  var turbCoef = poleA(2100);

  var apL1 = new AP(SR * 0.0071, 0.45), apL2 = new AP(SR * 0.0043, 0.36);
  var apR1 = new AP(SR * 0.0067, 0.45), apR2 = new AP(SR * 0.0047, 0.36);

  var dcL = new BQ(), dcR = new BQ();
  var eqLowL = new BQ(), eqLowR = new BQ();
  var eqRumL = new BQ(), eqRumR = new BQ();
  /* Bassen skal IKKE gjennom metningen. Signalet deles i to bånd, bare
     det øvre forvrenges, og de summeres igjen. Det er dette som gjør at
     man kan ha mye bunn uten at det blir grøtete og bråkete. */
  var splitL1 = new OnePole(), splitL2 = new OnePole();
  var splitR1 = new OnePole(), splitR2 = new OnePole();
  var splitA = poleA(170);
  /* Transientforsterker. To omhyllingsfølgere med ulik hastighet: der den
     raske ligger over den trege, skjer det noe brått — altså en tenning.
     Differansen brukes til å løfte akkurat det øyeblikket, så pulsene står
     fram i stedet for å smelte sammen. */
  var fastL = 0, slowL = 0, fastR = 0, slowR = 0;
  var punchFast = poleA(210), punchSlow = poleA(11);
  var eqBodyL = new BQ(), eqBodyR = new BQ();
  var eqRaspL = new BQ(), eqRaspR = new BQ();
  /* To mikrofonperspektiver som kjorer parallelt paa samme eksossignal:
       INNE  — karosseriet spiser diskanten, kupeen boomer i bunnen
       UTE   — full bandbredde, hardere anslag, mer kant paa hver puls
     De blandes til slutt. Det er slik en bilspill-motor faktisk mikses:
     tyngden kommer innenfra, detaljene utenfra. */
  var inLPL = new BQ(), inLPR = new BQ();       /* karosseriets lavpass */
  var inBoomL = new BQ(), inBoomR = new BQ();   /* kuperesonans */
  var inTameL = new BQ(), inTameR = new BQ();   /* demp skarpheten i mellomtonen */
  var outLPL = new BQ(), outLPR = new BQ();
  var outEdgeL = new BQ(), outEdgeR = new BQ(); /* naerhet / anslag */
  dcL.highpass(18, 0.7); dcR.highpass(18, 0.7);
  eqBodyL.peaking(235, 0.9, 2.5); eqBodyR.peaking(235, 0.9, 2.5);

  var intakeBP = new BQ(), intakeBP2 = new BQ(), mechHP = new BQ();
  intakeBP.bandpass(220, 1.1); intakeBP2.bandpass(680, 0.8); mechHP.highpass(2600, 0.7);

  /* liten romklang — nok til at det ikke høres «tørt/digitalt» ut */
  var revA = new Delay((SR * 0.031) | 0), revB = new Delay((SR * 0.047) | 0);
  var revLPa = new OnePole(), revLPb = new OnePole();
  var revDA = SR * 0.0291, revDB = SR * 0.0437;

  /* smell/spraking */
  var POPN = 12;
  var popE = new Float32Array(POPN), popMul = new Float32Array(POPN),
    popAmp = new Float32Array(POPN), popFq = new Float32Array(POPN),
    popPh = new Float32Array(POPN), popPan = new Float32Array(POPN),
    popOn = new Uint8Array(POPN);

  var whinePh = 0, whinePh2 = 0, starterPh = 0;

  /* turbo */
  var boost = 0;                 /* 0-1, med treghet i oppspolingen */
  var whistlePh = 0;
  var whistleSVF = new SVF(), bovSVF = new SVF();
  var bovE = 0, bovMul = 0, bovAmp = 0, bovFreq = 0, bovFDec = 1, bovCool = 0;
  var thrSlow = 0;
  var limEnv = 0;

  /* utjevnede parametere (per sample, unngår zipper-støy) */
  var sPunch = 0;
  var sCombAmp = 0, sPumpAmp = 0.5, sNoiseAmp = 0.4, sDrive = 1,
    sLevel = 1, sIntake = 0, sWhine = 0, sMech = 0, sMufMix = 0.5, sStarter = 0,
    sFloor = 0, sCabin = 0.55, sBoost = 0, sTurbo = 0;

  /* Avblåsingsventilen åpner når du slipper gassen mens turboen fortsatt
     står på trykk. Lyden er luft som slippes ut: et bredt støyutbrudd som
     synker i frekvens etter hvert som trykket faller. */
  function fireBOV(strength) {
    bovE = 1;
    bovAmp = strength;
    var dur = 0.20 + strength * 0.34;
    bovMul = Math.exp(-(3.2 / dur) * invSR);
    bovFreq = 1500 + strength * 1500;
    bovFDec = Math.exp(-(1.6 / dur) * invSR);
    pushEvent('bov', Math.round(strength * 100) / 100);
  }

  var evQueue = [];
  function pushEvent(name, value) {
    if (evQueue.length < 8) evQueue.push({ e: name, v: value });
  }

  /* måltall for lydparametere, satt av updateVehicle, glattet i render */
  var tCombAmp = 0, tPumpAmp = 0.5, tNoiseAmp = 0.4, tDrive = 1, tLevel = 0,
    tIntake = 0, tWhine = 0, tMech = 0, tMufMix = 0.5, tStarter = 0, tFloor = 0,
    tCabin = 0.55, tBoost = 0, tTurbo = 0, tPunch = 0.9, mufA = 0.3;

  /* ── koeffisienter som avhenger av cfg ── */
  var hdrDA = 0, hdrDB = 0, midDL = 0, midDR = 0, dampA = 0, dampA2 = 0;
  function recalcGeometry() {
    /* rundtur i røret: 2L/c. Lukket ved ventil, åpen i samlerøret
       => resonans på odde multipler av c/4L, som et ekte header-rør. */
    hdrDA = clamp(SR * 2 * cfg.headerLen / C_AIR, 8, MAXD - 4);
    hdrDB = clamp(SR * 2 * (cfg.headerLen * 1.035) / C_AIR, 8, MAXD - 4);
    midDL = clamp(SR * 2 * cfg.midLen / C_AIR, 8, MAXD - 4);
    midDR = clamp(SR * 2 * (cfg.midLen * 1.022) / C_AIR, 8, MAXD - 4);
    dampA = poleA(cfg.damping);
    dampA2 = poleA(cfg.damping * 0.55);
    /* Lavhylle løfter HELE bunnen — også halv- og kvartordens linjene som
       ligger under tenningsfrekvensen. Det er de som ER rumlingen; en smal
       topp på 80 Hz traff bare grunntonen og gjorde den brummete i stedet. */
    eqLowL.lowshelf(125, cfg.growl); eqLowR.lowshelf(125, cfg.growl);
    eqRumL.peaking(62, 0.9, cfg.rumble); eqRumR.peaking(64, 0.9, cfg.rumble);

    /* INNE: bilen rundt deg. Karosseri og glass demper alt over ca. 2,5 kHz,
       og kupeen har en egenresonans nede rundt 60 Hz som gir brystdunket. */
    inLPL.lowpass(2500, 0.72); inLPR.lowpass(2560, 0.72);
    inBoomL.peaking(62, 1.0, 5.5); inBoomR.peaking(64, 1.0, 5.5);
    inTameL.peaking(1600, 1.1, -4); inTameR.peaking(1640, 1.1, -4);

    /* UTE: mikrofon ved enderoret. Full bandbredde og naerhet, saa
       forbrenningspulsene og smellene beholder anslaget sitt. */
    outLPL.lowpass(9000, 0.7); outLPR.lowpass(9150, 0.7);
    outEdgeL.peaking(2300, 0.9, 2.4); outEdgeR.peaking(2360, 0.9, 2.4);
  }
  recalcGeometry();

  function firePop(strength, big) {
    for (var k = 0; k < POPN; k++) {
      if (popOn[k]) continue;
      popOn[k] = 1;
      popE[k] = 1;
      popAmp[k] = strength * (0.45 + urnd() * 0.85) * cfg.popGain;
      var dec = big ? (48 + urnd() * 40) : (170 + urnd() * 320);
      popMul[k] = Math.exp(-dec * invSR);
      popFq[k] = big ? (65 + urnd() * 65) : (170 + urnd() * 520);
      popPh[k] = 0;
      popPan[k] = clamp(0.5 + nrnd() * 0.5, 0, 1);
      return;
    }
  }
  function popBurst(n, strength) {
    for (var i = 0; i < n; i++) firePop(strength * (0.6 + urnd() * 0.7), i === 0);
  }

  /* ═══════════════════════════════════════════════════════════════════
     KJØRETØY / DRIVLINJE — oppdateres én gang per lydblokk
     ═══════════════════════════════════════════════════════════════════ */
  function startShift(dir) {
    var top = cfg.gears.length - 1;
    if (dir > 0 && gear >= top) return;
    if (dir < 0 && gear <= 0) return;
    gear += dir;
    gearTime = 0;
    shiftDir = dir;
    if (dir > 0) {
      shiftT = 0.30;
      fuelCutT = 0.075 + urnd() * 0.03;      /* tenningskutt = «bark» */
      popBurst(1 + ((urnd() * 2.6) | 0), 0.55 + throttle * 0.75);
    } else {
      shiftT = 0.26;
      blipT = 0.17;                          /* mellomgass */
      if (urnd() < 0.75) popBurst(1, 0.45 + throttle * 0.4);
    }
    pushEvent('shift', dir);
  }

  function updateVehicle(dt) {
    /* ---- inngang: fart og akselerasjon ---- */
    speed += (speedIn - speed) * clamp(dt * 7.5, 0, 1);
    var dv = (speed - speedPrev) / Math.max(dt, 1e-4);
    speedPrev = speed;
    var aMix = accelIn * 0.6 + dv * 0.4;
    accel += (aMix - accel) * clamp(dt * 8, 0, 1);

    /* ---- gasspådrag estimert fra kjøringen ---- */
    /* Hva som er «full gass» avhenger av farten.
       En elbil gir alt fra stillstand, men er effektbegrenset over grunnfarten,
       så maks akselerasjon faller som powerRef/fart. Måler vi gasspådraget mot
       en fast verdi i stedet, blir alt full gass i by og ingenting i motorvei-
       fart. Her måles akselerasjonen mot det bilen FAKTISK klarer akkurat nå,
       så halv gass høres ut som halv gass i hele fartsregisteret. */
    var aRef = cfg.powerRef / (speed < 4 ? 4 : speed);
    if (aRef > cfg.accelFull) aRef = cfg.accelFull;
    if (aRef < 0.9) aRef = 0.9;
    /* Ved marsjfart står gassen allerede et stykke inne bare for å holde
       farten. Akselerasjonen fordeles derfor over det som er IGJEN av pedalen,
       slik at «full gass» lander på nøyaktig 1,0 uansett fart. */
    var dragLoad = clamp(speed / 34, 0, 0.28);          /* luftmotstand ved fart */
    var aDemand = clamp(accel / aRef, -2, 2);
    var demand = clamp(dragLoad + (1 - dragLoad) * aDemand, 0, 1);
    if (accel < -0.35) demand = 0;                       /* slipp gass / brems */
    if (blipT > 0) demand = 0.85;                        /* mellomgass ved nedgir */
    if (throttleOverride >= 0) demand = throttleOverride;
    var trate = demand > throttle ? 11 : 5.5;
    throttle += (demand - throttle) * clamp(dt * trate, 0, 1);
    throttle = clamp(throttle, 0, 1);

    /* ---- tomgangsvariasjon (motoren «puster») ---- */
    idleWobT -= dt;
    if (idleWobT <= 0) { idleWobT = 0.12 + urnd() * 0.22; idleWobTarget = nrnd() * 42 * cfg.idleLope; }
    idleWob += (idleWobTarget - idleWob) * clamp(dt * 5, 0, 1);

    /* ---- girkasse ---- */
    gearTime += dt;
    if (shiftT > 0) shiftT -= dt;
    if (blipT > 0) blipT -= dt;

    var wheelRps = speed / cfg.tireCirc;
    var ratio = cfg.gears[gear] * cfg.finalDrive;
    var rpmWheels = wheelRps * 60 * ratio;

    if (state === ST_RUN && shiftT <= 0 && gearTime > 0.6) {
      var upAt = cfg.shiftUpLow + throttle * (cfg.shiftUpHigh - cfg.shiftUpLow);
      var dnAt = 1250 + throttle * 1450;
      if (rpmWheels > upAt && accel > -0.25) startShift(1);
      else if (rpmWheels < dnAt && speed > 1.2) startShift(-1);
    }

    /* rull til stopp: legg den i 1. gir igjen (clutch inn) */
    if (speed < 0.8 && gear > 0 && shiftT <= 0) { gear = 0; gearTime = 0; }

    /* ---- clutch ----
       Motoren går alltid det RASKESTE av (a) det hjulene krever og
       (b) det gassen ville turtallet opp til med clutchen sluppet.
       Under igangkjøring gir (b) et stabilt «slure-turtall» som hjulene
       tar igjen — akkurat som når du slipper clutchen fra stillstand. */
    ratio = cfg.gears[gear] * cfg.finalDrive;
    rpmWheels = wheelRps * 60 * ratio;
    var freeRpm = cfg.idleRpm + idleWob + throttle * (cfg.maxRpm * 0.45 - cfg.idleRpm);
    var target = rpmWheels > freeRpm ? rpmWheels : freeRpm;
    /* motoren står aldri helt stille i turtall — også ved marsjfart «puster» den */
    target += idleWob * (0.25 + 0.75 * (1 - clamp(speed * 0.1, 0, 1)));

    /* ---- turtallsrespons ---- */
    var tau;
    if (state === ST_CRANK) {
      crankT += dt;
      target = 250 + idleWob * 0.6;
      tau = 0.15;
      starterAmp = 1;
      if (crankT > crankDur) {
        state = ST_RUN;
        target = cfg.idleRpm * 1.9;          /* oppstartsflare */
        starterAmp = 0;
        pushEvent('running', 1);
      }
    } else if (state === ST_STOP) {
      stopT += dt;
      target = 0;
      tau = 0.30;
      fuelCutT = 0.05;
      if (stopT > 1.4) { state = ST_OFF; rpm = 0; pushEvent('off', 1); }
    } else if (state === ST_OFF) {
      target = 0; tau = 0.25;
    } else {
      tau = shiftT > 0 ? (shiftDir > 0 ? 0.055 : 0.05) : 0.075;
      /* turtallssperre */
      if (rpm > cfg.limitRpm) {
        limiterT -= dt;
        if (limiterT <= 0) { fuelCutT = 0.05; limiterT = 0.105; firePop(0.75, false); }
        target = Math.min(target, cfg.limitRpm * 1.02);
      }
    }
    rpmTarget = target;
    rpmPrev = rpm;
    rpm += (rpmTarget - rpm) * clamp(dt / tau, 0, 1);
    if (state !== ST_OFF && state !== ST_STOP) rpm = clamp(rpm, 120, cfg.maxRpm * 1.05);

    /* ---- tenningskutt ---- */
    if (fuelCutT > 0) fuelCutT -= dt;
    var cutTarget = fuelCutT > 0 ? 0.05 : 1;
    fuelCut += (cutTarget - fuelCut) * clamp(dt * 55, 0, 1);

    /* ---- smell i eksosen ----
       Ekte etterbrenning skjer når uforbrent drivstoff treffer varm eksos:
       på motorbrems, ved tenningskutt og rett etter girskift.            */
    if (state === ST_RUN) {
      var hot = clamp((rpm - 1600) / 3200, 0, 1);
      var overrun = (throttle < 0.08 && accel < -0.25) ? 1 : 0;
      var rate = cfg.popRate * hot * (overrun * 9 + (fuelCutT > 0 ? 26 : 0) + hot * 0.4);
      if (rate > 0 && urnd() < rate * dt) {
        firePop((0.25 + hot * 0.7) * (overrun ? 1 : 0.8), urnd() < 0.22);
      }
    }

    /* ---- turbo ----
       Ladetrykket bygger seg sakte opp (turboen må spole) og faller fort
       når gassen slippes. Det er nettopp det trykket som må ut gjennom
       avblåsingsventilen. */
    var rpmN = clamp(rpm / cfg.maxRpm, 0, 1.1);
    if (cfg.turbo > 0.001 && state === ST_RUN) {
      var bTarget = clamp(throttle * (0.2 + 0.8 * rpmN), 0, 1);
      boost += (bTarget - boost) * clamp(dt * (bTarget > boost ? 1.7 : 5.5), 0, 1);
      if (bovCool > 0) bovCool -= dt;
      /* Sammenlign med gassen for et par hundre millisekunder siden, ikke
         forrige lydblokk — pedalen slippes på et kvart sekund, ikke på 3 ms. */
      thrSlow += (throttle - thrSlow) * clamp(dt * 3.5, 0, 1);
      if (throttle < 0.22 && thrSlow > 0.42 && boost > 0.16 && speed > 3.5 && bovCool <= 0) {
        fireBOV(clamp(boost * 1.3, 0.3, 1));
        bovCool = 0.7;
        thrSlow = throttle;
      }
    } else {
      boost += (0 - boost) * clamp(dt * 4, 0, 1);
      thrSlow = throttle;
    }

    var tq = 0.82 + 0.30 * sinT(clamp(rpm / (cfg.torquePeak * 2), 0, 1) * 0.5);
    tBoost = boost;
    tTurbo = cfg.turbo;
    var thrEff = throttle;
    tCombAmp = (0.21 + 0.79 * thrEff) * fuelCut * tq;
    tPumpAmp = 0.12 + 0.17 * rpmN;
    tNoiseAmp = 0.16 + 0.30 * thrEff;
    tFloor = 0.004 + 0.016 * rpmN;
    tDrive = 1.05 + thrEff * 0.85 + rpmN * 0.5;
    tLevel = (0.52 + 0.72 * rpmN) * (state === ST_OFF ? 0 : 1);
    tIntake = cfg.intake * Math.pow(thrEff, 0.7) * (0.25 + 0.85 * rpmN);
    tWhine = cfg.whine * (0.15 + 0.85 * thrEff) * Math.pow(rpmN, 1.3);
    tMech = 0.018 + 0.022 * rpmN;
    tMufMix = clamp(cfg.muffler * (1 - thrEff * 0.30), 0, 1);
    tStarter = starterAmp;

    if (state === ST_CRANK) { tCombAmp = 0.05; tLevel = 0.55; }

    /* filtre som følger turtall/gass */
    eqRaspL.peaking(1150 + rpmN * 900, 1.0, cfg.rasp * (0.25 + thrEff * 0.9));
    eqRaspR.peaking(1180 + rpmN * 900, 1.0, cfg.rasp * (0.25 + thrEff * 0.9));
    tCabin = clamp(cfg.cabin, 0, 1);
    tPunch = cfg.punch;
    var ifq = clamp(rpm / 60 * 2.2, 80, 900);
    intakeBP.bandpass(ifq, 1.2);
    mufA = poleA(1500 + thrEff * 3200 + rpmN * 1800);
  }

  /* ═══════════════════════════════════════════════════════════════════
     LYDGENERERING — per sample
     ═══════════════════════════════════════════════════════════════════ */
  function render(outL, outR, n) {
    var dt = n * invSR;
    updateVehicle(dt);

    if (state === ST_OFF && rpm < 1 && limEnv < 0.001) {
      for (var z = 0; z < n; z++) { outL[z] = 0; outR[z] = 0; }
      return;
    }

    /* lineær turtallsrampe gjennom blokka => ingen «trappetrinn» i tonehøyden */
    var rpmA = rpmPrev, rpmStep = (rpm - rpmPrev) / n;
    var smooth = clamp(dt * 14, 0, 1);
    var refl = cfg.reflection, mrefl = cfg.midReflection, xo = cfg.crossover;
    var vol = cfg.volume;

    for (var i = 0; i < n; i++) {
      var rpmCur = rpmA + rpmStep * i;

      /* glidende parametere */
      sCombAmp += (tCombAmp - sCombAmp) * smooth;
      sPumpAmp += (tPumpAmp - sPumpAmp) * smooth;
      sNoiseAmp += (tNoiseAmp - sNoiseAmp) * smooth;
      sDrive += (tDrive - sDrive) * smooth;
      sLevel += (tLevel - sLevel) * smooth;
      sIntake += (tIntake - sIntake) * smooth;
      sWhine += (tWhine - sWhine) * smooth;
      sMech += (tMech - sMech) * smooth;
      sMufMix += (tMufMix - sMufMix) * smooth;
      sStarter += (tStarter - sStarter) * smooth * 0.5;
      sFloor += (tFloor - sFloor) * smooth;
      sCabin += (tCabin - sCabin) * smooth;
      sBoost += (tBoost - sBoost) * smooth;
      sTurbo += (tTurbo - sTurbo) * smooth;
      sPunch += (tPunch - sPunch) * smooth;

      /* ---- veivaksel ---- */
      crank += rpmCur * 6 * invSR;
      while (crank >= 720) crank -= 720;

      /* ---- åtte sylindre ---- */
      var bdA = 0, bdB = 0, scA = 0, scB = 0;
      for (var c = 0; c < 8; c++) {
        var ph = crank - fireAng[c] - cylJit[c];
        if (ph < 0) ph += 720; else if (ph >= 720) ph -= 720;

        /* frisk variasjon midt i syklusen — langt unna pulsen, ingen klikk */
        if (prevPh[c] < 500 && ph >= 500) {
          cylAmp[c] = cylTrim[c] * (1 + nrnd() * 0.11 * cfg.combVar);
          cylJit[c] = nrnd() * 0.8 * cfg.combVar;
          cylDec[c] = cfg.burn * (1 + nrnd() * 0.16 * cfg.combVar);
        }
        prevPh[c] = ph;

        if (ph < OPEN_DEG) {
          var bd;
          if (ph < 6.5) { var x = ph * 0.1538; bd = x * x * (3 - 2 * x); }
          else bd = expT((ph - 6.5) * cylDec[c]);
          var sc = 0;
          if (ph > 26) { var y = (ph - 26) * 0.004464; if (y < 1) sc = sinT(y * 0.5); }
          var am = cylAmp[c];
          if (cfg.banks[c] === 0) { bdA += bd * am; scA += sc * am; }
          else { bdB += bd * am; scB += sc * am; }
        }
      }

      var exA = bdA * sCombAmp + scA * sPumpAmp;
      var exB = bdB * sCombAmp + scB * sPumpAmp;

      /* Turbulensstøy: proporsjonal med gjennomstrømningen, pluss et lite
         konstant sus fra gassen som alltid står i røret. Hvit støy høres
         digital og hvesende ut, så den lavpassfiltreres først. */
      var nA = turbA.lp(nrnd(), turbCoef);
      var nB = turbB.lp(nrnd(), turbCoef);
      var flowA = bdA + scA * 0.14 + sFloor;
      var flowB = bdB + scB * 0.14 + sFloor;
      exA += flowA * sNoiseAmp * nA * 2.2;
      exB += flowB * sNoiseAmp * nB * 2.2;

      /* startmotor */
      if (sStarter > 0.001) {
        starterPh += 1240 * invSR;
        if (starterPh > 1) starterPh -= 1;
        var stn = (sinT(starterPh) * 0.5 + nrnd() * 0.5) * sStarter * 0.22;
        exA += stn; exB += stn * 0.8;
      }

      /* ---- smell: mates INN i eksosrøret ---- */
      var pL = 0, pR = 0;
      for (var k = 0; k < POPN; k++) {
        if (!popOn[k]) continue;
        popE[k] *= popMul[k];
        if (popE[k] < 0.0015) { popOn[k] = 0; continue; }
        popPh[k] += popFq[k] * invSR;
        var pv = (nrnd() * 0.85 + sinT(popPh[k]) * 0.55) * popE[k] * popAmp[k];
        pL += pv * (1 - popPan[k]);
        pR += pv * popPan[k];
      }

      /* ---- bølgeleder: header per bank ---- */
      var hA = hdrA.read(hdrDA);
      hdrA.write(exA * 1.15 - hdrLPA.lp(hA, dampA) * refl);
      var hB = hdrB.read(hdrDB);
      hdrB.write(exB * 1.15 - hdrLPB.lp(hB, dampA) * refl);

      /* ---- H-rør + doble midtrør ---- */
      var inL = hA + hB * xo + pL;
      var inR = hB + hA * xo + pR;

      var mL = midL.read(midDL);
      midL.write(inL - midLPL.lp(mL, dampA2) * mrefl);
      var mR = midR.read(midDR);
      midR.write(inR - midLPR.lp(mR, dampA2) * mrefl);

      /* ---- potte (diffusjon + demping), blandes med rett gjennomløp ---- */
      var fL = apL2.run(apL1.run(mL));
      fL = mufLPL.lp(fL, mufA);
      var fR = apR2.run(apR1.run(mR));
      fR = mufLPR.lp(fR, mufA);
      var yL = mL * (1 - sMufMix) + fL * sMufMix * 1.35;
      var yR = mR * (1 - sMufMix) + fR * sMufMix * 1.35;

      /* ---- innsug + mekanisk klapring (senterplassert) ---- */
      var mono = 0;
      if (sIntake > 0.001) {
        var nz = nrnd();
        mono += (intakeBP.run(nz) * 1.6 + intakeBP2.run(nz) * 0.5) * sIntake;
      }
      mono += mechHP.run((bdA + bdB) * (0.6 + 0.4 * urnd())) * sMech;
      /* ---- kompressorhyl og avblåsing ---- */
      if (sTurbo > 0.001) {
        if (sBoost > 0.01) {
          var fWh = 820 + sBoost * 2500 + rpmCur * 0.10;
          whistlePh += fWh * invSR; if (whistlePh > 1) whistlePh -= 1;
          var wTone = sinT(whistlePh) * 0.62 + sinT(whistlePh * 2) * 0.22;
          var wAir = whistleSVF.band(nrnd(), svfF(fWh * 1.2), 0.30);
          mono += (wTone + wAir * 1.7) * sBoost * sBoost * sTurbo * 0.085;
        }
        if (bovE > 0.0008) {
          bovE *= bovMul;
          bovFreq *= bovFDec;
          if (bovFreq < 260) bovFreq = 260;
          mono += bovSVF.band(nrnd(), svfF(bovFreq), 0.5) * bovE * bovAmp * sTurbo * 1.35;
        }
      }
      if (sWhine > 0.001) {
        var wf = rpmCur * 0.33;
        whinePh += wf * invSR; if (whinePh > 1) whinePh -= 1;
        whinePh2 += wf * 2 * invSR; if (whinePh2 > 1) whinePh2 -= 1;
        mono += (sinT(whinePh) * 0.7 + sinT(whinePh2) * 0.3) * sWhine * 0.16;
      }
      yL += mono; yR += mono;

      /* ---- utgangs-EQ: kropp, brøl, rasp, kupé ---- */
      yL = dcL.run(yL); yR = dcR.run(yR);
      yL = eqLowL.run(yL); yR = eqLowR.run(yR);
      yL = eqRumL.run(yL); yR = eqRumR.run(yR);
      yL = eqBodyL.run(yL); yR = eqBodyR.run(yR);
      yL = eqRaspL.run(yL); yR = eqRaspR.run(yR);

      /* ---- metning, men bare på det øvre båndet ----
         Bassen har de største utslagene, så kjøres den gjennom metningen
         blir den både klemt flat og full av grove overtoner. Her tas den
         ut først, forvrengningen legges på resten, og de summeres igjen:
         bunnen står ren og tung, kanten sitter der den skal. */
      var loL = splitL2.lp(splitL1.lp(yL, splitA), splitA);
      var loR = splitR2.lp(splitR1.lp(yR, splitA), splitA);
      var hiL = yL - loL, hiR = yR - loR;

      /* transientløft før metningen, ellers spiser metningen det opp igjen */
      if (sPunch > 0.001) {
        var aL = hiL < 0 ? -hiL : hiL, aR = hiR < 0 ? -hiR : hiR;
        fastL += (aL - fastL) * punchFast; slowL += (aL - slowL) * punchSlow;
        fastR += (aR - fastR) * punchFast; slowR += (aR - slowR) * punchSlow;
        var pL = fastL - slowL, pR = fastR - slowR;
        if (pL > 0) hiL *= 1 + (pL > 0.35 ? 0.35 : pL) * 2.4 * sPunch;
        if (pR > 0) hiR *= 1 + (pR > 0.35 ? 0.35 : pR) * 2.4 * sPunch;
      }

      hiL *= sDrive; hiR *= sDrive;
      hiL = hiL / (1 + Math.abs(hiL) * 0.7);
      hiR = hiR / (1 + Math.abs(hiR) * 0.7);
      yL = loL * 1.15 + hiL;
      yR = loR * 1.15 + hiR;

      /* ── de to perspektivene, og blandingen mellom dem ──
         Begge kjores alltid, saa ingen detaljer forsvinner i mellomstillinger:
         du hoerer kupeens tyngde OG utsidens kant samtidig. */
      var inL = inTameL.run(inBoomL.run(inLPL.run(yL))) * 1.42;
      var inR = inTameR.run(inBoomR.run(inLPR.run(yR))) * 1.42;
      var exL = outEdgeL.run(outLPL.run(yL));
      var exR = outEdgeR.run(outLPR.run(yR));
      yL = inL * sCabin + exL * (1 - sCabin);
      yR = inR * sCabin + exR * (1 - sCabin);

      /* ---- liten romfølelse ---- */
      var ra = revA.read(revDA), rb = revB.read(revDB);
      revA.write(yL * 0.5 + revLPa.lp(rb, 0.42) * 0.12);
      revB.write(yR * 0.5 + revLPb.lp(ra, 0.42) * 0.12);
      yL += ra * 0.025; yR += rb * 0.025;

      yL *= sLevel * vol; yR *= sLevel * vol;

      /* ---- limiter (koblet stereo) ---- */
      var pk = Math.abs(yL) > Math.abs(yR) ? Math.abs(yL) : Math.abs(yR);
      if (pk > limEnv) limEnv += (pk - limEnv) * 0.75;
      else limEnv += (pk - limEnv) * 0.0009;
      var g = limEnv > 0.88 ? 0.88 / limEnv : 1;
      yL *= g; yR *= g;

      outL[i] = yL < -1 ? -1 : (yL > 1 ? 1 : yL);
      outR[i] = yR < -1 ? -1 : (yR > 1 ? 1 : yR);
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
     API
     ═══════════════════════════════════════════════════════════════════ */
  return {
    render: render,

    setProfile: function (p) {
      for (var key in p) { if (p[key] !== undefined && p[key] !== null) cfg[key] = p[key]; }
      if (!cfg.gears || !cfg.gears.length) cfg.gears = [3.42, 2.14, 1.45, 1.09, 0.85, 0.69];
      if (gear >= cfg.gears.length) gear = cfg.gears.length - 1;
      recalcGeometry();
    },

    setInput: function (speedMs, accelMs2) {
      if (typeof speedMs === 'number' && isFinite(speedMs)) speedIn = clamp(speedMs, 0, 120);
      if (typeof accelMs2 === 'number' && isFinite(accelMs2)) accelIn = clamp(accelMs2, -12, 12);
    },

    setThrottleOverride: function (v) {
      throttleOverride = (typeof v === 'number' && v >= 0) ? clamp(v, 0, 1) : -1;
    },

    start: function () {
      if (state === ST_RUN || state === ST_CRANK) return;
      state = ST_CRANK; crankT = 0; crankDur = 0.55 + urnd() * 0.35;
      boost = 0; bovE = 0; bovCool = 0; thrSlow = 0;
      rpm = 90; gear = 0; gearTime = 1; speed = 0; speedPrev = 0;
      throttle = 0; fuelCut = 1; limEnv = 0;
      pushEvent('cranking', 1);
    },

    stop: function () {
      if (state === ST_OFF) return;
      state = ST_STOP; stopT = 0; starterAmp = 0;
      pushEvent('stopping', 1);
    },

    snapshot: function () {
      var ev = evQueue; evQueue = [];
      return {
        rpm: rpm, gear: gear + 1, gears: cfg.gears.length,
        speed: speed, throttle: throttle, accel: accel,
        state: state, shifting: shiftT > 0 ? shiftDir : 0,
        limiter: rpm > cfg.limitRpm ? 1 : 0,
        events: ev
      };
    }
  };
}
`;
