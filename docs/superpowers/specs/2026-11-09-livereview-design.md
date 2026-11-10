# LiveReview — Design

Date: 2026-11-09
Status: draft, awaiting owner approval

## 1. Intent

The owner writes code on their own machine (macOS or Windows) across several git projects. Today, when someone reviews that work, the reviewer sends screenshots of problems, and the owner has to work out which file and line each screenshot is about.

LiveReview is a small app that runs on the owner's machine and serves a read-only web view of their work at a fixed URL on the owner's domain (e.g. `review.example.com`). Invited reviewers sign in with their email and can:

- watch the **current uncommitted changes** of a project update live while the owner types and saves;
- browse **past commits**, each with its diff;
- leave **comments on a specific line**, which reach the owner immediately and can be replied to and resolved.

Reviewers never need to clone, pull, install, or run anything. They can never change code.

## 2. Users

- **Owner** — exactly one per installation: the person whose machine runs LiveReview. Adds projects, invites/removes reviewers, reads and answers comments.
- **Reviewer** — anyone the owner invites by email to one or more projects. Sees only those projects.

## 3. Goals

1. One installation per machine serves **many projects** at the same time, each watched live independently.
2. Per-project access: each project has its own list of allowed reviewer emails. A reviewer invited to two projects sees both after one sign-in; a reviewer invited to one sees only that one.
3. Live view of `working tree vs HEAD` (staged + unstaged + untracked files), pushed to open browsers within ~1 second of a file save, with no page refresh.
4. Commit history per project (current branch), each commit viewable as a diff.
5. Line comments with author name, threaded replies, resolved state, and an "outdated" state when the commented line later changes.
6. Owner is notified of new comments as they arrive; reviewers see owner replies live.
7. Runs on **macOS and Windows** with identical behaviour.
8. Clean, conventional, legitimate software that antivirus (Windows Defender, macOS Gatekeeper/XProtect) has no reason to flag — see §6.

## 4. Non-goals

- Not a GitHub/GitLab replacement: no PRs, no merging, no approvals workflow, no CI.
- No editing of code from the browser, by anyone, ever.
- No multiple owners / multiple machines feeding one site.
- No reviewer-to-reviewer invitations; only the owner invites.
- No availability when the owner's machine is off or asleep. The site simply shows that the owner is offline.
- No publishing to npm in v1 (runs from its own folder).

## 5. Anti-goals (would make it a failure even if it "works")

- Exposing a secret: `.env` files, keys, or anything git-ignored ever being visible to a reviewer.
- Anyone without an invitation seeing any project, file name, or commit message.
- Antivirus quarantining or warning about it, or it behaving in ways that look like spyware (hidden processes, silent autostart, silent downloads, reading folders the owner did not add).
- Noticeably slowing down the owner's editor or machine while they work.

## 6. Constraints

### Platform & stack (owner delegated these choices; these are the designer's calls)

