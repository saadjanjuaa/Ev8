# Motorlyder for elbil-app 🚗💨

18 sømløse motor-loops generert proseduralt — alle i samme "familie" så de
crossfader pent sammen.

## Hva du har fått

Tre komplette sett, hvert med 6 RPM-nivåer (800, 1500, 2500, 4000, 6000, 8000):

- **`sport_*.wav`** — Sportsbil-aktig, lys og aggressiv
- **`muscle_*.wav`** — V8-aktig, dyp og rumlende
- **`ev_*.wav`** — Futuristisk elbil-sound (jetlignende, ingen forbrenning)

Alle filer er:
- 44.1 kHz, 16-bit, mono WAV
- ~2 sekunder lange
- **Sømløse loops** (lengden er justert til hele motorsykluser)
- Lisensfri (jeg genererte dem til deg her og nå)

## Hvordan bruke i appen

### 1. Mapping fart → RPM
Bestem hvilken fart som tilsvarer hvilket "RPM":
```
0 km/t  → 800 RPM   (idle)
30 km/t → 2500 RPM
60 km/t → 4000 RPM
100 km/t → 6000 RPM
130+ km/t → 8000 RPM
```

### 2. Crossfade mellom de to nærmeste loopene
Eksempel: bilen kjører på "3000 simulert RPM"
- Spill `sport_2500rpm.wav` med volum 67%, pitch +5%
- Spill `sport_4000rpm.wav` med volum 33%, pitch -8%
- Begge looper kontinuerlig, du justerer bare volum + pitch i sanntid

### 3. Pseudo-kode
```javascript
function updateEngineSound(speed_kmh) {
  const rpm = mapSpeedToRpm(speed_kmh);
  const [lower, upper] = findNearestSamples(rpm); // f.eks. 2500 og 4000
  
  // Hvor langt vi er mellom de to (0.0 - 1.0)
  const t = (rpm - lower.rpm) / (upper.rpm - lower.rpm);
  
  // Volum: kryssfade
  lower.gain = 1.0 - t;
  upper.gain = t;
  
  // Pitch: juster så hver loop "treffer" riktig RPM
  lower.playbackRate = rpm / lower.rpm;
  upper.playbackRate = rpm / upper.rpm;
}
```

## Anbefalt for elbil-app: bruk `ev_*` sett som base

EV-settet er designet for elbiler — ren, futuristisk, uten forbrennings-pulsering.
Du kan legge `sport_*` på toppen som et ekstra lag når brukeren akselererer hardt
for å gi det litt "ekstra".

## Hvis lyden fortsatt ikke er bra nok

Disse er prosedurale (syntetiske) — de er gode for prototyping og helt OK i en
ferdig app, men hvis du vil ha *ekte* opptak:

1. **Freesound.org** — søk "engine loop", filtrer på CC0
2. **FMOD Studio** (gratis indie) — bygg engine-systemet visuelt
3. **Boom Library** — kommersielle pakker av profesjonell kvalitet (~$100+)

## Tips for Claude Code

Når du jobber med Claude Code i appen din, gi den denne README-filen som kontekst.
Da skjønner den strukturen og kan bygge crossfade-logikken riktig på første forsøk.
