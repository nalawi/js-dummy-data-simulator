# JavaScript JSON Simulators

Pure-JavaScript, zero-dependency data simulators that emit **arrays of objects**
(JSON-ready) for dynamic mock scenarios. No frameworks, no build step — runs in
Node.js (CommonJS) and browsers via a `<script>` tag.

| File | Simulator | Output |
|------|-----------|--------|
| `floodDataSimulator.js` | Urban flooding in **Jakarta, Indonesia** | Array of flood-report objects |
| `hvacDataSimulator.js` | HVAC / chiller telemetry | Array of sensor readings |
| `gpsTrackerSimulator.js` | GPS tracker movement | Array of position pings |

---

## Jakarta Flood Simulator (`floodDataSimulator.js`)

Generates random, dynamic flood-monitoring data for **DKI Jakarta** — one report
object per flood monitoring post (*pos pantau banjir*) per time tick. The
network covers 18 flood-prone kelurahan across all five cities, on the rivers
Ciliwung, Cipinang, Sunter, Angke, Pesanggrahan, Krukut, Buaran, Cakung and
Cengkareng Drain, plus rob-prone coastal posts in the north.

### Quick start

**CLI demo** (pretty-printed JSON array):

```bash
node floodDataSimulator.js [ticks] [seed]
node floodDataSimulator.js 1        # one tick, random seed
node floodDataSimulator.js 5 1234   # reproducible run, seed 1234
```

**Node.js:**

```js
const { FloodSimulator, generateSnapshot, generateSeries } =
  require('./floodDataSimulator');

// One instant -> array of 18 report objects
const reports = generateSnapshot({ seed: 42 });

// Continuous simulation: 48 ticks x 30 min = 24 h of data
const sim = new FloodSimulator({ seed: 42 });
const day = sim.nextSeries(48);   // flat array of report objects over time
const next = sim.next();          // keep ticking forward one step at a time
```

**Browser:**

