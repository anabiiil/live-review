import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initials, openCount, projectActivity, projectRowMeta } from '../../public/js/shell-model.js';
import { ICONS } from '../../public/js/icons.js';

test('initials: up to two letters from the name, else the email', () => {
  assert.equal(initials('Rana Haddad', 'r@x.test'), 'RH');
  assert.equal(initials('olivia', 'o@x.test'), 'O');
  assert.equal(initials('  Ana  María  López ', 'a@x.test'), 'AL');
  assert.equal(initials(null, 'rev@e2e.test'), 'R');
  assert.equal(initials('رنا حداد', 'r@x.test'), 'رح');
  assert.equal(initials('', ''), '?');
});

test('openCount: the tab count text, empty for none', () => {
  assert.equal(openCount(0), '');
  assert.equal(openCount(3), '3');
  assert.equal(openCount(1200), '999+');
});

test('projectRowMeta: open comment wording', () => {
  assert.equal(projectRowMeta({ open: 0 }), 'No open comments');
  assert.equal(projectRowMeta({ open: 1 }), '1 open comment');
  assert.equal(projectRowMeta({ open: 4 }), '4 open comments');
});

test('projectActivity: branch and last change in a sentence, no middle dots', () => {
  const now = Date.UTC(2026, 10, 10, 12, 0, 0);
  assert.equal(projectActivity({ branch: 'main', lastChangeAt: now - 5 * 60_000 }, now), 'On main, updated 5 minutes ago');
  assert.equal(projectActivity({ branch: 'main', lastChangeAt: now - 60_000 }, now), 'On main, updated 1 minute ago');
  assert.equal(projectActivity({ branch: 'feat/x', lastChangeAt: now - 10_000 }, now), 'On feat/x, updated just now');
  assert.equal(projectActivity({ branch: null, lastChangeAt: now - 3 * 3600_000 }, now), 'Updated 3 hours ago');
  assert.equal(projectActivity({ branch: 'main', lastChangeAt: null }, now), 'On main');
  assert.equal(projectActivity({ branch: 'main', lastChangeAt: now - 2 * 86400_000 }, now), 'On main, updated 2 days ago');
  assert.equal(projectActivity({ branch: null, lastChangeAt: Date.UTC(2026, 0, 2) }, now), 'Updated on 2026-01-02');
  assert.equal(projectActivity({}, now), null);
  assert.ok(!projectActivity({ branch: 'main', lastChangeAt: now }, now)?.includes('·'));
});

test('icons: every icon is a list of drawable SVG elements', () => {
  const names = Object.keys(ICONS);
  for (const n of ['bell', 'chevron-down', 'git-branch', 'log-out', 'check', 'message', 'mark', 'shield']) assert.ok(names.includes(n), n);
  for (const [name, parts] of Object.entries(ICONS)) {
    assert.ok(Array.isArray(parts) && parts.length > 0, name);
    for (const [tag, attrs] of parts) {
      assert.ok(['path', 'circle', 'rect', 'line', 'polyline'].includes(tag), `${name}: ${tag}`);
      for (const v of Object.values(attrs)) assert.match(String(v), /^[\d\s.,\-a-zA-Z]+$/, `${name}: ${v}`);
    }
  }
});
