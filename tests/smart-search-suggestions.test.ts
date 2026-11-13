import assert from 'node:assert/strict';
import test from 'node:test';
import { rotateSuggestions } from '../src/lib/suggestions.js';

const POOL = ['一', '二', '三', '四', '五', '六', '七', '八'];
const sequence = (values: number[]) => {
  let index = 0;
  return () => values[index++ % values.length];
};

test('suggestions are a three-item subset of the pool', () => {
  const picked = rotateSuggestions(POOL);
  assert.equal(picked.length, 3);
  assert.ok(picked.every(item => POOL.includes(item)));
  assert.equal(new Set(picked).size, 3, 'no duplicates');
});

test('the same random draws yield the same subset and different draws rotate it', () => {
  const first = rotateSuggestions(POOL, 3, sequence([0.9, 0.1, 0.5, 0.2, 0.8, 0.3, 0.7]));
  const repeated = rotateSuggestions(POOL, 3, sequence([0.9, 0.1, 0.5, 0.2, 0.8, 0.3, 0.7]));
  assert.deepEqual(first, repeated, 'draws fully determine the subset');
  const second = rotateSuggestions(POOL, 3, sequence([0.2, 0.8, 0.3, 0.9, 0.1, 0.5, 0.4]));
  assert.notDeepEqual(first, second, 'new draws rotate the offered set');
});

test('a shorter-than-count pool degrades to what exists', () => {
  assert.deepEqual(rotateSuggestions(['甲'], 3, () => 0.5), ['甲']);
  assert.deepEqual(rotateSuggestions([], 3, () => 0.5), []);
});
