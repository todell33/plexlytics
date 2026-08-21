# Plexlytics — Setup Guide

This guide assumes you've never used the Terminal before. Follow the steps in
order and you'll be fine. It should take about 15–20 minutes.

**What you're building:** a private webpage that shows who's streaming from your
Plex server right now, and stats on what's been watched most, over time. It runs
quietly in the background on your Mac Mini.

---

## Quick install (recommended)

Unzip the app anywhere (Downloads is fine), then in Finder **double-click
`install.command`** inside that folder. It handles everything: Python
environment, dependencies, the background service, and installs a proper
Plexlytics icon into Launchpad. Approve any Terminal permission prompts
macOS shows you.

**Where things end up** — same split Tautulli's own Mac installer uses:
- **App code** goes into `/Applications/Plexlytics.app` — reinstalling or
  updating always overwrites this safely, since nothing important lives here.
- **Your data** (database, logs) lives in
  `~/Library/Application Support/Plexlytics/` — completely separate from the
  app itself, so reinstalling or updating never touches your watch history.

If you're upgrading from an older setup that had everything in a
`~/plex-stats-app` folder, re-running `install.command` moves your database
to the new location automatically the first time the app starts — nothing
to do by hand.

If something's not working, the logs are now at
`~/Library/Application Support/Plexlytics/logs/plexstats.log` (and
`.err` for errors) — check `.err` first.

The very first time you open Plexlytics from Launchpad afterward, macOS may
say it's from an unidentified developer — right-click (Control-click) it and
choose **Open** once. After that, opening it normally works from then on.

The full manual walkthrough below describes an older, simpler layout (one
plain folder, no app bundle) and hasn't been kept in sync with the change
above — if `install.command` works for you, there's no reason to read
further. It's here for anyone who wants to understand or customize each step
by hand; just know the exact paths involved have since moved to what's
described above.

---

## Before you start

You'll need:
- Your Mac Mini, with Plex already running on it
- About 20 minutes
- The password you use to log into your Mac (you may be asked for it once)

---

## Step 1: Open the Terminal app

The Terminal is where you'll type a few commands. It looks intimidating but you're
just copying and pasting — you won't be writing code.

1. Click the magnifying glass icon in the top-right corner of your screen (or press
   `Command (⌘) + Space`).
2. Type **Terminal** and press **Return**.
3. A black or white window will open with some text and a blinking cursor. This is
   the Terminal.

Keep this window open for the rest of the guide.

---

## Step 2: Unzip the app folder

If you haven't already, find the `plex-stats-app.zip` file you downloaded (probably
in your **Downloads** folder) and double-click it. This creates a normal folder
called `plex-stats-app`.

Now, in the Terminal window, type the following and press **Return**. This moves
the Terminal "into" that folder so every command below runs in the right place:

```
cd ~/Downloads/plex-stats-app
```

If you saved the folder somewhere other than Downloads, use that location instead
— for example, if it's on your Desktop, type `cd ~/Desktop/plex-stats-app`.

**How to tell it worked:** the line in your Terminal should now start with
something like `plex-stats-app %` instead of just your name.

---

## Step 3: Install the required software

Copy each line below **one at a time**, paste it into the Terminal (⌘V), press
**Return**, and wait for it to finish before pasting the next one. Some steps take
a minute or two — that's normal.

**3a.** Create a private space for this app to run in:
```
python3 -m venv venv
```

**3b.** Turn that space on. (You'll need to do this every time you open a new
Terminal window to work with this app — more on that in Step 7.)
```
source venv/bin/activate
```
You'll know it worked because you'll see `(venv)` appear at the start of the line
in your Terminal.

**3c.** Install the pieces the app needs to run:
```
pip install -r requirements.txt
```
You'll see a bunch of text scroll by — that's normal. Wait until it stops and you
get a new blinking cursor.

**3d.** Download the charting library the dashboard uses. This app deliberately
avoids loading it from the internet every time you open the page — that would
mean an ad-blocker, a strict firewall, or a bad connection could quietly break
your charts, so it's kept as a local copy the app serves itself:
```
mkdir -p static/js/vendor
curl -o static/js/vendor/chart.umd.min.js https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.5.0/chart.umd.min.js
```
You should see a progress display and end up back at a blinking cursor with no
error. To double check it worked:
```
ls -lh static/js/vendor/chart.umd.min.js
```
This should show a file a couple hundred KB in size — if it shows "No such
file," the download failed and you should try the `curl` command again.

