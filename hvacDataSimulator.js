/**
 * hvacDataSimulator.js
 * ---------------------------------------------------------------------------
 * Pure JavaScript generator for random, dynamic building HVAC monitoring
 * data. Produces an ARRAY OF OBJECTS (readings) simulating sensors mounted
 * on typical HVAC plant: Air Handling Units, Chillers, Boilers, VAV zone
 * terminals and Exhaust Fans.
 *
 * Features
 *  - Data-driven metric templates per equipment type (unit, range, alarms).
 *  - Realistic dynamics: values drift toward targets (random walk + pull),
 *    outdoor temperature follows a diurnal curve, occupancy schedule drives
 *    RUNNING / IDLE states, cumulative energy & runtime counters.
 *  - Random fault injection with latched FAULT state + critical alarms.
 *  - Deterministic output via optional seed (mulberry32 PRNG).
 *  - Zero dependencies. Works in Node.js (CommonJS) and browsers (global).
 *
 * Usage (Node.js)
 *   const { HVACSimulator, generateSnapshot, generateSeries } = require('./hvacDataSimulator');
 *   const sim = new HVACSimulator({ seed: 42 });
 *   const readings = sim.next();          // array of reading objects (one tick)
 *   const series  = sim.nextSeries(24 * 4); // flattened readings over time
 *
 * Usage (Browser)
 *   <script src="hvacDataSimulator.js"></script>
 *   const readings = HVACDataSimulator.generateSnapshot();
 *
 * CLI demo
 *   node hvacDataSimulator.js [ticks] [seed]
 *   node hvacDataSimulator.js 3          -> prints 3rd tick as pretty JSON
 *   node hvacDataSimulator.js 5 1234     -> reproducible run with seed 1234
 * ---------------------------------------------------------------------------
 */
