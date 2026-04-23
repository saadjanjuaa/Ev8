import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated, Easing, Platform, ScrollView, StatusBar,
  StyleSheet, Text, TouchableOpacity, View, Alert,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import WebView from 'react-native-webview';
import * as Location from 'expo-location';

import Tachometer from './src/components/Tachometer';
import GlassCard from './src/components/GlassCard';
import { ENGINE_HTML } from './src/audio/engineHtml';
import { calcEngine, rpmColor } from './src/utils/engineSim';

const MAX_SPD   = 220;
const PRESETS   = [0, 30, 60, 90, 120, 160, 200];

/* ─────────────────────────────────────────────────────────────────────────────
   SpeedSlider — uses View responder system instead of PanResponder
   so it doesn't conflict with ScrollView gesture handling.
   The ref-based callback means the PanResponder closure is never stale.
───────────────────────────────────────────────────────────────────────────── */
function SpeedSlider({ value, onChange, disabled }: {
  value: number; onChange: (v: number) => void; disabled: boolean;
}) {
  const W   = useRef(1);
  const cb  = useRef(onChange);
  cb.current = onChange;         // always fresh — no re-render on change
  const prev = useRef(-1);

  const handle = useRef((x: number) => {
    const spd = Math.round(Math.max(0, Math.min(1, x / W.current)) * MAX_SPD);
    if (spd === prev.current) return; // skip if unchanged (reduces re-renders)
    prev.current = spd;
    cb.current(spd);
  }).current;

  const pct   = Math.min(1, value / MAX_SPD);
  const color = value < 80 ? '#22ff88' : value < 140 ? '#ffaa00' : '#ff3300';

  return (
    <View
      onLayout={e => { W.current = e.nativeEvent.layout.width; }}
      /* View responder — has higher priority than ScrollView's gesture */
      onStartShouldSetResponder={() => !disabled}
      onMoveShouldSetResponder={() => !disabled}
      onStartShouldSetResponderCapture={() => !disabled}
      onMoveShouldSetResponderCapture={() => !disabled}
      onResponderGrant={e => handle(e.nativeEvent.locationX)}
      onResponderMove={e => handle(e.nativeEvent.locationX)}
      style={[sl.wrap, disabled && { opacity: 0.4 }]}
    >
      <View style={sl.track}>
        <View style={[sl.fill, { width: `${pct * 100}%` as any, backgroundColor: color }]} />
      </View>
      <View style={[sl.thumb, { left: `${pct * 100}%` as any, backgroundColor: color }]} />
    </View>
  );
}

const sl = StyleSheet.create({
  wrap:  { height: 44, justifyContent: 'center', position: 'relative' },
  track: { height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.08)', overflow: 'hidden' },
  fill:  { height: '100%', borderRadius: 3 },
  thumb: {
    position: 'absolute', width: 26, height: 26, borderRadius: 13,
    top: '50%', marginTop: -13, marginLeft: -13,
    shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.75, shadowRadius: 8, elevation: 4,
  },
});

/* ─── Throttle bar ──────────────────────────────────────────────────────────── */
function ThrottleBar({ value }: { value: number }) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(anim, { toValue: value, duration: 100, useNativeDriver: false,
      easing: Easing.out(Easing.quad) }).start();
  }, [value]); // eslint-disable-line

  return (
    <View style={tb.track}>
      <Animated.View style={[tb.fill, {
        width: anim.interpolate({ inputRange: [0,1], outputRange: ['0%','100%'] }),
        backgroundColor: anim.interpolate({ inputRange: [0,0.5,1],
          outputRange: ['#22ff88','#ffaa00','#ff3300'] }),
      }]} />
    </View>
  );
}
const tb = StyleSheet.create({
  track: { height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.08)', overflow: 'hidden', flex: 1 },
  fill:  { height: '100%', borderRadius: 3 },
});

