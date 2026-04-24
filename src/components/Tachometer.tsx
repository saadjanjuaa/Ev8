import React, { useEffect, useRef, useState } from 'react';
import { Animated, View } from 'react-native';
import Svg, {
  Circle,
  Path,
  Line,
  Text as SvgText,
  G,
  Defs,
  RadialGradient,
  Stop,
  LinearGradient,
} from 'react-native-svg';

const SIZE        = 320;
const CX          = SIZE / 2;
const CY          = SIZE / 2;
const OUTER_R     = 148;
const TRACK_R     = 124;
const TICK_OUTER  = 130;
const TICK_INNER_MAJOR = 112;
const TICK_INNER_MINOR = 120;
const LABEL_R     = 100;
const NEEDLE_LEN  = 108;
const NEEDLE_BASE = 14;

const START_DEG = 135;   // 7-o'clock
const SWEEP_DEG = 270;
const MAX_RPM   = 8000;

const DEG_TO_RAD = Math.PI / 180;

function polar(angleDeg: number, r: number) {
  const a = angleDeg * DEG_TO_RAD;
  return { x: CX + r * Math.cos(a), y: CY + r * Math.sin(a) };
}

function arcPath(startDeg: number, endDeg: number, r: number) {
  const s = polar(startDeg, r);
  const e = polar(endDeg, r);
  const span = endDeg - startDeg;
  const large = span > 180 ? 1 : 0;
  return `M ${s.x.toFixed(2)} ${s.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`;
}

function rpmToDeg(rpm: number) {
  return START_DEG + (Math.min(rpm, MAX_RPM) / MAX_RPM) * SWEEP_DEG;
}

interface Props {
  rpm: number;
}

