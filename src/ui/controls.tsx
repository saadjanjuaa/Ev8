import React from 'react';
import {
  Pressable,
  StyleProp,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { T, numeric, withAlpha } from './theme';

/* ───────────────────────── statuspille ───────────────────────── */

export function Pill({
  label,
  color = T.muted,
  dot,
  style,
}: {
  label: string;
  color?: string;
  dot?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[s.pill, style]}>
      {dot ? <View style={[s.dot, { backgroundColor: dot }]} /> : null}
      <Text style={[s.pillText, { color }]}>{label}</Text>
    </View>
  );
}

/* ───────────────────────── måler ───────────────────────── */

export const Meter = React.memo(function Meter({
  value,
  accent,
  label,
  right,
}: {
  /** 0–1, kvantisert av kalleren så den ikke tegnes på nytt hele tiden */
  value: number;
  accent: string;
  label: string;
  right?: string;
}) {
  const pct = Math.max(0, Math.min(1, value));
  return (
    <View>
      <View style={s.meterHead}>
        <Text style={s.meterLabel}>{label}</Text>
        {right ? <Text style={[s.meterValue, numeric]}>{right}</Text> : null}
      </View>
      <View style={s.meterTrack}>
        <LinearGradient
          colors={[withAlpha(accent, 0.55), accent]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={[s.meterFill, { width: `${pct * 100}%` }]}
        />
      </View>
    </View>
  );
});

/* ───────────────────────── valgknapper ───────────────────────── */

export function ChipRow<T extends { id: string; name: string }>({
  items,
  selectedId,
  onSelect,
  accentOf,
}: {
  items: readonly T[];
  selectedId: string;
  onSelect: (id: string) => void;
  accentOf: (item: T) => string;
}) {
  return (
    <View style={s.chipRow}>
      {items.map((it) => {
        const on = it.id === selectedId;
        const accent = accentOf(it);
        return (
          <Pressable
            key={it.id}
            onPress={() => onSelect(it.id)}
            style={({ pressed }) => [
              s.chip,
              on && { borderColor: withAlpha(accent, 0.75), backgroundColor: withAlpha(accent, 0.14) },
              pressed && { opacity: 0.7 },
            ]}
          >
            <Text style={[s.chipText, on && { color: accent }]} numberOfLines={1}>
              {it.name}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/* ───────────────────────── hovedknapp ───────────────────────── */

export function PowerButton({
  running,
  busy,
  accent,
  onPress,
}: {
  running: boolean;
  busy: boolean;
  accent: string;
  onPress: () => void;
}) {
  const label = busy ? 'STARTER …' : running ? 'SLÅ AV MOTOR' : 'START MOTOR';
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [s.power, pressed && { transform: [{ scale: 0.985 }] }]}
    >
      <LinearGradient
        colors={
          running
            ? ['rgba(255,255,255,0.10)', 'rgba(255,255,255,0.03)']
            : [withAlpha(accent, 0.95), withAlpha(accent, 0.55)]
        }
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <View
        style={[
          s.powerBorder,
          { borderColor: running ? T.border : withAlpha(accent, 0.9) },
        ]}
      />
      <Text style={[s.powerText, { color: running ? T.text : '#080A0F' }]}>{label}</Text>
    </Pressable>
  );
}

/* ───────────────────────── liten bryter ───────────────────────── */

export function Toggle({
  on,
  label,
  accent,
  onPress,
}: {
  on: boolean;
  label: string;
  accent: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={s.toggleRow} hitSlop={8}>
      <Text style={s.toggleLabel}>{label}</Text>
      <View style={[s.track, on && { backgroundColor: withAlpha(accent, 0.4) }]}>
        <View
          style={[
            s.knob,
            on && { transform: [{ translateX: 18 }], backgroundColor: accent },
          ]}
        />
      </View>
    </Pressable>
  );
}

const s = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: T.border,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  pillText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.7 },

  meterHead: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 7 },
  meterLabel: { color: T.muted, fontSize: 11, fontWeight: '700', letterSpacing: 1.1 },
  meterValue: { color: T.text, fontSize: 11, fontWeight: '700' },
  meterTrack: {
    height: 7,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
  },
  meterFill: { height: '100%', borderRadius: 4 },

  chipRow: { flexDirection: 'row', gap: 8 },
  chip: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: 14,
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.045)',
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: T.border,
  },
  chipText: { color: T.muted, fontSize: 11.5, fontWeight: '800', letterSpacing: 0.6 },

  power: {
    height: 58,
    borderRadius: 18,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  powerBorder: {
    ...StyleSheet.absoluteFill,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth * 2,
  },
  powerText: { fontSize: 14, fontWeight: '900', letterSpacing: 1.6 },

  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  toggleLabel: { color: T.muted, fontSize: 12, fontWeight: '700', letterSpacing: 0.8 },
  track: {
    width: 40,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(255,255,255,0.10)',
    padding: 2,
    justifyContent: 'center',
  },
  knob: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: 'rgba(255,255,255,0.55)',
  },
});
