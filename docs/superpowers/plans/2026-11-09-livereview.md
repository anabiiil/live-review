# LiveReview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Node.js app on the owner's machine that serves invited reviewers a live, read-only view of uncommitted changes and commit history for several git projects, with line comments, via a Cloudflare Tunnel on one hostname.

**Architecture:** One Node process, two HTTP listeners on 127.0.0.1: a public listener (the only thing cloudflared reaches) and an admin listener (owner only, one-time token). Git data comes from spawning the system `git`. Per-project chokidar watchers, ref-counted by connected viewers, debounce into a recompute → re-anchor comments → WebSocket broadcast pipeline. State lives in one `node:sqlite` file.

**Tech Stack:** Node.js ≥24 (ESM, plain JavaScript with JSDoc types), `node:sqlite`, `node:http`, `node:test`; npm deps `chokidar@4`, `ws@8`, `diff2html@3`. No other runtime deps.

**Spec:** `docs/superpowers/specs/2026-11-09-livereview-design.md`

## Global Constraints

- Node `>=24` in `engines`; startup exits with a clear message on older Node; only the `node:sqlite` ExperimentalWarning is suppressed.
- No native npm modules, no bundled executables, no obfuscation/minification of server code, no packers (`pkg`, `nexe`).
- LiveReview never downloads binaries; `cloudflared` is the owner's own install, started only if configured, as a visible child process, killed on exit.
- Both listeners bind `127.0.0.1` only. Defaults: public port `4317`, admin port `4318`.
- No autostart / registry / launch agents / services. No telemetry. Outbound traffic only to Cloudflare (via cloudflared) and `https://api.resend.com`.
- Reads only folders the owner added; a project path must equal `git rev-parse --show-toplevel`; home dir and drive roots rejected; symlinks not followed outside the repo; submodule contents not shown.
- Every git call passes `-c core.quotepath=false` and uses `--no-color --no-ext-diff`.
- Default hidden list (exact): `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `*.jks`, `id_rsa*`, `id_ed25519*`, `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`, `credentials*.json`, `*secret*`, `*.kdbx`, `auth.json`. Matched against the file's basename, case-insensitive. Applied to live diff, commit diffs (all history), file lists, comment anchors.
- Limits: untracked file >1 MB → "large file added" without content; >300 untracked files → first 300 + note; debounce 300 ms; watcher stops 60 s after last viewer leaves.
- Auth: 6-digit code, 10 min, single use, burned after 5 wrong tries; ≤5 codes/email/hour, ≤20 requests/IP/hour (IP = `Cf-Connecting-IP`); login-request response padded to ≥800 ms and identical for members and non-members. Session cookie `lr_session`: `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`, token stored as SHA-256. Owner cookie `lr_owner`: `HttpOnly; SameSite=Strict; Path=/`, admin listener only.
- Invite link: `/invite/{token}`, 32 random bytes base64url, stored hashed, single use, 7 days, bound to email; regenerate invalidates previous; member removal invalidates.
- Public listener: `Host` must equal `config.publicHost`; state-changing requests and WS upgrades need `Origin: https://{publicHost}`; never serves `/admin` or `/api/admin/*` (404).
- Admin listener: `Host` must be `localhost:{adminPort}` or `127.0.0.1:{adminPort}`; state-changing requests and WS upgrades need matching `http://` Origin.
- Data dir: macOS `~/Library/Application Support/LiveReview`, Windows `%APPDATA%\LiveReview`, Linux (dev only) `~/.config/livereview`; overridable with env `LIVEREVIEW_DATA_DIR` (tests use this). Files: `config.json`, `livereview.db`.
- A "no access" response must be identical for a project that does not exist and one the viewer is not a member of.

## Review Focus

1. **Paths with spaces, Arabic/Unicode, or quotes** — diff, hidden check, comments and URLs must work for `src/مجلد/my file.php`. Test in Task 1 (parser) and Task 4 (live diff).
2. **Windows CRLF files** — a comment's anchor must still match when lines end in `\r\n`. Test in Task 7.
3. **Burst of file events** (checkout touching hundreds of files) — must collapse into one recompute, not hundreds of `git` spawns. Test in Task 10.
4. **Reviewer removed while connected** — their open socket for that project is closed and further API calls get "no access". Test in Task 13.
5. **Project folder moved/deleted or not a repo anymore while running** — that project shows an error state; the server and other projects keep working. Test in Task 4 (diff throws typed error) and Task 11 (API returns 503 JSON, not a crash).

---

## File Structure

