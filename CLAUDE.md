# Mdwnh Digital Workspace — AI Dev Guide

> **This project is entirely vibe-coded.** Every line of JS/HTML/CSS was written by an AI model. Only the art assets and audio files are human-made. When Claude is working on this, it IS the developer — read this file carefully before touching anything.

> **Spell-check all UI text.** Any Arabic or English text that will appear in the UI must be spell-checked before being written into the codebase. Never add user-visible text without verifying spelling and grammar first.

> **The owner is a beginner developer.** Explain things in plain language — what broke, why, and what the fix does — as if to someone who doesn't know much about code. Skip jargon, and when you must use a technical term, define it briefly. Don't over-explain either: keep it short and clear, not a tutorial. Claude is the one writing the code; the owner is steering, so help them understand decisions without drowning them in detail.

> **The owner is on macOS and tests mainly in Safari.** Every new feature must work cross-browser — don't assume Chrome behaviour. Common Safari gotchas: aggressive favicon caching + rejection of oversized favicons (use a small ~128px PNG, not a 1MB+ one — see `favicon-128.png`/`apple-touch-icon.png`); no `documentPictureInPicture` and no `canvas.captureStream()` (PiP falls back to a popup window — see Picture-in-Picture tiers); `button[disabled]` leaks touch events on iOS (use a CSS `.unlocked` class, never the `disabled` attribute, for visual-only locks); always pair `backdrop-filter` with `-webkit-backdrop-filter`; stricter autoplay / AudioContext-resume rules. When something "works for me but not for the owner," suspect a Safari difference first.

---

## Quick Start

```bash
# Serve locally (required — ES modules + Firebase won't work from file://)
python3 -m http.server 8080
# then open http://localhost:8080
```

**Mobile testing:** `ipconfig getifaddr en0` → open `http://[IP]:8080` on phone (same WiFi).

**Never push to git unless the user explicitly asks.** Always test on localhost first. **Always push directly to `main`** — never push to a separate branch (`git push origin HEAD:main`).

**Build number**: A `#build-number` div sits below the `#siraj-test-link` button on the login screen showing `Build N · Updated H:MM AM/PM`. The `.git/hooks/pre-commit` hook auto-increments the number and timestamps it on every commit — no manual edits needed. If the hook ever fails to find the pattern, it logs a warning and exits cleanly.

---

## What This App Is

A multiplayer collaborative Pomodoro workspace — players appear as avatars in a 2D pixel-art office. Arabic UI (RTL). Main features:

| Feature | Description |
|---|---|
| **Pomodoro timer** | Per-laptop work/break cycles, persisted in Firebase |
| **Shared Pomo (coop)** | Multiple players work a synchronized session together |
| **Focus sounds panel** | Ambient audio mixer — 8 sounds, each with an on/off toggle and volume slider (desktop only) |
| **YouTube focus player** | Paste a YouTube link, it plays embedded with loop support |
| **Prayer times** | Live Adhan scheduling with overlay + rain effect |
| **Azkar (أذكار)** | Morning/evening dhikr overlay with per-item count buttons, Firebase completion tracking, timer lock; optional shuffled order; **after-prayer azkar** reachable from the prayer overlay |
| **Minigames** | Racing (canvas-based) and Coffee-catching game; triggered by walking into zones |
| **Mobile mode** | Full touch support — virtual joystick, pull-up sounds drawer, focus-mode UI |

**Language**: All UI text is Arabic. Keep it that way.

---

## File Map

```
game.js        ~10500 lines — all game logic, classes, Firebase, rendering
index.html       ~900 lines  — single page; all panels/overlays live here
style.css       ~4400 lines  — all styling; mobile rules under body.is-mobile
firebase-config.js           — exports { database, ref, onValue, update, get, onDisconnect, set }
Sound/                       — UI/minigame sound effects (.mp3)
Sound/Focus Sounds/          — ambient focus audio files (.mp3)
Art/                         — sprite sheets, background image, assets
pomo9.json                   — background tilemap/layout (don't edit)
```

---

## Architecture

- **No build step** — pure vanilla ES modules. Edit and reload.
- **Firebase Realtime Database** (europe-west1) handles ALL multiplayer state.
- `lobbyPath(sub)` prefixes every Firebase path with `lobbies/{male|female}/{sub}` — male and female users never share data.
- `serverNow()` returns Firebase server time offset-corrected — use it instead of `Date.now()` for any multiplayer timing.
- The `gameState` object (line ~700) is the single source of truth for local state.
- The game loop runs at 60fps via `requestAnimationFrame` → `update()` → `render()`.

### Key classes

| Class | Location | Purpose |
|---|---|---|
| `FocusAudioEngine` | line ~46 | Web Audio API ambient mixer |
| `FocusYouTubePlayer` | line ~409 | YouTube IFrame API wrapper |

### Login & auto-resume
Discord OAuth session in localStorage. On load, `initDiscordOAuth()` validates the token and resolves the lobby. **Auto-resume**: `startGame` writes `localStorage[ACTIVE_SESSION_KEY] = userId` while in-game (cleared on explicit logout / welcome-screen logout); on load, if that flag matches the resolved user, re-enter the game directly instead of stopping on the welcome screen — `startGame` then restores the pomodoro/free-mode session from Firebase. This is what makes an unintended reload (Android discarding a backgrounded tab) seamless. Siraj ghosts never set the flag (ephemeral).

---

## Mobile / Responsive System

Mobile = `isMobile()`: `window.innerWidth < 1024`, **OR** a touch device whose physical `screen` short side < 760px (catches phones that report a wide layout viewport — DuckDuckGo, in-app webviews, "desktop site"). Toggle with `setMobileClass()`. `body.is-mobile` drives all mobile CSS.

### Orientation changes (rotation)
Android reports **stale** `innerWidth/innerHeight` for up to ~1s after rotating, so a naive relayout commits the old-orientation size and the UI stays broken until reload. `settleViewportLayout()` polls, re-applying layout only once the viewport aspect **agrees with `screen.orientation`** (which updates immediately) and has gone stable, then forces a final relayout. Wired to `orientationchange`, `screen.orientation` change, a `matchMedia('(orientation)')` change, and an aspect-flip detected in the debounced `resize`. `resizeCanvas()` guards on the computed **backing-store** size and clamps total pixels (3.2M reduced / 24M high) so a bad transient can't allocate a giant canvas. Viewport meta is locked (`maximum-scale=1, user-scalable=no, viewport-fit=cover`) — the game has its own canvas pinch-zoom, so browser zoom isn't needed and locking it prevents rotation zoom-stuck. Body/overlays use `100dvh` so fixed controls stay reachable as the URL bar moves.

**Critical CSS rule**: Never use `!important` on `transform` for `.focus-sounds-panel`. JS drag code sets `drawer.style.transform` inline, and `!important` silently beats inline styles.

**Focus sounds panel**: Mobile has a bottom-sheet pull-up drawer. Hidden during azkar (`body.is-mobile.azkar-active .focus-sounds-panel { display: none !important }`) — do not show it during azkar on mobile.

**Focus mode** (`setMobileFocusMode(active)`): Hides joystick + user card during work phase. Joystick gets `.focus-hidden` class → opacity 0. User card slides off-screen with `transform: translateY(-140%)` + `pointer-events: none`.

**Mobile azkar float button** (`#azkar-focus-float-btn`): A fixed pill at `top: 14px; right: 14px; z-index: 9500` that appears on mobile when the user card is `.focus-hidden` AND the azkar time window is valid. Tapping it opens the overlay directly (skips confirm — user card is hidden so confirm has no anchor). Visibility driven by `style.display` directly in JS (not class toggle) to avoid CSS specificity issues.

---

## Focus Audio Engine (the ambient sounds system)

### Sound keys and their source files