/* ─── Pulsing dot ───────────────────────────────────────────────────────────── */
function PulseDot({ on }: { on: boolean }) {
  const a = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    if (!on) { a.setValue(0.4); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(a, { toValue:1,   duration:650, useNativeDriver:true, easing:Easing.inOut(Easing.sin) }),
      Animated.timing(a, { toValue:0.4, duration:650, useNativeDriver:true, easing:Easing.inOut(Easing.sin) }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [on]); // eslint-disable-line

  return <Animated.View style={{ width:8, height:8, borderRadius:4, opacity:a,
    backgroundColor: on ? '#22ff88' : '#444' }} />;
}

/* ─────────────────────────────────────────────────────────────────────────────
   Main App
───────────────────────────────────────────────────────────────────────────── */
export default function App() {
  const [running,   setRunning]   = useState(false);
  const [ready,     setReady]     = useState(false);
  const [gpsSpd,    setGpsSpd]    = useState(0);
  const [rpm,       setRpm]       = useState(720);
  const [gear,      setGear]      = useState(1);
  const [throttle,  setThrottle]  = useState(0);
  const [testMode,  setTestMode]  = useState(false);
  const [testSpd,   setTestSpd]   = useState(0);

  const wvRef      = useRef<WebView>(null);
  const prevSpd    = useRef(0);
  const locSub     = useRef<Location.LocationSubscription | null>(null);
  const runningRef = useRef(false);
  const testRef    = useRef(false);
  runningRef.current = running;
  testRef.current    = testMode;

  const activeSpd   = testMode ? testSpd : gpsSpd;
  const needleColor = rpmColor(rpm);

  /* ── Stable audio send ─────────────────────────────────────────────────── */
  const sendAudio = useCallback((msg: object) => {
    wvRef.current?.injectJavaScript(
      `(function(){window.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(${JSON.stringify(msg)})}))})();true;`
    );
  }, []);

  /* ── applySpeed via ref (zero dep-chain → zero loop risk) ─────────────── */
  const applyImpl = useRef<(k: number) => void>(() => {});
  applyImpl.current = (kmh: number) => {
    const { rpm: r, gear: g, throttle: t } = calcEngine(kmh, prevSpd.current);
    prevSpd.current = kmh;
    setRpm(r); setGear(g); setThrottle(t);
    sendAudio({ type: 'setRPM', rpm: r, throttle: t });
  };
  const applySpeed = useCallback((k: number) => applyImpl.current(k), []);

  /* ── Test slider handler ────────────────────────────────────────────────── */
  const onSliderChange = useCallback((v: number) => {
    setTestSpd(v);
    if (runningRef.current) applySpeed(v);
  }, [applySpeed]);

  /* ── GPS ────────────────────────────────────────────────────────────────── */
  const startGPS = useCallback(async (): Promise<boolean> => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Plassering', 'EV8 trenger GPS for å måle hastigheten.', [{ text:'OK' }]);
      return false;
    }
    locSub.current = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 150, distanceInterval: 0 },
      loc => {
        const kmh = Math.max(0, (loc.coords.speed ?? 0) * 3.6);
        setGpsSpd(kmh);
        if (!testRef.current) applySpeed(kmh);
      },
    );
    return true;
  }, [applySpeed]);

  const stopGPS = useCallback(() => {
    locSub.current?.remove(); locSub.current = null;
  }, []);

  /* ── Engine start/stop ──────────────────────────────────────────────────── */
  const startEngine = useCallback(async () => {
    if (!testRef.current) {
      if (!(await startGPS())) return;
    }
    setRunning(true);
    sendAudio({ type: 'start' });
    if (testRef.current) applySpeed(testSpd);
  }, [startGPS, sendAudio, applySpeed, testSpd]);

  const stopEngine = useCallback(() => {
    stopGPS();
    sendAudio({ type: 'stop' });
    setRunning(false); setGpsSpd(0); setRpm(720);
    setGear(1); setThrottle(0); setTestSpd(0);
    prevSpd.current = 0;
  }, [stopGPS, sendAudio]);

  const toggle = useCallback(() => {
    if (runningRef.current) stopEngine(); else startEngine();
  }, [stopEngine, startEngine]);

  const switchMode = useCallback((toTest: boolean) => {
    if (runningRef.current) stopEngine();
    setTestMode(toTest); setTestSpd(0); prevSpd.current = 0;
  }, [stopEngine]);

  /* ── WebView handlers ───────────────────────────────────────────────────── */
  const onMsg = useCallback((e: { nativeEvent: { data: string } }) => {
    try {
      const m = JSON.parse(e.nativeEvent.data);
      if (m.type === 'ready') setReady(true);
    } catch {}
  }, []);

  // Reset state on every WebView load/reload
  const onWebViewLoad = useCallback(() => {
    setReady(false);
    if (runningRef.current) stopEngine();
  }, [stopEngine]);

  /* ─────────────────────────────────────────────────────────────────────────
     Render
  ───────────────────────────────────────────────────────────────────────── */
  return (
    <View style={s.root}>
      <StatusBar barStyle="light-content" translucent backgroundColor="transparent" />
      <LinearGradient
        colors={['#05050e','#09071a','#070510','#050310']}
        locations={[0,0.35,0.7,1]}
        style={StyleSheet.absoluteFill}
      />

      {/* WebView — kept on-screen with minimal visible area for iOS audio reliability */}
      <WebView
        ref={wvRef}
        source={{ html: ENGINE_HTML }}
        style={s.wv}
        onMessage={onMsg}
        onLoad={onWebViewLoad}
        javaScriptEnabled
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback
        originWhitelist={['*']}
      />

      <ScrollView style={s.scroll} contentContainerStyle={s.content}
        showsVerticalScrollIndicator={false}>

        {/* Header */}
        <View style={s.hdr}>
          <View>
            <Text style={s.title}>EV8</Text>
            <Text style={s.sub}>GT-R R35 SOUND ENGINE</Text>
          </View>
          <View style={s.badge}>
            <PulseDot on={running} />
            <Text style={[s.badgeTxt, { color: running ? '#22ff88' : '#555' }]}>
              {running ? (testMode ? 'TEST' : 'LIVE') : 'OFF'}
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
            {[{ label:'📡 GPS LIVE', test:false }, { label:'🎛 TEST MODE', test:true }].map(m => (
              <TouchableOpacity key={m.label} style={[s.modeBtn, testMode===m.test && s.modeBtnOn]}
                onPress={() => switchMode(m.test)} activeOpacity={0.75}>
                {testMode===m.test && <BlurView intensity={15} tint="dark" style={StyleSheet.absoluteFill}/>}
                <Text style={[s.modeTxt, testMode===m.test && s.modeTxtOn]}>{m.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </GlassCard>

        {/* Test slider */}
        {testMode && (
          <GlassCard style={s.sliderCard}>
            <View style={s.sliderTop}>
              <Text style={s.sliderLbl}>SPEED</Text>
              <Text style={[s.sliderVal, { color: needleColor }]}>
                {testSpd}<Text style={s.sliderUnit}> KM/H</Text>
              </Text>
            </View>

            <SpeedSlider value={testSpd} onChange={onSliderChange} disabled={!running} />

            <View style={s.presets}>
              {PRESETS.map(sp => (
                <TouchableOpacity key={sp}
                  style={[s.preset, { borderColor: testSpd===sp ? needleColor : 'rgba(255,255,255,0.12)' },
                    testSpd===sp && s.presetOn]}
                  onPress={() => running && onSliderChange(sp)} activeOpacity={0.7}>
                  <Text style={[s.presetTxt, testSpd===sp && { color: needleColor }]}>{sp}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {!running && <Text style={s.sliderHint}>Start engine to use slider</Text>}
          </GlassCard>
        )}

        {/* Speed / RPM readout */}
        <GlassCard style={s.readCard}>
          <View style={s.readRow}>
            <View style={s.readBlk}>
              <Text style={s.readBig}>{Math.round(activeSpd)}</Text>
              <Text style={s.readUnit}>KM/H</Text>
            </View>
            <View style={s.readDiv} />
            <View style={s.readBlk}>
              <Text style={[s.readBig, { color: needleColor, fontSize: 40 }]}>
                {Math.round(rpm / 10) * 10}
              </Text>
              <Text style={s.readUnit}>RPM</Text>
            </View>
          </View>
        </GlassCard>

        {/* Gear + throttle */}
        <View style={s.infoRow}>
          <GlassCard style={s.gearCard}>
            <Text style={s.gearLbl}>GEAR</Text>
            <Text style={s.gearNum}>{running ? gear : '—'}</Text>
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
        <TouchableOpacity style={[s.engBtn, !ready && { opacity: 0.4 }]}
          onPress={toggle} disabled={!ready} activeOpacity={0.8}>
          <LinearGradient
            colors={running
              ? ['rgba(255,50,20,0.3)','rgba(160,15,5,0.18)']
              : ['rgba(25,220,90,0.28)','rgba(8,150,55,0.16)']}
            style={s.engGrad}>
            <BlurView intensity={14} tint="dark" style={StyleSheet.absoluteFill}/>
            <View style={[s.engBorder, {
              borderColor: running ? 'rgba(255,90,50,0.55)' : 'rgba(35,255,120,0.45)' }]}/>
            <Text style={[s.engTxt, { color: running ? '#ff5533' : '#22ff88' }]}>
              {!ready ? 'LOADING…' : running ? '■  KILL ENGINE' : '▶  START ENGINE'}
            </Text>
          </LinearGradient>
        </TouchableOpacity>

        <Text style={s.hint}>
          {testMode
            ? 'Start engine · drag slider or tap a preset speed'
            : 'Start engine · drive and hear the GT-R respond'}
        </Text>
      </ScrollView>
    </View>
  );
}

/* ─── Styles ─────────────────────────────────────────────────────────────────── */
const PAD = 18;
const s = StyleSheet.create({
  root:    { flex:1, backgroundColor:'#05050e' },
  scroll:  { flex:1 },
  content: {
    paddingTop: Platform.OS==='android' ? (StatusBar.currentHeight??32)+8 : 60,
    paddingHorizontal: PAD, paddingBottom: 32,
  },
  // WebView: 1×1px, on-screen, nearly transparent — iOS needs it visible for audio
  wv: { position:'absolute', width:1, height:1, top:0, left:0, opacity:0.01 },

  hdr:      { flexDirection:'row', justifyContent:'space-between', alignItems:'flex-start', marginBottom:4 },
  title:    { fontSize:30, fontWeight:'900', color:'#fff', letterSpacing:7 },
  sub:      { fontSize:9, color:'rgba(255,255,255,0.3)', letterSpacing:2.5, marginTop:1 },
  badge:    { flexDirection:'row', alignItems:'center', gap:6,
              backgroundColor:'rgba(255,255,255,0.05)', borderRadius:20,
              paddingHorizontal:12, paddingVertical:6,
              borderWidth:1, borderColor:'rgba(255,255,255,0.08)', marginTop:4 },
  badgeTxt: { fontSize:11, fontWeight:'700', letterSpacing:2 },

  tachoWrap: { alignItems:'center', marginVertical:2 },

  modeCard:  { marginBottom:12, padding:0 },
  modeRow:   { flexDirection:'row' },
  modeBtn:   { flex:1, paddingVertical:12, alignItems:'center', borderRadius:18, overflow:'hidden' },
  modeBtnOn: { backgroundColor:'rgba(255,255,255,0.06)' },
  modeTxt:   { fontSize:12, fontWeight:'600', color:'rgba(255,255,255,0.3)', letterSpacing:1 },
  modeTxtOn: { color:'#fff' },

  sliderCard: { marginBottom:12 },
  sliderTop:  { flexDirection:'row', justifyContent:'space-between', alignItems:'baseline', marginBottom:8 },
  sliderLbl:  { fontSize:10, color:'rgba(255,255,255,0.35)', letterSpacing:3 },
  sliderVal:  { fontSize:28, fontWeight:'900', fontVariant:['tabular-nums'] },
  sliderUnit: { fontSize:12, fontWeight:'400', color:'rgba(255,255,255,0.4)' },
  presets:    { flexDirection:'row', gap:6, marginTop:14, flexWrap:'wrap' },
  preset:     { paddingHorizontal:11, paddingVertical:6, borderRadius:12,
                borderWidth:1, backgroundColor:'rgba(255,255,255,0.03)' },
  presetOn:   { backgroundColor:'rgba(255,255,255,0.08)' },
  presetTxt:  { fontSize:12, fontWeight:'700', color:'rgba(255,255,255,0.35)' },
  sliderHint: { textAlign:'center', fontSize:11, color:'rgba(255,255,255,0.2)', marginTop:10 },

  readCard: { marginBottom:12 },
  readRow:  { flexDirection:'row', alignItems:'center', justifyContent:'space-evenly' },
  readBlk:  { alignItems:'center', flex:1 },
  readBig:  { fontSize:52, fontWeight:'900', color:'#fff', fontVariant:['tabular-nums'], letterSpacing:-1 },
  readUnit: { fontSize:11, color:'rgba(255,255,255,0.35)', letterSpacing:3, marginTop:-4 },
  readDiv:  { width:1, height:52, backgroundColor:'rgba(255,255,255,0.08)' },

  infoRow:  { flexDirection:'row', gap:12, marginBottom:16 },
  gearCard: { width:80, alignItems:'center', justifyContent:'center' },
  gearLbl:  { fontSize:9, color:'rgba(255,255,255,0.35)', letterSpacing:2, marginBottom:2 },
  gearNum:  { fontSize:38, fontWeight:'900', color:'#fff' },
  thrCard:  { flex:1, justifyContent:'center' },
  thrTop:   { flexDirection:'row', justifyContent:'space-between', marginBottom:10 },
  thrLbl:   { fontSize:9, color:'rgba(255,255,255,0.35)', letterSpacing:2 },
  thrPct:   { fontSize:9, color:'rgba(255,255,255,0.6)', fontWeight:'700', letterSpacing:1 },

  engBtn:    { borderRadius:20, overflow:'hidden', height:72, marginBottom:14 },
  engGrad:   { flex:1, alignItems:'center', justifyContent:'center' },
  engBorder: { ...StyleSheet.absoluteFillObject, borderRadius:20, borderWidth:1.5 },
  engTxt:    { fontSize:17, fontWeight:'900', letterSpacing:3 },

  hint: { textAlign:'center', fontSize:11, color:'rgba(255,255,255,0.18)', letterSpacing:0.3 },
});
