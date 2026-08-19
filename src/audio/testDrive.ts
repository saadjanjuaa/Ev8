import { CAR, fullThrottleAccel } from './profiles';

/**
 * Skriptet testkjøring. Forløpet er valgt for å vise fram hver ting motoren
 * gjør, i den rekkefølgen man faktisk kjører:
 *
 *   tomgang
 *   0-50 km/t   rolig akselerasjon
 *   50-30 km/t  slipp gassen  -> avblåsingsventilen fresr
 *   30-100 km/t 80 % gass     -> turboen bygger trykk, girskift
 *   100-30 km/t slipp gassen  -> avblåsing igjen, spraking, nedgir
 *   stopp
 *   noen gasspådrag på tomgang
 *
 * Farten integreres opp fra bilens faktiske akselerasjonsevne, ikke fra en
 * fast kurve, så tempoet stemmer med e-Golfen. Mates inn i lydmotoren på
 * samme vei som ekte GPS-data.
 */

export type TestPhase =
  | 'vent'
  | 'tomgang'
  | 'rolig'
  | 'slipp1'
  | 'hold'
  | 'hard'
  | 'slipp2'
  | 'stopp'
  | 'revs'
  | 'ferdig';

export interface TestRun {
  phase: TestPhase;
  /** sekunder i gjeldende fase */
  t: number;
  /** m/s */
  v: number;
}

const MID_KMH = 50;
const LIFT_KMH = 30;
const TOP_KMH = 100;

/** rolig = halvparten av det bilen klarer fra stillstand */
const CALM = 0.5;
/** hard = 80 % av det bilen klarer ved den farten den har */
const HARD = 0.8;

const LIFT1 = 2.0;    /* m/s² — rolig utrulling ned til 30 */
const LIFT2 = 3.0;    /* m/s² — fra 100 og ned */
const BRAKE = 3.4;    /* m/s² — siste stykket inn til stopp */

export const TEST_LABELS: Record<TestPhase, string> = {
  vent: 'STARTER MOTOR …',
  tomgang: 'TESTKJØRING · TOMGANG',
  rolig: `TESTKJØRING · 0→${MID_KMH} ROLIG`,
  slipp1: `TESTKJØRING · ${MID_KMH}→${LIFT_KMH} SLIPP GASSEN`,
  hold: `TESTKJØRING · ${LIFT_KMH} KM/T`,
  hard: `TESTKJØRING · ${LIFT_KMH}→${TOP_KMH} · 80 % GASS`,
  slipp2: `TESTKJØRING · ${TOP_KMH}→${LIFT_KMH} SLIPP GASSEN`,
  stopp: 'TESTKJØRING · INN TIL STOPP',
  revs: 'TESTKJØRING · GASSPÅDRAG',
  ferdig: 'TESTKJØRING',
};

export function newTestRun(): TestRun {
  return { phase: 'vent', t: 0, v: 0 };
}

export interface TestTick {
  /** m/s inn til lydmotoren */
  speed: number;
  /** m/s² inn til lydmotoren */
  accel: number;
  /** 0-1 tvinger gasspådraget, −1 lar kjøringen styre som vanlig */
  throttle: number;
  done: boolean;
}

/**
 * Ett steg framover. `engineReady` er sann når motoren faktisk går (ikke
 * mens startmotoren drar rundt), slik at testen ikke begynner å rulle før
 * motoren har tatt tak.
 */
export function stepTestRun(run: TestRun, dt: number, engineReady: boolean): TestTick {
  let a = 0;
  let throttle = -1;
  run.t += dt;

  switch (run.phase) {
    case 'vent':
      if (engineReady) next(run, 'tomgang');
      break;

    case 'tomgang':
      if (run.t >= 1.2) next(run, 'rolig');
      break;

    case 'rolig':
      a = CAR.accelFull * CALM;
      if (run.v >= MID_KMH / 3.6) next(run, 'slipp1');
      break;

    case 'slipp1':
      a = -LIFT1;
      if (run.v <= LIFT_KMH / 3.6) next(run, 'hold');
      break;

    case 'hold':
      if (run.t >= 1.0) next(run, 'hard');
      break;

    case 'hard':
      a = fullThrottleAccel(run.v) * HARD;
      if (run.v >= TOP_KMH / 3.6) next(run, 'slipp2');
      break;

    case 'slipp2':
      a = -LIFT2;
      if (run.v <= LIFT_KMH / 3.6) next(run, 'stopp');
      break;

    case 'stopp':
      a = -BRAKE;
      if (run.v <= 0) next(run, 'revs');
      break;

    case 'revs': {
      /* tre gasspådrag på tomgang til slutt */
      const cycle = run.t % 1.05;
      throttle = cycle < 0.42 ? 0.9 : 0;
      if (run.t >= 3.15) { throttle = -1; next(run, 'ferdig'); }
      break;
    }

    case 'ferdig':
      break;
  }

  run.v = Math.max(0, run.v + a * dt);
  return { speed: run.v, accel: a, throttle, done: run.phase === 'ferdig' };
}

function next(run: TestRun, phase: TestPhase) {
  run.phase = phase;
  run.t = 0;
}
