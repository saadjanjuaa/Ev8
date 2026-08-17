import React, { forwardRef, useCallback, useImperativeHandle, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { ENGINE_HTML } from './engineHtml';

export interface EngineState {
  rpm: number;
  gear: number;
  gears: number;
  speed: number;
  throttle: number;
  accel: number;
  /** 0 = av, 1 = starter, 2 = går, 3 = stopper */
  state: number;
  /** 1 = girer opp, -1 = girer ned, 0 = ingenting */
  shifting: number;
  limiter: number;
}

export interface EngineHandle {
  start(): void;
  stop(): void;
  setInput(speedMs: number, accelMs2: number): void;
  setProfile(dsp: Record<string, unknown>): void;
  /** −1 kobler ut manuell gass og lar kjøringen styre igjen */
  setThrottle(v: number): void;
  resume(): void;
}

interface Props {
  onState?: (s: EngineState) => void;
  onEvent?: (name: string, value: number) => void;
  onReady?: (mode: string, sampleRate: number) => void;
  onError?: (msg: string) => void;
}

/**
 * Usynlig WebView som huser lydmotoren. Den rendres 1×1 px (ikke display:none —
 * enkelte plattformer stopper lyden da) og tar ikke imot berøring.
 */
export const EngineAudio = forwardRef<EngineHandle, Props>(function EngineAudio(
  { onState, onEvent, onReady, onError },
  ref,
) {
  const web = useRef<WebView>(null);
  const queue = useRef<string[]>([]);
  const ready = useRef(false);

  const send = useCallback((msg: object) => {
    const s = JSON.stringify(msg);
    if (!ready.current) {
      /* hold på de siste meldingene til siden er lastet */
      if (queue.current.length < 24) queue.current.push(s);
      return;
    }
    web.current?.postMessage(s);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      start: () => send({ t: 'start' }),
      stop: () => send({ t: 'stop' }),
      setInput: (s, a) => send({ t: 'input', s, a }),
      setProfile: (dsp) => send({ t: 'profile', p: dsp }),
      setThrottle: (v) => send({ t: 'throttle', v }),
      resume: () => send({ t: 'resume' }),
    }),
    [send],
  );

  const handleMessage = useCallback(
    (e: { nativeEvent: { data: string } }) => {
      let m: any;
      try {
        m = JSON.parse(e.nativeEvent.data);
      } catch {
        return;
      }
      switch (m.t) {
        case 'boot': {
          ready.current = true;
          const q = queue.current;
          queue.current = [];
          for (const s of q) web.current?.postMessage(s);
          break;
        }
        case 'ready':
          onReady?.(m.mode, m.sr);
          break;
        case 'state': {
          onState?.(m as EngineState);
          if (m.events?.length && onEvent) {
            for (const ev of m.events) onEvent(ev.e, ev.v);
          }
          break;
        }
        case 'error':
          onError?.(`${m.where}: ${m.msg}`);
          break;
        case 'warn':
          break;
      }
    },
    [onState, onEvent, onReady, onError],
  );

  return (
    <View style={styles.host} pointerEvents="none">
      <WebView
        ref={web}
        source={{ html: ENGINE_HTML, baseUrl: 'https://ev8.local/' }}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled
        onMessage={handleMessage}
        mediaPlaybackRequiresUserAction={false}
        allowsInlineMediaPlayback
        allowsAirPlayForMediaPlayback
        allowsProtectedMedia
        androidLayerType="hardware"
        mixedContentMode="always"
        setSupportMultipleWindows={false}
        cacheEnabled={false}
        scrollEnabled={false}
        style={styles.web}
        onError={(e) => onError?.(`webview: ${e.nativeEvent.description}`)}
        onRenderProcessGone={() => {
          ready.current = false;
          onError?.('webview: lydprosessen ble avsluttet av systemet');
        }}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    left: 0,
    bottom: 0,
    width: 1,
    height: 1,
    opacity: 0.01,
  },
  web: { width: 1, height: 1, backgroundColor: 'transparent' },
});
