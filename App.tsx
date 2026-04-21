import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  Easing,
  PanResponder,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  Alert,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import WebView from 'react-native-webview';
import * as Location from 'expo-location';

import Tachometer from './src/components/Tachometer';
import GlassCard from './src/components/GlassCard';
import { ENGINE_HTML } from './src/audio/engineHtml';
import { calcEngine, rpmColor } from './src/utils/engineSim';

const MAX_TEST_SPEED = 220;
const SPEED_PRESETS  = [0, 30, 60, 90, 120, 160, 200];

// ── Speed slider ──────────────────────────────────────────────────────────────
function SpeedSlider({
  value,
  onValueChange,
}: {
  value: number;
  onValueChange: (v: number) => void;
}) {
  const widthRef   = useRef(1);
  const callbackRef = useRef(onValueChange);
  callbackRef.current = onValueChange;

  const toSpeed = (x: number) =>
    Math.round(Math.max(0, Math.min(1, x / widthRef.current)) * MAX_TEST_SPEED);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => callbackRef.current(toSpeed(e.nativeEvent.locationX)),
      onPanResponderMove: (e) => callbackRef.current(toSpeed(e.nativeEvent.locationX)),
    }),
  ).current;

  const pct   = Math.min(1, value / MAX_TEST_SPEED);
  const color = value < 80 ? '#22ff88' : value < 140 ? '#ffaa00' : '#ff3300';

  return (
    <View
      {...panResponder.panHandlers}
      onLayout={(e) => { widthRef.current = e.nativeEvent.layout.width; }}
      style={sl.hit}
    >
      {/* Track */}
      <View style={sl.track}>
        <View style={[sl.fill, { width: `${pct * 100}%` as any, backgroundColor: color }]} />
      </View>
      {/* Thumb */}
      <View style={[sl.thumb, { left: `${pct * 100}%` as any, backgroundColor: color }]} />
    </View>
  );
}

const sl = StyleSheet.create({
  hit: {
    height: 44,
    justifyContent: 'center',
    position: 'relative',
  },
  track: {
    height: 5,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 3,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: 3,
  },
  thumb: {
    position: 'absolute',
    width: 26,
    height: 26,
    borderRadius: 13,
    top: '50%',
    marginTop: -13,
    marginLeft: -13,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.7,
    shadowRadius: 8,
    elevation: 4,
  },
});

// ── Throttle bar ──────────────────────────────────────────────────────────────
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

  return (
    <View style={tb.track}>
      <Animated.View
        style={[
          tb.fill,
          {
            width: anim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
            backgroundColor: anim.interpolate({
              inputRange: [0, 0.5, 1],
              outputRange: ['#22ff88', '#ffaa00', '#ff3300'],
            }),
          },
        ]}
      />
    </View>
  );
}

const tb = StyleSheet.create({
  track: { height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.08)', overflow: 'hidden', flex: 1 },
  fill:  { height: '100%', borderRadius: 3 },
});

