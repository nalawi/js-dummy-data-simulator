/**
 * floodDataSimulator.js
 * ---------------------------------------------------------------------------
 * Pure JavaScript generator for random, dynamic urban-flood monitoring data
 * for the city of Jakarta, Indonesia. Produces an ARRAY OF OBJECTS (reports)
 * simulating flood monitoring posts (pos pantau banjir) spread across
 * flood-prone kelurahan in the capital's five cities.
 *
 * Each report includes:
 *   - rainfall    : intensity (mm/h), 24 h accumulation, condition, wind,
 *                   humidity - driven by simulated monsoon storm cells with
 *                   Jakarta's typical afternoon/evening convective pattern
 *   - hydrology   : river water level vs BMKG-style thresholds
 *                   (WASPADA < SIAGA < AWAS) for Ciliwung, Cipinang,
 *                   Sunter, Angke, Pesanggrahan, Krukut, Buaran, Cakung...
 *   - tide        : semidiurnal tidal cycle with spring/neap modulation
 *                   (moon phase) causing "rob" tidal floods on the coast
 *   - flood       : water depth (cm), status (NORMAL / REWETAN / WASPADA /
 *                   SIAGA / AWAS), flooded area, duration, affected
 *                   residents, displaced & sheltered persons
 *   - response    : pump status (OFF / ACTIVE / OVERLOADED), evacuation site
 *   - alerts      : threshold-based alert objects (rain, river, rob, flood)
 *
 * Features
 *  - Data-driven station network (18 posts, all 5 Jakarta cities + rivers)
 *  - Realistic dynamics: monsoon seasonality (Nov-Apr wet season), storm
 *    cells with ramp/peak/decay envelopes, rain -> river level lag, tidal
 *    backwater, drainage + pump recession curves
 *  - Random impact estimation scaled by depth (residents, displacement)
 *  - Deterministic output via optional seed (mulberry32 PRNG)
 *  - Zero dependencies. Works in Node.js (CommonJS) and browsers (global).
 *
 * Usage (Node.js)
 *   const { FloodSimulator, generateSnapshot, generateSeries } =
 *     require('./floodDataSimulator');
 *   const sim = new FloodSimulator({ seed: 42 });
 *   const reports = sim.next();           // array of report objects (one tick)
 *   const series  = sim.nextSeries(48);   // flattened reports over time
 *
 * Usage (Browser)
 *   <script src="floodDataSimulator.js"></script>
 *   const reports = FloodDataSimulator.generateSnapshot();
 *
 * CLI demo
 *   node floodDataSimulator.js [ticks] [seed]
 *   node floodDataSimulator.js 3         -> prints 3rd tick as pretty JSON
 *   node floodDataSimulator.js 5 1234    -> reproducible run with seed 1234
 * ---------------------------------------------------------------------------
 */
