import { useState, useEffect, useRef } from 'react';
import * as Location from 'expo-location';

export interface SpeedState {
  speedKmh: number;
  permissionGranted: boolean;
  permissionChecked: boolean;
}

export function useSpeed(active: boolean): SpeedState {
  const [speedKmh, setSpeedKmh] = useState(0);
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [permissionChecked, setPermissionChecked] = useState(false);
  const subRef = useRef<Location.LocationSubscription | null>(null);

  useEffect(() => {
    Location.getForegroundPermissionsAsync().then(({ status }) => {
      setPermissionGranted(status === 'granted');
      setPermissionChecked(true);
    });
  }, []);

  useEffect(() => {
    if (!active || !permissionGranted) {
      subRef.current?.remove();
      subRef.current = null;
      setSpeedKmh(0);
      return;
    }

    let cancelled = false;

    Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: 150,
        distanceInterval: 0,
      },
      (loc) => {
        if (cancelled) return;
        const ms = loc.coords.speed ?? 0;
        // GPS can briefly return negative speed — clamp to zero
        setSpeedKmh(Math.max(0, ms * 3.6));
      },
    ).then((sub) => {
      if (cancelled) { sub.remove(); return; }
      subRef.current = sub;
    });

    return () => {
      cancelled = true;
      subRef.current?.remove();
      subRef.current = null;
    };
  }, [active, permissionGranted]);

  return { speedKmh, permissionGranted, permissionChecked };
}
