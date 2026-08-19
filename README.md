# EV8 — V8-motorlyd for elbil

Appen leser hvor fort og hvordan telefonen beveger seg, og lager en V8-motorlyd
som følger kjøringen i sanntid. Koble telefonen til bilstereoen, trykk start, og
kjør.

Bilen er en **VW e-Golf**. Girkasse, toppfart og gasspådrag er bygget på bilens
faktiske data, ikke på en generisk V8. Skal appen brukes i en annen bil, er det
`CAR` i `src/audio/profiles.ts` som endres — girkassen regner seg ut selv.

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

## Lydbilde — inne og ute samtidig

To mikrofonperspektiver regnes ut parallelt på det samme eksossignalet:

* **Utenfor bilen** — full båndbredde og nærhet. Anslaget i hver forbrennings­puls
  og smellene beholder kanten sin.
* **I kupéen** — karosseriet spiser alt over ca. 2,5 kHz, og kupéens egenresonans
  rundt 60 Hz gir brystdunket.

Skyvebryteren **LYDBILDE** blander dem. Det er en ekte blanding, ikke et valg:
begge kjøres alltid, så midt på skalaen får du tyngden fra kupéen *og* detaljene
fra utsiden på én gang. Standard er 55 % kupé. Til sammenligning, målt spektralt
tyngdepunkt under full gass:

| Innstilling | Tyngdepunkt |
|---|---|
| Bare utenfor | 727 Hz |
| Blanding (standard) | 428 Hz |
| Bare kupé | 325 Hz |

## Tydelige pulser

Tre ting avgjør om du hører hver enkelt tenning eller bare én sammenhengende
grøt:

* **`burn`** — hvor fort forbrenningspulsen klinger av, målt per veivgrad.
  Kortere puls gir mer stillhet mellom tenningene.
* **`punch`** — transientforsterker. To omhyllingsfølgere med ulik hastighet;
  der den raske ligger over den trege har det skjedd noe brått, altså en
  tenning, og akkurat det øyeblikket løftes. Ligger før metningen, ellers
  spiser metningen løftet opp igjen.
* **Pumpestrømmen** mellom pulsene, som fyller igjen stillheten hvis den står
  for høyt.

Målt modulasjonsdybde i omhyllingen ved tenningsfrekvensen: 14,9 → 18,6 % ved
50 km/t og 11,4 → 15,3 % ved 90 km/t.

## Bunn og bråk

Metningen legges bare på det ØVRE båndet. Signalet deles ved 170 Hz, bassen
tas ut ren, forvrengningen legges på resten, og de summeres igjen. Kjøres
bassen gjennom metningen blir den både klemt flat — den har jo de største
utslagene — og full av grove overtoner. Delt opp står bunnen tung og ren
samtidig som kanten sitter der den skal.

Under bunnen ligger en lavhylle på 125 Hz i stedet for en smal topp på 80 Hz.
Halv- og kvartordens linjene som ER rumlingen ligger *under* tenningsfrekvensen,
og en smal topp traff bare grunntonen — det ga brumming, ikke rumling.

Målt frekvensbalanse ved 80 km/t, som viser hva de to grepene gjorde:

| | 25–120 Hz | 2–8 kHz | Forhold | Tyngdepunkt |
|---|---|---|---|---|
| Før | −47,6 dB | −70,4 dB | 22,8 dB | 282 Hz |
| Nå | −45,3 dB | −76,8 dB | 31,5 dB | 166 Hz |

## Turbo

Ladetrykket bygger seg opp med gass og turtall, med treghet — turboen må spole.
Når du slipper gassen mens trykket står på, åpner **avblåsingsventilen** og
overtrykket freser ut: et bredt støyutbrudd som synker i frekvens etter hvert
som trykket faller. Over det ligger **kompressorhylet**, en tone pluss luft som
følger ladetrykket.

To ting avgjør om man faktisk hører den:

**Den går på en egen direktebuss**, ikke gjennom eksosen. Turboen sitter i
motorrommet, ikke i enderøret — og sendes den gjennom kupémikrofonens lavpass
på 2,5 kHz forsvinner hele plystringen.