// ── Pulsing status dot ────────────────────────────────────────────────────────
function PulseDot({ active }: { active: boolean }) {
  const anim = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    if (!active) { anim.setValue(0.4); return; }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: 1,   duration: 650, useNativeDriver: true, easing: Easing.inOut(Easing.sin) }),
        Animated.timing(anim, { toValue: 0.4, duration: 650, useNativeDriver: true, easing: Easing.inOut(Easing.sin) }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active]);

  return (
    <Animated.View
      style={{
        width: 8, height: 8, borderRadius: 4,
        opacity: anim,
        backgroundColor: active ? '#22ff88' : '#444',
      }}
    />
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [engineRunning, setEngineRunning] = useState(false);
  const [audioReady,    setAudioReady]    = useState(false);
  const [gpsSpeed,      setGpsSpeed]      = useState(0);
  const [rpm,           setRpm]           = useState(820);
  const [gear,          setGear]          = useState(1);
  const [throttle,      setThrottle]      = useState(0);
  const [testMode,      setTestMode]      = useState(false);
  const [testSpeed,     setTestSpeed]     = useState(0);

  const webViewRef  = useRef<WebView>(null);
  const prevSpeed   = useRef(0);
  const locationSub = useRef<Location.LocationSubscription | null>(null);

  const activeSpeed = testMode ? testSpeed : gpsSpeed;
  const speedInt    = Math.round(activeSpeed);
  const displayRpm  = Math.round(rpm / 10) * 10;
  const needleColor = rpmColor(rpm);

  // ── Audio bridge ──────────────────────────────────────────────────────────
  const sendAudio = useCallback((msg: object) => {
    webViewRef.current?.injectJavaScript(
      `(function(){window.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(${JSON.stringify(msg)})}))})();true;`,
    );
  }, []);

  // ── Engine update ─────────────────────────────────────────────────────────
  const applySpeed = useCallback((kmh: number) => {
    const { rpm: r, gear: g, throttle: t } = calcEngine(kmh, prevSpeed.current);
    prevSpeed.current = kmh;
    setRpm(r);
    setGear(g);
    setThrottle(t);
    sendAudio({ type: 'setRPM', rpm: r, throttle: t });
  }, [sendAudio]);

  // ── Test-mode slider changes ───────────────────────────────────────────────
  useEffect(() => {
    if (!testMode || !engineRunning) return;
    applySpeed(testSpeed);
  }, [testSpeed, testMode, engineRunning, applySpeed]);

  // ── GPS tracking ──────────────────────────────────────────────────────────
  const startGPS = useCallback(async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Plassering nødvendig', 'EV8 trenger GPS for å måle hastigheten din.', [{ text: 'OK' }]);
      return false;
    }
    locationSub.current = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 150, distanceInterval: 0 },
      (loc) => {
        const kmh = Math.max(0, (loc.coords.speed ?? 0) * 3.6);
        setGpsSpeed(kmh);
        if (!testMode) applySpeed(kmh);
      },
    );
    return true;
  }, [testMode, applySpeed]);

  const stopGPS = useCallback(() => {
    locationSub.current?.remove();
    locationSub.current = null;
  }, []);

  // ── Start / stop engine ───────────────────────────────────────────────────
  const startEngine = useCallback(async () => {
    if (!testMode) {
      const ok = await startGPS();
      if (!ok) return;
    }
    setEngineRunning(true);
    sendAudio({ type: 'start' });
    if (testMode) applySpeed(testSpeed);
  }, [testMode, startGPS, sendAudio, applySpeed, testSpeed]);

  const stopEngine = useCallback(() => {
    stopGPS();
    sendAudio({ type: 'stop' });
    setEngineRunning(false);
    setGpsSpeed(0);
    setRpm(820);
    setGear(1);
    setThrottle(0);
    prevSpeed.current = 0;
    if (testMode) setTestSpeed(0);
  }, [stopGPS, sendAudio, testMode]);

  const toggleEngine = useCallback(() => {
    if (engineRunning) stopEngine();
    else startEngine();
  }, [engineRunning, stopEngine, startEngine]);

  // Switch modes — stop engine first so GPS / speed resets cleanly
  const switchMode = useCallback((toTest: boolean) => {
    if (engineRunning) stopEngine();
    setTestMode(toTest);
    setTestSpeed(0);
    prevSpeed.current = 0;
  }, [engineRunning, stopEngine]);

  const onWebViewMessage = useCallback((e: { nativeEvent: { data: string } }) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      if (msg.type === 'ready') setAudioReady(true);
    } catch {}
  }, []);

  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" translucent backgroundColor="transparent" />

      <LinearGradient
        colors={['#05050e', '#09071a', '#070510', '#050310']}
        locations={[0, 0.35, 0.7, 1]}
        style={StyleSheet.absoluteFill}
      />

      {/* Hidden audio WebView */}
      <WebView
        ref={webViewRef}
        source={{ html: ENGINE_HTML }}
        style={s.hiddenView}
        onMessage={onWebViewMessage}
        javaScriptEnabled
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback
        originWhitelist={['*']}
      />

      <ScrollView
        style={s.scroll}
        contentContainerStyle={s.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Header ───────────────────────────────────────────────────────── */}
        <View style={s.header}>
          <View>
            <Text style={s.title}>EV8</Text>
            <Text style={s.subtitle}>V8 SOUND ENGINE</Text>
          </View>
          <View style={s.statusBadge}>
            <PulseDot active={engineRunning} />
            <Text style={[s.statusText, { color: engineRunning ? '#22ff88' : '#555' }]}>
              {engineRunning ? (testMode ? 'TEST' : 'LIVE') : 'OFF'}
            </Text>
          </View>
        </View>

        {/* ── Tachometer ───────────────────────────────────────────────────── */}
        <View style={s.tachoWrap}>
          <Tachometer rpm={rpm} />
        </View>

        {/* ── Mode selector ────────────────────────────────────────────────── */}
        <GlassCard style={s.modeCard}>
          <View style={s.modeRow}>
            <TouchableOpacity
              style={[s.modeBtn, !testMode && s.modeBtnActive]}
              onPress={() => switchMode(false)}
              activeOpacity={0.75}
            >
              {!testMode && <BlurView intensity={15} tint="dark" style={StyleSheet.absoluteFill} />}
              <Text style={[s.modeBtnText, !testMode && s.modeBtnTextActive]}>📡 GPS LIVE</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[s.modeBtn, testMode && s.modeBtnActive]}
              onPress={() => switchMode(true)}
              activeOpacity={0.75}
            >
              {testMode && <BlurView intensity={15} tint="dark" style={StyleSheet.absoluteFill} />}
              <Text style={[s.modeBtnText, testMode && s.modeBtnTextActive]}>🎛 TEST MODE</Text>
            </TouchableOpacity>
          </View>
        </GlassCard>

        {/* ── Test-mode slider ─────────────────────────────────────────────── */}
        {testMode && (
          <GlassCard style={s.sliderCard}>
            <View style={s.sliderHeader}>
              <Text style={s.sliderLabel}>SPEED</Text>
              <Text style={[s.sliderValue, { color: rpmColor(rpm) }]}>
                {testSpeed} <Text style={s.sliderUnit}>KM/H</Text>
              </Text>
            </View>

            <SpeedSlider
              value={testSpeed}
              onValueChange={engineRunning ? setTestSpeed : () => {}}
            />

            {/* Preset speed buttons */}
            <View style={s.presets}>
              {SPEED_PRESETS.map((sp) => (
                <TouchableOpacity
                  key={sp}
                  style={[s.preset, testSpeed === sp && s.presetActive, { borderColor: testSpeed === sp ? rpmColor(rpm) : 'rgba(255,255,255,0.12)' }]}
                  onPress={() => engineRunning && setTestSpeed(sp)}
                  activeOpacity={0.7}
                >
                  <Text style={[s.presetText, testSpeed === sp && { color: rpmColor(rpm) }]}>
                    {sp}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            {!engineRunning && (
              <Text style={s.sliderHint}>Start engine to use slider</Text>
            )}
          </GlassCard>
        )}

        {/* ── Speed / RPM display ───────────────────────────────────────────── */}
        <GlassCard style={s.readoutCard}>
          <View style={s.readoutRow}>
            <View style={s.readoutBlock}>
              <Text style={s.readoutBig}>{speedInt}</Text>
              <Text style={s.readoutUnit}>KM/H</Text>
            </View>
            <View style={s.readoutDivider} />
            <View style={s.readoutBlock}>
              <Text style={[s.readoutBig, { color: needleColor, fontSize: 40 }]}>
                {displayRpm}
              </Text>
              <Text style={s.readoutUnit}>RPM</Text>
            </View>
          </View>
        </GlassCard>

        {/* ── Gear + Throttle row ───────────────────────────────────────────── */}
        <View style={s.infoRow}>
          <GlassCard style={s.gearCard}>
            <Text style={s.gearLabel}>GEAR</Text>
            <Text style={s.gearNum}>{engineRunning ? gear : '—'}</Text>
          </GlassCard>

          <GlassCard style={s.throttleCard}>
            <View style={s.throttleTop}>
              <Text style={s.throttleLabel}>THROTTLE</Text>
              <Text style={s.throttlePct}>{Math.round(throttle * 100)}%</Text>
            </View>
            <ThrottleBar value={throttle} />
          </GlassCard>
        </View>

        {/* ── Engine button ─────────────────────────────────────────────────── */}
        <TouchableOpacity
          style={[s.engBtn, !audioReady && { opacity: 0.45 }]}
          onPress={toggleEngine}
          disabled={!audioReady}
          activeOpacity={0.8}
        >
          <LinearGradient
            colors={
              engineRunning
                ? ['rgba(255,50,20,0.3)', 'rgba(160,15,5,0.18)']
                : ['rgba(25,220,90,0.28)', 'rgba(8,150,55,0.16)']
            }
            style={s.engBtnGrad}
          >
            <BlurView intensity={14} tint="dark" style={StyleSheet.absoluteFill} />
            <View
              style={[
                s.engBtnBorder,
                { borderColor: engineRunning ? 'rgba(255,90,50,0.55)' : 'rgba(35,255,120,0.45)' },
              ]}
            />
            <Text
              style={[s.engBtnText, { color: engineRunning ? '#ff5533' : '#22ff88' }]}
            >
              {!audioReady ? 'LOADING…' : engineRunning ? '■  KILL ENGINE' : '▶  START ENGINE'}
            </Text>
          </LinearGradient>
        </TouchableOpacity>

        <Text style={s.hint}>
          {testMode
            ? 'Start engine, then drag the slider to simulate speed'
            : 'Start engine and drive — sound follows your real speed'}
        </Text>
      </ScrollView>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const PAD = 18;

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#05050e',
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight ?? 32) + 8 : 60,
    paddingHorizontal: PAD,
    paddingBottom: 32,
  },
  hiddenView: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
    top: -100,
  },

  // Header
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 4,
  },
  title: {
    fontSize: 30,
    fontWeight: '900',
    color: '#fff',
    letterSpacing: 7,
  },
  subtitle: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.3)',
    letterSpacing: 3,
    marginTop: 1,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    marginTop: 4,
  },
  statusText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 2,
  },

  // Tachometer
  tachoWrap: {
    alignItems: 'center',
    marginVertical: 4,
  },

  // Mode toggle
  modeCard: {
    marginBottom: 12,
    padding: 0,
  },
  modeRow: {
    flexDirection: 'row',
    gap: 0,
  },
  modeBtn: {
    flex: 1,
    paddingVertical: 12,
    alignItems: 'center',
    borderRadius: 18,
    overflow: 'hidden',
  },
  modeBtnActive: {
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  modeBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.35)',
    letterSpacing: 1,
  },
  modeBtnTextActive: {
    color: '#ffffff',
  },

  // Test slider
  sliderCard: {
    marginBottom: 12,
  },
  sliderHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: 8,
  },
  sliderLabel: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.4)',
    letterSpacing: 3,
  },
  sliderValue: {
    fontSize: 28,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  sliderUnit: {
    fontSize: 12,
    fontWeight: '400',
    color: 'rgba(255,255,255,0.4)',
  },
  presets: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 14,
    flexWrap: 'wrap',
  },
  preset: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
    borderWidth: 1,
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  presetActive: {
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  presetText: {
    fontSize: 12,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.4)',
  },
  sliderHint: {
    textAlign: 'center',
    fontSize: 11,
    color: 'rgba(255,255,255,0.2)',
    marginTop: 10,
  },

  // Readout
  readoutCard: {
    marginBottom: 12,
  },
  readoutRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-evenly',
  },
  readoutBlock: {
    alignItems: 'center',
    flex: 1,
  },
  readoutBig: {
    fontSize: 52,
    fontWeight: '900',
    color: '#fff',
    fontVariant: ['tabular-nums'],
    letterSpacing: -1,
  },
  readoutUnit: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.35)',
    letterSpacing: 3,
    marginTop: -4,
  },
  readoutDivider: {
    width: 1,
    height: 52,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },

  // Info row
  infoRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
  },
  gearCard: {
    width: 80,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gearLabel: {
    fontSize: 9,
    color: 'rgba(255,255,255,0.35)',
    letterSpacing: 2,
    marginBottom: 2,
  },
  gearNum: {
    fontSize: 38,
    fontWeight: '900',
    color: '#fff',
  },
  throttleCard: {
    flex: 1,
    justifyContent: 'center',
  },
  throttleTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  throttleLabel: {
    fontSize: 9,
    color: 'rgba(255,255,255,0.35)',
    letterSpacing: 2,
  },
  throttlePct: {
    fontSize: 9,
    color: 'rgba(255,255,255,0.6)',
    fontWeight: '700',
    letterSpacing: 1,
  },

  // Engine button
  engBtn: {
    borderRadius: 20,
    overflow: 'hidden',
    height: 72,
    marginBottom: 14,
  },
  engBtnGrad: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  engBtnBorder: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 20,
    borderWidth: 1.5,
  },
  engBtnText: {
    fontSize: 17,
    fontWeight: '900',
    letterSpacing: 3,
  },

  hint: {
    textAlign: 'center',
    fontSize: 11,
    color: 'rgba(255,255,255,0.18)',
    letterSpacing: 0.3,
  },
});