---

## Step 4: Start the app

Back in the Terminal, type:
```
python3 app.py
```

You should see several lines of text appear, ending with something mentioning
`Running on`. **Leave this Terminal window open** — closing it stops the app.

---

## Step 5: Sign in with Plex

On the same Mac Mini, open a web browser and go to:
```
http://127.0.0.1:5055
```

You'll land on a sign-in page — no password to make up, no token to copy from
anywhere. Click **Sign in with Plex**:

1. A new browser tab opens to Plex's own sign-in page. Log in there the same
   way you always do (including two-factor codes, if you use them — this part
   is entirely handled by Plex, not this app).
2. Once you approve it, go back to the first tab. It checks automatically and
   takes you to your dashboard within a few seconds — no need to refresh
   manually.

That's it — this single sign-in both connects the app to your Plex server and
protects your dashboard, replacing what used to be two separate manual setup
steps. You'll stay signed in for a long time; if you're ever signed out, just
repeat this step.

To check it from another device on your home Wi-Fi (like your phone), you'll need
your Mac Mini's network address instead of `127.0.0.1`. To find it:
1. In the Terminal, open a **second** Terminal window (⌘N) so you don't stop the
   app — go to **Shell → New Window** in the menu bar, or press `⌘N`.
2. Type `ipconfig getifaddr en0` and press Return. You'll get something like
   `192.168.1.42`.
3. On your phone or another computer on the same Wi-Fi, visit
   `http://192.168.1.42:5055` (using the numbers you got) and sign in with
   Plex there too.

---

## Step 6: Checking it from outside your house

For real "from anywhere" access, don't try to expose this directly to the
internet — it's not built with the security that requires. Instead, use a free
app called **Tailscale**, which securely connects just your own devices together,
as if they were on the same Wi-Fi network no matter where you are:

1. On your Mac Mini, go to https://tailscale.com/download and install it.
2. Install the Tailscale app on your phone or laptop too, from the App Store /
   Play Store.
3. Sign in to Tailscale with the same account on both devices (it can use your
   Google or Microsoft account — no new password to remember).
4. Once both are connected, Tailscale gives your Mac Mini a private address you
   can use from anywhere — something like `100.x.x.x`. Visit
   `http://<that-address>:5055` from your phone, wherever you are, and you'll
   reach your dashboard.

This keeps your dashboard completely private — only devices you've personally
signed in stay connected. The Plex sign-in from Step 5 is still what actually
protects the dashboard itself; Tailscale just protects the network path to
reach it.

---

## Step 7: Keeping it running automatically

Right now, the app stops if you close the Terminal window or restart your Mac. To
have it start automatically and stay running in the background, you'll create a
small settings file that tells your Mac to run it for you. You can do this
entirely from Terminal — no manual editing required.

**7.1** — If the app is still running from Step 4, click into that Terminal
window and press `Control + C` to stop it.

**7.2** — If your app folder is inside **Downloads**, **Desktop**, or
**Documents**, move it into your home folder first. macOS treats those three
folders as protected, and background services like the one you're about to set
up are blocked from opening files inside them — even though Terminal itself can
get in just fine. Moving the folder avoids that entirely:

```
mv ~/Downloads/plex-stats-app ~/plex-stats-app
```

(adjust `Downloads` if yours is in Desktop or Documents instead — and skip this
if your folder is already somewhere else, like directly in your home folder)

**7.3** — Move into the app folder at its (possibly new) location:

```
cd ~/plex-stats-app
```

(use whatever path applies after 7.2 — if you skipped that step, use the path
from Step 2 instead)

**7.4** — Create the folder macOS looks in for these settings files, if it
doesn't already exist:

```
mkdir -p ~/Library/LaunchAgents
```

**7.5** — Copy the entire block below **as one piece**, from `python3` on the
first line down to the closing `PY` on the last line, and paste it into
Terminal, then press Return. This automatically fills in the correct folder
path for you — you don't need to edit anything. Every line below starts at the
very left edge on purpose — that matters for this one, so if you're typing it
by hand rather than pasting, don't add any spaces at the start of a line.

```
python3 > ~/Library/LaunchAgents/com.plexstats.app.plist << PY
import os
app_dir = os.getcwd()
print(f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
<key>Label</key><string>com.plexstats.app</string>
<key>ProgramArguments</key>
<array>
<string>{app_dir}/venv/bin/python3</string>
<string>{app_dir}/app.py</string>
</array>
<key>WorkingDirectory</key><string>{app_dir}</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>/tmp/plexstats.log</string>
<key>StandardErrorPath</key><string>/tmp/plexstats.err</string>
</dict>
</plist>""")
PY
```