- **Node.js 24 LTS**, plain JavaScript (ES modules) or TypeScript compiled with `tsc`. No bundling into a single executable.
- **Storage:** Node's built-in `node:sqlite` — one database file in the app's data dir. `engines` pins Node `>=24`. The app checks the version at startup and exits with a clear message if it is too old, and suppresses the `ExperimentalWarning` for `node:sqlite` only. No native npm modules (avoids per-OS compilation and unsigned `.node` binaries).
- **Git access:** by spawning the system `git` CLI (already installed on the owner's machine). No libgit2 bindings.
- **File watching:** Node's built-in `fs.watch` — one recursive watcher per project root plus the git dir (changed from chokidar after the final review: chokidar 4 opened one file descriptor per tracked file).
- **Realtime:** WebSocket (`ws`).
- **Diff rendering:** `diff2html` in the browser; side-by-side and unified toggle.
- **HTTP:** a small framework (Fastify or Hono) or `node:http` — builder's choice.
- **Email:** Resend HTTP API (free tier) for sign-in codes and invitations. API key lives only in the owner's local config.
- **Public access:** Cloudflare Tunnel (`cloudflared`) on the owner's domain, which is already on Cloudflare DNS. One hostname, e.g. `review.example.com`; **no per-project subdomains** (owner explicitly rejected them).

### Legitimacy / antivirus (owner requirement: "must not be stopped by Windows Defender")

- Ships as readable source run by the official Node.js runtime. No obfuscation, no minified server code, no packers (`pkg`, `nexe`, etc.).
- No bundled third-party executables. In particular, no native notifier helper binaries (e.g. `SnoreToast.exe` via `node-notifier`) — see notifications below.
- `cloudflared` is installed by the owner through official channels (`brew install cloudflared`, `winget install Cloudflare.cloudflared`). LiveReview never downloads binaries. It may start `cloudflared` as a visible child process if the owner configured it, and stops it on exit.
- HTTP server binds to **127.0.0.1 only** (the tunnel connects locally). This also avoids the Windows Firewall prompt.
- No autostart, registry Run keys, launch agents, or services in v1. The owner starts it with a command; it runs in a visible terminal window.
- Reads only the project folders the owner explicitly added. No telemetry, no outbound traffic except Cloudflare tunnel and the Resend API.

## 7. Decided behaviour

### 7.1 Projects

- Owner adds a project from the admin page by entering the absolute path of a git working tree, plus a display name. The path must be the top level of a git working tree (`git rev-parse --show-toplevel` equals it). The home folder, a drive root, or any path not satisfying this is rejected. Before saving, the admin page shows a preview of the tracked files that will be visible and the files that will be hidden, and asks the owner to confirm. Submodule contents are not shown, only the pointer change. Symlinks are not followed outside the repo. A URL slug is derived from the name (e.g. `nwc-legal`) and is editable.
- Owner can remove a project (stops watching, deletes its memberships and comments after confirmation).
- The view always reflects the **branch currently checked out**. Switching branch updates connected viewers live.

### 7.2 URLs (single hostname, path per project)

| Page | Path |
|---|---|
| Project list (only projects the viewer may see) | `/` |
| Project home → redirects to live | `/{slug}` |
| Live uncommitted changes | `/{slug}/live` |
| Commit list | `/{slug}/commits` |
| One commit | `/{slug}/commit/{sha}` |
| Deep link to a comment | any of the above + `#c-{commentId}` |
| Sign-in | `/login` |
| Personal invite link (GET shows Continue, POST redeems) | `/invite/{token}` |
| Admin (owner only) | `/admin` |

A signed-in reviewer opening a project they are not a member of gets a plain "no access" page that does not reveal whether the project exists.

### 7.3 Live view

- Content = `git diff HEAD` (staged + unstaged) plus untracked, non-ignored files shown as added.
- Recomputed on file-change events, debounced (~300 ms), and on changes under `.git/` that indicate a commit, checkout, or reset (`HEAD`, `refs/`, `index`).
- Pushed to every viewer of that project over WebSocket. Clients replace the diff without a page reload and keep scroll position and open comment threads.
- Watching ignores `.git/objects`, `node_modules`, and git-ignored paths so a large repo does not overload the machine.
- **Watcher lifecycle (designer's call):** a project's file watcher runs only while at least one viewer (reviewer or owner) has that project open; it stops ~1 minute after the last one leaves. When nobody is watching, the cost is zero. Live comment re-anchoring runs when the watcher next starts.
- Untracked files over 1 MB show as "large file added" without content. If there are more than 300 untracked files, only the first 300 are listed, with a note.
- Planning target: up to ~20 projects, ~10 concurrent viewers, repos of up to ~50k tracked files.

### 7.4 Commits

- List of commits on the current branch: short sha, subject, author, relative date; paginated.
- Commit page shows the full message and the diff against its first parent. The root commit diffs against the empty tree. Merge commits diff against the first parent.
- Edge states: a repo with no commits shows everything as added in the live view, and an empty commit list. Detached HEAD shows "detached at {sha}". A rebase or merge in progress shows a banner, with the live view still diffing against `HEAD`.

### 7.5 What is never shown

- Any path git ignores — never listed, never diffed in the live view. This includes files that are tracked but now match `.gitignore` (checked with `git check-ignore --no-index`).
- Additionally, always hidden even if tracked (default list, designer's call, broadened after review): `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `*.jks`, `id_rsa*`, `id_ed25519*`, `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`, `credentials*.json`, `*secret*`, `*.kdbx`, `auth.json` (Composer). The diff shows "hidden file changed" with no content. Owner can extend this list per project.
- The hide rules (gitignore for the live view; the hidden list everywhere) apply **everywhere content can appear**: live diff, commit diffs including old commits, file lists, and comment anchors. Old commits are filtered by the **current** hidden list, so a secret committed long ago in a file that is now on the list stays hidden. Gitignore is not applied to history (a path ignored now may have been legitimately tracked before); only the hidden list is.
- Comments cannot be placed on hidden or binary files. If the owner later adds a pattern to the hidden list, existing comments on matching files have their stored anchor text wiped and show "file hidden".
- Binary files: "binary file changed", no content.
- Very large file diffs are collapsed behind a "show" button.

### 7.6 Comments

- Any viewer (reviewer or owner) clicks a line in a diff (live or commit) and writes a comment. Plain text with Markdown code formatting.
- Stored: project, target (`live` or a commit sha), file path, line number, side (old/new), the text of the commented line plus 3 lines of context (the "anchor"), author email, body, timestamps, resolved flag.
- Threads: replies to a comment. Owner and reviewers can reply. The owner or the comment's author can mark it resolved/unresolved.
- Every comment and reply carries its author's name.
- **Outdated:** on live comments, after each recompute the anchor is searched for in the new diff of the same file. Found → comment moves to the new line. Not found → marked outdated and shown in a collapsed "outdated comments" area, never deleted.
- **On commit:** live comments whose anchor is found in the new commit's diff are re-attached to that commit; the rest stay as outdated live comments.
- Matching (designer's call): the matcher works against the **full new file content**, not only diff hunks. Anchor found exactly once → move. Found several times → pick the occurrence nearest the old line number. Not found → outdated. A commented line that still exists but is no longer part of the diff (e.g. the change was reverted) is outdated too, since the live view only shows changed hunks.
- Commit comments whose sha is no longer reachable from any branch (amend, rebase) remain viewable from a "comments on rewritten commits" section of the project and are marked as such.
- Unresolved-comment counts show per project (on `/`) and per file (in the file list).

### 7.7 Notifications

- Owner: the admin page (open in the owner's browser) uses the **browser Notification API** to show a native OS notification for each new comment or reply ("Ahmed commented on `src/UserController.php:42`"); clicking it opens the comment's deep link. Works on macOS and Windows without bundling any native binary.
- Reviewers: new replies appear live in the page; no email notifications in v1.

### 7.8 Sign-in and access

- Reviewers sign in with **email + 6-digit one-time code** sent via Resend. Code valid 10 minutes, single use, rate-limited per email and per IP. Only emails that are a member of at least one project can receive a code; others get the same generic response (no enumeration).
- Session: random token in an `HttpOnly; Secure; SameSite=Lax` cookie, 30-day expiry, stored hashed in SQLite. WebSocket connections are authenticated by the same cookie, with an `Origin` check.
- Rate limits (designer's call): at most 5 codes per email per hour, 20 code requests per client IP (`Cf-Connecting-IP`) per hour, and 5 wrong code attempts before the code is burned. The "code sent" response is identical in content and padded to a fixed minimum time whether or not the email is a member.
- **Email delivery:** Resend requires a verified sending domain. The owner's domain is on Cloudflare, so setup adds Resend's DNS records there, and the setup screen links to the steps. If sending fails (bad key, rate limit), the admin page shows the error, and the invite link above still works. Sign-in codes are never shown in admin.
- On first sign-in the reviewer sets a display name.
- **Owner access (designer's call, hardened after review):** the tunnel also connects from 127.0.0.1, so a missing `Cf-Connecting-IP` header alone is **not** trusted. Instead:
  - Two listeners: the **public listener** (the only one cloudflared points at) never serves `/admin` or admin APIs, whatever the headers say. The **admin listener** is a separate port on 127.0.0.1 that the tunnel is never configured to reach.
  - On startup the app generates a random one-time token and opens `http://localhost:{adminPort}/admin?t={token}` in the default browser. That token is exchanged for an owner session cookie (`HttpOnly; SameSite=Strict`, no `Secure` since it is plain localhost). The URL is also printed in the terminal.
  - The admin listener rejects any request whose `Host` is not `localhost`/`127.0.0.1:{adminPort}` (DNS-rebinding defence), and every state-changing request and WebSocket upgrade must carry a matching `Origin` (CSRF defence).
  - The public listener likewise only accepts its configured public `Host` and checks `Origin` on state-changing requests and WebSocket upgrades.
- **Owner identity:** the owner's name and email are set in config. The owner is one identity everywhere; if the owner's email is also on a member list it maps to the same person. In the owner's own browser the owner uses the admin listener, which also renders the same project/diff/comment pages.
- **Comment permissions:** anyone can edit or delete their own comments. The owner can resolve or delete any comment. The author can resolve their own comments.
- **Invite:** owner adds an email to a project in admin → an email goes out with the site link and the project name.
- **Invite link (owner request, added 2026-11-09):** every invitation also has a personal invite link (`/invite/{token}`) that the admin page always shows with a copy button, so the owner can send it over WhatsApp or anywhere, whether or not the email worked. The token is bound to that email, random (32 bytes), stored hashed, single-use, and valid 7 days. Opening it shows a "Continue" page; pressing Continue (a POST) signs that reviewer in directly (first-time name prompt), with no email code needed. The GET never consumes the token, so link previews in WhatsApp/Slack/mail scanners can't burn it. The owner can regenerate it, which invalidates the previous one. Removing the member invalidates it. Later sign-ins after the session expires use the email code, or a fresh invite link from the owner. Removing an email from a project revokes access immediately, including closing that reviewer's open WebSocket for that project.

### 7.9 Running it

- `npm start` (or a small `livereview` bin) starts both listeners, starts `cloudflared` if configured (pointed at the public listener only), and opens the admin page in the default browser with its one-time token.
- First run with no config: admin page shows a setup screen for the public hostname, Resend API key, sender address, owner display name, and the tunnel name; plus short written instructions for creating the Cloudflare tunnel and DNS route once.
- Data dir: `~/Library/Application Support/LiveReview` on macOS, `%APPDATA%\LiveReview` on Windows. Holds `config.json` and `livereview.db`.
- When the tunnel is down or the machine is off, Cloudflare's error page shows. Acceptable in v1.

## 8. Left to the builder

- Exact HTTP framework, front-end approach (plain JS + small templates is fine; no heavy SPA framework needed), and visual design, kept clean and readable in light and dark mode.
- Debounce timings, pagination sizes, and the large-diff threshold.
- Exact anchor-matching algorithm, as long as it behaves as in §7.6.
- Test strategy: unit tests for diff/anchor/auth logic; an integration test running against a temporary git repo.
- README with setup steps for macOS and Windows.
