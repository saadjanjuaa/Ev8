# EV8 — V8-motorlyd for elbil

Appen leser hvor fort og hvordan telefonen beveger seg, og lager en V8-motorlyd
som følger kjøringen i sanntid. Koble telefonen til bilstereoen, trykk start, og
kjør.

Lyden er **ikke** lydfiler som spilles av eller pitches opp og ned. Den blir
regnet ut fra bunnen av, sample for sample, ut fra hvordan en ekte V8 faktisk
lager lyd. Det er derfor den kan gjøre ting samples ikke kan: legge seg presis
på turtallet, endre karakter når du slipper gassen, spraking på motorbrems og
smell i girskiftene — uten sømmer eller loop-punkter.

## Slik høres det ut

| | |
|---|---|
| **Tomgang** | Ujevn, lopete rumling. Kommer av at en crossplane-V8 fyrer ujevnt per sylinderbank (270-180-90-180 veivgrader) |
| **Akselerasjon** | Gasspådraget leses ut av hvordan bilen faktisk akselererer. Mer gass = kraftigere forbrenning, mer rasp, åpnere potte |
| **Girskift opp** | Tenningskutt, «bark» i eksosen, 1–3 smell, turtallet faller gjennom giret |
| **Girskift ned** | Mellomgass som rev-matcher, ofte med et smell |
| **Motorbrems** | Forbrenningen dør ut, du hører pumpingen i motoren, og uforbrent drivstoff smeller i eksosen |
| **Turtallssperre** | Hakkende tenningskutt mot sperren |
| **Start / stopp** | Startmotor som drar rundt, motoren tar tak og flarer, og dør ut når du slår av |

## Motorer

* **MUSCLE V8** — 6,2 l crossplane, rette rør. Dyp, lopete, mye smell.
* **TRACK V8** — 4,5 l flatplane opp til 8600. Eksotisk hyl i stedet for rumling.
* **BLOWN V8** — crossplane med kompressorhyl.

Bytt i innstillingene (tannhjulet oppe til høyre).

## Kom i gang

```bash
npm install
npx expo start
```

Skann QR-koden med Expo Go. Alt som brukes ligger i Expo Go, så du trenger ikke
bygge appen selv for å prøve den.

I bilen:

1. Koble telefonen til stereoen (AUX eller Bluetooth).
2. Trykk **START MOTOR** og godta posisjonstilgang.
3. Kjør. De første gangene du akselererer kalibrerer appen seg (se under).

Vil du høre på lyden mens du står stille: skru på **DEMOMODUS** i innstillingene
og dra i fartsbryteren.

## Hvordan det virker

### Lyden

`src/audio/engineCore.ts` er hele motoren, skrevet som ren DSP-kode som kjører i
en `AudioWorkletProcessor` — altså på lydtråden, ikke på UI-tråden. Den kan
derfor ikke hakke selv om skjermen tegner opp eller React rerenderer.

Per sample:

1. **Veivakselen** dreier videre ut fra turtallet, målt i grader — ikke sekunder.
2. **Åtte sylindre** fyrer hver 90. grad i riktig tenningsrekkefølge
   (1-8-4-3-6-5-7-2). Hvilken bank hver tenning tilhører er hele forskjellen på
   amerikansk rumling og italiensk hyl, og er ett felt i profilen.
3. **Forbrenningspulsen** modelleres i veivgrader: en skarp trykkbølge når
   eksosventilen åpner, så pumpestrøm resten av eksostakten, pluss turbulensstøy
   som følger gjennomstrømningen. Fordi pulsen er definert i grader blir den
   automatisk kortere og hardere når turtallet stiger, akkurat som i virkeligheten.
4. **Eksosanlegget** er en bølgeleder: ett header-rør per bank, H-rør mellom
   dem, doble midtrør, potte med diffusjon, og enderør. Refleksjonene i rørene
   lager resonansene — de er ikke lagt på som EQ etterpå.
5. **Smell** mates inn i *begynnelsen* av røret, ikke på utgangen, slik at de
   arver rørets klang i stedet for å ligge oppå som en effekt.
6. Til slutt metning, kupé-filter og limiter.

Ingen sylinder er helt lik: hver har et fast avvik, og amplitude, brennhastighet
og tenningstidspunkt varierer litt fra syklus til syklus. Det er dette som gjør
at det ikke blir stående som en synth-tone.

Girkassen ligger også inne i lydtråden, med clutch som slurer ved igangkjøring,
automatiske girskift som flytter seg etter hvor hardt du kjører, og
turtallssperre.

### Farten

`src/sensors/useVehicleSpeed.ts`. GPS alene oppdaterer omtrent én gang i
sekundet — da ville lyden ligget et helt sekund bak gassfoten. Derfor:

* Akselerometeret (50 Hz) integreres opp og gir umiddelbar respons.
* GPS korrigerer bort driften.

Telefonen kan ligge hvordan som helst, så appen finner selv ut hvilken vei som
er framover: tyngdekraften gir «ned», og framoverretningen læres opp ved å se
hvilken vei akselerometeret peker akkurat når GPS melder at farten øker. Prikken
ved siden av GPS-statusen blir grønn når retningen sitter.

### Prosjektstruktur

```
src/audio/engineCore.ts    motoren + eksosanlegget + girkassen (DSP)
src/audio/engineHtml.ts    lydverten: AudioWorklet, med ScriptProcessor i reserve
src/audio/EngineAudio.tsx  broen mellom React Native og lydtråden
src/audio/profiles.ts      de tre motorene, som fysiske beskrivelser
src/sensors/               GPS + akselerometer-fusjon
src/ui/                    glassmorfisme-komponenter og turtelleren
src/screens/DriveScreen.tsx
```

## Justere lyden

Alt i `profiles.ts` er fysiske størrelser, så det er ganske intuitivt å skru på:

| Felt | Betydning |
|---|---|
| `headerLen`, `midLen` | rørlengder i meter — lengre rør gir dypere brøl |
| `reflection` | hvor mye som reflekteres tilbake i røret — mer = mer rørklang |
| `muffler` | 0 er rett rør, 1 er stille |
| `damping` | hvor mye høyfrekvens røret spiser |
| `growl`, `rasp` | dB på bunn og på raspen i midten |
| `popRate`, `popGain` | hvor ofte og hvor hardt det smeller |
| `idleLope`, `combVar` | hvor ujevn motoren går |
| `banks` | tenningsrekkefølgens bankmønster (crossplane vs. flatplane) |
| `shiftUpLow/High` | girpunkt ved henholdsvis null og full gass |

## Merk

* Lyden fortsetter i bakgrunnen, og skjermen holdes våken mens motoren går.
* Appen støyer ikke ut andre lydkilder — navigasjon og musikk kan spille samtidig.
* Batteribruken er merkbar: GPS på full nøyaktighet pluss skjerm som står på.
  Ha telefonen i lader på lengre turer.
