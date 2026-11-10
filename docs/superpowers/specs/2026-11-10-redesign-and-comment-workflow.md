# LiveReview v2 — Redesign and comment workflow

Date: 2026-11-10 · Status: approved by owner ("continue without asking"); all calls below are the designer's.

## Owner's request (verbatim intent)
1. Redesign: the UI looks old; make it modern.
2. A comments page: list comments, reply to them, click one to jump to its place in the code, and hide them.
3. Inline comments in the code look bad: a line with comments shows a comment mark; clicking the mark opens the thread.
4. Resolve notifications both ways: when the owner marks a reviewer's comment solved, the reviewer sees it and gets notified; when a reviewer marks something solved, the owner gets notified.

## Design direction
Subject: reading live code changes and talking about specific lines. Audience: developers (owner + invited reviewers, some writing Arabic). Primary job: read a diff and discuss lines without friction.

Principle: **the margin is the conversation.** Code and chrome stay quiet; comment marks are the one bold element — highlighter-ink tabs in the margin beside the line they belong to, like a proofreader's marks. Resolved marks fade to a quiet check.

Palette (light):
- Paper `#F6F7FB` (app background, faint blue-grey), Sheet `#FFFFFF` (panes), Rule `#E3E6EF` (hairlines)
- Ink `#1B2033` (text), Ink-soft `#5B6278` (secondary)
- Cobalt `#2F45D8` (actions, focus, links)
- Highlighter `#FFD84D` with ink text (comment marks, unread), Highlighter-wash `#FFF6CC` (open-thread background)
- Diff add `#E7F6EC` / add-strong `#2E8B57`; del `#FDECEC` / del-strong `#C2413B`; Resolved `#3C8D6E`
Dark: Paper `#14161D`, Sheet `#1B1E27`, Rule `#2A2E3B`, Ink `#E7E9F2`, Ink-soft `#9AA1B8`, Cobalt `#8C9BFF`, Highlighter `#F2C94C` (ink `#1B2033` on it), wash `#3A3320`, add `#14281D`/`#5CC28A`, del `#2E1717`/`#F07A73`.

Type: IBM Plex Sans (UI) with IBM Plex Sans Arabic in the same stack (Arabic comments render in a matching face), IBM Plex Mono (code). Self-hosted from npm `@fontsource/ibm-plex-sans`, `@fontsource/ibm-plex-sans-arabic`, `@fontsource/ibm-plex-mono` (OFL; woff2 only; weights 400/500/600), served at `/vendor/fonts/...` (CSP stays `'self'`). Scale: 12 / 13 / 14 (body) / 16 / 20 / 26, line-height 1.5 body, 1.45 code at 13px. Sentence case everywhere; no all-caps labels, no middle-dot meta strings, no arrows appended to buttons.

Layout:
```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ◧ LiveReview   Demo ▾   main ● live            Changes  Commits  Comments(3)  🔔2  (A) │
├───────────────┬─────────────────────────────────────────────────────────────┤
│ Files      12 │ src/app.php                       +4 −1      ✎ 2 comments    │
│ M app.php   ▮2│  12  12   function a() {                                    │
│ A util.js     │  13     − return 1;                                         │
│ D old.css     │      13 + return 2;                                    ▮ 2 │  ← highlighter tab in margin
│               │      ┌ thread (expanded on click) ─────────────────────┐    │
│               │      │ Rana · 2m  "Why 2 here?"   Reply  Resolve       │    │
│               │      └──────────────────────────────────────────────────┘    │
└───────────────┴─────────────────────────────────────────────────────────────┘
```
- Top bar: product mark, project switcher, branch + live dot (green pulse only when connected; grey "offline" otherwise), tabs Changes / Commits / Comments (count of open), notification bell with unread count, avatar menu (name, email notifications toggle, sign out).
- Project list: a quiet list of rows (name, branch, open comments, last change), not cards.
- Diff: one sheet per file with a sticky file header (path, +/− counts, comment count, collapse); gutters muted; a dedicated right margin column holds comment marks. Hover a line → small "+" in the left gutter. Left-aligned throughout.
- Threads collapsed by default inline; a mark shows count (and a check when all resolved). Clicking the mark toggles the thread open under the line with a highlighter-wash background. Deep links `#c-{id}` open + scroll + flash once.
- Comments page `/:slug/comments` (and admin `/admin#comments` across projects): filters Open / Resolved / All and "Only mine"; grouped by file; each thread shows a 3–7 line code snippet with the commented line highlighted, the conversation, inline reply box, Resolve/Reopen, "Show in code" (navigates to the line in Changes or the commit), and "Hide" (collapses the card; hidden state remembered per viewer in localStorage).
- Notifications: bell dropdown (latest 30, unread highlighted, click → go to the comment, "Mark all read"); a toast slides in for new notifications; desktop notification when permitted.
- Motion: only in answer to actions (thread open/close 150 ms, toast in/out, deep-link flash). Respect `prefers-reduced-motion`.
- Responsive: ≤ 900 px the file list becomes a drawer; ≤ 600 px the top-bar tabs become a bottom segmented control; no horizontal page scroll (code scrolls inside its sheet).

## Notification rules (backend)
- Events: `comment` (new top-level), `reply`, `resolved`, `reopened`.
- Recipients: the owner (config.ownerEmail) + every participant of the thread (top-level author + all repliers) who is still a member of the project — minus the actor. For `comment` (new top-level): owner only (as today).
- Persisted in a new table `notifications(id, recipient_email, project_id, comment_id /*thread root*/, kind, actor_email, created_at, read_at)`; migration v2.
- Delivered live over WebSocket to the recipient's sockets (`{type:'notification', notification}`), owner sockets = admin listener; reviewer sockets = public listener by email.
- Email: batched per recipient (default 60 s) through the existing sender when email is configured and the recipient has email notifications on (new `users.email_notifications` column, default 1; owner preference stored in config `ownerEmailNotifications`, default true). Owner links: `http://localhost:{adminPort}/...`; reviewer links: `https://{publicHost}/...`. Replaces the v1 owner-only mailer.
- APIs (both listeners, recipient = viewer email): `GET /api/notifications?limit=30` → `{items, unread}`; `POST /api/notifications/read {ids?:number[], all?:true}`; `PUT /api/me/prefs {emailNotifications:boolean}` (owner variant stores config).
- Threads listing: `GET /api/p/:slug/threads?status=open|resolved|all` → threads across live + commits incl. outdated/rewritten, each with `location {target, path, line, side}`, `snippet` (from the stored anchor: up to 3 before, the line, 3 after; `null` for hidden files), flags. `GET /api/admin/threads?status=` same across projects with `{slug, projectName}`.

## Non-goals
Per-thread "hide for everyone", mentions, rich text beyond `code`/fenced blocks, syntax highlighting.