**Den er terskelstyrt.** En ekte turbo plystrer ikke før den lager trykk. Uten
terskel hylte den gjennom hele marsjfarten og overdøvet motoren. Målt bidrag i
plysterområdet 1,4–6 kHz:

| | Hard akselerasjon | Marsjfart |
|---|---|---|
| MUSCLE V8 | **+12,6 dB** | ±0,3 dB |
| JDM TURBO | **+9,5 dB** | ±0,2 dB |

**Plystringen må være tonal.** Bredt filter på støy gir bare vind. Tonen bærer
plystringen og støyen er pusten rundt den — ikke omvendt. Frekvensen ligger nå
på 2,4–6,2 kHz.

**Avblåsingen plystrer flere ganger.** Ventilen og kompressoren pumper mot
hverandre, så det kommer 2–4 korte plyst som faller i tonehøyde etter det første
luftutbruddet — «pshh-tu-tu-tu», ikke ett jevnt sus.

Styres med skyvebryteren **TURBO** i innstillingene, fra av til maks.

## Smell

Hvert smell er **to ting samtidig**: et bredbåndet knall på 8–12 ms formet rundt
1 kHz, og en lav dunk på 50–140 Hz som ligger igjen i 100 ms etterpå. Ett enkelt
avklingende støyutbrudd — som det var før — blir et leketøysplopp uansett hvor
høyt det skrus.

To ting til måtte til for at de skulle slå hardt:

**Knallet går delvis utenom røret og metningen.** Ellers blir anslaget klemt
flatt av båndsplittmetningen før det når ut.

**Motornivået skaleres før direktebussen legges på.** Ellers vokser motoren og
smellene i takt, og knallet får aldri plass å stikke opp i. Det var derfor de
hørtes små ut uansett hvor mye `popGain` ble skrudd opp.

**Limiteren bruker 1,5 ms på å ta tak** i stedet for å reagere momentant. Med
momentan innsvingning ble hvert eneste knall klemt ned til terskelen. En myk
metning like under taket runder av det som stikker over.

Målt på ett enkelt smell mot tomgang: 16,1 dB over motoren, og varighet over
dobbelt motornivå gikk fra 29 til 114 ms — altså et smell med kropp, ikke et tikk.

Smellene fyres gjennom en kø med ekte avstand imellom, og en sperretid på 55 ms
som gjelder alle kilder. Uten den ble en «serie» avfyrt på nøyaktig samme sample
og hørtes ut som ett eneste blaff, og de tilfeldige smellene kom i
maskingeværsalver.

Et girskift gir nå 3–6 smell fordelt over 55–140 ms hver. En del av knallet går
rett ut på direktebussen så anslaget beholdes, resten gjennom røret som gir
klangen.

Målt i testkjøringen: 43 smell, korteste avstand 58 ms, median 206 ms, ingen
under 40 ms.

## Testkjøring

Knappen **TESTKJØRING** spiller av en skriptet tur uten at du beveger deg:

```
tomgang
0–50 km/t     rolig akselerasjon
50–30 km/t    slipp gassen   ->  avblåsingsventilen freser
30 km/t       hold
30–100 km/t   80 % gass      ->  turboen bygger trykk, girskift
100–30 km/t   slipp gassen   ->  avblåsing igjen, spraking, nedgir
inn til stopp
tre gasspådrag på tomgang
```

Farten integreres opp fra bilens faktiske akselerasjonsevne, ikke fra en fast
kurve — som en ekte e-Golf. Testen mates inn
i lydmotoren på nøyaktig samme vei som ekte GPS-data, så girkasse, gasspådrag og
smell oppfører seg identisk med virkelig kjøring. Trykk en gang til for å avbryte.

## Bilen

| | |
|---|---|
| Toppfart | 150 km/t |
| 0–100 | ca. 9,6 s (0–50 på ca. 3,4 s — elmotoren gir alt med én gang) |
| Effekt/masse | 100 kW / 1615 kg |
| Hjulomkrets | 1,96 m (205/55 R16) |

To ting følger av dette:

**Girkassen** regnes ut fra toppfarten. Toppgiret legges slik at 150 km/t lander
på 65 % av turtallssperren, og resten av girene fordeles geometrisk nedover.
For MUSCLE V8 gir det skift ved 37, 52, 74 og 104 km/t på full gass, og rundt
2200 o/min i 6. gir ved 80 km/t.

