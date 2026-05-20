# Mdwnh Digital Workspace — Dev Notes

## Local Development Server

Always run a local server to test (required for ES modules + Firebase):

```bash
# Python (built-in, simplest)
python3 -m http.server 8080

# Node.js alternatives
npx serve .
npx http-server . -p 8080 --cors
```

Then open **http://localhost:8080** in your browser.

### Mobile testing on real device
1. Connect phone to the same WiFi
2. Find your Mac's local IP: `ipconfig getifaddr en0`
3. Open `http://[YOUR_IP]:8080` on the phone

---

## Architecture

- Pure frontend — no build step, vanilla ES modules
- Firebase Realtime Database (europe-west1) handles all multiplayer state
- `firebase-config.js` exports `{ database, ref, onValue, update, get, onDisconnect, set }`

## Mobile / Responsive System

Mobile mode is detected purely by **window width < 1024px** — this fires on resize too, so you can test mobile layout by resizing the browser window.

The `body.is-mobile` class is toggled by `setMobileClass()` in game.js and drives all mobile-specific CSS.

### Mobile-only features
| Feature | Notes |
|---|---|
| Virtual joystick | Bottom-left, tracks touch. Push >55% radius = sprint |
| Pinch-to-zoom | Disabled during race |
| Hold-to-sprint | Joystick displacement >55% of radius |
| Focus drawer | Bottom sheet with `أصوات` label, drag up to reveal sounds + YT |
| User card hide | Slides up (with خروج pill) during work phase, bounces back on break/end |
| Race D-pad | Forward / Back / Left / Right buttons replace joystick during race |
| Race camera | Rotates with car so car always drives "up" (lerps smoothly; desktop stays static) |
| Siraj test mode | Hold الإخوة lobby button 800ms → spawns siraj ghost (same as Shift+click on desktop) |
| Reduced particles | 10 wind particles on mobile (vs 30 on desktop) for performance |

### Desktop-only features
- Top-right floating user card (avatar + name + channel + count) — no logout button inside it
- خروج pill floats separately on the left (same glass style as the user card)
- Focus sounds panel floats at bottom-center as before
- YouTube player floats at bottom-left

---

## Design Language

Follow **Apple HIG** principles throughout the UI:
- **Glass surfaces**: `rgba(18,18,18,0.68)` + `backdrop-filter: blur(20px) saturate(1.6)`
- **Subtle borders**: `rgba(255,255,255,0.09)` — barely visible, not structural
- **Shadows**: soft, low-spread (`0 4px 24px rgba(0,0,0,0.30)`) — depth without heaviness
- **Typography**: `font-weight: 600` for primary labels, `rgba(255,255,255,0.42)` for secondary
- **Letter spacing**: `-0.01em` on headings, `0.01-0.02em` on small labels
- **Transitions**: `cubic-bezier(0.34, 1.56, 0.64, 1)` for spring-y interactive elements
- **Pill shapes**: `border-radius: 50px` for standalone action buttons (خروج)
- **No heavy drop shadows** — keep depth light and layered

---

## Key Constants (game.js)
```
MOVE_SPEED = 5
PLAYER_SIZE = 70
BG_SCALE = 0.5             → world ≈ 1195 × 875 px
ROOM_COUNT = 2             → work room (top) + break room (bottom)
RACE_LAPS = 3
MOBILE_BREAKPOINT = 1024   (window.innerWidth)
WIND_PARTICLE_COUNT = 30   (desktop)
WIND_PARTICLE_COUNT_MOBILE = 10
```

## Minigame Architecture

**Gender separation**: All minigame sessions live under `lobbies/{male|female}/minigames/...` — since `lobbyPath()` is always used, male and female lobbies never share sessions.

**Multiple simultaneous games**: Each game type has its own session namespace (`minigames/race/sessions/` and `minigames/coffee/sessions/`). Within each type, multiple sessions can be active at the same time (each keyed by `{hostId}_{timestamp}`). Players in different sessions don't interact.

**Ready-sync protocol** (both games):
1. Host creates session with `startTime: 0`
2. Each client writes `participants/{uid}/ready: serverNow()` when they enter the game
3. Host watches Firebase: when all participants have `ready`, waits until `max(ready timestamps) + 1000ms`, then writes `startTime: serverNow() + 3500` (3.5 s gives the 3-2-1 countdown)
4. 5-second fallback: if not all ready after 5s, host starts anyway
5. **Do NOT set a small +500 offset** — clients need the full countdown window to render 3-2-1

### Coffee Minigame (`minigames/coffee/sessions/`)
| Key constant | Value |
|---|---|
| `COFFEE_MATCH_MS` | 30000 (30s) |
| `COFFEE_MUG_Y_FRAC` | 0.80 (mug at 80% screen height) |
| `COFFEE_CATCH_HALF` | 52 px half-hitbox |
| `COFFEE_ZONE_CX` | 280 world units (right of race zone) |

