/**
 * Motorprofiler. Hver profil er en fysisk beskrivelse — rørlengder,
 * tenningsrekkefølge, girkasse — ikke et sett med lydfiler.
 *
 * banks[]: hvilken sylinderbank hver av de 8 tenningene (90° fra hverandre)
 *          tilhører. Dette ene feltet er forskjellen på amerikansk rumling
 *          og italiensk hyl:
 *
 *   Crossplane  [0,1,1,0,1,0,0,1]  bank A fyrer 270-180-90-180°  -> ujevnt, rumling
 *   Flatplane   [0,1,0,1,0,1,0,1]  bank A fyrer 180-180-180-180° -> jevnt, hyl
 */

export interface EngineProfile {
  id: string;
  name: string;
  tagline: string;
  accent: string;
  redlineRpm: number;
  dsp: Record<string, unknown>;
}

const MUSCLE_GEARS = [3.42, 2.14, 1.45, 1.09, 0.85, 0.69];

export const PROFILES: EngineProfile[] = [
  {
    id: 'muscle',
    name: 'MUSCLE V8',
    tagline: '6.2 L crossplane · rette rør',
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
      gears: MUSCLE_GEARS,
      finalDrive: 3.31,
      tireCirc: 2.05,
      shiftUpLow: 2300,
      shiftUpHigh: 5800,
      torquePeak: 3400,
    },
  },
  {
    id: 'track',
    name: 'TRACK V8',
    tagline: '4.5 L flatplane · turtallssterk',
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
      gears: [3.15, 2.05, 1.52, 1.18, 0.95, 0.79, 0.67],
      finalDrive: 3.9,
      tireCirc: 2.0,
      shiftUpLow: 3200,
      shiftUpHigh: 8100,
      torquePeak: 5600,
    },
  },
  {
    id: 'blown',
    name: 'BLOWN V8',
    tagline: '6.2 L kompressor · Hellcat-aktig',
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
      gears: MUSCLE_GEARS,
      finalDrive: 3.09,
      tireCirc: 2.08,
      shiftUpLow: 2500,
      shiftUpHigh: 6100,
      torquePeak: 4200,
    },
  },
];

export const DEFAULT_PROFILE_ID = 'muscle';

export function profileById(id: string): EngineProfile {
  return PROFILES.find((p) => p.id === id) ?? PROFILES[0];
}
