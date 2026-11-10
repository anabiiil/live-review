import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notificationText, mergeNotifications, unreadBadge, internalUrl, unreadLabel } from '../../public/js/notify-model.js';

/** @param {Partial<any>} o */
const N = (o) => ({
  id: 1, kind: 'reply', projectSlug: 'demo', projectName: 'Demo', commentId: 9, threadId: 9, path: 'src/app.php', line: 3,
  target: 'live', actorName: 'Rana', excerpt: 'hi', url: '/demo/live#c-9', createdAt: 1, read: false, yours: false, ...o,
});

test('notificationText: one line per kind, file name and line', () => {
  assert.equal(notificationText(N({ kind: 'comment' })), 'Rana commented on app.php:3');
  assert.equal(notificationText(N({})), 'Rana replied on app.php:3');
  assert.equal(notificationText(N({ kind: 'resolved', actorName: 'Owner', yours: true })), 'Owner marked your comment on app.php:3 resolved');
  assert.equal(notificationText(N({ kind: 'resolved', yours: false })), 'Rana marked a comment on app.php:3 resolved');
  assert.equal(notificationText(N({ kind: 'reopened', yours: true })), 'Rana reopened your comment on app.php:3');
  assert.equal(notificationText(N({ kind: 'reopened' })), 'Rana reopened a comment on app.php:3');
  assert.equal(notificationText(N({ line: null, path: 'README.md' })), 'Rana replied on README.md');
});

test('mergeNotifications: newest first, no duplicates, capped', () => {
  const list = [N({ id: 2 }), N({ id: 1 })];
  assert.deepEqual(mergeNotifications(list, N({ id: 3 })).map((n) => n.id), [3, 2, 1]);
  assert.deepEqual(mergeNotifications(list, N({ id: 2, read: true })).map((n) => [n.id, n.read]), [[2, true], [1, false]]);
  assert.equal(mergeNotifications(list, N({ id: 3 }), 2).length, 2);
});

test('unreadBadge and unreadLabel', () => {
  assert.equal(unreadBadge(0), '');
  assert.equal(unreadBadge(7), '7');
  assert.equal(unreadBadge(150), '99+');
  assert.equal(unreadLabel(0), 'Notifications');
  assert.equal(unreadLabel(1), 'Notifications, 1 unread');
  assert.equal(unreadLabel(4), 'Notifications, 4 unread');
});

test('internalUrl: same-site paths only', () => {
  assert.equal(internalUrl('/demo/live#c-1'), '/demo/live#c-1');
  for (const bad of ['https://evil.test/', '//evil.test/x', '/\\evil', 'javascript:alert(1)', 42, null]) assert.equal(internalUrl(bad), null, String(bad));
});