```
package.json                 engines, scripts (start, test), deps
bin/livereview.js            entry: node version check, warning filter, boot
src/app.js                   createApp(config, deps) wires services + listeners; start/stop
src/config.js                data dir, load/save config.json, defaults
src/db.js                    open sqlite, schema migration
src/git/run.js               runGit(cwd, args, opts) — spawn wrapper
src/git/parseDiff.js         unified diff text → FileDiff[]
src/git/repo.js              repo root validation, head state, commits, file at rev, reachability
src/git/diff.js              liveDiff, commitDiff (filters + caps applied)
src/privacy/hidden.js        hidden-file rules
src/projects/store.js        projects + members + invite tokens
src/projects/preview.js      visible/hidden file preview for add-project
src/comments/anchor.js       makeAnchor / findAnchor (pure)
src/comments/store.js        comment CRUD + queries
src/comments/reanchor.js     reanchorLive, attachOnCommit, markRewritten, wipeHidden
src/auth/codes.js            login codes + rate limits
src/auth/sessions.js         reviewer sessions, owner token/sessions
src/auth/email.js            Resend sender
src/watch/watcher.js         WatcherPool: ref-counted, debounced project watchers
src/live/pipeline.js         recompute → reanchor → broadcast for one project
src/http/router.js           tiny method+pattern router, body/json/cookie helpers
src/http/guards.js           host/origin checks, viewer resolution, access check
src/http/api.js              shared viewer API routes (both listeners)
src/http/adminApi.js         admin-only routes
src/http/pages.js            HTML shells for pages
src/http/ws.js               WebSocket hub
src/tunnel.js                start/stop cloudflared
src/openBrowser.js           open URL in default browser
public/app.js, public/app.css, public/admin.js   browser UI
test/helpers/tmpRepo.js      temp git repo factory
test/**/*.test.js            node:test suites
README.md
```

Shared types (JSDoc in `src/types.js`, referenced by all tasks):

```js
/** @typedef {{type:'add'|'del'|'ctx', oldNo:number|null, newNo:number|null, text:string}} DiffLine */
/** @typedef {{header:string, lines:DiffLine[]}} Hunk */
/** @typedef {{path:string, oldPath:string|null, status:'added'|'modified'|'deleted'|'renamed',
 *   binary:boolean, hidden:boolean, large:boolean, hunks:Hunk[], patch:string}} FileDiff */
/** @typedef {{branch:string|null, detached:boolean, sha:string|null, empty:boolean,
 *   operation:null|'rebase'|'merge'}} HeadState */
/** @typedef {{sha:string, short:string, subject:string, author:string, date:string}} CommitSummary */
/** @typedef {{lineText:string, before:string[], after:string[]}} Anchor */
/** @typedef {{kind:'owner'|'reviewer', email:string, name:string|null}} Viewer */
```

`patch` is the per-file unified diff text (header + hunks) fed to diff2html; for hidden/binary/large files `hunks=[]` and `patch` is a header-only stub.

---

### Task 1: Scaffold, git runner, diff parser

**Files:**
- Create: `package.json`, `.gitignore`, `src/types.js`, `src/git/run.js`, `src/git/parseDiff.js`, `test/helpers/tmpRepo.js`
- Test: `test/git/parseDiff.test.js`, `test/git/run.test.js`

**Interfaces:**
- Produces: `runGit(cwd: string, args: string[], opts?: {input?: string, allowFail?: boolean}) => Promise<{stdout:string, code:number}>` — rejects with `GitError {code, stderr, args}` on non-zero unless `allowFail`. `parseDiff(text: string) => FileDiff[]` (hidden/large false, binary detected from `Binary files … differ`). `makeTmpRepo() => Promise<{dir, git(...args), write(rel, content), commit(msg) => sha, cleanup()}>`.

- [ ] **Step 1:** `package.json`: `"type":"module"`, `"engines":{"node":">=24"}`, scripts `"start":"node bin/livereview.js"`, `"test":"node --test --test-concurrency=1 \"test/**/*.test.js\""`; deps `chokidar@^4`, `ws@^8`, `diff2html@^3`. `npm install`. `.gitignore`: `node_modules/`.
- [ ] **Step 2: Write failing tests** — `parseDiff`: modified file with two hunks gives correct `oldNo/newNo` per line; added file (`--- /dev/null`) → `status:'added'`; deleted; rename with `similarity index` → `status:'renamed'`, `oldPath` set; binary → `binary:true, hunks:[]`; path `src/مجلد/my file.php` round-trips exactly (git output with `core.quotepath=false`); `\ No newline at end of file` lines are not emitted as DiffLines; CRLF content keeps `\r` stripped from `text`. `runGit`: `['rev-parse','--is-inside-work-tree']` in tmp repo → `"true\n"`; bad command rejects with `GitError`.
- [ ] **Step 3:** Run `npm test` → FAIL (modules missing).
- [ ] **Step 4:** Implement `runGit` with `child_process.spawn('git', ['-c','core.quotepath=false', ...args], {cwd, windowsHide:true})`, collecting UTF-8 stdout; never use a shell. Implement `parseDiff` by splitting on `^diff --git ` and reading `---`/`+++`/`rename from`/`rename to`/`new file mode`/`deleted file mode`/`Binary files` headers; paths come from `---`/`+++` lines (strip `a/`,`b/`), falling back to `rename to`.
- [ ] **Step 5:** `npm test` → PASS.
- [ ] **Step 6:** Commit `feat: scaffold, git runner and diff parser`.

