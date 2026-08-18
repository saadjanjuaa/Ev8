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
*/

export const PROFILES: EngineProfile[] = [
  {
    id: 'muscle',
    name: 'MUSCLE V8',
    tagline: '6,2 L crossplane · rette rør',
    accent: '#FF7A2F',
    redlineRpm: 6400,
    dsp: {
      banks: [0, 1, 1, 0, 1, 0, 0, 1],
      idleRpm: 700,
      maxRpm: 6400,
      limitRpm: 6100,
      headerLen: 0.92,
      midLen: 1.85,
      reflection: 0.7,
      midReflection: 0.47,
      damping: 2700,
      muffler: 0.42,
      crossover: 0.36,
      growl: 7.5,
      rasp: 3.2,
      intake: 0.4,
      whine: 0,
      popRate: 1.15,
      popGain: 1.1,
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
      banks: [0, 1, 0, 1, 0, 1, 0, 1],
      idleRpm: 900,
      maxRpm: 8600,
      limitRpm: 8300,
      headerLen: 0.62,
      midLen: 1.35,
      reflection: 0.64,
      midReflection: 0.38,
      damping: 4600,
      muffler: 0.3,
      crossover: 0.22,
      growl: 3.5,
      rasp: 7.0,
      intake: 0.7,
      whine: 0,
      popRate: 1.0,
      popGain: 0.85,
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
      banks: [0, 1, 1, 0, 1, 0, 0, 1],
      idleRpm: 760,
      maxRpm: 6600,
      limitRpm: 6300,
      headerLen: 0.84,
      midLen: 1.7,
      reflection: 0.66,
      midReflection: 0.44,
      damping: 3400,
      muffler: 0.5,
      crossover: 0.3,
      growl: 6.5,
      rasp: 4.5,
      intake: 0.55,
      whine: 0.85,
      popRate: 1.3,
      popGain: 1.2,
      idleLope: 1.0,
      combVar: 1.0,
      torquePeak: 4200,
      shiftUpLow: 2350,
      shiftUpHigh: 6100,
      ...vehicle(6600),
    },
  },
];

export const DEFAULT_PROFILE_ID = 'muscle';

export function profileById(id: string): EngineProfile {
  return PROFILES.find((p) => p.id === id) ?? PROFILES[0];
}
