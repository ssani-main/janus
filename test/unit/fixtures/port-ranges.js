'use strict'

// Single source of truth for the TUNNEL_PORT_MIN..TUNNEL_PORT_MAX ranges
// each test file binds real TCP loopback ports on.
//
// WHY THIS FILE EXISTS: `npm test` runs `node --test` inside test/unit,
// which executes test FILES IN PARALLEL (default concurrency = CPU core
// count). Every file below binds real ports from its configured range
// while its tests run. If two files' ranges overlap, they race for the
// same ports and you get either EADDRINUSE crashes or silently-skewed
// timing (a deadline/backoff test that depends on real port-probe latency
// can pass or fail depending on what else happens to be listening).
//
// RULE: every range below must be disjoint from every other range. When
// you add a new test file (or fixture spawned by one) that binds ports,
// add its range here too, in its own block, and pick numbers that don't
// overlap anything already listed.
//
// This file is also read by port-ranges.test.js, which mechanically
// verifies (a) no two ranges below overlap, and (b) the ranges below
// still match the literal TUNNEL_PORT_MIN/MAX values actually present in
// each file's source -- so this map can't silently drift out of date.
const PORT_RANGES = [
  { file: 'tunnel-manager.test.js', ranges: [[20000, 20010]] },
  {
    file: 'tunnel-manager-port-retry.test.js',
    ranges: [
      [20100, 20105],
      [20120, 20122],
      [20130, 20132],
      [20160, 20163],
      [20165, 20168],
      [20170, 20173],
    ],
  },
  { file: 'fixtures/port-guard-toctou.js', ranges: [[20110, 20115]] },
  { file: 'fixtures/port-guard-concurrency.js', ranges: [[20140, 20141]] },
  { file: 'fixtures/port-guard-real-bug-still-crashes.js', ranges: [[20150, 20155]] },
  {
    file: 'tunnel-manager-counters.test.js',
    ranges: [
      [20400, 20420],
      [20430, 20435],
    ],
  },
  {
    file: 'tunnel-manager-circuit.test.js',
    ranges: [
      [20500, 20520],
      [20550, 20560],
      [20570, 20580],
      [20585, 20589],
      [20590, 20595],
    ],
  },
  { file: 'metrics.test.js', ranges: [[20600, 20610]] },
  { file: 'tunnel-manager-health.test.js', ranges: [[20700, 20720]] },
  { file: 'tunnel-manager-ensure-tunnel-deadline.test.js', ranges: [[20800, 20810]] },
  { file: 'server-error-page-leak.test.js', ranges: [[20900, 20910]] },
  { file: 'tunnel-manager-ws-slots.test.js', ranges: [[20960, 20965]] },
  { file: 'tunnel-manager-eviction-race.test.js', ranges: [[20970, 20980]] },
  { file: 'tunnel-manager-create-concurrency.test.js', ranges: [[21000, 21040]] },
  { file: 'tunnel-manager-port-quarantine.test.js', ranges: [[21050, 21055]] },
  { file: 'fixtures/port-guard-late-bind-absorbed.js', ranges: [[21070, 21075]] },
  { file: 'fixtures/port-guard-unquarantined-still-crashes.js', ranges: [[21080, 21085]] },
]

/** Returns every overlap found across all declared ranges, as human-readable strings. */
function findOverlaps() {
  const flat = []
  for (const entry of PORT_RANGES) {
    for (const [min, max] of entry.ranges) {
      flat.push({ file: entry.file, min, max })
    }
  }

  const overlaps = []
  for (let i = 0; i < flat.length; i++) {
    for (let j = i + 1; j < flat.length; j++) {
      const a = flat[i]
      const b = flat[j]
      if (a.min <= b.max && b.min <= a.max) {
        overlaps.push(
          `${a.file} [${a.min}-${a.max}] overlaps ${b.file} [${b.min}-${b.max}]`
        )
      }
    }
  }
  return overlaps
}

module.exports = { PORT_RANGES, findOverlaps }
