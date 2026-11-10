# LiveReview

LiveReview lets people you invite watch your work in progress, read-only and in real time. You point it at a git
folder on your own computer. Your reviewers open a link in their browser and see what you are changing right now
(the uncommitted diff), your commits, and a comment thread on any line. You see their comments next to the code.
Nothing is uploaded anywhere: the code stays on your computer and LiveReview serves it from there, through a
Cloudflare Tunnel that you own.

## What reviewers can and can't see

Reviewers can see:

- the live changes in the working tree, updated as you save files
- the commit history and the diff of every commit
- comments, theirs and yours, anchored to lines

Reviewers never see:

- files that git ignores, including files that are tracked but match `.gitignore` (in the live view and the file
  list; commit history only applies the hidden list below)
- the hidden list (below), in the live view, in every commit in the history, in file lists and in comment anchors
- your home folder or anything outside the projects you added
- anything outside git's own view of the folder (submodule contents are not shown, symlinks pointing outside the
  repository are not followed)

Reviewers never change anything: LiveReview never edits, stages, commits or checks out in your repository.

The hidden list, matched against the file name (not the folder), ignoring case:

`.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `*.jks`, `id_rsa*`, `id_ed25519*`, `.npmrc`,
`.pypirc`, `.netrc`, `.git-credentials`, `credentials*.json`, `*secret*`, `*.kdbx`, `auth.json`

You can add more patterns per project in the admin page. A hidden file still shows up as a line saying it changed,
without its contents.

## Requirements

- Node.js 24 or newer
- git
- cloudflared (Cloudflare's tunnel program), installed by you
- a domain managed by Cloudflare, for example `review.example.com`
- optional: a Resend account (https://resend.com) with your sending domain verified, and an API key. With it,
  LiveReview emails sign-in codes and invitations. Without it, copy each invite link from the admin page and send
  it yourself (WhatsApp, chat, anything); a reviewer whose session expires needs a fresh invite link.

LiveReview itself has two small npm dependencies (diff2html, ws) and no native modules. It never
downloads or installs programs.

## Setup on macOS

```sh
brew install node git cloudflared
node --version          # must say v24 or higher

git clone <this repository> LiveReview
cd LiveReview
npm install
```

Create the tunnel once (this opens a browser to log in to Cloudflare):

```sh
cloudflared tunnel login
cloudflared tunnel create livereview
cloudflared tunnel route dns livereview review.example.com
```

Use your own hostname instead of `review.example.com`. `livereview` is the tunnel name; you will enter both in the
admin page.

## Setup on Windows

Open PowerShell:

```powershell
winget install --id OpenJS.NodeJS
winget install --id Git.Git
winget install --id Cloudflare.cloudflared
# open a new PowerShell window so the new programs are on PATH
node --version          # must say v24 or higher

git clone <this repository> LiveReview
cd LiveReview
npm install

cloudflared tunnel login
cloudflared tunnel create livereview
cloudflared tunnel route dns livereview review.example.com
```

If `winget` offers an older Node.js, download Node.js 24 or newer from https://nodejs.org instead.

`git.exe` itself must be on PATH (the Git for Windows installer does this by default). LiveReview starts git without
a shell, so a `git.cmd` or `git.bat` wrapper alone is not enough.

## Running

```sh
npm install     # first time only
npm start
```

The terminal prints:

```
LiveReview is running.
  Admin (this computer only): http://localhost:4318/admin?t=...
  Public: https://review.example.com
