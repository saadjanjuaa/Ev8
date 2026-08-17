import { useEffect, useRef, useState } from 'react';
import * as Location from 'expo-location';
import { DeviceMotion } from 'expo-sensors';

/**
 * Fart og akselerasjon fra telefonen.
 *
 * GPS alene duger ikke: den oppdaterer ca. én gang i sekundet, så lyden ville
 * ligget et helt sekund etter gassfoten. Derfor kjører vi en komplementær-
 * filter-fusjon:
 *
 *   • Akselerometeret (50 Hz) integreres opp og gir øyeblikkelig respons.
 *   • GPS (1 Hz) korrigerer bort driften.
 *
 * Utfordringen er at telefonen kan ligge hvordan som helst i bilen. Vi vet
 * ikke hvilken akse som peker framover. Derfor:
 *
 *   1. Tyngdekraften gir oss «ned» -> vi projiserer akselerasjonen ned i
 *      horisontalplanet.
 *   2. Framoverretningen læres opp over tid: når GPS ser at farten øker,
 *      må den horisontale akselerasjonen akkurat da peke framover. Vi
 *      middler dette opp til en stabil retningsvektor.
 *
 * Etter noen få akselerasjoner sitter retningen, og da er responsen
 * umiddelbar uten at telefonen må ligge i en bestemt posisjon.
 */

export type PermissionState = 'undetermined' | 'granted' | 'denied';

export interface VehicleSample {
  /** m/s — fusjonert fart */
  speed: number;
  /** m/s² — langsgående akselerasjon (positiv = framover) */
  accel: number;
  /** m/s — rå GPS-fart */
  gpsSpeed: number;
  /** meter — GPS-nøyaktighet */
  accuracy: number;
  hasFix: boolean;
  /** 0–1: hvor godt appen har lært framoverretningen */
  headingLock: number;
  /** sekunder siden siste GPS-punkt */
  fixAge: number;
}

export interface VehicleStatus {
  permission: PermissionState;
  hasFix: boolean;
  accuracy: number;
  motionAvailable: boolean;
  headingLock: number;
}

const EMPTY: VehicleSample = {
  speed: 0,
  accel: 0,
  gpsSpeed: 0,
  accuracy: 0,
  hasFix: false,
  headingLock: 0,
  fixAge: 999,
};