Nothing will print out — that's normal, it means it worked.

*(If you ever see a prompt like `heredoc>` or `dquote>` with a blinking cursor
after pasting a command in this guide, Terminal is still waiting for something
to finish — usually because only part of a multi-line block got pasted. Press
`Control + C` to cancel, then copy the **entire** block again, including its
first and last lines, and paste it in one go.)*

**7.6** — Double check it worked:

```
cat ~/Library/LaunchAgents/com.plexstats.app.plist
```

You should see the file's contents, with a real folder path starting with
`/Users/...` in the `<string>` entries — and it should **not** contain the word
`Downloads` unless you deliberately skipped 7.2. If you instead get an error
saying no such file exists, go back and re-run the block in 7.5 — make sure you
copied every line, including the first (`python3 > ...`) and last (`PY`).

**7.7** — Turn it on. Newer versions of macOS want a slightly different command
than older ones, so first check the file is valid:

```
plutil -lint ~/Library/LaunchAgents/com.plexstats.app.plist
```

This should print `OK`. If it prints something else, go back to 7.5 and re-copy
the whole block, making sure you included the first and last lines.

Once that prints `OK`, load and start it:

```
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.plexstats.app.plist
launchctl enable gui/$(id -u)/com.plexstats.app
launchctl kickstart -k gui/$(id -u)/com.plexstats.app
```

If the first of those three lines says something like "service already
bootstrapped," that's fine — it just means it's already loaded from a previous
attempt. Run this first to clear it, then try the three lines again:

```
launchctl bootout gui/$(id -u)/com.plexstats.app
```

The dashboard will now start automatically whenever your Mac Mini turns on, even
if you're not logged in to the Terminal. Give it about 10 seconds, then check
`http://127.0.0.1:5055` in your browser to confirm it's running — you may need
to sign in with Plex again the very first time (Step 5), after which it stays
signed in. If it still doesn't load, check what's in the log:

```
cat /tmp/plexstats.err
```

---

## Everyday use

- **To check your dashboard:** just visit `http://127.0.0.1:5055` (on the Mac
  Mini) or your Tailscale address (from anywhere) — no need to open Terminal once
  Step 7 is done.
- **To stop the app manually:** in Terminal, `launchctl bootout
  gui/$(id -u)/com.plexstats.app`
- **To start it again:** `launchctl kickstart -k
  gui/$(id -u)/com.plexstats.app`
- **To sign out:** click your username in the top-right of the dashboard, then
  **Log out**.

---

## What's on the dashboard

- **Live Now** — everyone streaming right now: who they are, what they're
  watching, what device, and whether Plex is transcoding (more work for your
  server) or direct playing. Updates every 10 seconds.
- **Trends** — a graph of how many people are streaming at once and how much
  bandwidth is being used, over time; a Top Users chart; top genres for movies
  and TV; and what hours of the day people watch the most.
- **Top Movies / Top TV Shows** — your most-watched titles, by number of plays
  or total hours watched. Click any title to see its full details (synopsis,
  cast, director, release date) and who's watched it.
- **Users** — everyone who's streamed, with lifetime totals. Click a name to
  drill into that person's own stats, top movies, and top shows.
- **History** — a searchable list of everything anyone has ever watched.
  Syncs automatically with Plex every 60 seconds while the page is open, so
  finished streams show up on their own.

---

---

## Menu Bar Icon (optional)

This adds a small Plexlytics icon to your Mac's menu bar with a dropdown to
open the app, restart it, or quit it. It's a separate small helper program
from the main app, so it needs its own one-time setup — do this *after*
you've run `install.command` (or completed Step 7 above) at least once.

Once this one-time setup is done, re-running `install.command` in the
future (e.g. to pick up an update) keeps this in sync automatically — these
steps are only needed the very first time.

**M.1** — In Terminal, go to where the app code actually lives now and
activate its venv (adjust the path if `install.command` printed a different
one for you, e.g. under `~/Applications` instead of `/Applications`):

```
cd "/Applications/Plexlytics.app/Contents/Resources"
source venv/bin/activate
pip install rumps pyobjc-framework-Cocoa
```

This can take a minute or two the first time.

**M.2** — Same auto-filling technique as Step 7.5 — copy the whole block below
as one piece and paste it into Terminal:

```
python3 > ~/Library/LaunchAgents/com.plexstats.menubar.plist << PY
import os
app_dir = os.getcwd()
logs_dir = os.path.expanduser("~/Library/Application Support/Plexlytics/logs")
os.makedirs(logs_dir, exist_ok=True)
print(f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
<key>Label</key><string>com.plexstats.menubar</string>
<key>ProgramArguments</key>
<array>
<string>{app_dir}/venv/bin/python3</string>
<string>{app_dir}/menubar.py</string>
</array>
<key>WorkingDirectory</key><string>{app_dir}</string>
<key>RunAtLoad</key><false/>
<key>StandardOutPath</key><string>{logs_dir}/plexstats-menubar.log</string>
<key>StandardErrorPath</key><string>{logs_dir}/plexstats-menubar.err</string>
</dict>
</plist>""")
PY
```

Note there's no `KeepAlive` key here, unlike the main app's plist — quitting
the menu bar icon should actually quit it, not have it silently reappear a
few seconds later. `RunAtLoad` starts as `false`; the icon's own "Start at
Login" checkbox controls that going forward, independent of the main app's
own Launch at Startup setting.

**M.3** — Check it's valid, then do the very first load:

```
plutil -lint ~/Library/LaunchAgents/com.plexstats.menubar.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.plexstats.menubar.plist
```

`plutil` should print `OK`. The icon won't appear yet — `RunAtLoad` is off
until you turn it on.

**M.4** — In the app, go to **Settings → Web Interface → Show Icon in Menu
Bar** and set it to Enabled. The icon should appear immediately. From here
on, that toggle starts and stops it — you don't need to touch Terminal again
for this.

---

## If something goes wrong

- **"command not found: python3"** — Python isn't installed. Go to
  https://www.python.org/downloads/ and install it, then start again from Step 3.
- **Charts don't show / browser console says "Chart is not defined"** — the
  charting library didn't download in Step 3d. Re-run:
  ```
  cd ~/plex-stats-app
  mkdir -p static/js/vendor
  curl -o static/js/vendor/chart.umd.min.js https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.5.0/chart.umd.min.js
  ```
  then restart the app (Step 7's `launchctl kickstart -k ...` command, or just
  re-run `python3 app.py` if you're not using the background service) and hard
  refresh the browser page (`⌘⇧R`).
- **The dashboard shows "Couldn't reach Plex" or keeps sending you back to the
  sign-in page** — sign in again via Step 5. If that doesn't help, check that
  Plex itself is actually running on this Mac.
- **"This Plex account doesn't have access to this server"** — you signed in
  with a Plex account that isn't the owner of, or a shared user on, the Plex
  server this app is pointed at. Sign in with the right account.
- **You closed the Terminal and the dashboard stopped working** — that's expected
  unless you've done Step 7. Reopen Terminal, `cd` back into the app folder (Step
  2), run `source venv/bin/activate` then `python3 app.py` again.
- Still stuck? Copy the exact error message from the Terminal and ask for help
  with that specific message.

---

## Technical notes (optional reading)

- Everything is stored locally in a file called `plex_stats.db` inside the app
  folder — nothing leaves your network except requests to your own Plex server
  and, during sign-in, to plex.tv itself.
- **Signing in with Plex** replaces both the old manual Plex token setup and
  the old dashboard username/password. The first successful sign-in is
  verified against your actual Plex server (not just any Plex.tv account) and
  its token is stored in the database for the background service to keep
  using between restarts — you generally only need to sign in again if you
  explicitly log out or clear your browser's cookies.
- If you set this app up before this sign-in flow existed and still have
  `PLEX_TOKEN` set in `.env`, it's kept as a fallback and still works — signing
  in through the web UI simply takes priority once you do.
- **"Most streamed" and "Users" combine two sources.** Plex's own official
  watch history only logs something once you've watched roughly 90% of it —
  that's a Plex setting, not this app. On top of that, this app tracks
  viewing sessions itself in real time as streams start and stop, so even a
  short test view shows up within about a minute instead of waiting on
  Plex's threshold. If a viewing later also qualifies for Plex's official
  history, this app automatically drops its own placeholder so it's never
  counted twice.
- Session snapshots older than 30 days are automatically deleted to keep things
  tidy; your full watch history is kept forever.
- Project structure: `app.py` (web app), `poller.py` (background data collection),
  `plex_client.py` (talks to Plex), `models.py` (database), `templates/` and
  `static/` (the webpage itself).
