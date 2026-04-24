// Speed → RPM for a 6-speed box mapped to 0–130 km/h.
// At redline (130 km/h in 6th) RPM ≈ 8000 = top sample loop.
// Gear ratios drop RPM by ~1100 at each upshift, giving realistic progression.

const IDLE    = 800;
const REDLINE = 8000;

// Speed at which each gear becomes active (gear 1 starts at 0).
export const MIN_SPEED_FOR_GEAR = [0, 0, 18, 40, 65, 90, 112]; // indexed by gear
export const UPSHIFT_KMH        = [18, 40, 65, 90, 112];       // 5 shift points

// RPM per km/h for each gear. Gear 6 at 130 km/h = 7995 RPM (redline).
const RPM_PER_KMH = [0, 378, 172, 112, 82, 68, 61.5];

export function getGear(speedKmh: number): number {
  for (let g = 6; g >= 2; g--) {
    if (speedKmh >= MIN_SPEED_FOR_GEAR[g]) return g;
  }
  return 1;
}

export interface EngineState {
  rpm: number;
  gear: number;
  throttle: number;
}

// GPS noise floor is 3 km/h per sample — anything smaller is jitter, not gas.
export function calcEngine(speedKmh: number, prevSpeedKmh: number): EngineState {
  const gear      = getGear(speedKmh);
  const accel     = speedKmh - prevSpeedKmh;
  const realAccel = accel > 3.0 ? accel - 3.0 : 0;

  const cruiseRPM = Math.max(IDLE, speedKmh * RPM_PER_KMH[gear]);
  const rpmSpike  = realAccel * 40;                   // calm — no fly-aways on light gas
  const rpm       = Math.min(REDLINE, cruiseRPM + rpmSpike);

  const throttle  = realAccel > 0 ? Math.min(1, realAccel / 8) : 0;

  return { rpm, gear, throttle };
}

export function formatSpeed(kmh: number): string {
  return Math.round(kmh).toString().padStart(3, ' ');
}

export function rpmColor(rpm: number): string {
  if (rpm < 4500) return '#22ff88';
  if (rpm < 6500) return '#ffaa00';
  return '#ff3300';
}

export const RPM_REDLINE = REDLINE;
export const RPM_IDLE    = IDLE;
