/**
 * Bilen og motorene.
 *
 * Bilen er en VW e-Golf. Den bestemmer girkassen, hvor fort det går, og hva
 * som teller som «full gass». Motorprofilene bestemmer bare hvordan det låter.
 * Skal appen brukes i en annen bil, er det CAR under som endres — girkassen
 * regnes ut av seg selv fra toppfarten.
 */

export interface EngineProfile {
  id: string;
  name: string;
  tagline: string;
  accent: string;
  redlineRpm: number;
  dsp: Record<string, unknown>;
}

/* ═══════════════════════════════════════════════════════════════════
   BILEN — VW e-Golf (100 kW, 290 Nm, 35,8 kWh)
   ═══════════════════════════════════════════════════════════════════ */
export const CAR = {
  name: 'VW e-Golf',
  /** km/t — sperret på 150 */
  topSpeedKmh: 150,
  /** meter per hjulomdreining, 205/55 R16 */
  tireCirc: 1.96,
  /**
   * m/s² — maks akselerasjon fra stillstand. e-Golf gjør 0–100 på ca. 9,6 s,
   * men elmotoren gir alt med én gang: 0–50 tar bare ca. 3,4 s.
   */
  accelFull: 4.3,
  /**
   * m²/s³ — effekt delt på masse (100 kW / 1615 kg). Over grunnfarten er
   * bilen effektbegrenset, og maks akselerasjon faller som powerRef / fart.
   * Det er dette som gjør at 100 km/t i timen føles helt annerledes enn 30.
   */
  powerRef: 62,
  /** m/s² — retardasjon når du slipper gassen (regenerering i D) */
  regen: 1.6,
} as const;

/** Maks akselerasjon bilen faktisk klarer ved en gitt fart. */
export function fullThrottleAccel(speedMs: number): number {
  const a = CAR.powerRef / Math.max(speedMs, 4);
  return Math.min(a, CAR.accelFull);
}

/**
 * Girkasse regnet ut fra bilen, ikke gjettet.
 *
 * Toppgiret velges slik at turtallet ved toppfart lander på TOP_FRACTION av
 * turtallssperren — altså med litt igjen, som i en ekte bil. Resten av girene
 * fordeles geometrisk nedover, slik at hvert skift føles like stort.
 *
 * Returnerer TOTALE utvekslinger, så finalDrive settes til 1.
 */
const TOP_FRACTION = 0.65;
const RATIO_SPAN = 5.7;      // 1. gir er 5,7 ganger kortere enn toppgiret

export function gearboxFor(redlineRpm: number, count = 6): number[] {
  const vTop = CAR.topSpeedKmh / 3.6;
  const topRatio = (TOP_FRACTION * redlineRpm * CAR.tireCirc) / (60 * vTop);
  const step = Math.pow(RATIO_SPAN, 1 / (count - 1));
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(+(topRatio * Math.pow(step, count - 1 - i)).toFixed(3));
  }
  return out;
}

/** Felles kjøretøydata som alle motorprofiler arver. */
function vehicle(redlineRpm: number, gears = 6) {
  return {
    gears: gearboxFor(redlineRpm, gears),
    finalDrive: 1,
    tireCirc: CAR.tireCirc,
    accelFull: CAR.accelFull,
    powerRef: CAR.powerRef,
  };
}

/* ═══════════════════════════════════════════════════════════════════
   MOTORENE
   ═══════════════════════════════════════════════════════════════════

   banks[]: hvilken sylinderbank hver av de 8 tenningene (90° fra hverandre)
            tilhører. Dette ene feltet er forskjellen på amerikansk rumling
            og italiensk hyl:

     Crossplane  [0,1,1,0,1,0,0,1]  bank A fyrer 270-180-90-180°  -> ujevnt
     Flatplane   [0,1,0,1,0,1,0,1]  bank A fyrer 180-180-180-180° -> jevnt
     Rekkesekser [0,0,0,0,0,0]      alle i én manifold, jevnt hver 120°

   Ligger alle tenningene på bank 0 er motoren enbanks: det finnes bare én
   manifold, og eksosen deler seg først bak samlerøret. Modellen håndterer
   det ved å mate begge halerørene fra samme strøm, med ulik rørlengde og
   hver sin turbulens — akkurat som et ekte todelt anlegg bak én turbo.
*/

