import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initials, openCount, projectRowMeta } from '../../public/js/shell-model.js';
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
