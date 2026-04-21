import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  Platform,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  Alert,
  Easing,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import WebView from 'react-native-webview';
import * as Location from 'expo-location';

import Tachometer from './src/components/Tachometer';
import GlassCard from './src/components/GlassCard';
import { ENGINE_HTML } from './src/audio/engineHtml';
import { calcEngine, rpmColor } from './src/utils/engineSim';

// ── Throttle bar ────────────────────────────────────────────────────────────
function ThrottleBar({ value }: { value: number }) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: value,
      duration: 120,
      useNativeDriver: false,
      easing: Easing.out(Easing.quad),
    }).start();
  }, [value]);

  const width = anim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });

  const color = anim.interpolate({
    inputRange: [0, 0.5, 1],
    outputRange: ['#22ff88', '#ffaa00', '#ff3300'],
  });

  return (
    <View style={tbar.track}>
      <Animated.View style={[tbar.fill, { width, backgroundColor: color }]} />
    </View>
  );
}

const tbar = StyleSheet.create({
  track: {
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
    flex: 1,
  },
  fill: {
    height: '100%',
    borderRadius: 3,
  },
});

// ── Pulsing "engine on" indicator ───────────────────────────────────────────
function EnginePulse({ active }: { active: boolean }) {
  const anim = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    if (!active) { anim.setValue(0.4); return; }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1,   duration: 700, useNativeDriver: true, easing: Easing.inOut(Easing.sin) }),
        Animated.timing(anim, { toValue: 0.4, duration: 700, useNativeDriver: true, easing: Easing.inOut(Easing.sin) }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active]);

  return (
    <Animated.View style={[pulse.dot, { opacity: anim, backgroundColor: active ? '#22ff88' : '#555' }]} />
  );
}

const pulse = StyleSheet.create({
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});

// ── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [engineRunning, setEngineRunning] = useState(false);
  const [audioReady,    setAudioReady]    = useState(false);
  const [speedKmh,      setSpeedKmh]      = useState(0);
  const [rpm,           setRpm]           = useState(820);
  const [gear,          setGear]          = useState(1);
  const [throttle,      setThrottle]      = useState(0);

  const webViewRef  = useRef<WebView>(null);
  const prevSpeed   = useRef(0);
  const locationSub = useRef<Location.LocationSubscription | null>(null);

  // ── Send message to the hidden WebView ──────────────────────────────────
  const sendAudio = useCallback((msg: object) => {
    const js = `
      (function(){
        var e = new MessageEvent('message', { data: JSON.stringify(${JSON.stringify(msg)}) });
        window.dispatchEvent(e);
      })();true;
    `;
    webViewRef.current?.injectJavaScript(js);
  }, []);

  // ── Start engine ────────────────────────────────────────────────────────
  const startEngine = useCallback(async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(
        'Location Required',
        'EV8 needs location permission to measure your speed.',
        [{ text: 'OK' }],
      );
      return;
    }

    setEngineRunning(true);
    sendAudio({ type: 'start' });

    locationSub.current = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: 150,
        distanceInterval: 0,
      },
      (loc) => {
        const ms  = Math.max(0, loc.coords.speed ?? 0);
        const kmh = ms * 3.6;

        setSpeedKmh(kmh);

        const { rpm: newRpm, gear: newGear, throttle: newThrottle } =
          calcEngine(kmh, prevSpeed.current);

        prevSpeed.current = kmh;
        setRpm(newRpm);
        setGear(newGear);
        setThrottle(newThrottle);

        sendAudio({ type: 'setRPM', rpm: newRpm, throttle: newThrottle });
      },
    );
  }, [sendAudio]);

  // ── Stop engine ─────────────────────────────────────────────────────────
  const stopEngine = useCallback(() => {
    locationSub.current?.remove();
    locationSub.current = null;
    sendAudio({ type: 'stop' });
    setEngineRunning(false);
    setSpeedKmh(0);
    setRpm(820);
    setGear(1);
    setThrottle(0);
    prevSpeed.current = 0;
  }, [sendAudio]);

  const toggleEngine = useCallback(() => {
    if (engineRunning) stopEngine();
    else startEngine();
  }, [engineRunning, startEngine, stopEngine]);

  // ── WebView message handler ─────────────────────────────────────────────
  const onWebViewMessage = useCallback((event: { nativeEvent: { data: string } }) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'ready') setAudioReady(true);
    } catch {}
  }, []);

  const speedInt    = Math.round(speedKmh);
  const displayRpm  = Math.round(rpm / 10) * 10;
  const needleColor = rpmColor(rpm);

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />

      {/* Deep space gradient background */}
      <LinearGradient
        colors={['#06060f', '#0a0818', '#080510', '#060410']}
        locations={[0, 0.3, 0.7, 1]}
        style={StyleSheet.absoluteFill}
      />

      {/* Subtle radial bloom behind tachometer */}
      <View style={styles.bloom} />

      {/* Hidden WebView for audio synthesis */}
      <WebView
        ref={webViewRef}
        source={{ html: ENGINE_HTML }}
        style={styles.webView}
        onMessage={onWebViewMessage}
        javaScriptEnabled
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback
        originWhitelist={['*']}
        onError={(e) => console.warn('WebView error', e.nativeEvent)}
      />

      <SafeAreaView style={styles.safe}>
        {/* ── Header ── */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <Text style={styles.appTitle}>EV8</Text>
            <Text style={styles.appSub}>V8 SOUND ENGINE</Text>
          </View>
          <View style={styles.headerRight}>
            <EnginePulse active={engineRunning} />
            <Text style={[styles.statusText, { color: engineRunning ? '#22ff88' : '#666' }]}>
              {engineRunning ? 'RUNNING' : 'OFF'}
            </Text>
          </View>
        </View>

        {/* ── Tachometer ── */}
        <View style={styles.tachoWrapper}>
          <Tachometer rpm={rpm} />
          {/* Glow ring behind tach */}
          <View style={[styles.tachoGlow, { shadowColor: needleColor }]} />
        </View>

        {/* ── Speed display ── */}
        <GlassCard style={styles.speedCard}>
          <View style={styles.speedRow}>
            <View style={styles.speedBlock}>
              <Text style={styles.speedValue}>{speedInt.toString().padStart(3, ' ')}</Text>
              <Text style={styles.speedUnit}>KM/H</Text>
            </View>
            <View style={styles.divider} />
            <View style={styles.rpmBlock}>
              <Text style={[styles.rpmValue, { color: needleColor }]}>
                {displayRpm.toString().padStart(4, ' ')}
              </Text>
              <Text style={styles.rpmUnit}>RPM</Text>
            </View>
          </View>
        </GlassCard>

        {/* ── Info row ── */}
        <View style={styles.infoRow}>
          {/* Gear indicator */}
          <GlassCard style={styles.gearCard}>
            <Text style={styles.gearLabel}>GEAR</Text>
            <Text style={styles.gearValue}>{engineRunning ? gear : '—'}</Text>
          </GlassCard>

          {/* Throttle */}
          <GlassCard style={styles.throttleCard}>
            <View style={styles.throttleHeader}>
              <Text style={styles.throttleLabel}>THROTTLE</Text>
              <Text style={styles.throttlePct}>{Math.round(throttle * 100)}%</Text>
            </View>
            <ThrottleBar value={throttle} />
          </GlassCard>
        </View>

        {/* ── Start / Stop button ── */}
        <View style={styles.btnWrapper}>
          <TouchableOpacity
            onPress={toggleEngine}
            activeOpacity={0.8}
            disabled={!audioReady}
            style={[styles.engineBtn, !audioReady && styles.engineBtnDisabled]}
          >
            <LinearGradient
              colors={
                engineRunning
                  ? ['rgba(255,40,20,0.25)', 'rgba(180,20,10,0.15)']
                  : ['rgba(30,220,100,0.25)', 'rgba(10,160,60,0.15)']
              }
              style={styles.engineBtnGrad}
            >
              <BlurView intensity={12} tint="dark" style={StyleSheet.absoluteFill} />
              <View style={[
                styles.engineBtnBorder,
                { borderColor: engineRunning ? 'rgba(255,80,40,0.5)' : 'rgba(40,255,120,0.4)' },
              ]} />
              <Text style={[
                styles.engineBtnText,
                { color: engineRunning ? '#ff5533' : '#22ff88' },
              ]}>
                {!audioReady ? 'LOADING…' : engineRunning ? 'KILL ENGINE' : 'START ENGINE'}
              </Text>
              <Text style={styles.engineBtnSub}>
                {!audioReady ? '' : engineRunning ? 'Tap to stop' : 'Tap to ignite'}
              </Text>
            </LinearGradient>
          </TouchableOpacity>
        </View>

        {/* ── Footer note ── */}
        <Text style={styles.footerNote}>
          Drive your vehicle to hear the V8 respond to your speed
        </Text>
      </SafeAreaView>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#06060f',
  },
  safe: {
    flex: 1,
    paddingHorizontal: 20,
  },
  webView: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
  },
  bloom: {
    position: 'absolute',
    top: '15%',
    alignSelf: 'center',
    width: 340,
    height: 340,
    borderRadius: 170,
    backgroundColor: 'transparent',
    shadowColor: '#ff4400',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.08,
    shadowRadius: 80,
    // Android uses elevation; bloom is decorative only
  },

  // Header
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) + 8 : 8,
    marginBottom: 4,
  },
  headerLeft: {},
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  appTitle: {
    fontSize: 28,
    fontWeight: '900',
    color: '#ffffff',
    letterSpacing: 6,
  },
  appSub: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.35)',
    letterSpacing: 3,
    marginTop: 2,
  },
  statusText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 2,
  },

  // Tachometer
  tachoWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 8,
  },
  tachoGlow: {
    position: 'absolute',
    width: 280,
    height: 280,
    borderRadius: 140,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.15,
    shadowRadius: 60,
    pointerEvents: 'none',
  },

  // Speed card
  speedCard: {
    marginBottom: 12,
  },
  speedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
  },
  speedBlock: {
    alignItems: 'center',
    flex: 1,
  },
  rpmBlock: {
    alignItems: 'center',
    flex: 1,
  },
  divider: {
    width: 1,
    height: 48,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  speedValue: {
    fontSize: 52,
    fontWeight: '900',
    color: '#ffffff',
    fontVariant: ['tabular-nums'],
    letterSpacing: -1,
  },
  speedUnit: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.4)',
    letterSpacing: 3,
    marginTop: -4,
  },
  rpmValue: {
    fontSize: 36,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  rpmUnit: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.4)',
    letterSpacing: 3,
    marginTop: -2,
  },

  // Info row
  infoRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 20,
  },
  gearCard: {
    width: 80,
    alignItems: 'center',
  },
  gearLabel: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.4)',
    letterSpacing: 2,
    marginBottom: 4,
  },
  gearValue: {
    fontSize: 36,
    fontWeight: '900',
    color: '#ffffff',
  },
  throttleCard: {
    flex: 1,
    justifyContent: 'center',
  },
  throttleHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  throttleLabel: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.4)',
    letterSpacing: 2,
  },
  throttlePct: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.7)',
    fontWeight: '700',
    letterSpacing: 1,
  },

  // Engine button
  btnWrapper: {
    marginBottom: 16,
  },
  engineBtn: {
    borderRadius: 20,
    overflow: 'hidden',
    height: 80,
  },
  engineBtnDisabled: {
    opacity: 0.5,
  },
  engineBtnGrad: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
  },
  engineBtnBorder: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 20,
    borderWidth: 1.5,
  },
  engineBtnText: {
    fontSize: 18,
    fontWeight: '900',
    letterSpacing: 4,
  },
  engineBtnSub: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.3)',
    letterSpacing: 2,
    marginTop: 2,
  },

  footerNote: {
    textAlign: 'center',
    fontSize: 11,
    color: 'rgba(255,255,255,0.2)',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
});
