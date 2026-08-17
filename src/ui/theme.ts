import { Platform, TextStyle } from 'react-native';

export const T = {
  bg: '#05070C',
  bgDeep: '#020306',
  glass: 'rgba(255,255,255,0.055)',
  glassStrong: 'rgba(255,255,255,0.10)',
  border: 'rgba(255,255,255,0.13)',
  borderBright: 'rgba(255,255,255,0.26)',
  text: '#EEF3FF',
  muted: '#7E8AA3',
  dim: 'rgba(255,255,255,0.10)',
  red: '#FF4438',
  green: '#3DDC84',
} as const;

/** Sifre som ikke hopper i bredden når tallet endrer seg */
export const numeric: TextStyle = {
  fontVariant: ['tabular-nums'],
  ...Platform.select({
    android: { fontFamily: 'sans-serif-medium' },
    default: {},
  }),
};

function hex(c: string) {
  const h = c.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

export function mix(a: string, b: string, t: number) {
  const A = hex(a), B = hex(b);
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const r = Math.round(A[0] + (B[0] - A[0]) * k);
  const g = Math.round(A[1] + (B[1] - A[1]) * k);
  const bl = Math.round(A[2] + (B[2] - A[2]) * k);
  return `rgb(${r},${g},${bl})`;
}

export function withAlpha(c: string, a: number) {
  const [r, g, b] = hex(c);
  return `rgba(${r},${g},${b},${a})`;
}
