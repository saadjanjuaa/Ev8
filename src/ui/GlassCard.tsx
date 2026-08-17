import React from 'react';
import { StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { T } from './theme';

interface Props {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  radius?: number;
  intensity?: number;
  /** svak fargetone i glasset */
  tint?: string;
}

/**
 * Frostet glass: blur + hårfin lys kant øverst + mørk kant nederst.
 * Kanten er det som får det til å se ut som ekte glass og ikke bare
 * en gjennomsiktig boks.
 */
export function GlassCard({ children, style, radius = 24, intensity = 26, tint }: Props) {
  return (
    <View style={[styles.wrap, { borderRadius: radius }, style]}>
      <BlurView intensity={intensity} tint="dark" style={StyleSheet.absoluteFill} />
      <LinearGradient
        colors={[
          'rgba(255,255,255,0.13)',
          'rgba(255,255,255,0.03)',
          'rgba(0,0,0,0.16)',
        ]}
        locations={[0, 0.45, 1]}
        style={StyleSheet.absoluteFill}
      />
      {tint ? <View style={[StyleSheet.absoluteFill, { backgroundColor: tint }]} /> : null}
      <View style={[styles.hairline, { borderRadius: radius }]} pointerEvents="none" />
      <View style={styles.content}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    overflow: 'hidden',
    backgroundColor: T.glass,
  },
  hairline: {
    ...StyleSheet.absoluteFill,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: T.border,
  },
  content: { padding: 16 },
});
