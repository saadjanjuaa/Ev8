import React, {
  useCallback,
  useEffect,
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
// PanResponder created once; callback accessed via ref to avoid stale closure.
function SpeedSlider({
  value,
  onValueChange,
  disabled,
}: {
  value: number;
  onValueChange: (v: number) => void;
  disabled?: boolean;
}) {
  const widthRef    = useRef(1);
  const callbackRef = useRef(onValueChange);
  // Always point at the latest callback without recreating PanResponder
  callbackRef.current = onValueChange;

  const toSpeed = useCallback((x: number) =>
    Math.round(Math.max(0, Math.min(1, x / widthRef.current)) * MAX_TEST_SPEED),
  []);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder:  () => true,
      onPanResponderGrant: (e) => callbackRef.current(
        Math.round(Math.max(0, Math.min(1, e.nativeEvent.locationX / widthRef.current)) * MAX_TEST_SPEED),
      ),
      onPanResponderMove: (e) => callbackRef.current(
        Math.round(Math.max(0, Math.min(1, e.nativeEvent.locationX / widthRef.current)) * MAX_TEST_SPEED),
      ),
    }),
  ).current;

  const pct   = Math.min(1, value / MAX_TEST_SPEED);
  const color = value < 80 ? '#22ff88' : value < 140 ? '#ffaa00' : '#ff3300';

  return (
    <View
      {...(disabled ? {} : panResponder.panHandlers)}
      onLayout={(e) => { widthRef.current = e.nativeEvent.layout.width; }}
      style={[sl.hit, disabled && { opacity: 0.4 }]}
    >
      <View style={sl.track}>
        <View style={[sl.fill, { width: `${pct * 100}%` as any, backgroundColor: color }]} />
      </View>
      <View style={[sl.thumb, { left: `${pct * 100}%` as any, backgroundColor: color }]} />
    </View>
  );
}

const sl = StyleSheet.create({
  hit:   { height: 44, justifyContent: 'center', position: 'relative' },
  track: { height: 5, backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 3, overflow: 'hidden' },
  fill:  { height: '100%', borderRadius: 3 },
  thumb: {
    position: 'absolute', width: 26, height: 26, borderRadius: 13,
    top: '50%', marginTop: -13, marginLeft: -13,
    shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.7, shadowRadius: 8, elevation: 4,
  },
});