Sugar spawning: host writes to `sessions/{key}/sugars/{id}`. Y position computed by all clients as `progress = (serverNow() - spawnTime) / fallDuration`. First player to write `caughtBy` claims the catch. Bad sugar (14% chance) = −3 pts + heavy shake (not elimination).

Mug sync: `participants/{uid}/mugX` (0..1) updated every 80ms for ghost rendering. Ghost positions use client-side lerp (`mugVisuals[uid].displayX`) to hide Firebase latency — never apply lerp to the local mug.

Session lifetime: `returnFromCoffee()` always deletes the session from Firebase (`lobbyPath('minigames/coffee/sessions/{key}') = null`) so the same player can start a new game immediately. **Forgetting this causes "can't play again" bugs.**

**Siraj ghost cleanup**: Siraj test ghosts never trigger the normal logout/return flow, so their minigame sessions can linger. Fix applied in `startLocalCoffee`: if `gameState.isSirajGhost`, set `onDisconnect(...).remove()` on the session path AND a 90-second `setTimeout` that force-deletes it. Cancel the timer in `returnFromCoffee`. Apply the same pattern to any future minigame.

## Common Minigame Pitfalls (lessons learned)

| Issue | Root cause | Fix |
|---|---|---|
| Timer shows before game starts | `startTime` set too close to `now` | Use `startTime = serverNow() + 3500` to allow 3-2-1 countdown |
| Session blocks replaying | Session never deleted from Firebase | `returnFromCoffee/returnFromRace` must write `null` to the session path |
| Ghost movement is snappy | Raw Firebase value used directly | Lerp `displayX` toward `mugX` every frame in `updateCoffeeMode` |
| HUD overlaps OS chrome | Element placed at top-center same as pomodoro pill | Coffee HUD lives on right side; check existing HTML elements before choosing position |
| Ready sound missing for new game type | Sound only wired to race zone entry | Each zone needs its own "newly entered" diff check with `prevZonePlayers` |
| Leaderboard not visible during countdown | HUD function returned early when `now < startTime` | Split: timer shown only when active, leaderboard shown always |
| Results panel missing avatars | `results` only stores `username`/`score` | Look up avatar from `session.participants[uid].avatar` at draw time |
| Siraj ghost sessions linger in Firebase | Ghost disconnects without calling `returnFromCoffee` | `onDisconnect` + 90s `setTimeout` in `startLocalCoffee` when `isSirajGhost`; cancel timer in `returnFromCoffee` |
| Mug flash shows white rectangle (transparent bg) | `source-atop` on main canvas composites against everything drawn | Render mug to offscreen canvas, apply `source-atop` tint there, stamp result back |
| Lobby screen stays visible after Siraj Shift+click | `spawnSirajGhost` calls `startGame` which only removes `login-screen` | Explicitly remove `active` from `lobby-screen` before calling `startGame` in `spawnSirajGhost` |

## DPR Canvas Scaling
Canvas is scaled by `window.devicePixelRatio` in `resizeCanvas()`:
- `canvas.width/height = viewport * dpr` (physical)
- `canvas.style.width/height = viewport + 'px'` (CSS logical)
- `gameState.dpr` stores the current ratio
- `render()` and `renderRace()` call `ctx.save(); ctx.scale(dpr, dpr)` so all drawing uses **logical pixels**
- `drawFocusMask`: mCanvas stays physical for sharp gradients; player positions computed with `* dpr`; drawn via `ctx.drawImage(mCanvas, 0, 0, W, H)`

## Shared Pomodoro Firebase Cleanup

`sharedPomo/sessions/{hostId}` is a temporary coordination doc — it **must not linger** in Firebase after the session starts.

**Cleanup rules:**
1. Host calls `update(... { [spPath('sessions/{id}')]: null })` 12 seconds after `startTime` in `launchSharedPomoWork` — enough time for all clients to receive the session and start.
2. Host's `onDisconnect` for the laptop pomodoro path (`lobbyPath('pomodoro/{laptopId}')`) is set in `launchSharedPomoWork` to auto-remove if host disconnects mid-session.
3. `cancelSharedPomo()` deletes the session immediately when host cancels before starting.
4. `leaveSharedPomo()` removes only the local participant's entry from `participants/`.
5. The invite doc (`sharedPomo/invites/{uid}`) is always cleaned up: on accept, decline, timeout (10s), or auto-expire timeout in `sendSpInvite`.

**Do NOT leave `sharedPomo/sessions` docs alive indefinitely** — they are not permanent session records.
