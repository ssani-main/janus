'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { hostToKey } = require('../../src/routing')

const BASE = 'gateway.example.com'

test('hostToKey: exact base domain is apex', () => {
  assert.deepEqual(hostToKey(BASE, BASE), { apex: true })
})

test('hostToKey: www.<base> is apex', () => {
  assert.deepEqual(hostToKey(`www.${BASE}`, BASE), { apex: true })
})

test('hostToKey: empty/undefined host is apex', () => {
  assert.deepEqual(hostToKey('', BASE), { apex: true })
  assert.deepEqual(hostToKey(undefined, BASE), { apex: true })
})

test('hostToKey: subdomain extracts rawKey from leftmost label', () => {
  assert.deepEqual(hostToKey(`0000abc.${BASE}`, BASE), { rawKey: '0000abc' })
})

test('hostToKey: trailing :port suffix is stripped before extracting rawKey', () => {
  assert.deepEqual(hostToKey(`0000abc.${BASE}:443`, BASE), { rawKey: '0000abc' })
})

test('hostToKey: uppercase host is lowercased (rawKey lowercased too)', () => {
  assert.deepEqual(hostToKey(`0000ABC.${BASE.toUpperCase()}`, BASE), { rawKey: '0000abc' })
})

test('hostToKey: unrelated host is invalid', () => {
  assert.deepEqual(hostToKey('evil.com', BASE), { invalid: true })
})
