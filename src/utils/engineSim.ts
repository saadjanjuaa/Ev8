// Speed → RPM — tuned for Norwegian roads, 130 km/h max
// Earlier gear shifts keep RPM moderate in normal driving.
// Acceleration threshold filters GPS noise (jitter < 2 km/h ignored).

const GEAR_THRESHOLDS = [0, 15, 28, 46, 68, 96]; // km/h upshift points
const RPM_PER_KMH     = [0, 280, 155, 100, 70, 52, 35];
// 6th at 130 km/h cruise = ~4550 RPM; hard acceleration can spike higher.

export function getGear(speedKmh: number): number {
  for (let g = 6; g >= 1; g--) {
    if (speedKmh >= GEAR_THRESHOLDS[g - 1]) return g;
  }
  return 1;
}

export interface EngineState {
  rpm: number;
  gear: number;
  throttle: number;
}

export function calcEngine(speedKmh: number, prevSpeedKmh: number): EngineState {
  const gear      = getGear(speedKmh);
  const accel     = speedKmh - prevSpeedKmh;

  // Filter GPS jitter: only count acceleration above 2 km/h as real
  const realAccel = accel > 2.0 ? accel - 2.0 : 0;

  const cruiseRPM = Math.max(820, speedKmh * RPM_PER_KMH[gear]);
  const rpmSpike  = realAccel * 55;                       // was 210 — much calmer
  const rpm       = Math.min(7000, cruiseRPM + rpmSpike);

  // Throttle only fires on genuine acceleration
  const throttle  = realAccel > 0 ? Math.min(1, realAccel / 10) : 0;

  return { rpm, gear, throttle };
}

export function formatSpeed(kmh: number): string {
  return Math.round(kmh).toString().padStart(3, ' ');
}

export function rpmColor(rpm: number): string {
  if (rpm < 4000) return '#22ff88';
  if (rpm < 5500) return '#ffaa00';
  return '#ff3300';
}
