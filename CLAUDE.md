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

**Never push to git unless the user explicitly asks.** Always test on localhost first.

---

## What This App Is

A multiplayer collaborative Pomodoro workspace — players appear as avatars in a 2D pixel-art office. Arabic UI (RTL). Main features:

| Feature | Description |
|---|---|
| **Pomodoro timer** | Per-laptop work/break cycles, persisted in Firebase |
| **Shared Pomo (coop)** | Multiple players work a synchronized session together |
| **Focus sounds panel** | Ambient audio mixer — 8 sounds, each with an on/off toggle and volume slider |
| **YouTube focus player** | Paste a YouTube link, it plays embedded with loop support |
| **Prayer times** | Live Adhan scheduling with overlay + rain effect |
| **Minigames** | Racing (canvas-based) and Coffee-catching game; triggered by walking into zones |
| **Mobile mode** | Full touch support — virtual joystick, pull-up sound drawer, focus-mode UI |

**Language**: All UI text is Arabic. Keep it that way.

---

## File Map

```
game.js        ~8800 lines  — all game logic, classes, Firebase, rendering
index.html       ~660 lines  — single page; all panels/overlays live here
style.css       ~2800 lines  — all styling; mobile rules under body.is-mobile
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

**Critical CSS rule**: Never use `!important` on `transform` for `.focus-sounds-panel` or the mobile drawer. JS drag code sets `drawer.style.transform` inline, and `!important` silently beats inline styles — the drawer will appear broken (can't pull up).

**Focus drawer**: Bottom-sheet on mobile. Drag handle pulls it up. State tracked by `.drawer-open` class. Children must have `flex-shrink: 0` or the prayer panel gets crushed when YouTube is open.

**Focus mode** (`setMobileFocusMode(active)`): Hides joystick + user card during work phase. Joystick gets `.focus-hidden` class → opacity 0.

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

### HTML data-sound keys must match engine keys exactly
The HTML `<div class="sound-item" data-sound="KEY">` must match the key in `this.sounds`. If you add a new sound, add it to both.

### Sound preloading and background-tab rules
**All sounds must be preloaded.** Every new sound file must be:
1. Added as `new Audio('Sound/Filename.mp3')` in `gameState.sounds`
2. Added to `FocusAudioEngine.buffers` with a `null` entry
3. Loaded in `loadSoundEffects()` via `await loadBuffer(...)`
4. Preloaded via `gameState.sounds.X.preload = 'auto'` after `gameState` declaration

**Sounds must work in background tabs.** Use `focusAudioEngine.playEffect('key')` (Web Audio API) rather than `playSoundRobust(gameState.sounds.X)` (HTMLAudioElement) for any sound that must fire when the tab is not focused — e.g., session transitions (TimeReturn), kidnap sounds, prayer calls. HTMLAudioElement playback can be throttled/blocked by the browser in background tabs; Web Audio nodes play regardless.

**`ctx.resume()` is async — await it before playing.** The AudioContext can be suspended in background tabs. Calling `ctx.resume()` without awaiting it and then immediately scheduling nodes causes silent failures. Always chain: `ctx.resume().then(_doPlay)`. The `playEffect()` method already does this — never rewrite it to fire-and-forget.

**Background-tab fast path**: `startKidnapAnimation` already handles `document.hidden` (skips animation, teleports instantly). For timed delays before kidnap (like the 2-second post-break wait), use `setTimeout` — it fires in background tabs (with some throttling). Store the timer ID in `fm._breakEndTimer` and clear it in `endFreeMode` to prevent orphaned timers.

---

## Shared Pomodoro (Coop) System

State machine at `gameState.sharedPomo.phase`: `'idle' | 'gathering' | 'guest-waiting' | 'active'`

### Key paths (via `spPath()`)
- `sharedPomo/sessions/{hostId}` — gathering/invite coordination (deleted after 12s)
- `sharedPomo/live/{hostId}` — active session live doc (participants, phase, time)
- `sharedPomo/invites/{uid}` — incoming invite for a user

### Host promotion (when host disconnects mid-session)
`setupSpLiveListener` detects `data === null` → calls `handleHostLeft()`. Remaining members sort UIDs deterministically → elect lexicographically-first as new host. New host writes fresh live doc and sets up listener; others re-point to new host.

### Solo-to-shared conversion
Free player walks near solo worker → `checkNearbyCoopSession` → `showSoloJoinPanel`. Guest writes to `sp/live/{hostId}`. Host's `setupSoloUpgradeListener` fires → upgrades to `phase='active'`.

### Coop animation
`updateCoopAnimation()` only runs members still in `sp.activeGroupMembers`. Members who leave are removed via Set-filter in `setupSpLiveListener` and deleted from `sp.coopAnim.members`.

---

## Pomodoro Timer (per-laptop)

Firebase path: `lobbyPath('pomodoro/{laptopId}')` — written by host, read by all.

`startPomodoroPhase(phase)` handles `'work' | 'break' | 'end'`. Phase transitions fire audio cues (`focusAudioEngine.playEffect(...)`) and UI changes.

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

`initPrayerSystem()` → `fetchPrayerTimes()` (calls Adhan API) → schedules `checkPrayerTrigger()` to run each minute. On trigger: `triggerPrayerOverlay()` plays adhan sound + rain particles + full-screen overlay. User dismisses or it auto-expires.

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
Sugar falls from top. `progress = (serverNow() - spawnTime) / fallDuration` — computed by all clients independently (no physics sync needed). First writer wins the catch. Bad sugars (14% chance) give −3 pts.

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
| Prayer panel crushed by YouTube | No `flex-shrink: 0` on drawer children | Add `body.is-mobile .focus-sounds-panel > * { flex-shrink: 0 }` |
| Coop anim plays for departed members | Departed UIDs never removed from `activeGroupMembers` | Set-filter in `setupSpLiveListener` + delete from `coopAnim.members` |
| Focus sound won't play after buffer not loaded | `!buf` returns early after gainNode already connected | Disconnect gainNode before early return: `gainNode.disconnect(); return;` |
| Mobile leave button overlaps timer | `top: 50px` sits inside the 5.5rem (~88px) timer block | Use `top: 124px` |
| Timer shows before countdown | `startTime` too close to `now` | Use `startTime = serverNow() + 3500` |
| Session blocks replaying | Session never deleted | `returnFromCoffee/returnFromRace` must write `null` |
| Solo-to-shared joiner name undefined | Malformed `.find()` on participant keys | `const joinerUid = uids.find(uid => uid !== gameState.userId)` |
| Coop task panel hidden for guests | `shouldShow` required `sp.isHost` | Remove host check — show for all `sp.phase === 'active'` members |
| Ghost movement snappy | Raw Firebase value applied directly | Lerp `displayX` toward `mugX` each frame in `updateCoffeeMode` |
| Lobby stays visible after Siraj spawn | `startGame` only removes `login-screen` | Explicitly remove `active` from `lobby-screen` in `spawnSirajGhost` |

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
5. **Mobile**: Test by resizing browser to <1024px. Check drawer, joystick, leave button positions.
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
