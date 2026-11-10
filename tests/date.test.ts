import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDate, formatDateTime } from '../src/lib/date.js';

test('formatDate renders calendar dates with hyphens and preserves missing/invalid fallbacks', () => {
  assert.equal(formatDate('2026-11-09'), '2026-11-09');
  assert.equal(formatDate('not-a-date'), 'not-a-date');
  assert.equal(formatDate(''), '未登记');
});

test('formatDateTime renders minute precision with a shared YYYY-MM-DD date', () => {
  assert.equal(formatDateTime(new Date(2026, 10, 9, 9, 5, 40)), '2026-11-09 09:05');
  assert.equal(formatDateTime('not-a-date'), 'not-a-date');
  assert.equal(formatDateTime(''), '—');
});
