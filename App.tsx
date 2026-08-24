import React, { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StyleSheet, Text, View } from 'react-native';
import * as SystemUI from 'expo-system-ui';
import * as SplashScreen from 'expo-splash-screen';
import DriveScreen from './src/screens/DriveScreen';

/**
 * Fanger opp feil under første tegning.
 *
 * I et utviklingsbygg vises en rød feilskjerm med hele stakken. I et
 * ferdig bygg gjør React ingenting synlig — treet blir bare stående tomt,
 * og siden ingenting tegnes, blir oppstartsskjermen liggende. Utenfra ser
 * det ut som appen henger, uten at noe forteller hvorfor.
 *
 * Derfor skrives feilen på skjermen i stedet. Da kan den leses av og
 * sendes videre, i stedet for at neste bygg blir enda en gjetning.
 */
class Feilgrense extends React.Component<
  { children: React.ReactNode },
  { feil: Error | null }
> {
  state: { feil: Error | null } = { feil: null };

  static getDerivedStateFromError(feil: Error) {
    return { feil };
  }

  componentDidCatch() {
    /* Skjermen er alt vi har her — oppstartsskjermen må vekk, ellers
       ligger den over feilmeldingen. */
    SplashScreen.hideAsync().catch(() => {});
  }

  render() {
    const { feil } = this.state;
    if (!feil) return this.props.children;
    return (
      <View style={s.feilrot}>
        <Text style={s.feiltittel}>EV8 startet ikke</Text>
        <Text style={s.feilmelding}>{feil.message}</Text>
        <Text style={s.feilstakk} numberOfLines={14}>
          {feil.stack ?? ''}
        </Text>
      </View>
    );
  }
}

export default function App() {
  useEffect(() => {
    /* unngå hvitt glimt bak skjermbildet ved rotasjon/oppstart */
    SystemUI.setBackgroundColorAsync('#05070C').catch(() => {});
    /* Oppstartsskjermen skjuler seg normalt selv når roten er tegnet, men
       den garantien er ikke verdt å hvile på: slår den feil, står appen
       bak et bilde som aldri går bort. Å be om det eksplisitt koster
       ingenting, og er en tom operasjon hvis den alt er borte. */
    SplashScreen.hideAsync().catch(() => {});
  }, []);

  return (
    <Feilgrense>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <DriveScreen />
      </SafeAreaProvider>
    </Feilgrense>
  );
}

const s = StyleSheet.create({
  feilrot: {
    flex: 1,
    backgroundColor: '#05070C',
    paddingHorizontal: 22,
    paddingTop: 90,
    gap: 14,
  },
  feiltittel: { color: '#FF4438', fontSize: 19, fontWeight: '800', letterSpacing: 0.6 },
  feilmelding: { color: '#EDF1F8', fontSize: 14, lineHeight: 20 },
  feilstakk: { color: '#79839A', fontSize: 11, lineHeight: 15 },
});
