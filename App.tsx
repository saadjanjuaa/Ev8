import React, { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as SystemUI from 'expo-system-ui';
import DriveScreen from './src/screens/DriveScreen';

export default function App() {
  useEffect(() => {
    // unngå hvitt glimt bak skjermbildet ved rotasjon/oppstart
    SystemUI.setBackgroundColorAsync('#05070C').catch(() => {});
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <DriveScreen />
    </SafeAreaProvider>
  );
}