```html
<script src="floodDataSimulator.js"></script>
<script>
  const reports = FloodDataSimulator.generateSnapshot();
  console.log(reports); // array of objects
</script>
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `seed` | random | Seed for the internal PRNG; same seed ⇒ identical output |
| `startEpochMs` | `Date.now()` | Simulation clock origin (ms epoch) |
| `tickIntervalMs` | `1800000` (30 min) | Simulated time between ticks |
| `stationIds` | all | Filter posts by id, e.g. `['FMS-01','FMS-12']` |
| `stationCount` | all | Limit number of posts |
| `stormRate` | `0.10` | Base chance a storm cell spawns per tick |
| `rainWindowTicks` | `48` | Rolling window length for 24 h rain accumulation |

### API

| Member | Returns | Description |
|--------|---------|-------------|
| `new FloodSimulator(options)` | instance | Stateful simulator |
| `sim.next()` | array of reports | Advance one tick |
| `sim.nextSeries(ticks)` | array of reports | `ticks` × station-count flat array |
| `sim.getStationCatalog()` | array of objects | Post metadata, rivers, alert thresholds |
| `generateSnapshot(options)` | array of reports | One-tick convenience helper |
| `generateSeries(ticks, options)` | array of reports | Multi-tick convenience helper |
| `STATIONS`, `CITY_ZONES`, `RIVER_THRESHOLDS` | data | Built-in reference data |

### Report object schema

```jsonc
{
  "id": "FLD-000001",
  "timestamp": "2026-02-20T17:00:00.000Z",   // ISO 8601
  "epochMs": 1771616400000,
  "region": "DKI Jakarta",
  "stationId": "FMS-12",
  "stationName": "Pos Pantau Banjir Manggarai",
  "location": {
    "latitude": -6.212, "longitude": 106.852,
    "kelurahan": "Manggarai", "kecamatan": "Setiabudi",
    "city": "Jakarta Selatan", "zoneType": "river"   // river | coastal | drainage
  },
  "rainfall": {
    "intensityMmPerHour": 34.5,          // instantaneous rate
    "last24hMm": 88.2,                   // rolling 24 h accumulation
    "condition": "HEAVY_RAIN",           // CLEAR | DRIZZLE | LIGHT_RAIN |
                                         // MODERATE_RAIN | HEAVY_RAIN | VERY_HEAVY_RAIN
    "windKmh": 12.3, "humidityPct": 88
  },
  "hydrology": {
    "riverName": "Kali Ciliwung",        // null for coastal/drainage posts
    "waterLevelM": 4.31,
    "normalM": 3.5, "waspadaM": 4.2, "siagaM": 4.7, "awasM": 5.2,
    "levelStatus": "WASPADA",            // NORMAL | WASPADA | SIAGA | AWAS
    "flowRateM3s": 41.2
  },
  "tide": {
    "levelM": 1.24, "phase": "HIGH_TIDE",  // RISING | FALLING | HIGH_TIDE | LOW_TIDE
    "springTide": true, "robRisk": true    // coastal posts only
  },
  "flood": {
    "depthCm": 62.4,
    "status": "SIAGA",                   // NORMAL | REWETAN | WASPADA | SIAGA | AWAS
    "areaHectares": 12.3,
    "durationHours": 4.0,
    "affectedResidents": 640,
    "displacedPersons": 64,
    "shelteredPersons": 41
  },
  "response": {
    "pumpsTotal": 4, "pumpsOnline": 4,
    "pumpStatus": "OVERLOADED",          // OFF | ACTIVE | OVERLOADED
    "evacuationSite": "SDN Manggarai 03"
  },
  "alerts": [                            // threshold-based, may be empty
    { "code": "FLOOD_SIAGA", "severity": "critical",
      "message": "Manggarai flood depth 62.4 cm - SIAGA level",
      "timestamp": "2026-02-20T17:00:00.000Z" }
  ],
  "hasAlert": true
}
```

### Simulation model

- **Monsoon seasonality** — monthly wet-season weight (0.28 dry August … 1.00
  wet February) scales storm frequency and intensity.
- **Storm cells** — spawn per tick (more during the 12:00–21:00 convective
  window), hit one city zone, two zones, or the whole city, and ramp up → peak
  → decay over a 1–4 h envelope. Rare (12 %) extreme events multiply intensity.
- **River response** — gauge level rises with 6 h rain accumulation (lagged),
  relaxes back toward normal, and is pushed up by tidal backwater.
- **Tide (rob)** — semidiurnal lunar tide (12.42 h period) modulated by the
  spring/neap moon cycle; coastal posts flood when the tide tops ~1.15 m.
- **Flood depth** — combines surface ponding (reduced by drainage
  efficiency), river overflow above WASPADA level, and rob overtopping, with
  pumps accelerating recession.
- **Impact estimation** — flooded hectares, affected residents, displaced and
  sheltered persons scale with depth and population density.
- **Alerts** — emitted on thresholds: very heavy rain (≥ 50 mm/h), heavy rain
  (≥ 20 mm/h), river level WASPADA/SIAGA/AWAS, rob tidal flood, flood
  WASPADA/SIAGA/AWAS, and evacuation advisories (depth ≥ 50 cm).

### Determinism

Pass a fixed `seed` (and optionally `startEpochMs`) to get byte-identical
output across runs — handy for tests and fixtures:

```js
new FloodSimulator({ seed: 5, startEpochMs: Date.UTC(2026, 1, 20) }).nextSeries(10)
```

### Verified behaviour

| Scenario | Result |
|----------|--------|
| Output shape | Array of objects (18 per tick) |
| Wet season (Feb), 7-day run | max rain 104 mm/h, max depth 146 cm, all statuses + 10 alert codes observed |
| Dry season (Jul), same seed | mean rain 0.91 mm/h (≈ 5× calmer), max depth 77.5 cm |
| Spring tide (coastal post, full moon) | rob flood alerts triggered |
| Same seed + start time | byte-identical series |
</arg_value>