// Tachometer with animated needle
export default function Tachometer({ rpm }: Props) {
  const animRpm = useRef(new Animated.Value(rpm)).current;

  useEffect(() => {
    Animated.spring(animRpm, {
      toValue: rpm,
      useNativeDriver: false,
      friction: 6,
      tension: 35,
    }).start();
  }, [rpm]);

  // Generate tick marks
  const ticks: {
    inner: { x: number; y: number };
    outer: { x: number; y: number };
    isMajor: boolean;
    label: string | null;
    isRed: boolean;
  }[] = [];

  for (let r = 0; r <= MAX_RPM; r += 100) {
    const isMajor = r % 1000 === 0;
    const isMid   = r % 500 === 0 && !isMajor;
    if (!isMajor && !isMid && r % 500 !== 0) {
      if (r % 100 !== 0) continue; // keep every 100
    }
    const deg   = rpmToDeg(r);
    const inner = polar(deg, isMajor ? TICK_INNER_MAJOR : TICK_INNER_MINOR);
    const outer = polar(deg, TICK_OUTER);
    ticks.push({
      inner,
      outer,
      isMajor,
      label: isMajor ? String(r / 1000) : null,
      isRed: r >= 7000,
    });
  }

  return (
    <View style={{ width: SIZE, height: SIZE }}>
      <Svg width={SIZE} height={SIZE}>
        <Defs>
          {/* Face gradient */}
          <RadialGradient id="faceBg" cx="50%" cy="50%" r="50%">
            <Stop offset="0%"   stopColor="#1a1a2e" stopOpacity="1" />
            <Stop offset="60%"  stopColor="#0d0d1a" stopOpacity="1" />
            <Stop offset="100%" stopColor="#050510" stopOpacity="1" />
          </RadialGradient>

          {/* Needle gradient */}
          <LinearGradient id="needleGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <Stop offset="0%"   stopColor="#ff6600" stopOpacity="1" />
            <Stop offset="100%" stopColor="#ff2200" stopOpacity="1" />
          </LinearGradient>
        </Defs>

        {/* Outer bezel ring */}
        <Circle cx={CX} cy={CY} r={OUTER_R} fill="rgba(255,255,255,0.04)" />
        <Circle cx={CX} cy={CY} r={OUTER_R}
          stroke="rgba(255,255,255,0.12)" strokeWidth={1.5} fill="none" />

        {/* Dial face */}
        <Circle cx={CX} cy={CY} r={OUTER_R - 4} fill="url(#faceBg)" />

        {/* Full arc track (dim) */}
        <Path
          d={arcPath(START_DEG, START_DEG + SWEEP_DEG, TRACK_R)}
          stroke="rgba(255,255,255,0.07)"
          strokeWidth={8}
          fill="none"
          strokeLinecap="round"
        />

        {/* Green zone: 0–5000 */}
        <Path
          d={arcPath(START_DEG, rpmToDeg(5000), TRACK_R)}
          stroke="#1aff6a"
          strokeWidth={4}
          fill="none"
          strokeLinecap="round"
          opacity={0.45}
        />

        {/* Yellow zone: 5000–7000 */}
        <Path
          d={arcPath(rpmToDeg(5000), rpmToDeg(7000), TRACK_R)}
          stroke="#ffaa00"
          strokeWidth={4}
          fill="none"
          strokeLinecap="round"
          opacity={0.55}
        />

        {/* Red zone: 7000–8000 */}
        <Path
          d={arcPath(rpmToDeg(7000), rpmToDeg(8000), TRACK_R)}
          stroke="#ff2200"
          strokeWidth={7}
          fill="none"
          strokeLinecap="round"
          opacity={0.85}
        />

        {/* Active RPM arc (bright) */}
        {rpm > 0 && (
          <Path
            d={arcPath(START_DEG, rpmToDeg(rpm), TRACK_R)}
            stroke={rpm < 5000 ? '#22ff88' : rpm < 7000 ? '#ffaa00' : '#ff3300'}
            strokeWidth={5}
            fill="none"
            strokeLinecap="round"
            opacity={0.9}
          />
        )}

        {/* Tick marks */}
        {ticks.map((tk, i) => (
          <G key={i}>
            <Line
              x1={tk.inner.x} y1={tk.inner.y}
              x2={tk.outer.x} y2={tk.outer.y}
              stroke={tk.isRed ? '#ff3300' : 'rgba(255,255,255,0.55)'}
              strokeWidth={tk.isMajor ? 2.5 : 1}
            />
            {tk.label && (
              <SvgText
                x={polar(rpmToDeg(parseInt(tk.label) * 1000), LABEL_R).x}
                y={polar(rpmToDeg(parseInt(tk.label) * 1000), LABEL_R).y}
                textAnchor="middle"
                alignmentBaseline="middle"
                fill={parseInt(tk.label) >= 7 ? '#ff4400' : 'rgba(255,255,255,0.75)'}
                fontSize={11}
                fontWeight="bold"
              >
                {tk.label}
              </SvgText>
            )}
          </G>
        ))}

        {/* "RPM ×1000" label */}
        <SvgText
          x={CX}
          y={CY + 52}
          textAnchor="middle"
          alignmentBaseline="middle"
          fill="rgba(255,255,255,0.3)"
          fontSize={9}
          letterSpacing={2}
        >
          RPM ×1000
        </SvgText>

        {/* Animated needle — rendered via a non-animated path that updates on each render */}
        <AnimatedNeedle animRpm={animRpm} />

        {/* Center cap */}
        <Circle cx={CX} cy={CY} r={20} fill="#111118" />
        <Circle cx={CX} cy={CY} r={20}
          stroke="rgba(255,255,255,0.15)" strokeWidth={1} fill="none" />
        <Circle cx={CX} cy={CY} r={9} fill="#ff3300" />
        <Circle cx={CX} cy={CY} r={4} fill="rgba(255,200,180,0.9)" />
      </Svg>
    </View>
  );
}

// Separate component so the Animated.Value drives re-renders of just the needle
function AnimatedNeedle({ animRpm }: { animRpm: Animated.Value }) {
  const [needleRpm, setNeedleRpm] = useState(0);

  useEffect(() => {
    const id = animRpm.addListener(({ value }) => setNeedleRpm(value));
    return () => animRpm.removeListener(id);
  }, [animRpm]);

  const deg  = rpmToDeg(needleRpm);
  const tip  = polar(deg, NEEDLE_LEN);
  const b1   = polar(deg + 90, NEEDLE_BASE / 2);
  const b2   = polar(deg - 90, NEEDLE_BASE / 2);
  const tail = polar(deg + 180, 18);

  return (
    <>
      {/* Needle shadow */}
      <Path
        d={`M ${b1.x + 1} ${b1.y + 1} L ${tip.x + 1} ${tip.y + 1} L ${b2.x + 1} ${b2.y + 1} Z`}
        fill="rgba(0,0,0,0.4)"
      />
      {/* Main needle */}
      <Path
        d={`M ${b1.x} ${b1.y} L ${tip.x} ${tip.y} L ${b2.x} ${b2.y} L ${tail.x} ${tail.y} Z`}
        fill="#ff3300"
      />
      {/* Needle highlight */}
      <Path
        d={`M ${b1.x} ${b1.y} L ${tip.x} ${tip.y} L ${polar(deg, NEEDLE_LEN * 0.5).x} ${polar(deg, NEEDLE_LEN * 0.5).y} Z`}
        fill="rgba(255,150,80,0.5)"
      />
    </>
  );
}