```

and your browser opens the admin link. On the first run nothing is configured yet, so the second line is
`Public: not configured yet` and the admin page walks you through the settings: public hostname, your name and
email, the tunnel name, and (optionally) the sender address and Resend API key. Then add a project (a folder that is the top
level of a git repository).

Things to know:

- The admin link contains a one-time token. It works once, only on this computer, and a new one is printed on every
  start. Restarting LiveReview signs you out of the admin page until you use the new link.
- If a tunnel name is set, LiveReview starts `cloudflared` for you, in the same terminal window, so you can see
  what it is doing. When you press Ctrl+C, LiveReview stops it again.
- The sender address can be a bare address (`review@example.com`) or with a name (`LiveReview <review@example.com>`).
- Stop with Ctrl+C. Changed ports take effect after a restart.
- Set `LIVEREVIEW_NO_BROWSER=1` to stop it opening the browser.

## Inviting a reviewer

In the admin page, open a project, add the reviewer's email address as a member, and send the invitation. The
reviewer gets an email with a link. You can also copy the invite link and send it yourself. An invite link:

- works for 7 days
- works once
- only for that email address
- is replaced when you generate a new one

The reviewer opens the link, enters the 6-digit code that is emailed to them, and lands in the project. They stay
signed in for 30 days on that browser. Removing a member signs them out of that project immediately and
invalidates their pending invite.

## How reviewer comments reach you

- **Under the line** in the project page, for everyone on that project.
- **Admin page → Inbox**, with a count in the tab title, and a desktop notification while the admin page is open
  (click "Enable desktop notifications" once).
- **By email**, when email is set up (Resend key + sender address): comments that arrive within a minute of each
  other come as one email, with the comment text and a link that opens it on this computer. Your own comments are
  never emailed to you.

## Security model, in plain words

- LiveReview opens two ports, both on `127.0.0.1` only (nothing on your network can connect): the public one
  (4317) for reviewers and the admin one (4318) for you.
- The Cloudflare Tunnel points at the public port only. The admin page and admin API do not exist on the public
  port (they answer "not found"), so they cannot be reached from the internet.
- The admin page is opened by a one-time token printed in your terminal; after that a cookie that is
  `HttpOnly` and `SameSite=Strict` identifies you, and only on the admin port.
- Reviewers sign in with a 6-digit code sent to an invited email address. A code lasts 10 minutes, works once and
  is burned after 5 wrong tries. At most 5 codes per email address per hour and 20 requests per IP address per
  hour. The response is the same, and equally slow, whether or not the address is invited, so it cannot be used
  to find out who has access.
- The public port only answers requests for your configured hostname, and changes only when the request comes
  from a page on that hostname.
- A project the viewer is not a member of looks exactly like a project that does not exist.
- Session tokens, sign-in codes and invite tokens are stored hashed. The Resend API key is stored in
  `config.json` in the data folder (readable only by your user account on macOS) and is never sent to the browser.
- The only outbound traffic is Cloudflare (through `cloudflared`) and `https://api.resend.com` for email. No
  telemetry.
- LiveReview does not install a service, a startup item or a registry entry. When you close it, it is gone.

## Where the data is

| System | Folder |
| --- | --- |
| macOS | `~/Library/Application Support/LiveReview` |
| Windows | `%APPDATA%\LiveReview` |
| Linux (development only) | `~/.config/livereview` |

It contains `config.json` (settings, including the Resend API key) and `livereview.db` (projects, members,
comments, sessions). Set the environment variable `LIVEREVIEW_DATA_DIR` to use a different folder.

To reset: stop LiveReview and delete the folder. To keep your settings but remove projects, members and comments,
delete only `livereview.db` (and `livereview.db-wal` / `livereview.db-shm` if present).

## Troubleshooting

**"Port 4317 is already in use. Is LiveReview already running?"** Another LiveReview (or another program) holds the
port. Close the other window, or change the ports in `config.json` (`publicPort`, `adminPort`) and start again.

**"cloudflared isn't installed."** Install it (`brew install cloudflared` on macOS,
`winget install --id Cloudflare.cloudflared` on Windows) and restart. LiveReview keeps running without the public
link in the meantime, so you can still use the admin page.

**The public link does not load.** Check that the tunnel name in the admin page matches the one you created
(`cloudflared tunnel list`), that the DNS route exists (`cloudflared tunnel route dns ...`), and read what
`cloudflared` prints in the terminal. If it stopped, LiveReview says so and does not restart it; restart LiveReview.

**Emails do not arrive.** Check the Resend dashboard that your domain is verified and that the sender address is on
that domain. The admin page shows a send error if Resend refused the message; invite links can always be copied and
sent by hand. Look in spam too.

**"LiveReview needs Node.js 24 or newer."** Install a newer Node.js and run `node --version` again.

**Windows SmartScreen or Defender warns about it.** LiveReview is plain JavaScript source code run by the official
Node.js runtime you installed yourself. It bundles no executables and downloads nothing, and the code is not
minified or obfuscated, so you can read all of it. `cloudflared` is Cloudflare's own signed program that you
installed separately.

## Development

```sh
npm test
```