### Task 2: Hidden-file rules

**Files:** Create `src/privacy/hidden.js`; Test `test/privacy/hidden.test.js`

**Interfaces:**
- Produces: `DEFAULT_HIDDEN: string[]` (exact list from Global Constraints); `isHidden(path: string, extra?: string[]) => boolean`; `redactFiles(files: FileDiff[], extra?: string[]) => FileDiff[]` (sets `hidden:true`, `hunks:[]`, stub `patch` for matches; checks both `path` and `oldPath`).

- [ ] **Step 1: Failing tests** — `isHidden` true for `.env`, `config/.env.production`, `certs/server.PEM`, `id_ed25519.pub`, `app/credentials-prod.json`, `src/client_secret.ts`, `composer/auth.json`; false for `environment.ts`, `src/keyboard.js`, `README.md`; extra pattern `config/*.yml`-style basename glob `*.yml` hides `a/b.yml`. `redactFiles` on a renamed file whose `oldPath` is `.env` → hidden.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement glob→RegExp for `*` only (no `**`), anchored, case-insensitive, matched on basename.
- [ ] **Step 4:** Run → PASS. **Step 5:** Commit `feat: hidden-file rules`.

### Task 3: Repository queries

**Files:** Create `src/git/repo.js`; Test `test/git/repo.test.js`

**Interfaces:**
- Consumes: `runGit`.
- Produces:
  - `validateRepoRoot(path) => Promise<string>` (returns normalized root; throws `RepoError` with `reason: 'not-a-repo'|'not-root'|'forbidden'` — forbidden = `os.homedir()` or a filesystem root).
  - `headState(root) => Promise<HeadState>` (`operation` from existence of `git rev-parse --git-path rebase-merge|rebase-apply|MERGE_HEAD`).
  - `listCommits(root, {skip, limit}) => Promise<{commits: CommitSummary[], hasMore: boolean}>` (fetch `limit+1`).
  - `commitInfo(root, sha) => Promise<{sha, author, email, date, message, parents:string[]}>` (throws `RepoError('unknown-commit')`; `sha` must match `/^[0-9a-f]{7,40}$/`).
  - `fileAt(root, rev, path) => Promise<string|null>` (`git show rev:path`, null if absent).
  - `isReachable(root, sha) => Promise<boolean>` (`git for-each-ref --contains sha refs/heads`, non-empty).
  - `gitDir(root) => Promise<string>` (absolute).
  - `EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'`.

- [ ] **Step 1: Failing tests** — subfolder path → `not-root`; plain folder → `not-a-repo`; `os.homedir()` → `forbidden`; fresh repo → `{empty:true, sha:null, branch:'main'}`; after commit → sha set; `git checkout --detach` → `detached:true`; `listCommits` with 3 commits, limit 2 → 2 + `hasMore:true`; `commitInfo` of root → `parents:[]`; `isReachable` false after `git commit --amend` for the old sha; `commitInfo(root,'zzz')` rejects `unknown-commit`.
- [ ] **Step 2–4:** Run FAIL → implement (`git log --format=%H%x00%h%x00%s%x00%an%x00%aI -z`) → PASS.
- [ ] **Step 5:** Commit `feat: repository queries`.

### Task 4: Live and commit diffs

**Files:** Create `src/git/diff.js`; Test `test/git/diff.test.js`

**Interfaces:**
- Consumes: `runGit`, `parseDiff`, `redactFiles`, `headState`, `EMPTY_TREE`.
- Produces:
  - `liveDiff(root, {extraHidden}) => Promise<{head: HeadState, files: FileDiff[], untrackedTruncated: boolean}>` — `git diff <HEAD|EMPTY_TREE> -M` + untracked from `git ls-files --others --exclude-standard -z` (first 300; each synthesized as an added FileDiff; >1 MB → `large:true`, no hunks; binary sniff = NUL byte in first 8 KB). Submodule entries show only the pointer line. Untracked paths that resolve (realpath) outside root are skipped.
  - `commitDiff(root, sha, {extraHidden}) => Promise<FileDiff[]>` — `git diff <parents[0]|EMPTY_TREE> <sha> -M`.
  - Both throw `RepoError('missing')` when root no longer exists / is no longer a repo.

