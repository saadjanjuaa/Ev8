import React, { useMemo } from 'react';
import Svg, {
  Circle,
  Defs,
  G,
  Line,
  RadialGradient,
  Stop,
  Text as SvgText,
} from 'react-native-svg';
import { mix, withAlpha } from './theme';

const SEGMENTS = 58;
const START = 148;   // grader, SVG-koordinater (y peker ned)
const SWEEP = 244;

interface Props {
  size: number;
  /** antall tente segmenter, 0…SEGMENTS */
  lit: number;
  /** første segment i det røde feltet */
  redFrom: number;
  accent: string;
  /** 0–10, hvor sterkt midtgløden lyser */
  glow: number;
  maxRpm: number;
  /** 1 = girer opp, −1 = girer ned */
  shift: number;
  limiter: boolean;
}

/**
 * Turteller som lyskrans. Segmentene er diskrete, så komponenten trenger bare
 * å tegnes på nytt når antall tente segmenter faktisk endrer seg — ikke for
 * hver eneste turtallsverdi. Derfor er den memoisert på heltall.
 */
function TachRingBase({ size, lit, redFrom, accent, glow, maxRpm, shift, limiter }: Props) {
  const cx = size / 2;
  const cy = size / 2;
  const rOut = size / 2 - 6;
  const rIn = rOut - size * 0.085;

  const geometry = useMemo(() => {
    const segs: { x1: number; y1: number; x2: number; y2: number; f: number }[] = [];
    for (let i = 0; i < SEGMENTS; i++) {
      const f = i / (SEGMENTS - 1);
      const a = ((START + f * SWEEP) * Math.PI) / 180;
      const c = Math.cos(a), s = Math.sin(a);
      segs.push({
        x1: cx + c * rIn,
        y1: cy + s * rIn,
        x2: cx + c * rOut,
        y2: cy + s * rOut,
        f,
      });
    }
    return segs;
  }, [cx, cy, rIn, rOut]);

  const labels = useMemo(() => {
    const step = maxRpm > 7000 ? 2000 : 1000;
    const out: { x: number; y: number; t: string }[] = [];
    for (let r = 0; r <= maxRpm; r += step) {
      const f = r / maxRpm;
      const a = ((START + f * SWEEP) * Math.PI) / 180;
      const rr = rIn - size * 0.075;
      out.push({
        x: cx + Math.cos(a) * rr,
        y: cy + Math.sin(a) * rr + size * 0.018,
        t: String(r / 1000),
      });
    }
    return out;
  }, [cx, cy, rIn, size, maxRpm]);

  const glowOpacity = 0.05 + (glow / 10) * 0.4;

  return (
    <Svg width={size} height={size}>
      <Defs>
        <RadialGradient id="core" cx="50%" cy="50%" r="50%">
          <Stop offset="0%" stopColor={accent} stopOpacity={glowOpacity} />
          <Stop offset="55%" stopColor={accent} stopOpacity={glowOpacity * 0.35} />
          <Stop offset="100%" stopColor={accent} stopOpacity={0} />
        </RadialGradient>
      </Defs>

      {/* glød i midten som puster med turtallet */}
      <Circle cx={cx} cy={cy} r={rIn} fill="url(#core)" />

      {/* glassringer */}
      <Circle
        cx={cx}
        cy={cy}
        r={rOut + 3}
        stroke="rgba(255,255,255,0.10)"
        strokeWidth={1}
        fill="none"
      />
      <Circle
        cx={cx}
        cy={cy}
        r={rIn - size * 0.028}
        stroke="rgba(255,255,255,0.07)"
        strokeWidth={1}
        fill="none"
      />

      <G>
        {geometry.map((g, i) => {
          const on = i < lit;
          const inRed = i >= redFrom;
          let color: string;
          let width: number;
          let opacity: number;

          if (on) {
            color = inRed ? '#FF3B2F' : mix('#6FE3FF', accent, Math.min(g.f / 0.72, 1));
            width = inRed ? size * 0.019 : size * 0.016;
            opacity = 1;
          } else {
            color = inRed ? withAlpha('#FF3B2F', 0.22) : 'rgba(255,255,255,0.16)';
            width = size * 0.011;
            opacity = 1;
          }
          return (
            <Line
              key={i}
              x1={g.x1}
              y1={g.y1}
              x2={g.x2}
              y2={g.y2}
              stroke={color}
              strokeWidth={width}
              strokeOpacity={opacity}
              strokeLinecap="round"
            />
          );
        })}
      </G>

      {labels.map((l, i) => (
        <SvgText
          key={i}
          x={l.x}
          y={l.y}
          fill="rgba(255,255,255,0.34)"
          fontSize={size * 0.042}
          fontWeight="600"
          textAnchor="middle"
        >
          {l.t}
        </SvgText>
      ))}

      {/* girskift-markør: lyser opp hele kransen et lite øyeblikk */}
      {shift !== 0 || limiter ? (
        <Circle
          cx={cx}
          cy={cy}
          r={rOut + 3}
          stroke={limiter ? '#FF3B2F' : accent}
          strokeWidth={2}
          strokeOpacity={0.75}
          fill="none"
        />
      ) : null}
    </Svg>
  );
}

export const TachRing = React.memo(TachRingBase);
export const TACH_SEGMENTS = SEGMENTS;