(function (root, factory) {
  /* istanbul ignore next - UMD wrapper */
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.FloodDataSimulator = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.0';

  /* ------------------------------------------------------------------ *
   *  Random number utilities (seeded, dependency free)
   * ------------------------------------------------------------------ */

  /** mulberry32 - tiny, fast, seedable PRNG. */
  function createRng(seed) {
    var s = (seed == null ? (Date.now() ^ 0x9e3779b9) : seed) >>> 0;
    function next() {
      s |= 0;
      s = (s + 0x6d2b79f5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    return {
      next: next,
      range: function (min, max) { return min + next() * (max - min); },
      int: function (min, max) { return Math.floor(min + next() * (max - min + 1)); },
      gauss: function () { // Box-Muller transform -> normal distribution
        var u = 0, v = 0;
        while (u === 0) u = next();
        while (v === 0) v = next();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      },
      pick: function (arr) { return arr[Math.floor(next() * arr.length)]; },
      chance: function (p) { return next() < p; }
    };
  }

  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  }

  function round(value, precision) {
    var f = Math.pow(10, precision == null ? 1 : precision);
    return Math.round(value * f) / f;
  }

  /* ------------------------------------------------------------------ *
   *  Simulation configuration
   * ------------------------------------------------------------------ */

  var DEFAULTS = {
    seed: null,                        // null -> random each run
    regionName: 'DKI Jakarta',
    tickIntervalMs: 1800000,           // simulated time between reports (30 min)
    startEpochMs: null,                // null -> Date.now() at construction
    stationIds: null,                  // null -> all built-in stations
    stationCount: null,                // null -> all built-in stations
    stormRate: 0.10,                   // base chance a storm cell spawns per tick
    rainWindowTicks: 48                // rolling buffer length (48 x 30 min = 24 h)
  };

  /* ------------------------------------------------------------------ *
   *  Reference data: administrative zones, river thresholds, stations
   * ------------------------------------------------------------------ */

  var CITY_ZONES = ['Jakarta Pusat', 'Jakarta Utara', 'Jakarta Barat',
                    'Jakarta Selatan', 'Jakarta Timur'];

  /** Monsoon weight per month (Jan..Dec). Peak of rainy season: Jan-Feb. */
  var MONTHLY_MONSOON = [0.95, 1.00, 0.85, 0.65, 0.45, 0.30,
                         0.28, 0.30, 0.45, 0.60, 0.80, 0.90];

  /** BMKG-style alert thresholds per river, in meters (gauge datum). */
  var RIVER_THRESHOLDS = {
    'Kali Ciliwung':           { normal: 3.5, waspada: 4.2, siaga: 4.7, awas: 5.2 },
    'Kali Cipinang':           { normal: 2.0, waspada: 2.6, siaga: 2.9, awas: 3.2 },
    'Kali Sunter':             { normal: 2.2, waspada: 2.8, siaga: 3.1, awas: 3.4 },
    'Kali Angke':              { normal: 1.8, waspada: 2.4, siaga: 2.7, awas: 3.0 },
    'Kali Pesanggrahan':       { normal: 2.8, waspada: 3.5, siaga: 3.9, awas: 4.3 },
    'Kali Krukut':             { normal: 2.0, waspada: 2.6, siaga: 2.9, awas: 3.2 },
    'Kali Buaran':             { normal: 1.8, waspada: 2.3, siaga: 2.6, awas: 2.9 },
    'Kali Cakung':             { normal: 1.6, waspada: 2.1, siaga: 2.4, awas: 2.7 },
    'Kali Cengkareng Drain':   { normal: 1.5, waspada: 2.0, siaga: 2.3, awas: 2.6 }
  };

  /**
   * Flood monitoring posts. type: 'river' (riverbank), 'coastal'
   * (rob-prone seafront), 'drainage' (urban drainage bottleneck).
   */
  var STATIONS = [
    { id: 'FMS-01', kelurahan: 'Pluit',              kecamatan: 'Penjaringan',    city: 'Jakarta Utara',  lat: -6.1153, lng: 106.7986, type: 'coastal',  river: null },
    { id: 'FMS-02', kelurahan: 'Penjaringan',        kecamatan: 'Penjaringan',    city: 'Jakarta Utara',  lat: -6.1089, lng: 106.7938, type: 'coastal',  river: null },
    { id: 'FMS-03', kelurahan: 'Kapuk Muara',        kecamatan: 'Penjaringan',    city: 'Jakarta Utara',  lat: -6.1103, lng: 106.7805, type: 'river',    river: 'Kali Angke' },
    { id: 'FMS-04', kelurahan: 'Cilincing',          kecamatan: 'Cilincing',      city: 'Jakarta Utara',  lat: -6.1392, lng: 106.9306, type: 'coastal',  river: null },
    { id: 'FMS-05', kelurahan: 'Rorotan',            kecamatan: 'Cilincing',      city: 'Jakarta Utara',  lat: -6.1556, lng: 106.9529, type: 'river',    river: 'Kali Cakung' },
    { id: 'FMS-06', kelurahan: 'Sunter Agung',       kecamatan: 'Tanjung Priok',  city: 'Jakarta Utara',  lat: -6.1340, lng: 106.8720, type: 'river',    river: 'Kali Sunter' },
    { id: 'FMS-07', kelurahan: 'Kapuk',              kecamatan: 'Cengkareng',     city: 'Jakarta Barat',  lat: -6.1281, lng: 106.7619, type: 'coastal',  river: null },
    { id: 'FMS-08', kelurahan: 'Duri Kosambi',       kecamatan: 'Cengkareng',     city: 'Jakarta Barat',  lat: -6.1439, lng: 106.7389, type: 'river',    river: 'Kali Cengkareng Drain' },
    { id: 'FMS-09', kelurahan: 'Kebon Jeruk',        kecamatan: 'Kebon Jeruk',    city: 'Jakarta Barat',  lat: -6.1944, lng: 106.7680, type: 'river',    river: 'Kali Pesanggrahan' },
    { id: 'FMS-10', kelurahan: 'Kebon Melati',       kecamatan: 'Tanah Abang',    city: 'Jakarta Pusat',  lat: -6.1990, lng: 106.8100, type: 'drainage', river: 'Kali Krukut' },
    { id: 'FMS-11', kelurahan: 'Johar Baru',         kecamatan: 'Johar Baru',     city: 'Jakarta Pusat',  lat: -6.1740, lng: 106.8450, type: 'drainage', river: null },
    { id: 'FMS-12', kelurahan: 'Manggarai',          kecamatan: 'Setiabudi',      city: 'Jakarta Selatan', lat: -6.2120, lng: 106.8520, type: 'river',   river: 'Kali Ciliwung' },
    { id: 'FMS-13', kelurahan: 'Tebet',              kecamatan: 'Tebet',          city: 'Jakarta Selatan', lat: -6.2400, lng: 106.8350, type: 'river',   river: 'Kali Krukut' },
    { id: 'FMS-14', kelurahan: 'Petukangan Selatan', kecamatan: 'Pesanggrahan',   city: 'Jakarta Selatan', lat: -6.2611, lng: 106.7397, type: 'river',   river: 'Kali Pesanggrahan' },
    { id: 'FMS-15', kelurahan: 'Kampung Melayu',     kecamatan: 'Jatinegara',     city: 'Jakarta Timur',  lat: -6.2086, lng: 106.8633, type: 'river',    river: 'Kali Ciliwung' },
    { id: 'FMS-16', kelurahan: 'Cipinang',           kecamatan: 'Jatinegara',     city: 'Jakarta Timur',  lat: -6.2350, lng: 106.8680, type: 'river',    river: 'Kali Cipinang' },
    { id: 'FMS-17', kelurahan: 'Buaran',             kecamatan: 'Duren Sawit',    city: 'Jakarta Timur',  lat: -6.2490, lng: 106.8900, type: 'river',    river: 'Kali Buaran' },
    { id: 'FMS-18', kelurahan: 'Cakung Timur',       kecamatan: 'Cakung',         city: 'Jakarta Timur',  lat: -6.1760, lng: 106.9500, type: 'river',    river: 'Kali Cakung' }
  ];

  var SHELTER_TYPES = ['SDN', 'SMPN', 'Balai Warga', 'Masjid', 'Gereja',
                       'Gedung Olahraga', 'Polsek'];

  /** Rain intensity classification (per-hour, mm). */
  function rainCondition(mm) {
    if (mm < 0.5) return 'CLEAR';
    if (mm < 2.5) return 'DRIZZLE';
    if (mm < 10) return 'LIGHT_RAIN';
    if (mm < 25) return 'MODERATE_RAIN';
    if (mm < 50) return 'HEAVY_RAIN';
    return 'VERY_HEAVY_RAIN';
  }

  /** Flood status from standing-water depth in cm. */
  function floodStatus(depthCm) {
    if (depthCm <= 0) return 'NORMAL';
    if (depthCm <= 20) return 'REWETAN';   // standing water / wet
    if (depthCm <= 50) return 'WASPADA';   // alert
    if (depthCm <= 100) return 'SIAGA';    // standby
    return 'AWAS';                         // emergency
  }

  /** River level status vs thresholds. */
  function riverStatus(level, th) {
    if (level >= th.awas) return 'AWAS';
    if (level >= th.siaga) return 'SIAGA';
    if (level >= th.waspada) return 'WASPADA';
    return 'NORMAL';
  }

  /* ------------------------------------------------------------------ *
   *  Astronomical / climatic helpers
   * ------------------------------------------------------------------ */

  /** Monsoon weight for a date (0.28 dry Aug .. 1.00 wet Feb). */
  function monsoonFactor(date) {
    return MONTHLY_MONSOON[date.getMonth()];
  }

  /** Diurnal convective factor: Jakarta rain peaks in the afternoon/evening. */
  function diurnalFactor(hour) {
    if (hour >= 12 && hour <= 21) return 1.5;
    if (hour >= 6 && hour < 12) return 1.0;
    return 0.35;
  }

  /** Spring-tide factor (0.75 neap .. 1.25 spring) from moon phase. */
  function springTideFactor(epochMs) {
    var SYNODIC_MS = 29.53058867 * 24 * 3600 * 1000;
    var refNewMoon = 947182440000;          // 2000-01-06 18:14 UTC new moon
    var phase = ((epochMs - refNewMoon) % SYNODIC_MS) / SYNODIC_MS; // 0..1
    if (phase < 0) phase += 1;
    return 0.75 + 0.5 * Math.abs(Math.cos(2 * Math.PI * phase));
  }

  /**
   * Jakarta semidiurnal tide: main lunar constituent (period 12.42 h),
   * mean sea level 0.55 m, amplitude modulated by spring/neap cycle.
   * Rob (tidal) floods hit coastal North Jakarta around 1.2 m and above.
   */
  function tideLevel(epochMs, spring) {
    var hours = epochMs / 3600000;
    var level = 0.55 + 0.55 * spring * Math.sin((2 * Math.PI * hours) / 12.42);
    return level;
  }

  function tidePhase(level, epochMs) {
    var hours = epochMs / 3600000;
    var slope = Math.cos((2 * Math.PI * hours) / 12.42); // derivative sign
    if (slope > 0.3) return 'RISING';
    if (slope < -0.3) return 'FALLING';
    return level > 0.75 ? 'HIGH_TIDE' : 'LOW_TIDE';
  }

  /* ------------------------------------------------------------------ *
   *  Station (stateful simulated monitoring post)
   * ------------------------------------------------------------------ */

  function Station(cfg, sim) {
    this.sim = sim;
    this.rng = sim.rng;
    this.meta = cfg;

    // Per-station physical constants (drawn once, keep station "personality")
    this.riverCoef = this.rng.range(0.015, 0.025);   // m rise per mm of 6 h rain
    this.drainageEff = this.meta.type === 'drainage'
      ? this.rng.range(0.35, 0.60)
      : this.meta.type === 'coastal' ? this.rng.range(0.45, 0.70)
                                     : this.rng.range(0.50, 0.80);
    this.floodProneFactor = this.rng.range(0.8, 1.2);
    this.coastalExposure = this.meta.type === 'coastal'
      ? this.rng.range(0.75, 1.0) : this.rng.range(0.2, 0.5);
    this.floodProneHa = round(this.meta.type === 'coastal'
      ? this.rng.range(15, 45) : this.rng.range(5, 30), 0);
    this.densityPerHa = round(this.rng.range(180, 420), 0);
    this.baseFlowM3s = round(this.rng.range(4, 25), 1);
    this.pumpsTotal = this.rng.int(2, 6);
    this.evacuationSite = this.rng.pick(SHELTER_TYPES) + ' ' +
                          cfg.kelurahan + ' ' + String(this.rng.int(1, 8)).padStart(2, '0');

    // Dynamic state
    var th = cfg.river ? RIVER_THRESHOLDS[cfg.river] : null;
    this.riverLevelM = th ? th.normal : 0;
    this.depthCm = 0;
    this.floodedTicks = 0;
    this.rainBuffer = [];
    for (var i = 0; i < sim.options.rainWindowTicks; i++) this.rainBuffer.push(0);
  }

  /** Advance the post by one tick and return a report object. */
  Station.prototype.tick = function (ctx) {
    var rng = this.rng;
    var opts = this.sim.options;
    var cfg = this.meta;
    var th = cfg.river ? RIVER_THRESHOLDS[cfg.river] : null;
    var report = {
      id: 'FLD-' + String(this.sim.nextReportId()).padStart(6, '0'),
      timestamp: ctx.timestamp,
      epochMs: ctx.epochMs,
      region: this.sim.options.regionName,
      stationId: cfg.id,
      stationName: 'Pos Pantau Banjir ' + cfg.kelurahan,
      location: {
        latitude: cfg.lat,
        longitude: cfg.lng,
        kelurahan: cfg.kelurahan,
        kecamatan: cfg.kecamatan,
        city: cfg.city,
        zoneType: cfg.type
      },
      rainfall: {},
      hydrology: {},
      tide: {},
      flood: {},
      response: {},
      alerts: [],
      hasAlert: false
    };

    /* --- 1. rainfall from active storm cells + background drizzle --- */
    var rain = 0;
    for (var i = 0; i < this.sim.storms.length; i++) {
      var storm = this.sim.storms[i];
      if (storm.zone !== 'ALL' && storm.zone !== cfg.city) continue;
      var elapsed = clamp(storm.duration - storm.ticksLeft, 0, storm.duration);
      var envelope = Math.pow(Math.max(0, Math.sin((Math.PI * elapsed) / storm.duration)), 0.7);
      rain += storm.intensity * envelope * (0.55 + rng.next() * 0.5);
    }
    if (rain < 1 && rng.chance(0.35 * ctx.monsoon)) rain += rng.range(0.2, 3);
    rain = clamp(rain, 0, 120);

    // Rolling accumulation (each tick is 30 min -> mm per tick = rain * 0.5)
    this.rainBuffer.push(rain * 0.5);
    if (this.rainBuffer.length > opts.rainWindowTicks) this.rainBuffer.shift();
    var rain24h = 0, rain6h = 0;
    for (var b = 0; b < this.rainBuffer.length; b++) rain24h += this.rainBuffer[b];
    for (var b6 = this.rainBuffer.length - 12; b6 < this.rainBuffer.length; b6++) {
      if (b6 >= 0) rain6h += this.rainBuffer[b6];
    }

    var windKmh = round(rng.range(2, 14) + rain * 0.15, 1);
    var humidity = round(clamp(62 + rain * 0.5 + rng.gauss() * 4, 55, 98), 0);

    /* --- 2. tide (shared cycle, local noise) ------------------------- */
    var tideM = round(ctx.tideLevel + rng.gauss() * 0.03, 2);

    /* --- 3. river level: rain accumulation + tidal backwater --------- */
    var tideBack = Math.max(0, ctx.tideLevel - 0.9) * this.coastalExposure;
    if (th) {
      var target = th.normal + rain6h * this.riverCoef + tideBack;
      this.riverLevelM += (target - this.riverLevelM) * 0.25 + rng.gauss() * 0.02;
      this.riverLevelM = clamp(this.riverLevelM, th.normal - 0.6, th.awas + 1.4);
    }
    var flowM3s = th
      ? round(this.baseFlowM3s *
          clamp(this.riverLevelM / th.normal, 0.3, 3.2) * (0.9 + rng.next() * 0.2), 1)
      : 0;

    /* --- 4. flood depth: ponding + overflow + rob, with recession ---- */
    var pondingCm = clamp(rain * 0.4, 0, 30) * (1.55 - this.drainageEff);
    var overflowCm = th ? Math.max(0, this.riverLevelM - th.waspada) * 55 : 0;
    var robCm = Math.max(0, ctx.tideLevel - 1.15) * 85 * this.coastalExposure;
    var targetDepth = (pondingCm + overflowCm + robCm) * this.floodProneFactor;

    var pumpsOnline = (this.depthCm >= 5 || rain >= 5) ? this.pumpsTotal : 0;
    if (targetDepth > this.depthCm) {
      this.depthCm += (targetDepth - this.depthCm) * 0.35 + rng.gauss() * 0.3;
    } else {
      var pumpBonus = pumpsOnline * (rain < 3 ? 1.8 : 0.5);
      var drain = (this.depthCm - targetDepth) * 0.2 + pumpBonus;
      this.depthCm = Math.max(targetDepth, this.depthCm - drain);
    }
    this.depthCm = clamp(this.depthCm, 0, 400);

    /* --- 5. status + impact estimation -------------------------------- */
    var depth = round(this.depthCm, 1);
    var status = floodStatus(depth);
    if (depth >= 10) this.floodedTicks++; else this.floodedTicks = 0;

    var floodedHa = 0, affected = 0, displaced = 0, sheltered = 0;
    if (depth >= 10) {
      floodedHa = this.floodProneHa * clamp(depth / 60, 0.08, 1);
      affected = Math.round(floodedHa * this.densityPerHa *
                            clamp(depth / 80, 0.1, 1.5) * (0.85 + rng.next() * 0.3));
      var dispFrac = depth >= 100 ? 0.22 : depth >= 50 ? 0.10 : depth >= 20 ? 0.03 : 0;
      displaced = Math.round(affected * dispFrac * (0.8 + rng.next() * 0.4));
      sheltered = Math.round(displaced * rng.range(0.4, 0.8));
    }

    var pumpStatus = pumpsOnline === 0 ? 'OFF'
      : (rain >= 20 && depth >= 50) ? 'OVERLOADED' : 'ACTIVE';

    /* --- 6. assemble report sections ---------------------------------- */
    report.rainfall = {
      intensityMmPerHour: round(rain, 1),
      last24hMm: round(rain24h, 1),
      condition: rainCondition(rain),
      windKmh: windKmh,
      humidityPct: humidity
    };

    report.hydrology = {
      riverName: cfg.river,
      waterLevelM: th ? round(this.riverLevelM, 2) : round(tideM, 2),
      normalM: th ? th.normal : null,
      waspadaM: th ? th.waspada : null,
      siagaM: th ? th.siaga : null,
      awasM: th ? th.awas : null,
      levelStatus: th ? riverStatus(this.riverLevelM, th)
                      : (tideM >= 1.4 ? 'SIAGA' : tideM >= 1.2 ? 'WASPADA' : 'NORMAL'),
      flowRateM3s: flowM3s
    };

    report.tide = {
      levelM: round(tideM, 2),
      phase: tidePhase(ctx.tideLevel, ctx.epochMs),
      springTide: ctx.spring,
      robRisk: cfg.type === 'coastal' && ctx.tideLevel >= 1.2
    };

    report.flood = {
      depthCm: depth,
      status: status,
      areaHectares: round(floodedHa, 1),
      durationHours: round(this.floodedTicks * (opts.tickIntervalMs / 3600000), 1),
      affectedResidents: affected,
      displacedPersons: displaced,
      shelteredPersons: sheltered
    };

    report.response = {
      pumpsTotal: this.pumpsTotal,
      pumpsOnline: pumpsOnline,
      pumpStatus: pumpStatus,
      evacuationSite: displaced > 0 ? this.evacuationSite : null
    };

    report.alerts = this.buildAlerts(rain, depth, th, tideM);
    report.hasAlert = report.alerts.length > 0;
    return report;
  };

  /** Threshold-based alert builder for the current station state. */
  Station.prototype.buildAlerts = function (rain, depth, th, tideM) {
    var alerts = [];
    var ts = this.sim.currentTimestamp;

    if (rain >= 50) {
      alerts.push({ code: 'VERY_HEAVY_RAIN', severity: 'critical',
        message: this.meta.kelurahan + ' very heavy rain: ' + round(rain, 1) +
                 ' mm/h (BMKG extreme threshold 50 mm/h)', timestamp: ts });
    } else if (rain >= 20) {
      alerts.push({ code: 'HEAVY_RAIN', severity: 'warning',
        message: this.meta.kelurahan + ' heavy rain: ' + round(rain, 1) +
                 ' mm/h (threshold 20 mm/h)', timestamp: ts });
    }

    if (th) {
      var status = riverStatus(this.riverLevelM, th);
      if (status === 'AWAS') {
        alerts.push({ code: 'RIVER_LEVEL_AWAS', severity: 'critical',
          message: this.meta.river + ' at ' + round(this.riverLevelM, 2) +
                   ' m - AWAS (emergency) level, overflow imminent', timestamp: ts });
      } else if (status === 'SIAGA') {
        alerts.push({ code: 'RIVER_LEVEL_SIAGA', severity: 'critical',
          message: this.meta.river + ' at ' + round(this.riverLevelM, 2) +
                   ' m - SIAGA (standby) level', timestamp: ts });
      } else if (status === 'WASPADA') {
        alerts.push({ code: 'RIVER_LEVEL_WASPADA', severity: 'warning',
          message: this.meta.river + ' at ' + round(this.riverLevelM, 2) +
                   ' m - WASPADA (alert) level', timestamp: ts });
      }
    }

    if (this.meta.type === 'coastal' && tideM >= 1.2 && depth > 0) {
      alerts.push({ code: 'ROB_TIDAL_FLOOD', severity: depth >= 50 ? 'critical' : 'warning',
        message: 'Rob tidal flood at ' + this.meta.kelurahan + ' seawall: tide ' +
                 round(tideM, 2) + ' m, water depth ' + depth + ' cm', timestamp: ts });
    }

    if (depth > 100) {
      alerts.push({ code: 'FLOOD_AWAS', severity: 'critical',
        message: this.meta.kelurahan + ' flood depth ' + depth +
                 ' cm - AWAS level, evacuation advised', timestamp: ts });
    } else if (depth > 50) {
      alerts.push({ code: 'FLOOD_SIAGA', severity: 'critical',
        message: this.meta.kelurahan + ' flood depth ' + depth +
                 ' cm - SIAGA level', timestamp: ts });
    } else if (depth > 20) {
      alerts.push({ code: 'FLOOD_WASPADA', severity: 'warning',
        message: this.meta.kelurahan + ' flood depth ' + depth +
                 ' cm - WASPADA level', timestamp: ts });
    }

    if (depth >= 50) {
      alerts.push({ code: 'EVACUATION_ADVISORY', severity: 'warning',
        message: this.meta.kelurahan + ' residents advised to move to ' +
                 this.evacuationSite, timestamp: ts });
    }
    return alerts;
  };

  /* ------------------------------------------------------------------ *
   *  Simulator
   * ------------------------------------------------------------------ */

  function FloodSimulator(options) {
    var opts = {};
    for (var k in DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) opts[k] = DEFAULTS[k];
    }
    if (options) {
      for (var k2 in options) {
        if (Object.prototype.hasOwnProperty.call(options, k2)) opts[k2] = options[k2];
      }
    }
    this.options = opts;
    this.rng = createRng(opts.seed);
    this.startEpochMs = opts.startEpochMs != null ? opts.startEpochMs : Date.now();
    this.tickIndex = 0;
    this.reportCounter = 0;
    this.storms = [];
    this.currentTimestamp = null;

    var pool = STATIONS;
    if (opts.stationIds) {
      pool = STATIONS.filter(function (s) { return opts.stationIds.indexOf(s.id) !== -1; });
    }
    if (opts.stationCount != null) pool = pool.slice(0, Math.max(0, opts.stationCount));
    if (!pool.length) throw new Error('No stations selected. Valid ids: ' +
                                     STATIONS.map(function (s) { return s.id; }).join(', '));

    this.stations = pool.map(function (cfg) { return new Station(cfg, this); }, this);
  }

  /** Build shared context (clock, monsoon, tide) for a tick. */
  FloodSimulator.prototype.context = function (tickIndex) {
    var epochMs = this.startEpochMs + tickIndex * this.options.tickIntervalMs;
    var date = new Date(epochMs);
    var monsoon = monsoonFactor(date);
    var spring = springTideFactor(epochMs);
    return {
      tickIndex: tickIndex,
      epochMs: epochMs,
      timestamp: date.toISOString(),
      hour: date.getHours(),
      monsoon: monsoon,
      spring: spring > 1.05,
      tideLevel: round(tideLevel(epochMs, spring) + this.rng.gauss() * 0.02, 3)
    };
  };

  /** Spawn new storm cells and retire expired ones. */
  FloodSimulator.prototype.updateWeather = function (ctx) {
    var rng = this.rng;

    // Retire finished storms
    this.storms = this.storms.filter(function (s) { return --s.ticksLeft > 0; });

    // Spawn: monsoon-modulated, boosted during afternoon convective window
    var rate = this.options.stormRate * ctx.monsoon * diurnalFactor(ctx.hour);
    if (this.storms.length < 6 && rng.chance(rate)) {
      var roll = rng.next();
      var zones = roll < 0.15 ? ['ALL']
                : roll < 0.80 ? [rng.pick(CITY_ZONES)]
                : [rng.pick(CITY_ZONES), rng.pick(CITY_ZONES)];
      for (var i = 0; i < zones.length; i++) {
        var intensity = rng.range(8, 45) * (0.7 + 0.6 * ctx.monsoon);
        if (rng.chance(0.12)) intensity *= 1.8;      // mesoscale extreme event
        var dur = rng.int(2, 8);                     // 1-4 h at 30-min ticks
        this.storms.push({
          id: 'STORM-' + String(this.tickIndex).padStart(4, '0') + '-' + (i + 1),
          zone: zones[i],
          intensity: clamp(intensity, 5, 110),       // peak mm/h
          duration: dur,
          ticksLeft: dur                             // start at envelope peak ramp
        });
      }
    }
  };

  FloodSimulator.prototype.nextReportId = function () {
    return ++this.reportCounter;
  };

  /** Generate one tick -> array of report objects (one per station). */
  FloodSimulator.prototype.next = function () {
    var ctx = this.context(this.tickIndex);
    this.currentTimestamp = ctx.timestamp;
    this.updateWeather(ctx);
    var reports = [];
    for (var i = 0; i < this.stations.length; i++) {
      reports.push(this.stations[i].tick(ctx));
    }
    this.tickIndex++;
    return reports;
  };

  /** Generate `ticks` ticks -> flat array of all reports over time. */
  FloodSimulator.prototype.nextSeries = function (ticks) {
    var out = [];
    ticks = Math.max(1, ticks | 0);
    for (var t = 0; t < ticks; t++) {
      var batch = this.next();
      for (var i = 0; i < batch.length; i++) out.push(batch[i]);
    }
    return out;
  };

  /** Station catalogue (id, name, location, river, alert thresholds). */
  FloodSimulator.prototype.getStationCatalog = function () {
    return this.stations.map(function (s) {
      var th = s.meta.river ? RIVER_THRESHOLDS[s.meta.river] : null;
      return {
        id: s.meta.id,
        stationName: 'Pos Pantau Banjir ' + s.meta.kelurahan,
        location: {
          kelurahan: s.meta.kelurahan,
          kecamatan: s.meta.kecamatan,
          city: s.meta.city,
          latitude: s.meta.lat,
          longitude: s.meta.lng,
          zoneType: s.meta.type
        },
        river: s.meta.river,
        thresholds: th,
        pumpsTotal: s.pumpsTotal,
        floodProneHectares: s.floodProneHa
      };
    });
  };

  /* ------------------------------------------------------------------ *
   *  One-shot convenience helpers
   * ------------------------------------------------------------------ */

  /** Single snapshot: array of report objects for one instant. */
  function generateSnapshot(options) {
    return new FloodSimulator(options).next();
  }

  /** Time series: flat array of reports across `ticks` ticks. */
  function generateSeries(ticks, options) {
    return new FloodSimulator(options).nextSeries(ticks);
  }

  return {
    version: VERSION,
    FloodSimulator: FloodSimulator,
    generateSnapshot: generateSnapshot,
    generateSeries: generateSeries,
    STATIONS: STATIONS,
    CITY_ZONES: CITY_ZONES,
    RIVER_THRESHOLDS: RIVER_THRESHOLDS,
    DEFAULT_OPTIONS: DEFAULTS
  };
});

/* ------------------------------------------------------------------------ *
 * CLI demo: `node floodDataSimulator.js [ticks] [seed]`  -> pretty JSON
 * ------------------------------------------------------------------------ */
if (typeof module !== 'undefined' && module.exports && require.main === module) {
  var ticks = Math.max(1, parseInt(process.argv[2], 10) || 3);
  var seedArg = process.argv[3] !== undefined ? Number(process.argv[3]) : undefined;
  var SimulatorMod = module.exports;
  var simulator = new SimulatorMod.FloodSimulator({
    seed: isNaN(seedArg) ? undefined : seedArg
  });
  var reports = null;
  for (var t = 0; t < ticks; t++) reports = simulator.next();
  console.log(JSON.stringify(reports, null, 2));
}