import { CAR, fullThrottleAccel } from './profiles';

/**
 * Skriptet testkjøring: 0–50 km/t med halv gass, 50–100 km/t med pedalen i
 * gulvet. Farten integreres opp fra bilens faktiske akselerasjonsevne, ikke
 * fra en fast kurve — så det du hører er nøyaktig det e-Golfen ville gjort.
 *
 * Kjøres fra matesløyfa i DriveScreen og mater lydmotoren på samme vei som
 * ekte GPS-data, slik at girkasse, gasspådrag og smell oppfører seg likt.
 */

export type TestPhase =
  | 'vent'
  | 'tomgang'
  | 'medium'
  | 'full'
  | 'hold'
  | 'utrulling'
  | 'ferdig';

export interface TestRun {
  phase: TestPhase;
  /** sekunder i gjeldende fase */
  t: number;
  /** m/s */
  v: number;
}

const MID_KMH = 50;
const TOP_KMH = 100;
/** halv gass = halvparten av det bilen klarer fra stillstand */
const MEDIUM_FRACTION = 0.5;
/**
 * m/s² på slutten av testen: regenerering pluss et lett bremsetrykk, så
 * demonstrasjonen ikke bruker et kvarter på å rulle ned fra 100.
 */
const COAST_DECEL = 3.0;

export const TEST_LABELS: Record<TestPhase, string> = {
  vent: 'STARTER MOTOR …',
  tomgang: 'TESTKJØRING · TOMGANG',
  medium: `TESTKJØRING · 0→${MID_KMH} HALV GASS`,
  full: `TESTKJØRING · ${MID_KMH}→${TOP_KMH} FULL GASS`,
  hold: `TESTKJØRING · ${TOP_KMH} KM/T`,
  utrulling: 'TESTKJØRING · SLIPP GASSEN',
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
  done: boolean;
}

/**
 * Ett steg framover. `engineReady` er sann når motoren faktisk går (ikke
 * mens startmotoren drar rundt), slik at testen ikke begynner å rulle før
 * motoren har tatt tak.
 */
export function stepTestRun(run: TestRun, dt: number, engineReady: boolean): TestTick {
  let a = 0;
  run.t += dt;

  switch (run.phase) {
    case 'vent':
      if (engineReady) next(run, 'tomgang');
      break;

    case 'tomgang':
      if (run.t >= 1.2) next(run, 'medium');
      break;

    case 'medium':
      a = CAR.accelFull * MEDIUM_FRACTION;
      if (run.v >= MID_KMH / 3.6) next(run, 'full');
      break;

    case 'full':
      a = fullThrottleAccel(run.v);
      if (run.v >= TOP_KMH / 3.6) next(run, 'hold');
      break;

    case 'hold':
      /* hold farten: akkurat nok gass til å stå imot luftmotstanden */
      a = 0;
      if (run.t >= 1.6) next(run, 'utrulling');
      break;

    case 'utrulling':
      a = -COAST_DECEL;
      if (run.v <= 0) next(run, 'ferdig');
      break;

    case 'ferdig':
      break;
  }

  run.v = Math.max(0, run.v + a * dt);
  return { speed: run.v, accel: a, done: run.phase === 'ferdig' };
}

function next(run: TestRun, phase: TestPhase) {
  run.phase = phase;
  run.t = 0;
}