export const PROFILES: EngineProfile[] = [
  {
    id: 'muscle',
    name: 'MUSCLE V8',
    tagline: '6,2 L crossplane · rette rør',
    accent: '#FF7A2F',
    redlineRpm: 6400,
    dsp: {
      cylinders: 8,
      banks: [0, 1, 1, 0, 1, 0, 0, 1],
      idleRpm: 700,
      maxRpm: 6400,
      limitRpm: 6100,
      headerLen: 0.97,
      midLen: 2.02,
      reflection: 0.42,
      midReflection: 0.26,
      damping: 1700,
      muffler: 0.26,
      crossover: 0.36,
      burn: 0.095,
      turbo: 0.7,
      punch: 1.0,
      growl: 6.5,
      rumble: 5.0,
      rasp: 2.6,
      intake: 0.26,
      whine: 0,
      popRate: 1.15,
      popGain: 3.4,
      idleLope: 1.35,
      combVar: 1.25,
      torquePeak: 3400,
      /* Bytilpasset: girer tidlig når du sluser, seint når du kjører hardt */
      shiftUpLow: 2200,
      shiftUpHigh: 5800,
      ...vehicle(6400),
    },
  },
  {
    id: 'track',
    name: 'TRACK V8',
    tagline: '4,5 L flatplane · turtallssterk',
    accent: '#FFD23F',
    redlineRpm: 8600,
    dsp: {
      cylinders: 8,
      banks: [0, 1, 0, 1, 0, 1, 0, 1],
      idleRpm: 900,
      maxRpm: 8600,
      limitRpm: 8300,
      headerLen: 0.62,
      midLen: 1.35,
      reflection: 0.40,
      midReflection: 0.22,
      damping: 3000,
      muffler: 0.2,
      crossover: 0.22,
      burn: 0.105,
      turbo: 0.55,
      punch: 0.85,
      growl: 4.0,
      rumble: 2.5,
      rasp: 5.2,
      intake: 0.4,
      whine: 0,
      popRate: 1.0,
      popGain: 3.6,
      idleLope: 0.55,
      combVar: 0.7,
      torquePeak: 5600,
      shiftUpLow: 3000,
      shiftUpHigh: 8100,
      ...vehicle(8600, 7),
    },
  },
  {
    id: 'blown',
    name: 'BLOWN V8',
    tagline: '6,2 L kompressor · Hellcat-aktig',
    accent: '#48E5C2',
    redlineRpm: 6600,
    dsp: {
      cylinders: 8,
      banks: [0, 1, 1, 0, 1, 0, 0, 1],
      idleRpm: 760,
      maxRpm: 6600,
      limitRpm: 6300,
      headerLen: 0.92,
      midLen: 1.94,
      reflection: 0.40,
      midReflection: 0.24,
      damping: 1950,
      muffler: 0.32,
      crossover: 0.3,
      burn: 0.088,
      turbo: 0.9,
      punch: 0.95,
      growl: 6.0,
      rumble: 4.5,
      rasp: 3.2,
      intake: 0.3,
      whine: 0.85,
      popRate: 1.3,
      popGain: 2.8,
      idleLope: 1.0,
      combVar: 1.0,
      torquePeak: 4200,
      shiftUpLow: 2350,
      shiftUpHigh: 6100,
      ...vehicle(6600),
    },
  },
  {
    id: 'jdm',
    name: 'JDM TURBO',
    tagline: '2,6 L rekkesekser · twin-turbo',
    accent: '#4D8DFF',
    redlineRpm: 8000,
    dsp: {
      /* Rekkesekser i RB26-ånden: seks jevne tenninger hver 120°, alle i én
         manifold. Den perfekt jevne tenningen er grunnen til at en rekkesekser
         hyler turbinaktig i stedet for å rumle som en V8 — det finnes ingen
         halv- eller kvartordens ujevnhet å rumle på. */
      cylinders: 6,
      banks: [0, 0, 0, 0, 0, 0],
      idleRpm: 850,
      maxRpm: 8000,
      limitRpm: 7800,
      /* korte primærrør og lite potte — turboene sitter tett på */
      headerLen: 0.72,
      midLen: 1.62,
      reflection: 0.36,
      midReflection: 0.22,
      damping: 2600,
      muffler: 0.18,
      crossover: 0.5,
      burn: 0.105,
      /* turboen ER lyden på denne */
      turbo: 1.0,
      punch: 1.0,
      growl: 3.5,
      rumble: 1.5,
      rasp: 5.5,
      intake: 0.45,
      whine: 0,
      /* turbomotorer smeller mindre på motorbrems enn en sugemotor med
         rette rør, men de smeller hardt i girskiftene */
      popRate: 0.75,
      popGain: 3.0,
      idleLope: 0.4,
      combVar: 0.55,
      torquePeak: 4800,
      shiftUpLow: 2600,
      shiftUpHigh: 7400,
      ...vehicle(8000),
    },
  },
  {
    id: 'golfr',
    name: 'GOLF R',
    tagline: '2,0 L rekkefirer · turbo',
    accent: '#8E7BFF',
    redlineRpm: 6800,
    dsp: {
      /* Bygget på måling av et ekte Golf R-opptak, ikke på gjetning.

         Tenningsfrekvensen gikk fra 27 til 182 Hz gjennom opptaket. En
         firesylindret firetakter fyrer to ganger per omdreining, så 27 Hz
         er tomgang på 810 og 182 Hz er 5460 o/min. Det er en rekkefirer,
         og alle fire går i samme manifold fram til turboen.

         Klangen er hentet fra partier der turtallet står helt stille —
         under en akselerasjon vandrer tonehøyden inne i målevinduet og
         smører alle linjene ut. Tre slike partier (2190, 2340 og 3060
         o/min) ga samme svar: sterk grunntone, og alt over den mye
         svakere enn på en sugemotor med rette rør. Derfor lite rasp,
         kraftig demping i røret og en potte som faktisk demper. */
      cylinders: 4,
      banks: [0, 0, 0, 0],
      idleRpm: 810,
      maxRpm: 6800,
      limitRpm: 6600,
      headerLen: 0.84,
      midLen: 2.40,
      reflection: 0.37,
      midReflection: 0.40,
      damping: 528,
      muffler: 0.61,
      crossover: 0.64,
      burn: 0.043,
      turbo: 0.85,
      punch: 0.49,
      /* Målt båndbalanse rundt 200-500 Hz: +5 under 90 Hz, +4 på 90-200,
         -7 på 500-1200, -13 på 1,2-3k, -20 på 3-7k, -29 over 7k. Tyngden
         ligger lavt, men det er ingen V8-rumling — bare en kompakt bunn. */
      growl: 3.8,
      rumble: 4.6,
      rasp: 0.33,
      intake: 0.21,
      whine: 0,
      /* Halvordenen lå 23 dB under tenningstonen. Den kommer av at
         sylindrene ikke er helt like, og gjentar seg hver andre
         omdreining — derfor fast trim, ikke tilfeldig variasjon. */
      trim: 0.35,
      combVar: 0.8,
      levelTrim: 0.32,
      idleLope: 0.6,
      /* Golf R spraker på motorbrems, og det er hørbart i opptaket. */
      popRate: 1.4,
      popGain: 3.0,
      torquePeak: 3000,
      shiftUpLow: 2100,
      shiftUpHigh: 6200,
      ...vehicle(6800, 7),
    },
  },
];

export const DEFAULT_PROFILE_ID = 'muscle';

export function profileById(id: string): EngineProfile {
  return PROFILES.find((p) => p.id === id) ?? PROFILES[0];
}