| Key | File | Label (Arabic) |
|---|---|---|
| `rain` | `Sound/Focus Sounds/Rain.mp3` | مطر |
| `rain_muffled` | `Sound/Focus Sounds/Muffled rain.mp3` | مطر خافت |
| `fire` | `Sound/Focus Sounds/Boiling.mp3` | موقد |
| `forest` | `Sound/Focus Sounds/Forest.mp3` | غابة |
| `brown` | `Sound/Focus Sounds/Brown Noise.mp3` | ضوضاء بنية |
| `wind` | `Sound/Focus Sounds/Wind.mp3` | رياح |
| `ocean` | `Sound/Focus Sounds/Ocean.mp3` | بحر |
| `plane` | *(synthesized — Web Audio only)* | طائرة |

### How it works

1. `init()` creates `AudioContext` + `masterGain`, then calls `loadFocusSoundBuffers()` async.
2. `loadFocusSoundBuffers()` fetches all 7 MP3 files → `decodeAudioData` → stores in `this.focusBuffers[key]`.
3. `startSound(name)` for file-based sounds: creates `AudioBufferSourceNode`, sets `loop = true`, uses `loopStart`/`loopEnd` to skip file fade-in/fade-out edges (`fadePad = Math.min(2.0, duration * 0.08)`), calls `source.start(0, fadePad)`.
4. Gain chain: `source → gainNode (sound.volume * baseVolumeScale) → masterGain (overallVolume) → destination`.
5. `saveToFirebase()` writes `users/{userId}/focusMix` with active/volume per sound + overall volume.
6. `applyState()` reads it back on login and restores UI + state. Old `stream` key data is silently ignored (safe migration from old key name).

### baseVolumeScale
File-based sounds use `1.0` (full file level). `plane` (synthesized) uses `0.09` (synthesized noise is much louder raw).

### Sound preloading and background-tab rules
**All sounds must be preloaded.** Every new sound file must be:
1. Added as `new Audio('Sound/Filename.mp3')` in `gameState.sounds`
2. Added to `FocusAudioEngine.buffers` with a `null` entry
3. Loaded in `loadSoundEffects()` via `await loadBuffer(...)`
4. Preloaded via `gameState.sounds.X.preload = 'auto'` after `gameState` declaration

**Sounds must work in background tabs.** Use `focusAudioEngine.playEffect('key')` (Web Audio API) rather than `playSoundRobust(gameState.sounds.X)` (HTMLAudioElement) for any sound that must fire when the tab is not focused. HTMLAudioElement playback can be throttled/blocked in background tabs; Web Audio nodes play regardless.

**`ctx.resume()` is async — await it before playing.** Always chain: `ctx.resume().then(_doPlay)`. The `playEffect()` method already does this — never rewrite it to fire-and-forget.

### Ambient sound loading (mobile-safe)
`loadFocusSoundBuffers()` loads all 7 MP3s **in parallel** via `Promise.all`. Do not rewrite as sequential (`for...await`).

**`visibilitychange` restart rule**: Only restart when `ctx.state === 'suspended'`. Running context means sounds are still alive — do NOT restart (that resets loop position).

---

## YouTube Focus Player

### Ad detection & muting
YouTube embeds cannot remove ads. Instead, `FocusYouTubePlayer` detects pre-roll ads and mutes + overlays them.

**Detection heuristic** (in `_poll()`, runs every 500ms):
1. 2-second grace period after `loadUrl()`.
2. After grace period, while `getPlayerState() === PLAYING`:
   - If `getCurrentTime() < -0.1` → ad.
   - If `getCurrentTime()` delta between polls is `< 0.05s` for 2.5s+ → time frozen → ad.
3. Ad clears when `getCurrentTime() > 1` and neither condition is true.
4. 120-second failsafe force-clears stuck state.

### `FocusYouTubePlayer` key methods
| Method | Purpose |
|---|---|
| `loadUrl(url, startSec, saveToFirebase, startPaused)` | Parse ID, create player if needed, load/cue video, start poll |
| `fadeOutAndPause(duration)` | Gradual volume→0 then pause |
| `fadeInAndResume(duration)` | Set vol=0, play, ramp up |
| `_poll()` | 500ms interval: update time display, waveform, ad detection |
| `_setAdMode(isAd)` | Mute/unmute + show/hide ad overlay |
| `loadFromProfile(profile)` | Restore saved URL+timestamp+loop from Firebase on login |

---

## Azkar System (أذكار الصباح / أذكار المساء)

### Time windows
- **Morning (صباح)**: Fajr → Dhuhr
- **Evening (مساء)**: Asr → Isha
- Falls back to Cairo times if no prayer API data: `{ Fajr: '04:30', Dhuhr: '12:00', Asr: '15:30', Isha: '19:30' }`
- `getCurrentAzkarType()` → `'morning' | 'evening' | null`

### Firebase path
`users/{uid}/azkarCompleted = { morning: 'YYYY-MM-DD', evening: 'YYYY-MM-DD' }`

Morning and evening are **independent keys** — marking morning done does NOT affect the evening button.

### gameState.azkar fields
```js
azkar: {
    active, type, items[], afterPrayer,   // overlay state (items = the ACTIVE list)
    startTime, minLockMs,
    counts[], currentIndex, completed,     // list progress
    pausedPomoRemaining, pausedPomoPhase,  // timer freeze
    pausedFreeWorkStart, pausedFreeWorkSnap,
    ytWasPlaying, ytVolumeBefore,
    focusMobileWasActive, _lastButtonRefresh
}
```

**`az.items` is the single source for rendering** — `openAzkarOverlay` builds it once (`renderAzkarList`/`onAzkarCountClick` read `az.items`, never `AZKAR_MORNING/EVENING` directly), so shuffling and the custom after-prayer list "just work" and stay index-aligned with `az.counts`.

### Randomize order
`getRandomizeAzkar()` (off by default, `SETTINGS_AZKAR_RANDOM_KEY`) → `openAzkarOverlay` builds `az.items` via `_shuffledCopy(baseList)` (Fisher–Yates). Completion tracking is per-type (morning/evening), so shuffling never affects the done state.