- [ ] **Step 1: Failing tests** — modify tracked file → one `modified` FileDiff; stage one change + leave another unstaged → both appear; new untracked `notes.md` → `added` with content lines; untracked ignored file (in `.gitignore`) → absent; tracked `.env` change → `hidden:true`, `patch` has no secret text; untracked `big.log` 1.5 MB not ignored → `large:true`; 305 untracked files → 300 + `untrackedTruncated:true`; empty repo with one untracked file → added; `src/مجلد/my file.php` modified → path exact; `commitDiff` of root commit lists all files as added; merge commit diffs against first parent; old commit containing `.env` → hidden; deleting the repo dir then `liveDiff` → rejects `RepoError` `reason:'missing'`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat: live and commit diffs with redaction`.

### Task 5: Config and database

**Files:** Create `src/config.js`, `src/db.js`; Test `test/config.test.js`, `test/db.test.js`

**Interfaces:**
- Produces: `dataDir() => string`; `loadConfig() => Config`; `saveConfig(partial) => Config`; `isConfigured(cfg) => boolean` (publicHost, resendApiKey, fromEmail, ownerName, ownerEmail all set).
  `Config = {publicHost, resendApiKey, fromEmail, ownerName, ownerEmail, tunnelName, publicPort:4317, adminPort:4318}`.
  `openDb(file?) => DatabaseSync` with schema applied idempotently (`PRAGMA user_version`):

```sql
projects(id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, path TEXT UNIQUE NOT NULL,
         extra_hidden TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL)
members(project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, email TEXT NOT NULL,
        invited_at INTEGER NOT NULL, PRIMARY KEY(project_id, email))
invites(token_hash TEXT PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        email TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER)
users(email TEXT PRIMARY KEY, name TEXT)
login_codes(id INTEGER PRIMARY KEY, email TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0)
code_requests(id INTEGER PRIMARY KEY, email TEXT NOT NULL, ip TEXT NOT NULL, at INTEGER NOT NULL)
sessions(token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at INTEGER NOT NULL)
comments(id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
         parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE, target TEXT, path TEXT, line INTEGER,
         side TEXT CHECK(side IN ('old','new')), anchor TEXT, author_email TEXT NOT NULL, body TEXT NOT NULL,
         created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, resolved INTEGER NOT NULL DEFAULT 0,
         outdated INTEGER NOT NULL DEFAULT 0, rewritten INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0)
```
  Emails are stored lowercased and trimmed everywhere.

- [ ] **Step 1: Failing tests** — with `LIVEREVIEW_DATA_DIR` set, `dataDir()` returns it; `dataDir()` per platform (stub `process.platform`) gives the three paths above; `loadConfig()` on empty dir returns defaults; `saveConfig` persists and merges; `openDb` twice on same file doesn't error; `foreign_keys` on (deleting a project cascades members).
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat: config and database`.

### Task 6: Projects, members, invite links, preview

**Files:** Create `src/projects/store.js`, `src/projects/preview.js`; Test `test/projects/store.test.js`, `test/projects/preview.test.js`

**Interfaces:**
- Consumes: `openDb`, `validateRepoRoot`, `isHidden`, `runGit`.
- Produces: `createProjectStore(db)` returning
  `{ list(), get(id), bySlug(slug), add({path,name,slug?}), update(id,{name?,slug?,extraHidden?}), remove(id),
     members(projectId), addMember(projectId,email), removeMember(projectId,email), isMember(projectId,email),
     projectsFor(viewer: Viewer), canView(viewer, projectId),
     createInvite(projectId,email,now) => token, redeemInvite(token,now) => {email, projectId}|null }`.
  `slugify(name)` → lowercase ASCII `[a-z0-9-]`, non-Latin names fall back to `project-{n}`; collisions get `-2`, `-3`; reserved slugs `admin, api, login, logout, invite, vendor, static, ws` are rejected.
  `previewProject(path, extraHidden) => Promise<{root, visible: string[], hidden: string[]}>` from `git ls-files -z` + untracked non-ignored.
- `add` calls `validateRepoRoot` and stores the returned root. `createInvite` deletes earlier unused invites for the same (project,email). `removeMember` deletes their invites.

- [ ] **Step 1: Failing tests** — add from subfolder rejects; slug from "Nwc Legal" = `nwc-legal`, second same name → `nwc-legal-2`, `admin` rejected; owner viewer sees all projects, reviewer sees only memberships; emails case-insensitive (`A@X.com` == `a@x.com`); invite redeem works once, second redeem null, expired (now+8d) null, regenerated invite invalidates old token, removed member's token null; preview of a repo with `.env` and `src/a.js` puts them in hidden/visible respectively.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat: projects, members and invite links`.

