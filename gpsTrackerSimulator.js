/**
 * gpsTrackerSimulator.js
 * ---------------------------------------------------------------------------
 * Pure JavaScript generator for random, dynamic GPS fleet tracking data.
 * Produces an ARRAY OF OBJECTS (tracker pings) simulating GPS devices
 * installed in delivery vehicles.
 *
 * Each tracking record includes:
 *   - location       : lat/lng moving along a simulated route + accuracy,
 *                      satellites, speed, heading
 *   - car            : vehicle make/model, plate number, year, odometer
 *   - driverName     : driver assigned to the vehicle
 *   - machineStatus  : ENGINE_ON / ENGINE_OFF / IDLE / MAINTENANCE
 *   - gasolineLevel  : percent (0-100), drains while engine on, refuels
 *   - deliveryStatus : PENDING / LOADING / IN_TRANSIT / DELIVERED
 *
 * Features
 *  - Data-driven route network (Indonesian cities) with waypoint interpolation
 *  - Stateful vehicles: fuel consumption, odometer, speed model, delivery
 *    lifecycle state machine, random maintenance & refuel events
 *  - Deterministic output via optional seed (mulberry32 PRNG)
 *  - Zero dependencies. Works in Node.js (CommonJS) and browsers (global).
 *
 * Usage (Node.js)
 *   const { GPSSimulator, generateSnapshot, generateSeries } = require('./gpsTrackerSimulator');
 *   const sim = new GPSSimulator({ seed: 42, vehicleCount: 5 });
 *   const pings = sim.next();            // array of tracker objects (one tick)
 *   const log   = sim.nextSeries(60);    // flattened pings over 60 ticks
 *
 * Usage (Browser)
 *   <script src="gpsTrackerSimulator.js"></script>
 *   const pings = GPSDataSimulator.generateSnapshot();
 *
 * CLI demo
 *   node gpsTrackerSimulator.js [ticks] [seed]
 *   node gpsTrackerSimulator.js 3       -> prints 3rd tick as pretty JSON
 * ---------------------------------------------------------------------------
 */
