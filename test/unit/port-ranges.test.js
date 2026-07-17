'use strict'

// Guards test/unit/fixtures/port-ranges.js -- the single source of truth
// for which TUNNEL_PORT_MIN..TUNNEL_PORT_MAX range each test file (and
// fixture spawned by one) owns. See that file's header comment for why
// this matters (test files run in parallel and bind real TCP ports).
//
// This test does two things:
//   1. Mechanically verifies no two declared ranges overlap.
//   2. Reads each listed file's actual source and verifies the
//      TUNNEL_PORT_MIN/MAX pairs it contains match what's declared in the
//      registry, so the registry can't silently drift out of date as
//      files are edited.

const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { PORT_RANGES, findOverlaps } = require('./fixtures/port-ranges')

test('port-ranges registry: no two declared ranges overlap', () => {
  const overlaps = findOverlaps()
  assert.deepEqual(
    overlaps,
    [],
    `overlapping port ranges found (these files run in parallel and WILL race for ports):\n${overlaps.join('\n')}`
  )
})

test('port-ranges registry: declared ranges match each file\'s actual TUNNEL_PORT_MIN/MAX literals', () => {
  for (const entry of PORT_RANGES) {
    const filePath = path.join(__dirname, entry.file)
    const source = fs.readFileSync(filePath, 'utf8')

    const mins = [...source.matchAll(/TUNNEL_PORT_MIN\s*[:=]\s*'?(\d+)'?/g)].map((m) => Number(m[1]))
    const maxes = [...source.matchAll(/TUNNEL_PORT_MAX\s*[:=]\s*'?(\d+)'?/g)].map((m) => Number(m[1]))

    assert.equal(
      mins.length,
      entry.ranges.length,
      `${entry.file}: expected ${entry.ranges.length} TUNNEL_PORT_MIN occurrence(s), found ${mins.length} -- update test/unit/fixtures/port-ranges.js`
    )
    assert.equal(
      maxes.length,
      entry.ranges.length,
      `${entry.file}: expected ${entry.ranges.length} TUNNEL_PORT_MAX occurrence(s), found ${maxes.length} -- update test/unit/fixtures/port-ranges.js`
    )

    entry.ranges.forEach(([min, max], i) => {
      assert.equal(
        mins[i],
        min,
        `${entry.file}: TUNNEL_PORT_MIN #${i + 1} is ${mins[i]} in source but ${min} in the registry -- keep test/unit/fixtures/port-ranges.js in sync`
      )
      assert.equal(
        maxes[i],
        max,
        `${entry.file}: TUNNEL_PORT_MAX #${i + 1} is ${maxes[i]} in source but ${max} in the registry -- keep test/unit/fixtures/port-ranges.js in sync`
      )
    })
  }
})