### Task 7: Anchor matching

**Files:** Create `src/comments/anchor.js`; Test `test/comments/anchor.test.js`

**Interfaces:**
- Produces: `makeAnchor(lines: string[], lineNo: number) => Anchor` (1-based; up to 3 before/after; strips trailing `\r`). `findAnchor(lines: string[], anchor: Anchor, oldLine: number) => number|null`.
- Algorithm: candidates = indices where `lines[i] === lineText` (after `\r` strip) and each available context line equals the stored one; if none, null; else the candidate nearest `oldLine` (ties → lower).

- [ ] **Step 1: Failing tests** — unchanged file → same line; two lines inserted above → line+2; commented line edited → null; duplicate identical blocks → nearest to oldLine; anchor made from LF file matches CRLF file; anchor at line 1 (no before context) works; last line works.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat: comment anchor matching`.

### Task 8: Comments store and re-anchoring

**Files:** Create `src/comments/store.js`, `src/comments/reanchor.js`; Test `test/comments/store.test.js`, `test/comments/reanchor.test.js`

**Interfaces:**
- Consumes: `openDb`, `makeAnchor`, `findAnchor`, `fileAt`, `isReachable`, `isHidden`, `FileDiff`.
- Produces: `createCommentStore(db)` → `{ create({projectId,target,path,line,side,anchor,authorEmail,body,now}), reply(parentId,{authorEmail,body,now}), edit(id,actor:Viewer,body), setResolved(id,actor,bool), delete(id,actor), get(id), forTarget(projectId,target) => Thread[], openCounts(projectId) => {total, byPath: Record<string,number>}, liveActive(projectId), commitTargets(projectId), wipeHidden(projectId, predicate) }`. `Thread = Comment & {replies: Comment[], authorName}`.
  Permissions: edit/delete only by author; resolve by author or owner; delete by owner allowed. Violations throw `ForbiddenError`.
  `reanchorLive({root, projectId, files, store, extraHidden}) => Promise<number[]>` (changed comment ids). For each non-outdated live comment: content = new side → working-tree file; old side → `fileAt(root,'HEAD',path)`; `findAnchor`; also require the found line to be visible in that file's hunks on the comment's side; else `outdated=1`.
  `attachOnCommit({root, projectId, sha, commitFiles, store}) => Promise<number[]>` — same matching against `fileAt(root, sha, path)` and the commit's hunks; matches move to `target=sha`.
  `markRewritten({root, projectId, store}) => Promise<number[]>` — commit-target comments whose sha is not reachable get `rewritten=1`.
- Creating a comment on a hidden or binary file throws `ValidationError`.

- [ ] **Step 1: Failing tests** — reviewer cannot edit owner's comment; owner can resolve reviewer's comment; reply inherits project; live comment survives inserting lines above (line moves); editing commented line → outdated; reverting a change so line leaves the diff → outdated; commit containing the commented change → comment target becomes sha; amend → `rewritten=1`; adding `*.yml` to extra hidden + `wipeHidden` clears anchor and sets `hidden=1`; comment on `.env` rejected.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat: comments with re-anchoring`.

### Task 9: Auth — codes, sessions, owner token, invites redemption, email

**Files:** Create `src/auth/codes.js`, `src/auth/sessions.js`, `src/auth/email.js`; Test `test/auth/*.test.js`

**Interfaces:**
- Produces:
  - `createCodeService(db, {isAllowedEmail: (email)=>boolean})` → `requestCode(email, ip, now) => {code: string|null}` (null when not member or rate-limited — callers treat both identically), `verifyCode(email, code, now) => boolean`.
  - `createSessionService(db)` → `create(email, now) => token`, `lookup(token, now) => {email}|null`, `revokeAllFor(email)`, `revoke(token)`.
  - `createOwnerAuth()` (in-memory) → `issueOneTime() => token`, `exchange(token) => sessionToken|null` (one-time token single use), `isOwnerSession(sessionToken) => boolean`.
  - `createEmailSender({apiKey, from, fetch = globalThis.fetch})` → `send({to, subject, text}) => Promise<{ok:true}|{ok:false, error:string}>` — POST `https://api.resend.com/emails`, never throws.
  - `inviteEmail({projectName, link, ownerName}) => {subject, text}`, `codeEmail(code) => {subject, text}`.
- Codes via `crypto.randomInt(0, 1e6)` zero-padded; hashes SHA-256; comparisons `crypto.timingSafeEqual`.

