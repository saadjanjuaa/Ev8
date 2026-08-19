import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  LayoutChangeEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import Slider from '@react-native-community/slider';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { setAudioModeAsync } from 'expo-audio';

import { EngineAudio, EngineHandle, EngineState } from '../audio/EngineAudio';
import { DEFAULT_PROFILE_ID, PROFILES, profileById } from '../audio/profiles';
import { useVehicleSpeed } from '../sensors/useVehicleSpeed';
import { GlassCard } from '../ui/GlassCard';
import { TACH_SEGMENTS, TachRing } from '../ui/TachRing';
import { ChipRow, Meter, Pill, PowerButton, SecondaryButton, Toggle } from '../ui/controls';
import { newTestRun, stepTestRun, TEST_LABELS, TestRun } from '../audio/testDrive';
import { T, numeric, withAlpha } from '../ui/theme';

const FEED_HZ = 25;      // hvor ofte fart sendes til lydmotoren
const UI_HZ = 16;        // hvor ofte skjermen oppdateres

interface Disp {
  rpm: number;
  gear: number;
  kmh: number;
  throttle: number;
  lit: number;
  state: number;
  shift: number;
  limiter: boolean;
}

function SensorItem({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.sensorItem}>
      <Text style={styles.sensorLabel}>{label}</Text>
      <Text style={[styles.sensorValue, numeric]}>{value}</Text>
    </View>
  );
}

const ZERO: Disp = { rpm: 0, gear: 1, kmh: 0, throttle: 0, lit: 0, state: 0, shift: 0, limiter: false };