(function (root, factory) {
  /* istanbul ignore next - UMD wrapper */
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GPSDataSimulator = factory();
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

  function clamp(v, min, max) { return v < min ? min : v > max ? max : v; }
  function round(v, p) { var f = Math.pow(10, p == null ? 1 : p); return Math.round(v * f) / f; }

  /* ------------------------------------------------------------------ *
   *  Simulation configuration
   * ------------------------------------------------------------------ */

  var DEFAULTS = {
    seed: null,                              // null -> random each run
    fleetId: 'FLEET-JKT-01',
    companyName: 'Nusantara Logistics',
    vehicleCount: 5,                         // number of tracked vehicles
    tickIntervalMs: 30000,                   // simulated time between pings (30 s)
    startEpochMs: null,                      // null -> Date.now() at construction
    speedKmh: { min: 60, max: 90 },          // cruise speed range on highways
    citySpeedKmh: { min: 15, max: 40 },      // speed in urban segments
    refuelThreshold: 20,                     // % that triggers a refuel stop
    maintenanceRate: 0.004,                  // chance per vehicle per tick
    gpsDriftMeters: 25                       // max GPS positional noise (m)
  };

  /* ------------------------------------------------------------------ *
   *  Reference data: routes (Indonesian inter-city corridors),
   *  vehicles, drivers
   * ------------------------------------------------------------------ */

  var ROUTES = [
    {
      id: 'JKT-BDG', name: 'Jakarta -> Bandung',
      waypoints: [
        { lat: -6.1751, lng: 106.8272, name: 'Jakarta' },
        { lat: -6.3500, lng: 107.2000, name: 'Bekasi' },
        { lat: -6.5500, lng: 107.5500, name: 'Cikampek' },
        { lat: -6.8500, lng: 107.6000, name: 'Purwakarta' },
        { lat: -6.9147, lng: 107.6098, name: 'Bandung' }
      ]
    },
    {
      id: 'JKT-SMG', name: 'Jakarta -> Semarang',
      waypoints: [
        { lat: -6.1751, lng: 106.8272, name: 'Jakarta' },
        { lat: -6.3200, lng: 107.3000, name: 'Bekasi' },
        { lat: -6.1000, lng: 106.1500, name: 'Karawang' },
        { lat: -6.4000, lng: 107.4700, name: 'Cikampek Junction' },
        { lat: -6.9667, lng: 109.1500, name: 'Tegal' },
        { lat: -6.9667, lng: 110.4167, name: 'Semarang' }
      ]
    },
    {
      id: 'SBY-MLG', name: 'Surabaya -> Malang',
      waypoints: [
        { lat: -7.2575, lng: 112.7521, name: 'Surabaya' },
        { lat: -7.4500, lng: 112.7000, name: 'Sidoarjo' },
        { lat: -7.6500, lng: 112.7000, name: 'Mojokerto' },
        { lat: -7.8000, lng: 112.6500, name: 'Kediri' },
        { lat: -7.9667, lng: 112.6327, name: 'Malang' }
      ]
    },
    {
      id: 'SBY-MDN', name: 'Surabaya -> Medan (long haul)',
      waypoints: [
        { lat: -7.2575, lng: 112.7521, name: 'Surabaya' },
        { lat: -6.9667, lng: 110.4167, name: 'Semarang' },
        { lat: -6.1751, lng: 106.8272, name: 'Jakarta' },
        { lat: -2.2000, lng: 104.0000, name: 'Palembang corridor' },
        { lat: 3.5952, lng: 98.6722, name: 'Medan' }
      ]
    },
    {
      id: 'DPS-SBY', name: 'Denpasar -> Surabaya',
      waypoints: [
        { lat: -8.6500, lng: 115.2167, name: 'Denpasar' },
        { lat: -8.2000, lng: 114.4000, name: 'Banyuwangi Ferry' },
        { lat: -7.8000, lng: 113.7000, name: 'Jember' },
        { lat: -7.2575, lng: 112.7521, name: 'Surabaya' }
      ]
    },
    {
      id: 'MKS-PDG', name: 'Makassar -> Padang (long haul)',
      waypoints: [
        { lat: -5.1477, lng: 119.4327, name: 'Makassar' },
        { lat: -3.0000, lng: 120.0000, name: 'Central Sulawesi' },
        { lat: -2.0000, lng: 118.0000, name: 'East corridor' },
        { lat: -0.9471, lng: 100.4392, name: 'Padang' }
      ]
    }
  ];

  var VEHICLE_MODELS = [
    { make: 'Toyota', model: 'Hilux Double Cabin', tankLiters: 80, kmPerLiter: 9 },
    { make: 'Mitsubishi', model: 'L300 Pickup', tankLiters: 55, kmPerLiter: 11 },
    { make: 'Toyota', model: 'Avanza Cargo', tankLiters: 45, kmPerLiter: 14 },
    { make: 'Hino', model: 'Dutro 130 HD', tankLiters: 100, kmPerLiter: 4.5 },
    { make: 'Suzuki', model: 'Carry Pick Up', tankLiters: 40, kmPerLiter: 13 },
    { make: 'Isuzu', model: 'Elf NLR 55', tankLiters: 100, kmPerLiter: 8 }
  ];

  var DRIVER_FIRST = ['Budi', 'Agus', 'Joko', 'Slamet', 'Andi', 'Eko', 'Hendra', 'Rizki',
                      'Dedi', 'Iwan', 'Yusuf', 'Farhan', 'Bagus', 'Wahyu', 'Doni', 'Tono'];
  var DRIVER_LAST = ['Santoso', 'Wijaya', 'Pratama', 'Hartono', 'Saputra', 'Nugroho',
                     'Setiawan', 'Kusuma', 'Maulana', 'Ramadhan', 'Firmansyah', 'Halim'];

  var PLATE_AREAS = ['B', 'D', 'F', 'L', 'N', 'AB', 'AD', 'H', 'DK'];

  /* ------------------------------------------------------------------ *
   *  Geo helpers (haversine distance + initial bearing)
   * ------------------------------------------------------------------ */

  function haversineKm(a, b) {
    var R = 6371, toRad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toRad;
    var dLng = (b.lng - a.lng) * toRad;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  function bearingDeg(a, b) {
    var toRad = Math.PI / 180;
    var y = Math.sin((b.lng - a.lng) * toRad) * Math.cos(b.lat * toRad);
    var x = Math.cos(a.lat * toRad) * Math.sin(b.lat * toRad) -
            Math.sin(a.lat * toRad) * Math.cos(b.lat * toRad) *
            Math.cos((b.lng - a.lng) * toRad);
    var deg = Math.atan2(y, x) / toRad;
    return (deg + 360) % 360;
  }

  function totalRouteKm(route) {
    var sum = 0;
    for (var i = 1; i < route.waypoints.length; i++) {
      sum += haversineKm(route.waypoints[i - 1], route.waypoints[i]);
    }
    return sum;
  }

  /** Interpolate a position 0..1 along the current leg. */
  function lerpPos(a, b, t) {
    return {
      lat: a.lat + (b.lat - a.lat) * t,
      lng: a.lng + (b.lng - a.lng) * t,
      name: t < 0.5 ? a.name : b.name
    };
  }

  /* ------------------------------------------------------------------ *
   *  Vehicle (stateful simulated tracker)
   * ------------------------------------------------------------------ */

  function Vehicle(cfg, sim) {
    this.sim = sim;
    this.rng = sim.rng;
    var model = cfg.model;
    this.id = 'GPS-' + String(cfg.seq).padStart(3, '0');
    this.vehicle = {
      make: model.make,
      model: model.model,
      year: this.rng.int(2015, 2023),
      plateNumber: cfg.plate,
      tankLiters: model.tankLiters,
      kmPerLiter: model.kmPerLiter
    };
    this.driverName = cfg.driverName;
    this.route = cfg.route;
    this.routeKm = totalRouteKm(cfg.route);
    this.legIndex = 0;              // current leg (waypoint pair index)
    this.legProgress = 0;           // 0..1 along current leg
    this.speedKmh = 0;
    this.headingDeg = 0;
    this.fuelPct = round(this.rng.range(35, 75), 0);
    this.odometerKm = round(this.rng.range(15000, 250000), 1);
    this.deliveryStatus = 'PENDING';
    this.machineStatus = 'ENGINE_OFF';
    this.position = this.route.waypoints[0];
    this.tripsCompleted = this.rng.int(2, 40);
    this.waitingTicks = 0;
  }

  /**
   * Advance the vehicle one tick and return a tracker ping object.
   * Delivery lifecycle:  PENDING -> LOADING -> IN_TRANSIT -> DELIVERED -> ...
   * Machine states:      ENGINE_ON (moving) / IDLE (loading, refuel) /
   *                      MAINTENANCE (random event) / ENGINE_OFF (depot)
   */
  Vehicle.prototype.tick = function (ctx) {
    var rng = this.rng;
    var opts = this.sim.options;

    /* --- 1. depot / delivery state machine ------------------------- */
    if (this.deliveryStatus === 'DELIVERED' || this.deliveryStatus === 'PENDING') {
      if (this.waitingTicks > 0) {
        this.waitingTicks--;
      }
      if (this.waitingTicks === 0) {
        this.deliveryStatus = 'LOADING';               // new shipment assigned
        this.waitingTicks = this.rng.int(1, 2);        // load for 1-2 ticks
        if (this.machineStatus !== 'MAINTENANCE') {
          this.fuelPct = 100;                          // refuel at depot
          this.machineStatus = 'IDLE';
        }
        this.legIndex = 0;
        this.legProgress = 0;
        this.position = this.route.waypoints[0];
      }
    }

    /* --- 2. machine status transitions ------------------------------ */
    if (this.machineStatus === 'MAINTENANCE') {
      this.waitingTicks--;
      if (this.waitingTicks <= 0) {
        this.machineStatus = 'ENGINE_OFF';
        this.deliveryStatus = 'PENDING';
        this.waitingTicks = this.rng.int(1, 3);
      }
      this.speedKmh = 0;
    } else if (this.deliveryStatus === 'LOADING') {
      this.waitingTicks--;
      this.machineStatus = 'IDLE';
      this.speedKmh = 0;
      if (this.waitingTicks <= 0) {
        this.deliveryStatus = 'IN_TRANSIT';
        this.machineStatus = 'ENGINE_ON';
      }
    } else if (this.deliveryStatus === 'IN_TRANSIT') {
      if (this.fuelPct <= opts.refuelThreshold && rng.chance(0.6)) {
        this.machineStatus = 'IDLE';                   // refuel stop
        this.waitingTicks = this.rng.int(1, 2);
        this.fuelPct = 100;
      } else if (rng.chance(opts.maintenanceRate)) {
        this.machineStatus = 'MAINTENANCE';            // breakdown event
        this.waitingTicks = this.rng.int(3, 8);
        this.speedKmh = 0;
      } else {
        this.machineStatus = 'ENGINE_ON';
      }
    } else if (this.deliveryStatus === 'DELIVERED' ||
               this.deliveryStatus === 'PENDING') {
      this.machineStatus = this.machineStatus === 'MAINTENANCE'
        ? 'MAINTENANCE' : 'ENGINE_OFF';
      this.speedKmh = 0;
    }

    /* --- 3. movement + fuel burn ------------------------------------ */
    if (this.machineStatus === 'ENGINE_ON') {
      var nearCity = this.legProgress < 0.12 || this.legProgress > 0.88;
      var cruise = nearCity
        ? rng.range(opts.citySpeedKmh.min, opts.citySpeedKmh.max)
        : rng.range(opts.speedKmh.min, opts.speedKmh.max);
      var speed = clamp(cruise * (0.9 + rng.next() * 0.2), 5, 100);
      this.speedKmh = round(speed, 0);

      var kmThisTick = speed * (opts.tickIntervalMs / 3600000);
      var from = this.route.waypoints[this.legIndex];
      var to = this.route.waypoints[this.legIndex + 1];
      var legKm = Math.max(haversineKm(from, to), 0.1);

      this.legProgress += kmThisTick / legKm;
      while (this.legProgress >= 1) {
        this.legProgress -= 1;
        this.legIndex++;
        if (this.legIndex >= this.route.waypoints.length - 1) {
          // Destination reached -> delivery complete
          this.legIndex = this.route.waypoints.length - 2;
          this.legProgress = 1;
          this.deliveryStatus = 'DELIVERED';
          this.machineStatus = 'ENGINE_OFF';
          this.speedKmh = 0;
          this.tripsCompleted++;
          this.waitingTicks = rng.int(1, 3);
          this.legProgress = 0;
          break;
        }
        from = this.route.waypoints[this.legIndex];
        to = this.route.waypoints[this.legIndex + 1];
        legKm = Math.max(haversineKm(from, to), 0.1);
      }

      this.position = lerpPos(this.route.waypoints[this.legIndex],
                              this.route.waypoints[this.legIndex + 1],
                              clamp(this.legProgress, 0, 1));
      this.headingDeg = round(bearingDeg(this.route.waypoints[this.legIndex],
                                         this.route.waypoints[this.legIndex + 1]), 0);

      // Fuel: idle burns ~0.5 L/h, moving burns tank via km/L efficiency
      var litersBurned = kmThisTick / this.vehicle.kmPerLiter;
      var idleExtra = 0.5 * (opts.tickIntervalMs / 3600000);
      var tankLiters = this.vehicle.tankLiters;
      this.fuelPct = clamp(this.fuelPct -
        ((litersBurned + idleExtra) / tankLiters) * 100, 0, 100);

      this.odometerKm = round(this.odometerKm + kmThisTick, 1);
    } else if (this.machineStatus === 'IDLE') {
      var idleBurn = 0.5 * (opts.tickIntervalMs / 3600000) /
                     this.vehicle.tankLiters * 100;
      this.fuelPct = clamp(this.fuelPct - idleBurn, 0, 100);
      this.speedKmh = 0;
    } else {
      this.speedKmh = 0; // ENGINE_OFF / MAINTENANCE
    }

    /* --- 4. build the tracker ping object ---------------------------- */
    var gpsNoiseDeg = opts.gpsDriftMeters / 111320; // ~meters to degrees
    var satellites = this.machineStatus === 'ENGINE_ON'
      ? rng.int(7, 12) : rng.int(4, 12);

    return {
      id: 'PING-' + this.id + '-' + String(ctx.tickIndex).padStart(5, '0'),
      timestamp: ctx.timestamp,
      epochMs: ctx.epochMs,
      fleetId: opts.fleetId,
      companyName: opts.companyName,
      trackerId: this.id,
      location: {
        latitude: round(this.position.lat + rng.gauss() * gpsNoiseDeg, 6),
        longitude: round(this.position.lng + rng.gauss() * gpsNoiseDeg, 6),
        lastWaypoint: this.position.name,
        routeId: this.route.id,
        routeName: this.route.name,
        legIndex: this.legIndex,
        legProgressPct: round(clamp(this.legProgress, 0, 1) * 100, 1),
        accuracyMeters: round(rng.range(3, opts.gpsDriftMeters), 1),
        satellites: satellites,
        speedKmh: this.speedKmh,
        headingDeg: this.headingDeg
      },
      car: {
        make: this.vehicle.make,
        model: this.vehicle.model,
        year: this.vehicle.year,
        plateNumber: this.vehicle.plateNumber,
        odometerKm: this.odometerKm
      },
      driverName: this.driverName,
      machineStatus: this.machineStatus,
      gasolineLevel: {
        percent: round(this.fuelPct, 1),
        litersRemaining: round(this.fuelPct / 100 * this.vehicle.tankLiters, 1),
        tankLiters: this.vehicle.tankLiters,
        rangeKmEstimate: round(this.fuelPct / 100 * this.vehicle.tankLiters *
                               this.vehicle.kmPerLiter, 1)
      },
      deliveryStatus: this.deliveryStatus,
      tripsCompleted: this.tripsCompleted,
      alerts: this.buildAlerts()
    };
  };

  /** Threshold-based alert builder for the current vehicle state. */
  Vehicle.prototype.buildAlerts = function () {
    var alerts = [];
    if (this.fuelPct <= this.sim.options.refuelThreshold) {
      alerts.push({
        code: 'LOW_FUEL',
        severity: 'warning',
        message: this.vehicle.plateNumber + ' fuel level low: ' +
                 round(this.fuelPct, 1) + '%'
      });
    }
    if (this.machineStatus === 'MAINTENANCE') {
      alerts.push({
        code: 'VEHICLE_MAINTENANCE',
        severity: 'critical',
        message: this.vehicle.plateNumber + ' undergoing maintenance'
      });
    }
    if (this.machineStatus === 'IDLE' && this.deliveryStatus === 'IN_TRANSIT') {
      alerts.push({
        code: 'UNEXPECTED_IDLE',
        severity: 'info',
        message: this.vehicle.plateNumber + ' stopped en route (refuel/rest stop)'
      });
    }
    return alerts;
  };

  /* ------------------------------------------------------------------ *
   *  Simulator
   * ------------------------------------------------------------------ */

  function GPSSimulator(options) {
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

    this.vehicles = [];
    var usedPlates = {};
    for (var i = 0; i < opts.vehicleCount; i++) {
      // Unique plate numbers (Indonesian format: area code + 1-4 digits + letters)
      var plate;
      do {
        plate = this.rng.pick(PLATE_AREAS) + ' ' + this.rng.int(1, 9999) +
                ' ' + this.rng.pick(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']) +
                this.rng.pick(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
      } while (usedPlates[plate]);
      usedPlates[plate] = true;

      this.vehicles.push(new Vehicle({
        seq: i + 1,
        plate: plate,
        model: this.rng.pick(VEHICLE_MODELS),
        driverName: this.rng.pick(DRIVER_FIRST) + ' ' + this.rng.pick(DRIVER_LAST),
        route: this.rng.pick(ROUTES)
      }, this));
    }
  }

  /** Build shared context (clock) for a tick. */
  GPSSimulator.prototype.context = function (tickIndex) {
    var epochMs = this.startEpochMs + tickIndex * this.options.tickIntervalMs;
    return {
      tickIndex: tickIndex,
      epochMs: epochMs,
      timestamp: new Date(epochMs).toISOString()
    };
  };

  /** Generate one tick -> array of tracker ping objects (one per vehicle). */
  GPSSimulator.prototype.next = function () {
    var ctx = this.context(this.tickIndex);
    var pings = [];
    for (var i = 0; i < this.vehicles.length; i++) {
      pings.push(this.vehicles[i].tick(ctx));
    }
    this.tickIndex++;
    return pings;
  };

  /** Generate `ticks` ticks -> flat array of all pings over time. */
  GPSSimulator.prototype.nextSeries = function (ticks) {
    var out = [];
    ticks = Math.max(1, ticks | 0);
    for (var t = 0; t < ticks; t++) {
      var batch = this.next();
      for (var i = 0; i < batch.length; i++) out.push(batch[i]);
    }
    return out;
  };

  /** Route catalogue (id, name, waypoint list, total km). */
  GPSSimulator.prototype.getRouteCatalog = function () {
    return ROUTES.map(function (r) {
      return { id: r.id, name: r.name, waypoints: r.waypoints,
               totalKm: round(totalRouteKm(r), 1) };
    });
  };

  /* ------------------------------------------------------------------ *
   *  One-shot convenience helpers
   * ------------------------------------------------------------------ */

  /** Single snapshot: array of tracker pings for one instant. */
  function generateSnapshot(options) {
    return new GPSSimulator(options).next();
  }

  /** Time series: flat array of pings across `ticks` ticks. */
  function generateSeries(ticks, options) {
    return new GPSSimulator(options).nextSeries(ticks);
  }

  return {
    version: VERSION,
    GPSSimulator: GPSSimulator,
    generateSnapshot: generateSnapshot,
    generateSeries: generateSeries,
    ROUTES: ROUTES,
    DEFAULT_OPTIONS: DEFAULTS
  };
});

/* ------------------------------------------------------------------------ *
 * CLI demo: `node gpsTrackerSimulator.js [ticks] [seed]`  -> pretty JSON
 * ------------------------------------------------------------------------ */
if (typeof module !== 'undefined' && module.exports && require.main === module) {
  var ticks = Math.max(1, parseInt(process.argv[2], 10) || 3);
  var seedArg = process.argv[3] !== undefined ? Number(process.argv[3]) : undefined;
  var SimulatorMod = module.exports;
  var simulator = new SimulatorMod.GPSSimulator({
    seed: isNaN(seedArg) ? undefined : seedArg
  });
  var pings = null;
  for (var t = 0; t < ticks; t++) pings = simulator.next();
  console.log(JSON.stringify(pings, null, 2));
}