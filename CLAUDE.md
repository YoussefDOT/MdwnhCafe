# Mdwnh Digital Workspace — AI Dev Guide

> **This project is entirely vibe-coded.** Every line of JS/HTML/CSS was written by an AI model. Only the art assets and audio files are human-made. When Claude is working on this, it IS the developer — read this file carefully before touching anything.

---

## Quick Start

```bash
# Serve locally (required — ES modules + Firebase won't work from file://)
python3 -m http.server 8080
# then open http://localhost:8080
```

**Mobile testing:** `ipconfig getifaddr en0` → open `http://[IP]:8080` on phone (same WiFi).

**Never push to git unless the user explicitly asks.** Always test on localhost first. **Always push directly to `main`** — never push to a separate branch (`git push origin HEAD:main`).

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
| **Azkar (أذكار)** | Morning/evening dhikr overlay with per-item count buttons, Firebase completion tracking, timer lock |
| **Minigames** | Racing (canvas-based) and Coffee-catching game; triggered by walking into zones |
| **Mobile mode** | Full touch support — virtual joystick, focus-mode UI (no sounds drawer on mobile) |

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

---

## Mobile / Responsive System

Mobile = `window.innerWidth < 1024`. Toggle with `setMobileClass()`. `body.is-mobile` drives all mobile CSS.

**Critical CSS rule**: Never use `!important` on `transform` for `.focus-sounds-panel`. JS drag code sets `drawer.style.transform` inline, and `!important` silently beats inline styles.

**Focus sounds panel**: Desktop only. `body.is-mobile .focus-sounds-panel { display: none !important }` — the mobile sounds drawer has been removed entirely. Do not re-add it.

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
    active, type, startTime, minLockMs,   // overlay state
    counts[], currentIndex, completed,     // list progress
    pausedPomoRemaining, pausedPomoPhase,  // timer freeze
    pausedFreeWorkStart, pausedFreeWorkSnap,
    ytWasPlaying, ytVolumeBefore,
    focusMobileWasActive, _lastButtonRefresh
}
```

### Key functions
| Function | Purpose |
|---|---|
| `getCurrentAzkarType()` | Returns current window type using `_azkarFakeHour` if set |
| `updateAzkarButton()` | Throttled 1/s; shows/hides button + mobile float btn |
| `openAzkarOverlay(type)` | Freezes timers, pauses YT, renders list, starts lock timer |
| `closeAzkarOverlay(markDone)` | Restores timers, fades YT back in, removes body class |
| `renderAzkarList()` | Builds DOM; resets `scrollTop = 0` every time |
| `onAzkarCountClick(idx)` | Decrements count, marks done, scrolls to next |
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

## Prayer System

`initPrayerSystem()` → `fetchPrayerTimes()` (calls Adhan API) → schedules `checkPrayerTrigger()` to run each minute. On trigger: `triggerPrayerOverlay()` plays adhan sound + rain particles + full-screen overlay.

**Priority**: Prayer overlay takes priority over azkar. `triggerPrayerOverlay()` calls `closeAzkarOverlay(false)` first.

Prayer location stored in localStorage (`mdwnh_prayer_location`).

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

---

## Design Language (Apple HIG)

- **Glass**: `rgba(18,18,18,0.68)` + `backdrop-filter: blur(20px) saturate(1.6)`
- **Borders**: `rgba(255,255,255,0.09)` — barely visible
- **Shadows**: `0 4px 24px rgba(0,0,0,0.30)` — soft, low spread
- **Typography**: weight `600` primary, `rgba(255,255,255,0.42)` secondary
- **Spring transitions**: `cubic-bezier(0.34, 1.56, 0.64, 1)`
- **Pills**: `border-radius: 50px` for action buttons
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