- [ ] **Step 1: Failing tests** — correct code verifies once; second use false; after 10 min false; 5 wrong attempts then correct → false; 6th request same email within hour → `code:null`; 21st request same IP → null; non-member → null; session lookup valid until 30 days, then null; `revokeAllFor` kills sessions; owner one-time token exchanges once; email sender with stub fetch returning 422 → `{ok:false}` with message; network throw → `{ok:false}`.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat: auth services and email sender`.

### Task 10: Watcher pool

**Files:** Create `src/watch/watcher.js`; Test `test/watch/watcher.test.js`

**Interfaces:**
- Consumes: `chokidar`, `runGit`, `gitDir`.
- Produces: `createWatcherPool({onChange: (projectId) => void, debounceMs = 300, graceMs = 60000})` → `acquire(projectId, root) => Promise<void>`, `release(projectId)`, `active() => number[]`, `closeAll()`.
- Watches root with `ignored` = function rejecting `node_modules`, `.git/objects`, and the ignored directories from `git ls-files --others --ignored --exclude-standard --directory -z` (computed at acquire); also watches `<gitDir>/HEAD`, `<gitDir>/index`, `<gitDir>/refs`. `followSymlinks:false`. Events debounced per project into one `onChange`.

- [ ] **Step 1: Failing tests** (use `debounceMs: 50`, `graceMs: 100`) — write a file → one `onChange`; write 200 files in a loop → exactly one `onChange` (Review Focus 3); write inside an ignored `dist/` → none; commit → `onChange`; two acquires + one release → still watching; after last release + grace → `active()` empty.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat: ref-counted debounced watcher pool`.

### Task 11: HTTP core and viewer API

**Files:** Create `src/http/router.js`, `src/http/guards.js`, `src/http/api.js`, `src/http/pages.js`, `src/app.js`; Test `test/http/api.test.js`, `test/http/guards.test.js`

**Interfaces:**
- Consumes: stores/services from Tasks 3–9.
- Produces: `createApp({config, db, now = Date.now, emailSender?})` → `{start() => Promise<{publicPort, adminPort}>, stop(), services}` where `services = {projects, comments, codes, sessions, owner, pipeline?, hub?}` (pipeline/hub attached in Task 13). Listeners on `127.0.0.1`; ports `0` allowed in tests.
- Guards: `resolveViewer(req, listener) => Viewer|null` (public: `lr_session`; admin: `lr_owner` → owner viewer from config). Host/Origin rules exactly as in Global Constraints; failures → 403 JSON `{error:'forbidden'}` (host → 421).
- Routes on both listeners (JSON unless page):
  - Pages `GET /`, `/login`, `/invite/:token`, `/:slug`, `/:slug/live`, `/:slug/commits`, `/:slug/commit/:sha` → HTML shell (`pages.js`) loading `/static/app.js`; unauthenticated → redirect `/login` (except `/login`, `/invite/:token`).
  - `GET /invite/:token` (public): redeem → create session, set cookie, redirect to `/{slug}`; invalid → page "This invite link is no longer valid".
  - `POST /api/login/request {email}` → always `200 {ok:true}` after ≥800 ms; sends `codeEmail` when a code was issued.
  - `POST /api/login/verify {email, code}` → sets `lr_session` or `401`.
  - `POST /api/logout`; `GET /api/me` → `{email,name,kind}`; `POST /api/me/name {name}` (1–60 chars).
  - `GET /api/projects` → `[{slug,name,open}]`.
  - `GET /api/p/:slug/live` → `{head, files, untrackedTruncated}`; `GET /api/p/:slug/commits?page=N` (20 per page); `GET /api/p/:slug/commit/:sha` → `{commit, files}`; `GET /api/p/:slug/comments?target=live|<sha>` → `{threads, outdated, rewritten}`.
  - `POST /api/p/:slug/comments`, `POST /api/comments/:id/replies`, `PATCH /api/comments/:id {body?, resolved?}`, `DELETE /api/comments/:id`.
  - No access / unknown slug → `404 {error:'no-access'}` (identical). `RepoError('missing')` → `503 {error:'project-unavailable'}`. Unknown commit → 404.
  - Static: `/static/*` from `public/`, `/vendor/diff2html/*` from `node_modules/diff2html/bundles/`.
- Public listener: `/admin*`, `/api/admin/*` → 404.