// ── Throttle bar ──────────────────────────────────────────────────────────────
function ThrottleBar({ value }: { value: number }) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(anim, { toValue: value, duration: 100, useNativeDriver: false,
      easing: Easing.out(Easing.quad) }).start();
  }, [value]);   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={tb.track}>
      <Animated.View style={[tb.fill, {
        width: anim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
        backgroundColor: anim.interpolate({ inputRange: [0, 0.5, 1], outputRange: ['#22ff88', '#ffaa00', '#ff3300'] }),
      }]} />
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
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(anim, { toValue: 1,   duration: 650, useNativeDriver: true, easing: Easing.inOut(Easing.sin) }),
      Animated.timing(anim, { toValue: 0.4, duration: 650, useNativeDriver: true, easing: Easing.inOut(Easing.sin) }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [active]);  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Animated.View style={{ width: 8, height: 8, borderRadius: 4, opacity: anim,
      backgroundColor: active ? '#22ff88' : '#444' }} />
  );
}

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [engineRunning, setEngineRunning] = useState(false);
  const [audioReady,    setAudioReady]    = useState(false);
  const [gpsSpeed,      setGpsSpeed]      = useState(0);
  const [rpm,           setRpm]           = useState(750);
  const [gear,          setGear]          = useState(1);
  const [throttle,      setThrottle]      = useState(0);
  const [testMode,      setTestMode]      = useState(false);
  const [testSpeed,     setTestSpeed]     = useState(0);

  const webViewRef     = useRef<WebView>(null);
  const prevSpeedRef   = useRef(0);
  const locationSub    = useRef<Location.LocationSubscription | null>(null);
  const engineRunRef   = useRef(false);
  const testModeRef    = useRef(false);

  // Keep refs in sync with state (no re-render on ref update)
  engineRunRef.current = engineRunning;
  testModeRef.current  = testMode;

  const activeSpeed = testMode ? testSpeed : gpsSpeed;
  const speedInt    = Math.round(activeSpeed);
  const displayRpm  = Math.round(rpm / 10) * 10;
  const needleColor = rpmColor(rpm);

  // ── Stable audio sender (empty deps → never recreated) ───────────────────
  const sendAudio = useCallback((msg: object) => {
    webViewRef.current?.injectJavaScript(
      `(function(){window.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(${JSON.stringify(msg)})}))})();true;`,
    );
  }, []);

  // ── applySpeed via ref pattern ───────────────────────────────────────────
  // Putting implementation in a ref means the stable `applySpeed` callback
  // always sees the latest sendAudio without listing it as a dep, which
  // eliminates the useEffect → setState → re-render → useEffect loop.
  const applySpeedImpl = useRef<(kmh: number) => void>(() => {});
  applySpeedImpl.current = (kmh: number) => {
    const { rpm: r, gear: g, throttle: t } = calcEngine(kmh, prevSpeedRef.current);
    prevSpeedRef.current = kmh;
    setRpm(r);
    setGear(g);
    setThrottle(t);
    sendAudio({ type: 'setRPM', rpm: r, throttle: t });
  };

  // Stable wrapper — safe to pass anywhere without causing dep-chain issues
  const applySpeed = useCallback((kmh: number) => {
    applySpeedImpl.current(kmh);
  }, []);

  // ── Test slider handler — called directly, NO useEffect ──────────────────
  const handleTestSpeed = useCallback((v: number) => {
    setTestSpeed(v);
    if (engineRunRef.current) applySpeed(v);
  }, [applySpeed]);

  // ── GPS tracking ──────────────────────────────────────────────────────────
  const startGPS = useCallback(async (): Promise<boolean> => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Plassering nødvendig', 'EV8 trenger GPS for å måle hastigheten.', [{ text: 'OK' }]);
      return false;
    }
    locationSub.current = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 150, distanceInterval: 0 },
      (loc) => {
        const kmh = Math.max(0, (loc.coords.speed ?? 0) * 3.6);
        setGpsSpeed(kmh);
        // Use ref so callback never goes stale without re-subscribing
        if (!testModeRef.current) applySpeed(kmh);
      },
    );
    return true;
  }, [applySpeed]);

  // ── Start engine ──────────────────────────────────────────────────────────
  const startEngine = useCallback(async () => {
    if (!testModeRef.current) {
      const ok = await startGPS();
      if (!ok) return;
    }
    setEngineRunning(true);
    sendAudio({ type: 'start' });
  }, [startGPS, sendAudio]);

  // ── Stop engine ───────────────────────────────────────────────────────────
  const stopEngine = useCallback(() => {
    locationSub.current?.remove();
    locationSub.current = null;
    sendAudio({ type: 'stop' });
    setEngineRunning(false);
    setGpsSpeed(0);
    setRpm(750);
    setGear(1);
    setThrottle(0);
    setTestSpeed(0);
    prevSpeedRef.current = 0;
  }, [sendAudio]);

  const toggleEngine = useCallback(() => {
    if (engineRunRef.current) stopEngine();
    else startEngine();
  }, [stopEngine, startEngine]);

  // ── Mode switch ───────────────────────────────────────────────────────────
  const switchMode = useCallback((toTest: boolean) => {
    if (engineRunRef.current) stopEngine();
    setTestMode(toTest);
    setTestSpeed(0);
    prevSpeedRef.current = 0;
  }, [stopEngine]);

  const onWebViewMessage = useCallback((e: { nativeEvent: { data: string } }) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      if (msg.type === 'ready') setAudioReady(true);
    } catch {}
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" translucent backgroundColor="transparent" />

      <LinearGradient
        colors={['#05050e', '#09071a', '#070510', '#050310']}
        locations={[0, 0.35, 0.7, 1]}
        style={StyleSheet.absoluteFill}
      />

      {/* Hidden audio engine */}
      <WebView
        ref={webViewRef}
        source={{ html: ENGINE_HTML }}
        style={s.hidden}
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
      >
        {/* Header */}
        <View style={s.header}>
          <View>
            <Text style={s.title}>EV8</Text>
            <Text style={s.subtitle}>GT-R R35 SOUND ENGINE</Text>
          </View>
          <View style={s.badge}>
            <PulseDot active={engineRunning} />
            <Text style={[s.badgeText, { color: engineRunning ? '#22ff88' : '#555' }]}>
              {engineRunning ? (testMode ? 'TEST' : 'LIVE') : 'OFF'}
            </Text>
          </View>
        </View>

        {/* Tachometer */}
        <View style={s.tachoWrap}>
          <Tachometer rpm={rpm} />
        </View>

        {/* Mode selector */}
        <GlassCard style={s.modeCard}>
          <View style={s.modeRow}>
            {(['GPS LIVE', 'TEST MODE'] as const).map((label, i) => {
              const active = testMode === (i === 1);
              return (
                <TouchableOpacity
                  key={label}
                  style={[s.modeBtn, active && s.modeBtnOn]}
                  onPress={() => switchMode(i === 1)}
                  activeOpacity={0.75}
                >
                  {active && <BlurView intensity={15} tint="dark" style={StyleSheet.absoluteFill} />}
                  <Text style={[s.modeTxt, active && s.modeTxtOn]}>
                    {i === 0 ? '📡 ' : '🎛 '}{label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </GlassCard>

        {/* Test slider — only visible in test mode */}
        {testMode && (
          <GlassCard style={s.sliderCard}>
            <View style={s.sliderTop}>
              <Text style={s.sliderLabel}>SPEED</Text>
              <Text style={[s.sliderVal, { color: needleColor }]}>
                {testSpeed}
                <Text style={s.sliderUnit}> KM/H</Text>
              </Text>
            </View>

            <SpeedSlider
              value={testSpeed}
              onValueChange={handleTestSpeed}
              disabled={!engineRunning}
            />

            {/* Preset buttons */}
            <View style={s.presets}>
              {SPEED_PRESETS.map((sp) => (
                <TouchableOpacity
                  key={sp}
                  style={[
                    s.preset,
                    { borderColor: testSpeed === sp ? needleColor : 'rgba(255,255,255,0.12)' },
                    testSpeed === sp && s.presetOn,
                  ]}
                  onPress={() => engineRunning && handleTestSpeed(sp)}
                  activeOpacity={0.7}
                >
                  <Text style={[s.presetTxt, testSpeed === sp && { color: needleColor }]}>
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

        {/* Speed / RPM readout */}
        <GlassCard style={s.readCard}>
          <View style={s.readRow}>
            <View style={s.readBlock}>
              <Text style={s.readBig}>{speedInt}</Text>
              <Text style={s.readUnit}>KM/H</Text>
            </View>
            <View style={s.readDiv} />
            <View style={s.readBlock}>
              <Text style={[s.readBig, { color: needleColor, fontSize: 40 }]}>
                {displayRpm}
              </Text>
              <Text style={s.readUnit}>RPM</Text>
            </View>
          </View>
        </GlassCard>

        {/* Gear + throttle */}
        <View style={s.infoRow}>
          <GlassCard style={s.gearCard}>
            <Text style={s.gearLbl}>GEAR</Text>
            <Text style={s.gearNum}>{engineRunning ? gear : '—'}</Text>
          </GlassCard>
          <GlassCard style={s.thrCard}>
            <View style={s.thrTop}>
              <Text style={s.thrLbl}>THROTTLE</Text>
              <Text style={s.thrPct}>{Math.round(throttle * 100)}%</Text>
            </View>
            <ThrottleBar value={throttle} />
          </GlassCard>
        </View>

        {/* Engine button */}
        <TouchableOpacity
          style={[s.engBtn, !audioReady && { opacity: 0.4 }]}
          onPress={toggleEngine}
          disabled={!audioReady}
          activeOpacity={0.8}
        >
          <LinearGradient
            colors={engineRunning
              ? ['rgba(255,50,20,0.3)', 'rgba(160,15,5,0.18)']
              : ['rgba(25,220,90,0.28)', 'rgba(8,150,55,0.16)']}
            style={s.engGrad}
          >
            <BlurView intensity={14} tint="dark" style={StyleSheet.absoluteFill} />
            <View style={[s.engBorder, {
              borderColor: engineRunning ? 'rgba(255,90,50,0.55)' : 'rgba(35,255,120,0.45)',
            }]} />
            <Text style={[s.engTxt, { color: engineRunning ? '#ff5533' : '#22ff88' }]}>
              {!audioReady ? 'LOADING…' : engineRunning ? '■  KILL ENGINE' : '▶  START ENGINE'}
            </Text>
          </LinearGradient>
        </TouchableOpacity>

        <Text style={s.hint}>
          {testMode
            ? 'Start engine · drag slider or tap preset speed'
            : 'Start engine · drive to hear the GT-R respond'}
        </Text>
      </ScrollView>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const PAD = 18;

const s = StyleSheet.create({
  root:    { flex: 1, backgroundColor: '#05050e' },
  scroll:  { flex: 1 },
  content: {
    paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight ?? 32) + 8 : 60,
    paddingHorizontal: PAD,
    paddingBottom: 32,
  },
  hidden: { position: 'absolute', width: 1, height: 1, opacity: 0, top: -100 },

  // Header
  header:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 },
  title:     { fontSize: 30, fontWeight: '900', color: '#fff', letterSpacing: 7 },
  subtitle:  { fontSize: 9, color: 'rgba(255,255,255,0.3)', letterSpacing: 2.5, marginTop: 1 },
  badge:     { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(255,255,255,0.05)',
               borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6,
               borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', marginTop: 4 },
  badgeText: { fontSize: 11, fontWeight: '700', letterSpacing: 2 },

  // Tachometer
  tachoWrap: { alignItems: 'center', marginVertical: 2 },

  // Mode toggle
  modeCard: { marginBottom: 12, padding: 0 },
  modeRow:  { flexDirection: 'row' },
  modeBtn:  { flex: 1, paddingVertical: 12, alignItems: 'center', borderRadius: 18, overflow: 'hidden' },
  modeBtnOn:{ backgroundColor: 'rgba(255,255,255,0.06)' },
  modeTxt:  { fontSize: 12, fontWeight: '600', color: 'rgba(255,255,255,0.3)', letterSpacing: 1 },
  modeTxtOn:{ color: '#fff' },

  // Slider
  sliderCard: { marginBottom: 12 },
  sliderTop:  { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 },
  sliderLabel:{ fontSize: 10, color: 'rgba(255,255,255,0.35)', letterSpacing: 3 },
  sliderVal:  { fontSize: 28, fontWeight: '900', fontVariant: ['tabular-nums'] },
  sliderUnit: { fontSize: 12, fontWeight: '400', color: 'rgba(255,255,255,0.4)' },
  presets:    { flexDirection: 'row', gap: 6, marginTop: 14, flexWrap: 'wrap' },
  preset:     { paddingHorizontal: 11, paddingVertical: 6, borderRadius: 12,
                borderWidth: 1, backgroundColor: 'rgba(255,255,255,0.03)' },
  presetOn:   { backgroundColor: 'rgba(255,255,255,0.08)' },
  presetTxt:  { fontSize: 12, fontWeight: '700', color: 'rgba(255,255,255,0.35)' },
  sliderHint: { textAlign: 'center', fontSize: 11, color: 'rgba(255,255,255,0.2)', marginTop: 10 },

  // Readout
  readCard:  { marginBottom: 12 },
  readRow:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-evenly' },
  readBlock: { alignItems: 'center', flex: 1 },
  readBig:   { fontSize: 52, fontWeight: '900', color: '#fff', fontVariant: ['tabular-nums'], letterSpacing: -1 },
  readUnit:  { fontSize: 11, color: 'rgba(255,255,255,0.35)', letterSpacing: 3, marginTop: -4 },
  readDiv:   { width: 1, height: 52, backgroundColor: 'rgba(255,255,255,0.08)' },

  // Info row
  infoRow:  { flexDirection: 'row', gap: 12, marginBottom: 16 },
  gearCard: { width: 80, alignItems: 'center', justifyContent: 'center' },
  gearLbl:  { fontSize: 9, color: 'rgba(255,255,255,0.35)', letterSpacing: 2, marginBottom: 2 },
  gearNum:  { fontSize: 38, fontWeight: '900', color: '#fff' },
  thrCard:  { flex: 1, justifyContent: 'center' },
  thrTop:   { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  thrLbl:   { fontSize: 9, color: 'rgba(255,255,255,0.35)', letterSpacing: 2 },
  thrPct:   { fontSize: 9, color: 'rgba(255,255,255,0.6)', fontWeight: '700', letterSpacing: 1 },

  // Engine button
  engBtn:    { borderRadius: 20, overflow: 'hidden', height: 72, marginBottom: 14 },
  engGrad:   { flex: 1, alignItems: 'center', justifyContent: 'center' },
  engBorder: { ...StyleSheet.absoluteFillObject, borderRadius: 20, borderWidth: 1.5 },
  engTxt:    { fontSize: 17, fontWeight: '900', letterSpacing: 3 },

  hint: { textAlign: 'center', fontSize: 11, color: 'rgba(255,255,255,0.18)', letterSpacing: 0.3 },
});
