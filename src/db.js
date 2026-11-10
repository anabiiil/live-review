import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from './config.js';

/**
 * Emails are stored lowercased and trimmed everywhere.
 * @param {string} s
 * @returns {string}
 */
export function normalizeEmail(s) {
  return String(s).trim().toLowerCase();
}

const SCHEMA_V1 = `
CREATE TABLE projects(
  id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, path TEXT UNIQUE NOT NULL,
  extra_hidden TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL);
CREATE TABLE members(
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, email TEXT NOT NULL,
  invited_at INTEGER NOT NULL, PRIMARY KEY(project_id, email));
CREATE TABLE invites(
  token_hash TEXT PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  email TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE TABLE users(email TEXT PRIMARY KEY, name TEXT);
CREATE TABLE login_codes(
  id INTEGER PRIMARY KEY, email TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE code_requests(id INTEGER PRIMARY KEY, email TEXT NOT NULL, ip TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE comments(
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE, target TEXT, path TEXT, line INTEGER,
  side TEXT CHECK(side IN ('old','new')), anchor TEXT, author_email TEXT NOT NULL, body TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, resolved INTEGER NOT NULL DEFAULT 0,
  outdated INTEGER NOT NULL DEFAULT 0, rewritten INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0);
CREATE INDEX comments_project_target ON comments(project_id, target);
CREATE INDEX sessions_email ON sessions(email);
CREATE INDEX code_requests_email_at ON code_requests(email, at);
CREATE INDEX code_requests_ip_at ON code_requests(ip, at);
CREATE INDEX invites_project_email ON invites(project_id, email);
`;

// v2: persisted notifications (thread root in comment_id) and the reviewer's email-notification preference.
const SCHEMA_V2 = `
CREATE TABLE notifications(
  id INTEGER PRIMARY KEY, recipient_email TEXT NOT NULL,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('comment','reply','resolved','reopened')), actor_email TEXT NOT NULL,
  created_at INTEGER NOT NULL, read_at INTEGER);
CREATE INDEX notifications_recipient_created ON notifications(recipient_email, created_at DESC);
ALTER TABLE users ADD COLUMN email_notifications INTEGER NOT NULL DEFAULT 1;
`;

/** Ordered migrations; migrations[i] upgrades user_version i to i+1. Append new ones at the end. */
const MIGRATIONS = [SCHEMA_V1, SCHEMA_V2];

/**
 * Open (creating if needed) the LiveReview database and bring the schema up to date.
 * @param {string} [file] defaults to <dataDir>/livereview.db
 * @returns {DatabaseSync}
 */
export function openDb(file) {
  const path = file ?? join(dataDir(), 'livereview.db');
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  const current = /** @type {{user_version:number}} */ (db.prepare('PRAGMA user_version').get()).user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}
