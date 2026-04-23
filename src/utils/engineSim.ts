// Speed → RPM simulation — tuned for 130 km/h max (Norwegian roads)
// Gear thresholds scaled so redline (~7000 RPM) hits at 130 km/h in 6th.

const GEAR_THRESHOLDS = [0, 12, 26, 44, 64, 88]; // km/h — upshift points
// RPM per (km/h) for each gear: calibrated so shift point ≈ 5500–6500 RPM
const RPM_PER_KMH   = [0, 380, 195, 128, 90, 70, 54];

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
  const gear = getGear(speedKmh);
  const accel = speedKmh - prevSpeedKmh;

  const cruiseRPM = Math.max(820, speedKmh * RPM_PER_KMH[gear]);
  const rpmSpike  = Math.max(0, accel * 210);
  const rpm       = Math.min(7000, cruiseRPM + rpmSpike);
  const throttle  = accel > 0 ? Math.min(1, accel / 9) : 0;

  return { rpm, gear, throttle };
}

export function formatSpeed(kmh: number): string {
  return Math.round(kmh).toString().padStart(3, ' ');
}

export function rpmColor(rpm: number): string {
  if (rpm < 4500) return '#22ff88';
  if (rpm < 6000) return '#ffaa00';
  return '#ff3300';
}