- [ ] **Step 1: Failing tests** (spin app on port 0, temp data dir, tmp repo project, stub email) — wrong Host on public → 421; POST without Origin → 403; reviewer without session `GET /api/projects` → 401; invite link signs in and redirects to `/nwc-legal`; reviewer sees only member project; other project and nonexistent slug give byte-identical 404 bodies; `/api/p/x/live` returns modified file; `.env` content never appears in any response body; login request for non-member returns 200 and sends no email, member gets one email; response time ≥800 ms in both; project dir deleted → 503 and `/api/projects` still 200 (Review Focus 5); `/admin` on public listener → 404.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat: http core and viewer api`.

### Task 12: Admin API

**Files:** Create `src/http/adminApi.js`; Modify `src/app.js`; Test `test/http/adminApi.test.js`

**Interfaces:**
- Admin listener only, owner viewer required:
  - `GET /admin?t=TOKEN` → exchange, set `lr_owner`, redirect `/admin`; `GET /admin` without owner session → page "Open LiveReview from the link printed in your terminal."
  - `GET /api/admin/config` (never returns `resendApiKey`, returns `hasResendKey`) / `PUT /api/admin/config`.
  - `POST /api/admin/projects/preview {path}` → `{root, visible, hidden}` or `400 {error, reason}`.
  - `POST /api/admin/projects {path,name,slug?}`, `PATCH /api/admin/projects/:id {name?,slug?,extraHidden?}` (extraHidden change runs `wipeHidden`), `DELETE /api/admin/projects/:id`.
  - `GET /api/admin/projects` → with members and open counts.
  - `POST /api/admin/projects/:id/members {email}` → adds, creates invite, sends `inviteEmail`; returns `{inviteLink, emailSent: boolean, emailError?}`. `inviteLink = https://{publicHost}/invite/{token}`.
  - `POST /api/admin/projects/:id/members/:email/invite` → regenerate link (and resend email).
  - `DELETE /api/admin/projects/:id/members/:email` → removes, invalidates invites; if the email has no remaining memberships, `sessions.revokeAllFor(email)`.
- Comments posted from the admin listener are authored as `config.ownerEmail`.

- [ ] **Step 1: Failing tests** — no owner cookie → 401; one-time token works once; config GET hides key; preview of home dir → 400 `forbidden`; add project + member returns an inviteLink that redeems on the public listener; email failure still returns 200 with `emailSent:false` and a working link; regenerate invalidates old link; removing last membership revokes the reviewer's session; cross-origin POST → 403.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat: admin api with invite links`.

### Task 13: WebSocket hub and live pipeline

**Files:** Create `src/http/ws.js`, `src/live/pipeline.js`; Modify `src/app.js`, `src/http/api.js`, `src/http/adminApi.js`; Test `test/live/pipeline.test.js`, `test/http/ws.test.js`

**Interfaces:**
- `createHub()` attached to both servers' `upgrade` (path `/ws`, same Host/Origin/viewer rules). Client→server: `{type:'subscribe', slug}`, `{type:'unsubscribe', slug}`. Server→client: `{type:'live', slug, head, files, untrackedTruncated}`, `{type:'comments', slug, target}` (refetch hint), `{type:'notify', slug, commentId, path, line, author, excerpt, url}` (owner sockets only, on every new comment/reply not authored by owner), `{type:'revoked', slug}`, `{type:'error', slug, error:'project-unavailable'}`.
- Subscribe: checks `canView`; calls `watcherPool.acquire`; sends current live state immediately. Unsubscribe/close → `release`.
- `createPipeline({projects, comments, watcherPool, hub, repo, diff})` → `recompute(projectId)`: liveDiff → if `head.sha` changed and new commit's first parent is the previous sha, `attachOnCommit`; `markRewritten` when head changed otherwise; `reanchorLive`; broadcast `live` + `comments`. Errors → broadcast `error`, never throw out.
- Hub `revoke(projectId, email)` used by member removal: sends `revoked` and drops that subscription.
- Comment create/reply/edit/resolve/delete routes broadcast `comments` (and `notify` for create/reply).

- [ ] **Step 1: Failing tests** — subscribed reviewer gets `live` within 2 s of a file write; commit moves a live comment and clients get `comments`; owner socket gets `notify` when reviewer comments, reviewer socket doesn't; **removing reviewer while connected → `revoked` received and next `GET /api/p/:slug/live` → 404** (Review Focus 4); subscribing to non-member slug → `error`-free silent ignore (no info leak) and no watcher acquired; deleting project dir → `error` broadcast, other project still updates.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** Commit `feat: websocket hub and live pipeline`.

### Task 14: Reviewer UI

**Files:** Create `public/app.js`, `public/app.css`; Modify `src/http/pages.js`

