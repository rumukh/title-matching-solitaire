"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHash } = require("node:crypto");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const source = html.match(/<script id="mahjong-engine">([\s\S]*?)<\/script>/)[1];
const M = vm.runInNewContext(source + "; Mahjong");
const plain = value => JSON.parse(JSON.stringify(value));
const counts = tiles => tiles.reduce((map, tile) => {
  map[tile.face] = (map[tile.face] || 0) + 1;
  return map;
}, {});

// Deliberately independent rule implementation: a bad certificate verifier
// must not make a broken generator pass its own tests.
function freeOracle(tile, tiles) {
  const intersects = (a, b) => Math.abs(a - b) < 1 - .001;
  const active = tiles.filter(t => !t.removed && t.id !== tile.id);
  const covered = active.some(t => t.z > tile.z && intersects(t.x, tile.x) && intersects(t.y, tile.y));
  const left = active.some(t => t.z === tile.z && intersects(t.y, tile.y) && Math.abs(t.x - tile.x + 1) < .001);
  const right = active.some(t => t.z === tile.z && intersects(t.y, tile.y) && Math.abs(t.x - tile.x - 1) < .001);
  return !tile.removed && !covered && !(left && right);
}
function verifyIndependently(tiles, solution) {
  const copy = plain(tiles);
  for (const [first, second] of solution) {
    assert.notEqual(first, second);
    const a = copy.find(t => t.id === first), b = copy.find(t => t.id === second);
    assert.ok(a && b);
    assert.ok(freeOracle(a, copy), `Tile ${first} must be free`);
    assert.ok(freeOracle(b, copy), `Tile ${second} must be free`);
    assert.ok(a.face === b.face || ["f", "s"].some(suit => a.face[0] === suit && b.face[0] === suit));
    a.removed = b.removed = true;
  }
  assert.ok(copy.every(t => t.removed));
}

