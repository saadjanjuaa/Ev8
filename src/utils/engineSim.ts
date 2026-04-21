// Speed → RPM simulation for a V8 muscle car
// Models a 6-speed manual with realistic gear ratios

const GEAR_THRESHOLDS = [0, 20, 42, 68, 100, 135]; // km/h to upshift
// RPM per (km/h) for each gear — derived from real gearbox + axle math
const RPM_PER_KMH = [0, 148, 82, 56, 38, 28, 21];

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

export function calcEngine(
  speedKmh: number,
  prevSpeedKmh: number,
): EngineState {
  const gear = getGear(speedKmh);
  const accelKmhPerTick = speedKmh - prevSpeedKmh;

  // Natural (cruise) RPM for current gear and speed
  const cruiseRPM = Math.max(820, speedKmh * RPM_PER_KMH[gear]);

  // When accelerating: RPM spikes above cruise (driver held gear, or downshifted)
  const rpmSpike = Math.max(0, accelKmhPerTick * 210);

  const rpm = Math.min(7000, cruiseRPM + rpmSpike);

  // Throttle: normalised 0–1 from measured acceleration
  const throttle = accelKmhPerTick > 0 ? Math.min(1, accelKmhPerTick / 9) : 0;

  return { rpm, gear, throttle };
}

// Format speed nicely
export function formatSpeed(kmh: number): string {
  return Math.round(kmh).toString().padStart(3, ' ');
}

// RPM zone colour
export function rpmColor(rpm: number): string {
  if (rpm < 4500) return '#22ff88';
  if (rpm < 6000) return '#ffaa00';
  return '#ff3300';
}