**Gasspådraget** måles mot det bilen faktisk klarer *ved den farten du har nå*.
En elbil gir alt fra stillstand, men er effektbegrenset høyere oppe: 4,3 m/s² fra
stopp, men bare 2,5 m/s² ved 90 km/t. Måltes akselerasjonen mot en fast verdi,
ville alt hørtes ut som full gass i by og ingenting i motorveifart. Nå høres
halv gass ut som halv gass i hele fartsregisteret.

## Motorer

* **MUSCLE V8** — 6,2 l crossplane, rette rør. Dyp, lopete, mye smell.
* **TRACK V8** — 4,5 l flatplane opp til 8600. Eksotisk hyl i stedet for rumling.
* **BLOWN V8** — crossplane med kompressorhyl.
* **JDM TURBO** — 2,6 l rekkesekser, twin-turbo, opp til 8000. Turboen er lyden.

Bytt i innstillingene (tannhjulet oppe til høyre).

### Hvorfor en sekser låter helt annerledes

`cylinders` bestemmer hvor mange tenninger som fordeles på de 720 veivgradene
i en arbeidssyklus. En V8 fyrer fire ganger per omdreining, en rekkesekser tre —
og fordi seksuerens tenninger er *perfekt* jevne, finnes det ingen halv- eller
kvartordens ujevnhet å rumle på. All energien samles på grunntonen, og det er
derfor den hyler turbinaktig i stedet for å rumle amerikansk.

Målt ved samme test: V8-ene topper på 4 tenninger per omdreining, JDM-profilen
på 3, og dens grunntone er nesten tre ganger sterkere enn V8-enes.

Ligger alle tenningene på bank 0 er motoren enbanks — det finnes bare én
manifold. Modellen mater da begge halerørene fra samme strøm, med ulik
rørlengde og hver sin turbulens, akkurat som et todelt anlegg bak én turbo.

## Kom i gang

Det finnes to måter å kjøre EV8 på. Begge bruker **nøyaktig samme lydmotor** —
`web/` bygges fra de samme kildefilene som appen, så de kan ikke drifte fra
hverandre.

### Som nettside (ingen installasjon)

```bash
node scripts/build-web.mjs
```

Bygger `web/ev8.html` — hele appen i én selvstendig fil på ca. 97 kB. Lydmotoren
kjører i en `AudioWorklet` rett i nettleseren, uten React Native rundt seg.
Åpnes fra en HTTPS-adresse virker GPS og bevegelsessensor som i appen, og
«Legg til på Hjem-skjerm» gir den et eget ikon.

Bygget lager også `web/ev8-hosted.html`, samme side uten `<html>`/`<body>`,
til bruk der verten leverer sitt eget dokumentskjelett.

### Som app (React Native)

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

Vil du høre på lyden mens du står stille: trykk **TESTKJØRING**, eller skru på
**DEMOMODUS** i innstillingene og dra i fartsbryteren.

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
6. Til slutt metning, de to mikrofonperspektivene (se over) og limiter.

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
src/audio/profiles.ts      bilen + de tre motorene, som fysiske beskrivelser
src/audio/testDrive.ts     skriptet testkjøring 0-50 halv gass, 50-100 full
src/sensors/               GPS + akselerometer-fusjon
src/ui/                    glassmorfisme-komponenter og turtelleren
src/screens/DriveScreen.tsx
web/template.html          nettversjonens grensesnitt (malen)
scripts/build-web.mjs      limer DSP-en inn i malen -> web/ev8.html
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
| `cabin` | lydbilde: 0 er ren utvendig mikrofon, 1 er ren kupémikrofon |
| `shiftUpLow/High` | girpunkt ved henholdsvis null og full gass |

Kjøretøydataene ligger i `CAR` i samme fil, og `gearboxFor()` regner girkassen
ut fra dem.

## Merk

* Lyden fortsetter i bakgrunnen, og skjermen holdes våken mens motoren går.
* Appen støyer ikke ut andre lydkilder — navigasjon og musikk kan spille samtidig.
* Batteribruken er merkbar: GPS på full nøyaktighet pluss skjerm som står på.
  Ha telefonen i lader på lengre turer.