export default function DriveScreen() {
  const insets = useSafeAreaInsets();
  const engine = useRef<EngineHandle>(null);

  const [running, setRunning] = useState(false);
  const [profileId, setProfileId] = useState(DEFAULT_PROFILE_ID);
  const [volume, setVolume] = useState(0.85);
  /* lydbilde: 0 = ren utvendig mikrofon, 1 = ren kupemikrofon */
  const [cabin, setCabin] = useState(0.55);
  const [demo, setDemo] = useState(false);
  const [demoKmh, setDemoKmh] = useState(0);
  /* Gåtest: farten fra GPS ganges opp, så du kan gå eller sykle og høre
     det som kjøring. Hele kjeden testes — GPS, bevegelsessensor, fusjon,
     girkasse, lyd — uten at du må ut på veien. */
  const [walkScale, setWalkScale] = useState(1);
  const [showSensors, setShowSensors] = useState(false);
  const [sens, setSens] = useState({
    speed: 0, gpsSpeed: 0, accel: 0, accuracy: 0, headingLock: 0, fixAge: 0,
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [audioMode, setAudioMode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [disp, setDisp] = useState<Disp>(ZERO);
  const [tachSize, setTachSize] = useState(280);

  const profile = useMemo(() => profileById(profileId), [profileId]);
  const { sample, status } = useVehicleSpeed(running && !demo);

  const [testLabel, setTestLabel] = useState<string | null>(null);
  const test = useRef<TestRun | null>(null);
  const lastOverride = useRef(-1);
  const latest = useRef<EngineState | null>(null);
  const demoRef = useRef({ kmh: 0, prev: 0, t: Date.now() });
  demoRef.current.kmh = demoKmh;
  /* matingen kjører i et intervall som ikke ser ny state, så den leses av en ref */
  const walkRef = useRef(1);
  walkRef.current = walkScale;

  /* ── lydsesjon: spill i stillemodus, i bakgrunnen, og ut på bilstereoen ──

     interruptionMode er det som avgjør om lyden i det hele tatt når fram.
     'mixWithOthers' ber IKKE om lydfokus: appen legger seg oppå en strøm
     noen andre holder åpen. Er det ingen slik strøm, blir det stumt — og
     det var derfor motoren bare hørtes når Spotify spilte samtidig.

     'doNotMix' tar fokus. Da åpner telefonen strømmen mot bilstereoen for
     appen selv, og lyden er der uten at noe annet må spille. Prisen er at
     musikk pauses mens motoren går, men motoren spiller sammenhengende —
     den skal eie lyden mens den er på. */
  const armAudioSession = useCallback(
    () =>
      setAudioModeAsync({
        playsInSilentMode: true,
        shouldPlayInBackground: true,
        interruptionMode: 'doNotMix',
        allowsRecording: false,
      }).catch(() => { }),
    [],
  );
  useEffect(() => { armAudioSession(); }, [armAudioSession]);

  /* ── profil / volum / kupé sendes ned til DSP-en ── */
  useEffect(() => {
    engine.current?.setProfile({ ...profile.dsp, volume, cabin });
  }, [profile, volume, cabin]);

  /* ── iOS suspenderer lyden når appen legges bort: vekk den igjen ── */
  useEffect(() => {
    if (!running) return;
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') engine.current?.resume();
    });
    return () => sub.remove();
  }, [running]);

  /* ── hold skjermen våken mens motoren går ── */
  useEffect(() => {
    if (!running) return;
    activateKeepAwakeAsync('ev8').catch(() => { });
    return () => {
      deactivateKeepAwake('ev8').catch(() => { });
    };
  }, [running]);

  /* ── mating: fart + akselerasjon inn i lydmotoren ── */
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      const t = test.current;
      if (t) {
        const engineReady = latest.current?.state === 2;
        const tick = stepTestRun(t, 1 / FEED_HZ, engineReady);
        engine.current?.setInput(tick.speed, tick.accel);
        /* gasspådraget overstyres bare under revs-fasen */
        if (tick.throttle !== lastOverride.current) {
          lastOverride.current = tick.throttle;
          engine.current?.setThrottle(tick.throttle);
        }
        setTestLabel((p) => {
          const next = TEST_LABELS[t.phase];
          return p === next ? p : next;
        });
        if (tick.done) {
          test.current = null;
          lastOverride.current = -1;
          engine.current?.setThrottle(-1);
          setTestLabel(null);
        }
        return;
      }
      if (demo) {
        const d = demoRef.current;
        const now = Date.now();
        const dt = Math.max((now - d.t) / 1000, 1 / FEED_HZ);
        d.t = now;
        const ms = d.kmh / 3.6;
        const a = (ms - d.prev) / dt;
        d.prev = ms;
        engine.current?.setInput(ms, a);
      } else {
        const s = sample.current;
        /* Akselerasjonen ganges med samme faktor som farten. Ellers ville
           gassanslaget lest en oppganget fart med gåfart-akselerasjon, og
           bilen hadde hørtes ut som den ruller i fri. */
        const k = walkRef.current;
        engine.current?.setInput(s.speed * k, s.accel * k);
      }
    }, 1000 / FEED_HZ);
    return () => clearInterval(id);
  }, [running, demo, sample]);

  /* ── UI-oppdatering: kvantisert, så React slipper å tegne unødig ── */
  useEffect(() => {
    if (!running) {
      setDisp(ZERO);
      return;
    }
    const id = setInterval(() => {
      const s = latest.current;
      if (!s) return;
      const max = profile.redlineRpm;
      const next: Disp = {
        rpm: Math.round(s.rpm / 10) * 10,
        gear: s.gear,
        kmh: Math.round(s.speed * 3.6),
        throttle: Math.round(s.throttle * 20) / 20,
        lit: Math.max(0, Math.min(TACH_SEGMENTS, Math.round((s.rpm / max) * TACH_SEGMENTS))),
        state: s.state,
        shift: s.shifting,
        limiter: !!s.limiter,
      };
      setDisp((p) =>
        p.rpm === next.rpm &&
          p.gear === next.gear &&
          p.kmh === next.kmh &&
          p.throttle === next.throttle &&
          p.lit === next.lit &&
          p.state === next.state &&
          p.shift === next.shift &&
          p.limiter === next.limiter
          ? p
          : next,
      );
    }, 1000 / UI_HZ);
    return () => clearInterval(id);
  }, [running, profile.redlineRpm]);

  /* Sensorpanelet oppdateres sjelden — det skal leses, ikke flimre. */
  useEffect(() => {
    if (!running || demo || !showSensors) return;
    const id = setInterval(() => {
      const s = sample.current;
      setSens({
        speed: s.speed,
        gpsSpeed: s.gpsSpeed,
        accel: s.accel,
        accuracy: s.accuracy,
        headingLock: s.headingLock,
        fixAge: s.fixAge,
      });
    }, 250);
    return () => clearInterval(id);
  }, [running, demo, showSensors, sample]);

  const onEngineState = useCallback((s: EngineState) => {
    latest.current = s;
  }, []);

  const toggleRunning = useCallback(() => {
    if (running) {
      engine.current?.stop();
      setRunning(false);
    } else {
      setError(null);
      /* Økta bes om på nytt ved hver start. iOS river den ned etter en
         telefonsamtale eller når bilen kobles til, og da må den hentes
         tilbake — ikke bare settes opp én gang da appen startet. */
      armAudioSession();
      engine.current?.setProfile({ ...profile.dsp, volume, cabin });
      engine.current?.start();
      setRunning(true);
    }
  }, [running, profile, volume, cabin, armAudioSession]);

  const toggleTest = useCallback(() => {
    if (test.current) {
      test.current = null;
      lastOverride.current = -1;
      engine.current?.setThrottle(-1);
      setTestLabel(null);
      return;
    }
    if (!running) {
      setError(null);
      engine.current?.setProfile({ ...profile.dsp, volume, cabin });
      engine.current?.start();
      setRunning(true);
    }
    test.current = newTestRun();
    setTestLabel(TEST_LABELS.vent);
  }, [running, profile, volume, cabin]);

  /* testen skal ikke leve videre når motoren slås av */
  useEffect(() => {
    if (!running && test.current) {
      test.current = null;
      lastOverride.current = -1;
      setTestLabel(null);
    }
  }, [running]);

  const onTachLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    const s = Math.max(170, Math.min(340, Math.min(width, height) - 8));
    setTachSize((p) => (Math.abs(p - s) < 2 ? p : s));
  }, []);

  const redFrom = Math.round(
    ((profile.dsp.limitRpm as number) / profile.redlineRpm) * TACH_SEGMENTS,
  );
  const glow = Math.round((disp.lit / TACH_SEGMENTS) * 10);
  const gearLabel = disp.state === 0 ? '–' : disp.state === 1 ? 'S' : String(disp.gear);

  /* ── statuslinje ── */
  let statusLabel = 'DEMO';
  let statusDot: string = T.muted;
  if (!demo) {
    if (status.permission === 'denied') {
      statusLabel = 'GPS AVSLÅTT';
      statusDot = T.red;
    } else if (!status.hasFix) {
      statusLabel = running ? 'SØKER GPS' : 'GPS KLAR';
      statusDot = '#F5A623';
    } else {
      statusLabel =
        walkScale > 1 ? `GÅTEST ×${walkScale}` : `GPS ±${status.accuracy} m`;
      statusDot = status.headingLock > 0.6 ? T.green : '#F5A623';
    }
  }

  return (
    <View style={styles.root}>
      <LinearGradient
        colors={[T.bgDeep, T.bg, '#0A0F1A']}
        locations={[0, 0.55, 1]}
        style={StyleSheet.absoluteFill}
      />
      {/* fargeglød bak turtelleren som følger turtallet */}
      <View
        pointerEvents="none"
        style={[
          styles.aura,
          {
            backgroundColor: withAlpha(profile.accent, 0.055 + (glow / 10) * 0.1),
            top: insets.top + 40,
          },
        ]}
      />

      <View style={[styles.page, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 10 }]}>
        {/* ── topplinje ── */}
        <View style={styles.header}>
          <View>
            <Text style={styles.logo}>
              EV<Text style={{ color: profile.accent }}>8</Text>
            </Text>
            <Text style={styles.tagline}>{profile.tagline}</Text>
          </View>
          <View style={styles.headerRight}>
            <Pill label={statusLabel} dot={statusDot} />
            <Pressable
              onPress={() => setSettingsOpen(true)}
              hitSlop={10}
              style={({ pressed }) => [styles.gearBtn, pressed && { opacity: 0.6 }]}
            >
              <Text style={styles.gearIcon}>⚙</Text>
            </Pressable>
          </View>
        </View>

        {/* ── turteller ── */}
        <View style={styles.tachArea} onLayout={onTachLayout}>
          <View style={{ width: tachSize, height: tachSize }}>
            <TachRing
              size={tachSize}
              lit={disp.lit}
              redFrom={redFrom}
              accent={profile.accent}
              glow={glow}
              maxRpm={profile.redlineRpm}
              shift={disp.shift}
              limiter={disp.limiter}
            />
            <View style={styles.tachCenter} pointerEvents="none">
              <Text style={[styles.gearBig, { color: profile.accent }]}>{gearLabel}</Text>
              <Text style={[styles.rpmBig, numeric]}>{disp.rpm}</Text>
              <Text style={styles.rpmUnit}>OMDR/MIN</Text>
            </View>
          </View>
        </View>

        {/* ── tall og målere ── */}
        <View style={styles.readouts}>
          <GlassCard style={styles.speedCard} radius={22}>
            <Text style={styles.cardLabel}>FART</Text>
            <View style={styles.speedRow}>
              <Text style={[styles.speedBig, numeric]}>{disp.kmh}</Text>
              <Text style={styles.speedUnit}>km/t</Text>
            </View>
          </GlassCard>

          <GlassCard style={styles.loadCard} radius={22}>
            <Meter
              value={disp.throttle}
              accent={profile.accent}
              label="GASS"
              right={`${Math.round(disp.throttle * 100)} %`}
            />
            <View style={{ height: 12 }} />
            <Meter
              value={Math.min(1, disp.kmh / 130)}
              accent={withAlpha(profile.accent, 0.75)}
              label="BELASTNING"
              right={disp.state === 2 ? `${disp.gear}. GIR` : '—'}
            />
          </GlassCard>
        </View>

        {demo ? (
          <GlassCard style={styles.demoCard} radius={20}>
            <View style={styles.demoHead}>
              <Text style={styles.cardLabel}>DEMOFART</Text>
              <Text style={[styles.demoValue, numeric]}>{Math.round(demoKmh)} km/t</Text>
            </View>
            <Slider
              value={demoKmh}
              onValueChange={setDemoKmh}
              minimumValue={0}
              maximumValue={140}
              step={1}
              minimumTrackTintColor={profile.accent}
              maximumTrackTintColor="rgba(255,255,255,0.16)"
              thumbTintColor={profile.accent}
              style={styles.slider}
            />
          </GlassCard>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <SecondaryButton
          label={testLabel ?? 'TESTKJØRING  0→50 HALV · 50→100 FULL'}
          accent={profile.accent}
          active={testLabel !== null}
          onPress={toggleTest}
        />

        <PowerButton
          running={running}
          busy={running && disp.state === 1}
          accent={profile.accent}
          onPress={toggleRunning}
        />

        {showSensors && !demo ? (
          <GlassCard style={styles.sensorCard} radius={16}>
            <View style={styles.sensorGrid}>
              <SensorItem label="GPS" value={`${(sens.gpsSpeed * 3.6).toFixed(0)} km/t`} />
              <SensorItem label="FUSJONERT" value={`${(sens.speed * 3.6).toFixed(0)} km/t`} />
              <SensorItem label="TIL MOTOR" value={`${(sens.speed * 3.6 * walkScale).toFixed(0)} km/t`} />
              <SensorItem label="AKSELERASJON" value={`${sens.accel.toFixed(1)} m/s²`} />
              <SensorItem label="NØYAKTIGHET" value={`±${Math.round(sens.accuracy)} m`} />
              <SensorItem label="RETNING LÆRT" value={`${Math.round(sens.headingLock * 100)} %`} />
              <SensorItem label="SIDEN GPS" value={`${sens.fixAge.toFixed(1)} s`} />
              <SensorItem label="GIR / TURTALL" value={`${disp.gear} · ${disp.rpm}`} />
            </View>
          </GlassCard>
        ) : null}

        <Text style={styles.foot}>
          {audioMode === 'worklet'
            ? 'Sanntidssyntese · lydtråd'
            : audioMode === 'script'
              ? 'Sanntidssyntese · reservemodus'
              : 'Lydmotor lastes …'}
          {!demo && status.headingLock > 0 && status.headingLock < 0.6
            ? '  ·  kalibrerer retning'
            : ''}
        </Text>
      </View>

      {/* ── innstillinger ── */}
      {settingsOpen ? (
        <View style={styles.sheetWrap}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setSettingsOpen(false)} />
          <GlassCard
            style={[styles.sheet, { paddingBottom: insets.bottom + 8 }]}
            radius={28}
            intensity={40}
          >
            <ScrollView showsVerticalScrollIndicator={false}>
              <View style={styles.sheetHandle} />
              <Text style={styles.sheetTitle}>MOTOR</Text>
              <ChipRow
                items={PROFILES}
                selectedId={profileId}
                onSelect={setProfileId}
                accentOf={(p) => p.accent}
              />
              <Text style={styles.hint}>{profile.tagline}</Text>

              <Text style={styles.sheetTitle}>VOLUM</Text>
              <Slider
                value={volume}
                onValueChange={setVolume}
                minimumValue={0}
                maximumValue={1}
                minimumTrackTintColor={profile.accent}
                maximumTrackTintColor="rgba(255,255,255,0.16)"
                thumbTintColor={profile.accent}
                style={styles.slider}
              />

              <Text style={styles.sheetTitle}>LYDBILDE</Text>
              <Slider
                value={cabin}
                onValueChange={setCabin}
                minimumValue={0}
                maximumValue={1}
                minimumTrackTintColor={profile.accent}
                maximumTrackTintColor="rgba(255,255,255,0.16)"
                thumbTintColor={profile.accent}
                style={styles.slider}
              />
              <View style={styles.scaleRow}>
                <Text style={styles.scaleEnd}>UTENFOR BILEN</Text>
                <Text style={[styles.scaleValue, numeric]}>
                  {Math.round((1 - cabin) * 100)} / {Math.round(cabin * 100)}
                </Text>
                <Text style={styles.scaleEnd}>I KUPÉEN</Text>
              </View>
              <Text style={styles.hint}>
                To mikrofoner som spilles samtidig, ikke enten eller. Utsiden gir
                anslag og smell, kupéen gir tyngde i bunnen. Midt på får du begge
                deler.
              </Text>

              <View style={styles.sheetRow}>
                <Toggle
                  on={demo}
                  label="DEMOMODUS (UTEN GPS)"
                  accent={profile.accent}
                  onPress={() => setDemo((v) => !v)}
                />
              </View>
              <Text style={styles.hint}>
                Styr farten med en skyvebryter for å teste lyden mens du står stille.
              </Text>

              <View style={styles.sheetRow}>
                <Text style={styles.cardLabel}>GÅTEST</Text>
                <Text style={[styles.scaleValue, numeric]}>
                  {walkScale > 1 ? `× ${walkScale}` : 'AV'}
                </Text>
              </View>
              <Slider
                value={walkScale}
                minimumValue={1}
                maximumValue={15}
                step={1}
                onValueChange={setWalkScale}
                minimumTrackTintColor={profile.accent}
                maximumTrackTintColor="rgba(255,255,255,0.15)"
                thumbTintColor={profile.accent}
                style={styles.slider}
              />
              <Text style={styles.hint}>
                Ganger opp farten fra GPS. Med × 10 høres gange i 5 km/t ut som
                50 km/t. Da kan du teste posisjon, bevegelsessensor, girkasse og
                lyd ute på fortauet i stedet for i bilen. Sett den til AV før du
                kjører på ordentlig.
              </Text>

              <View style={styles.sheetRow}>
                <Toggle
                  on={showSensors}
                  label="VIS SENSORVERDIER"
                  accent={profile.accent}
                  onPress={() => setShowSensors((v) => !v)}
                />
              </View>
              <Text style={styles.hint}>
                Rå GPS-fart mot fusjonert fart, hvor gammelt siste GPS-punkt er,
                og hvor godt appen har lært hvilken vei som er framover. Henger
                lyden etter, står svaret her.
              </Text>

              <Pressable
                onPress={() => setSettingsOpen(false)}
                style={({ pressed }) => [styles.closeBtn, pressed && { opacity: 0.7 }]}
              >
                <Text style={styles.closeText}>LUKK</Text>
              </Pressable>
            </ScrollView>
          </GlassCard>
        </View>
      ) : null}

      <EngineAudio
        ref={engine}
        onState={onEngineState}
        onReady={(mode) => setAudioMode(mode)}
        onError={(msg) => setError(msg)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: T.bg },
  aura: {
    position: 'absolute',
    alignSelf: 'center',
    width: 460,
    height: 460,
    borderRadius: 230,
  },
  page: { flex: 1, paddingHorizontal: 18, gap: 12 },

  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  logo: { color: T.text, fontSize: 26, fontWeight: '900', letterSpacing: 3 },
  tagline: { color: T.muted, fontSize: 10.5, letterSpacing: 1.1, marginTop: 2, fontWeight: '600' },
  gearBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: T.border,
  },
  gearIcon: { color: T.muted, fontSize: 15, marginTop: Platform.OS === 'ios' ? -1 : 0 },

  tachArea: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 180 },
  tachCenter: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  gearBig: { fontSize: 54, fontWeight: '900', lineHeight: 58, letterSpacing: -1 },
  rpmBig: { color: T.text, fontSize: 27, fontWeight: '800', marginTop: 2, letterSpacing: 0.5 },
  rpmUnit: { color: T.muted, fontSize: 9.5, fontWeight: '800', letterSpacing: 2, marginTop: 3 },

  readouts: { flexDirection: 'row', gap: 12 },
  speedCard: { width: 130 },
  loadCard: { flex: 1 },
  cardLabel: { color: T.muted, fontSize: 10.5, fontWeight: '800', letterSpacing: 1.4 },
  speedRow: { flexDirection: 'row', alignItems: 'baseline', gap: 5, marginTop: 4 },
  speedBig: { color: T.text, fontSize: 40, fontWeight: '900', letterSpacing: -1.5 },
  speedUnit: { color: T.muted, fontSize: 12, fontWeight: '700' },

  sensorCard: { marginTop: 10 },
  sensorGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  sensorItem: { width: '50%', paddingVertical: 4 },
  sensorLabel: { color: T.muted, fontSize: 9, fontWeight: '700', letterSpacing: 0.9 },
  sensorValue: { color: T.text, fontSize: 13, fontWeight: '700' },

  demoCard: {},
  demoHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  demoValue: { color: T.text, fontSize: 13, fontWeight: '800' },
  slider: { width: '100%', height: 34 },

  error: { color: T.red, fontSize: 11, textAlign: 'center' },
  foot: { color: 'rgba(255,255,255,0.28)', fontSize: 10, textAlign: 'center', letterSpacing: 0.6 },

  sheetWrap: { ...StyleSheet.absoluteFillObject, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: { maxHeight: '82%', borderBottomLeftRadius: 0, borderBottomRightRadius: 0 },
  sheetHandle: {
    alignSelf: 'center',
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.25)',
    marginBottom: 14,
  },
  sheetTitle: {
    color: T.muted,
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 1.6,
    marginBottom: 10,
    marginTop: 14,
  },
  sheetRow: { marginTop: 20 },
  hint: { color: 'rgba(255,255,255,0.32)', fontSize: 11, marginTop: 8, lineHeight: 15 },
  scaleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 },
  scaleEnd: { color: 'rgba(255,255,255,0.30)', fontSize: 9.5, fontWeight: '800', letterSpacing: 1 },
  scaleValue: { color: T.muted, fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  closeBtn: {
    marginTop: 26,
    paddingVertical: 13,
    borderRadius: 14,
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: T.border,
  },
  closeText: { color: T.text, fontSize: 12, fontWeight: '800', letterSpacing: 1.4 },
});