(function (root, factory) {
  /* istanbul ignore next - UMD wrapper */
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.HVACDataSimulator = factory();
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

  function toSnakeUpper(key) {
    return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
  }

  /* ------------------------------------------------------------------ *
   *  Simulation configuration
   * ------------------------------------------------------------------ */

  var DEFAULTS = {
    seed: null,                                   // null -> random each run
    buildingId: 'BLD-001',
    buildingName: 'Simulated HQ Tower',
    floors: 6,
    // Equipment population per type inside the building
    equipment: { AHU: 3, CHILLER: 2, BOILER: 1, VAV: 8, EXHAUST_FAN: 3 },
    faultRate: 0.02,          // probability per running equipment per tick
    tickIntervalMs: 60000,    // simulated time between readings (1 min)
    startEpochMs: null,       // null -> Date.now() at construction
    occupiedHours: { start: 7, end: 19 },         // local building hours
    workdays: [1, 2, 3, 4, 5],                    // Mon..Fri
    climate: { baseTempC: 24, amplitudeC: 6 }     // diurnal outdoor curve
  };

  var EQUIPMENT_CONFIG = {
    AHU: {
      label: 'Air Handling Unit',
      shouldRun: function (state, ctx) { return ctx.occupied; }
    },
    CHILLER: {
      label: 'Water-Cooled Chiller',
      shouldRun: function (state, ctx) { return ctx.occupied || ctx.outdoorTemp > 26; }
    },
    BOILER: {
      label: 'Hot Water Boiler',
      shouldRun: function (state, ctx) { return ctx.outdoorTemp < 18; }
    },
    VAV: {
      label: 'VAV Zone Terminal',
      shouldRun: function (state, ctx) { return ctx.occupied; }
    },
    EXHAUST_FAN: {
      label: 'Exhaust Fan',
      shouldRun: function (state, ctx) { return ctx.occupied; }
    }
  };

  /* ------------------------------------------------------------------ *
   *  Metric templates (data-driven generation per equipment type)
   *  target: number | function(state, ctx) -> desired value
   *  pull:   0..1  how fast the value converges to its target per tick
   *  noise:  gaussian jitter applied every tick
   * ------------------------------------------------------------------ */

  var METRIC_TEMPLATES = {
    AHU: [
      { key: 'returnAirTemp', label: 'Return air temperature', unit: '\u00B0C',
        min: 5, max: 45, precision: 1, noise: 0.2, pull: 0.3,
        target: function (s, c) { return c.occupied ? 22.5 : 19; } },
      { key: 'outdoorAirTemp', label: 'Outdoor air temperature', unit: '\u00B0C',
        min: -20, max: 55, precision: 1, noise: 0.15, pull: 0.6,
        target: function (s, c) { return c.outdoorTemp; } },
      { key: 'mixedAirTemp', label: 'Mixed air temperature', unit: '\u00B0C',
        min: -20, max: 55, precision: 1, noise: 0.2, pull: 0.4,
        target: function (s, c) {
          var ret = s.values.returnAirTemp != null ? s.values.returnAirTemp : 21;
          return 0.25 * c.outdoorTemp + 0.75 * ret;
        } },
      { key: 'supplyAirTemp', label: 'Supply air temperature', unit: '\u00B0C',
        min: 2, max: 40, precision: 1, noise: 0.25, pull: 0.35,
        alarmLow: 4, alarmHigh: 16,
        target: function (s, c) {
          return s.isRunning ? 12.5 + (c.outdoorTemp > 32 ? 0.8 : 0)
                             : c.outdoorTemp * 0.6 + 8;
        } },
      { key: 'relativeHumidity', label: 'Return air humidity', unit: '%',
        min: 0, max: 100, precision: 1, noise: 0.8, pull: 0.2,
        target: function (s, c) { return c.occupied ? 46 : 55; } },
      { key: 'supplyFanSpeed', label: 'Supply fan speed', unit: '%',
        min: 0, max: 100, precision: 1, noise: 0.6, pull: 0.4,
        target: function (s, c) {
          return s.isRunning ? 82 + Math.sin(c.hour / 2) * 4 : 0;
        } },
      { key: 'airflowCfm', label: 'Supply airflow', unit: 'm\u00B3/h',
        min: 0, max: 20000, precision: 0, noise: 40, pull: 0.4,
        target: function (s) { return (s.values.supplyFanSpeed / 100) * 14500; } },
      { key: 'ductStaticPressure', label: 'Duct static pressure', unit: 'in. w.g.',
        min: 0, max: 3, precision: 2, noise: 0.01, pull: 0.4,
        target: function (s) {
          return 0.25 + Math.pow(s.values.supplyFanSpeed / 100, 2) * 1.35;
        } },
      { key: 'filterPressureDrop', label: 'Filter differential pressure', unit: 'in. w.g.',
        min: 0, max: 2, precision: 2, noise: 0.004, pull: 0.5,
        alarmHigh: 1.2, resetAt: 1.5, resetTo: 0.45,   // auto "filter change"
        seed: 0.45,                                    // initial filter loading
        target: function (s) {
          return s.isRunning ? s.values.filterPressureDrop + 0.02 : s.values.filterPressureDrop;
        } },
      { key: 'coolingValvePosition', label: 'Cooling coil valve position', unit: '%',
        min: 0, max: 100, precision: 1, noise: 1.2, pull: 0.35,
        target: function (s, c) {
          return s.isRunning ? clamp((c.outdoorTemp - 20) * 6, 25, 95) : 0;
        } },
      { key: 'powerKw', label: 'Electrical power', unit: 'kW',
        min: 0, max: 80, precision: 2, noise: 0.15, pull: 0.4,
        target: function (s) {
          var fan = Math.pow(s.values.supplyFanSpeed / 100, 3) * 30; // affinity law
          return fan + (s.values.coolingValvePosition / 100) * 6;
        } }
    ],

    CHILLER: [
      { key: 'chilledWaterSupplyTemp', label: 'Chilled water supply temp', unit: '\u00B0C',
        min: 2, max: 20, precision: 1, noise: 0.15, pull: 0.4, alarmHigh: 10,
        target: function (s, c) {
          return s.isRunning ? 6.8 + (c.outdoorTemp > 33 ? 0.5 : 0) : 15;
        } },
      { key: 'chilledWaterReturnTemp', label: 'Chilled water return temp', unit: '\u00B0C',
        min: 2, max: 25, precision: 1, noise: 0.2, pull: 0.4,
        target: function (s) {
          var load = s.values.compressorLoad != null ? s.values.compressorLoad : 60;
          return s.values.chilledWaterSupplyTemp +
                 (s.isRunning ? 3.5 + (load / 100) * 3 : 0.5);
        } },
      { key: 'condenserWaterSupplyTemp', label: 'Condenser water supply temp', unit: '\u00B0C',
        min: 10, max: 45, precision: 1, noise: 0.2, pull: 0.4,
        target: function (s, c) { return Math.max(18, c.outdoorTemp - 6); } },
      { key: 'condenserWaterReturnTemp', label: 'Condenser water return temp', unit: '\u00B0C',
        min: 10, max: 50, precision: 1, noise: 0.25, pull: 0.4,
        target: function (s) { return s.values.condenserWaterSupplyTemp + 5.5; } },
      { key: 'compressorLoad', label: 'Compressor load', unit: '%',
        min: 0, max: 100, precision: 1, noise: 1.5, pull: 0.35,
        target: function (s, c) {
          return s.isRunning ? clamp(50 + (c.outdoorTemp - 24) * 4, 25, 96) : 0;
        } },
      { key: 'cop', label: 'Coefficient of performance', unit: 'kW/kW',
        min: 1.5, max: 7, precision: 2, noise: 0.05, pull: 0.3,
        target: function (s, c) {
          return clamp(5.2 - Math.max(0, c.outdoorTemp - 24) * 0.09, 2.6, 5.2);
        } },
      { key: 'powerKw', label: 'Electrical power', unit: 'kW',
        min: 0, max: 600, precision: 1, noise: 1.5, pull: 0.4,
        target: function (s) {
          var cop = Math.max(2, s.values.cop != null ? s.values.cop : 4.5);
          return (s.values.compressorLoad / 100) * 320 / cop;
        } }
    ],

    BOILER: [
      { key: 'hotWaterSupplyTemp', label: 'Hot water supply temp', unit: '\u00B0C',
        min: 15, max: 95, precision: 1, noise: 0.3, pull: 0.3, alarmHigh: 85,
        target: function (s, c) {
          var demand = Math.max(0, 16 - c.outdoorTemp);
          return s.isRunning ? clamp(58 + demand * 1.6, 58, 82) : 42;
        } },
      { key: 'hotWaterReturnTemp', label: 'Hot water return temp', unit: '\u00B0C',
        min: 15, max: 90, precision: 1, noise: 0.3, pull: 0.3,
        target: function (s) { return s.values.hotWaterSupplyTemp - 11; } },
      { key: 'burnerFiringRate', label: 'Burner firing rate', unit: '%',
        min: 0, max: 100, precision: 1, noise: 1.5, pull: 0.35,
        target: function (s, c) {
          return s.isRunning
            ? clamp(30 + Math.max(0, 16 - c.outdoorTemp) * 5, 15, 92) : 0;
        } },
      { key: 'flueGasTemp', label: 'Flue gas temperature', unit: '\u00B0C',
        min: 20, max: 300, precision: 1, noise: 1.2, pull: 0.3, alarmHigh: 250,
        target: function (s) {
          return 120 + (s.values.burnerFiringRate != null ? s.values.burnerFiringRate : 0) * 0.7;
        } },
      { key: 'powerKw', label: 'Thermal output', unit: 'kW',
        min: 0, max: 600, precision: 1, noise: 1.0, pull: 0.35,
        target: function (s) {
          return ((s.values.burnerFiringRate != null ? s.values.burnerFiringRate : 0) / 100) * 420;
        } }
    ],

    VAV: [
      { key: 'zoneSetpoint', label: 'Zone setpoint', unit: '\u00B0C',
        min: 15, max: 30, precision: 1, noise: 0.05, pull: 0.5,
        target: function (s, c) { return c.occupied ? 22 : 26.5; } },
      { key: 'zoneTemp', label: 'Zone temperature', unit: '\u00B0C',
        min: 5, max: 40, precision: 1, noise: 0.15, pull: 0.2, alarmHigh: 27,
        target: function (s, c) {
          return s.isRunning ? s.values.zoneSetpoint + 0.3
                             : c.outdoorTemp * 0.4 + 15;
        } },
      { key: 'supplyAirTemp', label: 'Supply air temperature', unit: '\u00B0C',
        min: 2, max: 40, precision: 1, noise: 0.2, pull: 0.5,
        target: function (s) { return s.isRunning ? 13 : 20; } },
      { key: 'damperPosition', label: 'Damper position', unit: '%',
        min: 0, max: 100, precision: 1, noise: 1.5, pull: 0.35,
        target: function (s) {
          if (!s.isRunning) return 0;
          var err = s.values.zoneTemp - s.values.zoneSetpoint;
          return clamp(30 + err * 45, 10, 100); // simple proportional control
        } },
      { key: 'airflowCfm', label: 'Zone airflow', unit: 'm\u00B3/h',
        min: 0, max: 2500, precision: 0, noise: 15, pull: 0.4,
        target: function (s) { return (s.values.damperPosition / 100) * 950; } },
      { key: 'co2Ppm', label: 'Room CO2 concentration', unit: 'ppm',
        min: 350, max: 2000, precision: 0, noise: 12, pull: 0.25, alarmHigh: 1100,
        target: function (s) {
          return s.isRunning ? 480 + s.occupantCount * 45 : 420;
        } },
      { key: 'occupancyCount', label: 'Occupancy count', unit: 'persons',
        min: 0, max: 30, precision: 0, noise: 0.3, pull: 0.4,
        target: function (s, c) { return c.occupied ? s.occupantCount : 0; } }
    ],

    EXHAUST_FAN: [
      { key: 'fanSpeed', label: 'Fan speed', unit: '%',
        min: 0, max: 100, precision: 1, noise: 0.5, pull: 0.4,
        target: function (s) { return s.isRunning ? 78 : 0; } },
      { key: 'airflowCfm', label: 'Exhaust airflow', unit: 'm\u00B3/h',
        min: 0, max: 8000, precision: 0, noise: 25, pull: 0.4,
        target: function (s) { return (s.values.fanSpeed / 100) * 6200; } },
      { key: 'ductStaticPressure', label: 'Duct static pressure', unit: 'in. w.g.',
        min: 0, max: 2, precision: 2, noise: 0.008, pull: 0.4,
        target: function (s) {
          return 0.2 + Math.pow(s.values.fanSpeed / 100, 2) * 1.1;
        } },
      { key: 'vibrationMmS', label: 'Vibration velocity RMS', unit: 'mm/s',
        min: 0, max: 12, precision: 2, noise: 0.15, pull: 0.3, alarmHigh: 7.1,
        target: function (s) {
          return 2.2 + Math.pow(s.values.fanSpeed / 100, 2) * 2.2;
        } },
      { key: 'powerKw', label: 'Electrical power', unit: 'kW',
        min: 0, max: 15, precision: 2, noise: 0.05, pull: 0.4,
        target: function (s) { return Math.pow(s.values.fanSpeed / 100, 3) * 7.5; } }
    ]
  };

  /* ------------------------------------------------------------------ *
   *  Equipment (stateful simulated device)
   * ------------------------------------------------------------------ */

  function Equipment(cfg, sim) {
    this.sim = sim;
    this.rng = sim.rng;
    this.id = cfg.id;
    this.name = cfg.name;
    this.type = cfg.type;
    this.floor = cfg.floor;
    this.zone = cfg.zone;
    this.metrics = METRIC_TEMPLATES[cfg.type];
    this.occupantCount = cfg.occupantCount;
    this.runtimeHours = round(this.rng.range(2000, 26000), 1);
    this.energyKwh = round(this.rng.range(500, 90000), 2);
    this.faultTicksRemaining = 0;
    this.faultMetric = null;
    this.isRunning = false;
    this.values = {};

    // Seed every metric at its target so the first readings look "settled".
    var ctx = sim.context(0);
    this.isRunning = sim.equipmentConfig[this.type].shouldRun(this, ctx);
    for (var i = 0; i < this.metrics.length; i++) {
      var m = this.metrics[i];
      var t = m.seed != null ? m.seed
            : (typeof m.target === 'function' ? m.target(this, ctx) : m.target);
      if (!isFinite(t)) t = (m.min + m.max) / 2; // NaN guard (self-referencing)
      this.values[m.key] = clamp(t + this.rng.gauss() * (m.noise || 0), m.min, m.max);
    }
  }

  /** Advance the simulated device by one tick and produce a reading object. */
  Equipment.prototype.tick = function (ctx) {
    var rng = this.rng;
    var self = this;
    var config = this.sim.equipmentConfig[this.type];
    var reading = {
      id: 'RDG-' + String(this.sim.nextReadingId()).padStart(6, '0'),
      timestamp: ctx.timestamp,
      epochMs: ctx.epochMs,
      buildingId: this.sim.options.buildingId,
      buildingName: this.sim.options.buildingName,
      equipmentId: this.id,
      equipmentName: this.name,
      equipmentType: this.type,
      location: { floor: this.floor, zone: this.zone },
      status: null,
      runtimeHours: 0,
      energyKwh: 0,
      metrics: {},
      alarms: [],
      hasAlarm: false
    };

    /* --- status / fault latch ------------------------------------- */
    if (this.faultTicksRemaining > 0) {
      this.faultTicksRemaining--;
      if (this.faultTicksRemaining === 0) this.faultMetric = null;
      reading.status = 'FAULT';
    } else if (this.isRunning && rng.chance(this.sim.options.faultRate)) {
      var faultCandidates = this.metrics.filter(function (m) {
        return m.alarmHigh != null || m.alarmLow != null;
      });
      this.faultMetric = faultCandidates.length ? rng.pick(faultCandidates) : null;
      this.faultTicksRemaining = rng.int(2, 5);
      reading.status = 'FAULT';
    } else {
      reading.status = config.shouldRun(this, ctx) ? 'RUNNING' : 'IDLE';
    }
    this.isRunning = reading.status === 'RUNNING';

    /* --- metric generation ---------------------------------------- */
    for (var i = 0; i < this.metrics.length; i++) {
      var m = this.metrics[i];
      var target = typeof m.target === 'function' ? m.target(this, ctx) : m.target;
      var current = this.values[m.key] != null ? this.values[m.key] : target;
      if (!isFinite(target)) target = current; // NaN guard (self-referencing)
      var pull = m.pull != null ? m.pull : 0.3;
      var noise = m.noise || 0;
      var nextValue = current + (target - current) * pull + rng.gauss() * noise;

      // Fault injection: drive the selected metric past its alarm limit.
      if (this.faultMetric === m) {
        var faultTarget = m.alarmHigh != null
          ? m.alarmHigh * 1.15
          : m.alarmLow * 0.85;
        nextValue = current + (faultTarget - current) * 0.8 +
                    rng.gauss() * Math.max(noise, 0.1);
      }

      nextValue = clamp(nextValue, m.min, m.max);

      // Generic "maintenance event" hook (e.g. filter replacement).
      if (m.resetAt != null && nextValue > m.resetAt) nextValue = m.resetTo;

      this.values[m.key] = nextValue;
      reading.metrics[m.key] = round(nextValue, m.precision);

      /* --- threshold alarms --------------------------------------- */
      var severity = this.faultMetric === m ? 'critical' : (m.severity || 'warning');
      if (m.alarmHigh != null && nextValue > m.alarmHigh) {
        reading.alarms.push({
          code: toSnakeUpper(m.key) + '_HIGH',
          severity: severity,
          message: this.name + ' ' + m.label.toLowerCase() + ' high: ' +
                   round(nextValue, m.precision) + ' ' + m.unit +
                   ' (limit ' + m.alarmHigh + ')',
          metric: m.key,
          value: round(nextValue, m.precision),
          threshold: m.alarmHigh,
          unit: m.unit,
          timestamp: ctx.timestamp
        });
      }
      if (m.alarmLow != null && nextValue < m.alarmLow) {
        reading.alarms.push({
          code: toSnakeUpper(m.key) + '_LOW',
          severity: severity,
          message: this.name + ' ' + m.label.toLowerCase() + ' low: ' +
                   round(nextValue, m.precision) + ' ' + m.unit +
                   ' (limit ' + m.alarmLow + ')',
          metric: m.key,
          value: round(nextValue, m.precision),
          threshold: m.alarmLow,
          unit: m.unit,
          timestamp: ctx.timestamp
        });
      }
    }

    /* --- latched fault alarm + cumulative counters ----------------- */
    if (reading.status === 'FAULT') {
      reading.alarms.push({
        code: 'EQUIPMENT_FAULT',
        severity: 'critical',
        message: this.name + ' reported equipment fault' +
                 (this.faultMetric ? ' (' + this.faultMetric.label + ')' : ''),
        timestamp: ctx.timestamp
      });
    }

    if (this.isRunning) {
      var hours = this.sim.options.tickIntervalMs / 3600000;
      var power = this.values.powerKw != null ? this.values.powerKw : 0;
      this.runtimeHours += hours;
      this.energyKwh += power * hours;
    }
    reading.runtimeHours = round(this.runtimeHours, 1);
    reading.energyKwh = round(this.energyKwh, 2);
    reading.hasAlarm = reading.alarms.length > 0;

    return reading;
  };

  /* ------------------------------------------------------------------ *
   *  Simulator
   * ------------------------------------------------------------------ */

  function HVACSimulator(options) {
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
    this.equipmentConfig = EQUIPMENT_CONFIG;
    this.rng = createRng(opts.seed);
    this.startEpochMs = opts.startEpochMs != null ? opts.startEpochMs : Date.now();
    this.tickIndex = 0;
    this.readingCounter = 0;

    var zoneNames = ['North', 'South', 'East', 'West', 'Core', 'Northeast',
                     'Northwest', 'Southeast', 'Southwest'];
    this.equipment = [];
    var seqByType = {};
    for (var type in opts.equipment) {
      if (!Object.prototype.hasOwnProperty.call(opts.equipment, type)) continue;
      if (!EQUIPMENT_CONFIG[type]) {
        throw new Error('Unknown equipment type: ' + type +
                        '. Supported: ' + Object.keys(EQUIPMENT_CONFIG).join(', '));
      }
      var count = opts.equipment[type];
      for (var n = 0; n < count; n++) {
        seqByType[type] = (seqByType[type] || 0) + 1;
        var id = type + '-' + String(seqByType[type]).padStart(2, '0');
        var idx = this.equipment.length;
        this.equipment.push(new Equipment({
          id: id,
          name: EQUIPMENT_CONFIG[type].label + ' ' + seqByType[type],
          type: type,
          floor: (idx % opts.floors) + 1,
          zone: zoneNames[idx % zoneNames.length],
          occupantCount: this.rng.int(3, 12)
        }, this));
      }
    }
  }

  /** Build the shared simulation context (clock, weather, occupancy). */
  HVACSimulator.prototype.context = function (tickIndex) {
    var opts = this.options;
    var epochMs = this.startEpochMs + tickIndex * opts.tickIntervalMs;
    var date = new Date(epochMs);
    var hour = date.getHours();
    var weekday = date.getDay();
    var occupied = opts.workdays.indexOf(weekday) !== -1 &&
                   hour >= opts.occupiedHours.start &&
                   hour < opts.occupiedHours.end;
    var outdoorTemp = opts.climate.baseTempC +
                      opts.climate.amplitudeC *
                      Math.sin(((hour - 9) / 12) * Math.PI) +
                      this.rng.gauss() * 0.6;
    return {
      epochMs: epochMs,
      timestamp: date.toISOString(),
      hour: hour,
      weekday: weekday,
      occupied: occupied,
      outdoorTemp: outdoorTemp
    };
  };

  HVACSimulator.prototype.nextReadingId = function () {
    return ++this.readingCounter;
  };

  /** Generate one tick -> array of reading objects (one per equipment). */
  HVACSimulator.prototype.next = function () {
    var ctx = this.context(this.tickIndex);
    var readings = [];
    for (var i = 0; i < this.equipment.length; i++) {
      readings.push(this.equipment[i].tick(ctx));
    }
    this.tickIndex++;
    return readings;
  };

  /** Generate `ticks` ticks -> flat array of all readings over time. */
  HVACSimulator.prototype.nextSeries = function (ticks) {
    var out = [];
    ticks = Math.max(1, ticks | 0);
    for (var t = 0; t < ticks; t++) {
      var batch = this.next();
      for (var i = 0; i < batch.length; i++) out.push(batch[i]);
    }
    return out;
  };

  /** Metric catalogue (key, label, unit, ranges, alarm limits) per type. */
  HVACSimulator.prototype.getMetricDefinitions = function () {
    var defs = {};
    for (var type in METRIC_TEMPLATES) {
      if (!Object.prototype.hasOwnProperty.call(METRIC_TEMPLATES, type)) continue;
      defs[type] = METRIC_TEMPLATES[type].map(function (m) {
        return {
          key: m.key, label: m.label, unit: m.unit,
          min: m.min, max: m.max,
          alarmLow: m.alarmLow != null ? m.alarmLow : null,
          alarmHigh: m.alarmHigh != null ? m.alarmHigh : null
        };
      });
    }
    return defs;
  };

  /* ------------------------------------------------------------------ *
   *  One-shot convenience helpers
   * ------------------------------------------------------------------ */

  /** Single snapshot: array of reading objects for one instant. */
  function generateSnapshot(options) {
    return new HVACSimulator(options).next();
  }

  /** Time series: flat array of readings across `ticks` ticks. */
  function generateSeries(ticks, options) {
    return new HVACSimulator(options).nextSeries(ticks);
  }

  return {
    version: VERSION,
    HVACSimulator: HVACSimulator,
    generateSnapshot: generateSnapshot,
    generateSeries: generateSeries,
    EQUIPMENT_TYPES: Object.keys(EQUIPMENT_CONFIG),
    DEFAULT_OPTIONS: DEFAULTS
  };
});

/* ------------------------------------------------------------------------ *
 * CLI demo: `node hvacDataSimulator.js [ticks] [seed]`  -> pretty JSON
 * ------------------------------------------------------------------------ */
if (typeof module !== 'undefined' && module.exports && require.main === module) {
  var ticks = Math.max(1, parseInt(process.argv[2], 10) || 3);
  var seedArg = process.argv[3] !== undefined ? Number(process.argv[3]) : undefined;
  var SimulatorMod = module.exports;
  var simulator = new SimulatorMod.HVACSimulator({
    seed: isNaN(seedArg) ? undefined : seedArg
  });
  var readings = null;
  for (var t = 0; t < ticks; t++) readings = simulator.next();
  console.log(JSON.stringify(readings, null, 2));
}