export function useVehicleSpeed(active: boolean) {
  const sample = useRef<VehicleSample>({ ...EMPTY });
  const [status, setStatus] = useState<VehicleStatus>({
    permission: 'undetermined',
    hasFix: false,
    accuracy: 0,
    motionAvailable: false,
    headingLock: 0,
  });

  /* ── filtertilstand (holdes utenfor render) ── */
  const st = useRef({
    v: 0,                 // fusjonert fart, m/s
    aLong: 0,             // filtrert langsgående akselerasjon
    aBias: 0,             // treg middelverdi = sensordrift
    fwd: [0, 0, 0],       // lært framoverretning i telefonens akser
    fwdMag: 0,            // hvor sikker retningen er
    grav: [0, 0, -9.81],  // estimert tyngdekraft
    gravInit: false,
    lastMotion: 0,
    lastFix: 0,
    gpsSpeed: 0,
    gpsPrev: 0,
    gpsAccel: 0,
  });

  useEffect(() => {
    if (!active) {
      sample.current = { ...EMPTY };
      st.current.v = 0;
      st.current.aLong = 0;
      return;
    }

    let alive = true;
    let locSub: Location.LocationSubscription | null = null;
    let motSub: { remove: () => void } | null = null;

    (async () => {
      /* ───────────── bevegelsessensor ───────────── */
      try {
        const ok = await DeviceMotion.isAvailableAsync();
        if (alive && ok) {
          DeviceMotion.setUpdateInterval(20);
          motSub = DeviceMotion.addListener((d) => {
            const s = st.current;
            const now = Date.now();
            const dt = s.lastMotion ? Math.min((now - s.lastMotion) / 1000, 0.15) : 0.02;
            s.lastMotion = now;
            if (dt <= 0) return;

            const withG = d.accelerationIncludingGravity;
            if (!withG) return;
            const gx = withG.x ?? 0, gy = withG.y ?? 0, gz = withG.z ?? 0;

            /* tyngdekraft = svært lavpassfiltrert totalakselerasjon */
            const g = s.grav;
            if (!s.gravInit) {
              g[0] = gx; g[1] = gy; g[2] = gz;
              s.gravInit = true;
            } else {
              const k = Math.min(dt * 0.6, 1);
              g[0] += (gx - g[0]) * k;
              g[1] += (gy - g[1]) * k;
              g[2] += (gz - g[2]) * k;
            }

            /* lineær akselerasjon: bruk sensorens egen hvis den finnes */
            let lx: number, ly: number, lz: number;
            const lin = d.acceleration;
            if (lin && typeof lin.x === 'number') {
              lx = lin.x; ly = lin.y; lz = lin.z ?? 0;
            } else {
              lx = gx - g[0]; ly = gy - g[1]; lz = gz - g[2];
            }

            /* projiser vekk den vertikale komponenten (humper i veien) */
            const gm = Math.hypot(g[0], g[1], g[2]) || 9.81;
            const ux = g[0] / gm, uy = g[1] / gm, uz = g[2] / gm;
            const dot = lx * ux + ly * uy + lz * uz;
            const hx = lx - dot * ux, hy = ly - dot * uy, hz = lz - dot * uz;

            /* ── lær framoverretningen fra GPS-akselerasjon ── */
            const ga = s.gpsAccel;
            if (Math.abs(ga) > 0.45) {
              const sign = ga > 0 ? 1 : -1;
              const k = Math.min(dt * 0.9, 0.2);
              s.fwd[0] += (hx * sign - s.fwd[0]) * k;
              s.fwd[1] += (hy * sign - s.fwd[1]) * k;
              s.fwd[2] += (hz * sign - s.fwd[2]) * k;
            }
            const fm = Math.hypot(s.fwd[0], s.fwd[1], s.fwd[2]);
            s.fwdMag = fm;

            let aLong: number;
            if (fm > 0.12) {
              aLong = (hx * s.fwd[0] + hy * s.fwd[1] + hz * s.fwd[2]) / fm;
            } else {
              /* ikke lært enda: bruk GPS-akselerasjonen alene */
              aLong = ga;
            }

            /* fjern sensordrift (treg middelverdi) */
            s.aBias += (aLong - s.aBias) * Math.min(dt * 0.08, 0.02);
            const aClean = aLong - s.aBias;
            s.aLong += (aClean - s.aLong) * Math.min(dt * 12, 1);

            /* ── integrer opp farten mellom GPS-punktene ── */
            const fixAge = (now - s.lastFix) / 1000;
            const trust = fm > 0.12 && fixAge < 6 ? 1 : 0.25;
            s.v += s.aLong * dt * trust;

            /* trekk mot GPS-farten hele tiden, hardere jo eldre prediksjonen er */
            if (s.lastFix) {
              const pull = Math.min(dt * (0.9 + fixAge * 1.6), 0.4);
              s.v += (s.gpsSpeed - s.v) * pull;
            }
            if (s.v < 0) s.v = 0;
            if (s.v > 120) s.v = 120;

            /* står stille: ikke la sensorstøy lage falsk gasspådrag */
            if (s.gpsSpeed < 0.6 && Math.abs(s.aLong) < 0.5) {
              s.v += (0 - s.v) * Math.min(dt * 3, 1);
            }

            sample.current = {
              speed: s.v,
              accel: s.aLong,
              gpsSpeed: s.gpsSpeed,
              accuracy: sample.current.accuracy,
              hasFix: fixAge < 6,
              headingLock: Math.min(fm / 0.8, 1),
              fixAge,
            };
          });
          if (alive) setStatus((p) => ({ ...p, motionAvailable: true }));
        }
      } catch {
        /* uten bevegelsessensor faller vi tilbake til ren GPS */
      }

      /* ───────────── GPS ───────────── */
      let perm: PermissionState = 'denied';
      try {
        const res = await Location.requestForegroundPermissionsAsync();
        perm = res.status === 'granted' ? 'granted' : 'denied';
      } catch {
        perm = 'denied';
      }
      if (!alive) return;
      setStatus((p) => ({ ...p, permission: perm }));
      if (perm !== 'granted') return;

      try {
        locSub = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.BestForNavigation,
            timeInterval: 400,
            distanceInterval: 0,
          },
          (loc) => {
            const s = st.current;
            const now = Date.now();
            const dt = s.lastFix ? Math.max((now - s.lastFix) / 1000, 0.05) : 1;
            s.lastFix = now;

            const raw = loc.coords.speed;
            const v = raw != null && raw >= 0 ? raw : 0;
            s.gpsAccel = (v - s.gpsPrev) / dt;
            s.gpsPrev = v;
            s.gpsSpeed = v;

            /* uten bevegelsessensor er GPS alt vi har */
            if (!s.lastMotion) {
              s.v += (v - s.v) * 0.5;
              s.aLong = s.gpsAccel;
              sample.current = {
                speed: s.v,
                accel: s.aLong,
                gpsSpeed: v,
                accuracy: loc.coords.accuracy ?? 0,
                hasFix: true,
                headingLock: 0,
                fixAge: 0,
              };
            } else {
              sample.current.accuracy = loc.coords.accuracy ?? 0;
            }

            setStatus((p) => {
              const acc = Math.round(loc.coords.accuracy ?? 0);
              const lock = Math.min(s.fwdMag / 0.8, 1);
              if (p.hasFix && p.accuracy === acc && Math.abs(p.headingLock - lock) < 0.1) return p;
              return { ...p, hasFix: true, accuracy: acc, headingLock: lock };
            });
          },
        );
      } catch {
        if (alive) setStatus((p) => ({ ...p, permission: 'denied' }));
      }
    })();

    return () => {
      alive = false;
      locSub?.remove();
      motSub?.remove();
      st.current.lastMotion = 0;
      st.current.lastFix = 0;
    };
  }, [active]);

  return { sample, status };
}