**Interfaces:**
- Consumes: viewer API + WS from Tasks 11/13; diff2html from `/vendor/diff2html/diff2html.min.js` and `.min.css`.
- Single client script routes on `location.pathname`: login (email → code steps, then name prompt if `name` null), project list (with open counts), project live view, commits list (paged), commit view. Header shows project, branch / "detached at {sha}" / rebase-merge banner, and an offline indicator when the socket drops (auto-reconnect with backoff).
- Diff: diff2html, side-by-side/unified toggle remembered in `localStorage` (try/catch). File list sidebar with per-file open-comment counts. Hidden files show "hidden file changed", binary "binary file changed", large "large file — show" (collapsed), truncated-untracked note.
- Comments: clicking a line number opens a composer on that line (side old/new from the column); threads render under their line; reply, edit/delete own, resolve; "Outdated comments" and "Comments on rewritten commits" collapsible sections; `#c-{id}` scrolls to and highlights the thread. Live updates replace the diff without losing scroll position or open composers (keep composer text across re-render keyed by path+line+side).
- Light/dark via `prefers-color-scheme`; readable at 375 px width.

- [ ] **Step 1:** Implement.
- [ ] **Step 2: Verify in the browser** — `npm start` against a sample repo, sign in through an invite link, then confirm: editing a file updates the page in <2 s without reload; comment on a line, then insert lines above it in the editor → comment follows; commit → comment appears on the commit page; deep link `#c-{id}` scrolls; Arabic path renders; dark mode readable; narrow width usable.
- [ ] **Step 3:** Commit `feat: reviewer web ui`.

### Task 15: Admin UI

**Files:** Create `public/admin.js`; Modify `src/http/pages.js`

- Setup screen when `!isConfigured`: public hostname, Resend API key, sender address, owner name/email, tunnel name; short steps for Cloudflare tunnel (`cloudflared tunnel login`, `cloudflared tunnel create livereview`, `cloudflared tunnel route dns livereview review.example.com`, the `--url http://127.0.0.1:4317` note) and Resend domain verification.
- Projects: add (path + name → preview list of visible/hidden files → confirm), rename/slug, extra hidden patterns, remove (confirm). Members: add email → shows invite link with **Copy** button always, plus email status/error; regenerate link; remove (confirm).
- All-projects comment inbox with unresolved counts; owner can reply/resolve here or open the project page (same UI as Task 14, served on admin listener).
- Notifications: ask `Notification.requestPermission()` on a button click; on WS `notify` show `new Notification(\`${author} commented on ${path}:${line}\`)`; click focuses the tab and opens `url`. Title shows unread count.

- [ ] **Step 1:** Implement.
- [ ] **Step 2: Verify in the browser** — fresh data dir shows setup; add project shows preview with `.env` under hidden; add member → copy link → open in a private window → signed in to that project only; reviewer comment triggers a system notification on macOS; email failure (bad key) shows the error and link still works.
- [ ] **Step 3:** Commit `feat: admin web ui`.

### Task 16: Startup, tunnel, browser open, README

**Files:** Create `bin/livereview.js`, `src/tunnel.js`, `src/openBrowser.js`, `README.md`; Test `test/startup.test.js`

**Interfaces:**
- `bin/livereview.js`: if `Number(process.versions.node.split('.')[0]) < 24` → print `LiveReview needs Node.js 24 or newer (you have vX).` and exit 1; filter only warnings where `w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)`; `createApp(...).start()`; print `Admin: http://localhost:{adminPort}/admin?t={token}`; `openBrowser(url)` unless env `LIVEREVIEW_NO_BROWSER=1`; `startTunnel(config)`; on SIGINT/SIGTERM stop tunnel, watchers, servers, close db.
- `startTunnel({tunnelName, publicPort}) => ChildProcess|null` — if no `tunnelName` → null; spawn `cloudflared tunnel run --url http://127.0.0.1:{publicPort} {tunnelName}` with `stdio:'inherit'` (check the flag order against the installed `cloudflared tunnel run --help` and adjust if it differs); on `ENOENT` print install hint (`brew install cloudflared` / `winget install Cloudflare.cloudflared`) and continue without tunnel.
- `openBrowser(url)` — darwin `open url`; win32 `explorer.exe url`; else `xdg-open url`; spawn with arg array, `detached`, errors ignored.
- README: what it is, requirements (Node 24, git, cloudflared, Resend + verified domain), setup on macOS and Windows, running, security model in plain words, what is never shown.

- [ ] **Step 1: Failing tests** — `startTunnel` with no name → null; with fake missing binary (PATH emptied) → returns null and prints hint; spawning `node bin/livereview.js` with `LIVEREVIEW_DATA_DIR` temp and env `LIVEREVIEW_NO_BROWSER=1` prints the admin URL line and responds on the admin port, then exits cleanly on SIGTERM (skip the signal assertion on win32).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Full `npm test` → all PASS.
- [ ] **Step 6:** Commit `feat: startup, tunnel and docs`.