test("the deliverable is a standalone document with parseable scripts and no external assets", () => {
  for (const [, script] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new vm.Script(script);
  assert.doesNotMatch(html, /(?:src|href)=["'](?:https?:)?\/\//);
  assert.doesNotMatch(html, /@import|url\(["']?https?:/);
  assert.doesNotMatch(html, /[\u{1F000}-\u{1F02F}]/u);
  assert.match(html, /<html lang="ru">/);
});

test("the standard deck has 34 ordinary types four times and 8 unique bonus tiles", () => {
  const deck = M.deck();
  assert.equal(deck.length, 144);
  assert.equal(new Set(deck).size, 42);
  for (const [face, count] of Object.entries(counts(deck.map(face => ({ face }))))) {
    assert.equal(count, /^[fs]/.test(face) ? 1 : 4);
  }
  for (const first of M.FACES) for (const second of M.FACES) {
    assert.equal(M.matches(first, second), first === second || /^[fs]/.test(first) && first[0] === second[0]);
  }
});

test("every numbered bamboo tile has the correct number of distinct stalks", () => {
  const start = html.indexOf("    const faceCache = new Map();");
  const end = html.indexOf("    const ACHIEVEMENTS = [", start);
  const artwork = vm.runInNewContext(html.slice(start, end) + "; artwork");
  const shapes = face => [...artwork(face).matchAll(/<path\b[^>]*>/g)].map(match => match[0]);
  for (let rank = 2; rank <= 9; rank++) {
    assert.equal(shapes("b" + rank).length, rank);
    assert.equal(new Set(shapes("b" + rank)).size, rank);
  }
  assert.notDeepEqual([...new Set(shapes("b7"))], [...new Set(shapes("b8"))]);
});

test("late layouts increase layering and blocking while retaining certified solutions", () => {
  const means = [];
  for (const [level, layers] of [["49", 5], ["50", 6], ["100", 7]]) {
    let free = 0;
    for (let seed = 0; seed < 32; seed++) {
      const deal = M.generate(level, seed);
      assert.equal(deal.tiles.length, 144);
      assert.equal(Math.max(...deal.tiles.map(t => t.z)) + 1, layers);
      free += M.freeIds(deal.tiles).length;
      verifyIndependently(deal.tiles, deal.solution);
    }
    means.push(free / 32);
  }
  assert.ok(means[1] < means[0] - 5, "Level 50 should lock materially more tiles than level 49");
  assert.ok(means[2] < means[1], "Level 100 should add another measurable difficulty tier");
  const levels = ["50", "51", "100", "250", "1000", "9007199254740993123", "9".repeat(400)];
  const geometries = levels.map(level => JSON.stringify(M.layout(level, 42)));
  assert.equal(new Set(geometries).size, levels.length);
  for (const level of levels) {
    const deal = M.generate(level, 42);
    assert.ok(deal.tiles.every(t => Number.isFinite(t.x) && Number.isFinite(t.y) && t.z < 8));
    verifyIndependently(deal.tiles, deal.solution);
    const partial = plain(deal.tiles);
    for (const id of deal.solution.slice(0, 20).flat()) partial.find(t => t.id === id).removed = true;
    const shuffled = M.reshuffle(partial, level, 54321);
    verifyIndependently(shuffled.tiles, shuffled.solution);
    assert.deepEqual(counts(shuffled.tiles.filter(t => !t.removed)), counts(partial.filter(t => !t.removed)));
  }
});

test("legacy generator reproduces existing saved deals exactly", () => {
  const fingerprints = [
    ["1", "68b5bc0814ae0c24a5c237a6eefe4c436c31334bce454e60c8b0e884493d7328"],
    ["49", "8e46420f8c2906ceec2c5706d2013968f99a6a45128b8a7cec934dde1d64c764"],
    ["1000", "8e46420f8c2906ceec2c5706d2013968f99a6a45128b8a7cec934dde1d64c764"]
  ];
  for (const [level, expected] of fingerprints) {
    const hash = createHash("sha256").update(JSON.stringify(M.generate(level, 12345, 1))).digest("hex");
    assert.equal(hash, expected);
  }
  for (const level of ["1", "3", "4", "16", "49"]) {
    assert.deepEqual(plain(M.generate(level, 12345)), plain(M.generate(level, 12345, 1)));
  }
});

test("side freedom and partial upper coverage follow classic rules", () => {
  const tile = (id, x, y, z = 0) => ({ id, x, y, z, removed: false, face: "d1" });
  const tiles = [tile(0, 0, 0), tile(1, 1, 0), tile(2, 2, 0), tile(3, 1.5, 0, 1)];
  assert.deepEqual(plain(M.freeIds(tiles)).sort(), [0, 3]);
  tiles[3].removed = true;
  assert.deepEqual(plain(M.freeIds(tiles)).sort(), [0, 2]);
  tiles[0].removed = true;
  assert.deepEqual(plain(M.freeIds(tiles)).sort(), [1, 2]);
  for (const t of tiles) assert.equal(M.freeIds(tiles).includes(t.id), freeOracle(t, tiles));
});

test("1,200 seeded deals are all solvable; tutorial sizes and complete decks are exact", () => {
  for (let level = 1; level <= 60; level++) {
    for (let seed = 0; seed < 20; seed++) {
      const deal = M.generate(String(level), seed * 104729);
      assert.equal(deal.tiles.length, [48, 72, 108][level - 1] || 144);
      assert.equal(deal.solution.length, deal.tiles.length / 2);
      if (level >= 4) assert.deepEqual(counts(deal.tiles), counts(M.deck().map(face => ({ face }))));
      verifyIndependently(deal.tiles, deal.solution);
    }
  }
});

test("canonical fallback is a valid solution for all authored geometry", () => {
  for (let level = 1; level <= 80; level++) {
    const tiles = plain(M.layout(String(level), level));
    for (const tile of tiles) tile.face = "d1";
    const solution = M.canonicalOrder(tiles);
    verifyIndependently(tiles, solution);
  }
});

test("seeds are repeatable, while levels work beyond Number.MAX_SAFE_INTEGER", () => {
  assert.deepEqual(plain(M.generate("24", 77)), plain(M.generate("24", 77)));
  assert.notDeepEqual(plain(M.generate("24", 77)), plain(M.generate("24", 78)));
  const level = "99999999999999999999999999999999999999";
  const deal = M.generate(level, 42);
  assert.equal(deal.tiles.length, 144);
  verifyIndependently(deal.tiles, deal.solution);
  assert.equal((BigInt(level) + 1n).toString(), "100000000000000000000000000000000000000");
});

test("shuffle after arbitrary legal moves preserves every remaining face and certifies a solution", () => {
  for (let level = 1; level <= 35; level++) {
    for (let seed = 1; seed <= 5; seed++) {
      const deal = M.generate(String(level), seed);
      const tiles = plain(deal.tiles);
      const rng = M.random(seed * 997);
      for (let move = 0; move < 35; move++) {
        const pairs = M.availablePairs(tiles);
        if (!pairs.length) break;
        const pair = pairs[Math.floor(rng() * pairs.length)];
        for (const tile of tiles) if (pair.includes(tile.id)) tile.removed = true;
      }
      const remaining = tiles.filter(t => !t.removed);
      if (!remaining.length) continue;
      const result = M.reshuffle(tiles, String(level), seed * 1009);
      assert.deepEqual(counts(result.tiles.filter(t => !t.removed)), counts(remaining));
      assert.deepEqual(plain(result.tiles.filter(t => t.removed)), tiles.filter(t => t.removed));
      verifyIndependently(result.tiles, result.solution);
    }
  }
});

test("a geometrically impossible remainder is repacked, never silently randomized", () => {
  const tiles = [
    { id: 0, x: 0, y: 0, z: 0, face: "f1", removed: false },
    { id: 1, x: 0, y: 0, z: 1, face: "f4", removed: false }
  ];
  assert.equal(M.solveGeometry(tiles, 12), null);
  const result = M.reshuffle(tiles, "1", 12);
  assert.equal(result.repacked, true);
  assert.deepEqual(counts(result.tiles), counts(tiles));
  verifyIndependently(result.tiles, result.solution);
});

test("solution validation rejects blocked, repeated, mismatched and incomplete pairs", () => {
  const deal = M.generate("1", 234);
  const solution = plain(deal.solution);
  assert.equal(M.verifySolution(deal.tiles, solution.slice(1)), false);
  assert.equal(M.verifySolution(deal.tiles, [solution[0], ...solution]), false);
  const changed = plain(deal.tiles);
  changed.find(t => t.id === solution[0][0]).face = "d1";
  changed.find(t => t.id === solution[0][1]).face = "d2";
  assert.equal(M.verifySolution(changed, solution), false);
});