### After-prayer azkar (أذكار بعد الصلاة)
Opened from the **prayer overlay** via `#prayer-azkar-btn` → `openAzkarOverlay('morning', { afterPrayer: true })`. Uses the custom `AZKAR_AFTER_PRAYER` list, the morning (sky-blue) look (`overlay.dataset.mode = 'morning'`), and sits **on top** of the prayer overlay (`body.azkar-after-prayer .azkar-overlay { z-index: 10002 }` vs prayer's 10000). Crucially it does **not** freeze/resume the timer or fade YT/sounds itself (`afterPrayer` skips all of that in `openAzkarOverlay`) — the prayer overlay already owns that. On انتهيت, `closeAzkarOverlay` detects `afterPrayer`, fades the azkar overlay out, then calls `dismissPrayerOverlay()` which un-freezes the timer and fades focus sounds + YouTube back in → normal work session. `minLockMs = 0` for after-prayer (no forced wait).

### Key functions
| Function | Purpose |
|---|---|
| `getCurrentAzkarType()` | Returns current window type using `_azkarFakeHour` if set |
| `updateAzkarButton()` | Throttled 1/s; shows/hides button + mobile float btn |
| `openAzkarOverlay(type, opts)` | Builds `az.items` (shuffle / custom), freezes timers, pauses YT, renders list, starts lock timer. `opts.afterPrayer` = post-salah mode (skips freeze/YT) |
| `closeAzkarOverlay(markDone)` | Restores timers, fades YT back in, removes body class. In `afterPrayer` mode delegates the resume to `dismissPrayerOverlay()` |
| `renderAzkarList()` | Builds DOM from `az.items`; resets `scrollTop = 0` every time |
| `onAzkarCountClick(idx)` | Decrements count, marks done, scrolls to next — **scrolls `listEl` only** (manual `scrollTo`, never `scrollIntoView` which bubbled up and scrolled the whole overlay down) |
| `markAzkarCompleted(type)` | Saves to Firebase |
| `setupAzkarUI()` | Wires all button events; called from `startGame()` |
| `updateAzkarSystem()` | Called every frame from game loop |

### Timer freeze pattern (mirrors prayer overlay)
- **Solo pomo**: snapshot `endTime - Date.now()` → keep re-extending `endTime` each frame in `updatePomodoro()` while `az.active`
- **Free mode**: snapshot `totalWorkMs`, zero `workStartTime`; restore on close
- **Shared pomo**: azkar button is blocked during any phase ≠ `'idle'`

### انتهيت button lock
- **Normal users**: 3-minute lock
- **Siraj**: 3-second lock (`az.minLockMs = gameState.isSirajGhost ? 3000 : 180000`)
- Lock is CSS-only (`.unlocked` class) — button is **never** `disabled` attribute. On iOS, `button[disabled]` leaks touch events through to elements below. Use `classList.contains('unlocked')` check in click handler instead.

### Focus sounds during azkar
- Desktop: panel shown in compact 2-column grid, sliders hidden, bg/border at 10% opacity, `z-index: 10001` (above overlay at 10000), `pointer-events: all`
- Mobile: sounds panel hidden entirely (`display: none !important`)
- Prayer overlay (z-index 10000) still covers sounds panel — azkar's elevated z-index only lifts it above the *azkar* overlay, not above prayer

### Scroll and overlay containment
- `.azkar-list`: `overscroll-behavior: contain` stops scroll propagating to page
- `body.azkar-active { overflow: hidden }` locks body
- Overlay wheel events: `stopPropagation()` on all; `preventDefault()` on non-list targets — prevents game zoom while azkar is open
- Global wheel zoom handler also checks `gameState.azkar.active` as safety net
- Overlay `bottom: -200px` (desktop) + `padding-bottom: 200px` → background extends below fold without shifting content. Mobile: `bottom: 0; padding-bottom: 0` — no extension needed

### Siraj time-spoof UI
Module-level vars `_azkarFakeHour` / `_azkarFakeMin` override the real clock for `getCurrentAzkarType()`. Auto-cleared on page reload (module scope). Applying a new fake time also clears `azkarCompleted` from Firebase so the button reappears fresh.

`#azkar-time-picker-modal` — clock picker with up/down arrow wheels + scroll wheel (normalized by `deltaMode` so one mouse click = one unit change). Visible only when `gameState.isSirajGhost === true`.

---

## Shared Pomodoro (Coop) System

State machine at `gameState.sharedPomo.phase`: `'idle' | 'gathering' | 'guest-waiting' | 'active'`

### Key paths (via `spPath()`)
- `sharedPomo/sessions/{hostId}` — gathering/invite coordination (deleted after 12s)
- `sharedPomo/live/{hostId}` — active session live doc (participants, phase, time)
- `sharedPomo/invites/{uid}` — incoming invite for a user

### Host promotion (when host disconnects mid-session)
`setupSpLiveListener` detects `data === null` → calls `handleHostLeft()`. Remaining members sort UIDs deterministically → elect lexicographically-first as new host.

### Coop animation
`updateCoopAnimation()` only runs members still in `sp.activeGroupMembers`. Members who leave are removed via Set-filter in `setupSpLiveListener` and deleted from `sp.coopAnim.members`.

---

## Pomodoro Timer (per-laptop)

Firebase path: `lobbyPath('pomodoro/{laptopId}')` — written by host, read by all.

`startPomodoroPhase(phase)` handles `'work' | 'break' | 'end'`. Phase transitions fire audio cues and UI changes.

`updatePomodoro()` runs every frame — drives the countdown, phase transitions, and the focus mask/fog effects.

**Focus mask**: `drawFocusMask()` renders a dark vignette around the active laptop. Alpha driven by `gameState.focusAlpha` (lerped 0→1 on work start).

### Disconnect / session reclaim (the ghost-laptop system)
A laptop must **never** linger as a claimed-but-empty "ghost" (a timer floating over a laptop nobody is at, showing `هذا الجهاز تابع لـ …`). Two distinct causes, both fixed:

1. **Presence lost on a network blip** (the perennial bug — "there IS a user, working, but a ghost for everyone else"). Firebase fires the registered `onDisconnect` ops server-side the moment the socket drops (e.g. flaky mobile data), setting `activeInGame=false`. The socket silently reconnects, but presence was only set **once** at login, so `activeInGame` stayed false forever → observers never add the avatar to `gameState.players`, yet the laptop doc still shows the timer. **Fix:** a `.info/connected` listener (in `startGame`) re-asserts `activeInGame=true` **and re-arms** `onDisconnect(activeRef).set(false)` on **every** (re)connect, then calls `reassertActiveSessionAfterReconnect()`.

2. **User actually left** (closed tab / lost data for good). The laptop should free **immediately** for others (no ghost), the session should be stashed for **4 hours**, and the user reclaims it on return. Implemented with a unified per-session disconnect model (solo pomodoro **and** solo free mode; shared pomo is excluded — it has host-promotion):

| Helper | Role |
|---|---|
| `persistReclaimSnapshot()` | Writes a **live** snapshot to `users/{uid}/lastPomoSession` with `abandonedAt: null`. Kept fresh so a disconnect only has to stamp the timestamp (no read-race on reload). |
| `armSessionDisconnect()` | `onDisconnect(laptop).remove()` (free it) + `onDisconnect(lastPomoSession/abandonedAt).set(serverTimestamp)`. Cancels the **previous** laptop's remove if we relocated. |
| `trackSessionForReclaim()` | persist + arm together. Called at pomo start, **every** `startPomodoroPhase`, free start, periodic `saveFreeModStateToFirebase` (15s), and at end of login restore. |
| `cancelSessionDisconnect(clearStash)` | Clean exit — cancels both handlers, optionally wipes the stash. Called from `exitPomoNow`, `endFreeMode`, natural completion (both work-end and break-end), and explicit `doLogout`. |
| `reassertActiveSessionAfterReconnect()` | After a silent reconnect: re-claim our laptop (or **relocate** to a free one via `_relocateActiveSession` if it was taken during the dropout), persist a fresh snapshot, re-arm. |

**Reclaim on login** (in `startGame`'s restore): only when `lastPomoSession.abandonedAt` is **set** (a live snapshot has it `null` → ignored) and within `RECLAIM_WINDOW_MS` (4h). **Prefers the original laptop** (`ls.laptopId` if free) else any free laptop; restores `mode==='free'` or pomo accordingly; seats the player at `laptop.sitX/sitY` and syncs position so all clients see them correctly on the new laptop. Stale (>4h) / no free device → discarded.

**Pitfall (fixed):** never clear `lastPomoSession` to `null` and then arm only the `abandonedAt` child — a later disconnect then stamps a timestamp onto an empty object and the session is **lost**. Always re-**persist** a full live snapshot (`trackSessionForReclaim`), never `set(null)` while still in-session.

---

## Firebase Sync Patterns

```js
// Write (always use update, not set, unless replacing entire subtree)
update(ref(database), { 'path/to/key': value });

// Read once
get(ref(database, path)).then(snap => snap.val());

// Live listener (returns unsubscribe function)
const unsub = onValue(ref(database, path), snap => { ... });

// Cleanup on disconnect
onDisconnect(ref(database, path)).remove();
```

**Always store the unsubscribe function** and call it on cleanup — leaking listeners causes double-updates and ghost data.

---

## Firebase Cost Rules — DEFAULT TO THE CHEAPEST OPTION (10GB/mo download cap)

> Firebase Realtime Database bills **downloads** (data sent to clients), and the free tier caps at **10GB/month**. The download cost of a piece of data is roughly **(bytes that changed) × (number of clients listening at that path) × (how often it changes)**. Every `onValue` listener is a tap that streams to that client; every write fans out a download to *every* client listening to that path. **When adding any feature, pick the option that minimizes that product.** If two designs work, choose the one that downloads less — even if it's slightly more code.

**The decision checklist for any new feature that touches Firebase:**

1. **Does this even need Firebase?** If the data is high-frequency and ephemeral (live positions, cursor, typing, transient animation state), use the **WebSocket relay** (`presence-server/`, `sendPositionWS`), **not** Firebase. Firebase is only for state that must *persist* (survive reload / be seen by late joiners). Per-frame or per-second writes must never go to Firebase.

2. **Scope the listener as narrowly as possible.** Listen at `lobbyPath(...)` or a single child (`users/{uid}/foo`), never at a broad node like `/users` if you can avoid it — a broad listener downloads *every* child's changes (including the other lobby's). Prefer `get()` (one-time read) over `onValue` when you only need the value once (login restore, a count, a snapshot). Reserve `onValue` for data that genuinely must update live.

3. **Always store the unsub and tear it down** when the feature closes / the user logs out / leaves the screen. A listener left attached keeps downloading for the rest of the session. (Bug we hit: the welcome-screen `/users` listener was never detached, so every in-game client streamed the entire global users node — both lobbies — forever. Fixed via `gameState._userSelectionUnsub`.)

4. **Keep frequently-changing docs small; split out big/static fields.** Don't bundle large or rarely-changing data (avatars/data-URLs, long text, blobs) into a doc that also holds fields written often (x/y/flags) — every small change re-streams the whole child to every listener. Store big static data under its own key, written once. Never store base64/data-URL images in a doc that's in a live listener's path.

5. **Compute locally instead of syncing.** Anything a client can derive on its own (a countdown from a single `endTime`, progress from `spawnTime`, elapsed from `workStartTime`) must be written **once** and computed per-frame locally — never streamed tick-by-tick. This is why the pomodoro doc only changes at phase transitions.

6. **Don't re-write unchanged values in a loop.** RTDB suppresses no-op `value` events, but only if the value is *byte-identical*. Heartbeats that re-assert the same value are fine; heartbeats that recompute a slightly-different number every tick will fan out a download every tick.

7. **Write with `update()` (multi-path) not many `set()`s**, and write only the fields that changed — fewer/smaller writes = fewer/smaller downloads for everyone listening.

**When in doubt, measure the fan-out:** ask "how many clients are listening to this path, and how often will this change?" If the answer is "everyone in the lobby, several times a second," redesign it (relay, local compute, or narrower scope) before shipping.

---

## Prayer System

`initPrayerSystem()` → `fetchPrayerTimes()` (calls Adhan API) → schedules `checkPrayerTrigger()` to run each minute. On trigger: `triggerPrayerOverlay()` plays adhan sound + rain particles + full-screen overlay.

**Priority**: Prayer overlay takes priority over azkar. `triggerPrayerOverlay()` calls `closeAzkarOverlay(false)` first.

Prayer location stored in localStorage (`mdwnh_prayer_location`).

**Privacy — never persist exact lat/lon.** Firebase `users/{uid}/prayerLocation` stores **city + country only** (write with `set()` to replace, not `update()`). Auto-detected/curated coords live in-memory (`loc._lat/_lon`) for the session; legacy coords are scrubbed on login.

**Offline fallback (API can be blocked by VPN/ISP).** `fetchPrayerTimes()`: resolve coords (in-memory, else match `PRAYER_LOCATIONS` by city+country) → try `api.aladhan.com` with an **8s `AbortController`** → on any failure **compute locally** via `computePrayerTimesLocal()` (self-contained, method=5: Fajr 19.5°, Isha 17.5°, Asr factor 1; uses the device UTC offset so DST is correct; verified within ~1 min of the API). Retry in 20s only if there were no coords at all.

**Overlay layout** (`.prayer-overlay-content`): a centred glass card — icon, name, subtitle (`حيَّ على الصلاة، حيَّ على الفلاح`), then a `.prayer-overlay-actions` column with the primary dismiss button (`#prayer-overlay-btn`, locked for `prayerLockMs`) and a secondary `#prayer-azkar-btn` ("قراءة أذكار الصلاة؟") that opens the after-prayer azkar on top (see Azkar System). Keep the gorgeous per-prayer backgrounds (`.prayer-overlay-bg` gradients) untouched — only the content card was redesigned.

---

## Minigame Architecture

**Gender separation**: All minigame paths go through `lobbyPath()` — male/female never share sessions.

**Ready-sync protocol** (both games):
1. Host creates session with `startTime: 0`
2. Each client writes `participants/{uid}/ready: serverNow()` when entering
3. Host waits for all `ready`, then sets `startTime = serverNow() + 3500`
4. **Do NOT use a small offset** — clients need the full 3.5s window for 3-2-1 countdown

### Race minigame
Track is built from image pixel classification (`classifyRacePixel`). Physics: friction zones on/off-track. Camera rotates on mobile to always show car heading "up".

### Coffee minigame
Sugar falls from top. `progress = (serverNow() - spawnTime) / fallDuration` — computed by all clients independently. First writer wins the catch. Bad sugars (14% chance) give −3 pts.

**Session lifetime rule**: `returnFromCoffee()` and `returnFromRace()` MUST write `null` to the session path. Forgetting this causes "can't play again" bugs.

**Siraj ghost cleanup**: If `gameState.isSirajGhost`, set `onDisconnect` + 90s `setTimeout` to force-delete any minigame session the ghost created.

---

## Rendering Pipeline

`render()` each frame:
1. `drawFocusFog` — ambient fog in work room
2. `drawPlayers` — all player avatars
3. `drawTimers` — pomodoro badge stacks above laptops
4. `drawCoopGroupLabels` — floating group labels (only if ≥2 members)
5. `drawFocusMask` — dark vignette around active laptop
6. `drawWindParticles` — decorative particles
7. `drawConnections` — social connection lines between nearby players

**DPR scaling**: Canvas is `viewport * dpr` physical, `viewport` CSS. All drawing uses `ctx.scale(dpr, dpr)` so use logical pixels everywhere. `gameState.dpr` holds the ratio.

---

## Graphics Tiers & Mobile Performance

Stored in `localStorage[SETTINGS_GRAPHICS_KEY]` as `'high' | 'low' | 'potato'`, or **absent = device-auto** (`graphicsTier()` → mobile `'low'`, desktop `'high'`). The settings toggle cycles only the three explicit tiers (عالية → منخفضة → بطاطس) — there is **no `'auto'` value/button** (it confused users: on a phone "auto" already = low, so the press looked like a no-op). Per-frame the loop caches `gameState._lowGfx = isReducedGraphics()` and `gameState._potato = isPotato()`; hot draw code reads those flags (never call the helpers per-draw — they hit localStorage).

| Helper | Meaning |
|---|---|
| `isReducedGraphics()` | `low` **or** `potato` (mobile default). Gates the **cheap-but-huge compositing wins** that don't change the art. |
| `isPotato()` (بطاطس) | most aggressive; **additionally** drops the atmosphere gradients. For very weak phones. |
| `isLowGraphics()` | back-compat alias of `isReducedGraphics()`. |

**Reduced (low + potato)** applies: DPR cap (`Math.min(dpr, 1.5)`, potato `1.25`) in `resizeCanvas`; **no `backdrop-filter`** on `body.is-mobile` (a blurred panel over the 60fps canvas re-rasterizes its backdrop *every frame* — the #1 mobile killer, and the "css rebuilding" users perceive); canvas shadows clamped to 0 via `installLowGfxShadowGuard(ctx)` (intercepts the `shadowBlur` setter — `ctx.shadowBlur` is a per-draw Gaussian blur used ~20×/frame); fewer wind particles.

**Potato-only** (gated on `gameState._potato`): `drawSunRays`, the parallax `drawBackgroundAtmosphere`, the soft `drawFocusMask` fade, animated `drawFocusFog`, and ambient motes all fall back to cheap/no versions. So **low looks close to desktop** (gradients on) while keeping the compositing wins.

**Sound:** boss-fight SFX (15 files, only used in that minigame) are deferred to `requestIdleCallback` (`ensureBossSounds()`, also force-loaded on boss-fight entry) so they don't compete during cold-start.

Never animate `filter: blur()` or `transform: scale()`/`background-position` on full-screen/always-visible elements — they repaint every frame and flicker on weak GPUs. Keep such effects static.

---

## Settings Panel (`setupSettingsUI`, `#settings-panel`)

Opens **under the gear button, top-right** on desktop (`top:130px; right:18px`) and mobile (`right:10px; top:110px`). Each row is a binary toggle button reflected via a `_reflect*()` helper and persisted in localStorage. Rows are grouped into **categories** (`.settings-category` + `.settings-category-title` header): العرض والأداء / التحكم والعمل / الأذكار والصلاة. Keys & defaults:

| Key | Default | Effect |
|---|---|---|
| `SETTINGS_GRAPHICS_KEY` | device-auto | عالية → منخفضة → بطاطس (see Graphics Tiers) |
| `SETTINGS_NAMES_KEY` | show | hide player names above avatars |
| `SETTINGS_JOYSTICK_KEY` | auto | show/hide the on-screen joystick |
| `SETTINGS_NOIDLE_KEY` | off (`getDisableIdleAnim()`) | when **on**, freeze the local avatar's animation while working |
| `SETTINGS_AZKAR_RANDOM_KEY` | off (`getRandomizeAzkar()`) | when **on**, shuffle morning/evening azkar order each open |
| `SETTINGS_PRAYER_DELAY_KEY` | off (`getPrayerJamaahDelay()`) | "صلاة الجماعة" — when **on**, adds **+5 min** to every prayer time (`prayerJamaahExtraMin()`, applied in `computeNextPrayer`/`updatePrayerPanelDOM`). **Per-USER, not per-device**: source of truth is Firebase `users/{uid}/prayerJamaahDelay`, read on login and **mirrored into localStorage** so the getter stays a cheap sync read; the toggle writes both. |

### Open / close animation
Open removes `.hidden` (the `settingsPanelIn` keyframe pops it in). Close is **animated, not a snap**: `closeSettingsPanel()` adds `.settings-panel-closing` (runs `settingsPanelOut`), then `.hidden` after ~230 ms. All three close paths (close button, gear re-press, outside-click) go through it. **Closing makes no sound** (see below).

### Sequenced rows + the cascade blip (sound)
Row/heading entrance lives in **style.css** as `@keyframes settingsRowIn` with **category-aware** `animation-delay`s (scoped `.settings-panel:not(.hidden):not(.settings-panel-closing) …` so it replays on every open). Do **not** re-add the old `juiceRowIn` settings rule in juice.css — it double-animates and fights the category delays.

### Avatar working animation (`drawPlayers`, the `suppressWorkAnim` block)
Two independent suppressions, both gated on `localInWorkPhase()` (pomodoro **or** free-mode work):
- **My own avatar** — if `SETTINGS_NOIDLE_KEY` is on, freeze **both** the working bounce **and** the idle breathing while I'm in any work phase. NB the per-avatar `isWorking` flag only tracks pomodoro, so the suppression uses `localInWorkPhase()` (which also covers free mode) — otherwise free-mode users kept breathing. The flag is cached per-frame as `gameState._disableIdleAnim` (the getter hits localStorage; never read it per-draw).
- **Other players' working bounce** — always hidden while *I'm* in a work phase. I only see their bounce when I'm idle / on break / not in a session.

### End-break button (`#end-break-btn`, `endBreakEarly()`)
"إنهاء الاستراحة" — a child of `#leave-wrap`, shown by `updatePomoLeaveBtn` only when `isBreakActive() && !isMinigameActive() && sharedPomo.phase !== 'active'` (solo pomo or free-mode break; shared pomo is host-synchronized so it's excluded). Ends the break early into the normal comeback-to-work sequence: free mode calls `endFreeModeBreak()`; solo pomo just sets `pomodoro.endTime = Date.now()` so `updatePomodoro`'s natural break-end transition (writes the `wait` doc → 2 s → kidnap) fires next frame.

---

## Sequenced UI Sounds (the cascade "blip") — `setupJuiceUi`, `_uiSeqRate`

When a panel's elements animate in **one-by-one** (a staggered/sequenced entrance), the matching sound is a **pitch sweep**: the **first** element to appear plays the **deepest (heaviest) pitch**, and each following element steps **up** in pitch, so the **last** element to appear is the **highest**. The starting pitch is **randomised per cascade** (so two opens never sound identical). This is the house style for sequenced UI — match it for any new sequenced panel that should be audible.

**How it's wired (don't reinvent it):**
- A single capture-phase `animationstart` listener (in `setupJuiceUi`) fires one blip per element **as it pops in**. It only reacts to animation **names** in the `_JUICE_IN_ANIMS` set (`juicePop`, `juiceContainerPop`, `juiceRowIn`, `settingsRowIn`). The pitch comes from `_uiSeqRate()`: a gap >240 ms (or an explicit `_uiSeqReset()`) starts a **fresh** sweep (`idx=0`, `base = 0.78 + random*0.16`); each blip within the window does `idx++` and returns `base + min(idx,12)*0.055` (rising). `_playUiBlip(rate)` plays `uiBlip` through the focus engine (`playPitched`).
- **Sound is opt-in by animation name, not automatic.** Sequenced elements are silent unless their keyframe name is in `_JUICE_IN_ANIMS`. To give a NEW sequenced panel the cascade: name its row keyframe and **add that name to `_JUICE_IN_ANIMS`** (that's all settings needed — `settingsRowIn`). To keep a sequenced panel **silent**, just don't register its animation name (and `_JUICE_SILENT_SEL` force-mutes specific elements even if they use a sounded name).
- **Start each panel's sweep fresh:** call `_uiSeqReset()` when the panel opens (e.g. `openSettingsPanel`) so its first row is reliably the deepest, regardless of any recent blip.
- **Closing must be silent.** Pop-**out**/close keyframes (`settingsPanelOut`, `juicePopOut`, …) are **not** in `_JUICE_IN_ANIMS`, so a close never blips. Never add a close/out animation name to that set.

---

## Player Position Sync

### Live movement runs over a WebSocket relay (not Firebase)
High-frequency walking used to write `x/y` to Firebase **every animation frame** — wasteful (counts against the 10GB/month download cap) and laggy with several players. Live positions now go over a tiny **Cloudflare Worker + Durable Object** relay instead; Firebase stays the source of truth for everything that must persist.

- **Server**: [`presence-server/`](presence-server/) — a stateless relay. One Durable Object = one lobby room (keyed by `gameState.selectedLobby`, so male/female never mix). It forwards each position payload to the other sockets in the room and stores nothing; on disconnect it sends `{t:'bye',uid}`. Deploy with `npx wrangler deploy`. URL: `wss://mdwnh-presence.yosefbore3y.workers.dev/lobby/<lobby>?uid=<uid>`. Free tier bills incoming WS messages 20:1 → ~2M msgs/day free.
- **Client** (`game.js`, the "Live position relay" block above `updatePlayerPosition`): `ensurePresenceSocket()` opens/heals the socket (called from `startGame`, the 10s presence heartbeat, and `_resyncPresence`). `sendPositionWS(x,y,force)` sends `{uid,x,y,m,s}` throttled to ~11/sec. `onPresenceMessage()` feeds others' positions into a per-player **interpolation buffer** (`pushNetSample`). `disconnectPresenceSocket()` on logout. Auto-reconnects on close (2s backoff).
- **Smooth movement = snapshot interpolation** (`pushNetSample` / `interpolateRemoteFromBuffer`, in the entity-helpers block). At ~11 packets/sec the old "ease toward each point and stop" lerp visibly stepped (worst at sprint). Instead each remote player is rendered `NET_RENDER_DELAY` (140ms) **in the past**, gliding at constant velocity between the two buffered samples bracketing that time; if the buffer starves it extrapolates along the last velocity for ≤`NET_MAX_EXTRAP` (180ms) (only while `isMoving`) then clamps. `updatePlayerRenderPositions` uses this for remotes and falls back to the plain lerp only before the first sample. **The buffer is fed by BOTH the WebSocket and the Firebase users listener**, so seating/teleport/kidnap/fallback all stay smooth and never freeze.
- **Anti-snap (the "friend snapping places" bug), two distinct causes — both fixed:**
  1. **Stale Firebase write polluting the buffer.** Firebase position writes (the 4s session heartbeat, stop writes) carry a slightly-OLD position but a fresh timestamp; appended as the newest buffer sample they yank the avatar backward, then the next WebSocket packet snaps it forward. Worst during a **break** (a walking friend still has `pomodoro.active`, so their heartbeat fires while WS also streams). **Fix:** `onPresenceMessage` stamps `player._lastWsSampleAt`; the Firebase users listener only `pushNetSample`s when WS has been quiet >1s (still sets the authoritative `.x/.y` always). WS owns smoothness; Firebase is the fallback only.
  2. **WebSocket starve → forward jump.** The relay is WS-over-TCP, so a "lost" packet is really a **delayed burst**. While starved the avatar extrapolates then clamps at the last sample; when the burst lands, interpolation places the render-time *between* the old clamp and the new sample and the avatar jumps forward to catch up. Happens **regardless of session/break**. **Fix:** the starve branch sets `entity._netStarved`; the next `pushNetSample` re-anchors at the CURRENT render position (same mechanism as resume-after-idle) so the glide continues smoothly with no jump.
- **`handleMovement`**: per-frame walk → `sendPositionWS()` (WebSocket). On **stop** → a forced `sendPositionWS()` (instant anim stop for others) **plus** `updatePlayerPosition()` (one Firebase write to persist last-known position for late joiners / spawn / reclaim).
- **Fallback**: if the socket is down, the periodic Firebase writes (stop + heartbeats) still drive observers via the users listener's `setEntityTarget` — nobody freezes, just less smooth until it reconnects.
- **Known limit (experiment)**: position `uid` is client-claimed (spoofable). Fine for the trusted friend group; revisit if going fully public.

`updatePlayerPosition(x, y)` writes `users/{uid}/{x,y,isMoving,isWorking,…}` together (atomic). Still called on **stop**, every frame during the kidnap animation, at the end of `startPomodoroPhase`, on session restore, and via a **4s heartbeat** in the game loop while locked-in/in a session — but **no longer per-frame while walking** (that's the WebSocket's job now).

**Pitfall — never use `!userData.x` to detect "no position":** the centre-column laptops sit at world **x ≈ 0**, and `0` is falsy, so that check made observers treat working users as position-less and scatter them to a random spawn (they looked mid-map to everyone but themselves). Always check `x !== undefined && x !== null`. Observers only assign a spawn to non-`activeInGame` users (VC ghosts), never to in-game players.

### Presence self-heal (`activeInGame`)
Observers render a remote player at **low opacity** (the "in Discord VC but not in the website" look) and hide their timer/`أعمل على` whenever `activeInGame !== true`. A dropped socket (network blip, **PC sleep/wake**) fires `onDisconnect.set(false)` server-side, so a returning user stays a faded ghost until presence is restored. Presence is kept true while the page is open through **three** redundant paths — never rely on just one:
1. `updatePlayerPosition()` writes `activeInGame: true` on **every** position write (move/stop/heartbeat/restore).
2. A standalone **10s presence heartbeat** in the game loop (independent of any session — covers idle/walking users the 4s position heartbeat skips).
3. `visibilitychange` / `window.focus` / `window.online` → `_resyncPresence()` re-asserts `activeInGame` + token and re-broadcasts position/task **immediately** on wake (don't make a woken PC wait for the heartbeat).

All three bail if `gameState._dupSessionDetected` (another device took over — don't fight back). Reconnect timer/task recovery also needs the laptop doc re-written: `reassertActiveSessionAfterReconnect()` (fired by `.info/connected`) does that.

---

## Picture-in-Picture (الوضع المصغر)

Floating focus window showing a **player-centred, zoomed** view of the world. Available on **all platforms**, but the *kind* of window depends on browser capability (see tiers). Platform matrix:
- **Chrome/Edge desktop** → Document PiP (always-on-top, escapes browser).
- **Safari desktop** → popup window (escapes tab, draggable across displays; **not** always-on-top — no web API allows it there).
- **Android Chrome** → Video PiP (always-on-top, floats over other apps).
- **iOS Safari** → in-page panel (no captureStream / Document PiP on iOS).

The popup window is **400×460**, forced small via `win.resizeTo()/moveTo()` (Safari ignores size on an `about:blank` popup otherwise). The popup tier is skipped on mobile (`window.open` is just a tab there).

### Surfaces (four tiers, one renderer)
`openPiPMode()` tries each in order; all share `renderPiPInto`:
1. **Document Picture-in-Picture** (`documentPictureInPicture.requestWindow`, Chrome/Edge): real always-on-top OS window with its own DOM + rAF — smoothest, has DOM timer/close. DOM/CSS injected from JS (`PIP_WINDOW_HTML`/`PIP_WINDOW_CSS`) — **no `pip.html` file**.
2. **Video Picture-in-Picture** (`srcCanvas.captureStream()` → hidden `<video>` → `requestPictureInPicture()`): always-on-top, timer drawn onto the canvas (`_pipDrawCanvasChrome`). **Skipped on Safari** — Safari does **not** implement `canvas.captureStream()`, so `_pipVideoSupported()` returns false there.
3. **Popup window** (`window.open('', …, 'popup=yes,…')`, **Safari** & anywhere): a real separate OS window that escapes the tab and drags across displays — *not* always-on-top, but the best Safari can do for live content (no Document PiP, no captureStream). Reuses `_pipSetupWindow`/`_pipFrame` exactly like tier 1 (mode `'window'`); a `setInterval` backstop + main-loop watchdog keep it rendering when the popup's own rAF throttles. **This is what Safari/macOS users get.**
4. **In-page panel** (`#pip-fallback`): draggable + `resize: both`, last resort when even `window.open` is blocked.

**Why Safari can't have always-on-top:** an always-on-top floating window of *live* content needs either Document PiP (Chrome-only) or a `<video>` fed by `canvas.captureStream()` (Safari lacks it). So Safari gets a normal popup window instead.

### Context-swap renderer (the core trick)
`renderPiPInto(ctx, canvas, dpr)` temporarily points `gameState.ctx/canvas/zoom/camera/dpr` at the PiP surface, runs the normal world-draw sequence, then restores them in a `finally`. Every draw function reads `gameState.ctx` etc., so this reuses 100% of the rendering code — **no draw function takes a `ctx` param** (the Haiku breakdown was wrong about that). Skips `drawFocusMask` (it would thrash the shared `maskCanvas`); uses a local `_pipVignette` instead of cached `drawVignette`.

### Smoothness
Render is driven by the **PiP window's own `requestAnimationFrame`** (`_pipFrame`) so it stays 60fps even when the opener tab is hidden/throttled. `updatePiPLifecycle` in the main loop is a **watchdog**: if `pip._lastFrameAt` is stale (>120ms) it renders a frame itself, and it drives the in-page fallback every frame. Camera centres via `updatePiPCamera` (lerp toward `-playerRenderPos`). Scroll-to-zoom is wired on both surfaces.

### Lifecycle — one guard, not scattered close-calls
`isPiPAllowed()` is the single predicate: work phase (pomodoro **or** free mode) AND no azkar/prayer/minigame/dup-session. `updatePiPLifecycle()` (called early in `gameLoop`, before the minigame early-returns) toggles button visibility and **auto-closes PiP the instant `isPiPAllowed()` goes false** — so break/session-end/overlay/minigame/logout are all handled in one place. The main page shows `#pip-blackout` ("الوضع المصغر مفعّل") while active.

| Function | Purpose |
|---|---|
| `togglePiPMode()` / `openPiPMode()` / `closePiPMode()` | entry / open (async, `_opening` guard) / teardown (`_closing` guard) |
| `renderPiPInto()` | context-swap world render |
| `updatePiPCamera()` | lerp camera to centre player + ease zoom |
| `updatePiPLifecycle()` | per-frame button visibility + auto-close + fallback/watchdog render |
| `setupPiPUI()` | wires button, blackout end-btn, fallback drag/resize, main-window `pagehide` |

`openPiPMode` is **async** (awaits `requestWindow`) — `pip.active` is only set after the await, so `_opening`/`_closing` flags prevent a close from being undone by an in-flight open (this was a real race: close appeared to "not work").

---

## Common Bugs & Fixes (lessons learned)

| Bug | Root cause | Fix |
|---|---|---|
| Drawer can't pull up on mobile | `!important` on `transform` beats JS inline style | Remove `!important` from all focus-sounds-panel `transform` rules |
| Coop anim plays for departed members | Departed UIDs never removed from `activeGroupMembers` | Set-filter in `setupSpLiveListener` + delete from `coopAnim.members` |
| Focus sound won't play after buffer not loaded | `!buf` returns early after gainNode already connected | Disconnect gainNode before early return: `gainNode.disconnect(); return;` |
| Timer shows before countdown | `startTime` too close to `now` | Use `startTime = serverNow() + 3500` |
| Session blocks replaying | Session never deleted | `returnFromCoffee/returnFromRace` must write `null` |
| Focus sounds silent on fresh page load | `startSound()` fails silently when context suspended | `resumeCtx` handler rescans `active && !nodes` after resume |
| YouTube ad plays silently | No ad detection | Detect via frozen `currentTime`; mute + show `#yt-ad-overlay` |
| انتهيت opens keyboard on iOS | `button[disabled]` leaks touch events through overlay | Never use `disabled` attr for visual-only lock. Use CSS class `.unlocked` and check it in click handler |
| Azkar overlay scroll reveals page behind | Scroll propagates out of list + body scroll not locked | `overscroll-behavior: contain` on `.azkar-list` + `body.azkar-active { overflow: hidden }` |
| Mouse scroll zooms game inside azkar | Global wheel handler runs even when overlay open | `stopPropagation` on overlay wheel events + early return in global handler when `azkar.active` |
| Azkar overlay content shifted down on desktop | `bottom: -200px` makes overlay taller; `align-items: center` moves content 100px lower | `padding-bottom: 200px` on overlay restores correct centering |
| Same fix breaks mobile | `bottom: 0` on mobile + `padding-bottom: 200px` shrinks usable area | `body.is-mobile .azkar-overlay { bottom: 0; padding-bottom: 0 }` |
| Mobile float button invisible | CSS class toggle fights specificity | Use `style.display = 'flex'/'none'` directly in JS, never hidden class |
| Focus sounds not clickable outside work session | Base panel has `pointer-events: none`; azkar-active override never adds `all` | `body.azkar-active .focus-sounds-panel { pointer-events: all }` |
| Time picker scroll wheel does nothing | `deltaMode: 1` (physical mouse = lines) sends `deltaY: 3`; old 50px threshold never reached | Normalize: `deltaMode===1 → deltaY*40`; threshold 40px → one click = one unit |
| Siraj time spoof doesn't reset completion | After setting fake time, old Firebase completion still hides the button | Clear `gameState.azkar.completed = {}` and write `null` to Firebase on apply |
| Prayer gradient glow stretched on mobile portrait | `ellipse` radial gradients look like ovals on narrow screens | `body.is-mobile .prayer-overlay-bg::after { display: none }` |
| PiP close "doesn't work" (reopens itself) | `openPiPMode` is async; `pip.active` set only after `await requestWindow`, so a close mid-await is undone when the pending fallback resolves | `_opening`/`_closing` flags; `closePiPMode` clears `_opening` to cancel in-flight opens |
| PiP button overlaps leave pill / looks like a stray icon | Icon-only circle placed at `top:68px` collides with `leave-wrap` (`top:54px`) | Labeled pill ("الوضع المصغر") at `top:96px`, stacked below logout + leave |
| PiP draws but never centres / thrashes mask canvas | Calling full `render()` reuses `gameState.maskCanvas` sized to main canvas → per-frame realloc | Dedicated `renderPiPInto` context-swap; skip `drawFocusMask`, use local `_pipVignette` |
| PiP works on Chrome but stays trapped in-tab on Safari | Safari has neither Document PiP nor `canvas.captureStream()`, so tiers 1+2 are skipped | Tier 3 `_pipOpenPopup()` (`window.open`) — a real popup window that escapes the tab (not always-on-top, but Safari's best for live content) |
| Azkar overlay flashes/flickers (whole or partial) even while idle, on Chrome/DuckDuckGo | Continuous per-frame repaint: animated `filter: blur()` fog + `prayerGlow` scale/opacity + button `background-position` shimmer; `will-change`/`isolation` on the root made it one giant repainting layer | Make those effects **static** (no infinite animation); don't promote the overlay to its own layer; hide `#game-canvas` while azkar is open so its 60fps repaint can't contend |
| Mobile "borderline unusable, sometimes fine" | Sustained GPU cost (varies w/ thermal & memory pressure): full-DPR canvas + `backdrop-filter` panels re-blurred every frame over the live canvas + ~20 `ctx.shadowBlur`/frame | DPR cap (`isReducedGraphics()`), remove `backdrop-filter` on `body.is-mobile`, global shadow-blur guard (`installLowGfxShadowGuard`), defer boss SFX to idle |
| Prayer times stuck on `--:--` for some users | `api.aladhan.com` blocked by their network/VPN; fetch had no timeout/retry/offline path | Resolve coords (in-memory or curated `PRAYER_LOCATIONS`), try API with 8s `AbortController`, else **compute locally** (`computePrayerTimesLocal`, method=5); retry if no coords |
| Reload (Android tab discard) dumps user on lobby/gender screen, "session lost" | Discord flow always stopped at the welcome screen on reload | Auto-resume: `ACTIVE_SESSION_KEY` in localStorage while in-game (cleared on explicit logout) → re-enter directly; `startGame` restores the session from Firebase |
| Landscape→portrait wrecks the UI until reload | Android reports the **stale (old-orientation)** `innerWidth/innerHeight` for ~1s after rotating; relayout committed those and stopped | Settle loop that waits until viewport aspect agrees with `screen.orientation` (updates immediately) before committing; backing-store pixel clamp; lock viewport meta |
| Working player shown mid-map for others, correct for self | Observer code used `!userData.x` which treats a legit `x:0` (centre-column laptop sits at world x≈0) as "no position" → scatters them to a random spawn | Explicit presence check (`x !== undefined && !== null`); never relocate `activeInGame` users; position heartbeat every 4s while in a session |
| Can join another player's session while already in one (breaks both) | When you start your own session, the proximity guard renders the nearby panel empty but never **hides** the already-showing `sp-join-panel` (hide only ran inside `checkNearbyCoopSession`, skipped when in a session) | Explicitly hide `#sp-join-panel` + clear `nearbyCoopId/nearbySoloId` in the guard; re-check `pomodoro.active/freeMode.active/sp.phase` in `confirmJoinCoopSession`/`confirmJoinSoloSession` |
| Perennial ghost laptop — working user invisible to others, laptop shows timer but `هذا الجهاز تابع لـ` with nobody there | `activeInGame` set **once** at login; a flaky-mobile socket drop fires `onDisconnect.set(false)` server-side and the silent reconnect never restored it → observer skips the avatar but the laptop doc still renders the timer | `.info/connected` listener re-asserts `activeInGame=true` + **re-arms** the disconnect handler on every (re)connect; `reassertActiveSessionAfterReconnect()` re-claims the laptop. See **Disconnect / session reclaim** |
| Disconnected/closed-tab user keeps a laptop unusable for ~30min–2h | The pomo/free doc lingered (claimed) until `cleanupAbandonedPomoSessions` freed it; free mode's `onDisconnect` deliberately kept it claimed as an AFK badge | Unified model: `onDisconnect` **removes** the laptop (others see nothing) + stamps `lastPomoSession.abandonedAt`; reclaim within 4h on next login (old laptop if free, else random). See **Disconnect / session reclaim** |
| Reclaimed session lost after a reconnect | `reassertActiveSessionAfterReconnect` cleared `lastPomoSession` to `null` then armed only the `abandonedAt` child → a later disconnect stamped a timestamp onto an empty object | Re-**persist** a full live snapshot via `trackSessionForReclaim` (never `set(null)` while still in-session) |
| Mobile: re-tapping the same laptop fires free/pomo "without asking"; happens only on the same laptop | The opening tap is followed ~300ms later by a synthesized `click` at the same point; if a mode-select button sits under it (depends on the laptop's screen position) it fires immediately | Ghost-click guard: `showLaptopModeSelect()` stamps `_modeSelectOpenedAt`; `mode-select-pomo`/`mode-select-free` ignore presses within 500ms (`modeSelectGhostClick()`) |
| Reconnected user shows no `أعمل على` / no timer for others; or appears low-opacity (VC-ghost look) after PC sleep/wake | `activeInGame` was set once at login and only re-asserted by `.info/connected`; `updatePlayerPosition` never wrote it, and the position heartbeat only runs during a session — so an idle/walking user stayed `false` after a drop, gating their opacity + timer + task label | Write `activeInGame:true` on every `updatePlayerPosition`; add a session-independent **10s presence heartbeat**; re-assert on `visibilitychange`/`focus`/`online`. See **Presence self-heal** |
| Friend's avatar "snaps places" occasionally while walking | Two causes: (1) a laggy Firebase position write (4s heartbeat during a break, stop write) fed the interpolation buffer with a stale-but-fresh-timestamped sample → backward yank; (2) WS-over-TCP delayed bursts starved the buffer, then interpolation jumped the avatar forward to catch up when the burst landed | (1) Only `pushNetSample` from Firebase when WS quiet >1s (`player._lastWsSampleAt`); (2) flag the starve (`entity._netStarved`) so the next sample re-anchors at the current render pos. See **Player Position Sync → Anti-snap** |
| "Disable idle animation while working" setting did nothing in free mode | The per-avatar `isWorking` flag only tracks pomodoro, so in free mode the local avatar fell into the idle-breathing branch and the suppression (gated on `isWorking`) never fired | Gate the local-avatar suppression on `localInWorkPhase()` (covers pomodoro **and** free mode) and freeze both the bounce and the breathing |
| After-prayer azkar: tapping a count button scrolled the whole overlay down | `nextEl.scrollIntoView()` bubbles to the nearest scrollable ancestor; when the list itself couldn't scroll it scrolled the overlay/page | Scroll `listEl` only via a manual `listEl.scrollTo({top})` computed from bounding rects — never `scrollIntoView` |

---

## Design Language (Apple HIG)

- **Glass**: `rgba(18,18,18,0.68)` + `backdrop-filter: blur(20px) saturate(1.6)`
- **Borders**: `rgba(255,255,255,0.09)` — barely visible
- **Shadows**: `0 4px 24px rgba(0,0,0,0.30)` — soft, low spread
- **Typography**: weight `600` primary, `rgba(255,255,255,0.42)` secondary
- **Spring transitions**: `cubic-bezier(0.34, 1.56, 0.64, 1)`
- **Pills**: `border-radius: 50px` for action buttons
- **Panels/drawers**: `border-radius: 25px` — all corners, including the mobile bottom-sheet sounds drawer
- **Colors**: dark theme, no bright whites, accent `rgba(255,255,255,0.85)`
- **Arabic text**: always RTL-compatible; use `direction: rtl` where needed

**Exception — success/end card** (`.success-content`): uses **white background + dark text**. This is intentional — the user prefers the old white UI for the session-complete screen. Do not apply dark glass to `.success-content`.

---

## Key Constants (game.js)

```
MOVE_SPEED = 5
PLAYER_SIZE = 70
BG_SCALE = 0.5             → world ≈ 1195 × 875 px
ROOM_COUNT = 2             → work room (top) + break room (bottom)
RACE_LAPS = 3
MOBILE_BREAKPOINT = 1024   (window.innerWidth)
WIND_PARTICLE_COUNT = 30   (desktop)  / 10 (mobile)
```

---

## Shared Pomodoro Firebase Cleanup Rules

`sharedPomo/sessions/{hostId}` is TEMPORARY — must not linger.

1. Host deletes it 12s after `startTime` in `launchSharedPomoWork`
2. `cancelSharedPomo()` deletes it immediately
3. `leaveSharedPomo()` removes only the local participant's entry
4. Invite doc (`sharedPomo/invites/{uid}`) cleaned up on accept/decline/timeout

---

## DPR Canvas Scaling

```
canvas.width/height = viewport * dpr   (physical pixels)
canvas.style.width/height = viewport   (CSS logical pixels)
render(): ctx.save(); ctx.scale(dpr, dpr)  → all drawing in logical px
drawFocusMask: uses physical mCanvas; player positions computed with * dpr
```

---

## Adding a New Feature — Checklist

1. **UI**: Add HTML in `index.html`. Follow glass design language. Arabic labels.
2. **Styling**: Add CSS in `style.css`. Add `body.is-mobile` variants if needed. Never `!important` on transforms.
3. **Logic**: Add to `game.js`. Wire Firebase sync if the state should persist.
4. **Firebase keys**: Follow existing path patterns through `lobbyPath()`.
5. **Mobile**: Test by resizing browser to <1024px. Check joystick, leave button, float button positions. No sounds drawer on mobile.
6. **Cleanup**: Store unsubscribe functions, call them on logout/leave/cleanup.
7. **Edge case scan** (MANDATORY after every new feature): Think through:
   - What happens if a user has this active and opens a pomo? (and vice versa)
   - What happens in shared pomo mode? Free mode? Prayer overlay?
   - What happens if the user closes the tab mid-feature?
   - What if they're in the break room vs work room?
   - What if Firebase write fails / is stale?
   - Does `updatePlayerPosition` correctly reflect state to other users?
   - Does cleanup happen on logout, tab close, and `endFreeMode`/`exitPomoNow`?
8. **Test locally**, then tell the user to git push.

---

## Testing Policy

**Do NOT use the browser preview tool to verify small changes** (bug fixes, single-line edits, minor tweaks). Only run the preview verification workflow for major new additions (new overlays, new panels, new game systems). For small changes, trust the code and push directly.
