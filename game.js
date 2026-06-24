import { database, ref, onValue, update, get, onDisconnect, set, remove, authReady } from './firebase-config.js';

// ─── Mobile detection ────────────────────────────────────────────────────────
const MOBILE_BREAKPOINT = 1024;
function isMobile() {
    if (window.innerWidth < MOBILE_BREAKPOINT) return true;
    // Some mobile browsers (DuckDuckGo, in-app webviews, "desktop site" mode)
    // report a wide layout viewport even on a phone — which would wrongly give
    // the desktop UI (no drawer). Fall back to the physical screen size: a
    // coarse-pointer touch device whose smaller screen dimension is phone-sized
    // is treated as mobile regardless of the reported innerWidth.
    if (isTouchDevice()) {
        const s = window.screen || {};
        const shortSide = Math.min(s.width || Infinity, s.height || Infinity);
        if (shortSide && shortSide < 760) return true;
    }
    return false;
}

// ─── Device-local settings keys (used before init() is called) ───────────────
const SETTINGS_GRAPHICS_KEY = 'mdwnh_graphics_quality'; // 'auto' | 'high' | 'low' | 'potato'
const SETTINGS_NAMES_KEY    = 'mdwnh_hide_names';        // '0' = show, '1' = hide
const SETTINGS_JOYSTICK_KEY = 'mdwnh_joystick_mode';    // 'auto' | 'always' | 'off'
const SETTINGS_NOIDLE_KEY   = 'mdwnh_disable_idle_anim'; // '1' = disable idle animation while working
const SETTINGS_AZKAR_RANDOM_KEY = 'mdwnh_randomize_azkar'; // '1' = shuffle azkar order

function getDisableIdleAnim() { return localStorage.getItem(SETTINGS_NOIDLE_KEY) === '1'; }
function getRandomizeAzkar()  { return localStorage.getItem(SETTINGS_AZKAR_RANDOM_KEY) === '1'; }

// ─── Touch / joystick detection ──────────────────────────────────────────────
// `is-mobile` is width-based and drives the whole mobile layout. But the control
// circle (joystick) must also appear on touch devices that report a wide viewport
// — e.g. an iPad in landscape (width >= 1024) which would otherwise be treated as
// a desktop. Joystick visibility is therefore decoupled from `is-mobile`.
function isTouchDevice() {
    return (navigator.maxTouchPoints || 0) > 0
        || ('ontouchstart' in window)
        || (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
}
// 'on' | 'off' | null. null = device-auto (show on touch devices). Legacy values
// 'always'→'on' and 'auto'→null are migrated transparently.
function getJoystickMode() {
    const v = localStorage.getItem(SETTINGS_JOYSTICK_KEY);
    if (v === 'on' || v === 'always') return 'on';
    if (v === 'off') return 'off';
    return null; // auto / device default
}
function setJoystickMode(mode) {
    if (mode === 'on' || mode === 'off') localStorage.setItem(SETTINGS_JOYSTICK_KEY, mode);
    else localStorage.removeItem(SETTINGS_JOYSTICK_KEY);
    updateJoystickVisibility();
}
// Should the control circle be shown right now?
// on   → always shown   off → never shown
// null → device-auto: any touch-capable device (incl. iPad landscape) or narrow viewport
function joystickShouldShow() {
    const mode = getJoystickMode();
    if (mode === 'on')  return true;
    if (mode === 'off') return false;
    return isMobile() || isTouchDevice(); // auto default
}
function updateJoystickVisibility() {
    document.body.classList.toggle('joystick-enabled', joystickShouldShow());
}

function setMobileClass() {
    document.body.classList.toggle('is-mobile', isMobile());
    applyGraphicsBodyClass();
    updateJoystickVisibility();
}

// Mirror the graphics tier onto the <body> so the CSS perf wins (drop live
// backdrop-filter, pause overlay animations) apply on DESKTOP too when the user
// picks low/potato — not just on mobile. `reduced-gfx` = low or potato (the
// cheap compositing wins); `potato-gfx` = the most aggressive tier. On desktop
// the default tier is 'high', so these only switch on once the user lowers it.
function applyGraphicsBodyClass() {
    const reduced = isReducedGraphics();
    document.body.classList.toggle('reduced-gfx', reduced);
    document.body.classList.toggle('potato-gfx', isPotato());
}
// ─── Lobby configuration ─────────────────────────────────────────────────────
// To add a new lobby: add one entry.  The key is the internal lobby ID and must
// match what index.js writes into users/{id}/lobby.
// categoryName must match the exact Discord category name.
const LOBBY_CONFIG = {
    male: {
        label:        'الإخوة',
        categoryName: '🔥 صالة السادة',
        iconClass:    'male'
    },
    female: {
        label:        'الأخوات',
        categoryName: '🌺صالة السيدات',
        iconClass:    'female'
    }
    // ← add new lobbies here; no other file changes needed
};

// Tracks temp Siraj ghost user IDs so they're deleted on disconnect
const sirajGhosts = [];

// Convert Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩) to Western (0-9)
const normalizeArabicNums = s => s.replace(/[٠١٢٣٤٥٦٧٨٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));

function setupArabicNumeralSupport() {
    document.querySelectorAll('input[inputmode="numeric"]').forEach(input => {
        input.addEventListener('input', () => {
            const converted = normalizeArabicNums(input.value);
            if (converted !== input.value) {
                const pos = input.selectionStart;
                input.value = converted;
                try { input.setSelectionRange(pos, pos); } catch (_) {}
            }
        });
    });
}

// Returns a Firebase path scoped to the active lobby.
// All minigame and pomodoro data is segregated per lobby.
function lobbyPath(subpath) {
    const lobby = gameState.selectedLobby;
    if (!lobby) throw new Error('lobbyPath called before lobby was selected');
    return `lobbies/${lobby}/${subpath}`;
}

// Returns a Firebase path within the current player's active race session.
function raceSessionPath(subpath) {
    const key = gameState.race.sessionKey;
    if (!key) return lobbyPath('minigames/race/sessions/__invalid__');
    return lobbyPath(`minigames/race/sessions/${key}${subpath ? '/' + subpath : ''}`);
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Discord OAuth (Implicit Grant — no server / no secret) ──────────────────
// Lets users log in from anywhere without joining a Discord VC. The returned
// Discord user ID matches the same `users/{id}` key the bot writes, so a single
// account flows through both paths with no mapping table.
const DISCORD_CLIENT_ID = '1505168261157752972';
const DISCORD_SCOPE = 'identify';
const DISCORD_SESSION_KEY = 'mdwnh_discord_session';
// Set to the user id while actively in-game; cleared on explicit logout. Lets us
// auto-resume straight back into the game after an unintended reload (e.g. Android
// Chrome discarding the tab when the user switches apps) instead of dumping them
// back on the lobby/welcome screen.
const ACTIVE_SESSION_KEY = 'mdwnh_active_session';

// Returns the exact redirect URI registered for the current host.
// Discord matches strictly so we hardcode known-good values.
function getDiscordRedirectUri() {
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
        return window.location.pathname === '/' ? 'http://localhost:8080/' : 'http://localhost:8080';
    }
    return 'https://youssefdot.github.io/MdwnhCafe/';
}

function getDiscordAuthorizeUrl() {
    const params = new URLSearchParams({
        client_id:    DISCORD_CLIENT_ID,
        response_type: 'token',
        redirect_uri: getDiscordRedirectUri(),
        scope:        DISCORD_SCOPE
    });
    return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

function saveDiscordSession(token, expiresInSec) {
    localStorage.setItem(DISCORD_SESSION_KEY, JSON.stringify({
        token,
        expiresAt: Date.now() + (expiresInSec * 1000)
    }));
}

function loadDiscordSession() {
    try {
        const raw = localStorage.getItem(DISCORD_SESSION_KEY);
        if (!raw) return null;
        const s = JSON.parse(raw);
        if (!s?.token) return null;
        if (s.expiresAt && Date.now() > s.expiresAt) return null;
        return s;
    } catch { return null; }
}

function clearDiscordSession() {
    localStorage.removeItem(DISCORD_SESSION_KEY);
}

async function fetchDiscordUser(token) {
    try {
        const res = await fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) return null;
        const data = await res.json();
        let avatarUrl;
        if (data.avatar) {
            avatarUrl = `https://cdn.discordapp.com/avatars/${data.id}/${data.avatar}.png?size=128`;
        } else {
            // Default discord avatar — new system uses (id >> 22) % 6
            const idx = Number((BigInt(data.id) >> 22n) % 6n);
            avatarUrl = `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
        }
        return {
            id:       data.id,
            username: data.global_name || data.username,
            avatar:   avatarUrl
        };
    } catch { return null; }
}

// Parse #access_token=... from URL on OAuth callback. Saves session + cleans URL.
function parseDiscordOauthHash() {
    if (!window.location.hash) return false;
    const params = new URLSearchParams(window.location.hash.slice(1));
    const token = params.get('access_token');
    if (!token) return false;
    const expiresIn = parseInt(params.get('expires_in') || '604800', 10); // 7d default
    saveDiscordSession(token, expiresIn);
    history.replaceState(null, '', window.location.pathname + window.location.search);
    return true;
}

// Determine the user's lobby from existing Firebase data.
// Returns 'male' | 'female' | null (null => caller shows first-time chooser).
async function resolveUserLobby(discordId) {
    const snap = await get(ref(database, `users/${discordId}`));
    const data = snap.val() || {};
    if (data.lobby && LOBBY_CONFIG[data.lobby]) return data.lobby;
    if (data.categoryName) {
        for (const [key, cfg] of Object.entries(LOBBY_CONFIG)) {
            if (cfg.categoryName === data.categoryName) return key;
        }
        // categoryName is from a non-male/female category (e.g. admin) — ignore it.
    }
    // Fallback: localStorage preserves the user's choice across bot-driven Firebase overwrites.
    const cached = localStorage.getItem(`mdwnh_discord_lobby_${discordId}`);
    if (cached && LOBBY_CONFIG[cached]) {
        update(ref(database), { [`users/${discordId}/lobby`]: cached });
        return cached;
    }
    return null;
}

async function enterGameAsDiscordUser(user, lobby) {
    // Wake the shared audio context NOW — we're still inside the "Enter" button
    // click that called us, and that gesture is the browser's permission to start
    // audio. The awaits below (Firebase reads/writes) end the gesture window, so an
    // AudioContext created afterwards (in startGame) is born suspended on Safari and
    // the entrance sound waits for the next tap to wake it. Priming here lets it
    // play the instant the entrance fires. (No-op on the gesture-less auto-resume
    // path; _juiceWireResume covers that.)
    _primeFocusAudio();

    gameState.selectedLobby = lobby;
    localStorage.setItem(`mdwnh_discord_lobby_${user.id}`, lobby);

    const snap = await get(ref(database, `users/${user.id}`));
    const existing = snap.val() || {};
    const updates = {
        [`users/${user.id}/lobby`]:       lobby,
        [`users/${user.id}/avatar`]:      user.avatar,   // always refresh from Discord
        [`users/${user.id}/channelName`]: null,          // clear stale VC channel
    };
    if (!existing.username) updates[`users/${user.id}/username`] = user.username;
    await update(ref(database), updates);

    document.getElementById('lobby-screen')?.classList.remove('active');
    document.getElementById('login-screen')?.classList.remove('active');
    document.getElementById('discord-welcome-screen')?.classList.remove('active');
    document.getElementById('discord-first-lobby-modal')?.classList.remove('active');

    startGame({
        userId:      user.id,
        username:    existing.username || user.username,
        channelName: null,
        avatar:      user.avatar
    });
}

function showDiscordWelcomeScreen(user, lobby) {
    const screen = document.getElementById('discord-welcome-screen');
    const lobbyScreen = document.getElementById('lobby-screen');
    if (!screen) return;

    document.getElementById('discord-welcome-avatar').src = user.avatar;
    document.getElementById('discord-welcome-name').textContent = user.username;
    document.getElementById('discord-welcome-lobby').textContent = LOBBY_CONFIG[lobby]?.label || lobby;

    if (lobbyScreen) lobbyScreen.classList.remove('active');
    screen.classList.add('active');

    document.getElementById('discord-welcome-enter').onclick = () => {
        enterGameAsDiscordUser(user, lobby);
    };
    document.getElementById('discord-welcome-logout').onclick = () => {
        clearDiscordSession();
        try { localStorage.removeItem(ACTIVE_SESSION_KEY); } catch (_) {}
        screen.classList.remove('active');
        if (lobbyScreen) lobbyScreen.classList.add('active');
    };
}

function showDiscordFirstLobbyChooser(user) {
    const modal = document.getElementById('discord-first-lobby-modal');
    if (!modal) return;
    document.getElementById('discord-first-name').textContent = user.username;

    const buttonsWrap = document.getElementById('discord-first-lobby-buttons');
    buttonsWrap.innerHTML = '';
    for (const [lobbyId, cfg] of Object.entries(LOBBY_CONFIG)) {
        const btn = document.createElement('button');
        btn.className = `lobby-btn ${cfg.iconClass || ''}`;
        btn.dataset.lobby = lobbyId;
        btn.innerHTML = `
            <div class="lobby-icon" aria-hidden="true"></div>
            <div class="lobby-label">${cfg.label}</div>
        `;
        btn.addEventListener('click', () => {
            modal.classList.remove('active');
            enterGameAsDiscordUser(user, lobbyId);
        });
        buttonsWrap.appendChild(btn);
    }
    modal.classList.add('active');
}

function setupDiscordLoginButton() {
    const btn = document.getElementById('discord-login-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        btn.classList.add('loading');
        window.location.href = getDiscordAuthorizeUrl();
    });
}

// Main OAuth entry — called once on init.
async function initDiscordOAuth() {
    setupDiscordLoginButton();
    parseDiscordOauthHash();

    const loading = document.getElementById('loading-screen');
    const lobby   = document.getElementById('lobby-screen');

    const session = loadDiscordSession();
    if (!session) {
        loading?.classList.remove('active');
        lobby?.classList.add('active');
        return;
    }

    // Keep spinner while we validate the token + read Firebase
    const user = await fetchDiscordUser(session.token);
    if (!user) {
        clearDiscordSession();
        loading?.classList.remove('active');
        lobby?.classList.add('active');
        return;
    }

    const resolvedLobby = await resolveUserLobby(user.id);
    loading?.classList.remove('active');
    if (resolvedLobby) {
        // Auto-login (auto-resume straight into the game on refresh) is DISABLED on
        // purpose: a gesture-less reload can't start audio (browser autoplay block),
        // so the entrance sound never played. We always show the welcome screen now,
        // so pressing الدخول provides the gesture that unlocks the entrance sound.
        showDiscordWelcomeScreen(user, resolvedLobby);
    } else {
        showDiscordFirstLobbyChooser(user);
    }
}
// ─────────────────────────────────────────────────────────────────────────────

class FocusAudioEngine {
    constructor() {
        this.ctx = null;
        this.sampleRate = 44100;
        this.masterGain = null;
        this.overallVolume = 0.5;
        this.sounds = {
            rain:         { active: false, volume: 0.5, nodes: null },
            rain_muffled: { active: false, volume: 0.5, nodes: null },
            fire:         { active: false, volume: 0.5, nodes: null },
            forest:       { active: false, volume: 0.5, nodes: null },
            brown:        { active: false, volume: 0.5, nodes: null },
            wind:         { active: false, volume: 0.5, nodes: null },
            plane:        { active: false, volume: 0.5, nodes: null },
            ocean:        { active: false, volume: 0.5, nodes: null },
        };
        // Normalized ambient levels (file-based sounds use 1.0, synthesized stay lower)
        this.baseVolumeScale = {
            rain: 1.0,
            rain_muffled: 1.0,
            fire: 1.0,
            forest: 1.0,
            brown: 1.0,
            wind: 1.0,
            plane: 0.09,
            ocean: 1.0,
        };
        this.buffers = {
            timeBreak: null,
            timeReturn: null,
            kidnap: null,
            yipee: null,
            breakAdded: null,
            inviteSent: null,
            inviteAccepted: null,
            // JUICE: entrance whoosh + UI cascade blip — played through THIS engine's
            // single context so they never spin up a competing AudioContext.
            entranceSound: null,
            uiBlip: null,
            // Laptop boss fight
            bossAnticipate: null,
            bossAttackInitiate: null,
            bossGrabInitiate: null,
            bossGrabSuccess: null,
            bossWeakIdle: null,
            bossWeakInitiate: null,
            bossWeakEnd: null,
            bossHit: null,
            bossAttackStomp: null,
            playerHitBoss: null,
            playerLooseBoss: null,
            playerWinBoss: null,
            bossApplause: null,
            crowdCheer: null,
            crowdShock: null,
        };
        this.focusBuffers = {
            rain: null,
            rain_muffled: null,
            fire: null,
            forest: null,
            brown: null,
            wind: null,
            ocean: null,
        };
        // Source files for the file-based ambient sounds. Used both for buffer
        // decoding (background-safe steady-state) and for instant streaming start
        // via a media element before the buffer has finished downloading.
        this.focusFiles = {
            rain:         'Sound/Focus Sounds/Rain.mp3',
            rain_muffled: 'Sound/Focus Sounds/Muffled rain.mp3',
            fire:         'Sound/Focus Sounds/Boiling.mp3',
            forest:       'Sound/Focus Sounds/Forest.mp3',
            brown:        'Sound/Focus Sounds/Brown Noise.mp3',
            wind:         'Sound/Focus Sounds/Wind.mp3',
            ocean:        'Sound/Focus Sounds/Ocean.mp3',
        };
    }
    // file-based ambient sound keys (everything except synthesized 'plane')
    get fileSoundKeys() { return ['rain', 'rain_muffled', 'fire', 'forest', 'brown', 'wind', 'ocean']; }

    init() {
        if (this.ctx) return;
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.sampleRate = this.ctx.sampleRate;
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.setValueAtTime(1.0 * this.overallVolume, this.ctx.currentTime);
        this.masterGain.connect(this.ctx.destination);
        this.loadSoundEffects();
        this.loadFocusSoundBuffers();

        const resumeCtx = () => {
            if (this.ctx && this.ctx.state === 'suspended') {
                this.ctx.resume().then(() => {
                    // Start any active sounds that couldn't launch while context was suspended
                    for (const [name, sound] of Object.entries(this.sounds)) {
                        if (sound.active && !sound.nodes) this.startSound(name);
                    }
                }).catch(e => {});
            }
        };
        document.addEventListener('click', resumeCtx);
        document.addEventListener('keydown', resumeCtx);

        // When the user tabs back after an extended background period the browser
        // suspends the AudioContext. Resume it immediately on visibility restore,
        // then restart any ambient sounds whose source nodes may have been killed.
        document.addEventListener('visibilitychange', () => {
            if (document.hidden || !this.ctx) return;
            // Only restart sounds if the context was actually suspended (long background tab).
            // If it's already running, sounds are still playing — restarting would reset the loop.
            if (this.ctx.state === 'suspended') {
                this.ctx.resume().then(() => {
                    for (const [name, sound] of Object.entries(this.sounds)) {
                        if (!sound.active) continue;
                        this._teardownNodes(sound);
                        this.startSound(name);
                    }
                }).catch(e => {});
            }
        });
    }

    async loadSoundEffects() {
        const loadBuffer = async (url) => {
            const response = await fetch(url);
            const arrayBuffer = await response.arrayBuffer();
            return await this.ctx.decodeAudioData(arrayBuffer);
        };
        // Core UI sounds (sequential — small, fast).
        // The entrance whoosh + UI blip load FIRST: the entrance sound must be ready
        // the instant login finishes, otherwise it lags behind the cinematic (and on
        // a gesture-less auto-resume it must be decoded before the first tap so it
        // can fire immediately). Loading them 8th (behind the timer/invite sounds)
        // was the "audio delayed by a bit" on re-entry.
        try {
            // Entrance whoosh: decode from the page-load prefetch if it's ready (no
            // second network round-trip), else fetch normally. Loaded FIRST so it's
            // ready the instant الدخول is pressed.
            let entAb = _entranceArrayBufferPromise ? await _entranceArrayBufferPromise : null;
            this.buffers.entranceSound  = entAb
                ? await this.ctx.decodeAudioData(entAb.slice(0))
                : await loadBuffer('Sound/Enterance_Sound.mp3');
            this.buffers.uiBlip         = await loadBuffer('Sound/Menu_Ui.mp3');           // JUICE
            this.buffers.timeBreak      = await loadBuffer('Sound/TimeBreak.mp3');
            this.buffers.timeReturn     = await loadBuffer('Sound/TimeReturn.mp3');
            this.buffers.kidnap         = await loadBuffer('Sound/LaptopGrab.mp3');
            this.buffers.yipee          = await loadBuffer('Sound/Yipee.mp3');
            this.buffers.breakAdded     = await loadBuffer('Sound/BreakAdded.mp3');
            this.buffers.inviteSent     = await loadBuffer('Sound/Invite_Sent.mp3');
            this.buffers.inviteAccepted = await loadBuffer('Sound/Invite_Accepted.mp3');
        } catch(e) {
            console.log("Failed to load Web Audio sound effects:", e);
        }
        // Boss-fight sounds (15 files) are only used inside the boss minigame, which
        // most players never open. Decoding them all on audio-init competes for
        // CPU/network during the critical startup window — a big cause of first-load
        // jank on budget phones (cold cache). Defer to browser idle time instead;
        // ensureBossSounds() also force-loads them the moment a boss fight begins.
        if (window.requestIdleCallback) {
            requestIdleCallback(() => this.ensureBossSounds(), { timeout: 6000 });
        } else {
            setTimeout(() => this.ensureBossSounds(), 2500);
        }
    }

    ensureBossSounds() {
        if (this._bossSoundsRequested || !this.ctx) return;
        this._bossSoundsRequested = true;
        const loadBuffer = async (url) => {
            const response = await fetch(url);
            const arrayBuffer = await response.arrayBuffer();
            return await this.ctx.decodeAudioData(arrayBuffer);
        };
        const bossSounds = [
            ['bossAnticipate',    'Sound/LaptopMinigame/Laptop_Anticipate.mp3'],
            ['bossAttackInitiate','Sound/LaptopMinigame/Laptop_Attack_Initiate .mp3'],
            ['bossGrabInitiate',  'Sound/LaptopMinigame/Laptop_Grab_initiate.mp3'],
            ['bossGrabSuccess',   'Sound/LaptopMinigame/Laptop_Grab_Success.mp3'],
            ['bossWeakIdle',      'Sound/LaptopMinigame/Laptop_Weak_Idle.mp3'],
            ['bossWeakInitiate',  'Sound/LaptopMinigame/Laptop_Weak_Inititate.mp3'],
            ['bossWeakEnd',       'Sound/LaptopMinigame/Laptop_Weak_End.mp3'],
            ['bossHit',           'Sound/LaptopMinigame/Laptop_Hit.mp3'],
            ['bossAttackStomp',   'Sound/LaptopMinigame/Laptop_Attack_Stomp.mp3'],
            ['playerHitBoss',     'Sound/LaptopMinigame/Player_Hit.mp3'],
            ['playerLooseBoss',   'Sound/LaptopMinigame/Player_Loose.mp3'],
            ['playerWinBoss',     'Sound/LaptopMinigame/Player_Win.mp3'],
            ['bossApplause',      'Sound/Minigame_Aplause.mp3'],
            ['crowdCheer',        'Sound/LaptopMinigame/Crowd_Cheer.mp3'],
            ['crowdShock',        'Sound/LaptopMinigame/Crowd_Shock.mp3'],
        ];
        Promise.all(bossSounds.map(async ([key, url]) => {
            try { this.buffers[key] = await loadBuffer(url); }
            catch(e) { console.log(`Boss sound load failed [${key}]:`, e); }
        }));
    }

    async loadFocusSoundBuffers() {
        // Load all sounds in parallel — each becomes available as soon as its own
        // buffer is ready (previously sequential: one slow file blocked all others).
        await Promise.all(Object.entries(this.focusFiles).map(async ([key, url]) => {
            try {
                const response = await fetch(url);
                const arrayBuffer = await response.arrayBuffer();
                this.focusBuffers[key] = await this.ctx.decodeAudioData(arrayBuffer);
                // Remove loading indicator now that this sound is buffered
                const el = document.querySelector(`.sound-item[data-sound="${key}"]`);
                if (el) el.classList.remove('sound-loading');
                // If the user toggled this sound on while it was still loading, switch
                // over to the seamless crossfade loop now that the buffer has arrived.
                const sound = this.sounds[key];
                if (sound?.active && this.ctx?.state === 'running') {
                    if (sound.nodes?.mediaEl) {
                        this._handoffToBuffer(key);   // crossfade: streaming → seamless loop
                    } else if (!sound.nodes) {
                        this.startSound(key);
                    }
                }
            } catch(e) {
                console.log(`Failed to load focus sound [${key}]:`, e);
            }
        }));
    }

    // Schedule a gap-free, cross-dissolving loop of `buf` into `gainNode`.
    // Instead of a hard loopStart/loopEnd jump (which can click), successive
    // copies of the buffer overlap by a short crossfade so the seam is inaudible.
    // Returns a loop-state handle; set `.stopped = true` and clear `.timer` to end it.
    _scheduleCrossfadeLoop(name, buf, gainNode) {
        const ctx = this.ctx;
        const XF = Math.max(0.15, Math.min(0.8, buf.duration * 0.18)); // crossfade seconds
        const period = Math.max(0.2, buf.duration - XF);               // spacing between starts
        const loop = { stopped: false, timer: null, sources: [], nextTime: ctx.currentTime + 0.03 };

        const startSegment = (when) => {
            const src = ctx.createBufferSource();
            src.buffer = buf;
            const seg = ctx.createGain();
            src.connect(seg);
            seg.connect(gainNode);
            // cross-dissolve envelope: fade in → hold → fade out (overlaps neighbours)
            seg.gain.setValueAtTime(0.0001, when);
            seg.gain.linearRampToValueAtTime(1, when + XF);
            seg.gain.setValueAtTime(1, when + period);
            seg.gain.linearRampToValueAtTime(0.0001, when + buf.duration);
            try { src.start(when); } catch(e) { try { seg.disconnect(); } catch(_){} return; }
            try { src.stop(when + buf.duration + 0.05); } catch(e) {}
            const entry = { src, seg };
            loop.sources.push(entry);
            src.onended = () => {
                try { src.disconnect(); } catch(e) {}
                try { seg.disconnect(); } catch(e) {}
                const i = loop.sources.indexOf(entry);
                if (i >= 0) loop.sources.splice(i, 1);
            };
        };

        // A look-ahead scheduler keeps ~1.5s of segments queued. The tab stays
        // "audible" while a sound plays, so its timers aren't throttled in the
        // background — the look-ahead is just a safety margin.
        const scheduler = () => {
            if (loop.stopped) return;
            const horizon = ctx.currentTime + 1.5;
            while (loop.nextTime < horizon) {
                startSegment(loop.nextTime);
                loop.nextTime += period;
            }
            loop.timer = setTimeout(scheduler, 300);
        };
        scheduler();
        return loop;
    }

    // Crossfade from the streaming media element to the seamless buffer loop once
    // the buffer has finished decoding. The loop's first segment fades in while the
    // media element fades out, so the listener hears no transition.
    _handoffToBuffer(name) {
        const sound = this.sounds[name];
        const buf = this.focusBuffers[name];
        if (!sound?.nodes?.mediaEl || !buf) return;
        const gainNode = sound.nodes.gainNode;
        const { mediaEl, mediaGain, mediaSource } = sound.nodes;

        sound.nodes.loopState = this._scheduleCrossfadeLoop(name, buf, gainNode);
        sound.nodes.mediaEl = null;
        sound.nodes.mediaGain = null;
        sound.nodes.mediaSource = null;

        const t = this.ctx.currentTime;
        try {
            mediaGain.gain.cancelScheduledValues(t);
            mediaGain.gain.setValueAtTime(mediaGain.gain.value, t);
            mediaGain.gain.linearRampToValueAtTime(0.0001, t + 0.8);
        } catch (e) {}
        setTimeout(() => {
            try { mediaEl.pause(); } catch(e) {}
            try { mediaSource.disconnect(); } catch(e) {}
            try { mediaGain.disconnect(); } catch(e) {}
            try { mediaEl.src = ''; } catch(e) {}
        }, 950);
    }

    // Immediately tear down all audio nodes for a sound (no fade). Used when
    // rebuilding after the context was suspended in a background tab.
    _teardownNodes(sound) {
        if (!sound.nodes) return;
        const n = sound.nodes;
        sound.nodes = null;
        if (n.loopState) {
            n.loopState.stopped = true;
            if (n.loopState.timer) clearTimeout(n.loopState.timer);
            n.loopState.sources.forEach(({ src, seg }) => {
                try { src.stop(); } catch(e) {}
                try { src.disconnect(); } catch(e) {}
                try { seg.disconnect(); } catch(e) {}
            });
        }
        try { n.source?.stop(); } catch(e) {}
        try { n.source?.disconnect(); } catch(e) {}
        n.secondaryNodes?.forEach(x => { try { x.stop(); } catch(e) {} try { x.disconnect(); } catch(e) {} });
        if (n.mediaEl) { try { n.mediaEl.pause(); } catch(e) {} try { n.mediaEl.src = ''; } catch(e) {} }
        try { n.mediaSource?.disconnect(); } catch(e) {}
        try { n.mediaGain?.disconnect(); } catch(e) {}
        try { n.gainNode?.disconnect(); } catch(e) {}
    }

    playEffect(name) {
        if (!this.ctx) this.init();
        const _doPlay = () => {
            const buffer = this.buffers[name];
            if (!buffer) {
                if (gameState.sounds[name]) {
                    gameState.sounds[name].pause();
                    gameState.sounds[name].currentTime = 0;
                    gameState.sounds[name].play().catch(e=>{});
                }
                return;
            }
            try {
                const source = this.ctx.createBufferSource();
                source.buffer = buffer;
                const gainNode = this.ctx.createGain();
                gainNode.gain.setValueAtTime(0.8, this.ctx.currentTime);
                source.connect(gainNode);
                gainNode.connect(this.ctx.destination);
                source.start();
            } catch(err) {
                console.log("Web Audio effect play failed, using fallback:", err);
                if (gameState.sounds[name]) gameState.sounds[name].play().catch(e=>{});
            }
        };
        // Must resume ctx BEFORE scheduling nodes — ctx.resume() is async,
        // so we chain _doPlay in .then() to guarantee the context is running
        if (this.ctx.state === 'suspended') {
            this.ctx.resume().then(_doPlay).catch(() => {
                if (gameState.sounds[name]) gameState.sounds[name].play().catch(e=>{});
            });
        } else {
            _doPlay();
        }
    }

    // JUICE one-shot: play a buffer at a random pitch with a short attack/release
    // envelope (no start/stop click → no "crackle"), through THIS engine's single
    // context. Returns true only if it actually started (ctx running + buffer ready).
    playPitched(name, rate, peak) {
        if (!this.ctx) this.init();
        const buf = this.buffers[name];
        if (!buf || !this.ctx || this.ctx.state !== 'running') return false;
        try {
            const src = this.ctx.createBufferSource();
            src.buffer = buf;
            src.playbackRate.value = rate;
            const g = this.ctx.createGain();
            const t = this.ctx.currentTime;
            const dur = buf.duration / rate;
            const atk = Math.min(0.014, dur * 0.25);
            const rel = Math.min(0.05, dur * 0.3);
            g.gain.setValueAtTime(0.0001, t);
            g.gain.exponentialRampToValueAtTime(peak, t + atk);
            g.gain.setValueAtTime(peak, t + Math.max(atk, dur - rel));
            g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
            src.connect(g); g.connect(this.ctx.destination);
            src.onended = () => { try { src.disconnect(); g.disconnect(); } catch (_) {} };
            src.start(0);
            return true;
        } catch (_) { return false; }
    }

    createWhiteNoiseNode() {
        const bufferSize = 2 * this.sampleRate;
        const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.sampleRate);
        const output = noiseBuffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            output[i] = Math.random() * 2 - 1;
        }
        const whiteNoise = this.ctx.createBufferSource();
        whiteNoise.buffer = noiseBuffer;
        whiteNoise.loop = true;
        return whiteNoise;
    }

    createBrownNoiseNode() {
        const bufferSize = 2 * this.sampleRate;
        const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.sampleRate);
        const output = noiseBuffer.getChannelData(0);
        let lastOut = 0.0;
        for (let i = 0; i < bufferSize; i++) {
            const white = Math.random() * 2 - 1;
            output[i] = (lastOut + (0.02 * white)) / 1.02;
            lastOut = output[i];
            output[i] *= 3.5;
        }
        const brownNoise = this.ctx.createBufferSource();
        brownNoise.buffer = noiseBuffer;
        brownNoise.loop = true;
        return brownNoise;
    }

    startSound(name) {
        if (!this.ctx) this.init();

        const sound = this.sounds[name];
        if (sound.nodes) return;

        // If context is still suspended, wait for it to resume before creating nodes
        if (this.ctx.state === 'suspended') {
            this.ctx.resume().then(() => {
                if (this.sounds[name].active) this.startSound(name);
            }).catch(() => {});
            return;
        }

        const gainNode = this.ctx.createGain();
        gainNode.connect(this.masterGain);

        let source = null;
        let secondaryNodes = [];

        if (this.fileSoundKeys.includes(name)) {
            const buf = this.focusBuffers?.[name];
            if (buf) {
                // Buffer ready → start the seamless cross-dissolving loop immediately.
                const loopState = this._scheduleCrossfadeLoop(name, buf, gainNode);
                sound.nodes = { gainNode, loopState, secondaryNodes: [] };
            } else {
                // Buffer still downloading → stream instantly via a media element so
                // the sound starts now, then hand off to the buffer loop when ready.
                let mediaEl, mediaSource, mediaGain;
                try {
                    mediaEl = new Audio(this.focusFiles[name]);
                    mediaEl.loop = true;          // temporary fallback loop until handoff
                    mediaEl.preload = 'auto';
                    mediaSource = this.ctx.createMediaElementSource(mediaEl);
                    mediaGain = this.ctx.createGain();
                    mediaGain.gain.setValueAtTime(1, this.ctx.currentTime);
                    mediaSource.connect(mediaGain);
                    mediaGain.connect(gainNode);
                    mediaEl.play().catch(() => {});
                } catch (e) {
                    gainNode.disconnect();
                    return;
                }
                sound.nodes = { gainNode, loopState: null, mediaEl, mediaSource, mediaGain, secondaryNodes: [] };
            }
        } else if (name === 'plane') {
            source = this.createBrownNoiseNode();
            const filter = this.ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.setValueAtTime(150, this.ctx.currentTime);
            source.connect(filter);
            filter.connect(gainNode);

            const osc1 = this.ctx.createOscillator();
            osc1.frequency.setValueAtTime(60, this.ctx.currentTime);
            const osc1Gain = this.ctx.createGain();
            osc1Gain.gain.setValueAtTime(0.15, this.ctx.currentTime);
            osc1.connect(osc1Gain);
            osc1Gain.connect(gainNode);

            const osc2 = this.ctx.createOscillator();
            osc2.frequency.setValueAtTime(90, this.ctx.currentTime);
            const osc2Gain = this.ctx.createGain();
            osc2Gain.gain.setValueAtTime(0.08, this.ctx.currentTime);
            osc2.connect(osc2Gain);
            osc2Gain.connect(gainNode);

            source.start();
            osc1.start();
            osc2.start();

            secondaryNodes.push(filter, osc1, osc1Gain, osc2, osc2Gain);
            sound.nodes = { source, gainNode, secondaryNodes };
        }

        // Unknown sound key (no branch ran) — bail without leaving a dangling node.
        if (!sound.nodes) { gainNode.disconnect(); return; }

        const scaledVol = sound.volume * this.baseVolumeScale[name];
        try {
            gainNode.gain.cancelScheduledValues(this.ctx.currentTime);
            gainNode.gain.setValueAtTime(0, this.ctx.currentTime);
            gainNode.gain.linearRampToValueAtTime(scaledVol, this.ctx.currentTime + 1.5);
        } catch (e) {
            gainNode.gain.value = scaledVol;
        }
    }

    stopSound(name) {
        const sound = this.sounds[name];
        if (!sound.nodes) return;

        const n = sound.nodes;
        sound.nodes = null; // immediately clear so startSound can restart without blocking

        // Stop scheduling new loop segments right away; existing ones ring out under the fade.
        if (n.loopState) {
            n.loopState.stopped = true;
            if (n.loopState.timer) clearTimeout(n.loopState.timer);
        }

        const gainNode = n.gainNode;
        try {
            gainNode.gain.cancelScheduledValues(this.ctx.currentTime);
            gainNode.gain.setValueAtTime(gainNode.gain.value, this.ctx.currentTime);
            gainNode.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.5);
        } catch (e) {
            gainNode.gain.value = 0;
        }

        setTimeout(() => {
            n.loopState?.sources.forEach(({ src, seg }) => {
                try { src.stop(); } catch(e) {}
                try { src.disconnect(); } catch(e) {}
                try { seg.disconnect(); } catch(e) {}
            });
            try { n.source?.stop(); } catch(e) {}
            try { n.source?.disconnect(); } catch(e) {}
            n.secondaryNodes?.forEach(x => { try { x.stop(); } catch(e) {} try { x.disconnect(); } catch(e) {} });
            if (n.mediaEl) { try { n.mediaEl.pause(); } catch(e) {} try { n.mediaEl.src = ''; } catch(e) {} }
            try { n.mediaSource?.disconnect(); } catch(e) {}
            try { n.mediaGain?.disconnect(); } catch(e) {}
            try { gainNode.disconnect(); } catch(e) {}
        }, 600);
    }

    updateVolume(name, val) {
        const sound = this.sounds[name];
        sound.volume = parseFloat(val);
        if (sound.nodes) {
            const scaledVol = sound.volume * this.baseVolumeScale[name];
            sound.nodes.gainNode.gain.setValueAtTime(scaledVol, this.ctx.currentTime);
        }
        // During azkar there's no work phase keeping master up — make the slider audible.
        if (gameState.azkar && gameState.azkar.active) this._applyMasterForAzkar();
    }

    updateOverallVolume(val) {
        this.overallVolume = parseFloat(val);
        const inWorkPhase = (gameState.pomodoro.active && gameState.pomodoro.phase === 'work')
            || (gameState.freeMode.active && gameState.freeMode.phase === 'work')
            || (gameState.azkar && gameState.azkar.active);
        if (this.masterGain && inWorkPhase) {
            this.masterGain.gain.setValueAtTime(this.overallVolume, this.ctx.currentTime);
        }
        this.saveToFirebase();
    }

    // The focus panel is shown during azkar as a live mixer, but no work phase is
    // running then, so the master gain sits at 0 and toggling sounds is silent.
    // This lifts master to the user's overall volume (resuming the context first).
    _applyMasterForAzkar() {
        if (!this.ctx || !this.masterGain) return;
        const apply = () => {
            try {
                this.masterGain.gain.cancelScheduledValues(this.ctx.currentTime);
                this.masterGain.gain.setValueAtTime(this.overallVolume, this.ctx.currentTime);
            } catch (e) {}
        };
        if (this.ctx.state === 'suspended') this.ctx.resume().then(apply).catch(() => {});
        else apply();
    }

    toggle(name) {
        const sound = this.sounds[name];
        sound.active = !sound.active;
        const el = document.querySelector(`.sound-item[data-sound="${name}"]`);
        if (el) {
            el.classList.toggle('active', sound.active);
            // Show a pulsing loading state if the buffer hasn't arrived yet
            const isBuffered = (this.focusBuffers[name] != null) || name === 'plane';
            el.classList.toggle('sound-loading', sound.active && !isBuffered);
        }
        if (sound.active) {
            this.startSound(name);
            // During azkar the panel acts as a live mixer; lift master so it's audible.
            if (gameState.azkar && gameState.azkar.active) this._applyMasterForAzkar();
        } else {
            this.stopSound(name);
            if (el) el.classList.remove('sound-loading');
        }
        this.saveToFirebase();
    }

    fadeToMaster(targetVolume, duration) {
        if (!this.ctx) this.init();
        const _doFade = () => {
            const targetGain = targetVolume * this.overallVolume;
            try {
                this.masterGain.gain.cancelScheduledValues(this.ctx.currentTime);
                this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, this.ctx.currentTime);
                this.masterGain.gain.linearRampToValueAtTime(targetGain, this.ctx.currentTime + duration);
            } catch (e) {
                this.masterGain.gain.value = targetGain;
            }
        };
        if (this.ctx.state === 'suspended') {
            this.ctx.resume().then(_doFade).catch(e => {});
        } else {
            _doFade();
        }
    }

    applyState(mixState) {
        if (!mixState) return;
        this.init();

        // Restore overall mix volume
        if (mixState.overallVolume !== undefined) {
            this.overallVolume = mixState.overallVolume;
            const slider = document.getElementById('overall-vol');
            if (slider) { slider.value = this.overallVolume; slider.style.setProperty('--vp', `${this.overallVolume * 100}%`); }
            const _inWork = (gameState.pomodoro.active && gameState.pomodoro.phase === 'work')
                || (gameState.freeMode.active && gameState.freeMode.phase === 'work');
            if (this.masterGain && _inWork) {
                this.masterGain.gain.setValueAtTime(this.overallVolume, this.ctx.currentTime);
            }
        }

        for (const [name, config] of Object.entries(mixState)) {
            if (this.sounds[name]) {
                this.sounds[name].active = config.active;
                this.sounds[name].volume = config.volume !== undefined ? config.volume : 0.5;

                const el = document.querySelector(`.sound-item[data-sound="${name}"]`);
                if (el) {
                    if (config.active) el.classList.add('active');
                    else el.classList.remove('active');
                    const volSlider = el.querySelector('.sound-vol');
                    if (volSlider) { volSlider.value = this.sounds[name].volume; volSlider.style.setProperty('--vp', `${this.sounds[name].volume * 100}%`); }
                }

                if (gameState.pomodoro.active && gameState.pomodoro.phase === 'work') {
                    if (config.active) {
                        this.startSound(name);
                    } else {
                        this.stopSound(name);
                    }
                }
            }
        }
    }

    saveToFirebase() {
        if (!gameState.userId) return;
        const mixState = {
            overallVolume: this.overallVolume
        };
        for (const [name, config] of Object.entries(this.sounds)) {
            mixState[name] = { active: config.active, volume: config.volume };
        }
        const updates = {};
        updates[`users/${gameState.userId}/focusMix`] = mixState;
        update(ref(database), updates);
    }

    stopAll({ clearActive = false } = {}) {
        for (const name of Object.keys(this.sounds)) {
            this.stopSound(name);
            if (clearActive) {
                this.sounds[name].active = false;
                const el = document.querySelector(`.sound-item[data-sound="${name}"]`);
                if (el) el.classList.remove('active');
            }
        }
    }
}

// Simple YouTube-based focus player using the IFrame API. Persists per-user
// playback state to `users/{userId}/focusPlayer` so timestamp+link survive sessions.
class FocusYouTubePlayer {
    constructor() {
        this.player = null;
        this.videoId = null;
        this.url = null;
        this.loop = false;
        this.pollInterval = null;
        this.ready = false;
        this.ui = {};
        this.volume = 80;
        this._ytReady = this._ensureApiLoaded();
        this._fading = false;
        this._wavePhase = 0;
        this._waveAnimId = null;
        // Ad detection state
        this._isAdPlaying  = false;
        this._adStartMs    = 0;
        this._loadedAt     = 0;
        this._wasAutoPlay  = false;
    }

    _ensureApiLoaded() {
        if (window.YT && window.YT.Player) return Promise.resolve();
        return new Promise((resolve) => {
            window.onYouTubeIframeAPIReady = () => resolve();
            const s = document.createElement('script');
            s.src = 'https://www.youtube.com/iframe_api';
            document.head.appendChild(s);
        });
    }

    parseVideoId(url) {
        if (!url) return null;
        const m = url.match(/(?:v=|\/videos\/|embed\/|youtu\.be\/|v%3D)([A-Za-z0-9_-]{6,})/i);
        if (m && m[1]) return m[1];
        // fallback: last path chunk
        try { const u = new URL(url); const p = u.pathname.split('/').pop(); return p || null; } catch(e) { return null; }
    }

    async createPlayer() {
        await this._ytReady;
        if (this.player) return;
        const container = document.getElementById('yt-iframe-container');
        if (!container) return;
        const iframeDiv = document.createElement('div');
        iframeDiv.id = 'yt-player-iframe';
        container.appendChild(iframeDiv);
        this._playerReadyPromise = new Promise((resolve) => { this._playerReadyResolver = resolve; });
        this.player = new YT.Player(iframeDiv.id, {
            height: '90', width: '160',
            playerVars: { controls: 0, modestbranding: 1, rel: 0, playsinline: 1 },
            events: {
                onReady: () => { this.ready = true; this.player.setVolume(this.volume); if (this._playerReadyResolver) this._playerReadyResolver(); },
                onStateChange: (e) => {
                    if (e.data === YT.PlayerState.ENDED && this.loop) this.player.playVideo();
                    const isPlaying = e.data === YT.PlayerState.PLAYING;
                    const playIcon = document.getElementById('yt-icon-play');
                    const pauseIcon = document.getElementById('yt-icon-pause');
                    if (playIcon) playIcon.style.display = isPlaying ? 'none' : 'block';
                    if (pauseIcon) pauseIcon.style.display = isPlaying ? 'block' : 'none';
                    if (isPlaying) this._startWaveAnim(); else this._stopWaveAnim();
                }
            }
        });
    }

    async loadUrl(url, startSec = 0, saveToFirebase = true, startPaused = false) {
        const id = this.parseVideoId(url);
        if (!id) return false;
        await this.createPlayer();
        this.videoId = id;
        this.url = url;
        // Reset ad detection for the new video
        this._loadedAt     = Date.now();
        this._isAdPlaying  = false;
        this._wasAutoPlay  = !startPaused;
        const adOverlay = document.getElementById('yt-ad-overlay');
        if (adOverlay) adOverlay.classList.remove('active');
        try {
            if (this._playerReadyPromise) await this._playerReadyPromise;
            if (startPaused) {
                this.player.cueVideoById({ videoId: id, startSeconds: Math.max(0, startSec) });
            } else {
                this.player.loadVideoById({ videoId: id, startSeconds: Math.max(0, startSec) });
                try { this.player.playVideo(); } catch(e) {}
            }
            this._startPoll(); // always run poll so display refreshes immediately
            this.player.setVolume(this.volume);
            this._ensureUiVisible(true);
            if (saveToFirebase && gameState.userId) {
                const updates = {};
                updates[`users/${gameState.userId}/focusPlayer`] = { url: this.url, videoId: this.videoId, timestamp: Math.floor(startSec), loop: this.loop };
                update(ref(database), updates);
            }
            return true;
        } catch (e) {
            console.warn('YT load failed', e);
            return false;
        }
    }

    async resume() {
        await this._ytReady;
        if (!this.player) return;
        this._fading = false;
        try { this.player.playVideo(); this._startPoll(); } catch(e){}
    }

    async pause() {
        if (!this.player) return;
        try { this.player.pauseVideo(); this._stopPoll(); } catch(e){}
    }

    async seekTo(sec) {
        if (!this.player) return;
        try { this.player.seekTo(sec, true); } catch(e){}
    }

    async forward(sec = 10) {
        if (!this.player) return;
        const now = this.player.getCurrentTime() || 0;
        this.seekTo(now + sec);
    }

    async back(sec = 10) {
        if (!this.player) return;
        const now = this.player.getCurrentTime() || 0;
        this.seekTo(Math.max(0, now - sec));
    }

    setLoop(v) {
        this.loop = !!v;
        const btn = document.getElementById('mini-yt-repeat');
        if (btn) btn.classList.toggle('active', this.loop);
        if (gameState.userId) update(ref(database), { [`users/${gameState.userId}/focusPlayer/loop`]: this.loop });
    }

    setVolumePercent(pct) {
        this.volume = Math.max(0, Math.min(100, Math.round(pct)));
        if (this.player && this.ready) this.player.setVolume(this.volume);
        const s = document.getElementById('yt-volume-slider');
        if (s) s.style.setProperty('--vp', `${this.volume}%`);
    }

    async fadeOutAndPause(duration = 1500) {
        if (!this.player || this._fading) return;
        this._fading = true;
        const steps = 12;
        const initial = this.volume;
        const stepTime = duration / steps;
        for (let i = 1; i <= steps; i++) {
            const v = Math.round(initial * (1 - i / steps));
            try { this.player.setVolume(Math.max(0, v)); } catch(e){}
            await new Promise(r => setTimeout(r, stepTime));
        }
        try { this.player.pauseVideo(); } catch(e){}
        this._stopPoll();
        if (this.player) this.player.setVolume(initial);
        this._fading = false;
    }

    async fadeInAndResume(duration = 1500) {
        await this._ytReady;
        if (!this.player) return;
        this._fading = true;
        const target = this.volume;
        try { this.player.setVolume(0); this.player.playVideo(); this._startPoll(); } catch(e){}
        const steps = 12;
        const stepTime = duration / steps;
        for (let i = 1; i <= steps; i++) {
            await new Promise(r => setTimeout(r, stepTime));
            try { this.player.setVolume(Math.round(target * (i / steps))); } catch(e){}
        }
        try { this.player.setVolume(target); } catch(e){}
        this._fading = false;
    }

    _startPoll() {
        if (this.pollInterval) return;
        this.pollInterval = setInterval(() => this._poll(), 500);
    }

    _stopPoll() { if (this.pollInterval) { clearInterval(this.pollInterval); this.pollInterval = null; } }

    _poll() {
        if (!this.player || !this.ready) return;
        try {
            const state = this.player.getPlayerState();
            const isPlaying = state === 1; // YT.PlayerState.PLAYING
            const playIcon = document.getElementById('yt-icon-play');
            const pauseIcon = document.getElementById('yt-icon-pause');
            if (playIcon) playIcon.style.display = isPlaying ? 'none' : 'block';
            if (pauseIcon) pauseIcon.style.display = isPlaying ? 'block' : 'none';
            if (isPlaying) this._startWaveAnim(); else this._stopWaveAnim();

            const dur = this.player.getDuration() || 0;
            const cur = this.player.getCurrentTime() ?? 0;

            // ── Ad detection ──────────────────────────────────────────
            // YouTube keeps state = -1 (UNSTARTED) during pre-roll ads
            // while dur > 0 (video metadata already loaded). When the ad
            // ends the state flips to 1 (PLAYING).
            const now = Date.now();
            const inGrace = now - (this._loadedAt || 0) < 3000;
            if (!inGrace && this._wasAutoPlay) {
                if (state === -1 && dur > 0 && !this._isAdPlaying) {
                    this._setAdMode(true);
                } else if (this._isAdPlaying && state === 1) {
                    this._setAdMode(false);
                    this._wasAutoPlay = false;
                }
                if (this._isAdPlaying && this._adStartMs && now - this._adStartMs > 120000) {
                    this._setAdMode(false);
                    this._wasAutoPlay = false;
                }
            }
            // ──────────────────────────────────────────────────────────
            const slider = document.getElementById('mini-yt-slider');
            const timeEl = document.getElementById('mini-yt-time');
            const titleEl = document.getElementById('mini-yt-title');
            if (slider && dur > 0) slider.value = Math.max(0, Math.min(100, Math.round((cur / dur) * 100)));
            if (timeEl) {
                const curSpan = timeEl.querySelector('.yt-time-cur');
                const durSpan = timeEl.querySelector('.yt-time-dur');
                if (curSpan) curSpan.textContent = formatTime(cur);
                if (durSpan) durSpan.textContent = formatTime(dur);
            }
            // Always draw waveform when not in the rAF animation loop (paused/buffering)
            if (!this._waveAnimId) this._drawWaveform(dur > 0 ? cur / dur : 0);
            if (titleEl) {
                try {
                    const data = this.player.getVideoData();
                    titleEl.textContent = data?.title ? data.title : `YouTube • ${this.videoId}`;
                } catch(e) {
                    titleEl.textContent = `YouTube • ${this.videoId}`;
                }
            }
            // Persist the playback position so the user resumes where they left
            // off next login. This is PRIVATE data nobody else reads, yet every
            // change fans out to every client on the /users listener — so save
            // sparingly: at most once every 15s, and only when the second has
            // actually advanced (the 500ms poll would otherwise double-write).
            // 15s granularity = you resume ≤15s behind, imperceptible for audio.
            if (gameState.userId) {
                const sec = Math.floor(cur);
                const now = Date.now();
                if (sec !== this._lastSavedTs && (!this._lastTsSaveAt || now - this._lastTsSaveAt >= 15000)) {
                    this._lastSavedTs = sec;
                    this._lastTsSaveAt = now;
                    update(ref(database), { [`users/${gameState.userId}/focusPlayer/timestamp`]: sec });
                }
            }
        } catch(e) {}
    }

    _drawWaveform(progress) {
        const canvas = document.getElementById('yt-waveform');
        if (!canvas) return;
        // getBoundingClientRect forces layout reflow — always gives the rendered width
        const W = canvas.getBoundingClientRect().width || canvas.parentElement?.getBoundingClientRect().width || 220;
        const H = 22;
        if (W <= 0) return;
        if (canvas.width !== Math.round(W)) canvas.width = Math.round(W);
        canvas.height = H;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, W, H);
        const p = this._wavePhase;
        const splitX = Math.round(W * (progress || 0));
        const A = 1.8, freq = 0.07, yMid = H / 2;

        // Played portion — animated wiggly green line
        if (splitX > 0) {
            ctx.beginPath();
            for (let x = 0; x <= splitX; x++) {
                const y = yMid + A * Math.sin(x * freq + p);
                x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            }
            ctx.strokeStyle = '#1ed760';
            ctx.lineWidth = 2;
            ctx.lineJoin = 'round';
            ctx.stroke();
        }

        // Unplayed portion — flat static line
        if (splitX < W) {
            ctx.beginPath();
            ctx.moveTo(splitX, yMid);
            ctx.lineTo(W, yMid);
            ctx.strokeStyle = 'rgba(255,255,255,0.2)';
            ctx.lineWidth = 1.5;
            ctx.stroke();
        }
    }

    _startWaveAnim() {
        if (this._waveAnimId) return;
        const draw = () => {
            this._wavePhase = (this._wavePhase + 0.04) % (Math.PI * 4);
            if (this.player && this.ready) {
                try {
                    const dur = this.player.getDuration() || 0;
                    const cur = this.player.getCurrentTime() || 0;
                    this._drawWaveform(dur > 0 ? cur / dur : 0);
                } catch(e) {}
            }
            this._waveAnimId = requestAnimationFrame(draw);
        };
        this._waveAnimId = requestAnimationFrame(draw);
    }

    _stopWaveAnim() {
        if (this._waveAnimId) { cancelAnimationFrame(this._waveAnimId); this._waveAnimId = null; }
        if (this.player && this.ready) {
            try {
                const dur = this.player.getDuration() || 0;
                const cur = this.player.getCurrentTime() || 0;
                this._drawWaveform(dur > 0 ? cur / dur : 0);
            } catch(e) {}
        }
    }

    _setAdMode(isAd) {
        if (isAd === this._isAdPlaying) return;
        this._isAdPlaying = isAd;
        const overlay = document.getElementById('yt-ad-overlay');
        if (!overlay) return;
        if (isAd) {
            this._adStartMs = Date.now();
            try { this.player.mute(); this.player.setVolume(0); } catch(e) {}
            overlay.classList.add('active');
        } else {
            overlay.classList.remove('active');
            try { this.player.unMute(); this.player.setVolume(this.volume); } catch(e) {}
            this._adStartMs = 0;
        }
    }

    _ensureUiVisible(visible) {
        const mini = document.getElementById('mini-yt-player');
        if (!mini) return;
        if (visible) mini.classList.add('active'); else mini.classList.remove('active');
        if (this.videoId) {
            const src = `https://i.ytimg.com/vi/${this.videoId}/mqdefault.jpg`;
            const cover = document.getElementById('mini-yt-cover');
            const ambient = document.getElementById('yt-ambient-img');
            if (cover) cover.src = src;
            if (ambient) ambient.src = src;
        }
    }

    async loadFromProfile(profile) {
        if (!profile || !profile.url) return;
        await this.loadUrl(profile.url, profile.timestamp || 0, false, true);
        if (profile.loop) { this.loop = !!profile.loop; const btn = document.getElementById('mini-yt-repeat'); if (btn) btn.classList.toggle('active', this.loop); }
        if (profile.volume !== undefined) {
            this.setVolumePercent(profile.volume);
            const volSlider = document.getElementById('yt-volume-slider');
            if (volSlider) { volSlider.value = profile.volume; volSlider.style.setProperty('--vp', `${profile.volume}%`); }
        }
        if (gameState.isLockedIn) {
            await this.resume();
        }
    }
}


// Game State
const gameState = {
    currentUser: null,
    userId: null,
    selectedLobby: null,   // 'male' | 'female' | ... – set on lobby screen
    players: {},
    avatarCache: {},
    assets: {
        bg: new Image(),
        shadow: new Image(),
        tables: new Image(),
        race: new Image(),
        coffeeZone:     new Image(),
        coffeeMug:      new Image(),
        coffeeSugar:    new Image(),
        coffeeBadSugar: new Image(),
        laptopBossZone: new Image(),
        bossBg:         new Image(),
        bossGround:     new Image(),
        bossHeart:      new Image(),
        bossHeartDead:  new Image(),
        bossIdle:       new Image(),
        bossAnticipation: new Image(),
        bossAttack:     new Image(),
        bossWeak:       new Image(),
        bossShield:     new Image(),
    },
    sounds: {
        kidnap:                new Audio('Sound/LaptopGrab.mp3'),
        timeBreak:             new Audio('Sound/TimeBreak.mp3'),
        timeReturn:            new Audio('Sound/TimeReturn.mp3'),
        yipee:                 new Audio('Sound/Yipee.mp3'),
        breakAdded:            new Audio('Sound/BreakAdded.mp3'),
        minigameReady:         new Audio('Sound/Minigame_Ready.mp3'),
        minigameButtonPressed: new Audio('Sound/Minigame_ButtonPressed.mp3'),
        minigameCountdown:       new Audio('Sound/Minigame_Racing_Countdown.mp3'),
        minigameCoffeeCountdown: new Audio('Sound/Minigame_Coffee_Countdown.mp3'),
        minigameCoffeeCollect:   new Audio('Sound/Minigame_Coffee_Collect.mp3'),
        minigameCoffeeBad:       new Audio('Sound/Minigame_Coffee_Collect_Bad.mp3'),
        minigameCoffeeTimerClose: new Audio('Sound/Minigame_Coffee_TimerClose.mp3'),
        minigameApplause:        new Audio('Sound/Minigame_Aplause.mp3'),
        // Laptop boss fight sounds
        bossAnticipate:     new Audio('Sound/LaptopMinigame/Laptop_Anticipate.mp3'),
        bossAttackInitiate: new Audio('Sound/LaptopMinigame/Laptop_Attack_Initiate .mp3'),
        bossGrabInitiate:   new Audio('Sound/LaptopMinigame/Laptop_Grab_initiate.mp3'),
        bossGrabSuccess:    new Audio('Sound/LaptopMinigame/Laptop_Grab_Success.mp3'),
        bossWeakIdle:       new Audio('Sound/LaptopMinigame/Laptop_Weak_Idle.mp3'),
        bossWeakInitiate:   new Audio('Sound/LaptopMinigame/Laptop_Weak_Inititate.mp3'),
        bossWeakEnd:        new Audio('Sound/LaptopMinigame/Laptop_Weak_End.mp3'),
        bossHit:            new Audio('Sound/LaptopMinigame/Laptop_Hit.mp3'),
        bossAttackStomp:    new Audio('Sound/LaptopMinigame/Laptop_Attack_Stomp.mp3'),
        playerHitBoss:      new Audio('Sound/LaptopMinigame/Player_Hit.mp3'),
        playerLooseBoss:    new Audio('Sound/LaptopMinigame/Player_Loose.mp3'),
        playerWinBoss:      new Audio('Sound/LaptopMinigame/Player_Win.mp3'),
        bossApplause:       new Audio('Sound/Minigame_Aplause.mp3'),
        crowdCheer:         new Audio('Sound/LaptopMinigame/Crowd_Cheer.mp3'),
        crowdShock:         new Audio('Sound/LaptopMinigame/Crowd_Shock.mp3'),
        prayerCall:              new Audio('Sound/Prayer_CallToPrayer.mp3'),
        inviteSent:              new Audio('Sound/Invite_Sent.mp3'),
        inviteAccepted:          new Audio('Sound/Invite_Accepted.mp3'),
    },
    canvas: null,
    ctx: null,
    camera: { x: 0, y: 0 },
    zoom: 1.0,
    keys: {},
    selectedUser: null,
    positionInitialized: false,
    windParticles: [],
    ambientMotes: [],
    laptops: [],
    activeLaptop: null,
    isLockedIn: false,
    focusAlpha: 0,
    // Animated "انقر للبدء" prompt — fades out from the old laptop then pops/fades
    // in for the next one as you walk past a row.
    promptState: { shownKey: null, shownText: null, shownWeak: false, shownX: 0, shownY: 0, alpha: 0, pop: 0 },
    // Animated laptop cutout in the focus mask — fades out at the old laptop and
    // in at the new one instead of snapping the bright circle across.
    maskLaptopState: { id: null, x: 0, y: 0, alpha: 0 },
    // Animated break-door prompt — same playful fade/pop as the laptop prompt.
    breakDoorPrompt: { shownText: null, alpha: 0, pop: 0 },
    lastTime: 0,
    dtFactor: 1.0,
    dustParticles: [],
    windSpeedMultiplier: 1.0,
    focusFogAlpha: 0.0,
    focusAudioEngine: null,
    activeRaceButton: false,
    isSirajGhost: false,
    activeRaceZone: false,
    raceZonePlayers: [],
    activeCoffeeZone: false,
    coffeeZonePlayers: [],
    activeLaptopBossZone: false,
    laptopBossZonePlayers: [],
    laptopBossButtons: { left: false, right: false, jump: false, jumpPressed: false },
    coffee: {
        session:            null,
        sessionKey:         null,
        activeSessions:     {},
        active:             false,
        localMug:           null,
        returnPoint:        null,
        teleportAnim:       null,
        localResultSent:    false,
        showResultsInGame:  false,
        resultsButtonRect:  null,
        lastMugSync:        0,
        lastSugarSpawn:     0,
        shakeX:             0,
        shakeY:             0,
        shakeDecay:         0,
        catchParticles:     [],
        startTimeScheduled: false,
        readyFallbackTimer: null,
        countdownSoundPlayed: false,
        applausePlayed:     false,
        timerClosePlayed:   false,
        sugarParticles: [],
        _mouseMoveHandler:  null,
        _touchMoveHandler:  null,
    },
    race: {
        session: null,
        sessionKey: null,     // key within minigames/race/sessions/
        activeSessions: {},   // all live sessions keyed by sessionKey
        active: false,
        localCar: null,
        returnPoint: null,
        localResultSent: false,
        finishReturnTimer: null,
        lastSync: 0,
        carVisuals: {},
        camera: { x: 0, y: 0, angle: 0 },
        track: null,
        teleportAnim: null,
        startTimeScheduled: false,
        readyFallbackTimer: null,
        applausePlayed: false,
    },

    // Laptop boss fight state
    laptopBoss: {
        session: null,
        sessionKey: null,
        activeSessions: {},
        active: false,
        teleportAnim: null,
        returnPoint: null,
        local: null,         // local game state — populated when game starts
        showResultsInGame: false,
        resultsButtonRect: null,
        _sirajCleanupTimer: null,
        // Audio nodes for the boss fight (managed by boss audio helpers)
        bossAudio: {
            applauseSource: null,   // BufferSourceNode — looping crowd applause
            applauseGain:   null,   // GainNode for fade/duck control
            weakIdleSource: null,   // BufferSourceNode — looping weak idle hum
            weakIdleGain:   null,   // GainNode
            weakIdleTimer:  null,   // setTimeout id for 1-second startup delay
            duckTimer:      null,   // setTimeout id for duck-recovery ramp
        },
    },

    // Mobile joystick state
    joystick: { active: false, dx: 0, dy: 0, magnitude: 0, sprinting: false },
    // Mobile race d-pad button state
    raceButtons: { forward: false, left: false, right: false, backward: false },
    // Device pixel ratio (set in resizeCanvas)
    dpr: 1,

    // Animation State
    anim: {
        active: false,
        phase: 'none',
        progress: 0,
        laptop: null,
        startPos: { x: 0, y: 0 },
        intermediatePos: { x: 0, y: 0 },
        targetPos: { x: 0, y: 0 }
    },
    // Pomodoro State
    pomodoro: {
        active: false,
        laptopId: null,
        phase: 'none',
        endTime: 0,
        sessionsLeft: 0,
        workDuration: 25,
        breakDuration: 5,
        totalSessions: 1,
        createdAt: 0
    },
    // Shared Pomodoro State
    sharedPomo: {
        phase: 'idle',          // 'idle' | 'gathering' | 'guest-waiting' | 'active'
        isHost: false,
        sessionId: null,        // hostId of the active shared session
        session: null,          // latest session snapshot from Firebase
        activeGroupMembers: [], // uids of group members (kept after Firebase cleanup)
        nearbyPlayers: [],      // players within proximity radius
        nearbyPlayerIds: '',    // stringified ids — used to detect changes cheaply
        pendingInvite: null,    // { fromId, fromName, fromAvatar, sessionId, sentAt }
        agreedEndTime: 0,       // synced endTime set by host, consumed by startPomodoroPhase
        toastInterval: null,
        toastTimeout: null,
        unsubInvite: null,
        unsubSession: null,
        unsubLive: null,
        coopAnim: {
            members: {},        // uid -> { orbitAngle, hammerT, hammering, state, stateTimer }
            emojiFloats: [],    // { wx, wy, emoji, age, maxAge, vy }
            syncBobPhase: 0,
            swapTimer: 0,
        },
        nearbyCoopId: '',       // hostId of detected nearby active coop session
        nearbySoloId: '',       // userId of a nearby solo worker (join-solo flow)
        joinDetails: null,      // cached live session data for join panel
        extCoopAnims: {},       // uid → animMem for remote coop players (external observer view)
        unsubSoloUpgrade: null, // Firebase listener watching for incoming solo-join requests
    },
    freeMode: {
        active: false,
        laptopId: null,
        isShared: false,
        phase: 'idle',           // 'idle' | 'work' | 'break'
        workStartTime: 0,        // ms timestamp when current work block began
        totalWorkMs: 0,          // accumulated work ms before current block
        breakEndTime: 0,
        nextBreakPromptMs: 25 * 60 * 1000,
        breakPromptShown: false,
        breakVotes: {},          // uid → true (shared: who requested break)
        selectedBreakMins: 5,
        workMsAtLastBreak: 0,    // totalWorkMs snapshot when last break started (for 25-min reset)
        _breakEndTimer: null,    // setTimeout id for post-break kidnap delay
        _lastSavedAt: 0,         // last time we wrote totalWorkMs to Firebase
        _createdAt: 0,           // session start timestamp, preserved across periodic saves
        needsResume: false,      // set on login restore; _startFreeModeWork fires on first tick
    },
    prayer: {
        location: null,            // { lat, lon, city, country }
        times: null,               // { Fajr: '05:23', Dhuhr: '12:30', ... }
        adjustments: {},           // { Fajr: 0, Dhuhr: 5, ... } offset in minutes
        nextPrayer: null,          // { key, arabic, timeMs, prevTimeMs }
        lastFetchDate: null,       // 'YYYY-MM-DD'
        isOverlayActive: false,
        pausedRemaining: 0,        // ms left on timer when paused by prayer
        pausedPhase: null,         // 'work' | 'break'
        overlayPrayer: null,       // prayer key that triggered overlay
        overlayStartTime: 0,       // when overlay appeared
        prayerLockMs: 180000,      // 3 min lock (10 s for Siraj)
        triggeredToday: {},        // { Fajr: true, ... } avoid re-triggering same prayer
        lastDayCheck: null,        // date string to reset triggers at midnight
    },
    azkar: {
        active: false,             // overlay open
        type: null,                // 'morning' | 'evening' | 'afterPrayer'
        items: [],                 // the active zikr list (possibly shuffled / custom)
        afterPrayer: false,        // opened from the prayer overlay (post-salah azkar)
        startTime: 0,              // overlay opened at
        minLockMs: 180000,         // 3 min lock before انتهيت enables (5 s for Siraj)
        counts: [],                // remaining count per zikr index
        currentIndex: 0,
        completed: {},             // { morning: 'YYYY-MM-DD', evening: 'YYYY-MM-DD' }
        _completionLoaded: false,  // don't show/hide the button until Firebase completion is known (no flash)
        _btnShown: false,          // current button visibility (drives fade in/out transitions)
        _btnHideTimer: null,
        // saved-state to restore on close
        pausedPomoRemaining: 0,
        pausedPomoPhase: null,
        pausedFreeWorkStart: 0,
        pausedFreeWorkSnap: 0,
        ytWasPlaying: false,
        ytVolumeBefore: 80,
        focusMobileWasActive: false,
        _lastButtonRefresh: 0,
        _lockInterval: null,       // setInterval id ticking the انتهيت lock (rAF-independent)
    },
    // Picture-in-Picture (الوضع المصغر) — always-on-top floating focus window.
    // Renders a player-centred view of the world into a separate surface (a real
    // Document-PiP window when supported, otherwise an in-page floating panel).
    pip: {
        active: false,
        supported: false,          // documentPictureInPicture available?
        mode: null,                // 'window' (Document PiP) | 'video' (Video PiP) | 'fallback'
        win: null,                 // the Document-PiP Window (window mode)
        doc: null,                 // its document
        canvas: null,              // target canvas (in whichever surface)
        ctx: null,                 // its 2D context
        dpr: 1,                    // target device-pixel-ratio
        // Video Picture-in-Picture (Safari/Chrome) — a real OS window via a
        // captured canvas stream. Escapes the browser, draggable across displays.
        video: null,               // hidden <video> consuming the canvas stream
        stream: null,              // MediaStream from srcCanvas.captureStream()
        srcCanvas: null,           // offscreen render target for the video stream
        _videoPrimed: false,       // hidden video pre-built + playing (Safari-ready)
        _videoInterval: 0,         // background-render backstop timer
        rafId: 0,                  // requestAnimationFrame id inside the PiP window
        zoomLevel: 2.4,            // current world zoom (lerped)
        targetZoomLevel: 2.4,      // scroll-to-zoom target
        camera: { x: 0, y: 0 },    // world offset that centres the player
        _camInit: false,           // snap camera on first frame, lerp after
        _opening: false,           // in-flight guard for async openPiPMode
        _closing: false,           // re-entrancy guard for closePiPMode
        _lastFrameAt: 0,           // perf timestamp of last PiP render (stall watchdog)
        popupPollId: null,         // win.setInterval backstop for Safari rAF throttling
        btn: null, blackout: null, fallbackEl: null,
        timerEl: null, taskEl: null,
    },
};

// Preload all sounds so they fire instantly with no lag
gameState.sounds.kidnap.preload                = 'auto';
gameState.sounds.timeBreak.preload             = 'auto';
gameState.sounds.timeReturn.preload            = 'auto';
gameState.sounds.breakAdded.preload            = 'auto';
gameState.sounds.yipee.preload                 = 'auto';
gameState.sounds.minigameReady.preload         = 'auto';
gameState.sounds.minigameButtonPressed.preload = 'auto';
gameState.sounds.minigameCountdown.preload       = 'auto';
gameState.sounds.minigameCoffeeCountdown.preload = 'auto';
gameState.sounds.minigameCoffeeCollect.preload   = 'auto';
gameState.sounds.minigameCoffeeBad.preload       = 'auto';
gameState.sounds.minigameCoffeeTimerClose.preload = 'auto';
gameState.sounds.minigameApplause.preload        = 'auto';
gameState.sounds.bossAnticipate.preload     = 'auto';
gameState.sounds.bossAttackInitiate.preload = 'auto';
gameState.sounds.bossGrabInitiate.preload   = 'auto';
gameState.sounds.bossGrabSuccess.preload    = 'auto';
gameState.sounds.bossWeakIdle.preload       = 'auto';
gameState.sounds.bossWeakInitiate.preload   = 'auto';
gameState.sounds.bossWeakEnd.preload        = 'auto';
gameState.sounds.bossHit.preload            = 'auto';
gameState.sounds.bossAttackStomp.preload    = 'auto';
gameState.sounds.playerHitBoss.preload      = 'auto';
gameState.sounds.playerLooseBoss.preload    = 'auto';
gameState.sounds.playerWinBoss.preload      = 'auto';
gameState.sounds.bossApplause.preload       = 'auto';
gameState.sounds.crowdCheer.preload         = 'auto';
gameState.sounds.crowdShock.preload         = 'auto';
gameState.sounds.prayerCall.preload              = 'auto';
gameState.sounds.inviteSent.preload              = 'auto';
gameState.sounds.inviteAccepted.preload          = 'auto';

// Constants
const COLORS = {
    black: '#000000',
    snow: '#faf9f7',
    raisin: '#262626',
    blue: '#086fb6',
    red: '#e1352e',
    afk: '#f4c82b'
};

const PLAYER_SIZE = 70;
const MOVE_SPEED = 5;
const SPAWN_RADIUS = 100;
const POMODORO_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const RACE_MAX_AGE_MS = 3 * 60 * 1000;

// Asset Base Dimensions
const BASE_BG_WIDTH = 2390;
const BASE_BG_HEIGHT = 1750;
const BASE_TABLE_WIDTH = 1460;
const BASE_TABLE_HEIGHT = 510;

// Visual Scaling (Background/Shadow 50% larger, Table stays at 0.33)
const BG_SCALE = 0.5; // 0.33 * 1.5
const TABLE_SCALE = 0.33;

const BG_WIDTH = BASE_BG_WIDTH * BG_SCALE;
const BG_HEIGHT = BASE_BG_HEIGHT * BG_SCALE;
const TABLE_WIDTH = BASE_TABLE_WIDTH * TABLE_SCALE;
const TABLE_HEIGHT = BASE_TABLE_HEIGHT * TABLE_SCALE;
const ROOM_COUNT = 2;

// Laptop focus-mask tuning (does NOT affect laptop selection, which stays 120px).
// FADE_R = how far the mask senses a laptop; HOLD_FRAMES = how long the mask
// holds its darkening after leaving range before fading, so short gaps between
// adjacent laptops don't flicker the mask out (~0.65s at 60fps).
const LAPTOP_MASK_FADE_R = 150;
const LAPTOP_MASK_HOLD_FRAMES = 40;
const WORLD_HEIGHT = BG_HEIGHT * ROOM_COUNT;
const ROOM_SEAM_Y = BG_HEIGHT / 2;
const BREAK_ROOM_CENTER_Y = BG_HEIGHT;
const DOOR_WIDTH = 260;
const DOOR_HALF_WIDTH = DOOR_WIDTH / 2;
const DOOR_HALF_HEIGHT = 52;
const RACE_ZONE_IMG_W = 160;
const RACE_ZONE_IMG_H = 175;
const RACE_ZONE_CX = 0;
const RACE_ZONE_CY = BREAK_ROOM_CENTER_Y + 120;
const RACE_ZONE_RECT = { x: -65, y: BREAK_ROOM_CENTER_Y + 40, w: 130, h: 148 };
const RACE_BTN_CX = 0;
const RACE_BTN_CY = BREAK_ROOM_CENTER_Y + 192;
const RACE_BTN_R = 26;
const RACE_LAPS = 3;
const RACE_TRACK_SRC = 'Art/RaceTrack Var1.png';
const RACE_TRACK_SCALE = 1;
const RACE_TRACK_GRID = 2;
const RACE_ZONE_OFF = 0;
const RACE_ZONE_SLOW = 1;
const RACE_ZONE_FAST = 2;
const RACE_ZONE_FINISH = 3;
const RACE_CELL_BARRIER = 4;
const RACE_SPAWN_OFFSET_PX = 150;
const RACE_MIN_LAP_MS = 7000;
const RACE_MIN_LAP_DIST = 600;
// Race mode tuning
const RACE_CAR_SCALE = 0.5; // 50% size
// Make cars 75% of the previous (current) speed: 1.5 * 0.75 = 1.125
const RACE_SPEED_FACTOR = 1.125; // 112.5% of baseline, 75% of prior 1.5 tuning

// Coffee catch minigame
const COFFEE_ZONE_IMG_W  = 150;
const COFFEE_ZONE_IMG_H  = 165;
const COFFEE_ZONE_CX     = 280;
const COFFEE_ZONE_CY     = BREAK_ROOM_CENTER_Y + 115;
const COFFEE_ZONE_RECT   = { x: 205, y: BREAK_ROOM_CENTER_Y + 35, w: 150, h: 152 };
const COFFEE_BTN_CX      = 280;
const COFFEE_BTN_CY      = BREAK_ROOM_CENTER_Y + 192;
const COFFEE_BTN_R       = 26;
const COFFEE_MATCH_MS    = 30000;  // 30 s match
const COFFEE_MUG_W       = 82;
const COFFEE_MUG_H       = 92;
const COFFEE_MUG_Y_FRAC  = 0.80;  // mug center Y as fraction of screen H
const COFFEE_SUGAR_W     = 48;
const COFFEE_SUGAR_H     = 48;
const COFFEE_CATCH_HALF  = 52;    // half-width of catch hitbox

// Laptop boss fight minigame — to the left of the race teleporter
const LAPTOP_BOSS_ZONE_IMG_W = 160;
const LAPTOP_BOSS_ZONE_IMG_H = 175;
const LAPTOP_BOSS_ZONE_CX    = -280;
const LAPTOP_BOSS_ZONE_CY    = BREAK_ROOM_CENTER_Y + 120;
const LAPTOP_BOSS_ZONE_RECT  = { x: -345, y: BREAK_ROOM_CENTER_Y + 40, w: 130, h: 148 };
const LAPTOP_BOSS_BTN_CX     = -280;
const LAPTOP_BOSS_BTN_CY     = BREAK_ROOM_CENTER_Y + 192;
const LAPTOP_BOSS_BTN_R      = 26;
// Boss sprite frame metrics (every sheet is 38px tall, 45px wide per frame)
const BOSS_FRAME_W = 45;
const BOSS_FRAME_H = 38;
const BOSS_IDLE_FRAMES         = 3;
const BOSS_ANTICIPATION_FRAMES = 8;
const BOSS_ATTACK_FRAMES       = 10;
const BOSS_WEAK_FRAMES         = 12;
const BOSS_SPRITE_SCALE        = 4;   // 45×38 → 180×152
const BOSS_MAX_HEALTH          = 3;
const PLAYER_BOSS_MAX_HEALTH   = 3;

// World Boundaries (Updated for new BG size)
const BOUNDS = {
    minX: -BG_WIDTH / 2 + PLAYER_SIZE / 2 + 10,
    maxX: BG_WIDTH / 2 - PLAYER_SIZE / 2 - 10,
    minY: -BG_HEIGHT / 2 + PLAYER_SIZE / 2 + 10,
    maxY: -BG_HEIGHT / 2 + WORLD_HEIGHT - PLAYER_SIZE / 2 - 10
};

// Table Box
const TABLE_OFFSET = 40;
const TABLE_BOX = {
    minX: BG_WIDTH / 2 - TABLE_WIDTH - TABLE_OFFSET,
    maxX: BG_WIDTH / 2 - TABLE_OFFSET,
    minY: -TABLE_HEIGHT / 2,
    maxY: TABLE_HEIGHT / 2
};

// Camera & Wind Settings
const CAMERA_SMOOTHING = 0.1;
const POSITION_LERP_SPEED = 0.22;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.0;
const WIND_PARTICLE_COUNT = 30;      // desktop
const WIND_PARTICLE_COUNT_MOBILE = 10; // mobile (performance)

// Easing Functions
const easeOutExpo = (x) => x === 1 ? 1 : 1 - Math.pow(2, -10 * x);
const easeOutBack = (x) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};
// JUICE EXPERIMENT helpers (used by the login entrance sequence below).
const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3);
const easeOutBounce = (x) => {
    const n1 = 7.5625, d1 = 2.75;
    if (x < 1 / d1)        return n1 * x * x;
    else if (x < 2 / d1)   return n1 * (x -= 1.5 / d1) * x + 0.75;
    else if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
    else                   return n1 * (x -= 2.625 / d1) * x + 0.984375;
};

function isBreakActive() {
    return (gameState.pomodoro.active && gameState.pomodoro.phase === 'break')
        || (gameState.freeMode.active && gameState.freeMode.phase === 'break');
}

// True while the LOCAL user is in an active work phase (solo/shared pomo or free
// mode). Used to suppress other players' distracting working-bounce animation
// while I'm trying to focus — I only see their bounce when I'm idle / on break.
function localInWorkPhase() {
    return (gameState.pomodoro.active && gameState.pomodoro.phase === 'work')
        || (gameState.freeMode.active && gameState.freeMode.phase === 'work');
}

// True while any break minigame (race / coffee / laptop-boss) is running, including
// its lobby/teleport phases.
function isMinigameActive() {
    return !!(gameState.race.active || gameState.coffee.active || gameState.laptopBoss.active);
}

// Force-exit whatever minigame is running (used when prayer time arrives — the athan
// takes priority, so we pull the player straight back out to the break room).
function exitAnyMinigame() {
    if (gameState.laptopBoss.active) returnFromLaptopBoss(true);
    if (gameState.coffee.active)     returnFromCoffee(true);
    if (gameState.race.active)       returnFromRace(true);
}

function serverNow() {
    return Date.now() + (gameState.serverTimeOffset || 0);
}

function ensureEntityRenderPos(entity) {
    if (entity.renderX === undefined) {
        entity.renderX = entity.x;
        entity.renderY = entity.y;
    }
}

function getPositionLerpFactor(dist) {
    const catchUpSpeed = Math.min(0.5, POSITION_LERP_SPEED + dist * 0.0018);
    return 1 - Math.pow(1 - catchUpSpeed, gameState.dtFactor);
}

function lerpEntityRenderTowardTarget(entity) {
    ensureEntityRenderPos(entity);
    const dx = entity.x - entity.renderX;
    const dy = entity.y - entity.renderY;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.35) {
        entity.renderX = entity.x;
        entity.renderY = entity.y;
        return false;
    }
    const t = getPositionLerpFactor(dist);
    entity.renderX += dx * t;
    entity.renderY += dy * t;
    return true;
}

function syncEntityRenderToTarget(entity) {
    ensureEntityRenderPos(entity);
    entity.renderX = entity.x;
    entity.renderY = entity.y;
}

// ---------------------------------------------------------------------------
// Remote-player snapshot interpolation
// ---------------------------------------------------------------------------
// Positions arrive ~11×/sec (WebSocket) plus the occasional Firebase write.
// Easing toward each one and stopping makes movement "step" (worst at sprint
// speed). Instead we buffer the last ~1s of samples and render each remote
// player NET_RENDER_DELAY ms in the past, gliding at constant velocity between
// the two samples that bracket that render time. Result: smooth motion even at
// a low, cheap send rate. When the buffer starves we briefly extrapolate along
// the last velocity (only while the player is still moving), then clamp.
const NET_RENDER_DELAY = 140; // ms behind real time (≈1.5 send intervals)
const NET_MAX_EXTRAP   = 180; // ms cap on extrapolation when starved (TCP bursts/delays)
const NET_BUF_MAX_AGE  = 1200; // ms of history to retain

const NET_IDLE_GAP = 250; // ms of silence after which a stream counts as "resumed"

function pushNetSample(player, x, y) {
    const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    if (player.renderX === undefined) { player.renderX = x; player.renderY = y; }
    if (!player._netBuf) player._netBuf = [];
    const buf = player._netBuf;
    const last = buf[buf.length - 1];
    // Re-anchor when the stream resumed after a gap (idle) OR after the buffer
    // STARVED (the relay is a WebSocket over TCP, so a lost packet really means a
    // delayed burst — meanwhile the avatar ran past the last sample and clamped).
    // Re-anchoring at the CURRENT render position, timestamped one render-delay in
    // the past, makes the glide resume smoothly from wherever the avatar actually
    // is — no dead time, and crucially no forward JUMP when the burst lands (the
    // "snapping" users saw with a laggy friend, in or out of a session).
    if (!last || now - last.t > NET_IDLE_GAP || player._netStarved) {
        buf.length = 0;
        buf.push({ t: now - NET_RENDER_DELAY, x: player.renderX, y: player.renderY });
        player._netStarved = false;
    } else if (last.x === x && last.y === y) {
        return; // not idle and no movement → no new sample
    }
    buf.push({ t: now, x, y });
    while (buf.length > 2 && now - buf[0].t > NET_BUF_MAX_AGE) buf.shift();
}

// Sets entity.renderX/renderY from the buffer. Returns false if no buffer yet
// (caller falls back to the plain lerp).
function interpolateRemoteFromBuffer(entity) {
    const buf = entity._netBuf;
    if (!buf || !buf.length) return false;
    const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    const renderT = now - NET_RENDER_DELAY;
    if (buf.length === 1 || renderT <= buf[0].t) {
        entity.renderX = buf[0].x; entity.renderY = buf[0].y; return true;
    }
    for (let i = 0; i < buf.length - 1; i++) {
        const a = buf[i], b = buf[i + 1];
        if (renderT >= a.t && renderT <= b.t) {
            const span = b.t - a.t || 1;
            const f = (renderT - a.t) / span;
            entity.renderX = a.x + (b.x - a.x) * f;
            entity.renderY = a.y + (b.y - a.y) * f;
            return true;
        }
    }
    // renderT is past the newest sample (buffer starved this frame).
    const b = buf[buf.length - 1];
    if (!entity.isMoving) { entity.renderX = b.x; entity.renderY = b.y; return true; }
    // Still moving but out of buffer → extrapolate along the last velocity, and flag
    // the starve so the NEXT incoming sample re-anchors smoothly instead of letting
    // interpolation jump the avatar forward to catch up.
    entity._netStarved = true;
    const a = buf[buf.length - 2];
    const span = b.t - a.t || 1;
    const ahead = Math.min(renderT - b.t, NET_MAX_EXTRAP);
    entity.renderX = b.x + ((b.x - a.x) / span) * ahead;
    entity.renderY = b.y + ((b.y - a.y) / span) * ahead;
    return true;
}

function setEntityTarget(entity, x, y) {
    entity.x = x;
    entity.y = y;
}

function teleportEntity(entity, x, y) {
    setEntityTarget(entity, x, y);
    entity.smoothMove = true;
}

function getPlayerRenderPos(player) {
    ensureEntityRenderPos(player);
    return { x: player.renderX, y: player.renderY };
}

function updatePlayerRenderPositions() {
    const localPlayer = gameState.players[gameState.userId];
    for (const player of Object.values(gameState.players)) {
        const isLocal = player === localPlayer;
        if (isLocal) {
            if (player.smoothMove) {
                if (!lerpEntityRenderTowardTarget(player)) {
                    player.smoothMove = false;
                }
            } else {
                syncEntityRenderToTarget(player);
            }
            continue;
        }
        // Remote players: smooth snapshot interpolation from the position buffer
        // (fed by both the WebSocket relay and Firebase). Fall back to the plain
        // catch-up lerp until the first sample arrives.
        if (!interpolateRemoteFromBuffer(player)) {
            lerpEntityRenderTowardTarget(player);
        }
    }
}

function lerpAngle(from, to, t) {
    let delta = to - from;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    return from + delta * t;
}

function updateRaceCarVisuals() {
    const session = gameState.race.session;
    if (!session) {
        gameState.race.carVisuals = {};
        return;
    }

    const targets = { ...(session.cars || {}) };
    if (gameState.race.localCar) {
        targets[gameState.userId] = gameState.race.localCar;
    }

    const activeIds = new Set(Object.keys(targets));
    for (const userId of Object.keys(gameState.race.carVisuals)) {
        if (!activeIds.has(userId)) delete gameState.race.carVisuals[userId];
    }

    for (const [userId, car] of Object.entries(targets)) {
        if (!car) continue;
        const isLocal = userId === gameState.userId;
        let visual = gameState.race.carVisuals[userId];
        if (!visual) {
            gameState.race.carVisuals[userId] = {
                x: car.x,
                y: car.y,
                angle: car.angle || 0
            };
            continue;
        }

        if (isLocal) {
            visual.x = car.x;
            visual.y = car.y;
            visual.angle = car.angle || 0;
            continue;
        }

        const dx = car.x - visual.x;
        const dy = car.y - visual.y;
        const dist = Math.hypot(dx, dy);
        const t = getPositionLerpFactor(dist);
        visual.x += dx * t;
        visual.y += dy * t;
        visual.angle = lerpAngle(visual.angle, car.angle || 0, t);
    }
}

function getRaceCarDrawState(userId, car) {
    const visual = gameState.race.carVisuals[userId];
    if (!visual) return car;
    return { ...car, x: visual.x, y: visual.y, angle: visual.angle };
}

function loadRaceTrackAsset() {
    const img = new Image();
    img.src = RACE_TRACK_SRC;
    img.onload = () => {
        const width = img.naturalWidth;
        const height = img.naturalHeight;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        gameState.race.track = buildRaceTrackFromImageData(ctx.getImageData(0, 0, width, height).data, width, height, img);
    };
    img.onerror = () => {
        console.error('Failed to load race track image:', RACE_TRACK_SRC);
    };
}

function isRaceTrackReady() {
    return !!(gameState.race.track && gameState.race.track.zones && gameState.race.track.image);
}

function sampleImageCell(data, width, height, gridSize, gx, gy) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    let count = 0;
    for (let sy = 0; sy < gridSize; sy++) {
        for (let sx = 0; sx < gridSize; sx++) {
            const px = Math.min(width - 1, gx * gridSize + sx);
            const py = Math.min(height - 1, gy * gridSize + sy);
            const i = (py * width + px) * 4;
            r += data[i];
            g += data[i + 1];
            b += data[i + 2];
            a += data[i + 3];
            count++;
        }
    }
    return classifyRacePixel(r / count, g / count, b / count, a / count);
}

function isCheckeredPixel(data, width, px, py) {
    let dark = 0;
    let light = 0;
    for (let dx = -5; dx <= 5; dx++) {
        const x = Math.max(0, Math.min(width - 1, px + dx));
        const i = (py * width + x) * 4;
        const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
        if (lum < 85) dark++;
        if (lum > 185) light++;
    }
    return dark >= 2 && light >= 2;
}

function classifyRacePixel(r, g, b, a) {
    if (a < 80) return RACE_ZONE_OFF;
    const lum = (r + g + b) / 3;

    if (g > r + 12 && g > 65 && b < g - 5) return RACE_ZONE_OFF;
    if (r > 145 && g < 105 && b < 105 && r > g + 35) return RACE_CELL_BARRIER;
    if (lum > 210 && r > 175 && g > 175) return RACE_CELL_BARRIER;
    if (r > 75 && r < 168 && g > 42 && g < 128 && b < 100 && r > b + 15) return RACE_ZONE_SLOW;
    if (r >= 46 && r <= 118 && g >= 46 && g <= 118 && b >= 46 && b <= 118) return 2;
    return RACE_ZONE_OFF;
}

function findFinishLineCells(data, width, height, gridSize, gridW, gridH, raw) {
    const cells = [];
    // Expand the finish detection band so the finish zone covers the full track
    const yStart = Math.floor(height * 0.80);
    const xStart = 0;
    const xEnd = width;

    for (let gy = Math.floor(yStart / gridSize); gy < gridH; gy++) {
        for (let gx = Math.floor(xStart / gridSize); gx < Math.ceil(xEnd / gridSize); gx++) {
            const idx = gy * gridW + gx;
            const px = gx * gridSize + gridSize / 2;
            const py = gy * gridSize + gridSize / 2;
            const isRoad = raw[idx] === 2;
            const isCheckered = isCheckeredPixel(data, width, px, py);
            if (isRoad || isCheckered) {
                cells.push({ gx, gy, px, py });
            }
        }
    }
    return cells;
}

function buildRaceTrackFromImageData(data, width, height, image) {
    const gridSize = RACE_TRACK_GRID;
    const gridW = Math.ceil(width / gridSize);
    const gridH = Math.ceil(height / gridSize);
    const raw = new Uint8Array(gridW * gridH);

    for (let gy = 0; gy < gridH; gy++) {
        for (let gx = 0; gx < gridW; gx++) {
            raw[gy * gridW + gx] = sampleImageCell(data, width, height, gridSize, gx, gy);
        }
    }

    const finishCells = findFinishLineCells(data, width, height, gridSize, gridW, gridH, raw);
    let finishSeeds = finishCells;
    if (!finishSeeds.length) {
        const fallbackPx = width * 0.5;
        const fallbackPy = height * 0.915;
        finishSeeds = [{
            gx: Math.floor(fallbackPx / gridSize),
            gy: Math.floor(fallbackPy / gridSize),
            px: fallbackPx,
            py: fallbackPy
        }];
    }

    const road = new Uint8Array(gridW * gridH);
    const queue = [];
    const push = (gx, gy) => {
        if (gx < 0 || gy < 0 || gx >= gridW || gy >= gridH) return;
        const idx = gy * gridW + gx;
        if (road[idx]) return;
        if (raw[idx] === RACE_CELL_BARRIER || raw[idx] === RACE_ZONE_OFF) return;
        if (raw[idx] !== 2) return;
        road[idx] = 1;
        queue.push(idx);
    };

    finishSeeds.forEach(({ gx, gy }) => {
        push(gx, gy);
        push(gx + 1, gy);
        push(gx - 1, gy);
        push(gx, gy + 1);
        push(gx, gy - 1);
    });
    for (let head = 0; head < queue.length; head++) {
        const idx = queue[head];
        const gx = idx % gridW;
        const gy = Math.floor(idx / gridW);
        push(gx + 1, gy);
        push(gx - 1, gy);
        push(gx, gy + 1);
        push(gx, gy - 1);
    }

    const finishMask = new Uint8Array(gridW * gridH);
    finishCells.forEach(({ gx, gy }) => {
        const idx = gy * gridW + gx;
        finishMask[idx] = 1;
    });

    const zones = new Uint8Array(gridW * gridH);
    for (let i = 0; i < raw.length; i++) {
        if (finishMask[i]) zones[i] = RACE_ZONE_FINISH;
        else if (road[i]) zones[i] = RACE_ZONE_FAST;
        else if (raw[i] === RACE_ZONE_SLOW) zones[i] = RACE_ZONE_SLOW;
        else zones[i] = RACE_ZONE_OFF;
    }

    let finishPx = 0;
    let finishPy = 0;
    finishSeeds.forEach(({ px, py }) => {
        finishPx += px;
        finishPy += py;
    });
    const finishCenterX = finishPx / finishSeeds.length;
    const finishCenterY = finishPy / finishSeeds.length;
    // Default start angle: point left (so cars face left at spawn)
    const startAngle = Math.PI;
    // Place the spawn point a fixed offset along the start angle so cars spawn on the road
    const spawnPx = finishCenterX - Math.cos(startAngle) * RACE_SPAWN_OFFSET_PX;
    // Move spawn 200px upward so cars sit fully on the road
    const spawnPy = finishCenterY - Math.sin(startAngle) * RACE_SPAWN_OFFSET_PX - 200;

    const track = {
        image,
        width,
        height,
        scale: RACE_TRACK_SCALE,
        gridSize,
        gridW,
        gridH,
        zones,
        ready: true,
        startWorld: racePixelToWorld(spawnPx, spawnPy, width, height, RACE_TRACK_SCALE, startAngle)
    };
    gameState.race.track = track;
    return track;
}

function racePixelToWorld(px, py, width, height, scale, angle) {
    return {
        x: (px - width / 2) * scale,
        y: (py - height / 2) * scale,
        angle
    };
}

function worldToRaceGrid(wx, wy) {
    const track = gameState.race.track;
    if (!track) return null;
    const px = wx / track.scale + track.width / 2;
    const py = wy / track.scale + track.height / 2;
    const gx = Math.floor(px / track.gridSize);
    const gy = Math.floor(py / track.gridSize);
    if (gx < 0 || gy < 0 || gx >= track.gridW || gy >= track.gridH) return null;
    return { gx, gy, idx: gy * track.gridW + gx };
}

function getRaceZoneAtWorld(wx, wy) {
    const grid = worldToRaceGrid(wx, wy);
    if (!grid) return RACE_ZONE_OFF;
    return gameState.race.track.zones[grid.idx];
}

function getRaceSurfaceMultiplier(zone) {
    if (zone === RACE_ZONE_FAST || zone === RACE_ZONE_FINISH) return 1;
    if (zone === RACE_ZONE_SLOW) return 0.88;
    return 0.72;
}

function clampCarToRaceBounds(car) {
    const track = gameState.race.track;
    if (!track) return;
    const halfW = (track.width * track.scale) / 2 - 36;
    const halfH = (track.height * track.scale) / 2 - 36;
    car.x = Math.max(-halfW, Math.min(halfW, car.x));
    car.y = Math.max(-halfH, Math.min(halfH, car.y));
}

function updateRaceCamera() {
    const car = gameState.race.localCar;
    if (!car) return;
    const visual = gameState.race.carVisuals[gameState.userId];
    const cx = visual ? visual.x : car.x;
    const cy = visual ? visual.y : car.y;
    const targetX = -cx;
    const targetY = -cy;
    const lerpFactor = 1 - Math.pow(1 - CAMERA_SMOOTHING, gameState.dtFactor);
    gameState.race.camera.x += (targetX - gameState.race.camera.x) * lerpFactor;
    gameState.race.camera.y += (targetY - gameState.race.camera.y) * lerpFactor;

    // Mobile: rotate camera to follow car heading so car always drives "upward"
    if (isMobile()) {
        const carAngle = visual ? visual.angle : car.angle;
        // Target angle makes the car appear to drive toward the top of the screen
        const targetAngle = -(carAngle + Math.PI / 2);
        // Shortest-path angle lerp (handles wraparound)
        let diff = targetAngle - gameState.race.camera.angle;
        while (diff > Math.PI)  diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        gameState.race.camera.angle += diff * Math.min(lerpFactor * 1.4, 1);
    }
}

function getCurrentTaskText() {
    const taskInput = document.getElementById('current-task-input');
    if (taskInput && taskInput.value.trim()) return taskInput.value.trim();
    const player = gameState.players[gameState.userId];
    return (player && player.currentTask ? player.currentTask : '').trim();
}

function formatTime(sec) {
    sec = Math.floor(sec || 0);
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// Tab-title countdown: while in a session, show the remaining work/break time in
// the browser tab so a backgrounded tab still surfaces the timer. Restores the
// original title when no session is running.
// Driven by a setInterval (see startTabTitleTicker) rather than the rAF game loop,
// because the browser pauses requestAnimationFrame in hidden tabs — setInterval
// keeps ticking, so the countdown stays live when the tab is in the background.
const _BASE_DOC_TITLE = (typeof document !== 'undefined' && document.title) || 'مدونة ستوديو';
let _lastTabTitle = '';
let _tabTitleTicker = null;
function startTabTitleTicker() {
    if (_tabTitleTicker) return;
    updateTabTitle();
    _tabTitleTicker = setInterval(updateTabTitle, 1000);
}
function updateTabTitle() {
    const now = Date.now();
    let title = _BASE_DOC_TITLE;
    const pomo = gameState.pomodoro;
    const fm   = gameState.freeMode;
    if (pomo.active && (pomo.phase === 'work' || pomo.phase === 'break') && pomo.endTime) {
        const remaining = Math.max(0, pomo.endTime - now);
        title = `${formatTime(remaining / 1000)} · ${pomo.phase === 'work' ? 'عمل' : 'راحة'}`;
    } else if (fm.active && fm.phase === 'work') {
        const elapsedMs = fm.totalWorkMs + (fm.workStartTime > 0 ? (now - fm.workStartTime) : 0);
        title = `${formatTime(elapsedMs / 1000)} · عمل`;
    } else if (fm.active && fm.phase === 'break' && fm.breakEndTime) {
        const remaining = Math.max(0, fm.breakEndTime - now);
        title = `${formatTime(remaining / 1000)} · راحة`;
    }

    if (title !== _lastTabTitle) {
        _lastTabTitle = title;
        document.title = title;
    }
}

// Countdown like "1:23:45" (h:mm:ss) when >= 1h, else "23:45" (mm:ss).
function formatPrayerCountdown(ms) {
    let sec = Math.max(0, Math.floor((ms || 0) / 1000));
    const h = Math.floor(sec / 3600); sec -= h * 3600;
    const m = Math.floor(sec / 60);   const s = sec % 60;
    const pad = (n) => n.toString().padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function formatDurationArabic(totalMins) {
    totalMins = Math.max(0, Math.floor(totalMins));
    if (totalMins < 60) return `${totalMins} دقيقة`;
    const hours = Math.floor(totalMins / 60);
    const mins  = totalMins % 60;
    const hourStr = hours === 1 ? 'ساعة' : hours === 2 ? 'ساعتان' : `${hours} ساعات`;
    return mins === 0 ? hourStr : `${hourStr} و${mins} دقيقة`;
}

function clearLocalPomodoroUi() {
    const largeTimer = document.getElementById('pomodoro-large-timer');
    const smallTimer = document.getElementById('pomodoro-small-timer');
    if (largeTimer) largeTimer.classList.add('hidden');
    if (smallTimer) smallTimer.classList.add('hidden');
    const panel = document.getElementById('focus-sounds-panel');
    if (panel) panel.classList.remove('active');
    const taskPanel = document.getElementById('current-task-panel');
    if (taskPanel) taskPanel.classList.remove('active');
    const taskInput = document.getElementById('current-task-input');
    if (taskInput) taskInput.blur();
    setMobileFocusMode(false);
}

function getPomodoroStartedAt(state) {
    if (!state) return 0;
    if (state.createdAt) return state.createdAt;
    if (!state.endTime) return 0;

    const durationMins = state.phase === 'break' ? state.breakDuration : state.workDuration;
    return durationMins ? state.endTime - durationMins * 60000 : 0;
}

function shouldExpirePomodoroAfterCurrentTimer(state) {
    const startedAt = getPomodoroStartedAt(state);
    return startedAt && Date.now() - startedAt > POMODORO_MAX_AGE_MS;
}

function clearPomodoroSession(laptopId) {
    if (laptopId === null || laptopId === undefined) return;
    update(ref(database), { [lobbyPath(`pomodoro/${laptopId}`)]: null });
}

function cleanupStalePomodoroState(laptopId, state) {
    if (!state || state.mode === 'free') return false; // free mode has its own 1-hour expiry
    if (!shouldExpirePomodoroAfterCurrentTimer(state)) return false;

    const timerFinished = state.phase === 'wait' || !state.endTime || Date.now() >= state.endTime;
    if (timerFinished) {
        clearPomodoroSession(laptopId);
        if (state.claimedBy === gameState.userId) {
            gameState.pomodoro.active = false;
            gameState.pomodoro.laptopId = null;
            gameState.pomodoro.phase = 'none';
            gameState.isLockedIn = false;
            clearLocalPomodoroUi();
            if (gameState.focusAudioEngine) gameState.focusAudioEngine.stopAll();
        }
        return true;
    }

    return false;
}

function cleanupAbandonedPomoSessions(pomoData) {
    const THIRTY_MINS        = 30 * 60 * 1000;
    const TWO_HOURS          = 2 * 60 * 60 * 1000;
    const FOUR_HOURS         = 4 * 60 * 60 * 1000;
    const FREE_MODE_EXPIRY_MS = 60 * 60 * 1000; // 1 hour for free mode sessions
    const now = Date.now();

    const uidsToCheck = new Set();
    for (const state of Object.values(pomoData)) {
        if (state?.claimedBy && state.claimedBy !== gameState.userId) {
            uidsToCheck.add(state.claimedBy);
        }
    }
    if (uidsToCheck.size === 0) return;

    const uidChecks = [...uidsToCheck].map(uid =>
        get(ref(database, `users/${uid}/activeInGame`))
            .then(snap => ({ uid, online: snap.val() === true }))
            .catch(() => ({ uid, online: false }))
    );

    Promise.all(uidChecks).then(results => {
        const offlineUids = new Set(results.filter(r => !r.online).map(r => r.uid));
        if (offlineUids.size === 0) return;

        const updates = {};
        for (const [laptopId, state] of Object.entries(pomoData)) {
            if (!state?.claimedBy || !offlineUids.has(state.claimedBy)) continue;

            // Free mode sessions: expire after 1 hour away
            if (state.mode === 'free') {
                const savedAt = state.savedAt || state.createdAt || 0;
                if (savedAt && now - savedAt > FREE_MODE_EXPIRY_MS) {
                    // Stash a reclaimable snapshot (parity with pomo below) instead of
                    // silently deleting — so a free-mode user whose onDisconnect never
                    // landed can still reclaim their accumulated work within 4 hours.
                    updates[`users/${state.claimedBy}/lastPomoSession`] = {
                        mode: 'free', laptopId: parseInt(laptopId),
                        claimedBy: state.claimedBy,
                        totalWorkMs: state.totalWorkMs || 0,
                        createdAt: state.createdAt || savedAt,
                        abandonedAt: now,
                    };
                    updates[lobbyPath(`pomodoro/${laptopId}`)] = null;
                }
                continue;
            }

            const endTime   = state.endTime  || 0;
            const createdAt = state.createdAt || 0;
            // Free the device if: timer expired 30+ mins ago, OR session started 2+ hours ago
            const isExpired = endTime   > 0 && now - endTime   > THIRTY_MINS;
            const isVeryOld = createdAt > 0 && now - createdAt > TWO_HOURS;
            if (!isExpired && !isVeryOld) continue;

            // Preserve progress so the user can reclaim on next login (valid for 4 hours)
            updates[`users/${state.claimedBy}/lastPomoSession`] = {
                ...state, abandonedAt: now, laptopId: parseInt(laptopId)
            };
            updates[lobbyPath(`pomodoro/${laptopId}`)] = null;
        }
        if (Object.keys(updates).length > 0) update(ref(database), updates);
    }).catch(() => {});
}

function getPomodoroEntry(data, laptopId) {
    if (!data) return null;
    return data[laptopId] ?? data[String(laptopId)] ?? null;
}

function clearLaptopPomodoroState(laptop) {
    laptop.claimedBy = null;
    laptop.endTime = 0;
    laptop.phase = 'none';
}

function applyPomodoroStateToLaptop(laptop, state) {
    laptop.claimedBy = state.claimedBy || null;
    laptop.endTime = state.endTime || 0;
    laptop.phase = state.phase || 'none';
    laptop.mode = state.mode || null;
    laptop.workDuration = state.workDuration;
    laptop.breakDuration = state.breakDuration;
    laptop.sessionsLeft = state.sessionsLeft;
    laptop.totalSessions = state.totalSessions;
}

function syncLaptopsFromPomodoro(data) {
    gameState.laptops.forEach(laptop => {
        const state = getPomodoroEntry(data, laptop.id);
        if (state && typeof state === 'object' && state.claimedBy) {
            if (cleanupStalePomodoroState(laptop.id, state)) {
                clearLaptopPomodoroState(laptop);
                return;
            }
            applyPomodoroStateToLaptop(laptop, state);
        } else {
            clearLaptopPomodoroState(laptop);
        }
    });
}

// ── Session disconnect / reclaim (solo pomodoro & free mode) ─────────────────
// On ANY disconnect we (a) free the laptop immediately so others never see a
// ghost (claimed-but-empty) laptop, and (b) stash the session under
// users/{uid}/lastPomoSession so the user can reclaim it within 4h on next login
// (their old laptop if it's free, otherwise a random free one). Shared pomo has
// its own host-promotion path and is intentionally excluded here.
const RECLAIM_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 hours

function _sessionIsSolo() {
    // Shared pomo: guests share the host's laptop; the host uses live-doc promotion.
    return gameState.sharedPomo.phase !== 'active';
}

function _activeSessionLaptopId() {
    if (gameState.freeMode.active) return gameState.freeMode.laptopId;
    if (gameState.pomodoro.active) return gameState.pomodoro.laptopId;
    return null;
}

function _pomoDocFromState() {
    const p = gameState.pomodoro;
    return {
        claimedBy:    gameState.userId,
        phase:        p.phase,
        endTime:      p.endTime || 0,
        workDuration: p.workDuration,
        breakDuration: p.breakDuration || 5,
        sessionsLeft:  p.sessionsLeft,
        totalSessions: p.totalSessions || p.sessionsLeft || 1,
        createdAt:     p.createdAt || Date.now(),
    };
}

function _buildReclaimSnapshot() {
    const lapId = _activeSessionLaptopId();
    if (lapId === null || lapId === undefined) return null;
    if (gameState.freeMode.active) {
        const fm = gameState.freeMode;
        let totalMs = fm.totalWorkMs || 0;
        if (fm.phase === 'work' && fm.workStartTime > 0) totalMs += Date.now() - fm.workStartTime;
        return {
            mode: 'free', laptopId: lapId, claimedBy: gameState.userId,
            totalWorkMs: totalMs, createdAt: fm._createdAt || Date.now(),
        };
    }
    const p = gameState.pomodoro;
    return {
        mode: 'pomo', laptopId: lapId, claimedBy: gameState.userId,
        phase: p.phase, endTime: p.endTime || 0,
        workDuration: p.workDuration, breakDuration: p.breakDuration || 5,
        sessionsLeft: p.sessionsLeft, totalSessions: p.totalSessions || p.sessionsLeft || 1,
        createdAt: p.createdAt || Date.now(),
    };
}

// Keep a fresh (NOT-yet-abandoned) snapshot in Firebase while the session is live
// so a sudden disconnect only needs to stamp `abandonedAt` server-side — no
// read-race when the reloaded page tries to reclaim.
function persistReclaimSnapshot() {
    if (gameState.isSirajGhost || !_sessionIsSolo()) return;
    const snap = _buildReclaimSnapshot();
    if (!snap) return;
    snap.abandonedAt = null; // live, not abandoned
    update(ref(database), { [`users/${gameState.userId}/lastPomoSession`]: snap });
}

// Arm the disconnect handlers: free the laptop + stamp `abandonedAt` on the stash.
function armSessionDisconnect() {
    if (gameState.isSirajGhost || !_sessionIsSolo()) return;
    const lapId = _activeSessionLaptopId();
    if (lapId === null || lapId === undefined) return;
    // If we relocated, cancel the previous laptop's remove so a later disconnect
    // doesn't wipe a doc that now belongs to someone else.
    const prev = gameState._armedDisconnectLaptopId;
    if (prev !== null && prev !== undefined && prev !== lapId) {
        onDisconnect(ref(database, lobbyPath(`pomodoro/${prev}`))).cancel();
    }
    gameState._armedDisconnectLaptopId = lapId;
    onDisconnect(ref(database, lobbyPath(`pomodoro/${lapId}`))).remove();
    onDisconnect(ref(database, `users/${gameState.userId}/lastPomoSession/abandonedAt`)).set({ '.sv': 'timestamp' });
}

// Persist + arm together. Call on every session state change (start, phase flip,
// periodic free-mode save) so the stash and disconnect handlers stay current.
function trackSessionForReclaim() {
    persistReclaimSnapshot();
    armSessionDisconnect();
}

// Cancel the disconnect handlers on a clean exit, optionally wiping the stash.
function cancelSessionDisconnect(clearStash) {
    if (gameState.isSirajGhost) return;
    const lapId = gameState._armedDisconnectLaptopId;
    if (lapId !== null && lapId !== undefined) {
        onDisconnect(ref(database, lobbyPath(`pomodoro/${lapId}`))).cancel();
    }
    onDisconnect(ref(database, `users/${gameState.userId}/lastPomoSession/abandonedAt`)).cancel();
    gameState._armedDisconnectLaptopId = null;
    if (clearStash) update(ref(database), { [`users/${gameState.userId}/lastPomoSession`]: null });
}

// Move the live solo session onto a different (free) laptop and sync position so
// every client sees the user seated correctly. Used when the old laptop was
// claimed by someone else during a network dropout.
function _relocateActiveSession(laptop) {
    const lapId = laptop.id;
    if (gameState.freeMode.active) {
        gameState.freeMode.laptopId = lapId;
    } else {
        gameState.pomodoro.laptopId = lapId;
    }
    laptop.claimedBy = gameState.userId;
    if (gameState.freeMode.active) {
        saveFreeModStateToFirebase();   // writes doc + persists snapshot + arms
    } else {
        update(ref(database), { [lobbyPath(`pomodoro/${lapId}`)]: _pomoDocFromState() });
        trackSessionForReclaim();       // fresh live snapshot (abandonedAt:null) + arm
    }
    const p = gameState.players[gameState.userId];
    if (p) { teleportEntity(p, laptop.sitX, laptop.sitY); updatePlayerPosition(laptop.sitX, laptop.sitY); }
}

// After the Firebase socket silently reconnects, undo any session-freeing
// onDisconnect that fired during the dropout: re-claim our laptop (or relocate
// if it was taken) and clear the just-stamped abandonment so we don't look like
// a ghost and the session isn't double-restored on the next reload.
function reassertActiveSessionAfterReconnect() {
    if (gameState.isSirajGhost || !_sessionIsSolo()) return;
    if (!gameState.pomodoro.active && !gameState.freeMode.active) return;
    const lapId = _activeSessionLaptopId();
    if (lapId === null || lapId === undefined) return;

    const laptop = gameState.laptops.find(l => l.id === lapId);
    if (laptop && laptop.claimedBy && laptop.claimedBy !== gameState.userId) {
        // Someone grabbed our laptop while we were dropped — relocate to a free one.
        const free = gameState.laptops.find(l => !l.claimedBy);
        if (free) _relocateActiveSession(free);
        return;
    }

    if (gameState.freeMode.active) {
        saveFreeModStateToFirebase();   // writes doc + persists snapshot + arms
    } else {
        update(ref(database), { [lobbyPath(`pomodoro/${lapId}`)]: _pomoDocFromState() });
        trackSessionForReclaim();       // fresh live snapshot (abandonedAt:null) + arm
    }
    const p = gameState.players[gameState.userId];
    if (p) updatePlayerPosition(p.x, p.y);
}

function cleanupStaleRaceSession(session, sessionKey) {
    if (!session || !sessionKey) return false;

    const now = Date.now();
    const raceStartedAt = session.startTime || session.createdAt || 0;
    const isExpired = session.phase === 'race'
        ? raceStartedAt && now - raceStartedAt > RACE_MAX_AGE_MS
        : session.createdAt && now - session.createdAt > RACE_MAX_AGE_MS;

    if (!isExpired) return false;

    update(ref(database), { [lobbyPath(`minigames/race/sessions/${sessionKey}`)]: null });
    return true;
}

function isInDoorOpening(x) {
    return Math.abs(x) <= DOOR_HALF_WIDTH;
}

function isInBreakRoom(y) {
    return y > ROOM_SEAM_Y;
}

function screenToWorld(clientX, clientY) {
    const rect = gameState.canvas.getBoundingClientRect();
    // CSS clientX/Y are in logical pixels; with ctx.scale(dpr,dpr) the draw space
    // is also logical, so no DPR multiplication needed here.
    const dpr = gameState.dpr || 1;
    const W = gameState.canvas.width / dpr;  // logical viewport width
    const H = gameState.canvas.height / dpr;
    const canvasX = clientX - rect.left;
    const canvasY = clientY - rect.top;
    return {
        x: (canvasX - W / 2) / gameState.zoom - gameState.camera.x,
        y: (canvasY - H / 2) / gameState.zoom - gameState.camera.y
    };
}

// The entrance whoosh, prefetched over the network the moment the page loads (the
// slow part is the download). We can't DECODE it yet — there's no AudioContext
// until the user gesture (الدخول press) — but holding the raw bytes means
// loadSoundEffects() decodes from memory on login instead of fetching, so the
// sound is ready to fire the instant الدخول is pressed.
let _entranceArrayBufferPromise = null;
function _prefetchEntranceSound() {
    if (_entranceArrayBufferPromise) return;
    _entranceArrayBufferPromise = fetch('Sound/Enterance_Sound.mp3')
        .then(r => r.arrayBuffer())
        .catch(() => null);
}

// Initialize game
function init() {
    _prefetchEntranceSound();   // FIRST: warm the entrance sound so it's ready at login
    setMobileClass(); // set body.is-mobile before anything renders
    loadAssets();
    loadRaceTrackAsset();
    setupLobbySelection();   // ← shows lobby screen first; calls setupUserSelection internally
    setupModal();
    initWindParticles();
    initAmbientMotes();
    initLaptops();
    initDiscordOAuth();      // Discord button on lobby; auto-resume if session exists
    _juiceWireResume();      // JUICE: resume audio on the first gesture (refresh autoplay)
    setupJuiceUi();          // JUICE: wire the UI blip early so the login/lobby menu blips too
}

function loadAssets() {
    gameState.assets.bg.src = 'Art/Bg.png';
    gameState.assets.shadow.src = 'Art/Shadow.png';
    gameState.assets.tables.src = 'Art/Tables.png';
    gameState.assets.race.src = 'Art/race.png';
    gameState.assets.coffeeZone.src     = 'Art/Coffee.png';
    gameState.assets.coffeeMug.src      = 'Art/Coffee mug.png';
    gameState.assets.coffeeSugar.src    = 'Art/Sugar.png';
    gameState.assets.coffeeBadSugar.src = 'Art/Bad suger.png';
    gameState.assets.laptopBossZone.src   = 'Art/Laptop.png?v=2';
    gameState.assets.bossBg.src           = 'Art/LaptopBossFight/BG.png';
    gameState.assets.bossGround.src       = 'Art/LaptopBossFight/Ground.png';
    gameState.assets.bossHeart.src        = 'Art/LaptopBossFight/Heart.png';
    gameState.assets.bossHeartDead.src    = 'Art/LaptopBossFight/HeartDead.png';
    gameState.assets.bossIdle.src         = 'Art/LaptopBossFight/laptop_idle.png';
    gameState.assets.bossAnticipation.src = 'Art/LaptopBossFight/laptop_anticipation.png';
    gameState.assets.bossAttack.src       = 'Art/LaptopBossFight/laptop_attack_release.png';
    gameState.assets.bossWeak.src         = 'Art/LaptopBossFight/laptop_weak.png';
    gameState.assets.bossShield.src       = 'Art/LaptopBossFight/Laptop_Sheild.png';
}

function initWindParticles() {
    const count = isPotato() ? WIND_PARTICLE_COUNT_MOBILE : WIND_PARTICLE_COUNT;
    for (let i = 0; i < count; i++) {
        gameState.windParticles.push({
            x: Math.random() * window.innerWidth,
            y: Math.random() * window.innerHeight,
            size: 2 + Math.floor(Math.random() * 2),
            length: 2 + Math.floor(Math.random() * 3),
            speed: 3 + Math.random() * 5,
            opacity: 0.1 + Math.random() * 0.4,
            parallax: 1.3 + Math.random() * 0.6,
            twinklePhase: Math.random() * Math.PI * 2,
            twinkleSpeed: 0.6 + Math.random() * 1.4
        });
    }
}

// Gentle world-space dust motes that drift through the office — magical "alive" feel.
// Skipped only on the potato tier (kept on low so mobile looks close to desktop).
function initAmbientMotes() {
    if (isPotato()) return;
    const count = 22;
    const minX = -BG_WIDTH / 2, maxX = BG_WIDTH / 2;
    const minY = -BG_HEIGHT / 2, maxY = BG_HEIGHT * 1.5;
    for (let i = 0; i < count; i++) {
        gameState.ambientMotes.push({
            x: minX + Math.random() * (maxX - minX),
            y: minY + Math.random() * (maxY - minY),
            r: 1.2 + Math.random() * 2.2,
            driftX: (Math.random() - 0.5) * 0.18,
            driftY: -0.05 - Math.random() * 0.12,
            phase: Math.random() * Math.PI * 2,
            speed: 0.5 + Math.random() * 1.2,
            baseAlpha: 0.12 + Math.random() * 0.22
        });
    }
}

function updateAmbientMotes() {
    if (!gameState.ambientMotes.length) return;
    const minX = -BG_WIDTH / 2, maxX = BG_WIDTH / 2;
    const minY = -BG_HEIGHT / 2, maxY = BG_HEIGHT * 1.5;
    const sway = Date.now() * 0.0006;
    for (const m of gameState.ambientMotes) {
        m.x += (m.driftX + Math.sin(sway + m.phase) * 0.12) * gameState.dtFactor;
        m.y += m.driftY * gameState.dtFactor;
        // Wrap softly around the world so they never run out
        if (m.y < minY - 20) { m.y = maxY + 20; m.x = minX + Math.random() * (maxX - minX); }
        if (m.x < minX - 20) m.x = maxX + 20;
        else if (m.x > maxX + 20) m.x = minX - 20;
    }
}

function drawAmbientMotes() {
    if (!gameState.ambientMotes.length) return;
    const ctx = gameState.ctx;
    const tw = Date.now() * 0.002;
    ctx.save();
    for (const m of gameState.ambientMotes) {
        const flicker = 0.55 + 0.45 * Math.sin(tw * m.speed + m.phase);
        const a = m.baseAlpha * flicker;
        // Soft halo
        ctx.fillStyle = `rgba(255, 248, 224, ${a * 0.35})`;
        ctx.beginPath();
        ctx.arc(m.x, m.y, m.r * 2.4, 0, Math.PI * 2);
        ctx.fill();
        // Bright core
        ctx.fillStyle = `rgba(255, 252, 238, ${a})`;
        ctx.beginPath();
        ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.restore();
}

function initLaptops() {
    const rows = [0.25, 0.75];
    const cols = [0.12, 0.31, 0.5, 0.69, 0.88];
    let index = 1;
    rows.forEach((ry, rIdx) => {
        cols.forEach((cx) => {
            const worldX = TABLE_BOX.minX + (TABLE_WIDTH * cx);
            const worldY = TABLE_BOX.minY + (TABLE_HEIGHT * ry);
            const sitY = (rIdx === 0) ? TABLE_BOX.minY - 40 : TABLE_BOX.maxY + 40;
            const intermediateY = (rIdx === 0) ? sitY - 180 : sitY + 180;

            gameState.laptops.push({
                id: index++,
                x: worldX,
                y: worldY,
                sitX: worldX,
                sitY: sitY,
                intermediateX: worldX,
                intermediateY: intermediateY,
                claimedBy: null,
                endTime: 0,
                phase: 'none'
            });
        });
    });
}

// ─── Lobby Selection Screen ───────────────────────────────────────────────────
// Shows before the user list.  Renders one button per LOBBY_CONFIG entry so
// adding a lobby only requires touching LOBBY_CONFIG at the top of this file.
function setupLobbySelection() {
    const lobbyScreen  = document.getElementById('lobby-screen');
    const loginScreen  = document.getElementById('login-screen');
    const buttonsWrap  = document.getElementById('lobby-buttons');

    // Dynamically render one button per configured lobby
    buttonsWrap.innerHTML = '';
    for (const [lobbyId, cfg] of Object.entries(LOBBY_CONFIG)) {
        const btn = document.createElement('button');
        btn.className = `lobby-btn ${cfg.iconClass || ''}`;
        btn.dataset.lobby = lobbyId;
        btn.innerHTML = `
            <div class="lobby-icon" aria-hidden="true"></div>
            <div class="lobby-label">${cfg.label}</div>
        `;
        btn.addEventListener('click', () => {
            gameState.selectedLobby = lobbyId;
            lobbyScreen.classList.remove('active');
            loginScreen.classList.add('active');
            setupUserSelection();   // now that a lobby is chosen, build the user list
        });

        buttonsWrap.appendChild(btn);
    }

    // وضع التجربة — password-gated siraj ghost entry
    const sirajLink = document.getElementById('siraj-test-link');
    const sirajPwModal = document.getElementById('siraj-pw-modal');
    const sirajPwInput = document.getElementById('siraj-pw-input');
    const sirajPwError = document.getElementById('siraj-pw-error');
    const sirajPwConfirm = document.getElementById('siraj-pw-confirm');
    const sirajPwCancel = document.getElementById('siraj-pw-cancel');

    if (sirajLink && sirajPwModal) {
        sirajLink.addEventListener('click', () => {
            sirajPwInput.value = '';
            sirajPwError.textContent = '';
            sirajPwModal.classList.add('active');
            setTimeout(() => sirajPwInput.focus(), 80);
        });

        const attemptSirajLogin = () => {
            if (sirajPwInput.value === 'siraj') {
                sirajPwModal.classList.remove('active');
                spawnSirajGhost();
            } else {
                sirajPwError.textContent = 'كلمة المرور غير صحيحة';
                sirajPwInput.value = '';
                sirajPwInput.focus();
            }
        };

        sirajPwConfirm.addEventListener('click', attemptSirajLogin);
        sirajPwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') attemptSirajLogin(); });
        sirajPwCancel.addEventListener('click', () => { sirajPwModal.classList.remove('active'); });
    }
}

async function spawnSirajGhost() {
    const loadingOverlay = document.getElementById('siraj-loading-overlay');
    if (loadingOverlay) loadingOverlay.classList.add('active');

    const hue = Math.floor(Math.random() * 360);
    const sirajId = `siraj_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    // Build avatar and write to Firebase in parallel
    const avatarPromise = new Promise((resolve) => {
        const i = new Image();
        i.onload = () => {
            try {
                const offscreen = document.createElement('canvas');
                offscreen.width = i.naturalWidth;
                offscreen.height = i.naturalHeight;
                const octx = offscreen.getContext('2d');
                octx.filter = `hue-rotate(${hue}deg)`;
                octx.drawImage(i, 0, 0);
                resolve(offscreen.toDataURL('image/png'));
            } catch (_) { resolve('Art/siraj.png'); }
        };
        i.onerror = () => resolve('Art/siraj.png');
        i.src = 'Art/siraj.png';
    });

    // Write placeholder first so Firebase write starts immediately
    const placeholderWrite = set(ref(database, `users/${sirajId}`), {
        username: 'سراج',
        status: 'in-voice',
        categoryName: LOBBY_CONFIG.male.categoryName,
        channelName: 'اختبار',
        avatar: 'Art/siraj.png',
        activeInGame: false,
        x: 0,
        y: 0
    });

    const [avatarDataUrl] = await Promise.all([avatarPromise, placeholderWrite]);

    // Patch avatar with hue-shifted version if we got one
    if (avatarDataUrl !== 'Art/siraj.png') {
        await set(ref(database, `users/${sirajId}/avatar`), avatarDataUrl);
    }

    onDisconnect(ref(database, `users/${sirajId}`)).remove();
    sirajGhosts.push(sirajId);

    gameState.isSirajGhost = true;
    gameState.selectedLobby = 'male';
    const _ls = document.getElementById('lobby-screen');
    const _li = document.getElementById('login-screen');
    const _dw = document.getElementById('discord-welcome-screen');
    if (_ls) _ls.classList.remove('active');
    if (_li) _li.classList.remove('active');
    if (_dw) _dw.classList.remove('active');
    if (loadingOverlay) loadingOverlay.classList.remove('active');
    startGame({
        userId: sirajId,
        username: 'سراج',
        channelName: 'اختبار',
        avatar: avatarDataUrl
    });
}
// ─────────────────────────────────────────────────────────────────────────────

// Setup User Selection UI – filtered to the chosen lobby
function setupUserSelection() {
    const userListContainer = document.getElementById('user-list');
    const usersRef = ref(database, 'users');

    const allowedCategory = LOBBY_CONFIG[gameState.selectedLobby]?.categoryName;

    userListContainer.innerHTML = '<div class="loading-spinner"></div>';
    let firstRender = true;
    let prevUsersKey = null;

    // Tear down any previous welcome-screen subscription before re-attaching
    // (the user can bounce between lobby/user screens). Without this each visit
    // leaks another listener on the GLOBAL /users node.
    if (gameState._userSelectionUnsub) { try { gameState._userSelectionUnsub(); } catch (_) {} gameState._userSelectionUnsub = null; }

    authReady.then(() => {
        gameState._userSelectionUnsub = onValue(usersRef, (snapshot) => {
        const users = snapshot.val();
        // Once in-game the in-game listener (listenToPlayers) is the source of
        // truth. Detach this welcome-screen listener so we don't keep streaming
        // the entire global /users node (both lobbies) for the whole session —
        // a permanent, redundant download cost against the 10GB/mo cap.
        if (gameState.userId) {
            if (gameState._userSelectionUnsub) { try { gameState._userSelectionUnsub(); } catch (_) {} gameState._userSelectionUnsub = null; }
            return;
        }

        const WAJEHA_CAT = '📺 واجهة المدونة';
        const onlineUsers = users
            ? Object.entries(users).filter(([_, data]) => {
                if (!data || data.status !== 'in-voice') return false;
                if (data.categoryName === allowedCategory) return true;
                if (data.categoryName === WAJEHA_CAT) {
                    return true; // Always show — they join whatever lobby is currently selected
                }
                return false;
            })
            : [];

        // Skip re-render + animation replay if the visible list hasn't changed
        const newKey = onlineUsers.map(([uid, d]) =>
            `${uid}:${d.username}:${d.activeInGame ? 1 : 0}:${d.avatar || ''}`
        ).join('|');

        if (!firstRender && newKey === prevUsersKey) return;
        prevUsersKey = newKey;

        const renderUsers = () => {
            if (onlineUsers.length === 0) {
                userListContainer.innerHTML = '<div class="loading-users">' +
                    (users ? 'لا يوجد مستخدمون في قنوات الصوت حالياً.' : 'لا يوجد مستخدمون متصلون حالياً.') +
                    '</div>';
                return;
            }
            userListContainer.innerHTML = '';
            onlineUsers.forEach(([userId, userData]) => {
                const userItem = document.createElement('div');
                const isActive = userData.activeInGame === true;
                userItem.className = 'user-item' + (isActive ? ' disabled' : '');

                const avatarHtml = userData.avatar
                    ? `<img src="${userData.avatar}" alt="${userData.username}">`
                    : `<div class="placeholder-avatar">${userData.username.charAt(0).toUpperCase()}</div>`;

                const statusHtml = isActive ? '<div class="in-game-status">داخل اللعبة</div>' : '';

                userItem.innerHTML = `
                    ${statusHtml}
                    <div class="avatar-circle">${avatarHtml}</div>
                    <div class="name">${userData.username}</div>
                    <div class="channel">${userData.channelName || 'قناة صوتية'}</div>
                `;

                if (!isActive) {
                    userItem.addEventListener('click', () => showConfirmModal({ userId, ...userData }));
                }
                userListContainer.appendChild(userItem);
            });
        };

        if (firstRender) {
            firstRender = false;
            setTimeout(renderUsers, 200);
        } else {
            renderUsers();
        }
        });
    });
}

function setupModal() {
    const modal = document.getElementById('confirm-modal');
    const cancelBtn = document.getElementById('modal-cancel');
    const confirmBtn = document.getElementById('modal-confirm');
    cancelBtn.addEventListener('click', () => { modal.classList.remove('active'); gameState.selectedUser = null; });
    confirmBtn.addEventListener('click', () => {
        if (!gameState.selectedUser) return;
        const user = gameState.selectedUser;
        modal.classList.remove('active');
        if (user.categoryName === '📺 واجهة المدونة') {
            // Trust the lobby selected on the lobby screen. Save it so listenToPlayers can find them.
            update(ref(database), { [`users/${user.userId}/lobby`]: gameState.selectedLobby });
            startGame(user);
        } else {
            startGame(user);
        }
    });
}

function showWajehaGenderPicker(userData) {
    const modal = document.getElementById('gender-picker-modal');
    const wrap  = document.getElementById('gender-picker-buttons');
    if (!modal || !wrap) return;
    wrap.innerHTML = '';
    for (const [lobbyId, cfg] of Object.entries(LOBBY_CONFIG)) {
        const btn = document.createElement('button');
        btn.className = `lobby-btn ${cfg.iconClass || ''}`;
        btn.innerHTML = `<div class="lobby-icon" aria-hidden="true"></div><div class="lobby-label">${cfg.label}</div>`;
        btn.addEventListener('click', () => {
            modal.classList.remove('active');
            gameState.selectedLobby = lobbyId;
            update(ref(database), { [`users/${userData.userId}/lobby`]: lobbyId });
            startGame(userData);
        });
        wrap.appendChild(btn);
    }
    modal.classList.add('active');
}

function showConfirmModal(userData) {
    gameState.selectedUser = userData;
    document.getElementById('confirm-name').textContent = userData.username;
    document.getElementById('confirm-channel').textContent = userData.channelName || 'قناة صوتية';
    document.getElementById('confirm-avatar').src = userData.avatar || '';
    document.getElementById('confirm-modal').classList.add('active');
}

function playSoundRobust(audioElement) {
    if (!audioElement) return;
    try {
        audioElement.pause();
        audioElement.currentTime = 0;
        const p = audioObjPlayHelper(audioElement);
        if (p !== undefined) {
            p.catch(e => {
                console.log("Audio play blocked by browser, queueing on user gesture...", e);
                const playOnGesture = () => {
                    audioObjPlayHelper(audioElement).catch(err => {});
                    document.removeEventListener('click', playOnGesture);
                    document.removeEventListener('keydown', playOnGesture);
                };
                document.addEventListener('click', playOnGesture);
                document.addEventListener('keydown', playOnGesture);
            });
        }
    } catch(err) {
        console.log("Failed to play sound:", err);
    }
}

function fadeOutAudio(audio, durationMs = 900) {
    if (!audio || audio.paused) return;
    const startVol = audio.volume > 0 ? audio.volume : 1;
    const steps    = 18;
    const stepTime = durationMs / steps;
    const volStep  = startVol / steps;
    let step = 0;
    const iv = setInterval(() => {
        step++;
        audio.volume = Math.max(0, startVol - volStep * step);
        if (step >= steps) {
            clearInterval(iv);
            audio.pause();
            audio.currentTime = 0;
            try { audio.volume = 1; } catch(e) {}
        }
    }, stepTime);
}

function audioObjPlayHelper(el) {
    return el.play();
}

// Pool of pre-loaded Audio instances per src — avoids cloneNode() unreliability.
// Finds a free (paused/ended) instance; creates a new one if all are busy.
const _audioPool = {};
function playPooledSound(src, volume = 1, playbackRate = 1) {
    if (!_audioPool[src]) _audioPool[src] = [];
    const pool = _audioPool[src];
    let audio = pool.find(a => a.paused || a.ended);
    if (!audio) {
        audio = new Audio(src);
        pool.push(audio);
    }
    audio.volume = volume;
    audio.playbackRate = playbackRate;
    audio.currentTime = 0;
    audio.play().catch(() => {});
}

/**
 * Play the "player ready" minigame sound with distance-based volume
 * and a small random pitch shift for variety.
 * @param {number} volume  0–1, already distance-attenuated
 */
function playMinigameReadySound(volume) {
    const snd = gameState.sounds.minigameReady;
    if (!snd) return;
    try {
        const clone = snd.cloneNode();
        clone.volume = Math.max(0, Math.min(1, volume));
        // ±10% pitch variation so repeated plays never sound identical
        clone.playbackRate = 0.92 + Math.random() * 0.16;
        clone.play().catch(() => {});
    } catch (e) {}
}

function startGame(userData) {
    gameState.currentUser = userData.username;
    gameState.userId = userData.userId;

    // Remember we're actively in-game so an unintended reload auto-resumes.
    // Siraj ghosts are ephemeral (deleted on disconnect) — never auto-resume them.
    if (!gameState.isSirajGhost) {
        try { localStorage.setItem(ACTIVE_SESSION_KEY, userData.userId); } catch (_) {}
    }

    // Set HUD avatar image
    const hudAvatar = document.getElementById('hud-avatar');
    if (hudAvatar && userData.avatar) hudAvatar.src = userData.avatar;

    // Apply mobile class immediately
    setMobileClass();

    // Initialize Focus Audio Engine & Setup Focus UI. (No forced init() here — it
    // inits lazily as before so the focus-sound streaming→buffer handoff timing is
    // undisturbed. Juice sounds [entrance/blips] are registered as buffers in this
    // same engine, so they share its single context — no competing AudioContext.)
    // Reuse the engine if the login gesture already primed it (_primeFocusAudio in
    // enterGameAsDiscordUser) — that's what keeps its context RUNNING so the
    // entrance sound plays immediately instead of waiting for the first tap.
    gameState.focusAudioEngine = gameState.focusAudioEngine || new FocusAudioEngine();
    gameState.focusYTPlayer = new FocusYouTubePlayer();
    setupFocusPanelUI();

    // Set active presence in game and set up disconnect presence cleanup
    const activeRef = ref(database, `users/${gameState.userId}/activeInGame`);
    if (gameState.isSirajGhost) {
        // Siraj ghost: delete entire user entry on disconnect
        set(activeRef, true);
        onDisconnect(ref(database, `users/${gameState.userId}`)).remove();
    } else {
        // Single-session enforcement: each login writes a unique token. If another
        // tab/device logs in with the same account, it overwrites the token. The
        // original tab detects the mismatch and shows a "logged in elsewhere" overlay.
        const _tok = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        gameState._sessionToken = _tok;
        const sessionRef = ref(database, `users/${gameState.userId}/activeSession`);

        // CRITICAL presence fix (the perennial "ghost laptop / working user
        // invisible to others" bug): a flaky mobile connection drops the Firebase
        // socket, which fires the `onDisconnect` ops server-side (activeInGame=false,
        // laptop freed). The socket then silently reconnects — but the original code
        // only set presence ONCE at login, so activeInGame stayed false forever and
        // the still-working user rendered as a claimed-but-empty ghost laptop to
        // everyone else. Re-assert presence (and RE-ARM the disconnect handlers,
        // which fire only once) on EVERY (re)connection via `.info/connected`.
        const connectedRef = ref(database, '.info/connected');
        onValue(connectedRef, (snap) => {
            if (snap.val() !== true) return;
            // If another device took over this account, don't fight back on reconnect.
            if (gameState._dupSessionDetected) return;
            // (Re)arm disconnect cleanup first, then assert the live value.
            onDisconnect(activeRef).set(false);
            set(activeRef, true);
            onDisconnect(sessionRef).set(null);
            set(sessionRef, gameState._sessionToken);
            // Undo any session-freeing onDisconnect that fired during the dropout so
            // the laptop comes back to us instead of lingering as a ghost / staying free.
            reassertActiveSessionAfterReconnect();
        });

        onValue(sessionRef, snap => {
            const live = snap.val();
            if (live && live !== gameState._sessionToken) {
                document.getElementById('dup-session-overlay')?.classList.add('active');
                // Halt the game loop gently — the overlay reload button will refresh.
                gameState._dupSessionDetected = true;
            }
        });

        // On PC sleep/wake or tab refocus, re-assert presence + re-broadcast our
        // position/task immediately (don't wait for the 10s heartbeat) so observers
        // who saw us drop refresh us instantly instead of leaving us as a faded ghost.
        const _resyncPresence = () => {
            if (gameState._dupSessionDetected) return;
            update(ref(database), {
                [`users/${gameState.userId}/activeInGame`]: true,
                [`users/${gameState.userId}/activeSession`]: gameState._sessionToken,
            });
            const _p = gameState.players[gameState.userId];
            if (_p) updatePlayerPosition(_p.x, _p.y);
            ensurePresenceSocket();   // re-open the relay if the wake dropped it
        };
        document.addEventListener('visibilitychange', () => { if (!document.hidden) _resyncPresence(); });
        window.addEventListener('focus', _resyncPresence);
        window.addEventListener('online', _resyncPresence);
    }

    document.getElementById('login-screen').classList.remove('active');
    document.getElementById('game-screen').classList.add('active');
    document.body.classList.add('game-ready');
    document.getElementById('current-user').textContent = userData.username;
    document.getElementById('channel-name').textContent = userData.channelName || 'قناة غير معروفة';
    gameState.canvas = document.getElementById('game-canvas');
    gameState.ctx = gameState.canvas.getContext('2d');
    gameState._lowGfx = isReducedGraphics();
    gameState._potato = isPotato();
    installLowGfxShadowGuard(gameState.ctx);
    resizeCanvas();
    setupControls();
    setupArabicNumeralSupport();
    setupModeSelectUI();
    setupPomodoroUI();
    setupTestModeUI();
    setupRaceUI();
    setupLogout();
    initMobileControls();
    listenToPlayers();
    ensurePresenceSocket();   // open the live-position WebSocket relay
    listenToPomodoro();
    listenToRace();
    listenToCoffee();
    listenToLaptopBoss();
    initSharedPomo();
    setupPomoLeaveBtn();
    setupFreeModeUI();
    initPrayerSystem();
    setupAzkarUI();
    setupPiPUI();
    setupSettingsUI();
    setupJuiceUi();   // JUICE: per-element UI blip + sequenced pop-out
    startTabTitleTicker();

    document.getElementById('minigame-leave-btn')?.addEventListener('click', () => leaveMinigame());

    // Track server time offset so race start/countdown is synchronized across clients
    const offsetRef = ref(database, '.info/serverTimeOffset');
    onValue(offsetRef, (snap) => {
        gameState.serverTimeOffset = snap.val() || 0;
    });
    get(ref(database, lobbyPath('pomodoro'))).then((pomoSnapshot) => {
        const pomoData = pomoSnapshot.val() || {};
        syncLaptopsFromPomodoro(pomoData);
        let activeLaptopId = null;
        let restoringFreeMode = false;
        const FREE_MODE_EXPIRY_MS = 60 * 60 * 1000; // 1 hour
        for (const [lapId, state] of Object.entries(pomoData)) {
            if (!state || state.claimedBy !== gameState.userId) continue;

            if (state.mode === 'free') {
                // Free mode save — check if < 1 hour old
                const savedAt = state.savedAt || state.createdAt || 0;
                if (!savedAt || Date.now() - savedAt > FREE_MODE_EXPIRY_MS) {
                    // Expired — clean up
                    update(ref(database), { [lobbyPath(`pomodoro/${lapId}`)]: null });
                } else {
                    activeLaptopId = parseInt(lapId);
                    restoringFreeMode = true;
                    const fm = gameState.freeMode;
                    fm.active        = true;
                    fm.laptopId      = activeLaptopId;
                    fm.isShared      = false;
                    fm.phase         = 'idle'; // _startFreeModeWork fires via needsResume
                    fm._createdAt    = state.createdAt || Date.now();
                    fm.totalWorkMs   = state.totalWorkMs || 0;
                    fm.workStartTime = 0;
                    fm.breakEndTime  = 0;
                    fm.breakPromptShown = false;
                    fm.needsResume   = true;
                    // Restore laptop doc to active state. The unified disconnect
                    // handlers (free laptop + stash) are armed later via
                    // trackSessionForReclaim() once the session state is settled.
                    update(ref(database), {
                        [lobbyPath(`pomodoro/${lapId}/phase`)]: 'free-work',
                        [lobbyPath(`pomodoro/${lapId}/savedAt`)]: 0,
                    });
                }
                break;
            }

            if (cleanupStalePomodoroState(lapId, state)) continue;
            activeLaptopId = parseInt(lapId);
            gameState.pomodoro.active = true;
            gameState.pomodoro.laptopId = activeLaptopId;
            gameState.pomodoro.phase = state.phase;
            gameState.pomodoro.endTime = state.endTime;
            gameState.pomodoro.sessionsLeft = state.sessionsLeft;
            gameState.pomodoro.workDuration = state.workDuration;
            gameState.pomodoro.breakDuration = state.breakDuration || 5;
            gameState.pomodoro.totalSessions = state.totalSessions || state.sessionsLeft || 1;
            gameState.pomodoro.createdAt = state.createdAt || Date.now();
            break;
        }

        // Fire-and-forget: free devices abandoned by offline users for 30+ mins
        cleanupAbandonedPomoSessions(pomoData);

        get(ref(database, `users/${gameState.userId}`)).then((snapshot) => {
            const data = snapshot.val();
            const _defaultSpawn = getRandomSpawnPosition();
            let spawnX = _defaultSpawn.x, spawnY = _defaultSpawn.y;
            let locked = false;

            // Restore Focus Mix from User Profile instead of session!
            if (data && data.focusMix && gameState.focusAudioEngine) {
                gameState.focusAudioEngine.applyState(data.focusMix);
            }

            // Restore persisted YouTube focus player if present
            if (data && data.focusPlayer && gameState.focusYTPlayer) {
                gameState.focusYTPlayer.loadFromProfile(data.focusPlayer);
            }

            // Reclaim a session our onDisconnect stashed when we dropped the socket
            // or closed the tab mid-session (valid for 4h). `abandonedAt` is only
            // present once a disconnect actually happened — a live snapshot has it
            // null and is ignored here. Prefer the original laptop; if it's taken,
            // fall back to any free laptop (position syncs so all clients see us
            // seated correctly on the new one).
            if (activeLaptopId === null && data?.lastPomoSession && data.lastPomoSession.abandonedAt) {
                const ls = data.lastPomoSession;
                const now = Date.now();
                const isFree = ls.mode === 'free';
                const withinWindow = (now - ls.abandonedAt) < RECLAIM_WINDOW_MS;
                const hasProgress = isFree ? true : (ls.sessionsLeft > 0);
                const stillValid = withinWindow && hasProgress;
                const preferred = (stillValid && ls.laptopId != null)
                    ? gameState.laptops.find(l => l.id === ls.laptopId && !l.claimedBy) : null;
                const target = stillValid ? (preferred || gameState.laptops.find(l => !l.claimedBy)) : null;

                if (target && isFree) {
                    // Restore free mode on the target laptop
                    const freeDoc = {
                        claimedBy: gameState.userId,
                        phase: 'free-work', mode: 'free',
                        createdAt: ls.createdAt || now,
                        endTime: 0, totalWorkMs: ls.totalWorkMs || 0,
                        breakEndTime: 0, savedAt: 0,
                    };
                    update(ref(database), {
                        [lobbyPath(`pomodoro/${target.id}`)]: freeDoc,
                        [`users/${gameState.userId}/lastPomoSession`]: null,
                    });
                    applyPomodoroStateToLaptop(target, freeDoc);
                    activeLaptopId = target.id;
                    restoringFreeMode = true;
                    const fm = gameState.freeMode;
                    fm.active        = true;
                    fm.laptopId      = target.id;
                    fm.isShared      = false;
                    fm.phase         = 'idle';
                    fm._createdAt    = ls.createdAt || now;
                    fm.totalWorkMs   = ls.totalWorkMs || 0;
                    fm.workStartTime = 0;
                    fm.breakEndTime  = 0;
                    fm.breakPromptShown = false;
                    fm.needsResume   = true;
                } else if (target) {
                    const restoredPhase = ls.phase === 'break' ? 'break' : 'work';
                    const phaseMins = restoredPhase === 'work' ? (ls.workDuration || 25) : (ls.breakDuration || 5);
                    const newEndTime = now + phaseMins * 60000;
                    const restoredDoc = {
                        claimedBy: gameState.userId,
                        phase: restoredPhase,
                        endTime: newEndTime,
                        workDuration: ls.workDuration,
                        breakDuration: ls.breakDuration || 5,
                        sessionsLeft: ls.sessionsLeft,
                        totalSessions: ls.totalSessions,
                        createdAt: ls.createdAt || now,
                    };
                    update(ref(database), {
                        [lobbyPath(`pomodoro/${target.id}`)]: restoredDoc,
                        [`users/${gameState.userId}/lastPomoSession`]: null,
                    });
                    applyPomodoroStateToLaptop(target, restoredDoc);
                    activeLaptopId = target.id;
                    gameState.pomodoro.active       = true;
                    gameState.pomodoro.laptopId     = target.id;
                    gameState.pomodoro.phase        = restoredPhase;
                    gameState.pomodoro.endTime      = newEndTime;
                    gameState.pomodoro.sessionsLeft = ls.sessionsLeft;
                    gameState.pomodoro.workDuration = ls.workDuration;
                    gameState.pomodoro.breakDuration = ls.breakDuration || 5;
                    gameState.pomodoro.totalSessions = ls.totalSessions || ls.sessionsLeft || 1;
                    gameState.pomodoro.createdAt    = ls.createdAt || now;
                    locked = restoredPhase === 'work';
                } else {
                    // Stale (>4h), no progress, or no free device — discard.
                    update(ref(database), { [`users/${gameState.userId}/lastPomoSession`]: null });
                }
            }

            if (gameState.pomodoro.active && gameState.pomodoro.phase === 'work') {
                const panel = document.getElementById('focus-sounds-panel');
                if (panel) panel.classList.add('active');
                const taskPanel = document.getElementById('current-task-panel');
                if (taskPanel) taskPanel.classList.add('active');
            }

            if (activeLaptopId !== null) {
                const laptop = gameState.laptops.find(l => l.id === activeLaptopId);
                if (laptop) {
                    spawnX = laptop.sitX;
                    spawnY = laptop.sitY;
                    if (!restoringFreeMode && (gameState.pomodoro.phase === 'work' || gameState.pomodoro.phase === 'wait')) locked = true;
                }
            } else if (data && (data.x !== undefined && data.y !== undefined) && data.x !== 0 && !checkCollision(data.x, data.y) && !isInBreakRoom(data.y)) {
                spawnX = data.x;
                spawnY = data.y;
            }

            if (!gameState.players[gameState.userId]) {
                const localPlayer = {
                    userId: gameState.userId,
                    username: gameState.currentUser,
                    x: spawnX,
                    y: spawnY,
                    renderX: spawnX,
                    renderY: spawnY
                };
                gameState.players[gameState.userId] = localPlayer;
            } else {
                teleportEntity(gameState.players[gameState.userId], spawnX, spawnY);
            }
            updatePlayerPosition(spawnX, spawnY);
            gameState.positionInitialized = true;
            if (locked) gameState.isLockedIn = true;

            // Arm the unified disconnect handlers for whatever solo session we
            // restored/reclaimed above (pomo or free), so an immediate disconnect
            // after login frees the laptop and preserves the session for reclaim.
            if ((gameState.pomodoro.active || gameState.freeMode.active) && _sessionIsSolo()) {
                trackSessionForReclaim();
            }

            // Now that session state is known, choose the entrance: a plain black
            // fade if we restored into an active session (seamless), otherwise the
            // full cinematic entrance — including on a refresh while NOT in a session.
            beginEntrance(gameState.pomodoro.active || gameState.freeMode.active);
        });
    });

    // Background interval using Web Worker to bypass tab throttling completely
    const timerWorkerCode = `
        let intervalId = null;
        self.onmessage = function(e) {
            if (e.data === 'start') {
                if (intervalId) clearInterval(intervalId);
                intervalId = setInterval(() => self.postMessage('tick'), 500);
            } else if (e.data === 'stop') {
                clearInterval(intervalId);
                intervalId = null;
            }
        };
    `;
    const timerWorkerBlob = new Blob([timerWorkerCode], { type: 'application/javascript' });
    const timerWorkerUrl = URL.createObjectURL(timerWorkerBlob);
    const timerWorker = new Worker(timerWorkerUrl);
    timerWorker.onmessage = () => {
        updatePomodoro();
        updateFreeMode();
    };
    timerWorker.postMessage('start');

    // JUICE EXPERIMENT: cinematic login entrance (black fade + zoom-in + character
    // drop + screenshake + pitched entrance sound). No-op when JUICE_ENTRANCE is off
    // or for ephemeral Siraj ghosts. See the JUICE block below startGame().
    playEntranceSequence();

    gameLoop();
}

// ═══════════════════════════════════════════════════════════════════════════
//  JUICE EXPERIMENT — login entrance sequence + remote scale-in + screenshake
//  Self-contained & reversible: flip JUICE_ENTRANCE to false to disable the JS
//  side entirely (every hook below is guarded on it). The matching CSS lives in
//  juice.css (remove its <link> in index.html to revert the UI animations).
// ═══════════════════════════════════════════════════════════════════════════
const JUICE_ENTRANCE = true;
const JUICE_EXIT_MS = 420;   // scale-down duration when a remote player disconnects

const ENTRY = {
    fadeMs:      1300,   // black overlay fade-out duration
    zoomStart:   0.62,   // camera starts zoomed OUT, eases IN to 1.0
    zoomMs:      1700,   // zoom-in duration (fast start, slow end)
    dropStartMs: 1480,   // when the character appears (waits ~0.5s longer)
    dropMs:      200,    // snaps down to normal size FAST (0.2s)
    startScale:  16,     // appears huge (≈screen-filling), then shrinks to normal
};

const _entrance = {
    active: false, start: 0, el: null, targetZoom: 1,
    camSnapped: false, dropBaseSet: false, dropBaseT: 0,
    charVisible: false, dropComplete: false,
    dropY: 0, dropScale: 1, dropBlur: 0, squashX: 1, squashY: 1,
    shakeFired: false, impactT: 0, shakeAmp: 0, shakeX: 0, shakeY: 0,
};

// ── Juice audio (entrance whoosh + UI blips) ─────────────────────────────────
// CRITICAL: never create a second AudioContext. On iOS/Safari all contexts share
// one audio session and the newest output owner silences the others — that was
// the "focus sounds vanish when I move" bug. Everything routes through the focus
// engine's ONE context via its registered buffers (FocusAudioEngine.playPitched),
// and we never touch its init timing (which would disturb the focus sounds).
let _entPending = false, _entPendingAt = 0, _entWantsPlay = false, _entFirstWantAt = 0;

// On a gesture-less refresh (OAuth auto-resume logs you straight in, no "Enter"
// click) the AudioContext starts suspended — the browser BLOCKS all audio until
// the first real interaction. That first tap/key/click is the only moment we're
// allowed to start the whoosh, so resume the context AND (re)fire the queued
// entrance sound here — even if its original retry loop already gave up.
function _juiceWireResume() {
    if (gameState._juiceResumeWired) return;
    gameState._juiceResumeWired = true;
    const onGesture = () => {
        const fe = gameState.focusAudioEngine;
        if (fe && fe.ctx && fe.ctx.state === 'suspended') fe.ctx.resume().catch(() => {});
        if (_entWantsPlay) _playEntranceSound();
    };
    ['pointerdown', 'mousedown', 'keydown', 'touchstart', 'click'].forEach(ev =>
        document.addEventListener(ev, onGesture, { capture: true, passive: true }));
}

// Ensure the focus audio engine exists, its single AudioContext is created, and —
// crucially — it's resumed. Call this synchronously from inside a user gesture
// (the login "Enter" click) so the context starts RUNNING rather than suspended.
// Idempotent and safe to call repeatedly. Returns the engine.
function _primeFocusAudio() {
    if (!gameState.focusAudioEngine) gameState.focusAudioEngine = new FocusAudioEngine();
    const fe = gameState.focusAudioEngine;
    try {
        if (!fe.ctx) fe.init();
        if (fe.ctx && fe.ctx.state === 'suspended') fe.ctx.resume().catch(() => {});
    } catch (_) {}
    return fe;
}

// Play the entrance whoosh through the focus engine. If the context is suspended
// (gesture-less refresh) or the buffer/engine isn't ready yet, keep retrying for
// a short window — it fires the instant the context is running AND the buffer is
// loaded (so on a refresh where focus audio is already allowed, it plays without
// waiting for input; otherwise the gesture handler resumes it).
function _playEntranceSound() {
    const fe = gameState.focusAudioEngine;
    if (!fe) return;
    if (!fe.ctx) { try { fe.init(); } catch (_) {} }
    // Mark the INTENT to play. This survives the retry loop giving up, so the first
    // gesture after a gesture-less auto-resume re-fires it (onGesture checks this).
    if (!_entWantsPlay) { _entWantsPlay = true; _entFirstWantAt = performance.now(); }
    // …but don't fire a stale whoosh forever — a returning user who finally clicks
    // 30s later shouldn't hear an out-of-context intro sound.
    if (performance.now() - _entFirstWantAt > 30000) { _entWantsPlay = false; _entPending = false; return; }
    if (_entPending) return;                            // a retry loop is already running
    _entPending = true; _entPendingAt = performance.now();
    const tick = () => {
        if (!_entPending) return;
        const c = fe.ctx;
        if (c && c.state === 'suspended') c.resume().catch(() => {});
        if (_entWantsPlay && fe.playPitched('entranceSound', 1.0, 0.42)) {
            _entPending = false; _entWantsPlay = false;  // played for real
            return;
        }
        if (performance.now() - _entPendingAt < 9000) setTimeout(tick, 130);
        else _entPending = false;                        // pause loop; a gesture re-arms it
    };
    tick();
}

// In-game UI cascade blip — quiet, through the focus engine's context.
function _playUiBlip(rate) {
    const fe = gameState.focusAudioEngine;
    if (fe) fe.playPitched('uiBlip', rate, 0.07);
}

// Put up the black overlay immediately, but DON'T decide the entrance yet — we
// only know whether we're restoring into an active session once the async
// Firebase restore resolves. beginEntrance() (called from that restore, and from
// a failsafe timer) then picks: plain fade if in a session, full cinematic
// entrance otherwise. The entrance sound rides the focus engine's buffers.
function playEntranceSequence() {
    if (!JUICE_ENTRANCE || gameState.isSirajGhost) return;

    const el = document.createElement('div');
    el.id = 'entrance-blackout';
    el.style.cssText = 'position:fixed;inset:0;background:#000;z-index:99999;'
        + 'pointer-events:none;opacity:1;';
    document.body.appendChild(el);

    _entrance.el = el;
    _entrance.pending = true;
    // Failsafe: if the restore callback never fires, default to a full entrance.
    if (_entrance._failsafe) clearTimeout(_entrance._failsafe);
    _entrance._failsafe = setTimeout(() => { if (_entrance.pending) beginEntrance(false); }, 4000);
}

// inSession = true → seamless plain black fade (no zoom/drop/sound). This is what
// a mid-session refresh gets. Not in a session → full cinematic entrance, even on
// a refresh.
function beginEntrance(inSession) {
    if (!_entrance.pending) return;
    _entrance.pending = false;
    if (_entrance._failsafe) { clearTimeout(_entrance._failsafe); _entrance._failsafe = null; }
    const el = _entrance.el;

    if (inSession) {
        if (el) {
            el.style.transition = 'opacity 0.7s ease';
            requestAnimationFrame(() => { el.style.opacity = '0'; });
            setTimeout(() => { try { el.remove(); } catch (_) {} }, 820);
        }
        _entrance.el = null;
        return;
    }

    // Full cinematic entrance — timing starts now (preserves the overlay ref).
    // Mobile gets a GENTLER version: a softer zoom-in (0.80 vs desktop's 0.62) so
    // the camera reveals ~1.5x the world area for ~1.7s instead of ~2.6x — most of
    // the cinematic feel at a fraction of the per-frame draw cost that was starving
    // the audio thread (the entrance-sound "crackle"). The weakest phones (potato
    // tier) still skip the zoom. We keep the small drop scale either way — the old
    // screen-filling 16x sprite was a costly raster spike. Desktop is unchanged.
    const mobile = isMobile();
    const mobileZoom = isPotato() ? 1 : 0.80;
    Object.assign(_entrance, {
        active: true, start: performance.now(), targetZoom: 1,
        zoomStart: mobile ? mobileZoom : ENTRY.zoomStart,
        startScale: mobile ? 2.4 : ENTRY.startScale,
        camSnapped: false, dropBaseSet: false, dropBaseT: 0,
        charVisible: false, dropComplete: false,
        dropY: 0, dropScale: 1, dropBlur: 0, squashX: 1, squashY: 1,
        shakeFired: false, impactT: 0, shakeAmp: 0, shakeX: 0, shakeY: 0,
        el,
    });
    gameState.zoom = _entrance.zoomStart;
    _playEntranceSound();
}

function updateEntrance(now) {
    if (!JUICE_ENTRANCE || !_entrance.active) return;
    const e = _entrance;
    const t = now - e.start;
    const player = gameState.players[gameState.userId];

    // Snap the camera onto the player the instant it exists (created async after
    // the Firebase read) so the zoom-out is centred — hidden under the black fade.
    if (player && !e.camSnapped) {
        const { x: px, y: py } = getPlayerRenderPos(player);
        gameState.camera.x = -px;
        gameState.camera.y = -py;
        e.camSnapped = true;
    }

    // Black overlay fade-out.
    if (e.el) {
        const f = Math.min(1, t / ENTRY.fadeMs);
        e.el.style.opacity = String(1 - easeOutCubic(f));
        if (f >= 1) { try { e.el.remove(); } catch (_) {} e.el = null; }
    }

    // Camera zoom-in (fast start, slow end).
    const _zs = e.zoomStart != null ? e.zoomStart : ENTRY.zoomStart;
    const z = Math.min(1, t / ENTRY.zoomMs);
    gameState.zoom = _zs + (e.targetZoom - _zs) * easeOutCubic(z);

    // Character drop — only once the player entity actually exists.
    if (player) {
        if (!e.dropBaseSet) {
            e.dropBaseT = Math.max(now, e.start + ENTRY.dropStartMs);
            e.dropBaseSet = true;
        }
        const dp = (now - e.dropBaseT) / ENTRY.dropMs;
        if (dp >= 0) {
            e.charVisible = true;
            const p = Math.min(1, dp);
            const sp = easeOutCubic(p);
            // Z-axis drop: starts huge (near the camera) → snaps down to normal fast.
            const _ss = e.startScale != null ? e.startScale : ENTRY.startScale;
            let scale = 1 + (_ss - 1) * (1 - sp);
            // Light landing settle — a subtle dip, not a heavy bounce.
            if (p > 0.74) { const q = (p - 0.74) / 0.26; scale *= 1 - Math.sin(q * Math.PI) * 0.045; }
            e.dropScale = scale;
            e.dropY = 0;
            // One soft screenshake + a puff of impact particles on landing.
            if (!e.shakeFired && p >= 0.74) {
                e.shakeFired = true;
                e.impactT = now;
                e.shakeAmp = 12;
                const rp = getPlayerRenderPos(player);
                spawnImpactBurst(rp.x, rp.y + PLAYER_SIZE / 2, gameState._lowGfx ? 9 : 18);
            }
            if (p >= 1 && !e.dropComplete) {
                e.dropComplete = true;
                e.dropY = 0;
                e.dropScale = 1;
                e.dropBlur = 0;
            }
        }
        // Impact squash: a light vertical compress that springs back.
        if (e.shakeFired) {
            const q = (now - e.impactT) / 180;
            if (q < 1) {
                const k = Math.sin(q * Math.PI) * 0.10;
                e.squashX = 1 + k;
                e.squashY = 1 - k;
            } else { e.squashX = 1; e.squashY = 1; }
        }
    }

    // Screenshake decay.
    if (e.shakeAmp > 0.3) {
        e.shakeAmp *= 0.86;
        e.shakeX = (Math.random() - 0.5) * 2 * e.shakeAmp;
        e.shakeY = (Math.random() - 0.5) * 2 * e.shakeAmp * 0.7;
    } else {
        e.shakeAmp = 0; e.shakeX = 0; e.shakeY = 0;
    }

    // End the sequence once the drop has landed, the shake settled, and the
    // overlay is gone — then movement unblocks.
    if (e.dropComplete && e.shakeAmp === 0 && !e.el) {
        e.active = false;
        e.charVisible = true;
        e.dropY = 0; e.dropScale = 1; e.dropBlur = 0; e.squashX = 1; e.squashY = 1;
    }
}

// JUICE: delete remote players once their disconnect scale-down has finished.
function updateLeavingPlayers() {
    if (!JUICE_ENTRANCE) return;
    const now = performance.now();
    for (const id of Object.keys(gameState.players)) {
        const p = gameState.players[id];
        if (p && p._exitT != null && now - p._exitT >= JUICE_EXIT_MS) {
            delete gameState.players[id];
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//  JUICE EXPERIMENT — UI sound per element + sequenced pop-out on modal swaps
//  Reversible: set JUICE_UI = false to disable both. The pop-out cascades and
//  per-element blip are driven from the CSS animations in juice.css.
// ═══════════════════════════════════════════════════════════════════════════
const JUICE_UI = true;
// Only POP-IN animations of the in-game juiced panels trigger the cascade blip.
// (Login/lobby elements do NOT blip on appear — they blip on button press, see
// the pointerdown handler in setupJuiceUi.)
const _JUICE_IN_ANIMS = new Set(['juicePop', 'juiceContainerPop', 'juiceRowIn']);
// Elements whose pop-in should stay silent (visual animation still plays).
const _JUICE_SILENT_SEL = '.free-mode-panel, .success-content';

// Pitch sweep state: first element of a cascade is the "heaviest" (deepest)
// pitch, each following element a step higher; the base is randomised per
// cascade. A gap (or an explicit reset) starts a fresh sweep.
const _uiSeq = { lastT: 0, idx: 0, base: 1 };
function _uiSeqRate() {
    const now = performance.now();
    if (now - _uiSeq.lastT > 240) {                 // new cascade
        _uiSeq.idx = 0;
        _uiSeq.base = 0.78 + Math.random() * 0.16;  // random deep start each time
    } else {
        _uiSeq.idx++;
    }
    _uiSeq.lastT = now;
    return _uiSeq.base + Math.min(_uiSeq.idx, 12) * 0.055;   // rises toward the end
}
function _uiSeqReset() { _uiSeq.lastT = 0; }   // force the next blip to begin a fresh sweep

function setupJuiceUi() {
    if (!JUICE_UI || gameState._juiceUiWired) return;
    gameState._juiceUiWired = true;
    // In-game cascade: one blip per element as it POPS IN (pop-outs are silent),
    // through the focus engine's context. Capture phase catches descendants.
    document.addEventListener('animationstart', (ev) => {
        if (!_JUICE_IN_ANIMS.has(ev.animationName)) return;
        const t = ev.target;
        if (t && t.closest && t.closest(_JUICE_SILENT_SEL)) return;   // mute in-session timer text + completed card
        _playUiBlip(_uiSeqRate());
    }, true);

    // Login / lobby flow (no focus engine yet): blip on BUTTON PRESS via a plain
    // HTMLAudio element — deliberately NOT Web Audio, so it can't create a second
    // AudioContext that would later fight the focus engine on iOS/Safari.
    document.addEventListener('pointerdown', (ev) => {
        if (gameState.userId) return;   // login flow only
        const t = ev.target;
        if (t && t.closest && t.closest('button, .user-item')) {
            try {
                const a = new Audio('Sound/Menu_Ui.mp3');
                a.volume = 0.18;
                a.playbackRate = 0.95 + Math.random() * 0.1;
                a.play().catch(() => {});
            } catch (_) {}
        }
    }, true);
}

// Quick sequenced close of a modal, then run openNext() — gives the "old panel
// flees, new panel pops in" feel. Falls back to an instant swap if JUICE_UI off.
function juiceCloseThenOpen(fromModal, openNext) {
    if (!fromModal) { if (openNext) openNext(); return; }
    if (!JUICE_UI) {
        fromModal.classList.remove('active');
        if (openNext) openNext();
        return;
    }
    fromModal.classList.add('juice-closing');
    setTimeout(() => {
        fromModal.classList.remove('active');
        fromModal.classList.remove('juice-closing');
        _uiSeqReset();          // the incoming panel starts its own pitch sweep
        if (openNext) openNext();
    }, 230);
}

// Canvas `shadowBlur` is a per-draw Gaussian blur and one of the most expensive
// 2D ops on budget GPUs — and it's used ~20× per frame (timers, nametags, player,
// connection labels…). Rather than gate every call site, intercept the property:
// when the live graphics tier is "low", every `ctx.shadowBlur = N` is clamped to 0.
// Calls the native accessor so high-graphics shadows are unchanged, and reads the
// per-frame flag so a runtime quality switch takes effect immediately.
function installLowGfxShadowGuard(ctx) {
    try {
        let proto = Object.getPrototypeOf(ctx), desc = null;
        while (proto && !desc) {
            desc = Object.getOwnPropertyDescriptor(proto, 'shadowBlur');
            proto = Object.getPrototypeOf(proto);
        }
        if (!desc || !desc.get || !desc.set) return;
        Object.defineProperty(ctx, 'shadowBlur', {
            configurable: true,
            get() { return desc.get.call(this); },
            set(v) { desc.set.call(this, gameState._lowGfx ? 0 : v); },
        });
    } catch (_) { /* non-fatal: shadows just stay on */ }
}

let _lastCanvasBW = -1, _lastCanvasBH = -1;
function resizeCanvas() {
    if (!gameState.canvas) return;
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    let dpr = window.devicePixelRatio || 1;
    // Cap render resolution on reduced tiers. A full-screen 60fps canvas is
    // fill-rate bound, and a budget phone at dpr 2.5–3 renders 6–9× the pixels of
    // dpr 1. Capping to 1.5 (1.25 on potato) cuts that dramatically — the single
    // biggest mobile win — for only a slight sharpness loss.
    const reduced = isReducedGraphics();
    if (reduced) dpr = Math.min(dpr, isPotato() ? 1.25 : 1.5);
    // Hard cap on the backing-store size. A bad transient viewport mid-rotation
    // (Android briefly reports stale/oversized dimensions) could otherwise allocate
    // a huge canvas and tank performance until reload. Scale dpr down to fit budget.
    const maxPixels = reduced ? 3.2e6 : 24e6; // high cap only catches absurd transients
    const want = w * h * dpr * dpr;
    if (want > maxPixels) dpr *= Math.sqrt(maxPixels / want);
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    // Skip redundant reallocations. Android fires resize/visualViewport repeatedly
    // as the URL bar collapses; reallocating a multi-megapixel canvas each time
    // causes jank. Only resize when the backing-store size actually changed.
    if (bw === _lastCanvasBW && bh === _lastCanvasBH) return;
    _lastCanvasBW = bw; _lastCanvasBH = bh;
    gameState.dpr = dpr;
    gameState.canvas.width  = bw;
    gameState.canvas.height = bh;
    gameState.canvas.style.width  = w + 'px';
    gameState.canvas.style.height = h + 'px';
}

function applyViewportLayout() {
    resizeCanvas();
    setMobileClass();
}

// Is the viewport aspect consistent with the device's reported orientation?
// screen.orientation updates IMMEDIATELY on rotation, while window.innerWidth/
// innerHeight lag (Android can report the old landscape size for up to ~1s into a
// portrait rotation). Comparing the two tells us whether the reported size is the
// real post-rotation size or a stale one.
function _viewportMatchesOrientation() {
    // Only meaningful on devices that physically rotate. On desktop a portrait-shaped
    // window on a landscape monitor is a permanent mismatch, so never block there.
    if (!isTouchDevice()) return true;
    const so = window.screen && window.screen.orientation;
    if (!so || !so.type) return true; // can't tell → assume fine
    const wantPortrait = so.type.indexOf('portrait') === 0;
    return (window.innerHeight >= window.innerWidth) === wantPortrait;
}

let _lastAspectPortrait = window.innerHeight >= window.innerWidth;
let _resizeTimer = null;
window.addEventListener('resize', () => {
    if (_resizeTimer) clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
        _resizeTimer = null;
        // If the aspect flipped (landscape↔portrait) without an orientationchange
        // event, treat it as a rotation and run the full settle.
        const portraitNow = window.innerHeight >= window.innerWidth;
        if (portraitNow !== _lastAspectPortrait) { settleViewportLayout(); return; }
        applyViewportLayout();
    }, 150);
});

// Orientation flips (portrait↔landscape) are the hard case: the browser reports the
// OLD (stale) innerWidth/innerHeight for a beat after rotating, and if we apply that
// and stop, the portrait UI is laid out with landscape dimensions and stays broken
// until reload. So: keep re-applying until the reported size actually matches the
// device orientation (via screen.orientation) AND has gone stable — i.e. "rebuild
// on drastic size change", but anchored to a reliable orientation signal rather than
// a guessed delay.
let _viewportSettleId = 0;
function settleViewportLayout() {
    const myId = ++_viewportSettleId;
    _lastCanvasBW = _lastCanvasBH = -1;   // force the next resize through the guard
    const start = Date.now();
    let lastW = -1, lastH = -1, stable = 0;
    const tick = () => {
        if (myId !== _viewportSettleId) return;   // superseded by a newer rotation
        const w = window.innerWidth, h = window.innerHeight;
        const oriented = _viewportMatchesOrientation();
        // Only commit a layout once the reported size reflects the real orientation;
        // before that the dimensions are stale and would lock in a broken UI.
        if (oriented) {
            applyViewportLayout();
            if (w === lastW && h === lastH) stable++;
            else { stable = 0; lastW = w; lastH = h; }
        }
        if ((oriented && stable >= 2) || Date.now() - start > 2500) {
            _lastAspectPortrait = h >= w;
            _lastCanvasBW = _lastCanvasBH = -1;
            applyViewportLayout();                // final forced relayout
            return;
        }
        setTimeout(tick, 80);
    };
    tick();
}
window.addEventListener('orientationchange', settleViewportLayout);
if (window.screen && window.screen.orientation && window.screen.orientation.addEventListener) {
    window.screen.orientation.addEventListener('change', settleViewportLayout);
}
if (window.matchMedia) {
    const _mqlPortrait = window.matchMedia('(orientation: portrait)');
    const _onOrient = () => settleViewportLayout();
    if (_mqlPortrait.addEventListener) _mqlPortrait.addEventListener('change', _onOrient);
    else if (_mqlPortrait.addListener) _mqlPortrait.addListener(_onOrient);
}
// visualViewport resize fires as the browser chrome settles after rotation.
if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
        if (_resizeTimer) clearTimeout(_resizeTimer);
        _resizeTimer = setTimeout(() => { _resizeTimer = null; applyViewportLayout(); }, 150);
    });
}

function setupControls() {
    window.addEventListener('keydown', (e) => {
        gameState.keys[e.code] = true;
    });
    window.addEventListener('keyup', (e) => { gameState.keys[e.code] = false; });
    window.addEventListener('blur', () => { gameState.keys = {}; });
    window.addEventListener('wheel', (e) => {
        // Disable scroll zoom while in an active race
        if (gameState.race && gameState.race.active && gameState.race.session && gameState.race.session.phase === 'race') {
            e.preventDefault();
            return;
        }
        // Disable scroll zoom while azkar overlay is open
        if (gameState.azkar && gameState.azkar.active) return;
        const zoomSpeed = 0.001;
        gameState.zoom -= e.deltaY * zoomSpeed;
        gameState.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, gameState.zoom));
    }, { passive: false });

    gameState.canvas.addEventListener('mousedown', (e) => {
        const clickWorld = screenToWorld(e.clientX, e.clientY);
        const player = gameState.players[gameState.userId];
        const clickedRaceBtn = player && isBreakActive() && isInBreakRoom(player.y) &&
            gameState.activeRaceZone &&
            Math.hypot(clickWorld.x - RACE_BTN_CX, clickWorld.y - RACE_BTN_CY) < RACE_BTN_R + 24;
        if (clickedRaceBtn) {
            triggerRaceTeleport();
            return;
        }
        const clickedCoffeeBtn = player && isBreakActive() && isInBreakRoom(player.y) &&
            gameState.activeCoffeeZone &&
            Math.hypot(clickWorld.x - COFFEE_BTN_CX, clickWorld.y - COFFEE_BTN_CY) < COFFEE_BTN_R + 24;
        if (clickedCoffeeBtn) { triggerCoffeeTeleport(); return; }
        const clickedBossBtn = player && isBreakActive() && isInBreakRoom(player.y) &&
            gameState.activeLaptopBossZone &&
            Math.hypot(clickWorld.x - LAPTOP_BOSS_BTN_CX, clickWorld.y - LAPTOP_BOSS_BTN_CY) < LAPTOP_BOSS_BTN_R + 24;
        if (clickedBossBtn) { triggerLaptopBossTeleport(); return; }
        if (gameState.pomodoro.active || gameState.freeMode.active) return;
        if (gameState.activeLaptop && !gameState.isLockedIn && !gameState.anim.active) {
            if (gameState.activeLaptop.claimedBy) return;
            showLaptopModeSelect();
        }
    });

    // Handle clicks on the in-game results overlay 'عودة' button
    gameState.canvas.addEventListener('click', (e) => {
        const rect = gameState.canvas.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        if (gameState.race && gameState.race.showResultsInGame) {
            const btn = gameState.race.resultsButtonRect;
            if (btn && cx >= btn.x && cx <= btn.x + btn.w && cy >= btn.y && cy <= btn.y + btn.h) {
                // User clicked return button in results overlay
                returnFromRace(true);
                gameState.race.showResultsInGame = false;
                gameState.race.finishedSession = null;
                gameState.race.resultsButtonRect = null;
            }
        }
        if (!gameState.race.showResultsInGame && gameState.coffee && gameState.coffee.showResultsInGame) {
            const cbtn = gameState.coffee.resultsButtonRect;
            const pad = isMobile() ? 10 : 0; // larger tap target on mobile
            if (cbtn && cx >= cbtn.x - pad && cx <= cbtn.x + cbtn.w + pad && cy >= cbtn.y - pad && cy <= cbtn.y + cbtn.h + pad) {
                returnFromCoffee(true);
            }
        }
        if (gameState.laptopBoss && gameState.laptopBoss.showResultsInGame) {
            const bbtn = gameState.laptopBoss.resultsButtonRect;
            const pad = isMobile() ? 10 : 0;
            if (bbtn && cx >= bbtn.x - pad && cx <= bbtn.x + bbtn.w + pad && cy >= bbtn.y - pad && cy <= bbtn.y + bbtn.h + pad) {
                returnFromLaptopBoss(true);
            }
        }
    });

    // Global gesture listener to resume Web Audio Context on first player input
    const resumeAudioEngine = () => {
        if (gameState.focusAudioEngine) {
            gameState.focusAudioEngine.init();
            if (gameState.focusAudioEngine.ctx && gameState.focusAudioEngine.ctx.state === 'suspended') {
                gameState.focusAudioEngine.ctx.resume().then(() => {
                    if (gameState.pomodoro.active && gameState.pomodoro.phase === 'work') {
                        for (const [name, config] of Object.entries(gameState.focusAudioEngine.sounds)) {
                            if (config.active) {
                                gameState.focusAudioEngine.startSound(name);
                            }
                        }
                    }
                }).catch(e=>{});
            }
        }
    };
    window.addEventListener('click', resumeAudioEngine);
    window.addEventListener('keydown', resumeAudioEngine);
}

function startKidnapAnimation(laptop) {
    const player = gameState.players[gameState.userId];
    if (!player) return;

    if (document.hidden) {
        // Skip animation in background, teleport player, lock in, and start work immediately!
        teleportEntity(player, laptop.sitX, laptop.sitY);
        updatePlayerPosition(laptop.sitX, laptop.sitY);
        gameState.isLockedIn = true;
        if (gameState.pomodoro.active && gameState.pomodoro.phase === 'wait') {
            startPomodoroPhase('work');
        } else if (gameState.freeMode.active && gameState.freeMode.phase === 'idle') {
            _startFreeModeWork();
        }
        return;
    }

    gameState.anim.active = true;
    gameState.anim.phase = 'reach';
    gameState.anim.progress = 0;
    gameState.anim.laptop = laptop;
    gameState.anim.startPos = { x: player.x, y: player.y };

    // Play Sound
    if (gameState.focusAudioEngine) {
        gameState.focusAudioEngine.playEffect('kidnap');
    } else {
        playSoundRobust(gameState.sounds.kidnap);
    }
}

function setupFocusPanelUI() {
    const items = document.querySelectorAll('.sound-item');
    items.forEach(item => {
        const soundName = item.dataset.sound;
        const btn = item.querySelector('.sound-toggle-btn');
        const slider = item.querySelector('.sound-vol');

        // Init fill variable
        slider.style.setProperty('--vp', `${slider.value * 100}%`);

        btn.addEventListener('click', () => {
            if (!gameState.focusAudioEngine) return;
            gameState.focusAudioEngine.toggle(soundName);
            if (gameState.focusAudioEngine.sounds[soundName].active) {
                item.classList.add('active');
            } else {
                item.classList.remove('active');
            }
        });

        slider.addEventListener('input', (e) => {
            if (!gameState.focusAudioEngine) return;
            e.target.style.setProperty('--vp', `${e.target.value * 100}%`);
            gameState.focusAudioEngine.updateVolume(soundName, e.target.value);
            gameState.focusAudioEngine.saveToFirebase();
        });
    });

    const masterSlider = document.getElementById('overall-vol');
    if (masterSlider) {
        masterSlider.style.setProperty('--vp', `${masterSlider.value * 100}%`);
        masterSlider.addEventListener('input', (e) => {
            if (!gameState.focusAudioEngine) return;
            e.target.style.setProperty('--vp', `${e.target.value * 100}%`);
            gameState.focusAudioEngine.updateOverallVolume(e.target.value);
        });
    }

    const taskInput = document.getElementById('current-task-input');
    if (taskInput) {
        let taskTimeout;
        taskInput.addEventListener('input', (e) => {
            clearTimeout(taskTimeout);
            taskTimeout = setTimeout(() => {
                if (!gameState.userId) return;
                const updates = {};
                updates[`users/${gameState.userId}/currentTask`] = e.target.value;
                update(ref(database), updates);
            }, 500);
        });
    }

    // YouTube focus player UI
    const ytInput = document.getElementById('yt-url-input');
    const ytLoadBtn = document.getElementById('yt-load-btn');
    const miniPlayPause = document.getElementById('mini-yt-playpause');
    const miniRepeat = document.getElementById('mini-yt-repeat');
    const miniBack = document.getElementById('mini-yt-back10');
    const miniForward = document.getElementById('mini-yt-forward10');
    const miniSlider = document.getElementById('mini-yt-slider');

    if (ytLoadBtn && ytInput) {
        ytLoadBtn.addEventListener('click', async () => {
            const url = ytInput.value.trim();
            if (!url || !gameState.focusYTPlayer) return;
            await gameState.focusYTPlayer.loadUrl(url, 0, true);
        });
    }

    if (miniPlayPause) {
        miniPlayPause.addEventListener('click', () => {
            if (!gameState.focusYTPlayer?.player) return;
            const state = gameState.focusYTPlayer.player.getPlayerState?.() ?? -1;
            if (state === 1) { gameState.focusYTPlayer.pause(); }
            else { gameState.focusYTPlayer.resume(); }
        });
    }
    if (miniRepeat) {
        miniRepeat.addEventListener('click', () => {
            if (!gameState.focusYTPlayer) return;
            gameState.focusYTPlayer.setLoop(!gameState.focusYTPlayer.loop);
            miniRepeat.classList.toggle('active', gameState.focusYTPlayer.loop);
        });
    }
    if (miniBack) miniBack.addEventListener('click', () => { gameState.focusYTPlayer?.back(10); });
    if (miniForward) miniForward.addEventListener('click', () => { gameState.focusYTPlayer?.forward(10); });
    // Waveform scrub — use direct mouse position to avoid range-input thumb-offset bugs
    const waveWrap = document.getElementById('yt-wave-wrap');
    if (waveWrap) {
        let dragging = false;

        const getPct = (e) => {
            const rect = waveWrap.getBoundingClientRect();
            return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        };

        const updateTimeDisplay = (sec, dur) => {
            const timeEl = document.getElementById('mini-yt-time');
            if (!timeEl) return;
            const curSpan = timeEl.querySelector('.yt-time-cur');
            const durSpan = timeEl.querySelector('.yt-time-dur');
            if (curSpan) curSpan.textContent = formatTime(sec);
            if (durSpan) durSpan.textContent = formatTime(dur);
            const slider = document.getElementById('mini-yt-slider');
            if (slider && dur > 0) slider.value = Math.round((sec / dur) * 100);
        };

        waveWrap.addEventListener('mousedown', (e) => {
            if (!gameState.focusYTPlayer?.player) return;
            dragging = true;
            const pct = getPct(e);
            const dur = gameState.focusYTPlayer.player.getDuration() || 0;
            updateTimeDisplay(dur * pct, dur);
            if (gameState.focusYTPlayer._waveAnimId == null)
                gameState.focusYTPlayer._drawWaveform(pct);
            e.preventDefault();
        });

        window.addEventListener('mousemove', (e) => {
            if (!dragging || !gameState.focusYTPlayer?.player) return;
            const pct = getPct(e);
            const dur = gameState.focusYTPlayer.player.getDuration() || 0;
            updateTimeDisplay(dur * pct, dur);
            gameState.focusYTPlayer._drawWaveform(pct);
        }, { passive: true });

        window.addEventListener('mouseup', async (e) => {
            if (!dragging) return;
            dragging = false;
            if (!gameState.focusYTPlayer?.player) return;
            const pct = getPct(e);
            const dur = gameState.focusYTPlayer.player.getDuration() || 0;
            const sec = Math.round(dur * pct);
            updateTimeDisplay(sec, dur);
            await gameState.focusYTPlayer.seekTo(sec);
            if (gameState.userId) update(ref(database), { [`users/${gameState.userId}/focusPlayer/timestamp`]: sec });
        });
    }

    // Volume slider for YouTube player — sync to Firebase
    const ytVolSlider = document.getElementById('yt-volume-slider');
    if (ytVolSlider) {
        ytVolSlider.style.setProperty('--vp', `${ytVolSlider.value}%`);
        ytVolSlider.addEventListener('input', (e) => {
            const pct = parseFloat(e.target.value);
            e.target.style.setProperty('--vp', `${pct}%`);
            if (gameState.focusYTPlayer) {
                gameState.focusYTPlayer.setVolumePercent(pct);
                if (gameState.userId) {
                    update(ref(database), { [`users/${gameState.userId}/focusPlayer/volume`]: pct });
                }
            }
        });
    }

}

function setupRaceUI() {
    const startBtn = document.getElementById('race-start');
    const returnBtn = document.getElementById('race-return');
    if (startBtn) startBtn.addEventListener('click', startHostedRace);
    if (returnBtn) {
        returnBtn.addEventListener('click', () => {
            const session = gameState.race.session;
            if (!session) {
                hideRacePanel();
                return;
            }
            if (session.phase === 'lobby') {
                if (session.hostId === gameState.userId) {
                    update(ref(database), { [raceSessionPath()]: null });
                } else {
                    update(ref(database), { [raceSessionPath(`participants/${gameState.userId}`)]: null });
                }
                hideRacePanel();
            } else {
                returnFromRace(true);
            }
        });
    }
}

// ─── Mobile UI helpers ────────────────────────────────────────────────────────

/** Hide or restore leave-wrap and logout-btn during minigames */
function setMinigameHideUI(hidden) {
    const leaveWrap = document.getElementById('leave-wrap');
    const logoutBtn = document.getElementById('logout-btn');
    const miniLeave = document.getElementById('minigame-leave-btn');
    if (leaveWrap) leaveWrap.style.visibility = hidden ? 'hidden' : '';
    if (logoutBtn) logoutBtn.style.visibility = hidden ? 'hidden' : '';
    if (miniLeave) miniLeave.style.display = hidden ? 'block' : 'none';
    // Hide the azkar button while in a minigame. updateAzkarSystem doesn't run during
    // a minigame (the loop early-returns), so the button would otherwise keep its
    // pre-minigame visible state and open the azkar overlay over the live game.
    // When the minigame ends, updateAzkarButton re-shows it on the next frame.
    const azkarBtn = document.getElementById('azkar-btn');
    if (azkarBtn) azkarBtn.style.visibility = hidden ? 'hidden' : '';
    if (hidden) {
        const azkarFloat = document.getElementById('azkar-focus-float-btn');
        if (azkarFloat) azkarFloat.style.display = 'none';
    }
}

/** Exit a minigame early without affecting the other players' sessions */
/** Fade out all minigame sound effects that may be looping or playing */
function _fadeAllMinigameSounds() {
    const s = gameState.sounds;
    const toFade = [
        s.minigameApplause, s.minigameCountdown, s.minigameCoffeeCountdown,
        s.minigameCoffeeTimerClose, s.minigameCoffeeCollect, s.minigameCoffeeBad,
        s.minigameReady, s.minigameButtonPressed
    ];
    for (const snd of toFade) {
        if (!snd) continue;
        snd.loop = false;
        fadeOutAudio(snd, 400);
    }
}

function leaveMinigame() {
    // Always fade all minigame sounds on early exit
    _fadeAllMinigameSounds();

    if (gameState.race.active) {
        if (gameState.race.sessionKey && gameState.userId) {
            const session = gameState.race.session;
            const participants = session?.participants || {};
            const otherPlayers = Object.keys(participants).filter(uid => uid !== gameState.userId);
            if (otherPlayers.length === 0) {
                // Solo race — delete the whole session so it doesn't linger
                update(ref(database), { [raceSessionPath()]: null }).catch(() => {});
            } else {
                // Others are racing — only remove ourselves from participants
                update(ref(database), { [raceSessionPath(`participants/${gameState.userId}`)]: null }).catch(() => {});
            }
        }
        returnFromRace(true);

    } else if (gameState.coffee.active) {
        const sk = gameState.coffee.sessionKey;
        if (sk && gameState.userId) {
            const session = gameState.coffee.session;
            const participants = session?.participants || {};
            const otherPlayers = Object.keys(participants).filter(uid => uid !== gameState.userId);
            if (otherPlayers.length === 0) {
                // Solo session — let returnFromCoffee delete it normally (sessionKey is still set)
                returnFromCoffee(true);
            } else {
                // Others still playing — only remove ourselves; do NOT delete the session
                update(ref(database), {
                    [lobbyPath(`minigames/coffee/sessions/${sk}/participants/${gameState.userId}`)]: null
                }).catch(() => {});
                gameState.coffee.sessionKey = null; // prevent returnFromCoffee from deleting session
                returnFromCoffee(true);
            }
        } else {
            returnFromCoffee(true);
        }

    } else if (gameState.laptopBoss.active) {
        returnFromLaptopBoss?.();
    }
}

/** Show/hide user card during focus work phase (mobile only) */
function setMobileFocusMode(active) {
    const card     = document.getElementById('user-card');
    const logout   = document.getElementById('logout-btn');
    const joystick = document.getElementById('mobile-joystick');
    const hideCard = active && isMobile();
    if (card)     card.classList.toggle('focus-hidden', hideCard);
    if (logout)   logout.classList.toggle('focus-hidden', hideCard);
    // The joystick hides during focus on any device where it's actually shown
    // (e.g. iPad landscape, where isMobile() is false but the circle is visible).
    if (joystick) joystick.classList.toggle('focus-hidden', active && joystickShouldShow());
    // Refresh the azkar float button immediately (it depends on the card being
    // focus-hidden) so it appears together with the rest of the focus UI instead of
    // lagging up to a second behind the 1/s throttle.
    gameState.azkar._lastButtonRefresh = 0;
    updateAzkarButton();
}

/** Show or hide the race d-pad, and toggle joystick visibility */
function showMobileRaceButtons(show) {
    if (!joystickShouldShow()) return;
    const dpad = document.getElementById('mobile-race-btns');
    const joystick = document.getElementById('mobile-joystick');
    if (dpad) dpad.classList.toggle('hidden', !show);
    if (joystick) joystick.style.display = show ? 'none' : '';
    if (!show) {
        // Reset button state
        gameState.raceButtons.forward  = false;
        gameState.raceButtons.left     = false;
        gameState.raceButtons.right    = false;
        gameState.raceButtons.backward = false;
    }
}

/** Initialize all mobile-only controls: joystick, pinch-zoom, canvas tap, focus drawer, race d-pad */
function initMobileControls() {
    // Always set up the resize observer for mobile class
    setMobileClass();

    // ── Joystick ──────────────────────────────────────────────────────
    const joystickEl = document.getElementById('mobile-joystick');
    const knob = document.getElementById('joystick-knob');
    if (joystickEl && knob) {
        const RADIUS = 58; // max knob displacement in px (outer ring radius - knob radius)
        let joyTouchId = null;
        let joyCenterX = 0;
        let joyCenterY = 0;

        const getJoyCenter = () => {
            const rect = joystickEl.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        };

        joystickEl.addEventListener('touchstart', (e) => {
            e.preventDefault();
            if (joyTouchId !== null) return;
            const t = e.changedTouches[0];
            joyTouchId = t.identifier;
            const center = getJoyCenter();
            joyCenterX = center.x;
            joyCenterY = center.y;
            joystickEl.classList.add('active');
            gameState.joystick.active = true;
        }, { passive: false });

        window.addEventListener('touchmove', (e) => {
            if (joyTouchId === null) return;
            let touch = null;
            for (const t of e.changedTouches) {
                if (t.identifier === joyTouchId) { touch = t; break; }
            }
            if (!touch) return;
            e.preventDefault();

            const rawDx = touch.clientX - joyCenterX;
            const rawDy = touch.clientY - joyCenterY;
            const dist = Math.hypot(rawDx, rawDy);
            const clampedDist = Math.min(dist, RADIUS);
            const mag = clampedDist / RADIUS;

            const nx = dist > 0 ? rawDx / dist : 0;
            const ny = dist > 0 ? rawDy / dist : 0;

            gameState.joystick.dx = nx;
            gameState.joystick.dy = ny;
            gameState.joystick.magnitude = mag;
            gameState.joystick.sprinting = mag > 0.55;

            // Move knob visually
            knob.style.transform = `translate(calc(-50% + ${nx * clampedDist}px), calc(-50% + ${ny * clampedDist}px))`;

            // Sprint visual
            joystickEl.classList.toggle('sprinting', gameState.joystick.sprinting);
        }, { passive: false });

        const endJoy = (e) => {
            let found = false;
            for (const t of e.changedTouches) {
                if (t.identifier === joyTouchId) { found = true; break; }
            }
            if (!found) return;
            joyTouchId = null;
            gameState.joystick.active = false;
            gameState.joystick.dx = 0;
            gameState.joystick.dy = 0;
            gameState.joystick.magnitude = 0;
            gameState.joystick.sprinting = false;
            knob.style.transform = 'translate(-50%, -50%)';
            joystickEl.classList.remove('active', 'sprinting');
        };
        window.addEventListener('touchend', endJoy);
        window.addEventListener('touchcancel', endJoy);
    }

    // ── Pinch-to-zoom (canvas, disabled during race) ──────────────────
    const canvas = document.getElementById('game-canvas');
    if (canvas) {
        let pinchDist = 0;

        canvas.addEventListener('touchstart', (e) => {
            if (e.touches.length === 2) {
                pinchDist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
            }
        }, { passive: true });

        canvas.addEventListener('touchmove', (e) => {
            if (e.touches.length !== 2) return;
            // Disable pinch during active race
            if (gameState.race && gameState.race.active) return;

            const newDist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY
            );
            if (pinchDist === 0) { pinchDist = newDist; return; }

            const scale = newDist / pinchDist;
            gameState.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, gameState.zoom * scale));
            pinchDist = newDist;
            e.preventDefault();
        }, { passive: false });

        canvas.addEventListener('touchend', () => { pinchDist = 0; }, { passive: true });

        // ── Canvas tap → laptop interaction (mobile) ─────────────────
        let tapMoved = false;
        let tapStartX = 0, tapStartY = 0;

        canvas.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            tapMoved = false;
            tapStartX = e.touches[0].clientX;
            tapStartY = e.touches[0].clientY;
        }, { passive: true });

        canvas.addEventListener('touchmove', (e) => {
            if (e.touches.length !== 1) return;
            const dx = e.touches[0].clientX - tapStartX;
            const dy = e.touches[0].clientY - tapStartY;
            if (Math.hypot(dx, dy) > 10) tapMoved = true;
        }, { passive: true });

        canvas.addEventListener('touchend', (e) => {
            if (tapMoved) return; // was a drag, not a tap
            if (e.changedTouches.length !== 1) return;
            const t = e.changedTouches[0];

            // Check race return button tap
            const clickWorld = screenToWorld(t.clientX, t.clientY);
            const player = gameState.players[gameState.userId];
            const clickedRaceBtn = player && isBreakActive() && isInBreakRoom(player.y) &&
                gameState.activeRaceZone &&
                Math.hypot(clickWorld.x - RACE_BTN_CX, clickWorld.y - RACE_BTN_CY) < RACE_BTN_R + 24;
            if (clickedRaceBtn) { triggerRaceTeleport(); return; }
            const clickedCoffeeBtn = player && isBreakActive() && isInBreakRoom(player.y) &&
                gameState.activeCoffeeZone &&
                Math.hypot(clickWorld.x - COFFEE_BTN_CX, clickWorld.y - COFFEE_BTN_CY) < COFFEE_BTN_R + 24;
            if (clickedCoffeeBtn) { triggerCoffeeTeleport(); return; }
            const clickedBossBtn = player && isBreakActive() && isInBreakRoom(player.y) &&
                gameState.activeLaptopBossZone &&
                Math.hypot(clickWorld.x - LAPTOP_BOSS_BTN_CX, clickWorld.y - LAPTOP_BOSS_BTN_CY) < LAPTOP_BOSS_BTN_R + 24;
            if (clickedBossBtn) { triggerLaptopBossTeleport(); return; }

            // Boss results overlay return button
            if (gameState.laptopBoss && gameState.laptopBoss.showResultsInGame) {
                const rect = canvas.getBoundingClientRect();
                const cx = t.clientX - rect.left;
                const cy = t.clientY - rect.top;
                const bbtn = gameState.laptopBoss.resultsButtonRect;
                const pad = 10;
                if (bbtn && cx >= bbtn.x - pad && cx <= bbtn.x + bbtn.w + pad && cy >= bbtn.y - pad && cy <= bbtn.y + bbtn.h + pad) {
                    returnFromLaptopBoss(true);
                    return;
                }
            }

            // Check results button tap
            if (gameState.race && gameState.race.showResultsInGame) {
                const rect = canvas.getBoundingClientRect();
                const cx = t.clientX - rect.left;
                const cy = t.clientY - rect.top;
                const btn = gameState.race.resultsButtonRect;
                if (btn && cx >= btn.x && cx <= btn.x + btn.w && cy >= btn.y && cy <= btn.y + btn.h) {
                    returnFromRace(true);
                    gameState.race.showResultsInGame = false;
                    gameState.race.finishedSession = null;
                    gameState.race.resultsButtonRect = null;
                    return;
                }
            }

            // Open laptop / mode select
            if (gameState.pomodoro.active || gameState.freeMode.active) return;
            if (gameState.activeLaptop && !gameState.isLockedIn && !gameState.anim.active) {
                if (gameState.activeLaptop.claimedBy) return;
                showLaptopModeSelect();
            }
        }, { passive: true });
    }

    // ── Focus sounds drawer (drag handle) ─────────────────────────────
    const drawer = document.getElementById('focus-sounds-panel');
    const handle = document.getElementById('drawer-handle');
    if (drawer && handle) {
        let dragStartY = 0;
        let dragStartTranslate = 0; // will be set on touch start
        let currentTranslate = 0;
        let isDraggingDrawer = false;
        const SNAP_THRESHOLD = 0.4; // fraction of drawer height

        const getCollapsedTranslate = () => {
            return drawer.offsetHeight - 72; // 72px visible when collapsed
        };

        handle.addEventListener('touchstart', (e) => {
            if (!isMobile()) return;
            e.preventDefault();
            isDraggingDrawer = true;
            dragStartY = e.touches[0].clientY;
            // Determine current position from class
            dragStartTranslate = drawer.classList.contains('drawer-open') ? 0 : getCollapsedTranslate();
            currentTranslate = dragStartTranslate;
            drawer.style.transition = 'none';
        }, { passive: false });

        window.addEventListener('touchmove', (e) => {
            if (!isDraggingDrawer) return;
            e.preventDefault();
            const dy = e.touches[0].clientY - dragStartY;
            const collapsed = getCollapsedTranslate();
            currentTranslate = Math.max(0, Math.min(collapsed, dragStartTranslate + dy));
            drawer.style.transform = `translateY(${currentTranslate}px)`;
        }, { passive: false });

        const endDrag = () => {
            if (!isDraggingDrawer) return;
            isDraggingDrawer = false;
            drawer.style.transition = '';

            const collapsed = getCollapsedTranslate();
            const openThreshold = collapsed * SNAP_THRESHOLD;

            if (currentTranslate < openThreshold) {
                // Snap open
                drawer.classList.add('drawer-open');
                drawer.style.transform = '';
            } else {
                // Snap closed (but still visible as handle)
                drawer.classList.remove('drawer-open');
                drawer.style.transform = '';
            }
        };
        window.addEventListener('touchend', endDrag);
        window.addEventListener('touchcancel', endDrag);
    }

    // ── Mobile race d-pad buttons ─────────────────────────────────────
    const setupDpadBtn = (id, key) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        const setPressed = (val) => {
            gameState.raceButtons[key] = val;
            btn.classList.toggle('pressed', val);
        };
        btn.addEventListener('touchstart', (e) => { e.preventDefault(); setPressed(true); if (navigator.vibrate) navigator.vibrate(18); }, { passive: false });
        btn.addEventListener('touchend', (e) => { e.preventDefault(); setPressed(false); }, { passive: false });
        btn.addEventListener('touchcancel', () => setPressed(false));
    };
    setupDpadBtn('race-btn-fwd',  'forward');
    setupDpadBtn('race-btn-left', 'left');
    setupDpadBtn('race-btn-right','right');
    setupDpadBtn('race-btn-bwd',  'backward');

    // ── Mobile boss-fight buttons ─────────────────────────────────────
    const setupBossBtn = (id, key, isJump) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        const setPressed = (val) => {
            gameState.laptopBossButtons[key] = val;
            btn.classList.toggle('pressed', val);
            if (isJump && val) {
                // edge-trigger for variable jump height
                gameState.laptopBossButtons.jumpPressed = true;
            }
        };
        btn.addEventListener('touchstart', (e) => { e.preventDefault(); setPressed(true); if (navigator.vibrate) navigator.vibrate(14); }, { passive: false });
        btn.addEventListener('touchend',   (e) => { e.preventDefault(); setPressed(false); }, { passive: false });
        btn.addEventListener('touchcancel',()=> setPressed(false));
        // Also mouse for desktop testing
        btn.addEventListener('mousedown',  (e) => { e.preventDefault(); setPressed(true); });
        btn.addEventListener('mouseup',    (e) => { e.preventDefault(); setPressed(false); });
        btn.addEventListener('mouseleave', () => setPressed(false));
    };
    setupBossBtn('boss-btn-left',  'left');
    setupBossBtn('boss-btn-right', 'right');
    setupBossBtn('boss-btn-jump',  'jump', true);
}

// ─────────────────────────────────────────────────────────────────────────────

function listenToRace() {
    onValue(ref(database, lobbyPath('minigames/race/sessions')), (snap) => {
        const sessions = snap.val() || {};

        // Build active (non-stale) session map and prune stale ones from Firebase
        const active = {};
        for (const [key, s] of Object.entries(sessions)) {
            if (!s) continue;
            if (cleanupStaleRaceSession(s, key)) continue;
            active[key] = s;
        }
        gameState.race.activeSessions = active;

        // Find the session this player is a participant in
        let myKey = null, mySession = null;
        for (const [key, s] of Object.entries(active)) {
            if (s.participants?.[gameState.userId]) { myKey = key; mySession = s; break; }
        }

        if (!mySession) {
            if (gameState.race.active) returnFromRace(false);
            gameState.race.session = null;
            gameState.race.sessionKey = null;
            gameState.race.localCar = null;
            gameState.race.carVisuals = {};
            hideRacePanel();
            hideRaceHud();
            return;
        }

        gameState.race.session = mySession;
        gameState.race.sessionKey = myKey;
        gameState.race.returnPoint = mySession.participants[gameState.userId].returnPoint || gameState.race.returnPoint;

        if (mySession.phase === 'lobby') {
            gameState.race.active = false;
            gameState.race.localCar = null;
            showRaceLobby(mySession);
            hideRaceHud();
        } else if (mySession.phase === 'teleporting') {
            hideRacePanel();
            if (!gameState.race.teleportAnim) {
                const elapsed = Math.max(0, (serverNow() - (mySession.teleportAt || serverNow())) / 1000);
                gameState.race.teleportAnim = {
                    t: elapsed, phase: 'fly', flyProgress: 0, screenAlpha: 0,
                    players: Object.keys(mySession.participants || {}).map(uid => {
                        const p = gameState.players[uid];
                        return { userId: uid, startX: p ? p.x : 0, startY: p ? p.y : 0 };
                    }),
                    pendingSession: null, raceStarted: false,
                    isHost: mySession.hostId === gameState.userId
                };
            }
        } else if (mySession.phase === 'race') {
            // Host: watch for all-ready then set startTime (1-second minimum wait)
            if (mySession.hostId === gameState.userId && mySession.startTime === 0) {
                const parts = Object.values(mySession.participants || {});
                const allReady = parts.length > 0 && parts.every(p => p.ready);
                if (allReady && !gameState.race.startTimeScheduled) {
                    gameState.race.startTimeScheduled = true;
                    const newestReady = Math.max(...parts.map(p => p.ready || 0));
                    const delay = Math.max(0, newestReady + 1000 - serverNow());
                    setTimeout(() => {
                        update(ref(database), { [raceSessionPath('startTime')]: serverNow() + 3500 });
                        gameState.race.startTimeScheduled = false;
                    }, delay);
                }
                if (!gameState.race.readyFallbackTimer) {
                    gameState.race.readyFallbackTimer = setTimeout(() => {
                        if (gameState.race.session?.startTime === 0) {
                            update(ref(database), { [raceSessionPath('startTime')]: serverNow() + 3500 });
                        }
                        gameState.race.readyFallbackTimer = null;
                    }, 5000);
                }
            }
            if (mySession.startTime > 0) {
                gameState.race.startTimeScheduled = false;
                if (gameState.race.readyFallbackTimer) {
                    clearTimeout(gameState.race.readyFallbackTimer);
                    gameState.race.readyFallbackTimer = null;
                }
            }
            hideRacePanel();
            if (gameState.race.teleportAnim) {
                gameState.race.teleportAnim.pendingSession = gameState.race.teleportAnim.pendingSession || mySession;
            } else {
                startLocalRace(mySession);
            }
        } else if (mySession.phase === 'finished') {
            gameState.race.active = true;
            gameState.race.session = mySession;
            gameState.race.showResultsInGame = true;
            gameState.race.finishedSession = mySession;
            hideRacePanel();
            hideRaceHud();
            scheduleRaceReturn();
        }
    });
}


function showRaceLobby(session) {
    const panel = document.getElementById('race-panel');
    const title = document.getElementById('race-title');
    const status = document.getElementById('race-status');
    const startBtn = document.getElementById('race-start');
    const returnBtn = document.getElementById('race-return');
    if (!panel || !title || !status || !startBtn || !returnBtn) return;

    title.textContent = 'سباق السيارات';
    status.textContent = session.hostId === gameState.userId ? 'أنت المضيف' : 'بانتظار المضيف';
    startBtn.style.display = session.hostId === gameState.userId ? 'block' : 'none';
    returnBtn.textContent = session.hostId === gameState.userId ? 'إلغاء' : 'خروج';
    returnBtn.style.display = 'block';
    renderRacePlayerList(session);
    panel.classList.remove('hidden');
}

function showRaceResults(session) {
    const panel = document.getElementById('race-panel');
    const title = document.getElementById('race-title');
    const status = document.getElementById('race-status');
    const startBtn = document.getElementById('race-start');
    const returnBtn = document.getElementById('race-return');
    if (!panel || !title || !status || !startBtn || !returnBtn) return;

    title.textContent = 'النتائج';
    status.textContent = 'سيتم إعادتك بعد لحظات';
    startBtn.style.display = 'none';
    returnBtn.textContent = 'عودة الآن';
    returnBtn.style.display = 'block';
    renderRacePlayerList(session, true);
    panel.classList.remove('hidden');
}

function showRaceMessage(message) {
    const panel = document.getElementById('race-panel');
    const title = document.getElementById('race-title');
    const list = document.getElementById('race-player-list');
    const status = document.getElementById('race-status');
    const startBtn = document.getElementById('race-start');
    const returnBtn = document.getElementById('race-return');
    if (!panel || !title || !list || !status || !startBtn || !returnBtn) return;
    title.textContent = 'سباق السيارات';
    list.innerHTML = '';
    status.textContent = message;
    startBtn.style.display = 'none';
    returnBtn.textContent = 'إغلاق';
    returnBtn.style.display = 'block';
    panel.classList.remove('hidden');
}

function renderRacePlayerList(session, showResults = false) {
    const list = document.getElementById('race-player-list');
    if (!list) return;
    const participants = Object.entries(session.participants || {})
        .sort(([, a], [, b]) => (a.index || 0) - (b.index || 0));
    const results = session.results || {};
    const rows = showResults
        ? participants.sort(([idA], [idB]) => (results[idA]?.finishTime || Infinity) - (results[idB]?.finishTime || Infinity))
        : participants;

    list.innerHTML = rows.map(([id, p], index) => {
        const result = results[id];
        const meta = showResults ? (result ? formatRaceTime(result.finishTime) : 'لم ينته') : (id === session.hostId ? 'المضيف' : 'جاهز');
        const rank = showResults ? `<span class="race-rank">${index + 1}</span>` : '<span class="race-rank race-rank-empty"></span>';
        const avatar = p.avatar ? `<img src="${p.avatar}" alt="">` : `<span>${(p.username || '?').charAt(0).toUpperCase()}</span>`;
        return `
            <div class="race-player-row">
                ${rank}
                <div class="race-avatar">${avatar}</div>
                <div class="race-player-name">${p.username || 'لاعب'}</div>
                <div class="race-player-meta">${meta}</div>
            </div>
        `;
    }).join('');
}

function hideRacePanel() {
    const panel = document.getElementById('race-panel');
    if (panel) panel.classList.add('hidden');
}

function hideRaceHud() {
    const hud = document.getElementById('race-hud');
    if (hud) hud.classList.add('hidden');
}

function startHostedRace() {
    const session = gameState.race.session;
    if (!session || session.hostId !== gameState.userId || session.phase !== 'lobby') return;
    if (!isRaceTrackReady()) {
        showRaceMessage('جاري تحميل حلبة السباق، حاول مرة أخرى');
        return;
    }

    const cars = {};
    Object.keys(session.participants || {}).forEach((userId) => {
        const participant = session.participants[userId];
        cars[userId] = createRaceCar(participant.index || 0, participant.username || 'لاعب');
    });

    update(ref(database), {
        [raceSessionPath('phase')]: 'race',
        [raceSessionPath('startTime')]: 0,
        [raceSessionPath('cars')]: cars,
        [raceSessionPath('results')]: null
    });
}

function startLocalRace(session) {
    if (gameState.race.active && gameState.race.localCar) return;
    const participant = session.participants[gameState.userId];
    const freshCar = createRaceCar(participant.index || 0, participant.username || gameState.currentUser || 'لاعب');
    gameState.race.active = true;
    gameState.race.localResultSent = false;
    gameState.race.returnPoint = participant.returnPoint;
    gameState.race.localCar = freshCar;
    gameState.race.carVisuals = {};
    // Show mobile race d-pad (hide joystick during race)
    showMobileRaceButtons(true);
    setMinigameHideUI(true);
    // Remember previous zoom and double it for race view
    gameState.race.prevZoom = gameState.zoom || 1;
    gameState.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, (gameState.race.prevZoom || 1) * 2));
    const car = gameState.race.localCar;
    car.ignoreFinishUntilLeave = true;
    car.leftFinishZone = false;
    car.canCountLap = false;
    car.lapDistance = 0;
    car.lastLapAt = 0;
    gameState.race.camera.x = -car.x;
    gameState.race.camera.y = -car.y;
    // Mobile: init camera angle to match car's starting heading so camera doesn't spin on race start
    gameState.race.camera.angle = isMobile() ? -(car.angle + Math.PI / 2) : 0;
    gameState.race.countdownSoundPlayed = false;
    // Mark this user as working so others see avatar bobbing while racing
    update(ref(database), {
        [raceSessionPath(`participants/${gameState.userId}/ready`)]: serverNow(),
        [`users/${gameState.userId}/isWorking`]: true
    });
}

function createRaceCar(index, username) {
    const start = gameState.race.track?.startWorld || { x: 0, y: 0, angle: 0 };
    const laneOffset = (index - 2.5) * 58;
    const x = start.x - Math.sin(start.angle) * laneOffset;
    const y = start.y + Math.cos(start.angle) * laneOffset;
    return {
        username,
        x,
        y,
        angle: start.angle,
        speed: 0,
        distance: 0,
        lap: 1,
        raceStarted: false,
        leftFinishZone: false,
        canCountLap: false,
        ignoreFinishUntilLeave: true,
        lapDistance: 0,
        lastLapAt: 0,
        finished: false
    };
}

function updateRaceMode() {
    const session = gameState.race.session;
    const car = gameState.race.localCar;
    if (!session || !car) return;

    if (!isBreakActive()) {
        if (session.hostId === gameState.userId) update(ref(database), { [raceSessionPath()]: null });
        returnFromRace(false);
        return;
    }

    const now = serverNow();
    // Play countdown sound once when countdown is actually ticking (startTime set and in future)
    if (session.startTime > 0 && now < session.startTime && !gameState.race.countdownSoundPlayed) {
        gameState.race.countdownSoundPlayed = true;
        playSoundRobust(gameState.sounds.minigameCountdown);
    }
    if (session.startTime === 0 || now < (session.startTime || 1) || car.finished) return;

    const up    = gameState.keys['KeyW'] || gameState.keys['ArrowUp']    || gameState.raceButtons.forward;
    const down  = gameState.keys['KeyS'] || gameState.keys['ArrowDown']  || gameState.raceButtons.backward;
    const left  = gameState.keys['KeyA'] || gameState.keys['ArrowLeft']  || gameState.raceButtons.left;
    const right = gameState.keys['KeyD'] || gameState.keys['ArrowRight'] || gameState.raceButtons.right;
    const dt = gameState.dtFactor;

    if (up) car.speed += 0.16 * dt * RACE_SPEED_FACTOR;
    if (down) car.speed -= 0.11 * dt * RACE_SPEED_FACTOR;
    if (!up && !down) car.speed *= Math.pow(0.982, dt);
    // Apply global race speed factor to acceleration and clamp speeds
    // Scale the current speed clamp to RACE_SPEED_FACTOR
    car.speed = Math.max(-3.2 * RACE_SPEED_FACTOR, Math.min(8.4 * RACE_SPEED_FACTOR, car.speed));

    const turn = (right ? 1 : 0) - (left ? 1 : 0);
    if (turn !== 0) {
        // On mobile allow turning from a standstill (d-pad needs it); desktop keeps the speed gate
        const speedOk = isMobile() ? true : Math.abs(car.speed) > 0.25;
        if (speedOk) {
            // Use forward direction when stopped so turn feels natural
            const dir = car.speed !== 0 ? Math.sign(car.speed) : 1;
            car.angle += turn * 0.047 * dt * dir;
        }
    }

    const prevX = car.x;
    const prevY = car.y;
    car.x += Math.cos(car.angle) * car.speed * dt;
    car.y += Math.sin(car.angle) * car.speed * dt;
    clampCarToRaceBounds(car);

    const zone = getRaceZoneAtWorld(car.x, car.y);
    const surface = getRaceSurfaceMultiplier(zone);
    if (surface < 1) {
        car.speed *= Math.pow(surface, dt);
    }
    if (zone === RACE_ZONE_FAST || zone === RACE_ZONE_SLOW || zone === RACE_ZONE_FINISH) {
        car.lapDistance = (car.lapDistance || 0) + Math.hypot(car.x - prevX, car.y - prevY);
    }

    updateRaceProgress(car);
    syncRaceCar(false);

    if (car.distance >= RACE_LAPS && !gameState.race.localResultSent) {
        car.finished = true;
        car.speed = 0;
        gameState.race.localResultSent = true;
        const finishTime = serverNow() - (session.startTime || serverNow());
        const participants = Object.keys(session.participants || {});
        const results = { ...(session.results || {}), [gameState.userId]: { finishTime, username: car.username } };
        const updates = {
            [raceSessionPath(`results/${gameState.userId}`)]: { finishTime, username: car.username },
            [raceSessionPath(`cars/${gameState.userId}/finished`)]: true,
            [raceSessionPath(`cars/${gameState.userId}/lap`)]: RACE_LAPS
        };
        if (participants.every(id => results[id])) {
            updates[raceSessionPath('phase')] = 'finished';
            updates[raceSessionPath('finishedAt')] = Date.now();
        }
        update(ref(database), updates);
    }
}

function updateRaceProgress(car) {
    const zone = getRaceZoneAtWorld(car.x, car.y);
    const inFinish = zone === RACE_ZONE_FINISH;

    if (car.ignoreFinishUntilLeave) {
        if (!inFinish) car.ignoreFinishUntilLeave = false;
        return;
    }

    if (inFinish && car.leftFinishZone && car.canCountLap) {
        const now = Date.now();
        const sinceLastLap = now - (car.lastLapAt || 0);
        if (sinceLastLap >= RACE_MIN_LAP_MS && (car.lapDistance || 0) >= RACE_MIN_LAP_DIST) {
            car.distance = Math.min(RACE_LAPS, car.distance + 1);
            car.lap = Math.min(RACE_LAPS, car.distance + 1);
            car.lastLapAt = now;
            car.lapDistance = 0;
            car.canCountLap = false;
            car.leftFinishZone = false;
            // Start looping applause on final lap
            if (car.lap >= RACE_LAPS && !gameState.race.applausePlayed) {
                gameState.race.applausePlayed = true;
                const ap = gameState.sounds.minigameApplause;
                ap.loop = true;
                ap.volume = 1;
                playSoundRobust(ap);
            }
        }
    }

    if (!inFinish) {
        car.leftFinishZone = true;
        car.canCountLap = true;
    }
}

function syncRaceCar(force) {
    const now = Date.now();
    if (!force && now - gameState.race.lastSync < 90) return;
    gameState.race.lastSync = now;
    const car = gameState.race.localCar;
    if (!car || !gameState.race.session) return;
    update(ref(database), {
        [raceSessionPath(`cars/${gameState.userId}`)]: {
            username: car.username,
            x: car.x, y: car.y, angle: car.angle, speed: car.speed,
            distance: car.distance, lap: car.lap, finished: car.finished || false
        }
    });
}

function scheduleRaceReturn() {
    if (gameState.race.finishReturnTimer) return;
    gameState.race.finishReturnTimer = setTimeout(() => returnFromRace(true), 8000);
    if (gameState.race.session && gameState.race.session.hostId === gameState.userId) {
        setTimeout(() => {
            update(ref(database), { [raceSessionPath()]: null });
        }, 11000);
    }
}

function returnFromRace(clearPanel) {
    if (gameState.race.finishReturnTimer) {
        clearTimeout(gameState.race.finishReturnTimer);
        gameState.race.finishReturnTimer = null;
    }
    // Fade out applause if playing
    const ap = gameState.sounds.minigameApplause;
    if (ap) { ap.loop = false; fadeOutAudio(ap, 900); }
    gameState.race.applausePlayed = false;
    const player = gameState.players[gameState.userId];
    const returnPoint = gameState.race.returnPoint;
    if (player && returnPoint) {
        teleportEntity(player, returnPoint.x, returnPoint.y);
        updatePlayerPosition(returnPoint.x, returnPoint.y);
    }
    gameState.race.active = false;
    gameState.race.localCar = null;
    gameState.race.carVisuals = {};
    gameState.race.camera = { x: 0, y: 0, angle: 0 };
    gameState.race.localResultSent = false;
    // Clear working flag so others know the player is no longer racing
    if (gameState.userId) update(ref(database), { [`users/${gameState.userId}/isWorking`]: false });
    // Restore previous zoom if present
    if (gameState.race.prevZoom !== undefined) {
        gameState.zoom = gameState.race.prevZoom;
        delete gameState.race.prevZoom;
    }
    // Clear any in-game results overlay state
    gameState.race.showResultsInGame = false;
    gameState.race.finishedSession = null;
    gameState.race.resultsButtonRect = null;
    if (clearPanel) hideRacePanel();
    hideRaceHud();
    // Hide mobile race d-pad and restore joystick
    showMobileRaceButtons(false);
    setMinigameHideUI(false);
}

function formatRaceTime(ms) {
    if (!Number.isFinite(ms)) return '--:--.---';
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    const millis = Math.floor(ms % 1000);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${millis.toString().padStart(3, '0')}`;
}

function showLaptopModeSelect() {
    // Mobile ghost-click guard: the tap that opens this modal is followed ~300ms
    // later by a synthesized mouse `click` at the same screen point. If a modal
    // button happens to sit under that point it fires immediately (free mode /
    // pomo started "without asking"). Record the open time and ignore button
    // presses that arrive within the ghost-click window.
    gameState._modeSelectOpenedAt = Date.now();
    if (gameState.isSirajGhost) {
        document.getElementById('test-mode-modal').classList.add('active');
    } else {
        document.getElementById('mode-select-modal').classList.add('active');
    }
}

// True while we should swallow synthesized ghost clicks just after the mode
// select modal opened (covers the iOS/Android touch→click ~300ms passthrough).
function modeSelectGhostClick() {
    return gameState._modeSelectOpenedAt && (Date.now() - gameState._modeSelectOpenedAt) < 500;
}

function setupModeSelectUI() {
    const modal = document.getElementById('mode-select-modal');
    if (!modal) return;

    document.getElementById('mode-select-back')?.addEventListener('click', () => {
        juiceCloseThenOpen(modal, null);   // JUICE: sequenced pop-out
    });

    document.getElementById('mode-select-pomo')?.addEventListener('click', () => {
        if (modeSelectGhostClick()) return;
        juiceCloseThenOpen(modal, () => document.getElementById('pomodoro-modal').classList.add('active'));
    });

    document.getElementById('mode-select-free')?.addEventListener('click', () => {
        if (modeSelectGhostClick()) return;
        juiceCloseThenOpen(modal, () => startFreeMode(null, false));
    });
}

function setupPomodoroUI() {
    const modal = document.getElementById('pomodoro-modal');
    const cancelBtn = document.getElementById('pomodoro-cancel');
    const confirmBtn = document.getElementById('pomodoro-confirm');

    ['work', 'break', 'session'].forEach(type => {
        const btns = document.querySelectorAll(`#${type}-options .opt-btn`);
        const input = document.getElementById(`custom-${type}`);

        btns.forEach(btn => {
            btn.addEventListener('click', () => {
                btns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                input.value = '';
            });
        });

        input.addEventListener('input', () => {
            if (input.value) {
                btns.forEach(b => b.classList.remove('active'));
                if (type === 'break') {
                    const errEl = document.getElementById('break-max-error');
                    if (errEl) errEl.textContent = parseInt(input.value) > 15 ? 'الحد الأقصى ١٥ دقيقة' : '';
                }
            } else {
                btns[0].classList.add('active');
                if (type === 'break') {
                    const errEl = document.getElementById('break-max-error');
                    if (errEl) errEl.textContent = '';
                }
            }
        });
    });

    cancelBtn.addEventListener('click', () => {
        juiceCloseThenOpen(modal, () => document.getElementById('mode-select-modal').classList.add('active'));   // JUICE
    });

    confirmBtn.addEventListener('click', () => {
        const getVal = (type, defaultVal) => {
            const input = document.getElementById(`custom-${type}`);
            if (input.value) return parseInt(input.value);
            const activeBtn = document.querySelector(`#${type}-options .opt-btn.active`);
            return activeBtn ? parseInt(activeBtn.dataset.val) : defaultVal;
        };

        const workMins = getVal('work', 25);
        const breakMins = Math.min(15, getVal('break', 5));
        const sessions = getVal('session', 1);

        modal.classList.remove('active');

        if (Notification.permission !== "granted" && Notification.permission !== "denied") {
            Notification.requestPermission();
        }

        const laptop = gameState.lastActiveLaptop;
        if (!laptop || laptop.claimedBy) return;

        gameState.pomodoro.active = true;
        gameState.pomodoro.laptopId = laptop.id;
        gameState.pomodoro.workDuration = workMins;
        gameState.pomodoro.breakDuration = breakMins;
        gameState.pomodoro.sessionsLeft = sessions;
        gameState.pomodoro.totalSessions = sessions;
        gameState.pomodoro.createdAt = Date.now();
        gameState.pomodoro.phase = 'wait';

        const updates = {};
        updates[lobbyPath(`pomodoro/${laptop.id}`)] = {
            claimedBy: gameState.userId,
            phase: 'wait',
            endTime: 0,
            workDuration: workMins,
            breakDuration: breakMins,
            sessionsLeft: sessions,
            totalSessions: sessions,
            createdAt: Date.now()
        };
        update(ref(database), updates);

        startKidnapAnimation(laptop);
    });
}

function setupTestModeUI() {
    const modal = document.getElementById('test-mode-modal');
    const cancelBtn = document.getElementById('test-mode-cancel');
    const confirmBtn = document.getElementById('test-mode-confirm');
    if (!modal || !cancelBtn || !confirmBtn) return;

    cancelBtn.addEventListener('click', () => modal.classList.remove('active'));

    // Free mode test button
    document.getElementById('test-mode-free')?.addEventListener('click', () => {
        modal.classList.remove('active');
        startFreeMode(null, false);
        // Prayer test in free mode
        const testPrayer = document.getElementById('test-prayer-check')?.checked;
        if (testPrayer) {
            const testPrayerKey = document.getElementById('test-prayer-select')?.value || 'Dhuhr';
            const testPrayerData = PRAYER_DATA.find(p => p.key === testPrayerKey) || PRAYER_DATA[1];
            setTimeout(() => {
                if (gameState.freeMode.active) triggerPrayerOverlay(testPrayerData.key, testPrayerData.arabic);
            }, 5000);
        }
    });

    // Toggle prayer picker visibility when checkbox changes
    document.getElementById('test-prayer-check')?.addEventListener('change', (e) => {
        const picker = document.getElementById('test-prayer-picker');
        if (picker) picker.style.display = e.target.checked ? 'block' : 'none';
    });

    confirmBtn.addEventListener('click', () => {
        const getNum = (id, fallback = 0) => Math.max(0, parseInt(document.getElementById(id)?.value) || fallback);
        const workH = getNum('test-work-h');
        const workM = getNum('test-work-m');
        const workS = getNum('test-work-s');
        const breakH = getNum('test-break-h');
        const breakM = getNum('test-break-m');
        const breakS = getNum('test-break-s');
        const sessions = Math.max(1, getNum('test-sessions', 3));

        const workMins = workH * 60 + workM + workS / 60;
        const rawBreakMins = breakH * 60 + breakM + breakS / 60;
        // Enforce minimum 5-second break when a break is configured, to prevent instant-fire confusion
        const breakMins = rawBreakMins > 0 ? Math.max(5 / 60, rawBreakMins) : 0;
        if (workMins <= 0) return;

        const testPrayer = document.getElementById('test-prayer-check')?.checked || false;

        modal.classList.remove('active');
        if (Notification.permission !== 'granted' && Notification.permission !== 'denied') Notification.requestPermission();

        const laptop = gameState.lastActiveLaptop;
        if (!laptop || laptop.claimedBy) return;

        gameState.pomodoro.active = true;
        gameState.pomodoro.laptopId = laptop.id;
        gameState.pomodoro.workDuration = workMins;
        gameState.pomodoro.breakDuration = breakMins;
        gameState.pomodoro.sessionsLeft = sessions;
        gameState.pomodoro.totalSessions = sessions;
        gameState.pomodoro.createdAt = Date.now();
        gameState.pomodoro.phase = 'wait';

        const updates = {};
        updates[lobbyPath(`pomodoro/${laptop.id}`)] = {
            claimedBy: gameState.userId,
            phase: 'wait',
            endTime: 0,
            workDuration: workMins,
            breakDuration: breakMins,
            sessionsLeft: sessions,
            totalSessions: sessions,
            createdAt: Date.now()
        };
        update(ref(database), updates);
        if (gameState.isSirajGhost) {
            onDisconnect(ref(database, lobbyPath(`pomodoro/${laptop.id}`))).remove();
        } else {
            // Free the laptop + stash the session on disconnect (reclaim within 4h).
            trackSessionForReclaim();
        }
        startKidnapAnimation(laptop);

        // Prayer test: fire athan 5 seconds into the session
        if (testPrayer) {
            const testPrayerKey = document.getElementById('test-prayer-select')?.value || 'Dhuhr';
            const testPrayerData = PRAYER_DATA.find(p => p.key === testPrayerKey) || PRAYER_DATA[1];
            setTimeout(() => {
                if (gameState.pomodoro.active || gameState.freeMode.active) {
                    triggerPrayerOverlay(testPrayerData.key, testPrayerData.arabic);
                }
            }, 5000);
        }
    });
}

function showSuccessModal(totalSessions, workDuration, taskText = '') {
    const modal = document.getElementById('success-modal');
    if (!modal) return;

    const totalMins = Math.floor(totalSessions * workDuration);
    document.getElementById('success-total-time').textContent = formatDurationArabic(totalMins);
    document.getElementById('success-sessions-count').textContent = totalSessions;
    const taskEl = document.getElementById('success-task');
    if (taskEl) {
        const cleanTask = taskText.trim();
        taskEl.textContent = cleanTask ? `عملت على ${cleanTask}` : '';
        taskEl.style.display = cleanTask ? 'block' : 'none';
    }

    const localPlayer = gameState.players[gameState.userId];
    const nameEl = document.getElementById('success-name');
    const avatarImg = document.getElementById('success-avatar-img');
    const avatarText = document.getElementById('success-avatar-text');

    if (localPlayer) {
        nameEl.textContent = localPlayer.username;
        if (localPlayer.avatar) {
            avatarImg.src = localPlayer.avatar;
            avatarImg.style.display = 'block';
            avatarText.style.display = 'none';
        } else {
            avatarImg.style.display = 'none';
            avatarText.style.display = 'block';
            avatarText.textContent = localPlayer.username.charAt(0).toUpperCase();
        }
    }

    modal.classList.add('active');

    const closeBtn = document.getElementById('success-close');
    closeBtn.onclick = () => {
        modal.classList.remove('active');
    };

    if (gameState.focusAudioEngine) {
        gameState.focusAudioEngine.playEffect('yipee');
    } else {
        playSoundRobust(gameState.sounds.yipee);
    }
}

function startPomodoroPhase(phase) {
    gameState.pomodoro.phase = phase;
    gameState.pomodoro.transitioning = false;
    const duration = phase === 'work' ? gameState.pomodoro.workDuration : gameState.pomodoro.breakDuration;
    // Shared pomodoro: use host-agreed endTime for perfect sync across clients
    if (phase === 'work' && gameState.sharedPomo.agreedEndTime) {
        gameState.pomodoro.endTime = gameState.sharedPomo.agreedEndTime;
        gameState.sharedPomo.agreedEndTime = 0;
    } else {
        gameState.pomodoro.endTime = Date.now() + duration * 60000;
    }

    if (gameState.pomodoro.laptopId !== null) {
        const updates = {};
        const pomoData = {
            claimedBy: gameState.userId,
            phase: phase,
            endTime: gameState.pomodoro.endTime,
            workDuration: gameState.pomodoro.workDuration,
            breakDuration: gameState.pomodoro.breakDuration,
            sessionsLeft: gameState.pomodoro.sessionsLeft,
            totalSessions: gameState.pomodoro.totalSessions,
            createdAt: gameState.pomodoro.createdAt || Date.now()
        };
        updates[lobbyPath(`pomodoro/${gameState.pomodoro.laptopId}`)] = pomoData;
        // Host pushes phaseEndTime + currentPhase to the live doc so guests stay in sync
        // across break and subsequent work cycles (agreedEndTime only covers the first cycle).
        const _sp = gameState.sharedPomo;
        if (_sp.isHost && _sp.phase === 'active' && _sp.sessionId) {
            updates[spPath(`live/${_sp.sessionId}/phaseEndTime`)] = gameState.pomodoro.endTime;
            updates[spPath(`live/${_sp.sessionId}/currentPhase`)] = phase;
        }
        update(ref(database), updates);
        // Refresh the reclaim stash + re-arm disconnect handlers with the new
        // phase/endTime (no-op for Siraj and shared-pomo via internal guards).
        trackSessionForReclaim();
    }

    // Prayer panel: compact during break (only show next prayer), full during work
    const _pp = document.getElementById('prayer-panel');
    if (_pp) _pp.classList.toggle('break-compact', phase === 'break');

    if (phase === 'break') {
        // Hard-reset any stuck state so the player can always move during break
        gameState.isLockedIn = false;
        if (gameState.anim.active) {
            gameState.anim.active  = false;
            gameState.anim.phase   = 'none';
            gameState.anim.progress = 0;
        }
        // Ensure focus panel isn't blocking the joystick on mobile
        const breakPanel = document.getElementById('focus-sounds-panel');
        if (breakPanel) {
            // Remember whether the drawer was open so we can restore it when work resumes
            gameState._drawerWasOpen = breakPanel.classList.contains('drawer-open');
            breakPanel.classList.remove('active');
        }
        setMobileFocusMode(false);
    } else if (phase === 'work') {
        setMobileFocusMode(true);
        const panel = document.getElementById('focus-sounds-panel');
        if (panel) {
            panel.classList.add('active');
            // Restore drawer open state from before the break
            if (gameState._drawerWasOpen) panel.classList.add('drawer-open');
        }
        const taskPanel = document.getElementById('current-task-panel');
        if (taskPanel) taskPanel.classList.add('active');

        if (gameState.focusAudioEngine) {
            gameState.focusAudioEngine.fadeToMaster(1.0, 2.0);
            for (const [name, config] of Object.entries(gameState.focusAudioEngine.sounds)) {
                if (config.active) {
                    gameState.focusAudioEngine.startSound(name);
                }
            }
            if (gameState.focusYTPlayer) {
                // Use the player's own saved volume (from Firebase), not the mixer's overallVolume
                const targetPct = gameState.focusYTPlayer.volume ?? 80;
                if (gameState.isLockedIn) {
                    // Fade in from silence over 2 s so re-entry feels smooth
                    gameState.focusYTPlayer.setVolumePercent(0);
                    gameState.focusYTPlayer.resume().then(() => {
                        let elapsed = 0;
                        const FADE_MS = 2000;
                        const iv = setInterval(() => {
                            elapsed += 50;
                            gameState.focusYTPlayer.setVolumePercent(
                                Math.min(targetPct, Math.round(targetPct * elapsed / FADE_MS))
                            );
                            if (elapsed >= FADE_MS) clearInterval(iv);
                        }, 50);
                    }).catch(() => {
                        gameState.focusYTPlayer.setVolumePercent(targetPct);
                    });
                } else {
                    gameState.focusYTPlayer.setVolumePercent(targetPct);
                }
            }
        }
    }
    // Wire solo-to-shared upgrade listener whenever a fresh solo pomo starts
    if (phase === 'work' && gameState.sharedPomo.phase === 'idle' && !gameState.sharedPomo.unsubSoloUpgrade) {
        setupSoloUpgradeListener();
    }
    const player = gameState.players[gameState.userId];
    if (player) {
        updatePlayerPosition(player.x, player.y);
    }
}

function listenToPomodoro() {
    const pomodoroRef = ref(database, lobbyPath('pomodoro'));
    onValue(pomodoroRef, (snapshot) => {
        syncLaptopsFromPomodoro(snapshot.val());
    });
}

function doLogout() {
    _azkarFakeHour = null;
    _azkarFakeMin  = null;
    disconnectPresenceSocket();   // close the live-position relay; don't reconnect
    // Explicit logout — don't auto-resume on the next load.
    try { localStorage.removeItem(ACTIVE_SESSION_KEY); } catch (_) {}
    if (gameState.userId) {
        if (gameState.isSirajGhost) {
            const cleanups = { [`users/${gameState.userId}`]: null };
            if (gameState.pomodoro.active && gameState.pomodoro.laptopId) {
                cleanups[lobbyPath(`pomodoro/${gameState.pomodoro.laptopId}`)] = null;
            }
            if (gameState.freeMode.active && gameState.freeMode.laptopId != null) {
                cleanups[lobbyPath(`pomodoro/${gameState.freeMode.laptopId}`)] = null;
            }
            const raceSession = gameState.race.session;
            const raceSessionKey = gameState.race.sessionKey;
            if (raceSession && raceSessionKey && (raceSession.hostId === gameState.userId ||
                raceSession.phase === 'teleporting')) {
                cleanups[lobbyPath(`minigames/race/sessions/${raceSessionKey}`)] = null;
            }
            update(ref(database), cleanups)
                .then(() => window.location.reload())
                .catch(() => window.location.reload());
        } else {
            const logoutCleanups = {};
            // Explicit logout = clean end. Cancel the disconnect handlers + wipe the
            // reclaim stash so we don't keep a laptop or reload into an old session.
            cancelSessionDisconnect(false);
            logoutCleanups[`users/${gameState.userId}/lastPomoSession`] = null;
            const _activeLap = _activeSessionLaptopId();
            if (_activeLap != null && _sessionIsSolo()) {
                onDisconnect(ref(database, lobbyPath(`pomodoro/${_activeLap}`))).cancel();
                logoutCleanups[lobbyPath(`pomodoro/${_activeLap}`)] = null;
            }
            if (gameState.freeMode.active && gameState.freeMode.laptopId != null) {
                // Cancel the onDisconnect so explicit logout fully clears the session
                onDisconnect(ref(database, lobbyPath(`pomodoro/${gameState.freeMode.laptopId}`))).cancel();
                logoutCleanups[lobbyPath(`pomodoro/${gameState.freeMode.laptopId}`)] = null;
            }
            // Clean up shared pomo live doc on explicit logout so Firebase isn't left dirty
            const _sp = gameState.sharedPomo;
            if (_sp.phase === 'active' && _sp.sessionId) {
                if (_sp.isHost) {
                    logoutCleanups[spPath(`live/${_sp.sessionId}`)] = null;
                } else {
                    logoutCleanups[spPath(`live/${_sp.sessionId}/participants/${gameState.userId}`)] = null;
                }
            }
            if (Object.keys(logoutCleanups).length) update(ref(database), logoutCleanups);
            set(ref(database, `users/${gameState.userId}/activeInGame`), false)
                .then(() => window.location.reload())
                .catch(() => window.location.reload());
        }
    } else {
        window.location.reload();
    }
}

function setupLogout() {
    const confirmModal = document.getElementById('logout-confirm-modal');
    document.getElementById('logout-btn').addEventListener('click', () => {
        confirmModal.classList.add('active');
    });
    document.getElementById('logout-confirm-yes').addEventListener('click', () => {
        confirmModal.classList.remove('active');
        doLogout();
    });
    document.getElementById('logout-confirm-no').addEventListener('click', () => {
        confirmModal.classList.remove('active');
    });
}

// Returns a spawn position in the shaded left area of the work room that
// doesn't overlap any already-loaded player. Falls back gracefully.
function getRandomSpawnPosition() {
    const SPAWN_MIN_X = -450;
    const SPAWN_MAX_X = -100;
    const SPAWN_MIN_Y = 100;
    const SPAWN_MAX_Y = 370;
    const MIN_DIST = PLAYER_SIZE + 15;

    const others = Object.values(gameState.players).filter(p => p.userId !== gameState.userId);

    for (let attempt = 0; attempt < 40; attempt++) {
        const x = SPAWN_MIN_X + Math.random() * (SPAWN_MAX_X - SPAWN_MIN_X);
        const y = SPAWN_MIN_Y + Math.random() * (SPAWN_MAX_Y - SPAWN_MIN_Y);
        if (checkCollision(x, y)) continue;
        const blocked = others.some(p => {
            const dx = (p.renderX ?? p.x) - x;
            const dy = (p.renderY ?? p.y) - y;
            return Math.sqrt(dx * dx + dy * dy) < MIN_DIST;
        });
        if (!blocked) return { x, y };
    }
    return { x: -250, y: BG_HEIGHT / 4 };
}

function initializePlayerPosition() {
    const { x: spawnX, y: spawnY } = getRandomSpawnPosition();
    if (!gameState.players[gameState.userId]) {
        gameState.players[gameState.userId] = {
            userId: gameState.userId,
            username: gameState.currentUser,
            x: spawnX,
            y: spawnY,
            renderX: spawnX,
            renderY: spawnY
        };
    } else {
        teleportEntity(gameState.players[gameState.userId], spawnX, spawnY);
    }
    updatePlayerPosition(spawnX, spawnY);
    gameState.positionInitialized = true;
}

function listenToPlayers() {
    // We're in-game now — drop the welcome-screen subscription on the global
    // /users node so we don't pay for two full-node streams per client.
    if (gameState._userSelectionUnsub) { try { gameState._userSelectionUnsub(); } catch (_) {} gameState._userSelectionUnsub = null; }
    const usersRef = ref(database, 'users');
    // The category that belongs to the active lobby – used to exclude the other lobby
    const allowedCategory = LOBBY_CONFIG[gameState.selectedLobby]?.categoryName;

    onValue(usersRef, (snapshot) => {
        const users = snapshot.val();
        if (users) {
            const currentIdsInSnapshot = new Set();
            for (const [userId, userData] of Object.entries(users)) {
                // Hard separation: VC users matched by categoryName; OAuth users matched by lobby field.
                const inCorrectLobby = userData.categoryName === allowedCategory
                    || userData.lobby === gameState.selectedLobby;
                if (!inCorrectLobby) continue;

                if (userData.status === 'in-voice' || userData.activeInGame === true) {
                    currentIdsInSnapshot.add(userId);
                    const isCurrentUser = userId === gameState.userId;
                    if (!gameState.players[userId]) {
                        // Explicit presence check — `!userData.x` wrongly treats a
                        // legitimate x:0 (the centre-column laptop sits at world x≈0)
                        // as "no position", which scattered working users to a random
                        // spot for everyone else. Only assign a spawn when the position
                        // is genuinely absent AND the user isn't already in-game (i.e. a
                        // VC ghost), so in-game players are never relocated by observers.
                        const hasPos = userData.x !== undefined && userData.x !== null
                                    && userData.y !== undefined && userData.y !== null;
                        let spawnX = hasPos ? userData.x : 0;
                        let spawnY = hasPos ? userData.y : 0;
                        if (!isCurrentUser && !hasPos && userData.activeInGame !== true) {
                            const ghostSpawn = getRandomSpawnPosition();
                            spawnX = ghostSpawn.x;
                            spawnY = ghostSpawn.y;
                            update(ref(database), {
                                [`users/${userId}/x`]: spawnX,
                                [`users/${userId}/y`]: spawnY,
                            });
                        }
                        gameState.players[userId] = {
                            userId,
                            username: userData.username,
                            channelName: userData.channelName,
                            avatar: userData.avatar,
                            x: spawnX,
                            y: spawnY,
                            renderX: spawnX,
                            renderY: spawnY,
                            currentTask: userData.currentTask || "",
                            activeInGame: userData.activeInGame === true,
                            avatarColorAlpha: userData.activeInGame === true ? 1 : 0,
                            isMoving: userData.isMoving || false,
                            isSprinting: userData.isSprinting || false,
                            isLockedIn: userData.isLockedIn || false,
                            isWorking:          userData.isWorking  || false,
                            isOnBreak:          userData.isOnBreak  || false,
                            inFreeMode:         userData.inFreeMode || false,
                            freeWorkStartTime:  userData.freeWorkStartTime || 0,
                            freeTotalWorkMs:    userData.freeTotalWorkMs   || 0,
                            coopHostId:         userData.coopHostId || null,
                            // JUICE: others pop in with a 0→100% overshoot scale.
                            _entryT: (JUICE_ENTRANCE && !isCurrentUser) ? performance.now() : null,
                        };
                    } else {
                        const player = gameState.players[userId];
                        // JUICE: reconnected mid scale-down → cancel the exit and re-pop in.
                        if (player._exitT != null) { player._exitT = null; player._entryT = performance.now(); }
                        player.username = userData.username;
                        player.channelName = userData.channelName;
                        player.avatar = userData.avatar;
                        player.currentTask = userData.currentTask || "";
                        player.activeInGame = userData.activeInGame === true;

                        if (isCurrentUser) {
                            const taskInput = document.getElementById('current-task-input');
                            if (taskInput && !gameState.taskInputInitialized) {
                                taskInput.value = userData.currentTask || "";
                                gameState.taskInputInitialized = true;
                            }
                        }

                        if (!isCurrentUser) {
                            // Only retarget when a real position is present — a transient
                            // undefined must not snap the player to (0,0).
                            if (userData.x !== undefined && userData.x !== null
                             && userData.y !== undefined && userData.y !== null) {
                                setEntityTarget(player, userData.x, userData.y);
                                // Only feed the interpolation buffer from Firebase when the
                                // WebSocket isn't the live source. A Firebase write carries a
                                // STALE position (round-trip latency) but a fresh timestamp, so
                                // interleaving it during active WS streaming yanks the avatar
                                // backward → the "snapping" users reported. The WS path keeps
                                // movement smooth; Firebase is only the fallback when WS is quiet.
                                const _now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
                                if (_now - (player._lastWsSampleAt || 0) > 1000) {
                                    pushNetSample(player, userData.x, userData.y);
                                }
                            }
                            player.isMoving          = userData.isMoving || false;
                            player.isSprinting       = userData.isSprinting || false;
                            player.isLockedIn        = userData.isLockedIn || false;
                            player.isWorking         = userData.isWorking  || false;
                            player.isOnBreak         = userData.isOnBreak  || false;
                            player.inFreeMode        = userData.inFreeMode || false;
                            player.freeWorkStartTime = userData.freeWorkStartTime || 0;
                            player.freeTotalWorkMs   = userData.freeTotalWorkMs   || 0;
                            player.coopHostId        = userData.coopHostId || null;
                        }
                    }
                    if (userData.avatar && !gameState.avatarCache[userId]) {
                        const img = new Image();
                        img.crossOrigin = "anonymous";
                        img.src = userData.avatar;
                        img.onload = () => { gameState.avatarCache[userId] = img; };
                        img.onerror = () => { gameState.avatarCache[userId] = 'failed'; };
                    }
                }
            }
            Object.keys(gameState.players).forEach(id => {
                if (id === gameState.userId || currentIdsInSnapshot.has(id)) return;
                const p = gameState.players[id];
                // JUICE: scale the avatar DOWN before removing (mirror of the scale-up
                // on connect). The actual delete happens in updateLeavingPlayers once the
                // animation finishes. With juice off, remove immediately as before.
                if (JUICE_ENTRANCE && p) {
                    if (p._exitT == null) p._exitT = performance.now();
                } else {
                    delete gameState.players[id];
                }
            });
            const playerCount = Object.keys(gameState.players).length;
            const countElem = document.getElementById('player-count');
            if (countElem) countElem.textContent = `${playerCount} مستخدم${playerCount > 10 ? '' : (playerCount > 2 ? 'ين' : '')}`;
        }
    });
}

// ============================================================================
// Live position relay (Cloudflare WebSocket)
// ----------------------------------------------------------------------------
// High-frequency player movement (x/y) goes over a WebSocket relay instead of
// Firebase — Firebase stays the source of truth for everything that must
// PERSIST (presence, task, working state, pomodoro, reclaim) but is no longer
// spammed with a write on every animation frame. The server is a dumb relay:
// it forwards each position payload to the other players in the same lobby and
// stores nothing. If the socket is down we silently fall back to the periodic
// Firebase position writes (stop / heartbeat), so nobody ever freezes.
// ============================================================================
const PRESENCE_WS_BASE = 'wss://mdwnh-presence.yosefbore3y.workers.dev';
const POS_WS_MIN_INTERVAL = 90; // ms between sends → ~11/sec max while walking
const presenceNet = {
    ws: null,
    lobby: null,        // which lobby room the current socket is joined to
    lastSendAt: 0,
    reconnectTimer: null,
    closing: false,     // true = we asked it to close (logout); don't reconnect
};

// The single entry point. Opens a socket if we don't have a healthy one for the
// current lobby. Safe to call repeatedly (startGame, the 10s heartbeat, resync).
function ensurePresenceSocket() {
    if (!gameState.userId || !gameState.selectedLobby) return;
    presenceNet.closing = false;
    const ws = presenceNet.ws;
    const lobbyOk = presenceNet.lobby === gameState.selectedLobby;
    if (ws && lobbyOk && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    if (ws && !lobbyOk) { try { ws.close(); } catch (_) {} presenceNet.ws = null; }
    _openPresenceSocket();
}

function _openPresenceSocket() {
    const lobby = gameState.selectedLobby;
    const url = `${PRESENCE_WS_BASE}/lobby/${encodeURIComponent(lobby)}?uid=${encodeURIComponent(gameState.userId)}`;
    let ws;
    try { ws = new WebSocket(url); } catch (_) { _schedulePresenceReconnect(); return; }
    presenceNet.ws = ws;
    presenceNet.lobby = lobby;
    ws.onopen = () => {
        // Announce our current position immediately so others place us correctly.
        const p = gameState.players[gameState.userId];
        if (p) sendPositionWS(p.x, p.y, true);
    };
    ws.onmessage = (ev) => onPresenceMessage(ev.data);
    ws.onclose = () => { if (!presenceNet.closing) _schedulePresenceReconnect(); };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
}

function _schedulePresenceReconnect() {
    if (presenceNet.reconnectTimer || presenceNet.closing) return;
    presenceNet.reconnectTimer = setTimeout(() => {
        presenceNet.reconnectTimer = null;
        ensurePresenceSocket();
    }, 2000);
}

function disconnectPresenceSocket() {
    presenceNet.closing = true;
    if (presenceNet.reconnectTimer) { clearTimeout(presenceNet.reconnectTimer); presenceNet.reconnectTimer = null; }
    if (presenceNet.ws) { try { presenceNet.ws.close(); } catch (_) {} presenceNet.ws = null; }
    presenceNet.lobby = null;
}

// Send our position over the socket (throttled). `force` bypasses the throttle —
// used on stop and on (re)connect so the final/initial state lands instantly.
// Returns false if it couldn't send (socket down) so callers can fall back.
function sendPositionWS(x, y, force) {
    const ws = presenceNet.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
    if (!force && now - presenceNet.lastSendAt < POS_WS_MIN_INTERVAL) return false;
    presenceNet.lastSendAt = now;
    const p = gameState.players[gameState.userId];
    const payload = JSON.stringify({
        uid: gameState.userId,
        x: Math.round(x),
        y: Math.round(y),
        m: (p && p.isMoving) ? 1 : 0,
        s: (p && p.isSprinting) ? 1 : 0,
    });
    try { ws.send(payload); return true; } catch (_) { return false; }
}

function onPresenceMessage(data) {
    let msg;
    try { msg = JSON.parse(data); } catch (_) { return; }
    if (!msg || !msg.uid || msg.uid === gameState.userId) return;
    if (msg.t === 'bye') {
        // Firebase presence owns add/remove; just stop their walk animation so
        // they don't keep "moonwalking" until the next Firebase update.
        const pl = gameState.players[msg.uid];
        if (pl) { pl.isMoving = false; pl.isSprinting = false; }
        return;
    }
    // Ignore positions for players Firebase hasn't introduced yet — the users
    // listener adds them (with avatar, lobby filtering, presence) first.
    const player = gameState.players[msg.uid];
    if (!player) return;
    // isMoving must update before pushing the sample — interpolateRemoteFromBuffer
    // reads it to decide whether to extrapolate when the buffer starves.
    player.isMoving = msg.m === 1;
    player.isSprinting = msg.s === 1;
    if (typeof msg.x === 'number' && typeof msg.y === 'number') {
        // Mark that the WebSocket is the live source for this player so the
        // Firebase listener won't interleave its laggy (stale-position) writes
        // into the interpolation buffer and snap the avatar backward.
        player._lastWsSampleAt = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        setEntityTarget(player, msg.x, msg.y);  // keep .x/.y authoritative
        pushNetSample(player, msg.x, msg.y);    // feed the interpolation buffer
    }
}

function updatePlayerPosition(x, y) {
    if (!gameState.userId) return;
    const player = gameState.players[gameState.userId];
    const updates = {};
    updates[`users/${gameState.userId}/x`] = x;
    updates[`users/${gameState.userId}/y`] = y;
    updates[`users/${gameState.userId}/lobby`] = gameState.selectedLobby;
    // Keep presence alive on every position write so a stale `activeInGame=false`
    // (left by an onDisconnect during a network blip / PC sleep) self-heals — this
    // is what otherwise renders a reconnected user as a low-opacity VC ghost with
    // no "أعمل على" label or timer for everyone else.
    updates[`users/${gameState.userId}/activeInGame`] = true;
    if (player) {
        updates[`users/${gameState.userId}/isMoving`] = player.isMoving || false;
        updates[`users/${gameState.userId}/isSprinting`] = player.isSprinting || false;
        updates[`users/${gameState.userId}/isLockedIn`] = gameState.isLockedIn || false;
        const fm = gameState.freeMode;
        const isFreeModeWork = fm.active && fm.phase === 'work';
        updates[`users/${gameState.userId}/isWorking`] = (gameState.isLockedIn && gameState.pomodoro.active && gameState.pomodoro.phase === 'work') || isFreeModeWork || false;
        updates[`users/${gameState.userId}/isOnBreak`] = (gameState.pomodoro.active && gameState.pomodoro.phase === 'break') || (fm.active && fm.phase === 'break') || false;
        updates[`users/${gameState.userId}/inFreeMode`] = fm.active || false;
        updates[`users/${gameState.userId}/freeWorkStartTime`] = isFreeModeWork ? (fm.workStartTime || 0) : null;
        updates[`users/${gameState.userId}/freeTotalWorkMs`] = isFreeModeWork ? (fm.totalWorkMs || 0) : null;
        // coopHostId drives external coop animation + labels:
        // — regular shared pomo (not free mode): always set when session active
        // — shared free mode: only set during work phase (hide animation during breaks)
        const _inRegularCoop = !fm.active && gameState.sharedPomo.phase === 'active' && gameState.sharedPomo.sessionId;
        const _inFreeWorkCoop = fm.active && fm.isShared && fm.phase === 'work' && gameState.sharedPomo.sessionId;
        updates[`users/${gameState.userId}/coopHostId`] = (_inRegularCoop || _inFreeWorkCoop) ? gameState.sharedPomo.sessionId : null;
    }
    update(ref(database), updates);
}

function checkCollision(x, y) {
    if (x < BOUNDS.minX || x > BOUNDS.maxX || y < BOUNDS.minY || y > BOUNDS.maxY) return true;
    // Door is passable if break is active, OR if the player is already inside the break room
    // (allows exit even after session ends while player is inside)
    const local = gameState.players[gameState.userId];
    const playerInBreakRoom = local && local.y > ROOM_SEAM_Y + DOOR_HALF_HEIGHT;
    const inBreakDoor = (isBreakActive() || playerInBreakRoom) && isInDoorOpening(x);
    if (Math.abs(y - ROOM_SEAM_Y) < DOOR_HALF_HEIGHT && !inBreakDoor) return true;
    const buffer = PLAYER_SIZE / 2;
    if (x > TABLE_BOX.minX - buffer && x < TABLE_BOX.maxX + buffer && y > TABLE_BOX.minY - buffer && y < TABLE_BOX.maxY + buffer) return true;
    return false;
}

function updateCamera() {
    const player = gameState.players[gameState.userId];
    if (!player) return;
    const { x: px, y: py } = getPlayerRenderPos(player);
    const targetX = -px;
    const targetY = -py;
    const lerpFactor = 1 - Math.pow(1 - CAMERA_SMOOTHING, gameState.dtFactor);
    gameState.camera.x += (targetX - gameState.camera.x) * lerpFactor;
    gameState.camera.y += (targetY - gameState.camera.y) * lerpFactor;
}

function handleMovement() {
    if (JUICE_ENTRANCE && _entrance.active) return;   // JUICE: lock controls during the login entrance
    if (gameState.isLockedIn || gameState.anim.active || gameState.prayer.isOverlayActive) return;
    if (document.querySelector('.modal-overlay.active')) return;
    const player = gameState.players[gameState.userId];
    if (!player) return;
    let dx = 0, dy = 0;
    let isSprinting = gameState.keys['ShiftLeft'] || gameState.keys['ShiftRight'];
    const currentSpeed = (isSprinting ? MOVE_SPEED * 1.8 : MOVE_SPEED) * gameState.dtFactor;
    if (gameState.keys['KeyW'] || gameState.keys['ArrowUp']) dy -= currentSpeed;
    if (gameState.keys['KeyS'] || gameState.keys['ArrowDown']) dy += currentSpeed;
    if (gameState.keys['KeyA'] || gameState.keys['ArrowLeft']) dx -= currentSpeed;
    if (gameState.keys['KeyD'] || gameState.keys['ArrowRight']) dx += currentSpeed;

    // Mobile joystick input
    if (gameState.joystick.active && gameState.joystick.magnitude > 0.08) {
        const jSprint = gameState.joystick.sprinting;
        const jSpeed = (jSprint ? MOVE_SPEED * 1.8 : MOVE_SPEED) * gameState.dtFactor;
        dx += gameState.joystick.dx * jSpeed;
        dy += gameState.joystick.dy * jSpeed;
        if (jSprint) isSprinting = true;
    }
    if (dx !== 0 || dy !== 0) {
        player.isMoving = true;
        player.isSprinting = isSprinting;
        const nextX = player.x + dx;
        const nextY = player.y + dy;
        if (!checkCollision(nextX, player.y)) player.x = nextX;
        if (!checkCollision(player.x, nextY)) player.y = nextY;
        player.smoothMove = false;
        syncEntityRenderToTarget(player);
        // Live movement goes over the WebSocket relay (throttled), NOT Firebase —
        // this is the per-frame write that used to spam the database.
        sendPositionWS(player.x, player.y);

        if (Math.random() < (isSprinting ? 0.8 : 0.4) * gameState.dtFactor) {
            spawnDust(player.renderX, player.renderY, isSprinting ? 2 : 1, false);
        }
    } else {
        if (player.isMoving) {
            player.isMoving = false;
            player.isSprinting = false;
            // On stop: persist the final position to Firebase (so late joiners /
            // reclaim / spawn read a correct last-known spot) AND push one forced
            // socket update so others halt our walk animation immediately.
            sendPositionWS(player.x, player.y, true);
            updatePlayerPosition(player.x, player.y);
        }
    }
}

function updateWindParticles() {
    // Lerp wind speed and focus fog opacity
    const isFocused = gameState.isLockedIn && (
        (gameState.pomodoro.active && gameState.pomodoro.phase === 'work') ||
        (gameState.freeMode.active && gameState.freeMode.phase === 'work')
    );
    const targetWindSpeed = isFocused ? 0.15 : 1.0;
    const targetFogAlpha = isFocused ? 1.0 : 0.0;

    const lerpFactor = 1 - Math.pow(1 - 0.03, gameState.dtFactor);
    gameState.windSpeedMultiplier += (targetWindSpeed - gameState.windSpeedMultiplier) * lerpFactor;
    gameState.focusFogAlpha += (targetFogAlpha - gameState.focusFogAlpha) * lerpFactor;

    gameState.windParticles.forEach(p => {
        p.x -= p.speed * gameState.dtFactor * gameState.windSpeedMultiplier;
        if (p.x < -100) {
            // Use logical viewport size (window.innerWidth = canvas.width / dpr)
            const dpr = gameState.dpr || 1;
            p.x = (gameState.canvas ? gameState.canvas.width / dpr : window.innerWidth) + 100;
            p.y = Math.random() * (gameState.canvas ? gameState.canvas.height / dpr : window.innerHeight);
        }
    });
}

function updateInteractions() {
    const player = gameState.players[gameState.userId];
    if (!player) return;

    gameState.activeLaptop = null;
    gameState.activeRaceButton = false;
    let closestDist = 120;          // selection range (click to start) — unchanged
    let minDist = Infinity;
    let nearestDist = Infinity;     // distance to closest laptop regardless of range (mask only)

    gameState.laptops.forEach(laptop => {
        const dist = Math.sqrt(Math.pow(player.x - laptop.x, 2) + Math.pow(player.y - laptop.y, 2));
        if (dist < nearestDist) nearestDist = dist;
        if (dist < closestDist) {
            gameState.activeLaptop = laptop;
            gameState.lastActiveLaptop = laptop;
            minDist = dist;
        }
    });

    const prevZonePlayers = gameState.raceZonePlayers || [];
    gameState.raceZonePlayers = isBreakActive() ? Object.values(gameState.players).filter(p => {
        if (!(p.x >= RACE_ZONE_RECT.x && p.x <= RACE_ZONE_RECT.x + RACE_ZONE_RECT.w &&
              p.y >= RACE_ZONE_RECT.y && p.y <= RACE_ZONE_RECT.y + RACE_ZONE_RECT.h)) return false;
        // Exclude players already committed to a race session
        const sessions = Object.values(gameState.race.activeSessions || {});
        return !sessions.some(s => s && s.phase !== 'finished' && s.participants?.[p.userId]);
    }) : [];

    // Detect newly-entered players and play the ready sound for them
    if (!gameState.race.active) {
        const prevIds = new Set(prevZonePlayers.map(p => p.userId));
        const newlyEntered = gameState.raceZonePlayers.filter(p => !prevIds.has(p.userId));
        newlyEntered.forEach(p => {
            const dist = Math.hypot(p.x - player.x, p.y - player.y);
            // Full volume within 80 px, fades to ~0 at 450 px
            const vol = Math.max(0, 1 - Math.max(0, dist - 80) / 370);
            if (vol > 0.04) playMinigameReadySound(vol);
        });
    }

    if (isBreakActive() && isInBreakRoom(player.y)) {
        gameState.activeRaceZone = player.x >= RACE_ZONE_RECT.x && player.x <= RACE_ZONE_RECT.x + RACE_ZONE_RECT.w &&
                                   player.y >= RACE_ZONE_RECT.y && player.y <= RACE_ZONE_RECT.y + RACE_ZONE_RECT.h;
        gameState.activeRaceButton = gameState.activeRaceZone;
    } else {
        gameState.activeRaceZone = false;
        gameState.activeRaceButton = false;
    }

    // Coffee zone
    const prevCoffeeZonePlayers = gameState.coffeeZonePlayers || [];
    gameState.coffeeZonePlayers = isBreakActive() ? Object.values(gameState.players).filter(p => {
        if (!(p.x >= COFFEE_ZONE_RECT.x && p.x <= COFFEE_ZONE_RECT.x + COFFEE_ZONE_RECT.w &&
              p.y >= COFFEE_ZONE_RECT.y && p.y <= COFFEE_ZONE_RECT.y + COFFEE_ZONE_RECT.h)) return false;
        const sessions = Object.values(gameState.coffee.activeSessions || {});
        return !sessions.some(s => s && s.phase !== 'finished' && s.participants?.[p.userId]);
    }) : [];
    // Play ready sound for newly-entered coffee zone players
    if (!gameState.coffee.active) {
        const prevCoffeeIds = new Set(prevCoffeeZonePlayers.map(p => p.userId));
        gameState.coffeeZonePlayers.filter(p => !prevCoffeeIds.has(p.userId)).forEach(p => {
            const dist = Math.hypot(p.x - player.x, p.y - player.y);
            const vol  = Math.max(0, 1 - Math.max(0, dist - 80) / 370);
            if (vol > 0.04) playMinigameReadySound(vol);
        });
    }
    if (isBreakActive() && isInBreakRoom(player.y)) {
        gameState.activeCoffeeZone =
            player.x >= COFFEE_ZONE_RECT.x && player.x <= COFFEE_ZONE_RECT.x + COFFEE_ZONE_RECT.w &&
            player.y >= COFFEE_ZONE_RECT.y && player.y <= COFFEE_ZONE_RECT.y + COFFEE_ZONE_RECT.h;
    } else {
        gameState.activeCoffeeZone = false;
    }

    // Laptop boss zone (single-player, but mirrors race/coffee patterns)
    const prevBossZonePlayers = gameState.laptopBossZonePlayers || [];
    gameState.laptopBossZonePlayers = isBreakActive() ? Object.values(gameState.players).filter(p => {
        if (!(p.x >= LAPTOP_BOSS_ZONE_RECT.x && p.x <= LAPTOP_BOSS_ZONE_RECT.x + LAPTOP_BOSS_ZONE_RECT.w &&
              p.y >= LAPTOP_BOSS_ZONE_RECT.y && p.y <= LAPTOP_BOSS_ZONE_RECT.y + LAPTOP_BOSS_ZONE_RECT.h)) return false;
        const sessions = Object.values(gameState.laptopBoss.activeSessions || {});
        return !sessions.some(s => s && s.phase !== 'finished' && s.participants?.[p.userId]);
    }) : [];
    if (!gameState.laptopBoss.active) {
        const prevBossIds = new Set(prevBossZonePlayers.map(p => p.userId));
        gameState.laptopBossZonePlayers.filter(p => !prevBossIds.has(p.userId)).forEach(p => {
            const dist = Math.hypot(p.x - player.x, p.y - player.y);
            const vol  = Math.max(0, 1 - Math.max(0, dist - 80) / 370);
            if (vol > 0.04) playMinigameReadySound(vol);
        });
    }
    if (isBreakActive() && isInBreakRoom(player.y)) {
        gameState.activeLaptopBossZone =
            player.x >= LAPTOP_BOSS_ZONE_RECT.x && player.x <= LAPTOP_BOSS_ZONE_RECT.x + LAPTOP_BOSS_ZONE_RECT.w &&
            player.y >= LAPTOP_BOSS_ZONE_RECT.y && player.y <= LAPTOP_BOSS_ZONE_RECT.y + LAPTOP_BOSS_ZONE_RECT.h;
    } else {
        gameState.activeLaptopBossZone = false;
    }

    const baseAlpha = gameState.isLockedIn ? 0.475 : 0.4;
    let targetAlpha = 0;
    if (gameState.isLockedIn) {
        // Always full darkening when locked in — don't rely on proximity
        targetAlpha = baseAlpha;
    } else {
        // Proximity fade toward the nearest laptop. Selection range is untouched
        // (120px), but the mask senses a bit wider (LAPTOP_MASK_FADE_R) and — to
        // stop the flicker in the gaps between laptops — HOLDS the last darkening
        // for a short window before letting it fade. So walking a row keeps the
        // mask continuous; it only fades once you've genuinely left the cluster.
        const prox = Math.min(baseAlpha, Math.max(0, (1 - nearestDist / LAPTOP_MASK_FADE_R) * 1.6));
        if (prox > 0.001) {
            gameState.maskHoldT = 0;
            gameState.maskLast = prox;
        } else {
            gameState.maskHoldT = (gameState.maskHoldT || 0) + gameState.dtFactor;
        }
        targetAlpha = (gameState.maskHoldT < LAPTOP_MASK_HOLD_FRAMES) ? (gameState.maskLast || 0) : 0;
    }

    // Disable the dark laptop focus mask if we are currently on a break!
    if (gameState.pomodoro.active && gameState.pomodoro.phase === 'break') {
        targetAlpha = 0;
    }

    const animAlphaMult = (gameState.anim.active && gameState.anim.phase !== 'none') ? 0 : 1;
    const lerpFactor = 1 - Math.pow(1 - 0.1, gameState.dtFactor);
    gameState.focusAlpha += (targetAlpha * animAlphaMult - gameState.focusAlpha) * lerpFactor;
}

function updateAnimation() {
    if (!gameState.anim.active) return;

    const player = gameState.players[gameState.userId];
    const laptop = gameState.anim.laptop;
    if (!player || !laptop) return;

    // Heavy dust during the entire kidnap animation sequence
    spawnDust(player.x, player.y, Math.ceil(3 * gameState.dtFactor), true);

    if (gameState.anim.phase === 'reach') {
        gameState.anim.progress += 0.08 * gameState.dtFactor;
        if (gameState.anim.progress >= 1) {
            gameState.anim.phase = 'align';
            gameState.anim.progress = 0;
            gameState.anim.startPos = { x: player.x, y: player.y };
        }
    } else if (gameState.anim.phase === 'align') {
        gameState.anim.progress += 0.025 * gameState.dtFactor;
        const t = easeOutBack(Math.min(1, gameState.anim.progress));

        player.x = gameState.anim.startPos.x + (laptop.sitX - gameState.anim.startPos.x) * t;
        player.y = gameState.anim.startPos.y + (laptop.intermediateY - gameState.anim.startPos.y) * t;

        if (gameState.anim.progress >= 1) {
            gameState.anim.phase = 'pull';
            gameState.anim.progress = 0;
            gameState.anim.startPos = { x: player.x, y: player.y };
        }
    } else if (gameState.anim.phase === 'pull') {
        gameState.anim.progress += 0.045 * gameState.dtFactor;
        const t = easeOutBack(Math.pow(Math.min(1, gameState.anim.progress), 2.5));

        player.y = gameState.anim.startPos.y + (laptop.sitY - gameState.anim.startPos.y) * t;

        if (gameState.anim.progress >= 1) {
            gameState.anim.active = false;
            gameState.anim.phase = 'none';
            gameState.isLockedIn = true;

            // Reset coop offsets to center so the grid spread animates outward smoothly
            if (gameState.sharedPomo.phase === 'active') {
                for (const m of Object.values(gameState.sharedPomo.coopAnim.members)) {
                    m.dxBlend = 0;
                    m.dyBlend = 0;
                }
            }

            if (gameState.pomodoro.active && gameState.pomodoro.phase === 'wait') {
                startPomodoroPhase('work');
            } else if (gameState.freeMode.active && gameState.freeMode.phase === 'idle') {
                _startFreeModeWork();
            } else if (gameState.pomodoro.active && gameState.pomodoro.phase === 'work' && gameState.focusYTPlayer && gameState.focusYTPlayer.videoId) {
                gameState.focusYTPlayer.resume();
            }
        }
    }

    syncEntityRenderToTarget(player);
    // Sync position continuously during animation to prevent snapping for other clients
    updatePlayerPosition(player.x, player.y);
}

function spawnDust(x, y, amount, isDragging = false) {
    for (let i = 0; i < amount; i++) {
        gameState.dustParticles.push({
            x: x + (Math.random() - 0.5) * 30,
            y: y + PLAYER_SIZE / 2 + (Math.random() - 0.5) * 10,
            vx: (Math.random() - 0.5) * (isDragging ? 4 : 1),
            vy: (Math.random() - 0.5) * (isDragging ? 4 : 1) - (isDragging ? 1 : 0.5),
            life: 1.0,
            decay: 0.03 + Math.random() * 0.04,
            size: 2 + Math.random() * (isDragging ? 5 : 3)
        });
    }
}

// JUICE: a puff of dust kicked outward + up when the character lands in the
// entrance. Reuses the dust pool (drawn by drawDustParticles). The optional
// gravity field arcs them back down; plain dust has no gravity field (no-op).
function spawnImpactBurst(cx, groundY, count) {
    for (let i = 0; i < count; i++) {
        const dir = i % 2 === 0 ? 1 : -1;
        const speed = 2.5 + Math.random() * 4.5;
        gameState.dustParticles.push({
            x: cx + (Math.random() - 0.5) * 24,
            y: groundY + (Math.random() - 0.5) * 6,
            vx: dir * speed * (0.5 + Math.random() * 0.9),
            vy: -(1.2 + Math.random() * 3.0),
            gravity: 0.18 + Math.random() * 0.12,
            life: 1.0,
            decay: 0.022 + Math.random() * 0.03,
            size: 3 + Math.random() * 5,
        });
    }
}

function updateDustParticles() {
    for (let i = gameState.dustParticles.length - 1; i >= 0; i--) {
        const p = gameState.dustParticles[i];
        if (p.gravity) p.vy += p.gravity * gameState.dtFactor;
        p.x += p.vx * gameState.dtFactor;
        p.y += p.vy * gameState.dtFactor;
        p.life -= p.decay * gameState.dtFactor;
        if (p.life <= 0) {
            gameState.dustParticles.splice(i, 1);
        }
    }
}

function updatePlayerBobbing() {
    for (const player of Object.values(gameState.players)) {
        if (player.bobTime === undefined) player.bobTime = 0;
        if (player.bobOffset === undefined) player.bobOffset = 0;

        const isLocal = player.userId === gameState.userId;
        const lastBobTime = player.bobTime;
        const lockedIn = isLocal ? gameState.isLockedIn : player.isLockedIn;

        if (!isLocal && player.isMoving) {
            if (Math.random() < 0.2 * gameState.dtFactor) {
                const { x: dustX, y: dustY } = getPlayerRenderPos(player);
                spawnDust(dustX, dustY, 1, false);
            }
        }

        if (player.isMoving && !lockedIn && (!gameState.anim.active || gameState.anim.phase !== 'pull')) {
            const speed = player.isSprinting ? 0.3 : 0.15;
            player.bobTime += speed * gameState.dtFactor;
            const targetBounce = Math.abs(Math.sin(player.bobTime)) * (player.isSprinting ? 12 : 6);
            player.bobOffset += (targetBounce - player.bobOffset) * 0.5 * gameState.dtFactor;

            if (isLocal) {
                if (Math.floor(player.bobTime / Math.PI) > Math.floor(lastBobTime / Math.PI)) {
                    if (gameState.sounds.walk) {
                        const walkSound = gameState.sounds.walk.cloneNode();
                        walkSound.volume = player.isSprinting ? 0.6 : 0.3;
                        walkSound.play().catch(e => {});
                    }
                }
            }
        } else {
            player.bobTime = 0;
            player.bobOffset += (0 - player.bobOffset) * 0.2 * gameState.dtFactor;
        }
    }
}

function updateNametags() {
    const localPlayer = gameState.players[gameState.userId];
    if (!localPlayer) return;

    for (const player of Object.values(gameState.players)) {
        if (player.nameAlpha === undefined) player.nameAlpha = 0;

        const isLocal = player.userId === gameState.userId;
        const lockedIn = isLocal ? gameState.isLockedIn : player.isLockedIn;
        let targetAlpha = 0;

        if (isLocal) {
            targetAlpha = lockedIn ? 0 : 1;
        } else {
            const localPos = getPlayerRenderPos(localPlayer);
            const playerPos = getPlayerRenderPos(player);
            const dist = Math.hypot(playerPos.x - localPos.x, playerPos.y - localPos.y);
            if (lockedIn) {
                targetAlpha = 0;
            } else if (dist < 200) {
                targetAlpha = 1;
            } else {
                targetAlpha = 0;
            }
        }

        const fadeSpeed = lockedIn ? 0.3 : (isLocal ? 0.2 : 0.15);
        const lerpFactor = 1 - Math.pow(1 - fadeSpeed, gameState.dtFactor);
        player.nameAlpha += (targetAlpha - player.nameAlpha) * lerpFactor;
    }
}

function updateAvatarColorFade() {
    for (const player of Object.values(gameState.players)) {
        if (player.avatarColorAlpha === undefined) {
            player.avatarColorAlpha = player.activeInGame ? 1 : 0;
        }
        const isLocal = player.userId === gameState.userId;
        const targetAlpha = (isLocal || player.activeInGame) ? 1 : 0;
        const fadeSpeed = targetAlpha > player.avatarColorAlpha ? 0.1 : 0.18;
        const lerpFactor = 1 - Math.pow(1 - fadeSpeed, gameState.dtFactor);
        player.avatarColorAlpha += (targetAlpha - player.avatarColorAlpha) * lerpFactor;
    }
}

function gameLoop(timestamp) {
    // Stop the loop if this session was displaced by a newer login elsewhere.
    if (gameState._dupSessionDetected) return;

    if (!timestamp) timestamp = performance.now();
    if (!gameState.lastTime) gameState.lastTime = timestamp;
    let deltaTime = timestamp - gameState.lastTime;
    gameState.lastTime = timestamp;

    if (deltaTime > 100) deltaTime = 100; // Cap to avoid large jumps if tab is inactive
    gameState.dtFactor = deltaTime / 16.666; // Standardize to 60fps (1000ms / 60 = 16.666ms)

    // Cache the graphics tier once per frame. Hot draw code reads these flags
    // instead of calling the helpers (which hit localStorage) many times per frame.
    // _lowGfx = reduced compositing (drops shadows etc.); _potato = also drop the
    // atmosphere gradients.
    gameState._lowGfx = isReducedGraphics();
    gameState._potato = isPotato();
    // Cache the "disable my working idle animation" setting once per frame too —
    // drawPlayers reads it per-avatar and the getter hits localStorage.
    gameState._disableIdleAnim = getDisableIdleAnim();
    // On mobile, cap dtFactor more aggressively to reduce stutters from dropped frames
    if (isMobile() && gameState.dtFactor > 2) gameState.dtFactor = 2;

    // Position heartbeat: while locked in / in a session the player doesn't move, so
    // updatePlayerPosition isn't being called — re-assert the authoritative position
    // every few seconds so observers always converge to it even if an earlier write
    // was missed or raced.
    if (gameState.userId && (gameState.isLockedIn || gameState.pomodoro.active || gameState.freeMode.active)) {
        const _now = Date.now();
        if (!gameState._lastPosHeartbeat || _now - gameState._lastPosHeartbeat > 4000) {
            gameState._lastPosHeartbeat = _now;
            const _p = gameState.players[gameState.userId];
            if (_p) updatePlayerPosition(_p.x, _p.y);
        }
    }

    // Presence heartbeat: independent of any session (the position heartbeat above
    // only runs while locked-in). An idle / walking user whose `activeInGame` was
    // flipped false by a disconnect must still self-heal back to true while the
    // page is open, or they stay a low-opacity ghost for everyone else.
    if (gameState.userId && !gameState.isSirajGhost) {
        const _now = Date.now();
        if (!gameState._lastPresenceHeartbeat || _now - gameState._lastPresenceHeartbeat > 10000) {
            gameState._lastPresenceHeartbeat = _now;
            update(ref(database), { [`users/${gameState.userId}/activeInGame`]: true });
            ensurePresenceSocket();   // self-heal the relay if it silently died
        }
    }

    try {
        // Edge bokeh: hide during all three minigames (they each return early before render()).
        // Must run first so the div state is always correct regardless of which path we take.
        if (!isLowGraphics()) {
            const _inMini =
                (gameState.laptopBoss.active && gameState.laptopBoss.session &&
                    (gameState.laptopBoss.session.phase === 'active' || gameState.laptopBoss.session.phase === 'finished')) ||
                (gameState.race.active && gameState.race.session &&
                    (gameState.race.session.phase === 'race' || gameState.race.session.phase === 'finished')) ||
                (gameState.coffee.active && gameState.coffee.session &&
                    (gameState.coffee.session.phase === 'active' || gameState.coffee.session.phase === 'finished'));
            const _bokeh = document.getElementById('edge-bokeh');
            if (_bokeh) {
                if (_inMini) {
                    _bokeh.style.display = 'none';
                } else {
                    // Blur scales linearly with zoom: 0px at MIN_ZOOM, 10px at MAX_ZOOM
                    const _zoomT = (gameState.zoom - MIN_ZOOM) / (MAX_ZOOM - MIN_ZOOM);
                    const _blur  = Math.round(_zoomT * 10 * 10) / 10; // 0.0–10.0 px
                    _bokeh.style.display = 'block';
                    _bokeh.style.backdropFilter = `blur(${_blur}px) saturate(1.15)`;
                    _bokeh.style.webkitBackdropFilter = `blur(${_blur}px) saturate(1.15)`;
                }
            }
        }

        updatePomodoro();
        updatePiPLifecycle();
        updateTeleportAnim();
        updateCoffeeTeleportAnim();
        updateLaptopBossTeleportAnim();
        cleanupStaleRaceSession(gameState.race.session);
        if (gameState.laptopBoss.active && gameState.laptopBoss.session &&
            (gameState.laptopBoss.session.phase === 'active' || gameState.laptopBoss.session.phase === 'finished')) {
            updateLaptopBoss();
            renderLaptopBoss();
            requestAnimationFrame(gameLoop);
            return;
        }
        if (gameState.race.active && gameState.race.session && gameState.race.session.phase === 'race') {
            updateRaceMode();
            updateRaceCarVisuals();
            updateRaceCamera();
            renderRace();
            requestAnimationFrame(gameLoop);
            return;
        }
        if (gameState.race.active && gameState.race.session && gameState.race.session.phase === 'finished') {
            updateRaceCarVisuals();
            updateRaceCamera();
            renderRace();
            requestAnimationFrame(gameLoop);
            return;
        }
        if (gameState.coffee.active && gameState.coffee.session &&
            (gameState.coffee.session.phase === 'active' || gameState.coffee.session.phase === 'finished')) {
            updateCoffeeMode();
            renderCoffee();
            requestAnimationFrame(gameLoop);
            return;
        }

        handleMovement();
        updateAnimation();
        updatePlayerRenderPositions();
        updateCamera();
        updateEntrance(timestamp);   // JUICE: login entrance (no-op once finished)
        updateLeavingPlayers();      // JUICE: finish disconnect scale-downs
        updatePlayerBobbing();
        updateNametags();
        updateAvatarColorFade();
        updateWindParticles();
        updateAmbientMotes();
        updateDustParticles();
        updateInteractions();
        updateSharedPomoProximity();
        updateCoopAnimation();
        updateCoopTaskPanel();
        updatePomoLeaveBtn();
        updatePrayerSystem();
        updateAzkarSystem();
        render();
    } catch (e) {
        console.error('[gameLoop crash — loop kept alive]', e);
        // Ensure isLockedIn doesn't stay stuck after a crash during break transition
        if (gameState.pomodoro.active && gameState.pomodoro.phase === 'break') {
            gameState.isLockedIn = false;
        }
    }
    requestAnimationFrame(gameLoop);
}

function render() {
    const ctx = gameState.ctx;
    const canvas = gameState.canvas;
    if (!ctx) return;

    const dpr = gameState.dpr || 1;
    const W = canvas.width  / dpr;  // logical (CSS-pixel) viewport width
    const H = canvas.height / dpr;  // logical (CSS-pixel) viewport height

    // Scale context by DPR so all drawing uses logical coordinates → sharp on retina
    ctx.save();
    ctx.scale(dpr, dpr);

    ctx.fillStyle = COLORS.black;
    ctx.fillRect(0, 0, W, H);

    drawBackgroundAtmosphere(W, H);

    ctx.save();
    ctx.translate(W / 2, H / 2);
    if (_entrance.shakeX || _entrance.shakeY) ctx.translate(_entrance.shakeX, _entrance.shakeY); // JUICE: entrance impact shake
    ctx.scale(gameState.zoom, gameState.zoom);
    ctx.translate(gameState.camera.x, gameState.camera.y);

    drawRooms();
    if (gameState.assets.tables.complete) {
        ctx.drawImage(gameState.assets.tables, TABLE_BOX.minX, TABLE_BOX.minY, TABLE_WIDTH, TABLE_HEIGHT);
    }
    drawBreakDoor();
    drawRaceMachine();
    drawCoffeeMachine();
    drawLaptopBossMachine();

    drawConnections();

    if (gameState.anim.active && (gameState.anim.phase === 'reach' || gameState.anim.phase === 'align' || gameState.anim.phase === 'pull')) {
        drawKidnapLine();
    }

    drawAmbientMotes();
    drawDustParticles();
    drawPlayers(false);
    drawCoopEmojiFloats();
    drawCoopGroupLabels();
    drawTimers();

    drawRoomShadows();
    drawBreakDoor();
    drawBreakDoorPrompt();
    drawRaceHint();
    drawCoffeeHint();
    drawLaptopBossHint();

    // Blue locked-in circle: solo pomo only, not coop (coop has its own ring)
    if (gameState.isLockedIn && gameState.sharedPomo.phase !== 'active') {
        drawLockedInOverlay();
    }

    ctx.restore();  // undo world translate/zoom

    if (gameState.focusAlpha > 0.01) {
        drawFocusMask(W, H);
    }

    drawWindParticles(W, H);
    drawFocusFog(W, H);
    if (!gameState._potato) drawSunRays(W, H);
    drawVignette(W, H);
    drawTeleportOverlay(W, H);

    ctx.restore();  // undo DPR scale

    const ytBlock = document.getElementById('yt-focus-block');
    if (ytBlock) {
        const shouldShow = (gameState.pomodoro.active && gameState.pomodoro.phase === 'work')
            || (gameState.freeMode.active && gameState.freeMode.phase === 'work');
        ytBlock.classList.toggle('visible', shouldShow);
    }
    const prayerPanel = document.getElementById('prayer-panel');
    if (prayerPanel) {
        // Only reveal once the kidnap animation has finished (anim inactive), so prayer
        // appears together with focus sounds / task box / YouTube — not the moment the
        // session is selected.
        const showPrayer = (gameState.pomodoro.active || gameState.freeMode.active) && !gameState.anim.active;
        prayerPanel.classList.toggle('visible', !!showPrayer);
        const isBreak = (gameState.pomodoro.active && gameState.pomodoro.phase === 'break')
            || (gameState.freeMode.active && gameState.freeMode.phase === 'break');
        prayerPanel.classList.toggle('break-compact', isBreak);
    }
}

function drawRooms() {
    const ctx = gameState.ctx;
    if (!gameState.assets.bg.complete) return;
    for (let i = 0; i < ROOM_COUNT; i++) {
        ctx.drawImage(gameState.assets.bg, -BG_WIDTH / 2, -BG_HEIGHT / 2 + (i * BG_HEIGHT), BG_WIDTH, BG_HEIGHT);
    }
}

function drawRoomShadows() {
    const ctx = gameState.ctx;
    if (!gameState.assets.shadow.complete) return;
    for (let i = 0; i < ROOM_COUNT; i++) {
        ctx.drawImage(gameState.assets.shadow, -BG_WIDTH / 2, -BG_HEIGHT / 2 + (i * BG_HEIGHT), BG_WIDTH, BG_HEIGHT);
    }
}

function drawBreakDoor() {
    const ctx = gameState.ctx;
    const y = ROOM_SEAM_Y;
    const open = isBreakActive();

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    if (open) {
        ctx.fillStyle = 'rgba(49, 178, 255, 0.22)';
        ctx.fillRect(-DOOR_HALF_WIDTH, y - 8, DOOR_WIDTH, 16);
        ctx.fillStyle = 'rgba(132, 218, 255, 0.38)';
        for (let x = -DOOR_HALF_WIDTH; x < DOOR_HALF_WIDTH; x += 24) {
            ctx.fillRect(x, y - 2, 14, 4);
        }
    } else {
        ctx.fillStyle = '#111111';
        ctx.fillRect(-DOOR_HALF_WIDTH, y - 6, DOOR_WIDTH, 12);
        for (let x = -DOOR_HALF_WIDTH; x < DOOR_HALF_WIDTH; x += 28) {
            ctx.fillStyle = '#f4c82b';
            ctx.fillRect(x, y - 6, 14, 12);
            ctx.fillStyle = '#111111';
            ctx.fillRect(x + 14, y - 6, 14, 12);
        }
    }

    ctx.restore();
}

// Animated break-door label (called once per frame, after players, so it sits on
// top). Same playful fade-out / pop-in as the laptop prompt.
function drawBreakDoorPrompt() {
    const ctx = gameState.ctx;
    const y = ROOM_SEAM_Y;
    const player = gameState.players[gameState.userId];
    const near = player && Math.hypot(player.x, player.y - y) < 190;
    const wantText = isBreakActive() ? 'باب الاستراحة مفتوح' : 'باب الاستراحة مغلق';

    const bp = gameState.breakDoorPrompt;
    const bLerp = 1 - Math.pow(1 - 0.22, gameState.dtFactor);
    if (!near || wantText !== bp.shownText) {
        // Fade out the current label; adopt the new one once it's faint enough.
        bp.alpha += (0 - bp.alpha) * bLerp;
        if (bp.alpha < 0.06 && near) { bp.shownText = wantText; bp.pop = 0; }
    } else {
        bp.shownText = wantText;
        bp.alpha += (1 - bp.alpha) * bLerp;
        bp.pop   += (1 - bp.pop)   * bLerp;
    }

    if (!bp.shownText || bp.alpha < 0.02) return;
    const a = bp.alpha;
    const bob = Math.sin(Date.now() * 0.004) * 2.5;
    const pop = 0.82 + 0.18 * easeOutBack(Math.min(1, bp.pop));
    ctx.save();
    ctx.translate(0, (y - 72) - (1 - a) * 10 + bob);
    ctx.scale(pop, pop);
    ctx.font = 'bold 15px Rubik';
    ctx.textAlign = 'center';
    ctx.fillStyle = `rgba(255, 255, 255, ${a})`;
    ctx.shadowBlur = 8;
    ctx.shadowColor = `rgba(0, 0, 0, ${a})`;
    ctx.fillText(bp.shownText, 0, 0);
    ctx.shadowBlur = 0;
    ctx.restore();
}

// ═══════════════════════════════════════════════════════════════════
//  COFFEE MINIGAME
// ═══════════════════════════════════════════════════════════════════

function coffeeSessionPath(subpath) {
    const key = gameState.coffee.sessionKey;
    if (!key) return lobbyPath('minigames/coffee/sessions/__invalid__');
    return lobbyPath(`minigames/coffee/sessions/${key}${subpath ? '/' + subpath : ''}`);
}

function listenToCoffee() {
    onValue(ref(database, lobbyPath('minigames/coffee/sessions')), (snap) => {
        const sessions = snap.val() || {};
        const nowMs = Date.now();
        const active = {};
        for (const [key, s] of Object.entries(sessions)) {
            if (!s) continue;
            if (s.createdAt && nowMs - s.createdAt > 600000) {
                if (s.hostId === gameState.userId) {
                    update(ref(database), { [lobbyPath(`minigames/coffee/sessions/${key}`)]: null });
                }
                continue;
            }
            active[key] = s;
        }
        gameState.coffee.activeSessions = active;

        let myKey = null, mySession = null;
        for (const [key, s] of Object.entries(active)) {
            if (s.participants?.[gameState.userId]) { myKey = key; mySession = s; break; }
        }

        if (!mySession) {
            if (gameState.coffee.active) returnFromCoffee(false);
            gameState.coffee.session = null;
            gameState.coffee.sessionKey = null;
            return;
        }

        gameState.coffee.session = mySession;
        gameState.coffee.sessionKey = myKey;

        if (mySession.phase === 'teleporting') {
            if (!gameState.coffee.teleportAnim) {
                const elapsed = Math.max(0, (serverNow() - (mySession.teleportAt || serverNow())) / 1000);
                gameState.coffee.teleportAnim = {
                    t: elapsed, phase: 'fly', flyProgress: 0, screenAlpha: 0,
                    players: Object.keys(mySession.participants || {}).map(uid => {
                        const p = gameState.players[uid];
                        return { userId: uid, startX: p ? p.x : 0, startY: p ? p.y : 0 };
                    }),
                    pendingSession: null, gameStarted: false, sessionCreated: false,
                    isHost: mySession.hostId === gameState.userId
                };
            }
        } else if (mySession.phase === 'active') {
            if (gameState.coffee.teleportAnim) {
                gameState.coffee.teleportAnim.pendingSession = gameState.coffee.teleportAnim.pendingSession || mySession;
            } else {
                startLocalCoffee(mySession);
            }
            // Host: watch for all-ready → set startTime
            if (mySession.hostId === gameState.userId && mySession.startTime === 0) {
                const parts = Object.values(mySession.participants || {});
                const allReady = parts.length > 0 && parts.every(p => p.ready);
                if (allReady && !gameState.coffee.startTimeScheduled) {
                    gameState.coffee.startTimeScheduled = true;
                    const newestReady = Math.max(...parts.map(p => p.ready || 0));
                    const delay = Math.max(0, newestReady + 1000 - serverNow());
                    setTimeout(() => {
                        update(ref(database), { [coffeeSessionPath('startTime')]: serverNow() + 3500 });
                        gameState.coffee.startTimeScheduled = false;
                    }, delay);
                }
                if (!gameState.coffee.readyFallbackTimer) {
                    gameState.coffee.readyFallbackTimer = setTimeout(() => {
                        if (gameState.coffee.session?.startTime === 0) {
                            update(ref(database), { [coffeeSessionPath('startTime')]: serverNow() + 3500 });
                        }
                        gameState.coffee.readyFallbackTimer = null;
                    }, 5000);
                }
            }
            if (mySession.startTime > 0) {
                gameState.coffee.startTimeScheduled = false;
                if (gameState.coffee.readyFallbackTimer) {
                    clearTimeout(gameState.coffee.readyFallbackTimer);
                    gameState.coffee.readyFallbackTimer = null;
                }
            }
        } else if (mySession.phase === 'finished') {
            gameState.coffee.active = true;
            gameState.coffee.session = mySession;
            gameState.coffee.showResultsInGame = true;
        }
    });
}

async function triggerCoffeeTeleport() {
    if (!gameState.userId || !isBreakActive()) return;
    if (gameState.coffee.teleportAnim) return;
    if (gameState.coffee.active) return;

    const zonePlayers = [...gameState.coffeeZonePlayers];
    if (zonePlayers.length === 0) return;

    playSoundRobust(gameState.sounds.minigameButtonPressed);

    const alreadyIn = Object.values(gameState.coffee.activeSessions || {}).some(
        s => s && s.participants?.[gameState.userId]
    );
    if (alreadyIn) return;

    const sessionId = `${gameState.userId}_${Date.now()}`;
    const participants = {};
    zonePlayers.forEach((p, index) => {
        participants[p.userId] = {
            username:    p.username || 'لاعب',
            avatar:      p.avatar   || '',
            index,
            returnPoint: { x: p.x, y: p.y },
            mugX:        0.5,
            score:       0,
            alive:       true
        };
    });

    update(ref(database), {
        [lobbyPath(`minigames/coffee/sessions/${sessionId}`)]: {
            id:          sessionId,
            hostId:      gameState.userId,
            phase:       'teleporting',
            createdAt:   Date.now(),
            teleportAt:  serverNow(),
            participants
        }
    });
}

function createCoffeeSession() {
    const session = gameState.coffee.session;
    if (!session || !session.participants) return;
    update(ref(database), {
        [coffeeSessionPath('phase')]:     'active',
        [coffeeSessionPath('startTime')]: 0,
        [coffeeSessionPath('sugars')]:    null,
        [coffeeSessionPath('results')]:   null
    });
}

function startLocalCoffee(session) {
    if (gameState.coffee.active && gameState.coffee.localMug) return;
    // Hide top-right user card so it doesn't overlap the coffee HUD
    const _uc = document.getElementById('user-card');
    if (_uc) _uc.style.display = 'none';
    // Hide mobile joystick — coffee uses touch-drag on the canvas instead
    const _jy = document.getElementById('mobile-joystick');
    if (_jy) _jy.style.display = 'none';
    setMinigameHideUI(true);
    const participant = session.participants[gameState.userId];
    gameState.coffee.active          = true;
    gameState.coffee.localResultSent = false;
    gameState.coffee.returnPoint     = participant.returnPoint;
    gameState.coffee.localMug        = {
        x: 0.5, targetX: 0.5,
        velX: 0,          // spring velocity (normalized units/frame)
        tilt: 0,          // current tilt in radians
        score: 0, alive: true,
        flashFrames: 0,   // frames remaining for catch flash
        flashType: 'good' // 'good' | 'bad'
    };
    gameState.coffee.shakeX          = 0;
    gameState.coffee.shakeY          = 0;
    gameState.coffee.shakeDecay      = 0;
    gameState.coffee.catchParticles  = [];
    gameState.coffee.lastMugSync     = 0;
    gameState.coffee.lastSugarSpawn  = 0;
    gameState.coffee.countdownSoundPlayed = false;
    gameState.coffee.mugVisuals      = {};  // uid → { displayX } for smooth ghost interpolation
    // Warm ambient wind streaks for the background
    gameState.coffee.windParticles   = Array.from({ length: 16 }, () => ({
        x:     Math.random(),
        y:     Math.random(),
        speed: 0.00035 + Math.random() * 0.00055,
        size:  1 + Math.random() * 1.8,
        alpha: 0.03 + Math.random() * 0.07
    }));

    // Mouse control
    if (gameState.coffee._mouseMoveHandler) {
        window.removeEventListener('mousemove', gameState.coffee._mouseMoveHandler);
    }
    gameState.coffee._mouseMoveHandler = (e) => {
        if (!gameState.coffee.active || !gameState.coffee.localMug) return;
        const canvas = gameState.canvas;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const dpr  = gameState.dpr || 1;
        const W    = canvas.width / dpr;
        gameState.coffee.localMug.targetX = Math.max(0.04, Math.min(0.96, (e.clientX - rect.left) / W));
    };
    window.addEventListener('mousemove', gameState.coffee._mouseMoveHandler);

    // Touch control
    if (gameState.coffee._touchMoveHandler) {
        window.removeEventListener('touchmove', gameState.coffee._touchMoveHandler);
    }
    gameState.coffee._touchMoveHandler = (e) => {
        if (!gameState.coffee.active || !gameState.coffee.localMug) return;
        if (e.touches.length !== 1) return;
        const canvas = gameState.canvas;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const dpr  = gameState.dpr || 1;
        const W    = canvas.width / dpr;
        gameState.coffee.localMug.targetX = Math.max(0.04, Math.min(0.96, (e.touches[0].clientX - rect.left) / W));
        e.preventDefault();
    };
    window.addEventListener('touchmove', gameState.coffee._touchMoveHandler, { passive: false });

    // Signal ready
    update(ref(database), {
        [coffeeSessionPath(`participants/${gameState.userId}/ready`)]: serverNow(),
        [`users/${gameState.userId}/isWorking`]: true
    });

    // Siraj ghost cleanup: delete the entire coffee session after 90s
    // (covers the 30s match + results screen) and also on disconnect.
    if (gameState.isSirajGhost && gameState.coffee.sessionKey) {
        const cleanupPath = lobbyPath(`minigames/coffee/sessions/${gameState.coffee.sessionKey}`);
        onDisconnect(ref(database, cleanupPath)).remove();
        if (gameState.coffee._sirajCleanupTimer) clearTimeout(gameState.coffee._sirajCleanupTimer);
        gameState.coffee._sirajCleanupTimer = setTimeout(() => {
            update(ref(database), { [cleanupPath]: null });
            gameState.coffee._sirajCleanupTimer = null;
        }, 90000);
    }
}

function updateCoffeeTeleportAnim() {
    const anim = gameState.coffee.teleportAnim;
    if (!anim) return;
    const FLY_DUR = 0.45, FADE_DUR = 0.30, HOLD_DUR = 0.40, FADEIN_DUR = 0.60;
    anim.t += gameState.dtFactor / 60;

    const tryStart = () => {
        if (anim.pendingSession && !anim.gameStarted) {
            anim.gameStarted = true;
            startLocalCoffee(anim.pendingSession);
        }
    };

    if (anim.t < FLY_DUR) {
        anim.phase = 'fly';  anim.flyProgress = anim.t / FLY_DUR;  anim.screenAlpha = 0;
    } else if (anim.t < FLY_DUR + FADE_DUR) {
        anim.phase = 'fade'; anim.flyProgress = 1;
        anim.screenAlpha = (anim.t - FLY_DUR) / FADE_DUR;
    } else if (anim.t < FLY_DUR + FADE_DUR + HOLD_DUR) {
        anim.phase = 'hold'; anim.flyProgress = 1; anim.screenAlpha = 1;
        if (anim.isHost && !anim.sessionCreated) {
            anim.sessionCreated = true;
            createCoffeeSession();
        }
        tryStart();
    } else if (anim.t < FLY_DUR + FADE_DUR + HOLD_DUR + FADEIN_DUR) {
        anim.phase = 'fadein'; anim.flyProgress = 1;
        anim.screenAlpha = 1 - (anim.t - FLY_DUR - FADE_DUR - HOLD_DUR) / FADEIN_DUR;
        tryStart();
    } else {
        tryStart();
        gameState.coffee.teleportAnim = null;
    }
}

function returnFromCoffee(clearState) {
    if (gameState.coffee.readyFallbackTimer) {
        clearTimeout(gameState.coffee.readyFallbackTimer);
        gameState.coffee.readyFallbackTimer = null;
    }
    if (gameState.coffee._sirajCleanupTimer) {
        clearTimeout(gameState.coffee._sirajCleanupTimer);
        gameState.coffee._sirajCleanupTimer = null;
    }
    // Fade out applause if playing
    fadeOutAudio(gameState.sounds.minigameApplause, 900);
    gameState.coffee.applausePlayed = false;
    // Restore user card and mobile joystick
    const _uc = document.getElementById('user-card');
    if (_uc) _uc.style.display = '';
    const _jy = document.getElementById('mobile-joystick');
    if (_jy) _jy.style.display = '';
    setMinigameHideUI(false);
    // Delete the session from Firebase so the same player can start a new one
    const sessionKeyToDelete = gameState.coffee.sessionKey;
    if (sessionKeyToDelete) {
        update(ref(database), { [lobbyPath(`minigames/coffee/sessions/${sessionKeyToDelete}`)]: null });
    }
    gameState.coffee.session    = null;
    gameState.coffee.sessionKey = null;
    const player      = gameState.players[gameState.userId];
    const returnPoint = gameState.coffee.returnPoint;
    if (player && returnPoint) {
        teleportEntity(player, returnPoint.x, returnPoint.y);
        updatePlayerPosition(returnPoint.x, returnPoint.y);
    }
    gameState.coffee.active           = false;
    gameState.coffee.localMug         = null;
    gameState.coffee.catchParticles   = [];
    gameState.coffee.sugarParticles   = [];
    gameState.coffee.timerClosePlayed = false;
    gameState.coffee.shakeX           = 0;
    gameState.coffee.shakeY           = 0;
    gameState.coffee.shakeDecay       = 0;
    gameState.coffee.showResultsInGame = false;
    gameState.coffee.resultsButtonRect = null;
    gameState.coffee.localResultSent  = false;
    if (gameState.userId) update(ref(database), { [`users/${gameState.userId}/isWorking`]: false });
    if (gameState.coffee._mouseMoveHandler) {
        window.removeEventListener('mousemove', gameState.coffee._mouseMoveHandler);
        gameState.coffee._mouseMoveHandler = null;
    }
    if (gameState.coffee._touchMoveHandler) {
        window.removeEventListener('touchmove', gameState.coffee._touchMoveHandler);
        gameState.coffee._touchMoveHandler = null;
    }
}

function spawnCatchParticles(x, y, type) {
    const count = type === 'good' ? 10 : 8;
    for (let i = 0; i < count; i++) {
        const angle = (Math.PI * 2 * i / count) - Math.PI / 2 + (Math.random() - 0.5) * 0.9;
        const speed = 2.5 + Math.random() * 4;
        gameState.coffee.catchParticles.push({
            x, y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed - 1.5,
            life:    25 + Math.random() * 18,
            maxLife: 43,
            type,
            size: 4 + Math.random() * 5
        });
    }
}

function addCoffeeShake(amplitude, decay) {
    gameState.coffee.shakeX     = (Math.random() - 0.5) * 2 * amplitude;
    gameState.coffee.shakeY     = (Math.random() - 0.5) * 2 * amplitude * 0.6;
    gameState.coffee.shakeDecay = decay;
}

function updateCoffeeMode() {
    const session = gameState.coffee.session;
    const mug     = gameState.coffee.localMug;
    if (!session || !mug) return;

    if (!isBreakActive()) {
        if (session.hostId === gameState.userId) {
            update(ref(database), { [lobbyPath(`minigames/coffee/sessions/${gameState.coffee.sessionKey}`)]: null });
        }
        returnFromCoffee(false);
        return;
    }

    const now       = serverNow();
    const startTime = session.startTime || 0;

    // Countdown sound (coffee-specific)
    if (startTime > 0 && now < startTime && !gameState.coffee.countdownSoundPlayed) {
        gameState.coffee.countdownSoundPlayed = true;
        playSoundRobust(gameState.sounds.minigameCoffeeCountdown);
    }

    // Applause: start once when game goes live
    if (startTime > 0 && now >= startTime && !gameState.coffee.applausePlayed) {
        gameState.coffee.applausePlayed = true;
        const ap = gameState.sounds.minigameApplause;
        ap.loop = false;
        ap.volume = 1;
        playSoundRobust(ap);
    }

    // Freeze until start
    if (startTime === 0 || now < startTime) return;

    const elapsed  = now - startTime;
    const matchOver = elapsed >= COFFEE_MATCH_MS || !mug.alive;

    if (!matchOver) {
        // Spring physics: underdamped (ratio ≈ 0.36) → slight bouncy overshoot
        const dx    = mug.targetX - mug.x;
        const accel = dx * 0.16 - mug.velX * 0.30;
        mug.velX   += accel * gameState.dtFactor;
        mug.velX    = Math.max(-0.028, Math.min(0.028, mug.velX));
        mug.x      += mug.velX * gameState.dtFactor;
        mug.x       = Math.max(0.04, Math.min(0.96, mug.x));

        // Tilt toward velocity direction, snap back when still
        const targetTilt = mug.velX * 9;    // ±0.25 rad ≈ ±14° at max speed
        mug.tilt += (targetTilt - mug.tilt) * Math.min(1, 0.14 * gameState.dtFactor);

        // Timer-close sound: 5 s before end
        const remaining = COFFEE_MATCH_MS - elapsed;
        if (remaining <= 5000 && remaining > 0 && !gameState.coffee.timerClosePlayed) {
            gameState.coffee.timerClosePlayed = true;
            playSoundRobust(gameState.sounds.minigameCoffeeTimerClose);
        }
    }

    // Tick down catch flash
    if (mug.flashFrames > 0) mug.flashFrames = Math.max(0, mug.flashFrames - gameState.dtFactor);

    // Drift wind particles
    if (gameState.coffee.windParticles) {
        gameState.coffee.windParticles.forEach(p => {
            p.x += p.speed * gameState.dtFactor * 0.75;
            p.y += p.speed * gameState.dtFactor * 0.22;
            if (p.x > 1.06) { p.x = -0.06; p.y = Math.random(); }
            if (p.y > 1.06) { p.y = -0.06; p.x = Math.random(); }
        });
    }

    // Decay shake
    if (Math.abs(gameState.coffee.shakeX) > 0.3 || Math.abs(gameState.coffee.shakeY) > 0.3) {
        gameState.coffee.shakeX *= gameState.coffee.shakeDecay;
        gameState.coffee.shakeY *= gameState.coffee.shakeDecay;
        gameState.coffee.shakeDecay = Math.max(0, gameState.coffee.shakeDecay - 0.005 * gameState.dtFactor);
    } else {
        gameState.coffee.shakeX = 0;
        gameState.coffee.shakeY = 0;
    }

    // Spawn white pixel particles from falling sugars
    const sugarsForParticles = session.sugars || {};
    for (const [, sugar] of Object.entries(sugarsForParticles)) {
        if (sugar.caughtBy !== null && sugar.caughtBy !== undefined) continue;
        const prog = (now - sugar.spawnTime) / sugar.fallDuration;
        if (prog < 0 || prog > 1) continue;
        if (Math.random() < 0.18) {
            const canvas = gameState.canvas;
            const dpr = gameState.dpr || 1;
            const W2 = canvas.width / dpr;
            const H2 = canvas.height / dpr;
            const mugSY2 = H2 * COFFEE_MUG_Y_FRAC;
            gameState.coffee.sugarParticles.push({
                x:    sugar.x * W2 + (Math.random() - 0.5) * COFFEE_SUGAR_W * 0.6,
                y:    prog * mugSY2,
                vy:   0.6 + Math.random() * 1.4,
                vx:   (Math.random() - 0.5) * 0.8,
                life: 22 + Math.random() * 18,
                maxLife: 40,
                size: 2,   // pixelated = always 2px square
            });
        }
    }
    // Tick sugar particles
    gameState.coffee.sugarParticles = gameState.coffee.sugarParticles.filter(p => {
        p.x  += p.vx * gameState.dtFactor;
        p.y  += p.vy * gameState.dtFactor;
        p.vy += 0.06 * gameState.dtFactor; // gentle gravity
        p.life -= gameState.dtFactor;
        return p.life > 0;
    });

    // Update particles
    gameState.coffee.catchParticles = gameState.coffee.catchParticles.filter(p => {
        p.x  += p.vx * gameState.dtFactor;
        p.y  += p.vy * gameState.dtFactor;
        p.vx *= 0.93;
        p.vy  = p.vy * 0.93 + 0.15 * gameState.dtFactor;
        p.life -= gameState.dtFactor;
        return p.life > 0;
    });

    if (matchOver) {
        // Fade out applause quickly when match ends
        if (gameState.coffee.applausePlayed) {
            fadeOutAudio(gameState.sounds.minigameApplause, 350);
            gameState.coffee.applausePlayed = false;
        }
        if (!gameState.coffee.localResultSent) {
            gameState.coffee.localResultSent = true;
            update(ref(database), {
                [coffeeSessionPath(`results/${gameState.userId}`)]: {
                    score:    mug.score,
                    username: session.participants[gameState.userId]?.username || 'لاعب',
                    alive:    mug.alive
                }
            }).then(() => {
                if (session.hostId !== gameState.userId) return;
                setTimeout(() => {
                    const s = gameState.coffee.session;
                    if (!s || s.phase === 'finished') return;
                    update(ref(database), { [coffeeSessionPath('phase')]: 'finished' });
                }, 2000);
            });
        }
        return;
    }

    // Host: spawn sugars
    if (session.hostId === gameState.userId) {
        const spawnInterval = Math.max(450, 1050 - (elapsed / COFFEE_MATCH_MS) * 600);
        if (now - gameState.coffee.lastSugarSpawn > spawnInterval) {
            gameState.coffee.lastSugarSpawn = now;
            const isBad      = Math.random() < 0.14;
            const fallDur    = Math.max(1800, 4300 - (elapsed / COFFEE_MATCH_MS) * 2500);
            const sugarId    = `s${now}${Math.floor(Math.random() * 9999)}`;
            update(ref(database), {
                [coffeeSessionPath(`sugars/${sugarId}`)]: {
                    x:            0.08 + Math.random() * 0.84,
                    spawnTime:    now,
                    fallDuration: fallDur,
                    type:         isBad ? 'bad' : 'good',
                    caughtBy:     null
                }
            });
        }
    }

    // Check catches
    const canvas   = gameState.canvas;
    const dpr      = gameState.dpr || 1;
    const W        = canvas.width  / dpr;
    const H        = canvas.height / dpr;
    const mugSX    = mug.x * W;
    const mugSY    = H * COFFEE_MUG_Y_FRAC;
    const sugars   = session.sugars || {};

    for (const [sid, sugar] of Object.entries(sugars)) {
        if (sugar.caughtBy !== null && sugar.caughtBy !== undefined) continue;
        const progress = (now - sugar.spawnTime) / sugar.fallDuration;
        if (progress < 0) continue;
        if (progress > 1.18) {
            if (session.hostId === gameState.userId) {
                update(ref(database), { [coffeeSessionPath(`sugars/${sid}`)]: null });
            }
            continue;
        }
        const sy = progress * mugSY;
        const sx = sugar.x * W;

        if (sy >= mugSY - 28 && sy <= mugSY + 22 && Math.abs(sx - mugSX) < COFFEE_CATCH_HALF) {
            update(ref(database), { [coffeeSessionPath(`sugars/${sid}/caughtBy`)]: gameState.userId });
            if (sugar.type === 'bad') {
                mug.score = Math.max(0, mug.score - 3);
                mug.flashFrames = 5; mug.flashType = 'bad';
                spawnCatchParticles(sx, mugSY, 'bad');
                addCoffeeShake(40, 0.72);
                // Play bad collect sound (cloned so overlapping works)
                playPooledSound('Sound/Minigame_Coffee_Collect_Bad.mp3');
                update(ref(database), {
                    [coffeeSessionPath(`participants/${gameState.userId}/score`)]: mug.score
                });
            } else {
                mug.score++;
                mug.flashFrames = 7; mug.flashType = 'good';
                spawnCatchParticles(sx, mugSY, 'good');
                addCoffeeShake(7, 0.83);
                playPooledSound('Sound/Minigame_Coffee_Collect.mp3', 1, 0.85 + Math.random() * 0.35);
                update(ref(database), {
                    [coffeeSessionPath(`participants/${gameState.userId}/score`)]: mug.score
                });
            }
        }
    }

    // Smooth ghost mug positions (client-side interpolation)
    const mugVis = gameState.coffee.mugVisuals || (gameState.coffee.mugVisuals = {});
    Object.entries(session.participants || {}).forEach(([uid, p]) => {
        if (uid === gameState.userId) return;
        if (!mugVis[uid]) mugVis[uid] = { displayX: p.mugX != null ? p.mugX : 0.5 };
        const target = p.mugX != null ? p.mugX : 0.5;
        mugVis[uid].displayX += (target - mugVis[uid].displayX) * Math.min(1, 0.10 * gameState.dtFactor);
    });

    // Sync mug X
    if (now - gameState.coffee.lastMugSync > 80) {
        gameState.coffee.lastMugSync = now;
        update(ref(database), {
            [coffeeSessionPath(`participants/${gameState.userId}/mugX`)]: Math.round(mug.x * 1000) / 1000
        });
    }
}

function renderCoffee() {
    const ctx    = gameState.ctx;
    const canvas = gameState.canvas;
    const session = gameState.coffee.session;
    const mug    = gameState.coffee.localMug;
    if (!ctx || !canvas || !session) return;

    const dpr = gameState.dpr || 1;
    const W   = canvas.width  / dpr;
    const H   = canvas.height / dpr;

    ctx.save();
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = '#180d06';
    ctx.fillRect(0, 0, W, H);

    const now       = serverNow();
    const startTime = session.startTime || 0;
    const elapsed   = startTime > 0 ? Math.max(0, now - startTime) : 0;
    const mugSY     = H * COFFEE_MUG_Y_FRAC;
    const shX       = gameState.coffee.shakeX || 0;
    const shY       = gameState.coffee.shakeY || 0;

    // Background gradient warmth
    const grad = ctx.createRadialGradient(W / 2, H * 0.3, 0, W / 2, H * 0.3, W * 0.7);
    grad.addColorStop(0, 'rgba(80,40,10,0.28)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // Ambient wind streaks
    if (mug && mug.windParticles) {
        mug.windParticles.forEach(p => {
            ctx.save();
            ctx.globalAlpha = p.alpha;
            ctx.fillStyle   = '#c8844a';
            ctx.beginPath();
            ctx.ellipse(p.x * W, p.y * H, p.size * 4, p.size * 0.9, 0.25, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        });
    }

    // Draw falling sugars
    if (startTime > 0 && now >= startTime) {
        const sugars = session.sugars || {};
        for (const [, sugar] of Object.entries(sugars)) {
            if (sugar.caughtBy !== null && sugar.caughtBy !== undefined) continue;
            const progress = (now - sugar.spawnTime) / sugar.fallDuration;
            if (progress < 0 || progress > 1.12) continue;

            const sugarX = sugar.x * W + shX;
            const sugarY = progress * mugSY + shY;

            // Soft trail
            if (progress < 0.9) {
                ctx.save();
                ctx.globalAlpha = (1 - progress) * 0.18;
                const trailGrad = ctx.createLinearGradient(sugarX, sugarY - COFFEE_SUGAR_H, sugarX, sugarY);
                trailGrad.addColorStop(0, 'transparent');
                trailGrad.addColorStop(1, sugar.type === 'bad' ? '#ff5555' : '#ffe0a0');
                ctx.fillStyle = trailGrad;
                ctx.fillRect(sugarX - 10, sugarY - COFFEE_SUGAR_H * 0.8, 20, COFFEE_SUGAR_H * 0.8);
                ctx.restore();
            }

            const img = sugar.type === 'bad' ? gameState.assets.coffeeBadSugar : gameState.assets.coffeeSugar;
            if (img && img.complete && img.naturalWidth) {
                ctx.save();
                ctx.translate(sugarX, sugarY);
                ctx.rotate(Math.sin(now * 0.0025 + sugar.spawnTime * 0.001) * 0.07);
                ctx.drawImage(img, -COFFEE_SUGAR_W / 2, -COFFEE_SUGAR_H / 2, COFFEE_SUGAR_W, COFFEE_SUGAR_H);
                ctx.restore();
            }
        }
    }

    // Catch particles
    gameState.coffee.catchParticles.forEach(p => {
        const alpha = Math.max(0, p.life / p.maxLife);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = p.type === 'good' ? '#f4c82b' : '#ff4444';
        ctx.beginPath();
        ctx.arc(p.x + shX, p.y + shY, p.size * alpha, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    });

    // White pixel particles from sugars
    gameState.coffee.sugarParticles.forEach(p => {
        const alpha = Math.max(0, p.life / p.maxLife) * 0.85;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = '#ffffff';
        // Disable anti-aliasing for pixelated look
        ctx.imageSmoothingEnabled = false;
        ctx.fillRect(Math.round(p.x + shX), Math.round(p.y + shY), p.size, p.size);
        ctx.restore();
    });

    // Ghost mugs (other players) — use client-side smoothed position
    const mugImg = gameState.assets.coffeeMug;
    Object.entries(session.participants || {}).forEach(([uid, participant]) => {
        if (uid === gameState.userId) return;
        const mugVis = gameState.coffee.mugVisuals || {};
        const ghostX = ((mugVis[uid] ? mugVis[uid].displayX : null) ?? participant.mugX ?? 0.5) * W;
        ctx.save();
        ctx.globalAlpha = participant.alive === false ? 0.12 : 0.28;
        if (mugImg && mugImg.complete && mugImg.naturalWidth) {
            ctx.drawImage(mugImg, ghostX - COFFEE_MUG_W / 2 + shX, mugSY - COFFEE_MUG_H / 2 + shY, COFFEE_MUG_W, COFFEE_MUG_H);
        }
        ctx.globalAlpha = participant.alive === false ? 0.2 : 0.5;
        ctx.fillStyle   = 'white';
        ctx.font        = '11px Rubik';
        ctx.textAlign   = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText((participant.username || '?').slice(0, 10), ghostX + shX, mugSY - COFFEE_MUG_H / 2 - 5 + shY);
        ctx.restore();
    });

    // Local mug — rendered with tilt, flash overlay, and score bubble
    if (mug) {
        const mugX = mug.x * W + shX;
        const mugY = mugSY + shY;

        ctx.save();
        if (!mug.alive) ctx.globalAlpha = 0.35;
        ctx.translate(mugX, mugY);
        ctx.rotate(mug.tilt || 0);
        if (mugImg && mugImg.complete && mugImg.naturalWidth) {
            if (mug.flashFrames > 0) {
                // Tint mug on an offscreen canvas so source-atop only affects
                // the mug's own pixels — never the transparent bounding box.
                const oc   = document.createElement('canvas');
                oc.width   = COFFEE_MUG_W;
                oc.height  = COFFEE_MUG_H;
                const octx = oc.getContext('2d');
                octx.drawImage(mugImg, 0, 0, COFFEE_MUG_W, COFFEE_MUG_H);
                const flashAlpha = Math.min(1, mug.flashFrames / 7) * 0.92;
                octx.globalAlpha = flashAlpha;
                octx.globalCompositeOperation = 'source-atop';
                octx.fillStyle = mug.flashType === 'bad' ? '#ff3030' : '#ffffff';
                octx.fillRect(0, 0, COFFEE_MUG_W, COFFEE_MUG_H);
                ctx.drawImage(oc, -COFFEE_MUG_W / 2, -COFFEE_MUG_H / 2);
            } else {
                ctx.drawImage(mugImg, -COFFEE_MUG_W / 2, -COFFEE_MUG_H / 2, COFFEE_MUG_W, COFFEE_MUG_H);
            }
        }
        ctx.restore();

        // Score bubble above mug (follows tilt)
        if (mug.alive && startTime > 0 && now >= startTime) {
            ctx.save();
            ctx.translate(mugX, mugY - COFFEE_MUG_H / 2 - 22);
            ctx.rotate((mug.tilt || 0) * 0.4);  // subtle echo of the tilt
            ctx.fillStyle = 'rgba(255,255,255,0.12)';
            ctx.beginPath();
            if (ctx.roundRect) { ctx.roundRect(-22, -14, 44, 28, 14); }
            else { ctx.rect(-22, -14, 44, 28); }
            ctx.fill();
            ctx.fillStyle    = '#f4c82b';
            ctx.font         = 'bold 17px Rubik';
            ctx.textAlign    = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(`${mug.score}`, 0, 0);
            ctx.restore();
        }
    }

    // Waiting overlay
    if (startTime === 0) {
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle    = 'white';
        ctx.font         = 'bold 28px Rubik';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('جاري التحميل...', W / 2, H / 2);
    } else if (now < startTime) {
        const count = Math.max(1, Math.ceil((startTime - now) / 1000));
        ctx.fillStyle = 'rgba(0,0,0,0.52)';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle    = 'white';
        ctx.font         = 'bold 96px Rubik';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowBlur   = 32;
        ctx.shadowColor  = 'rgba(244,200,43,0.6)';
        ctx.fillText(count.toString(), W / 2, H / 2);
        ctx.shadowBlur   = 0;
    }

    // HUD
    drawCoffeeHud(W, H, elapsed, session, mug);

    // Results
    if (session.phase === 'finished' || gameState.coffee.showResultsInGame) {
        drawCoffeeResults(W, H, session);
    }

    // Teleport overlay (still inside DPR scale)
    const coffeeAnim = gameState.coffee.teleportAnim;
    if (coffeeAnim && coffeeAnim.screenAlpha > 0.01) {
        ctx.save();
        ctx.globalAlpha = Math.min(1, coffeeAnim.screenAlpha);
        ctx.fillStyle   = 'black';
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
    }

    ctx.restore(); // undo DPR scale
}

function drawCoffeeHud(W, H, elapsed, session, mug) {
    const ctx       = gameState.ctx;
    const startTime = session.startTime || 0;
    const now       = serverNow();
    const gameActive = startTime > 0 && now >= startTime;

    const listW  = 200;
    const listX  = W - listW - 10;
    let   listY  = 14;

    // ── Timer (only once game has started) ──────────────────────────
    if (gameActive) {
        const remaining = Math.max(0, COFFEE_MATCH_MS - elapsed);
        const secs      = Math.ceil(remaining / 1000);
        ctx.save();
        ctx.fillStyle = remaining < 8000 ? 'rgba(200,30,30,0.92)' : 'rgba(18,10,4,0.82)';
        if (ctx.roundRect) {
            ctx.beginPath(); ctx.roundRect(listX, listY, listW, 38, 10); ctx.fill();
        } else { ctx.fillRect(listX, listY, listW, 38); }
        ctx.fillStyle    = 'white';
        ctx.font         = 'bold 20px Rubik';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        if (remaining < 8000) { ctx.shadowBlur = 10; ctx.shadowColor = '#ff4444'; }
        ctx.fillText(`⏱ ${secs}s`, listX + listW / 2, listY + 19);
        ctx.shadowBlur = 0;
        ctx.restore();
        listY += 46;
    } else {
        listY += 4; // small top padding when no timer
    }

    // ── Leaderboard (always visible during coffee game) ─────────────
    const participants = Object.entries(session.participants || {})
        .sort(([, a], [, b]) => (b.score || 0) - (a.score || 0));
    const rowH    = 40;
    const avSize  = 28;
    const headerH = 28;
    const panelH  = headerH + participants.length * rowH + 6;

    ctx.save();
    // Panel background
    ctx.fillStyle = 'rgba(12,6,2,0.80)';
    if (ctx.roundRect) {
        ctx.beginPath(); ctx.roundRect(listX, listY, listW, panelH, 10); ctx.fill();
    } else { ctx.fillRect(listX, listY, listW, panelH); }
    ctx.strokeStyle = 'rgba(244,200,43,0.18)';
    ctx.lineWidth   = 1;
    if (ctx.roundRect) {
        ctx.beginPath(); ctx.roundRect(listX, listY, listW, panelH, 10); ctx.stroke();
    }
    // Header label
    ctx.fillStyle    = 'rgba(244,200,43,0.7)';
    ctx.font         = 'bold 12px Rubik';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('الترتيب ☕', listX + listW / 2, listY + headerH / 2);

    participants.forEach(([uid, p], i) => {
        const ry      = listY + headerH + i * rowH;
        const isLocal = uid === gameState.userId;
        const dead    = p.alive === false;

        // Row highlight
        if (isLocal) {
            ctx.fillStyle = 'rgba(244,200,43,0.12)';
            ctx.fillRect(listX + 4, ry, listW - 8, rowH - 2);
        }

        // Avatar circle
        const ax  = listX + 8 + avSize / 2;
        const acy = ry + rowH / 2;
        ctx.save();
        ctx.beginPath(); ctx.arc(ax, acy, avSize / 2, 0, Math.PI * 2);
        ctx.fillStyle = dead ? '#333' : (isLocal ? '#f4c82b' : '#444');
        ctx.fill();
        const avImg = gameState.avatarCache[uid];
        if (!avImg && p.avatar) {
            const a = new Image(); a.crossOrigin = 'anonymous'; a.src = p.avatar;
            a.onload = () => { gameState.avatarCache[uid] = a; };
            a.onerror = () => { gameState.avatarCache[uid] = 'failed'; };
        }
        if (avImg && avImg !== 'failed') {
            ctx.beginPath(); ctx.arc(ax, acy, avSize / 2, 0, Math.PI * 2); ctx.clip();
            if (dead) ctx.filter = 'grayscale(80%)';
            ctx.drawImage(avImg, ax - avSize / 2, acy - avSize / 2, avSize, avSize);
            ctx.filter = 'none';
        } else {
            ctx.fillStyle    = 'white'; ctx.font = 'bold 10px Rubik';
            ctx.textAlign    = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText((p.username || '?').charAt(0).toUpperCase(), ax, acy + 1);
        }
        ctx.restore();

        // Name
        ctx.fillStyle    = dead ? '#555' : (isLocal ? '#f4c82b' : 'rgba(255,255,255,0.85)');
        ctx.font         = `${isLocal ? 'bold ' : ''}14px Rubik`;
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText((p.username || '?').slice(0, 9), listX + 10 + avSize + 4, acy);

        // Score / dead
        ctx.fillStyle = dead ? '#666' : '#f4c82b';
        ctx.font      = 'bold 14px Rubik';
        ctx.textAlign = 'right';
        ctx.fillText(dead ? '💀' : `${p.score || 0}`, listX + listW - 8, acy);
    });
    ctx.restore();
}

function drawCoffeeResults(W, H, session) {
    const ctx     = gameState.ctx;
    const results = session.results || {};
    const ranked  = Object.entries(results).sort(([, a], [, b]) => (b.score || 0) - (a.score || 0));

    const panelW = Math.min(400, W - 60);
    const rowH   = 46;
    const panelH = 120 + ranked.length * rowH;
    const px     = (W - panelW) / 2;
    const py     = (H - panelH) / 2;

    ctx.fillStyle = 'rgba(10,5,2,0.95)';
    if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(px, py, panelW, panelH, 14);
        ctx.fill();
    } else {
        ctx.fillRect(px, py, panelW, panelH);
    }
    ctx.strokeStyle = 'rgba(244,200,43,0.3)';
    ctx.lineWidth   = 1.5;
    if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(px, py, panelW, panelH, 14);
        ctx.stroke();
    }

    ctx.fillStyle    = '#f4c82b';
    ctx.font         = 'bold 22px Rubik';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('النتائج ☕', W / 2, py + 40);

    ranked.forEach(([uid, result], i) => {
        const ry     = py + 64 + i * rowH;
        const dead   = result.alive === false;
        if (i % 2 === 0) {
            ctx.fillStyle = 'rgba(255,255,255,0.03)';
            ctx.fillRect(px + 12, ry, panelW - 24, rowH - 4);
        }
        // Rank number
        ctx.fillStyle    = i === 0 ? '#f4c82b' : 'rgba(255,255,255,0.45)';
        ctx.font         = 'bold 13px Rubik';
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${i + 1}.`, px + 16, ry + rowH / 2);
        // Avatar
        const avSize = 28;
        const ax     = px + 38 + avSize / 2;
        const acy    = ry + rowH / 2;
        ctx.save();
        ctx.beginPath(); ctx.arc(ax, acy, avSize / 2, 0, Math.PI * 2);
        ctx.fillStyle = dead ? '#333' : (i === 0 ? '#f4c82b' : '#555'); ctx.fill();
        // Look up avatar from participants (results only store username/score)
        const participantData = session.participants?.[uid];
        const avImg = gameState.avatarCache[uid];
        if (!avImg && participantData?.avatar) {
            const a = new Image(); a.crossOrigin = 'anonymous'; a.src = participantData.avatar;
            a.onload = () => { gameState.avatarCache[uid] = a; };
            a.onerror = () => { gameState.avatarCache[uid] = 'failed'; };
        }
        if (avImg && avImg !== 'failed') {
            ctx.beginPath(); ctx.arc(ax, acy, avSize / 2, 0, Math.PI * 2); ctx.clip();
            if (dead) ctx.filter = 'grayscale(80%)';
            ctx.drawImage(avImg, ax - avSize / 2, acy - avSize / 2, avSize, avSize);
            ctx.filter = 'none';
        } else {
            ctx.fillStyle = 'white'; ctx.font = 'bold 12px Rubik';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText((result.username || '?').charAt(0).toUpperCase(), ax, acy + 1);
        }
        ctx.restore();
        // Name + score
        ctx.fillStyle    = dead ? '#666' : (i === 0 ? '#f4c82b' : 'rgba(255,255,255,0.85)');
        ctx.font         = `${i === 0 ? 'bold ' : ''}14px Rubik`;
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText((result.username || '?').slice(0, 11), ax + avSize / 2 + 8, acy);
        ctx.textAlign = 'right';
        ctx.fillText(dead ? '💀 خسر' : `${result.score || 0} ☕`, px + panelW - 16, acy);
    });

    // Return button
    const btnW = 130, btnH = 42;
    const bx   = px + (panelW - btnW) / 2;
    const by   = py + panelH - btnH - 18;
    ctx.fillStyle = '#6b3a14';
    if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(bx, by, btnW, btnH, 10);
        ctx.fill();
    } else {
        ctx.fillRect(bx, by, btnW, btnH);
    }
    ctx.fillStyle    = 'white';
    ctx.font         = 'bold 17px Rubik';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('عودة', bx + btnW / 2, by + btnH / 2);
    gameState.coffee.resultsButtonRect = { x: bx, y: by, w: btnW, h: btnH };
}

function drawCoffeeMachine() {
    if (!isBreakActive()) return;
    const ctx = gameState.ctx;
    const img = gameState.assets.coffeeZone;
    if (!img || !img.complete || !img.naturalWidth) return;

    const cx = COFFEE_ZONE_CX;
    const cy = COFFEE_ZONE_CY;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    if (gameState.activeCoffeeZone && !gameState.coffee.teleportAnim) {
        ctx.shadowBlur  = 28;
        ctx.shadowColor = 'rgba(160,80,20,0.70)';
    }
    ctx.drawImage(img, cx - COFFEE_ZONE_IMG_W / 2, cy - COFFEE_ZONE_IMG_H / 2, COFFEE_ZONE_IMG_W, COFFEE_ZONE_IMG_H);
    ctx.shadowBlur = 0;

    const zonePlayers = gameState.coffeeZonePlayers;
    if (zonePlayers.length > 0 && !gameState.coffee.teleportAnim) {
        drawCoffeeReadyList(ctx, cx, cy - COFFEE_ZONE_IMG_H / 2 - 6, zonePlayers);
    }
    ctx.restore();
}

function drawCoffeeReadyList(ctx, cx, bottomY, players) {
    const rowH = 34, listW = 158, padTop = 22;
    const listH = players.length * rowH + padTop + 4;
    const listX = cx - listW / 2;
    const listY = bottomY - listH - 6;

    ctx.save();
    ctx.fillStyle = 'rgba(20,10,3,0.90)';
    drawRoundedRectPath(ctx, listX, listY, listW, listH, 10);
    ctx.fill();
    ctx.strokeStyle = 'rgba(244,200,43,0.12)';
    ctx.lineWidth   = 1;
    drawRoundedRectPath(ctx, listX, listY, listW, listH, 10);
    ctx.stroke();

    ctx.fillStyle = 'rgba(244,200,43,0.85)';
    ctx.font      = 'bold 12px Rubik';
    ctx.textAlign = 'center';
    ctx.fillText('جاهزون ☕', cx, listY + 15);

    players.forEach((p, i) => {
        const rowY   = listY + padTop + i * rowH;
        const avatarR = 12;
        const avatarX = listX + 22;
        const avatarCY = rowY + rowH / 2;

        ctx.beginPath();
        ctx.arc(avatarX, avatarCY, avatarR, 0, Math.PI * 2);
        ctx.fillStyle = p.userId === gameState.userId ? COLORS.blue : '#444';
        ctx.fill();

        const avImg = gameState.avatarCache[p.userId];
        if (avImg && avImg !== 'failed') {
            ctx.save();
            ctx.beginPath();
            ctx.arc(avatarX, avatarCY, avatarR, 0, Math.PI * 2);
            ctx.clip();
            ctx.drawImage(avImg, avatarX - avatarR, avatarCY - avatarR, avatarR * 2, avatarR * 2);
            ctx.restore();
        }
        ctx.fillStyle = 'white';
        ctx.font      = '13px Rubik';
        ctx.textAlign = 'left';
        ctx.fillText((p.username || '?').slice(0, 12), listX + 40, avatarCY + 4);
        ctx.fillStyle = '#f4c82b';
        ctx.font      = 'bold 11px Rubik';
        ctx.textAlign = 'right';
        ctx.fillText('✓ جاهز', listX + listW - 8, avatarCY + 4);
    });
    ctx.restore();
}

function drawCoffeeHint() {
    if (!gameState.activeCoffeeZone) return;
    if (gameState.coffee.teleportAnim) return;
    const ctx = gameState.ctx;
    ctx.save();
    ctx.fillStyle  = 'white';
    ctx.font       = 'bold 13px Rubik';
    ctx.textAlign  = 'center';
    ctx.shadowBlur  = 6;
    ctx.shadowColor = 'black';
    ctx.fillText('اضغط زر البدء', COFFEE_BTN_CX, COFFEE_BTN_CY - COFFEE_BTN_R - 10);
    ctx.shadowBlur = 0;
    ctx.restore();
}

function drawRaceMachine() {
    const ctx = gameState.ctx;
    if (!isBreakActive()) return;

    const img = gameState.assets.race;
    if (!img || !img.complete || !img.naturalWidth) return;

    const cx = RACE_ZONE_CX;
    const cy = RACE_ZONE_CY;

    ctx.save();
    ctx.imageSmoothingEnabled = false;

    if (gameState.activeRaceButton && !gameState.race.teleportAnim) {
        ctx.shadowBlur = 28;
        ctx.shadowColor = 'rgba(220, 100, 30, 0.7)';
    }

    ctx.drawImage(img, cx - RACE_ZONE_IMG_W / 2, cy - RACE_ZONE_IMG_H / 2, RACE_ZONE_IMG_W, RACE_ZONE_IMG_H);
    ctx.shadowBlur = 0;

    const zonePlayers = gameState.raceZonePlayers;
    if (zonePlayers.length > 0 && !gameState.race.teleportAnim) {
        drawReadyList(ctx, cx, cy - RACE_ZONE_IMG_H / 2 - 6, zonePlayers);
    }

    ctx.restore();
}

function drawReadyList(ctx, cx, bottomY, players) {
    const rowH = 34;
    const listW = 158;
    const padTop = 22;
    const listH = players.length * rowH + padTop + 4;
    const listX = cx - listW / 2;
    const listY = bottomY - listH - 6;

    ctx.save();
    ctx.fillStyle = 'rgba(8, 10, 20, 0.88)';
    drawRoundedRectPath(ctx, listX, listY, listW, listH, 10);
    ctx.fill();

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    drawRoundedRectPath(ctx, listX, listY, listW, listH, 10);
    ctx.stroke();

    ctx.fillStyle = 'rgba(180, 180, 200, 0.7)';
    ctx.font = 'bold 12px Rubik';
    ctx.textAlign = 'center';
    ctx.fillText('جاهزون للسباق', cx, listY + 15);

    players.forEach((p, i) => {
        const rowY = listY + padTop + i * rowH;
        const avatarR = 12;
        const avatarX = listX + 22;
        const avatarCY = rowY + rowH / 2;

        ctx.beginPath();
        ctx.arc(avatarX, avatarCY, avatarR, 0, Math.PI * 2);
        ctx.fillStyle = p.userId === gameState.userId ? COLORS.blue : '#444';
        ctx.fill();

        const avImg = gameState.avatarCache[p.userId];
        if (avImg && avImg !== 'failed') {
            ctx.save();
            ctx.beginPath();
            ctx.arc(avatarX, avatarCY, avatarR, 0, Math.PI * 2);
            ctx.clip();
            ctx.imageSmoothingEnabled = true;
            ctx.drawImage(avImg, avatarX - avatarR, avatarCY - avatarR, avatarR * 2, avatarR * 2);
            ctx.restore();
        }

        ctx.fillStyle = 'white';
        ctx.font = '13px Rubik';
        ctx.textAlign = 'left';
        ctx.fillText((p.username || '?').slice(0, 12), listX + 40, avatarCY + 4);

        ctx.fillStyle = '#4caf50';
        ctx.font = 'bold 11px Rubik';
        ctx.textAlign = 'right';
        ctx.fillText('✓ جاهز', listX + listW - 8, avatarCY + 4);
    });

    ctx.restore();
}

function drawRaceHint() {
    if (gameState.race.teleportAnim) return;
    if (!gameState.activeRaceZone) return;
    const ctx = gameState.ctx;
    ctx.save();
    ctx.fillStyle = 'white';
    ctx.font = 'bold 13px Rubik';
    ctx.textAlign = 'center';
    ctx.shadowBlur = 6;
    ctx.shadowColor = 'black';
    ctx.fillText('اضغط زر البدء', RACE_ZONE_CX, RACE_BTN_CY - RACE_BTN_R - 10);
    ctx.shadowBlur = 0;
    ctx.restore();
}

async function triggerRaceTeleport() {
    if (!gameState.userId || !isBreakActive()) return;
    if (gameState.race.teleportAnim) return;
    if (gameState.race.active) return;

    const zonePlayers = [...gameState.raceZonePlayers];
    if (zonePlayers.length === 0) return;

    // Button-press confirmation sound
    playSoundRobust(gameState.sounds.minigameButtonPressed);

    if (!isRaceTrackReady()) {
        showRaceMessage('جاري تحميل حلبة السباق، حاول مرة أخرى');
        return;
    }

    // Block if this player is already in an active session
    const alreadyInRace = Object.values(gameState.race.activeSessions || {}).some(
        s => s && s.participants?.[gameState.userId]
    );
    if (alreadyInRace) return;

    const sessionId = `${gameState.userId}_${Date.now()}`;

    if (gameState.isSirajGhost) {
        onDisconnect(ref(database, lobbyPath(`minigames/race/sessions/${sessionId}`))).remove();
    }

    const participants = {};
    zonePlayers.forEach((p, index) => {
        participants[p.userId] = {
            username: p.username || 'لاعب',
            avatar: p.avatar || '',
            index,
            returnPoint: { x: p.x, y: p.y }
        };
    });

    // Write 'teleporting' phase — ALL participants react to this and start animation in sync
    update(ref(database), {
        [lobbyPath(`minigames/race/sessions/${sessionId}`)]: {
            id: sessionId,
            hostId: gameState.userId,
            phase: 'teleporting',
            createdAt: Date.now(),
            teleportAt: serverNow(),
            participants
        }
    });
}

function createRaceFromParticipants() {
    const session = gameState.race.session;
    if (!session || !session.participants || !isRaceTrackReady()) return;

    const cars = {};
    Object.keys(session.participants).forEach(userId => {
        const p = session.participants[userId];
        cars[userId] = createRaceCar(p.index || 0, p.username || 'لاعب');
    });

    update(ref(database), {
        [raceSessionPath('phase')]: 'race',
        [raceSessionPath('startTime')]: 0,
        [raceSessionPath('cars')]: cars,
        [raceSessionPath('results')]: null
    });
}

function updateTeleportAnim() {
    const anim = gameState.race.teleportAnim;
    if (!anim) return;

    const FLY_DUR = 0.45;
    const FADE_DUR = 0.30;
    const HOLD_DUR = 0.40;
    const FADEIN_DUR = 0.60;

    anim.t += gameState.dtFactor / 60;

    const tryStartRace = () => {
        if (anim.pendingSession && !anim.raceStarted) {
            anim.raceStarted = true;
            startLocalRace(anim.pendingSession);
        }
    };

    if (anim.t < FLY_DUR) {
        anim.phase = 'fly';
        anim.flyProgress = anim.t / FLY_DUR;
        anim.screenAlpha = 0;
    } else if (anim.t < FLY_DUR + FADE_DUR) {
        anim.phase = 'fade';
        anim.flyProgress = 1;
        anim.screenAlpha = (anim.t - FLY_DUR) / FADE_DUR;
    } else if (anim.t < FLY_DUR + FADE_DUR + HOLD_DUR) {
        anim.phase = 'hold';
        anim.flyProgress = 1;
        anim.screenAlpha = 1;
        // Host triggers race creation once during hold
        if (anim.isHost && !anim.raceCreated) {
            anim.raceCreated = true;
            createRaceFromParticipants();
        }
        tryStartRace();
    } else if (anim.t < FLY_DUR + FADE_DUR + HOLD_DUR + FADEIN_DUR) {
        anim.phase = 'fadein';
        anim.flyProgress = 1;
        anim.screenAlpha = 1 - (anim.t - FLY_DUR - FADE_DUR - HOLD_DUR) / FADEIN_DUR;
        tryStartRace();
    } else {
        tryStartRace();
        gameState.race.teleportAnim = null;
    }
}

function drawTeleportOverlay(W, H) {
    const anim = gameState.race.teleportAnim || gameState.coffee.teleportAnim || gameState.laptopBoss.teleportAnim;
    if (!anim || anim.screenAlpha < 0.01) return;
    const ctx = gameState.ctx;
    const canvas = gameState.canvas;
    // W/H are logical viewport dims (already in DPR-scaled context when called from render/renderRace)
    const w = W || canvas.width / (gameState.dpr || 1);
    const h = H || canvas.height / (gameState.dpr || 1);
    ctx.save();
    ctx.globalAlpha = Math.min(1, anim.screenAlpha);
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
    ctx.restore();
}

function renderRace() {
    const ctx = gameState.ctx;
    const canvas = gameState.canvas;
    const session = gameState.race.session;
    const localCar = gameState.race.localCar;
    const track = gameState.race.track;
    if (!ctx || !canvas || !session || !localCar) return;

    const dpr = gameState.dpr || 1;
    const W = canvas.width  / dpr;
    const H = canvas.height / dpr;

    // DPR scale — all drawing below uses logical pixels
    ctx.save();
    ctx.scale(dpr, dpr);

    ctx.fillStyle = '#1a3324';
    ctx.fillRect(0, 0, W, H);

    if (!track || !track.image) {
        ctx.fillStyle = 'white';
        ctx.font = 'bold 24px Rubik';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('جاري تحميل حلبة السباق...', W / 2, H / 2);
        updateRaceHud(session, localCar);
        ctx.restore();
        return;
    }

    const drawW = track.width * track.scale;
    const drawH = track.height * track.scale;

    ctx.save();
    ctx.translate(W / 2, H / 2);
    // Mobile: rotate camera to follow car heading so car always drives "upward"
    if (isMobile()) {
        ctx.rotate(gameState.race.camera.angle);
    }
    ctx.scale(gameState.zoom, gameState.zoom);
    ctx.translate(gameState.race.camera.x, gameState.race.camera.y);

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(track.image, -drawW / 2, -drawH / 2, drawW, drawH);

    const remoteCars = session.cars || {};
    // Draw remote cars then local car (no object copy needed)
    Object.entries(remoteCars).forEach(([userId, car]) => {
        if (userId === gameState.userId) return; // drawn separately below
        const participant = session.participants && session.participants[userId];
        const drawCar = getRaceCarDrawState(userId, car);
        drawRaceCar(drawCar, participant ? participant.index || 0 : 0, false);
    });
    // Local car
    {
        const participant = session.participants && session.participants[gameState.userId];
        const drawCar = getRaceCarDrawState(gameState.userId, localCar);
        drawRaceCar(drawCar, participant ? participant.index || 0 : 0, true);
    }

    ctx.restore();  // undo world translate/zoom/rotation

    // Second pass: labels in screen space (remote first, then local)
    Object.entries(remoteCars).forEach(([userId, car]) => {
        if (userId === gameState.userId) return;
        const participant = session.participants && session.participants[userId];
        const drawCar2 = getRaceCarDrawState(userId, car);
        const cx = drawCar2 ? drawCar2.x : car.x;
        const cy = drawCar2 ? drawCar2.y : car.y;
        const screen = raceWorldToScreen(cx, cy, W, H);
        drawRaceCarLabelScreen(userId, participant, screen.x, screen.y, false);
    });
    {
        const participant = session.participants && session.participants[gameState.userId];
        const drawCar2 = getRaceCarDrawState(gameState.userId, localCar);
        const cx = drawCar2 ? drawCar2.x : localCar.x;
        const cy = drawCar2 ? drawCar2.y : localCar.y;
        const screen = raceWorldToScreen(cx, cy, W, H);
        drawRaceCarLabelScreen(gameState.userId, participant, screen.x, screen.y, true);
    }
    const now = serverNow();
    if (session.startTime === 0) {
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = 'white';
        ctx.font = 'bold 28px Rubik';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('جاري التحميل...', W / 2, H / 2);
    } else if (now < (session.startTime || 0)) {
        const count = Math.max(1, Math.ceil(((session.startTime || 0) - now) / 1000));
        ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = 'white';
        ctx.font = 'bold 92px Rubik';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(count.toString(), W / 2, H / 2);
    } else if (localCar.finished) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = 'white';
        ctx.font = 'bold 34px Rubik';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('انتهيت!', W / 2, H / 2);
    }

    // If the session is finished, draw the in-game results overlay
    const showResults = (session.phase === 'finished') || !!gameState.race.showResultsInGame;
    if (showResults) {
        const results = session.results || {};
        const participants = Object.entries(session.participants || {})
            .sort(([, a], [, b]) => (a.index || 0) - (b.index || 0))
            .map(([id, p]) => ({ id, ...p }));
        // sort by finish time for ranking display
        const ranked = participants.slice().sort((a, b) => (results[a.id]?.finishTime || Infinity) - (results[b.id]?.finishTime || Infinity));

        const panelW = Math.min(520, W - 80);
        const rowH = 44;
        const panelH = 120 + ranked.length * rowH;
        const px = (W - panelW) / 2;
        const py = (H - panelH) / 2;

        // panel background
        ctx.fillStyle = 'rgba(12, 12, 12, 0.92)';
        drawRoundedRectPath(ctx, px, py, panelW, panelH, 12);
        ctx.fill();

        // Title
        ctx.fillStyle = 'white';
        ctx.font = 'bold 20px Rubik';
        ctx.textAlign = 'left';
        ctx.fillText('النتائج', px + 20, py + 34);

        // Rows
        ctx.font = '16px Rubik';
        for (let i = 0; i < ranked.length; i++) {
            const row = ranked[i];
            const ry = py + 60 + i * rowH;
            // background strip
            if (i % 2 === 0) {
                ctx.fillStyle = 'rgba(255,255,255,0.02)';
                ctx.fillRect(px + 12, ry - 8, panelW - 24, rowH - 6);
            }

            // rank
            ctx.fillStyle = '#f4c82b';
            ctx.textAlign = 'left';
            ctx.fillText(`${i + 1}.`, px + 24, ry + 12);

            // avatar
            const avatarSize = 36;
            const ax = px + 60;
            const ay = ry - 8 + (rowH - avatarSize) / 2;
            let img = gameState.avatarCache[row.id];
            if (!img && row.avatar) {
                const a = new Image();
                a.crossOrigin = 'anonymous';
                a.src = row.avatar;
                a.onload = () => { gameState.avatarCache[row.id] = a; };
                a.onerror = () => { gameState.avatarCache[row.id] = 'failed'; };
                img = null;
            }

            const playerObj = gameState.players[row.id];
            const shouldGray = !!(playerObj && playerObj.isWorking && row.id !== gameState.userId);

            ctx.save();
            ctx.beginPath();
            ctx.rect(ax, ay, avatarSize, avatarSize);
            ctx.clip();
            if (img && img !== 'failed') {
                if (shouldGray) ctx.filter = 'grayscale(60%)';
                ctx.drawImage(img, ax, ay, avatarSize, avatarSize);
                ctx.filter = 'none';
            } else {
                // placeholder avatar
                const placeholderColor = '#086fb6';
                ctx.fillStyle = shouldGray ? '#9a9a9a' : placeholderColor;
                ctx.fillRect(ax, ay, avatarSize, avatarSize);
                ctx.fillStyle = 'white';
                ctx.font = 'bold 14px Rubik';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText((row.username || '?').charAt(0).toUpperCase(), ax + avatarSize / 2, ay + avatarSize / 2 + 1);
            }
            ctx.restore();

            // name
            ctx.fillStyle = 'white';
            ctx.textAlign = 'left';
            ctx.fillText(row.username || 'لاعب', px + 64 + avatarSize + 8, ry + 12);

            // time/result
            ctx.textAlign = 'right';
            const t = results[row.id]?.finishTime;
            ctx.fillText(t ? formatRaceTime(t) : 'لم ينته', px + panelW - 28, ry + 12);
        }

        // Return button
        const btnW = 140;
        const btnH = 44;
        const bx = px + (panelW - btnW) / 2;
        const by = py + panelH - btnH - 20;
        ctx.fillStyle = '#086fb6';
        drawRoundedRectPath(ctx, bx, by, btnW, btnH, 8);
        ctx.fill();
        ctx.fillStyle = 'white';
        ctx.font = 'bold 18px Rubik';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('عودة', bx + btnW / 2, by + btnH / 2);

        // store button rect in logical canvas coords for click handler
        gameState.race.resultsButtonRect = { x: bx, y: by, w: btnW, h: btnH };
    }

    updateRaceHud(session, localCar);

    // Draw teleport overlay on top (still inside DPR scale)
    drawTeleportOverlay(W, H);

    ctx.restore();  // undo DPR scale
}

function drawRaceCar(car, index, isLocal) {
    const ctx = gameState.ctx;
    if (!car) return;
    const palette = ['#086fb6', '#f04e3a', '#f4c82b', '#3bb9ab', '#ffffff', '#262626'];
    const color = palette[index % palette.length];

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.translate(car.x, car.y);
    ctx.rotate(car.angle);
    // Scale the car drawing down for race mode
    ctx.scale(RACE_CAR_SCALE, RACE_CAR_SCALE);
    ctx.shadowBlur = isLocal ? 8 : 0;
    ctx.shadowColor = isLocal ? 'rgba(8, 111, 182, 0.65)' : 'transparent';
    ctx.fillStyle = color;
    drawPixelCarBody(ctx, color);
    ctx.shadowBlur = 0;
    ctx.restore();
    // Labels are drawn separately in screen space — see renderRace() second pass
}

// Convert a world position to logical screen coordinates given the race camera transform
function raceWorldToScreen(worldX, worldY, W, H) {
    const cam = gameState.race.camera;
    const zoom = gameState.zoom;
    const camAngle = isMobile() ? (cam.angle || 0) : 0;
    const wx = (worldX + cam.x) * zoom;
    const wy = (worldY + cam.y) * zoom;
    const ca = Math.cos(camAngle);
    const sa = Math.sin(camAngle);
    return {
        x: W / 2 + ca * wx - sa * wy,
        y: H / 2 + sa * wx + ca * wy
    };
}

// Draw avatar badge + name in screen space (no world rotation involved)
function drawRaceCarLabelScreen(userId, participant, screenX, screenY, isLocal) {
    const ctx = gameState.ctx;
    const img = gameState.avatarCache[userId];
    if (!img && participant && participant.avatar) {
        const avatar = new Image();
        avatar.crossOrigin = 'anonymous';
        avatar.src = participant.avatar;
        avatar.onload  = () => { gameState.avatarCache[userId] = avatar; };
        avatar.onerror = () => { gameState.avatarCache[userId] = 'failed'; };
    }

    const bx = screenX;
    const by = screenY - 44;

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    // Badge border
    ctx.fillStyle = isLocal ? '#f4c82b' : '#ffffff';
    ctx.fillRect(bx - 18, by - 18, 36, 36);
    ctx.fillStyle = '#111111';
    ctx.fillRect(bx - 14, by - 14, 28, 28);
    // Avatar or fallback
    if (img && img !== 'failed') {
        ctx.drawImage(img, bx - 12, by - 12, 24, 24);
    } else {
        ctx.fillStyle = '#086fb6';
        ctx.fillRect(bx - 12, by - 12, 24, 24);
        ctx.fillStyle = 'white';
        ctx.font = 'bold 14px Rubik';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText((participant?.username || '?').charAt(0).toUpperCase(), bx, by + 1);
    }
    // Username text
    ctx.fillStyle = 'white';
    ctx.font = 'bold 13px Rubik';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.shadowBlur = 4;
    ctx.shadowColor = 'black';
    ctx.fillText(participant?.username || 'لاعب', screenX, screenY - 26);
    ctx.shadowBlur = 0;
    ctx.restore();
}

function drawPixelCarBody(ctx, color) {
    ctx.fillStyle = '#111111';
    ctx.fillRect(-28, -16, 56, 32);
    ctx.fillStyle = color;
    ctx.fillRect(-24, -14, 44, 28);
    ctx.fillRect(20, -8, 10, 16);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.fillRect(-4, -10, 16, 20);
    ctx.fillStyle = '#26313a';
    ctx.fillRect(-18, -18, 12, 6);
    ctx.fillRect(-18, 12, 12, 6);
    ctx.fillRect(14, -18, 12, 6);
    ctx.fillRect(14, 12, 12, 6);
    ctx.fillStyle = '#f8f6d8';
    ctx.fillRect(27, -8, 5, 5);
    ctx.fillRect(27, 3, 5, 5);
}


function drawRoundedRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
}

function updateRaceHud(session, car) {
    const hud = document.getElementById('race-hud');
    const lap = document.getElementById('race-lap');
    const time = document.getElementById('race-time');
    if (!hud || !lap || !time) return;
    hud.classList.remove('hidden');
    lap.textContent = `لفة ${Math.min(RACE_LAPS, car.lap || 1)} من ${RACE_LAPS}`;
    const elapsed = Math.max(0, serverNow() - (session.startTime || serverNow()));
    time.textContent = car.finished && gameState.race.session?.results?.[gameState.userId]
        ? formatRaceTime(gameState.race.session.results[gameState.userId].finishTime)
        : formatRaceTime(elapsed);
}

function drawDustParticles() {
    const ctx = gameState.ctx;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    gameState.dustParticles.forEach(p => {
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
    });
    ctx.globalAlpha = 1.0;
}

function drawKidnapLine() {
    const ctx = gameState.ctx;
    const player = gameState.players[gameState.userId];
    const laptop = gameState.anim.laptop;
    const p = gameState.anim.progress;

    ctx.strokeStyle = 'white';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(laptop.x, laptop.y);

    const { x: playerX, y: playerY } = getPlayerRenderPos(player);
    let targetX, targetY;
    if (gameState.anim.phase === 'reach') {
        targetX = laptop.x + (playerX - laptop.x) * p;
        targetY = laptop.y + (playerY - laptop.y) * p;
    } else {
        targetX = playerX;
        targetY = playerY;
    }

    ctx.lineTo(targetX, targetY);
    ctx.stroke();

    ctx.fillStyle = 'white';
    ctx.fillRect(targetX - 4, targetY - 4, 8, 8);
}

function drawFocusMask(W, H) {
    const ctx = gameState.ctx;
    const canvas = gameState.canvas;
    const dpr = gameState.dpr || 1;
    if (!gameState.maskCanvas) {
        gameState.maskCanvas = document.createElement('canvas');
        gameState.maskCtx = gameState.maskCanvas.getContext('2d');
    }
    const mCanvas = gameState.maskCanvas;
    const mCtx = gameState.maskCtx;
    // mCanvas is always physical resolution to draw sharp masks
    if (mCanvas.width !== canvas.width || mCanvas.height !== canvas.height) {
        mCanvas.width  = canvas.width;
        mCanvas.height = canvas.height;
    }
    mCtx.clearRect(0, 0, mCanvas.width, mCanvas.height);
    mCtx.fillStyle = `rgba(0, 0, 0, ${gameState.focusAlpha})`;
    mCtx.fillRect(0, 0, mCanvas.width, mCanvas.height);

    const player = gameState.players[gameState.userId];

    // Quick fade-out/fade-in of the laptop cutout when the target laptop changes,
    // so the bright circle doesn't snap from one laptop to the next.
    const mls = gameState.maskLaptopState;
    const tgt = gameState.isLockedIn ? null : gameState.activeLaptop;
    const tgtId = tgt ? tgt.id : null;
    const mLerp = 1 - Math.pow(1 - 0.3, gameState.dtFactor);
    if (tgtId !== mls.id) {
        mls.alpha += (0 - mls.alpha) * mLerp;
        if (mls.alpha < 0.06 || mls.id === null) {
            mls.id = tgtId;
            if (tgt) { mls.x = tgt.x; mls.y = tgt.y; }
            mls.alpha = 0;
        }
    } else if (mls.id !== null) {
        if (tgt) { mls.x = tgt.x; mls.y = tgt.y; }
        mls.alpha += (1 - mls.alpha) * mLerp;
    }

    if (player) {
        mCtx.globalCompositeOperation = 'destination-out';
        const centerX = mCanvas.width  / 2;
        const centerY = mCanvas.height / 2;
        const zoom = gameState.zoom;
        const { x: playerX, y: playerY } = getPlayerRenderPos(player);
        const pScreenX = centerX + (playerX + gameState.camera.x) * zoom * dpr;
        const pScreenY = centerY + (playerY + gameState.camera.y) * zoom * dpr;

        const pRadius = (gameState.isLockedIn ? 85 : 75) * zoom * dpr;
        if (gameState._potato) {
            // Potato: solid circle (sharp edge) instead of a soft radial fade
            mCtx.fillStyle = 'rgba(255, 255, 255, 1)';
        } else {
            const pGrad = mCtx.createRadialGradient(pScreenX, pScreenY, pRadius * 0.4, pScreenX, pScreenY, pRadius);
            pGrad.addColorStop(0, 'rgba(255, 255, 255, 1)');
            pGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
            mCtx.fillStyle = pGrad;
        }
        mCtx.beginPath();
        mCtx.arc(pScreenX, pScreenY, pRadius, 0, Math.PI * 2);
        mCtx.fill();

        if (mls.id !== null && mls.alpha > 0.02 && !gameState.isLockedIn) {
            const la = mls.alpha;
            const lScreenX = centerX + (mls.x + gameState.camera.x) * zoom * dpr;
            const lScreenY = centerY + (mls.y + gameState.camera.y) * zoom * dpr;
            const lRadius = 100 * zoom * dpr;
            if (gameState._potato) {
                mCtx.fillStyle = `rgba(255, 255, 255, ${la})`;
            } else {
                const lGrad = mCtx.createRadialGradient(lScreenX, lScreenY, lRadius * 0.4, lScreenX, lScreenY, lRadius);
                lGrad.addColorStop(0, `rgba(255, 255, 255, ${la})`);
                lGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
                mCtx.fillStyle = lGrad;
            }
            mCtx.beginPath();
            mCtx.arc(lScreenX, lScreenY, lRadius, 0, Math.PI * 2);
            mCtx.fill();
        }
        mCtx.globalCompositeOperation = 'source-over';
    }
    // Draw physical-resolution mask at logical size (ctx is DPR-scaled)
    ctx.drawImage(mCanvas, 0, 0, W, H);

    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(gameState.zoom, gameState.zoom);
    ctx.translate(gameState.camera.x, gameState.camera.y);
    drawPlayers(true);
    drawPrompt((gameState.isLockedIn || gameState.anim.active) ? null : gameState.activeLaptop);
    ctx.restore();
}

function promptOwnerName(laptop) {
    const owner = gameState.players[laptop.claimedBy];
    return owner ? owner.username : "شخص آخر";
}

// Animated prompt. Called every frame with the current activeLaptop (or null).
// When the target laptop/text changes it fades the old prompt out, then pops the
// new one in — so walking past a row reads as a smooth hand-off between laptops.
function drawPrompt(laptop) {
    const ctx = gameState.ctx;
    const ps = gameState.promptState;

    // Work out the prompt the given laptop wants to show (null = nothing).
    let text = null, weak = false;
    if (laptop) {
        if (gameState.pomodoro.active || gameState.freeMode.active) {
            if (laptop.claimedBy && laptop.claimedBy !== gameState.userId) {
                text = `هذا الجهاز تابع لـ ${promptOwnerName(laptop)}`; weak = true;
            }
        } else if (laptop.claimedBy) {
            text = `هذا الجهاز تابع لـ ${promptOwnerName(laptop)}`; weak = true;
        } else {
            text = 'انقر للبدء';
        }
    }

    const key = (laptop && text) ? `${laptop.id}|${text}` : null;
    const lerp = 1 - Math.pow(1 - 0.22, gameState.dtFactor);

    if (key !== ps.shownKey) {
        // Fade the current prompt out; once it's faint enough, adopt the new one.
        ps.alpha += (0 - ps.alpha) * lerp;
        if (ps.alpha < 0.06 || ps.shownKey === null) {
            ps.shownKey = key;
            ps.shownText = text;
            ps.shownWeak = weak;
            if (laptop) { ps.shownX = laptop.x; ps.shownY = laptop.y; }
            ps.alpha = 0;
            ps.pop = 0;
        }
    } else if (ps.shownKey) {
        if (laptop) { ps.shownX = laptop.x; ps.shownY = laptop.y; }
        ps.alpha += (1 - ps.alpha) * lerp;
        ps.pop  += (1 - ps.pop)  * lerp;
    }

    if (!ps.shownKey || ps.alpha < 0.02) return;

    const a = ps.alpha;
    const bob = Math.sin(Date.now() * 0.004) * 2.5;        // gentle float
    const pop = 0.82 + 0.18 * easeOutBack(Math.min(1, ps.pop)); // playful pop-in
    const yOffset = -45 - (1 - a) * 10 + bob;              // rises as it appears

    ctx.save();
    ctx.translate(ps.shownX, ps.shownY + yOffset);
    ctx.scale(pop, pop);
    ctx.textAlign = 'center';
    ctx.shadowBlur = 4;
    ctx.shadowColor = `rgba(0, 0, 0, ${0.65 * a})`;
    ctx.fillStyle = `rgba(255, 255, 255, ${(ps.shownWeak ? 0.8 : 1) * a})`;
    ctx.font = ps.shownWeak ? 'bold 14px Rubik' : 'bold 16px Rubik';
    ctx.fillText(ps.shownText, 0, 0);
    ctx.shadowBlur = 0;
    ctx.restore();
}

function enforceAudioFailsafe() {
    // Azkar shows the focus panel as a live mixer — don't fade master down then.
    if (gameState.isLockedIn || gameState.azkar.active) return;
    const yt = gameState.focusYTPlayer;
    if (yt && yt.player && yt.ready && yt.videoId && !yt._fading) {
        try {
            const state = yt.player.getPlayerState();
            if (state === 1 || state === 3) {
                yt.fadeOutAndPause(800);
            }
        } catch(e) {}
    }
    const ae = gameState.focusAudioEngine;
    if (ae && ae.masterGain) {
        try {
            if (ae.masterGain.gain.value > 0.01) {
                ae.fadeToMaster(0, 0.5);
            }
        } catch(e) {}
    }
}

function updatePomodoro() {
    enforceAudioFailsafe();
    if (!gameState.pomodoro.active) return;

    // Azkar overlay: in solo pomo freeze the timer (shared pomo blocks azkar entirely)
    if (gameState.azkar.active && gameState.sharedPomo.phase !== 'active') {
        const az = gameState.azkar;
        gameState.pomodoro.endTime = Date.now() + az.pausedPomoRemaining;
        const pr = az.pausedPomoRemaining;
        const frozenStr = `${Math.floor(pr / 60000).toString().padStart(2, '0')}:${Math.floor((pr % 60000) / 1000).toString().padStart(2, '0')}`;
        const lg = document.getElementById('large-timer-text');
        const sm = document.getElementById('small-timer-text');
        if (gameState.pomodoro.phase === 'work' && lg) lg.textContent = frozenStr;
        if (gameState.pomodoro.phase === 'break' && sm) sm.textContent = frozenStr;
        return;
    }

    // Prayer overlay: in solo pomo freeze the timer; in shared pomo keep running (timer is shared)
    if (gameState.prayer.isOverlayActive) {
        updatePrayerOverlayTimer();
        if (gameState.sharedPomo.phase !== 'active') {
            gameState.pomodoro.endTime = Date.now() + gameState.prayer.pausedRemaining;
            const pr = gameState.prayer.pausedRemaining;
            const frozenStr = `${Math.floor(pr / 60000).toString().padStart(2, '0')}:${Math.floor((pr % 60000) / 1000).toString().padStart(2, '0')}`;
            const lg = document.getElementById('large-timer-text');
            const sm = document.getElementById('small-timer-text');
            if (gameState.pomodoro.phase === 'work' && lg) lg.textContent = frozenStr;
            if (gameState.pomodoro.phase === 'break' && sm) sm.textContent = frozenStr;
            return;
        }
        // Shared pomo: fall through so the timer display and transitions keep updating normally
    }

    // Check if prayer time arrived (skip if overlay already up)
    if (!gameState.prayer.isOverlayActive) checkPrayerTrigger();

    const now = Date.now();
    const remaining = Math.max(0, gameState.pomodoro.endTime - now);

    // Safety net: if transitioning flag is stuck (timer expired but transition never completed),
    // force-reset after 2 s so the transition can re-fire.
    if (gameState.pomodoro.transitioning && gameState.pomodoro.endTime > 0 && now >= gameState.pomodoro.endTime) {
        if (!gameState.pomodoro._transStuckAt) {
            gameState.pomodoro._transStuckAt = now;
        } else if (now - gameState.pomodoro._transStuckAt > 2000) {
            console.warn('[pomo] transitioning stuck >2s — force-resetting', {
                phase: gameState.pomodoro.phase,
                isLockedIn: gameState.isLockedIn,
                breakDuration: gameState.pomodoro.breakDuration,
                sessionsLeft: gameState.pomodoro.sessionsLeft,
            });
            gameState.pomodoro.transitioning = false;
            gameState.isLockedIn = false;
            gameState.pomodoro._transStuckAt = null;
        }
    } else {
        gameState.pomodoro._transStuckAt = null;
    }

    const largeTimer = document.getElementById('pomodoro-large-timer');
    const smallTimer = document.getElementById('pomodoro-small-timer');

    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    const timeStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

    if (gameState.pomodoro.phase === 'work') {
        largeTimer.classList.remove('hidden');
        smallTimer.classList.add('hidden');
        document.getElementById('large-timer-text').textContent = timeStr;
        document.getElementById('large-session-text').textContent = `جلسة ${gameState.pomodoro.totalSessions - gameState.pomodoro.sessionsLeft + 1} من ${gameState.pomodoro.totalSessions}`;

        if (remaining === 0 && !gameState.pomodoro.transitioning) {
            console.log('[pomo] work→break: starting transition', {
                sessionsLeft: gameState.pomodoro.sessionsLeft,
                breakDuration: gameState.pomodoro.breakDuration,
                isLockedIn: gameState.isLockedIn,
                isMobile: isMobile(),
            });
            gameState.pomodoro.transitioning = true;
            largeTimer.classList.add('hidden');
            gameState.isLockedIn = false;

            // FADE OUT FOCUS SOUNDS
            try {
                if (gameState.focusAudioEngine) {
                    gameState.focusAudioEngine.fadeToMaster(0, 1.5);
                    if (gameState.focusYTPlayer) gameState.focusYTPlayer.fadeOutAndPause(1500);
                }
            } catch(e) { console.error('[pomo] audio fade error:', e); }
            const panel = document.getElementById('focus-sounds-panel');
            if (panel) panel.classList.remove('active');
            const taskPanel = document.getElementById('current-task-panel');
            if (taskPanel) taskPanel.classList.remove('active');
            const taskInput = document.getElementById('current-task-input');
            if (taskInput) taskInput.blur();
            setMobileFocusMode(false);

            const shouldEndAfterThisTimer = gameState.pomodoro.sessionsLeft <= 1 ||
                shouldExpirePomodoroAfterCurrentTimer(gameState.pomodoro);

            if (shouldEndAfterThisTimer) {
                // END SESSION
                try {
                    const completedTaskText = getCurrentTaskText();
                    gameState.pomodoro.active = false;
                    cancelSessionDisconnect(true);
                    const updates = {};
                    updates[lobbyPath(`pomodoro/${gameState.pomodoro.laptopId}`)] = null;
                    update(ref(database), updates);
                    gameState.pomodoro.laptopId = null;
                    try { if (Notification.permission === "granted") new Notification("مدونة ستوديو", { body: "لقد أتممت جميع جلسات العمل بنجاح!" }); } catch(e) {}
                    if (gameState.focusAudioEngine) {
                        gameState.focusAudioEngine.stopAll();
                        if (gameState.focusYTPlayer) gameState.focusYTPlayer.pause();
                    }
                    // Clean up shared pomo state so the blue ring, emoji floats, and
                    // invite capability all reset correctly after a natural session end.
                    if (gameState.sharedPomo.phase === 'active') {
                        if (gameState.sharedPomo.isHost && gameState.sharedPomo.sessionId) {
                            update(ref(database), { [spPath(`live/${gameState.sharedPomo.sessionId}`)]: null });
                        }
                        cleanupSpLocal(true);
                    }
                    gameState.pomodoro.transitioning = false;
                    showSuccessModal(gameState.pomodoro.totalSessions, gameState.pomodoro.workDuration, completedTaskText);
                } catch(e) {
                    console.error('[pomo] session-end error:', e);
                    gameState.pomodoro.transitioning = false;
                }
            } else {
                // GO TO BREAK
                try {
                    if (gameState.focusAudioEngine) {
                        gameState.focusAudioEngine.playEffect('timeBreak');
                    } else {
                        playSoundRobust(gameState.sounds.timeBreak);
                    }
                } catch(e) {}
                try { if (Notification.permission === "granted") new Notification("مدونة ستوديو", { body: "انتهت جلسة العمل! وقت الراحة." }); } catch(e) {}
                console.log('[pomo] calling startPomodoroPhase(break)', { breakDuration: gameState.pomodoro.breakDuration });
                startPomodoroPhase('break');
            }
        }
    } else if (gameState.pomodoro.phase === 'break') {
        largeTimer.classList.add('hidden');
        smallTimer.classList.remove('hidden');
        document.getElementById('small-timer-text').textContent = timeStr;

        if (remaining === 0 && !gameState.pomodoro.transitioning) {
            gameState.pomodoro.transitioning = true;
            smallTimer.classList.add('hidden');
            gameState.pomodoro.sessionsLeft--;

            if (gameState.pomodoro.sessionsLeft <= 0 || shouldExpirePomodoroAfterCurrentTimer(gameState.pomodoro)) {
                gameState.pomodoro.active = false;
                cancelSessionDisconnect(true);
                const updates = {};
                updates[lobbyPath(`pomodoro/${gameState.pomodoro.laptopId}`)] = null;
                update(ref(database), updates);
                gameState.pomodoro.laptopId = null;
                try { if (Notification.permission === "granted") new Notification("مدونة ستوديو", { body: "لقد أتممت جميع جلسات العمل بنجاح!" }); } catch(e) {}

                // STOP ALL FOCUS SOUNDS
                if (gameState.focusAudioEngine) {
                    gameState.focusAudioEngine.stopAll();
                    if (gameState.focusYTPlayer) gameState.focusYTPlayer.pause();
                }
                const panel = document.getElementById('focus-sounds-panel');
                if (panel) panel.classList.remove('active');
                const taskPanel = document.getElementById('current-task-panel');
                if (taskPanel) taskPanel.classList.remove('active');
                const taskInput = document.getElementById('current-task-input');
                if (taskInput) taskInput.blur();

                // Clean up shared pomo state (blue ring, emoji floats, invite capability)
                if (gameState.sharedPomo.phase === 'active') {
                    if (gameState.sharedPomo.isHost && gameState.sharedPomo.sessionId) {
                        update(ref(database), { [spPath(`live/${gameState.sharedPomo.sessionId}`)]: null });
                    }
                    cleanupSpLocal(true);
                }
                gameState.pomodoro.transitioning = false;
            } else {
                if (gameState.focusAudioEngine) {
                    gameState.focusAudioEngine.playEffect('timeReturn');
                } else {
                    playSoundRobust(gameState.sounds.timeReturn);
                }
                try { if (Notification.permission === "granted") new Notification("مدونة ستوديو", { body: "انتهى وقت الراحة. هيا للعمل!" }); } catch(e) {}

                // Set state briefly to wait so that kidnap starts next work cycle timer
                gameState.pomodoro.phase = 'wait';

                const updates = {};
                updates[lobbyPath(`pomodoro/${gameState.pomodoro.laptopId}`)] = {
                    claimedBy: gameState.userId,
                    phase: 'wait',
                    endTime: 0,
                    workDuration: gameState.pomodoro.workDuration,
                    breakDuration: gameState.pomodoro.breakDuration,
                    sessionsLeft: gameState.pomodoro.sessionsLeft,
                    totalSessions: gameState.pomodoro.totalSessions,
                    createdAt: gameState.pomodoro.createdAt || Date.now()
                };
                update(ref(database), updates);

                setTimeout(() => {
                    const laptop = gameState.laptops.find(l => l.id === gameState.pomodoro.laptopId);
                    if (laptop) {
                        startKidnapAnimation(laptop);
                    }
                }, 2000);
            }
        }
    }
}

function isLaptopOwnerInGame(laptop) {
    const owner = gameState.players[laptop.claimedBy];
    return !!(owner && owner.activeInGame);
}

// Owner logged out while session waits for them (expired timer or between-phase wait).
function isLaptopSessionAfk(laptop) {
    if (!laptop.claimedBy) return false;
    if (isLaptopOwnerInGame(laptop)) return false;

    const now = Date.now();
    if (laptop.phase === 'wait') return true;
    if ((laptop.phase === 'work' || laptop.phase === 'break') && laptop.endTime && now >= laptop.endTime) {
        return true;
    }
    return false;
}

function getLaptopBadgePosition(laptop) {
    const player = Object.values(gameState.players).find(p => p.userId === laptop.claimedBy);
    if (player) {
        const { x, y } = getPlayerRenderPos(player);
        return { x, y: y - PLAYER_SIZE / 2 - 20 };
    }
    return { x: laptop.x, y: laptop.y - 70 };
}

function drawPomodoroBadgeStack(ctx, renderX, renderY, { taskText, statusText, color, textColor = 'white' }) {
    const timerH = 26;
    const taskH = 24;
    const gap = 4;

    ctx.font = 'bold 12px Rubik';
    const taskWidth = taskText ? ctx.measureText(taskText).width : 0;

    ctx.font = 'bold 14px Rubik';
    const statusWidth = ctx.measureText(statusText).width;

    const totalHeight = taskText ? (taskH + gap + timerH) : timerH;
    const startY = renderY - (totalHeight - timerH);

    const drawRoundedRect = (x, y, w, h, r) => {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.fill();
    };

    ctx.shadowBlur = 10;
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.fillStyle = color;

    if (taskText) {
        const bx = renderX - taskWidth / 2 - 12;
        drawRoundedRect(bx, startY, taskWidth + 24, taskH, 12);

        ctx.shadowBlur = 0;
        ctx.fillStyle = textColor;
        ctx.font = 'bold 12px Rubik';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(taskText, renderX, startY + taskH / 2);

        ctx.shadowBlur = 10;
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.fillStyle = color;
    }

    const statusY = taskText ? startY + taskH + gap : startY;
    const bx = renderX - statusWidth / 2 - 12;
    drawRoundedRect(bx, statusY, statusWidth + 24, timerH, 13);

    ctx.shadowBlur = 0;
    ctx.fillStyle = textColor;
    ctx.font = 'bold 14px Rubik';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(statusText, renderX, statusY + timerH / 2);
    ctx.textBaseline = 'alphabetic';
}

function drawTimers() {
    const ctx = gameState.ctx;
    const now = Date.now();
    const sp  = gameState.sharedPomo;

    gameState.laptops.forEach(laptop => {
        if (!laptop.claimedBy || laptop.claimedBy === gameState.userId) return;
        // Hide badge if local player is IN this coop session
        if (sp.phase === 'active' && sp.sessionId === laptop.claimedBy) return;

        const { x: renderX, y: renderY } = getLaptopBadgePosition(laptop);

        if (isLaptopSessionAfk(laptop)) {
            const player = Object.values(gameState.players).find(p => p.userId === laptop.claimedBy);
            drawPomodoroBadgeStack(ctx, renderX, renderY, {
                taskText: (player?.currentTask) ? `أعمل على ${player.currentTask}` : '',
                statusText: 'AFK', color: COLORS.afk, textColor: COLORS.black
            });
            return;
        }

        if (laptop.phase === 'free-work') {
            const hostPlayer = gameState.players[laptop.claimedBy];
            const taskText = hostPlayer?.currentTask ? `أعمل على ${hostPlayer.currentTask}` : '';
            if (hostPlayer?.freeWorkStartTime > 0) {
                const elapsedMs = (hostPlayer.freeTotalWorkMs || 0) + (now - hostPlayer.freeWorkStartTime);
                const timeStr = `🌿 ${formatTime(elapsedMs / 1000)}`;
                drawPomodoroBadgeStack(ctx, renderX, renderY, { taskText, statusText: timeStr, color: '#3bb9ab' });
            } else if (taskText) {
                drawPomodoroBadgeStack(ctx, renderX, renderY, { taskText, statusText: '🌿', color: '#3bb9ab' });
            }
            return;
        }

        if (laptop.phase !== 'work' && laptop.phase !== 'break') return;

        const remaining = Math.max(0, laptop.endTime - now);
        const timeStr = `${String(Math.floor(remaining / 60000)).padStart(2,'0')}:${String(Math.floor((remaining % 60000) / 1000)).padStart(2,'0')}`;
        const phaseColor = laptop.phase === 'work' ? COLORS.red : '#3bb9ab';

        // Gather coop participants for this laptop
        const coopMembers = Object.values(gameState.players).filter(p => p.coopHostId === laptop.claimedBy);
        // Host might also have coopHostId === their own uid
        const hostPlayer = gameState.players[laptop.claimedBy];
        if (hostPlayer && !coopMembers.find(p => p.userId === laptop.claimedBy)) coopMembers.unshift(hostPlayer);

        if (coopMembers.length > 1) {
            drawCoopBadge(ctx, renderX, renderY, coopMembers, timeStr, phaseColor);
        } else {
            const taskText = (hostPlayer?.currentTask) ? `أعمل على ${hostPlayer.currentTask}` : '';
            drawPomodoroBadgeStack(ctx, renderX, renderY, { taskText, statusText: timeStr, color: phaseColor });
        }
    });
}

function drawCoopBadge(ctx, cx, topY, members, timeStr, timerColor) {
    const rowH  = 26, avR = 9, padX = 10, gapRows = 3;
    const timerH = 28;

    ctx.font = 'bold 11px Rubik';
    // Measure widest task line
    let maxInnerW = ctx.measureText(timeStr).width + 24;
    for (const p of members) {
        const t = p.currentTask ? p.currentTask.slice(0, 20) : '…';
        maxInnerW = Math.max(maxInnerW, avR * 2 + 8 + ctx.measureText(t).width + padX * 2);
    }
    const panelW = Math.max(maxInnerW, 100);
    const totalH = members.length * rowH + (members.length - 1) * gapRows + gapRows + timerH;
    const panelX = cx - panelW / 2;
    const panelY = topY - totalH;

    // Panel background
    ctx.save();
    ctx.shadowBlur = 10; ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.fillStyle = 'rgba(15,15,15,0.88)';
    _rrect(ctx, panelX, panelY, panelW, totalH, 13);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Member rows
    for (let i = 0; i < members.length; i++) {
        const p   = members[i];
        const ry  = panelY + i * (rowH + gapRows) + rowH / 2;

        // Avatar circle
        const avX = panelX + padX + avR;
        ctx.save();
        ctx.beginPath();
        ctx.arc(avX, ry, avR, 0, Math.PI * 2);
        ctx.clip();
        const img = gameState.avatarCache[p.userId];
        if (img && img !== 'failed') {
            ctx.drawImage(img, avX - avR, ry - avR, avR * 2, avR * 2);
        } else {
            ctx.fillStyle = '#444'; ctx.fill();
            ctx.fillStyle = '#fff'; ctx.font = 'bold 9px Rubik';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText((p.username||'?')[0].toUpperCase(), avX, ry);
        }
        ctx.restore();

        // Task text (right-aligned within row, clipped)
        const task = p.currentTask ? `${p.currentTask}` : '…';
        const maxTW = panelW - avR * 2 - padX * 3;
        ctx.save();
        ctx.beginPath();
        ctx.rect(avX + avR + padX, panelY + i * (rowH + gapRows), maxTW, rowH);
        ctx.clip();
        ctx.fillStyle = 'rgba(255,255,255,0.82)';
        ctx.font = 'bold 11px Rubik';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(task, panelX + panelW - padX, ry);
        ctx.restore();

        // Thin separator between rows
        if (i < members.length - 1) {
            ctx.fillStyle = 'rgba(255,255,255,0.06)';
            ctx.fillRect(panelX + padX, panelY + (i + 1) * (rowH + gapRows) - 1, panelW - padX * 2, 1);
        }
    }

    // Timer row
    const timerY = panelY + members.length * rowH + (members.length - 1) * gapRows + gapRows;
    ctx.shadowBlur = 4; ctx.shadowColor = 'rgba(0,0,0,0.4)';
    ctx.fillStyle = timerColor;
    _rrect(ctx, panelX, timerY, panelW, timerH, 10);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'white';
    ctx.font = 'bold 14px Rubik';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(timeStr, cx, timerY + timerH / 2);
    ctx.textBaseline = 'alphabetic';

    ctx.restore();
}

function _rrect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

function drawLockedInOverlay() {
    const ctx = gameState.ctx;
    const player = gameState.players[gameState.userId];
    if (!player) return;
    const { x, y } = getPlayerRenderPos(player);
    ctx.fillStyle = 'rgba(8, 111, 182, 0.3)';
    ctx.beginPath();
    ctx.arc(x, y, PLAYER_SIZE / 2 + 10, 0, Math.PI * 2);
    ctx.fill();
}

function drawWindParticles(W, H) {
    const ctx = gameState.ctx;
    const canvas = gameState.canvas;
    // Logical viewport dimensions (ctx is DPR-scaled when called from render)
    const w = W || canvas.width  / (gameState.dpr || 1);
    const h = H || canvas.height / (gameState.dpr || 1);
    const twinkleClock = Date.now() * 0.002;
    ctx.save();
    gameState.windParticles.forEach(p => {
        const offsetX = gameState.camera.x * (p.parallax - 1.0) * gameState.zoom;
        const offsetY = gameState.camera.y * (p.parallax - 1.0) * gameState.zoom;
        let drawX = (p.x + offsetX) % w;
        let drawY = (p.y + offsetY) % h;
        if (drawX < 0) drawX += w;
        if (drawY < 0) drawY += h;
        // Gentle twinkle so the ambient motes shimmer instead of sitting flat
        const tw = 0.65 + 0.35 * Math.sin(twinkleClock * p.twinkleSpeed + p.twinklePhase);
        ctx.fillStyle = `rgba(255, 255, 255, ${p.opacity * tw})`;
        for (let i = 0; i < p.length; i++) {
            ctx.fillRect(drawX + (i * p.size), drawY, p.size, p.size);
        }
    });
    ctx.restore();
}

// ── Ambient void atmosphere ──────────────────────────────────────────────────
// Deep colour blobs drawn in screen-space into the black void around the world.
// They parallax with the camera so the empty space feels dimensional.
function drawBackgroundAtmosphere(W, H) {
    const ctx  = gameState.ctx;
    const cam  = gameState.camera;
    const zoom = gameState.zoom;
    const px   = 0.14;               // parallax factor (0 = screen-fixed, 1 = world-speed)
    const ox   = -cam.x * zoom * px;
    const oy   = -cam.y * zoom * px;

    ctx.save();

    if (!gameState._potato) {
        // Deep indigo pool — top-left void
        const g1 = ctx.createRadialGradient(
            W * 0.05 + ox,        H * 0.10 + oy,        0,
            W * 0.05 + ox,        H * 0.10 + oy,        W * 0.62
        );
        g1.addColorStop(0, 'rgba(42, 18, 78, 0.58)');
        g1.addColorStop(1, 'rgba(8, 4, 18, 0)');
        ctx.fillStyle = g1;
        ctx.fillRect(0, 0, W, H);

        // Midnight blue — bottom-right void
        const g2 = ctx.createRadialGradient(
            W * 0.94 + ox * 0.75, H * 0.88 + oy * 0.75, 0,
            W * 0.94 + ox * 0.75, H * 0.88 + oy * 0.75, W * 0.54
        );
        g2.addColorStop(0, 'rgba(10, 24, 68, 0.52)');
        g2.addColorStop(1, 'rgba(4, 8, 28, 0)');
        ctx.fillStyle = g2;
        ctx.fillRect(0, 0, W, H);
    } else {
        // Potato: single cheaper blob
        const gm = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(W, H) * 0.7);
        gm.addColorStop(0, 'rgba(30, 14, 58, 0.45)');
        gm.addColorStop(1, 'rgba(6, 3, 14, 0)');
        ctx.fillStyle = gm;
        ctx.fillRect(0, 0, W, H);
    }

    ctx.restore();
}

// ── Warm sun rays ────────────────────────────────────────────────────────────
// A single large radial gradient anchored off the top-right, giving the scene
// a warm golden wash. Mild camera parallax makes it "float" behind the world.
function drawSunRays(W, H) {
    if (gameState._potato) return;   // skip only on potato tier
    const ctx  = gameState.ctx;
    const cam  = gameState.camera;
    const zoom = gameState.zoom;
    const px   = 0.055;              // very gentle — sun is "far away"
    const ox   = -cam.x * zoom * px;
    const oy   = -cam.y * zoom * px;

    // Source: just off the top-right corner
    const cx = W * 0.90 + ox;
    const cy = H * -0.08 + oy;
    const r  = Math.max(W, H) * 1.55;

    ctx.save();
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0,    'rgba(255, 220, 130, 0.16)');
    grad.addColorStop(0.25, 'rgba(255, 195,  85, 0.10)');
    grad.addColorStop(0.55, 'rgba(255, 165,  50, 0.04)');
    grad.addColorStop(1,    'rgba(255, 140,  30, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
}

let _vignetteCache = null; // { w, h, grad } — rebuilt only on resize
function drawVignette(W, H) {
    const ctx = gameState.ctx;
    const canvas = gameState.canvas;
    const w = W || canvas.width  / (gameState.dpr || 1);
    const h = H || canvas.height / (gameState.dpr || 1);
    if (!_vignetteCache || _vignetteCache.w !== w || _vignetteCache.h !== h) {
        const grad = ctx.createRadialGradient(
            w / 2, h / 2, Math.min(w, h) * 0.42,
            w / 2, h / 2, Math.max(w, h) * 0.72
        );
        grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
        grad.addColorStop(1, 'rgba(0, 0, 0, 0.34)');
        _vignetteCache = { w, h, grad };
    }
    ctx.save();
    ctx.fillStyle = _vignetteCache.grad;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
}

function drawFocusFog(W, H) {
    if (gameState.focusFogAlpha <= 0.01) return;
    const ctx = gameState.ctx;
    const canvas = gameState.canvas;
    const w = W || canvas.width  / (gameState.dpr || 1);
    const h = H || canvas.height / (gameState.dpr || 1);

    ctx.save();
    ctx.globalAlpha = gameState.focusFogAlpha * 0.85;

    if (gameState._potato) {
        // Simple static overlay on potato — no gradient allocation every frame
        ctx.fillStyle = 'rgba(10, 15, 30, 0.35)';
        ctx.fillRect(0, 0, w, h);
    } else {
        const t = Date.now() * 0.0004;

        const grad1 = ctx.createRadialGradient(
            w / 2 + Math.sin(t) * (w * 0.15), h / 2 + Math.cos(t * 0.7) * (h * 0.15), Math.min(w, h) * 0.3,
            w / 2, h / 2, Math.max(w, h) * 0.95
        );
        grad1.addColorStop(0, 'rgba(10, 15, 30, 0)');
        grad1.addColorStop(0.6, 'rgba(10, 15, 30, 0.2)');
        grad1.addColorStop(1, 'rgba(13, 27, 42, 0.6)');
        ctx.fillStyle = grad1;
        ctx.fillRect(0, 0, w, h);

        const grad2 = ctx.createRadialGradient(
            w * 0.3 + Math.cos(t * 0.8) * (w * 0.1), h * 0.4 + Math.sin(t * 1.1) * (h * 0.1), Math.min(w, h) * 0.25,
            w * 0.3, h * 0.4, Math.max(w, h) * 0.75
        );
        grad2.addColorStop(0, 'rgba(16, 185, 129, 0)');
        grad2.addColorStop(0.5, 'rgba(16, 185, 129, 0.04)');
        grad2.addColorStop(1, 'rgba(16, 185, 129, 0.12)');
        ctx.fillStyle = grad2;
        ctx.fillRect(0, 0, w, h);

        const grad3 = ctx.createRadialGradient(
            w * 0.8 + Math.sin(t * 1.3) * (w * 0.08), h * 0.8 + Math.cos(t * 0.9) * (h * 0.08), Math.min(w, h) * 0.25,
            w * 0.8, h * 0.8, Math.max(w, h) * 0.7
        );
        grad3.addColorStop(0, 'rgba(99, 102, 241, 0)');
        grad3.addColorStop(0.5, 'rgba(99, 102, 241, 0.03)');
        grad3.addColorStop(1, 'rgba(99, 102, 241, 0.15)');
        ctx.fillStyle = grad3;
        ctx.fillRect(0, 0, w, h);
    }

    ctx.restore();
}

function drawConnections() {
    const ctx = gameState.ctx;
    const channelGroups = {};
    for (const player of Object.values(gameState.players)) {
        if (!channelGroups[player.channelName]) channelGroups[player.channelName] = [];
        channelGroups[player.channelName].push(player);
    }

    // Animated flowing dashes + gentle breathing glow — makes social links feel alive
    const t = Date.now() * 0.001;
    const flow = -(Date.now() * 0.02) % 14;       // dashes drift along the line
    const pulse = 0.5 + 0.5 * Math.sin(t * 1.6);  // 0..1 breathing
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineDashOffset = flow;
    ctx.setLineDash([4, 10]);
    for (const players of Object.values(channelGroups)) {
        if (players.length > 1) {
            for (let i = 0; i < players.length; i++) {
                for (let j = i + 1; j < players.length; j++) {
                    const p1 = players[i], p2 = players[j];
                    const pos1 = getPlayerRenderPos(p1);
                    const pos2 = getPlayerRenderPos(p2);
                    ctx.beginPath();
                    ctx.moveTo(pos1.x, pos1.y);
                    ctx.lineTo(pos2.x, pos2.y);
                    // Soft teal glow underlay
                    ctx.strokeStyle = `rgba(59, 185, 171, ${0.10 + 0.10 * pulse})`;
                    ctx.lineWidth = 5;
                    ctx.stroke();
                    // Bright flowing dashes on top
                    ctx.strokeStyle = `rgba(220, 245, 240, ${0.22 + 0.16 * pulse})`;
                    ctx.lineWidth = 2;
                    ctx.stroke();
                }
            }
        }
    }
    ctx.setLineDash([]);
    ctx.restore();
}

function blendHexColors(fromHex, toHex, t) {
    const clamp = Math.max(0, Math.min(1, t));
    const parse = (hex) => {
        const value = hex.replace('#', '');
        return [
            parseInt(value.slice(0, 2), 16),
            parseInt(value.slice(2, 4), 16),
            parseInt(value.slice(4, 6), 16)
        ];
    };
    const [r1, g1, b1] = parse(fromHex);
    const [r2, g2, b2] = parse(toHex);
    const r = Math.round(r1 + (r2 - r1) * clamp);
    const g = Math.round(g1 + (g2 - g1) * clamp);
    const b = Math.round(b1 + (b2 - b1) * clamp);
    return `rgb(${r}, ${g}, ${b})`;
}

function drawPlayers(onlyLocal = false) {
    const ctx = gameState.ctx;
    const teleportAnim = gameState.race.teleportAnim || gameState.coffee.teleportAnim;

    for (const player of Object.values(gameState.players)) {
        const isCurrentUser = player.userId === gameState.userId;
        if (onlyLocal && !isCurrentUser) continue;

        const { x: screenX, y: renderY } = getPlayerRenderPos(player);
        const screenY = renderY - (player.bobOffset || 0);

        // Teleport animation overrides
        const tpData = teleportAnim && teleportAnim.players.find(tp => tp.userId === player.userId);
        const tpFly = tpData ? easeOutExpo(teleportAnim.flyProgress || 0) : 0;
        const tpFlyOffsetY = tpFly * -110;
        const tpFadeOut = tpData ? Math.min(1, tpFly * 1.4) : 0;

        const isWorking = isCurrentUser ?
            (gameState.isLockedIn && gameState.pomodoro.active && gameState.pomodoro.phase === 'work') :
            player.isWorking;

        const shouldGrayWorld = !isCurrentUser && !!player.isWorking;

        let workBob = 0;
        let workAngle = 0;
        let workScaleX = 1.0;
        let workScaleY = 1.0;
        let coopDX = 0, coopDY = 0;

        // Suppress avatar animation in two cases:
        //  • MY OWN avatar, if I turned off "حركة الجلوس أثناء العمل" — freeze it
        //    completely (bounce AND idle breathing) whenever I'm in any work phase,
        //    pomodoro OR free mode. (isWorking above only tracks pomodoro, which is
        //    why free mode kept breathing before — use localInWorkPhase() instead.)
        //  • OTHER players' working bounce, while *I'm* in a work phase (I only see
        //    their bounce when idle / on break / not in a session).
        const suppressWorkAnim = !tpData && (
            (isCurrentUser && gameState._disableIdleAnim && localInWorkPhase()) ||
            (!isCurrentUser && player.isWorking && localInWorkPhase())
        );

        if (isWorking && !tpData && !suppressWorkAnim) {
            const workT = Date.now() * 0.005;
            workBob = Math.sin(workT) * 3;
            workAngle = Math.sin(workT * 0.5) * 0.08;
            workScaleY = 1.0 + Math.sin(workT) * 0.04;
            workScaleX = 1.0 - Math.sin(workT) * 0.04;
        } else if (!tpData && !player.isMoving && !suppressWorkAnim) {
            // Idle breathing — keeps standing avatars subtly alive.
            // Per-player phase offset so the crowd doesn't breathe in unison.
            const breatheT = Date.now() * 0.0022 + (player.bobTime || 0) * 0 + (player._breathePhase ?? (player._breathePhase = Math.random() * Math.PI * 2));
            const breathe = Math.sin(breatheT);
            workScaleY = 1.0 + breathe * 0.018;
            workScaleX = 1.0 - breathe * 0.012;
        }

        // Coop animation: read lerped blend values computed in updateCoopAnimation
        const sp = gameState.sharedPomo;
        {
            let coopMem = null;
            if (sp.phase === 'active' && sp.activeGroupMembers.length > 1
                && sp.activeGroupMembers.includes(player.userId)
                && gameState.isLockedIn && !tpData) {
                coopMem = sp.coopAnim.members[player.userId];
            } else if (player.coopHostId && !tpData) {
                // External observer: use external anim state
                coopMem = sp.extCoopAnims[player.userId];
            }
            if (coopMem) {
                coopDX     = coopMem.dxBlend;
                coopDY     = coopMem.dyBlend;
                workScaleX = coopMem.scaleXBlend;
                workScaleY = coopMem.scaleYBlend;
                workAngle  = coopMem.angleBlend;
            }
        }

        // JUICE: entrance drop (local player) + scale-in pop (remote players).
        let _juiceScale = 1, _juiceDropY = 0, _juiceSquashX = 1, _juiceSquashY = 1;
        if (JUICE_ENTRANCE) {
            if (isCurrentUser && _entrance.active) {
                if (!_entrance.charVisible) continue;   // pre-drop: hidden until it appears
                _juiceScale  = _entrance.dropScale;
                _juiceDropY  = _entrance.dropY;
                _juiceSquashX = _entrance.squashX;
                _juiceSquashY = _entrance.squashY;
            } else if (!isCurrentUser && player._exitT != null) {
                // Scale DOWN on disconnect — mirror of the scale-up on connect.
                const xt = Math.min(1, Math.max(0, (performance.now() - player._exitT) / JUICE_EXIT_MS));
                const c1 = 1.70158, c3 = c1 + 1;
                _juiceScale = Math.max(0, 1 - (c3 * xt * xt * xt - c1 * xt * xt));   // 1 − easeInBack
            } else if (!isCurrentUser && player._entryT != null) {
                const et = (performance.now() - player._entryT) / 460;
                if (et >= 1) { player._entryT = null; }
                else { _juiceScale = Math.max(0, easeOutBack(Math.max(0.0001, et))); }
            }
        }

        const colorAlpha = isCurrentUser ? 1 : (player.avatarColorAlpha ?? 0);
        const grayMix = 1 - colorAlpha;
        const ringColor = isCurrentUser ? COLORS.blue : '#ffffff';
        const mutedRing = '#8a8a8a';

        // Soft contact shadow on the ground — shrinks/fades as the avatar bobs upward,
        // so walking avatars feel like they lift off the floor. Cheap (one ellipse).
        if (!tpData || tpFadeOut < 0.9) {
            // JUICE: the z-drop / scale-in shrinks the contact shadow (it stays on the floor).
            const lift = (player.bobOffset || 0) + Math.abs(workBob) + tpFly * 110
                + Math.abs(_juiceScale - 1) * 40;
            const liftN = Math.min(1, lift / 24);
            const shW = (PLAYER_SIZE * 0.46) * (1 - liftN * 0.32);
            const shH = shW * 0.32;
            const shGroundY = renderY + PLAYER_SIZE / 2 - 2;
            ctx.save();
            ctx.globalAlpha = (0.28 - liftN * 0.14) * (tpData ? (1 - tpFadeOut) : 1);
            ctx.fillStyle = '#000';
            ctx.beginPath();
            ctx.ellipse(screenX + coopDX, shGroundY, shW, shH, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }

        ctx.save();
        if (tpFadeOut > 0.01) ctx.globalAlpha = 1 - tpFadeOut;
        ctx.translate(screenX + coopDX, screenY + workBob + coopDY + tpFlyOffsetY + _juiceDropY);
        ctx.rotate(workAngle);
        ctx.scale(workScaleX * _juiceScale * _juiceSquashX, workScaleY * _juiceScale * _juiceSquashY);

        if (grayMix > 0.01) {
            ctx.filter = `saturate(${colorAlpha}) brightness(${0.72 + 0.28 * colorAlpha})`;
            ctx.globalAlpha = 0.55 + 0.45 * colorAlpha;
        }

        // Local-player ambient glow — a gentle breathing halo so "you" stand out.
        // Desktop only (radial gradient per avatar is the costly bit); skipped on mobile.
        if (isCurrentUser && !isMobile() && tpFadeOut < 0.5) {
            const gt = Date.now() * 0.0018;
            const glowPulse = 0.5 + 0.5 * Math.sin(gt);
            const gr = PLAYER_SIZE / 2 + 10 + glowPulse * 6;
            const glow = ctx.createRadialGradient(0, 0, PLAYER_SIZE / 2 - 4, 0, 0, gr);
            glow.addColorStop(0, 'rgba(49, 178, 255, 0)');
            glow.addColorStop(0.55, `rgba(49, 178, 255, ${0.10 + 0.06 * glowPulse})`);
            glow.addColorStop(1, 'rgba(49, 178, 255, 0)');
            ctx.fillStyle = glow;
            ctx.beginPath();
            ctx.arc(0, 0, gr, 0, Math.PI * 2);
            ctx.fill();
        }

        // Shared pomodoro group ring — drawn behind the avatar ring
        if (gameState.sharedPomo.activeGroupMembers.includes(player.userId)) {
            const t = Date.now() * 0.0025;
            const pulse = 0.5 + 0.5 * Math.sin(t);
            const gr = (PLAYER_SIZE / 2) + 12 + Math.sin(t) * 2;
            ctx.beginPath();
            ctx.arc(0, 0, gr + 5, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(59,185,171,${0.13 * pulse})`;
            ctx.lineWidth = 8;
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(0, 0, gr, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(59,185,171,${0.6 * pulse})`;
            ctx.lineWidth = 2;
            ctx.stroke();
        }

        ctx.shadowBlur = 10;
        ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
        ctx.shadowOffsetY = 4 + (player.bobOffset || 0);
        ctx.beginPath();
        ctx.arc(0, 0, (PLAYER_SIZE / 2) + 4, 0, Math.PI * 2);
        ctx.fillStyle = grayMix > 0.01 ? blendHexColors(ringColor, mutedRing, grayMix) : ringColor;
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;

        ctx.save();
        ctx.beginPath();
        ctx.arc(0, 0, PLAYER_SIZE / 2, 0, Math.PI * 2);
        ctx.clip();

        const img = gameState.avatarCache[player.userId];
        if (img && img !== 'failed') {
            if (shouldGrayWorld) ctx.filter = 'grayscale(60%)';
            ctx.drawImage(img, -PLAYER_SIZE / 2, -PLAYER_SIZE / 2, PLAYER_SIZE, PLAYER_SIZE);
            ctx.filter = 'none';
        } else {
            const placeholderColor = isCurrentUser ? COLORS.blue : '#ccc';
            let fillColor = placeholderColor;
            if (!isCurrentUser && player.isWorking) fillColor = '#9a9a9a';
            ctx.fillStyle = grayMix > 0.01
                ? blendHexColors(fillColor, '#9a9a9a', grayMix)
                : fillColor;
            ctx.fill();
            ctx.fillStyle = `rgba(255, 255, 255, ${0.55 + 0.45 * colorAlpha})`;
            ctx.font = 'bold 24px Rubik';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(player.username.charAt(0).toUpperCase(), 0, 0);
        }
        ctx.restore();

        ctx.filter = 'none';
        ctx.globalAlpha = 1;
        ctx.restore(); // restores translate, rotate, scale

        if (player.nameAlpha > 0.01 && !tpData && !getHideNames()) {
            ctx.fillStyle = `rgba(255, 255, 255, ${player.nameAlpha})`;
            ctx.font = '500 14px Rubik';
            ctx.textAlign = 'center';
            ctx.fillText(player.username, screenX, renderY + PLAYER_SIZE / 2 + 25);

            // Free mode: show elapsed time + task in teal below the name
            if (!isCurrentUser && player.inFreeMode && player.freeWorkStartTime > 0) {
                const freeElapsedMs = (player.freeTotalWorkMs || 0) + (Date.now() - player.freeWorkStartTime);
                const freeTimeStr = formatTime(freeElapsedMs / 1000);
                const taskStr = player.currentTask ? ` · ${player.currentTask.slice(0, 14)}` : '';
                ctx.fillStyle = `rgba(59, 185, 171, ${player.nameAlpha * 0.9})`;
                ctx.font = '500 12px Rubik';
                ctx.fillText(`🌿 ${freeTimeStr}${taskStr}`, screenX, renderY + PLAYER_SIZE / 2 + 41);
            }
        }
    }
}

if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }

// ─────────────────────────────────────────────────────────────────────────────
// SHARED POMODORO
// ─────────────────────────────────────────────────────────────────────────────

const SP_PROXIMITY_SQ = 200 * 200; // squared distance threshold (world units)
const SP_MAX_GUESTS   = 2;
const SP_INVITE_TTL   = 10000;     // ms

// ═══════════════════════════════════════════════════════════════════
//  PICTURE-IN-PICTURE  (الوضع المصغر)
//  Always-on-top floating window that re-renders a player-centred view of
//  the world. Uses the Document Picture-in-Picture API when available (real
//  OS-level, resizable, draggable across displays, stays on top), and falls
//  back to an in-page draggable/resizable panel on unsupported browsers.
//
//  Rendering reuses 100% of the existing draw functions via a context swap:
//  we temporarily point gameState.ctx/canvas/zoom/camera/dpr at the PiP
//  surface, run the world-draw sequence, then restore. No code duplication.
// ═══════════════════════════════════════════════════════════════════

const PIP_WINDOW_CSS = `
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 100%; height: 100%; overflow: hidden; background: #07070a;
  font-family: 'Rubik', -apple-system, system-ui, sans-serif; cursor: default; }
#pip-root { position: fixed; inset: 0; }
#pip-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
#pip-top { position: absolute; top: 0; left: 0; right: 0; padding: 12px 16px 26px;
  display: flex; flex-direction: column; gap: 1px; pointer-events: none;
  background: linear-gradient(to bottom, rgba(0,0,0,0.55), rgba(0,0,0,0)); }
#pip-timer { font-size: clamp(28px, 12vw, 60px); font-weight: 700; color: #fff;
  line-height: 1; letter-spacing: 0.5px; text-shadow: 0 2px 16px rgba(0,0,0,0.7);
  font-variant-numeric: tabular-nums; }
#pip-task { font-size: clamp(11px, 3.6vw, 15px); font-weight: 500;
  color: rgba(255,255,255,0.55); direction: rtl; max-width: 100%;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  text-shadow: 0 1px 6px rgba(0,0,0,0.6); }
/* Next prayer + live countdown — sits under the task, subtle so it never competes with the timer */
#pip-prayer { display: none; align-items: center; gap: 6px; margin-top: 5px;
  font-size: clamp(10px, 3.2vw, 13px); font-weight: 600; direction: rtl;
  color: rgba(59,185,171,0.92); text-shadow: 0 1px 6px rgba(0,0,0,0.6); }
#pip-prayer.show { display: flex; }
#pip-prayer .pip-pr-dot { width: 5px; height: 5px; border-radius: 50%; background: rgba(59,185,171,0.7); flex: 0 0 auto; }
#pip-prayer .pip-pr-cd { color: rgba(255,255,255,0.6); font-variant-numeric: tabular-nums; }
#pip-close { position: absolute; bottom: 14px; left: 14px; z-index: 5; display: flex;
  align-items: center; gap: 7px; padding: 9px 15px; border-radius: 50px;
  cursor: pointer; background: rgba(18,18,18,0.68);
  -webkit-backdrop-filter: blur(20px) saturate(1.6); backdrop-filter: blur(20px) saturate(1.6);
  border: 1px solid rgba(255,255,255,0.09); color: rgba(255,255,255,0.85);
  font-family: inherit; font-size: 13px; font-weight: 600;
  box-shadow: 0 4px 24px rgba(0,0,0,0.3); transition: transform .25s cubic-bezier(0.34,1.56,0.64,1), background .2s, color .2s; }
#pip-close:hover { background: rgba(225,53,46,0.55); border-color: rgba(225,53,46,0.4); color: #fff; transform: scale(1.04); }
#pip-close svg { width: 15px; height: 15px; }

/* ── Compact control bar (focus sounds + YouTube) ──
   Stacked: YouTube row on TOP, sounds row on the BOTTOM. Stacking (instead of
   side-by-side) gives the sounds row the full width of the window, so all the
   sound chips stay visible even when the PiP window is made small. */
#pip-controls { position: absolute; bottom: 12px; right: 12px; z-index: 5;
  display: flex; flex-direction: column; align-items: flex-end; gap: 6px; direction: ltr;
  max-width: calc(100% - 130px); }
#pip-sounds { display: flex; align-items: center; gap: 4px; padding: 5px 6px;
  border-radius: 50px; background: rgba(18,18,18,0.62);
  -webkit-backdrop-filter: blur(20px) saturate(1.6); backdrop-filter: blur(20px) saturate(1.6);
  border: 1px solid rgba(255,255,255,0.08); box-shadow: 0 4px 20px rgba(0,0,0,0.3);
  overflow-x: auto; scrollbar-width: none; max-width: 100%; }
#pip-sounds::-webkit-scrollbar { display: none; }
.pip-chip { flex: 0 0 auto; width: 26px; height: 26px; border-radius: 50%;
  border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.05);
  color: rgba(255,255,255,0.55); font-size: 13px; line-height: 1; cursor: pointer;
  display: flex; align-items: center; justify-content: center; padding: 0;
  opacity: 0.38;
  transition: background .18s, color .18s, transform .15s, opacity .18s; }
.pip-chip:hover { background: rgba(255,255,255,0.12); opacity: 0.6; }
.pip-chip:active { transform: scale(0.9); }
.pip-chip.active { background: rgba(59,185,171,0.24); border-color: rgba(59,185,171,0.4); color: rgba(120,230,215,0.95); opacity: 1; }
.pip-chip.pip-chip-more { font-size: 15px; color: rgba(255,255,255,0.6); }
#pip-yt { display: flex; align-items: center; gap: 4px; padding: 5px 6px;
  border-radius: 50px; background: rgba(18,18,18,0.62);
  -webkit-backdrop-filter: blur(20px) saturate(1.6); backdrop-filter: blur(20px) saturate(1.6);
  border: 1px solid rgba(255,255,255,0.08); box-shadow: 0 4px 20px rgba(0,0,0,0.3); flex: 0 0 auto; }
.pip-yt-btn { width: 28px; height: 28px; border-radius: 50%; border: none; padding: 0; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  background: rgba(255,255,255,0.07); color: rgba(255,255,255,0.8); transition: background .18s, transform .15s; }
.pip-yt-btn:hover { background: rgba(255,255,255,0.14); }
.pip-yt-btn:active { transform: scale(0.9); }
.pip-yt-btn svg { width: 14px; height: 14px; }

/* ── Popovers (open above their buttons) ── */
.pip-pop { position: absolute; bottom: 50px; z-index: 6; display: none;
  flex-direction: column; gap: 9px; padding: 12px; border-radius: 16px; direction: rtl;
  width: 210px; max-height: 230px; overflow-y: auto;
  background: rgba(16,16,20,0.95); -webkit-backdrop-filter: blur(24px) saturate(1.6); backdrop-filter: blur(24px) saturate(1.6);
  border: 1px solid rgba(255,255,255,0.1); box-shadow: 0 12px 40px rgba(0,0,0,0.6); }
.pip-pop.show { display: flex; }
#pip-snd-pop { right: 12px; }
#pip-yt-pop { right: 12px; }
.pip-pop-title { font-size: 12px; font-weight: 700; color: rgba(255,255,255,0.7); margin-bottom: 2px; }
.pip-slider-row { display: flex; flex-direction: column; gap: 4px; }
.pip-slider-row .lbl { display: flex; justify-content: space-between; align-items: center;
  font-size: 11px; font-weight: 600; }
.pip-slider-row { opacity: 0.38; transition: opacity .18s; }
.pip-slider-row.snd-on { opacity: 1; }
.pip-slider-row .lbl .nm { color: rgba(255,255,255,0.6); }
.pip-slider-row .lbl .nm.on { color: rgba(120,230,215,0.95); }
.pip-pop input[type=range] { width: 100%; height: 4px; cursor: pointer; accent-color: rgba(59,185,171,0.9); }
.pip-pop input[type=text] { width: 100%; padding: 8px 10px; border-radius: 9px; direction: ltr;
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: #fff;
  font-family: inherit; font-size: 12px; }
.pip-pop input[type=text]::placeholder { color: rgba(255,255,255,0.3); }
.pip-pop .pip-pop-btn { padding: 8px 10px; border-radius: 9px; border: none; cursor: pointer;
  background: rgba(59,185,171,0.22); color: rgba(120,230,215,0.95); font-family: inherit; font-size: 12px; font-weight: 700; }
.pip-pop .pip-pop-btn:hover { background: rgba(59,185,171,0.32); }

/* Prayer screen drawn on canvas; hide DOM chrome while it's showing (window mode) */
#pip-root.praying #pip-top,
#pip-root.praying #pip-controls { opacity: 0; pointer-events: none; }
`;

// Focus-sound chips for the PiP control bar. Emoji glyphs keep it tiny + language-neutral.
const PIP_SOUND_CHIPS = [
  ['rain', '🌧', 'مطر'], ['rain_muffled', '🌫', 'مطر خافت'], ['fire', '🔥', 'موقد'],
  ['forest', '🌲', 'غابة'], ['brown', '🟤', 'ضوضاء بنية'], ['wind', '💨', 'رياح'],
  ['plane', '✈️', 'طائرة'], ['ocean', '🌊', 'بحر'],
];

function _pipBuildControlsHTML() {
    const chips = PIP_SOUND_CHIPS.map(([key, emoji, label]) =>
        `<button class="pip-chip" data-sound="${key}" title="${label}" aria-label="${label}">${emoji}</button>`
    ).join('');
    const sliders = PIP_SOUND_CHIPS.map(([key, , label]) =>
        `<div class="pip-slider-row" data-snd-row="${key}"><div class="lbl"><span class="nm" data-snd-nm="${key}">${label}</span></div>` +
        `<input type="range" min="0" max="1" step="0.05" data-snd-vol="${key}"></div>`
    ).join('');
    return `
  <div id="pip-controls">
    <div id="pip-yt">
      <button id="pip-yt-toggle" class="pip-yt-btn" type="button" aria-label="تشغيل/إيقاف يوتيوب">
        <svg id="pip-yt-play" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
        <svg id="pip-yt-pause" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="display:none"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>
      </button>
      <button id="pip-yt-opts" class="pip-yt-btn" type="button" aria-label="خيارات يوتيوب">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>
      </button>
    </div>
    <div id="pip-sounds">
      ${chips}
      <button class="pip-chip pip-chip-more" id="pip-snd-more" type="button" aria-label="مستويات الصوت" title="مستويات الصوت">≡</button>
    </div>
  </div>
  <div id="pip-snd-pop" class="pip-pop">
    <div class="pip-pop-title">مستويات أصوات التركيز</div>
    <div class="pip-slider-row snd-on" id="pip-overall-row"><div class="lbl"><span class="nm on">جميع الأصوات</span></div>
      <input type="range" min="0" max="1" step="0.05" id="pip-overall-vol"></div>
    ${sliders}
  </div>
  <div id="pip-yt-pop" class="pip-pop">
    <div class="pip-pop-title">مشغّل يوتيوب</div>
    <input id="pip-yt-url" type="text" placeholder="ألصق رابط يوتيوب…" />
    <button id="pip-yt-load" class="pip-pop-btn" type="button">تشغيل الرابط</button>
    <div class="pip-slider-row"><div class="lbl"><span class="nm">الصوت</span></div>
      <input id="pip-yt-vol" type="range" min="0" max="100" step="1"></div>
  </div>`;
}

const PIP_WINDOW_HTML = `
<div id="pip-root">
  <canvas id="pip-canvas"></canvas>
  <div id="pip-top">
    <div id="pip-timer">00:00</div>
    <div id="pip-task"></div>
    <div id="pip-prayer"><span class="pip-pr-dot"></span><span class="pip-pr-name"></span><span class="pip-pr-cd"></span></div>
  </div>
  <button id="pip-close" type="button" aria-label="إغلاق الوضع المصغر">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    <span>إغلاق</span>
  </button>
  __PIP_CONTROLS__
</div>`;

function pipSupported() {
    return typeof window !== 'undefined' && 'documentPictureInPicture' in window;
}

// PiP may only run during an active WORK phase with no blocking overlay/minigame.
// This single predicate centralises every auto-close trigger.
function isPiPAllowed() {
    const inWork = (gameState.pomodoro.active && gameState.pomodoro.phase === 'work')
        || (gameState.freeMode.active && gameState.freeMode.phase === 'work');
    if (!inWork) return false;
    if (gameState.azkar.active) return false;
    // Prayer no longer closes PiP — it shows the prayer screen on the PiP canvas instead.
    if (gameState.race.active || gameState.coffee.active || gameState.laptopBoss.active) return false;
    if (gameState._dupSessionDetected) return false;
    return true;
}

// Compute the timer string + label for whichever mode is running.
function _pipTimerData() {
    const p = gameState.pomodoro, fm = gameState.freeMode;
    if (p.active && p.phase === 'work') {
        const rem = Math.max(0, p.endTime - Date.now());
        const label = getCurrentTaskText() || `جلسة ${p.totalSessions - p.sessionsLeft + 1} من ${p.totalSessions}`;
        return { text: formatTime(rem / 1000), label };
    }
    if (fm.active && fm.phase === 'work') {
        const elapsed = fm.totalWorkMs + (fm.workStartTime > 0 ? (Date.now() - fm.workStartTime) : 0);
        return { text: formatTime(elapsed / 1000), label: getCurrentTaskText() || 'وضع حر' };
    }
    return { text: '00:00', label: '' };
}

// Lerp the PiP camera so the local player sits dead-centre, plus zoom easing.
function updatePiPCamera() {
    const pip = gameState.pip;
    const player = gameState.players[gameState.userId];
    if (!player) return;
    const { x: px, y: py } = getPlayerRenderPos(player);
    const tx = -px, ty = -py;
    if (!pip._camInit) {
        pip.camera.x = tx; pip.camera.y = ty; pip._camInit = true;
    } else {
        pip.camera.x += (tx - pip.camera.x) * 0.16;
        pip.camera.y += (ty - pip.camera.y) * 0.16;
    }
    pip.zoomLevel += (pip.targetZoomLevel - pip.zoomLevel) * 0.12;
}

// Draw the timer + task label directly onto the canvas (Video-PiP mode only,
// where there is no DOM to overlay). Logical coords (ctx is already dpr-scaled).
function _pipDrawCanvasChrome(ctx, W, H) {
    const t = _pipTimerData();
    ctx.save();
    // Top scrim so white text reads over any scene.
    const g = ctx.createLinearGradient(0, 0, 0, H * 0.30);
    g.addColorStop(0, 'rgba(0,0,0,0.62)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H * 0.30);

    const pad = Math.round(W * 0.05);
    ctx.textBaseline = 'top';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 12;

    // Big timer, top-left.
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    const tSize = Math.round(H * 0.11);
    ctx.font = `700 ${tSize}px Rubik, -apple-system, system-ui, sans-serif`;
    ctx.fillText(t.text, pad, pad);
    ctx.shadowBlur = 0;

    // Task / session label under it (RTL).
    if (t.label) {
        ctx.textAlign = 'right';
        ctx.direction = 'rtl';
        ctx.fillStyle = 'rgba(255,255,255,0.62)';
        ctx.font = `500 ${Math.round(H * 0.033)}px Rubik, -apple-system, system-ui, sans-serif`;
        ctx.fillText(t.label, W - pad, pad + tSize + Math.round(H * 0.012));
    }
    ctx.restore();
}

// Resolve the Arabic name for the prayer currently being shown.
function _pipPrayerArabic() {
    const key = (gameState.prayer.overlayPrayer || '').toLowerCase();
    const hit = (typeof PRAYER_DATA !== 'undefined') && PRAYER_DATA.find(p => p.key.toLowerCase() === key);
    return hit ? hit.arabic : '';
}

// Draw the prayer card onto the PiP canvas — mirrors the main-site overlay so the
// user sees "it's prayer time" instead of just a frozen timer. Works in every mode.
function _pipDrawPrayer(ctx, W, H) {
    ctx.save();
    // Darken the scene behind the card.
    ctx.fillStyle = 'rgba(6,7,12,0.82)';
    ctx.fillRect(0, 0, W, H);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 16;

    // Mosque glyph.
    ctx.font = `${Math.round(H * 0.16)}px -apple-system, system-ui, sans-serif`;
    ctx.fillText('🕌', W / 2, H * 0.38);

    // "وقت صلاة X"
    const name = _pipPrayerArabic();
    ctx.direction = 'rtl';
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 ${Math.round(H * 0.066)}px Rubik, -apple-system, system-ui, sans-serif`;
    ctx.fillText(name ? `وقت صلاة ${name}` : 'حان وقت الصلاة', W / 2, H * 0.56);

    // Subtitle
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = `500 ${Math.round(H * 0.036)}px Rubik, -apple-system, system-ui, sans-serif`;
    ctx.fillText('حان وقت الصلاة — الله أكبر', W / 2, H * 0.645);
    ctx.restore();
}

function _pipVignette(ctx, W, H) {
    const g = ctx.createRadialGradient(W / 2, H * 0.46, Math.min(W, H) * 0.30, W / 2, H / 2, Math.max(W, H) * 0.74);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.45)');
    ctx.save();
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
}

// Render the world into an arbitrary canvas/context by temporarily swapping the
// gameState render targets. Every draw function reads gameState.ctx/zoom/camera,
// so this transparently retargets them, then restores the originals.
function renderPiPInto(ctx, canvas, dpr) {
    if (!ctx || !canvas) return;
    const s = gameState;
    const _ctx = s.ctx, _canvas = s.canvas, _zoom = s.zoom, _cx = s.camera.x, _cy = s.camera.y, _dpr = s.dpr;
    s.ctx = ctx; s.canvas = canvas; s.zoom = s.pip.zoomLevel;
    s.camera.x = s.pip.camera.x; s.camera.y = s.pip.camera.y; s.dpr = dpr;
    try {
        const W = canvas.width / dpr, H = canvas.height / dpr;
        ctx.save();
        ctx.scale(dpr, dpr);
        ctx.fillStyle = COLORS.black;
        ctx.fillRect(0, 0, W, H);
        drawBackgroundAtmosphere(W, H);

        ctx.save();
        ctx.translate(W / 2, H / 2);
        ctx.scale(s.zoom, s.zoom);
        ctx.translate(s.camera.x, s.camera.y);

        drawRooms();
        if (s.assets.tables.complete) {
            ctx.drawImage(s.assets.tables, TABLE_BOX.minX, TABLE_BOX.minY, TABLE_WIDTH, TABLE_HEIGHT);
        }
        drawBreakDoor();
        drawAmbientMotes();
        drawDustParticles();
        drawPlayers(false);
        drawCoopEmojiFloats();
        drawCoopGroupLabels();
        drawTimers();
        drawRoomShadows();
        ctx.restore();  // world transform

        drawWindParticles(W, H);
        drawFocusFog(W, H);
        drawSunRays(W, H);
        _pipVignette(ctx, W, H);
        // Video PiP has no DOM overlay — paint the timer + label onto the frame.
        if (s.pip.mode === 'video') _pipDrawCanvasChrome(ctx, W, H);
        // Prayer time → draw the prayer card over everything (all PiP modes).
        if (s.prayer.isOverlayActive) _pipDrawPrayer(ctx, W, H);
        ctx.restore();  // dpr scale
    } catch (e) {
        console.error('[pip] render error (loop kept alive)', e);
    } finally {
        s.ctx = _ctx; s.canvas = _canvas; s.zoom = _zoom;
        s.camera.x = _cx; s.camera.y = _cy; s.dpr = _dpr;
    }
}

// Update the floating chrome (timer + task label) in whichever surface is live.
function _pipUpdateChrome() {
    const pip = gameState.pip;
    const t = _pipTimerData();
    if (pip.timerEl && pip.timerEl.textContent !== t.text) pip.timerEl.textContent = t.text;
    if (pip.taskEl && pip.taskEl.textContent !== t.label) pip.taskEl.textContent = t.label;

    // Next prayer + live countdown line (DOM modes only).
    if (pip.prayerEl) {
        const pr = gameState.prayer;
        if (pr.nextPrayer && pr.location && pr.times) {
            const rem = Math.max(0, pr.nextPrayer.timeMs - Date.now());
            pip.prayerEl.classList.add('show');
            const nm = pip.prayerEl.querySelector('.pip-pr-name');
            const cd = pip.prayerEl.querySelector('.pip-pr-cd');
            if (nm) nm.textContent = pr.nextPrayer.arabic;
            if (cd) cd.textContent = formatPrayerCountdown(rem);
        } else {
            pip.prayerEl.classList.remove('show');
        }
    }

    // Prayer screen mode: hide the interactive chrome so the canvas prayer card shows.
    if (pip.rootEl) pip.rootEl.classList.toggle('praying', !!gameState.prayer.isOverlayActive);

    _pipSyncControls();
}

// Reflect focus-sound + YouTube state onto the PiP control bar (cheap; only writes on change).
function _pipSyncControls() {
    const pip = gameState.pip;
    const doc = pip.doc;
    if (!doc) return;
    const eng = gameState.focusAudioEngine;
    if (eng) {
        doc.querySelectorAll('.pip-chip[data-sound]').forEach(chip => {
            const on = !!eng.sounds[chip.dataset.sound]?.active;
            if (chip.classList.contains('active') !== on) chip.classList.toggle('active', on);
        });
        doc.querySelectorAll('.pip-slider-row[data-snd-row]').forEach(row => {
            const on = !!eng.sounds[row.dataset.sndRow]?.active;
            row.classList.toggle('snd-on', on);
        });
    }
    const yt = gameState.focusYTPlayer;
    const playIcon = doc.getElementById('pip-yt-play');
    const pauseIcon = doc.getElementById('pip-yt-pause');
    if (playIcon && pauseIcon) {
        let playing = false;
        try { playing = yt && yt.player && yt.player.getPlayerState && yt.player.getPlayerState() === 1; } catch (e) {}
        playIcon.style.display = playing ? 'none' : 'block';
        pauseIcon.style.display = playing ? 'block' : 'none';
    }
}

// Wire the PiP control bar: sound chips, sliders popover, YouTube transport + options popover.
// Handlers call the existing engine/player directly (same JS context as the opener).
function _pipWireControls(doc) {
    const eng = () => gameState.focusAudioEngine;
    const yt  = () => gameState.focusYTPlayer;

    // Sound toggle chips
    doc.querySelectorAll('.pip-chip[data-sound]').forEach(chip => {
        chip.addEventListener('click', () => {
            const e = eng(); if (!e) return;
            e.toggle(chip.dataset.sound);
            _pipSyncControls();
        });
    });

    const sndPop = doc.getElementById('pip-snd-pop');
    const ytPop  = doc.getElementById('pip-yt-pop');
    const closePops = (except) => {
        if (sndPop && except !== sndPop) sndPop.classList.remove('show');
        if (ytPop  && except !== ytPop)  ytPop.classList.remove('show');
    };

    // Sliders popover (volumes)
    doc.getElementById('pip-snd-more')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const e = eng();
        const ov = doc.getElementById('pip-overall-vol');
        if (e && ov) ov.value = e.overallVolume ?? 0.5;
        if (e) doc.querySelectorAll('input[data-snd-vol]').forEach(sl => {
            const key = sl.dataset.sndVol;
            sl.value = e.sounds[key]?.volume ?? 0.5;
            const on = !!e.sounds[key]?.active;
            const nm = doc.querySelector(`.nm[data-snd-nm="${key}"]`);
            if (nm) nm.classList.toggle('on', on);
            const row = doc.querySelector(`.pip-slider-row[data-snd-row="${key}"]`);
            if (row) row.classList.toggle('snd-on', on);
        });
        const open = !sndPop.classList.contains('show');
        closePops(sndPop); sndPop.classList.toggle('show', open);
    });
    // Overall volume (master) — affects all focus sounds together.
    doc.getElementById('pip-overall-vol')?.addEventListener('input', () => {
        const e = eng(); const ov = doc.getElementById('pip-overall-vol');
        if (e && ov) e.updateOverallVolume(ov.value);
    });
    doc.querySelectorAll('input[data-snd-vol]').forEach(sl => {
        sl.addEventListener('input', () => {
            const e = eng(); if (!e) return;
            const key = sl.dataset.sndVol;
            // Turn the sound on if the user nudges its volume while it's off.
            if (!e.sounds[key]?.active && parseFloat(sl.value) > 0) e.toggle(key);
            e.updateVolume(key, sl.value);
            const nm = doc.querySelector(`.nm[data-snd-nm="${key}"]`);
            if (nm) nm.classList.toggle('on', !!e.sounds[key]?.active);
            _pipSyncControls();
        });
    });

    // YouTube transport
    doc.getElementById('pip-yt-toggle')?.addEventListener('click', () => {
        const y = yt(); if (!y || !y.player) return;
        let playing = false;
        try { playing = y.player.getPlayerState && y.player.getPlayerState() === 1; } catch (e) {}
        if (playing) y.pause(); else y.resume();
        setTimeout(_pipSyncControls, 60);
    });
    doc.getElementById('pip-yt-opts')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const y = yt();
        const vol = doc.getElementById('pip-yt-vol');
        const url = doc.getElementById('pip-yt-url');
        if (y && vol) vol.value = y.volume ?? 80;
        if (y && url && y.url) url.value = y.url;
        const open = !ytPop.classList.contains('show');
        closePops(ytPop); ytPop.classList.toggle('show', open);
    });
    doc.getElementById('pip-yt-load')?.addEventListener('click', () => {
        const y = yt(); const url = doc.getElementById('pip-yt-url');
        if (y && url && url.value.trim()) { y.loadUrl(url.value.trim(), 0, true, false); ytPop.classList.remove('show'); }
    });
    doc.getElementById('pip-yt-vol')?.addEventListener('input', () => {
        const y = yt(); const vol = doc.getElementById('pip-yt-vol');
        if (y && vol) y.setVolumePercent(parseInt(vol.value, 10));
    });

    // Tapping the canvas / empty space closes any open popover.
    doc.addEventListener('click', (ev) => {
        if (!ev.target.closest('#pip-snd-pop, #pip-snd-more, #pip-yt-pop, #pip-yt-opts')) closePops(null);
    });
}

// One render tick, driven by the PiP window's own rAF (runs at full speed even
// when the opener tab is hidden/throttled — this is what keeps PiP smooth).
function _pipFrame() {
    const pip = gameState.pip;
    if (!pip.active || pip.mode !== 'window' || !pip.win || pip.win.closed) return;
    if (gameState._dupSessionDetected) { closePiPMode(); return; }
    updatePiPCamera();
    renderPiPInto(pip.ctx, pip.canvas, pip.dpr);
    _pipUpdateChrome();
    pip._lastFrameAt = performance.now();
    try { pip.rafId = pip.win.requestAnimationFrame(_pipFrame); } catch (e) { closePiPMode(); }
}

function _pipResizeWindowCanvas() {
    const pip = gameState.pip;
    if (!pip.win || !pip.canvas) return;
    const dpr = pip.win.devicePixelRatio || 1;
    const w = pip.win.innerWidth, h = pip.win.innerHeight;
    if (w <= 0 || h <= 0) return;
    pip.dpr = dpr;
    pip.canvas.width = Math.round(w * dpr);
    pip.canvas.height = Math.round(h * dpr);
    pip.canvas.style.width = w + 'px';
    pip.canvas.style.height = h + 'px';
}

function _pipSetupWindow(win) {
    const pip = gameState.pip;
    const doc = win.document;
    // window.open('') yields about:blank — make sure head/body exist.
    if (!doc.head) { try { (doc.documentElement || doc).appendChild(doc.createElement('head')); } catch (e) {} }
    if (!doc.body) { try { (doc.documentElement || doc).appendChild(doc.createElement('body')); } catch (e) {} }
    doc.documentElement.lang = 'ar';
    doc.documentElement.dir = 'rtl';

    const fontLink = doc.createElement('link');
    fontLink.rel = 'stylesheet';
    fontLink.href = 'https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;700&display=swap';
    doc.head.appendChild(fontLink);

    const style = doc.createElement('style');
    style.textContent = PIP_WINDOW_CSS;
    doc.head.appendChild(style);

    doc.body.innerHTML = PIP_WINDOW_HTML.replace('__PIP_CONTROLS__', _pipBuildControlsHTML());

    pip.doc = doc;
    pip.canvas = doc.getElementById('pip-canvas');
    pip.ctx = pip.canvas.getContext('2d');
    pip.timerEl = doc.getElementById('pip-timer');
    pip.taskEl = doc.getElementById('pip-task');
    pip.rootEl = doc.getElementById('pip-root');
    pip.prayerEl = doc.getElementById('pip-prayer');

    doc.getElementById('pip-close').addEventListener('click', () => closePiPMode());
    _pipWireControls(doc);
    win.addEventListener('resize', _pipResizeWindowCanvas);
    win.addEventListener('pagehide', () => closePiPMode());
    win.addEventListener('unload', () => closePiPMode());
    // Scroll to zoom — a nice bonus the OS PiP gives us for free.
    win.addEventListener('wheel', (e) => {
        e.preventDefault();
        const d = e.deltaY > 0 ? -0.2 : 0.2;
        pip.targetZoomLevel = Math.max(0.8, Math.min(4.0, pip.targetZoomLevel + d));
    }, { passive: false });

    _pipResizeWindowCanvas();

    // Safari-proof: schedule a render loop inside the popup window's own execution
    // context. When the popup is visible to the user, its setInterval is not subject
    // to the opener tab's background-throttling — so this fires even when the opener
    // is hidden/throttled, keeping the canvas alive at ~30 fps minimum.
    if (pip.popupPollId) { try { win.clearInterval(pip.popupPollId); } catch(e) {} pip.popupPollId = null; }
    pip.popupPollId = win.setInterval(() => {
        const p = gameState.pip;
        if (!p.active || p.mode !== 'window' || !p.win || p.win.closed) {
            try { win.clearInterval(p.popupPollId); } catch(e) {} p.popupPollId = null; return;
        }
        // Always render — no stale check. The main-loop watchdog also renders when
        // the opener is foregrounded, so this only adds cost when it is throttled.
        try {
            updatePiPCamera();
            renderPiPInto(p.ctx, p.canvas, p.dpr);
            _pipUpdateChrome();
            p._lastFrameAt = performance.now();
        } catch (e) {}
    }, 33);
}

async function openPiPMode() {
    const pip = gameState.pip;
    // Re-entrancy guard: requestWindow() is async, so without _opening a second
    // click (or a stale one) would spin up a duplicate window and race the close.
    if (pip.active || pip._opening || pip._closing) return;
    if (!isPiPAllowed()) return;
    pip._opening = true;

    // ── Tier 1: Document Picture-in-Picture (Chrome/Edge) ──
    // Real OS window with its own DOM + rAF — smoothest, richest. Chrome only.
    if (pipSupported()) {
        try {
            const win = await documentPictureInPicture.requestWindow({ width: 440, height: 480 });
            // Closed/cancelled while we were awaiting → discard this window.
            if (!pip._opening) { try { win.close(); } catch (e) {} return; }
            pip.win = win;
            pip.mode = 'window';
            pip.active = true;
            pip._opening = false;
            pip._camInit = false;
            pip.targetZoomLevel = pip.zoomLevel = 2.4;
            _pipSetupWindow(win);
            _pipShowBlackout(true);
            _pipReflectButton();
            // Paint one frame immediately so the window never flashes blank.
            updatePiPCamera();
            renderPiPInto(pip.ctx, pip.canvas, pip.dpr);
            _pipUpdateChrome();
            pip._lastFrameAt = performance.now();
            pip.rafId = win.requestAnimationFrame(_pipFrame);
            return;
        } catch (e) {
            console.warn('[pip] Document PiP unavailable, trying Video PiP:', e && e.name || e);
        }
    }
    if (!pip._opening) return;   // cancelled during the await

    // ── Tier 2: Video Picture-in-Picture (Safari/Chrome/Edge) ──
    // A genuine floating OS window via a captured canvas stream — escapes the
    // browser, stays on top of all apps, draggable anywhere across displays.
    if (_pipVideoSupported()) {
        try {
            await _pipOpenVideo();
            if (!pip._opening) return;   // cancelled mid-await → _pipOpenVideo bailed
            pip._opening = false;
            return;
        } catch (e) {
            console.warn('[pip] Video PiP unavailable, trying popup window:', e && e.name || e);
            // Make sure a half-opened video session doesn't linger.
            try { if (pip.stream) pip.stream.getTracks().forEach(t => t.stop()); } catch (_) {}
            pip.stream = null; pip.mode = null; pip.active = false;
        }
    }
    if (!pip._opening) return;

    // ── Tier 3: real popup window (desktop Safari & anywhere window.open works) ──
    // Safari has no Document PiP AND no canvas.captureStream, so a true
    // always-on-top PiP of live content is impossible there. A popup window is
    // the next best thing: a separate OS window that escapes the tab and drags
    // freely across displays (just not always-on-top). Renders via the same path.
    // Skipped on mobile — there window.open is just a new tab, not a window.
    // Skipped on mobile AND on iPad/iPhone: on iOS/iPadOS every browser is WebKit
    // and window.open() makes a *tab*, never an escapable window — so the popup
    // would just be stuck inside the browser (worse than the in-page panel below).
    if (!isMobile() && !_pipIsAppleTouch()) {
        try {
            if (_pipOpenPopup()) { pip._opening = false; return; }
        } catch (e) {
            console.warn('[pip] popup window failed, using in-page panel:', e && e.name || e);
        }
    }
    if (!pip._opening) return;

    // ── Tier 4: in-page fallback panel ──
    pip._opening = false;
    _pipOpenFallback();
}

// Open the PiP view in a real popup window (window.open). Returns false if the
// popup is blocked, so the caller can fall through to the in-page panel.
function _pipOpenPopup() {
    const pip = gameState.pip;
    const W = 400, H = 460;
    const left = Math.max(0, (window.screen && window.screen.availWidth || 1280) - W - 40);
    const top = 90;
    // No `popup=yes` (Safari ignores it and may open a full tab); explicit
    // dimensions + disabled bars is the cross-browser way to force a small popup.
    const features = `width=${W},height=${H},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no,scrollbars=no,resizable=yes`;
    let win = null;
    try { win = window.open('', 'mdwnhPiP', features); } catch (e) { win = null; }
    if (!win) return false;
    // Safari often ignores size on an about:blank popup — force it small + placed.
    try { win.resizeTo(W, H); } catch (e) {}
    try { win.moveTo(left, top); } catch (e) {}

    pip.win = win;
    pip.mode = 'window';
    pip.active = true;
    pip._camInit = false;
    pip.targetZoomLevel = pip.zoomLevel = 2.4;
    _pipSetupWindow(win);
    _pipShowBlackout(true);
    _pipReflectButton();

    updatePiPCamera();
    renderPiPInto(pip.ctx, pip.canvas, pip.dpr);
    _pipUpdateChrome();
    pip._lastFrameAt = performance.now();
    try { pip.rafId = win.requestAnimationFrame(_pipFrame); } catch (e) {}
    // popupPollId backstop is set up inside _pipSetupWindow (above)
    return true;
}

// True on iPhone/iPod and iPadOS (which reports as "MacIntel" but has touch).
// Used to skip the popup-window PiP tier — window.open is only ever a tab on iOS.
function _pipIsAppleTouch() {
    const ua = navigator.userAgent || '';
    if (/iP(hone|od|ad)/.test(ua)) return true;
    // iPadOS 13+ masquerades as macOS Safari; real Macs have no touch.
    return navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1;
}

function _pipVideoSupported() {
    try {
        const c = document.createElement('canvas');
        if (typeof c.captureStream !== 'function') return false;
        const v = document.createElement('video');
        return !!document.pictureInPictureEnabled || typeof v.webkitSetPresentationMode === 'function';
    } catch (e) { return false; }
}

const PIP_VIDEO_W = 920, PIP_VIDEO_H = 1040;   // 460×520 @2x — retina-crisp portrait

// Build the offscreen canvas + hidden <video> + capture stream (idempotent).
function _pipBuildVideoPipeline() {
    const pip = gameState.pip;
    if (!pip.srcCanvas) pip.srcCanvas = document.createElement('canvas');
    if (pip.srcCanvas.width !== PIP_VIDEO_W)  pip.srcCanvas.width  = PIP_VIDEO_W;
    if (pip.srcCanvas.height !== PIP_VIDEO_H) pip.srcCanvas.height = PIP_VIDEO_H;
    pip.dpr = 2;

    if (!pip.video) {
        const v = document.createElement('video');
        v.muted = true; v.defaultMuted = true; v.playsInline = true;
        v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
        v.style.cssText = 'position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
        document.body.appendChild(v);
        pip.video = v;
        const onLeave = () => { if (gameState.pip.mode === 'video' && gameState.pip.active) closePiPMode(); };
        v.addEventListener('leavepictureinpicture', onLeave);
        v.addEventListener('webkitpresentationmodechanged', () => {
            if (v.webkitPresentationMode && v.webkitPresentationMode !== 'picture-in-picture') onLeave();
        });
    }
    if (!pip.stream) {
        pip.stream = pip.srcCanvas.captureStream(30);
        pip.video.srcObject = pip.stream;
    }
}

// Pre-warm the video while the button is shown so that, on click, PiP can be
// requested with the video already playing + metadata loaded. Safari grants PiP
// only for a ready video, and is happiest when requestPictureInPicture is called
// without an intervening async wait — priming buys exactly that. No-op unless
// Video PiP is the active path (i.e. Document PiP is unavailable).
function _pipPrimeVideo() {
    const pip = gameState.pip;
    if (pip._videoPrimed || pip.active) return;
    if (pipSupported() || !_pipVideoSupported()) return;
    try {
        _pipBuildVideoPipeline();
        const ctx = pip.srcCanvas.getContext('2d');
        ctx.fillStyle = '#07070a';
        ctx.fillRect(0, 0, pip.srcCanvas.width, pip.srcCanvas.height);
        pip.video.play().catch(() => {});
        pip._videoPrimed = true;
    } catch (e) { /* best-effort */ }
}

// Open a Video-PiP window: render the world+timer into the offscreen canvas,
// then request PiP on the hidden <video> that mirrors it via captureStream.
async function _pipOpenVideo() {
    const pip = gameState.pip;
    _pipBuildVideoPipeline();
    pip.canvas = pip.srcCanvas;
    pip.ctx = pip.srcCanvas.getContext('2d');
    pip.timerEl = null; pip.taskEl = null;   // video has no DOM chrome — drawn on canvas
    pip.mode = 'video';
    pip._camInit = false;
    pip.targetZoomLevel = pip.zoomLevel = 2.4;

    // Live frame before capture so the window never shows the neutral prime fill.
    updatePiPCamera();
    renderPiPInto(pip.ctx, pip.srcCanvas, pip.dpr);

    // Only await play() if not already playing (priming usually started it) —
    // skipping the await keeps the click's transient activation maximally fresh.
    if (pip.video.paused) { try { await pip.video.play(); } catch (e) {} }

    if (typeof pip.video.requestPictureInPicture === 'function') {
        await pip.video.requestPictureInPicture();
    } else if (typeof pip.video.webkitSetPresentationMode === 'function') {
        pip.video.webkitSetPresentationMode('picture-in-picture');
    } else {
        throw new Error('no-video-pip-api');
    }

    // Cancelled while awaiting PiP entry → undo immediately.
    if (!pip._opening) {
        try {
            if (document.pictureInPictureElement === pip.video) document.exitPictureInPicture().catch(() => {});
        } catch (e) {}
        return;
    }

    pip.active = true;
    _pipShowBlackout(true);
    _pipReflectButton();
    pip._lastFrameAt = performance.now();

    // Background backstop: the main rAF throttles when the tab is hidden, so a
    // timer keeps the stream (and the visible MM:SS) alive while you're away.
    if (pip._videoInterval) clearInterval(pip._videoInterval);
    pip._videoInterval = setInterval(() => {
        const p = gameState.pip;
        if (p.active && p.mode === 'video' && performance.now() - (p._lastFrameAt || 0) > 200) {
            try { updatePiPCamera(); renderPiPInto(p.ctx, p.canvas, p.dpr); p._lastFrameAt = performance.now(); } catch (e) {}
        }
    }, 300);
}

function closePiPMode() {
    const pip = gameState.pip;
    if (pip._closing) return;
    pip._opening = false;   // cancel any in-flight openPiPMode awaiting requestWindow/PiP
    if (!pip.active && pip.mode === null) { _pipReflectButton(); return; }
    pip._closing = true;

    pip.active = false;

    // Document PiP / popup window
    if (pip.win) {
        try { if (pip.rafId) pip.win.cancelAnimationFrame(pip.rafId); } catch (e) {}
        if (pip.popupPollId) { try { pip.win.clearInterval(pip.popupPollId); } catch(e) {} pip.popupPollId = null; }
        try { if (!pip.win.closed) pip.win.close(); } catch (e) {}
    }
    pip.rafId = 0;
    pip.popupPollId = null;
    pip.win = null; pip.doc = null;

    // Video PiP
    if (pip._videoInterval) { clearInterval(pip._videoInterval); pip._videoInterval = 0; }
    if (pip.video) {
        try {
            if (document.pictureInPictureElement === pip.video && document.exitPictureInPicture) {
                document.exitPictureInPicture().catch(() => {});
            } else if (typeof pip.video.webkitSetPresentationMode === 'function'
                       && pip.video.webkitPresentationMode === 'picture-in-picture') {
                pip.video.webkitSetPresentationMode('inline');
            }
        } catch (e) {}
        try { pip.video.pause(); } catch (e) {}
        try { if (pip.stream) pip.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
        try { pip.video.srcObject = null; } catch (e) {}
    }
    pip.stream = null;
    pip._videoPrimed = false;   // re-prime fresh next time the button shows

    pip.ctx = null; pip.canvas = null;
    pip.timerEl = null; pip.taskEl = null;
    pip.rootEl = null; pip.prayerEl = null;
    _pipCloseFallback();
    pip.mode = null;
    _pipShowBlackout(false);
    _pipReflectButton();
    pip._closing = false;
}

function togglePiPMode() {
    if (gameState.pip.active) closePiPMode();
    else openPiPMode();
}

function _pipShowBlackout(show) {
    // Guard: never show the blackout unless PiP is genuinely active
    if (show && !gameState.pip.active) return;
    const el = gameState.pip.blackout;
    if (el) {
        if (show) {
            // Make visible before adding active class so the CSS transition fires
            el.style.display = 'flex';
            // Defer one frame so display change is painted before opacity transition starts
            requestAnimationFrame(() => el.classList.add('active'));
        } else {
            el.classList.remove('active');
            // After transition completes, truly hide it from render tree
            setTimeout(() => {
                if (!el.classList.contains('active')) el.style.display = 'none';
            }, 450);
        }
    }
    document.body.classList.toggle('pip-active', !!show);
}

function _pipReflectButton() {
    if (gameState.pip.btn) gameState.pip.btn.classList.toggle('active', !!gameState.pip.active);
}

// ── In-page fallback (browsers without Document PiP) ─────────────────────────
function _pipOpenFallback() {
    const pip = gameState.pip;
    const el = pip.fallbackEl;
    if (!el) return;
    pip.canvas = document.getElementById('pip-fb-canvas');
    pip.ctx = pip.canvas.getContext('2d');
    pip.timerEl = document.getElementById('pip-fb-timer');
    pip.taskEl = document.getElementById('pip-fb-task');
    pip.mode = 'fallback';
    pip.active = true;
    pip._camInit = false;
    pip.targetZoomLevel = pip.zoomLevel = 2.4;
    el.classList.add('active');
    _pipShowBlackout(true);
    _pipReflectButton();
    _pipResizeFallbackCanvas();
}

function _pipCloseFallback() {
    if (gameState.pip.fallbackEl) gameState.pip.fallbackEl.classList.remove('active');
}

function _pipResizeFallbackCanvas() {
    const pip = gameState.pip, c = pip.canvas;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    pip.dpr = dpr;
    const w = c.clientWidth, h = c.clientHeight;
    if (w <= 0 || h <= 0) return;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
}

function _pipSetupFallback() {
    const el = document.getElementById('pip-fallback');
    if (!el) return;
    const bar = document.getElementById('pip-fb-bar') || el;
    const closeBtn = document.getElementById('pip-fb-close');
    if (closeBtn) closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closePiPMode(); });

    // Drag by the top bar. A small movement threshold means a plain click on
    // the bar (or a jittery click on the close button) never nudges the panel.
    let armed = false, dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    bar.addEventListener('pointerdown', (e) => {
        if (e.target.closest('#pip-fb-close')) return;
        armed = true; dragging = false;
        const r = el.getBoundingClientRect();
        ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
    });
    bar.addEventListener('pointermove', (e) => {
        if (!armed) return;
        if (!dragging) {
            if (Math.hypot(e.clientX - sx, e.clientY - sy) < 4) return;
            dragging = true;
            el.classList.add('dragging');
            el.style.left = ox + 'px'; el.style.top = oy + 'px';
            el.style.right = 'auto'; el.style.bottom = 'auto';
            try { bar.setPointerCapture(e.pointerId); } catch (_) {}
        }
        const maxX = window.innerWidth - el.offsetWidth, maxY = window.innerHeight - el.offsetHeight;
        el.style.left = Math.max(0, Math.min(maxX, ox + e.clientX - sx)) + 'px';
        el.style.top = Math.max(0, Math.min(maxY, oy + e.clientY - sy)) + 'px';
    });
    const endDrag = (e) => { armed = false; dragging = false; el.classList.remove('dragging'); try { bar.releasePointerCapture(e.pointerId); } catch (_) {} };
    bar.addEventListener('pointerup', endDrag);
    bar.addEventListener('pointercancel', endDrag);

    // Resize handle → keep backing store in sync.
    const c = document.getElementById('pip-fb-canvas');
    if (window.ResizeObserver && c) {
        const ro = new ResizeObserver(() => {
            if (gameState.pip.active && gameState.pip.mode === 'fallback') _pipResizeFallbackCanvas();
        });
        ro.observe(c);
    }
    el.addEventListener('wheel', (e) => {
        if (!gameState.pip.active) return;
        e.preventDefault();
        const d = e.deltaY > 0 ? -0.2 : 0.2;
        gameState.pip.targetZoomLevel = Math.max(0.8, Math.min(4.0, gameState.pip.targetZoomLevel + d));
    }, { passive: false });
}

// Per-frame: drive button visibility, auto-close, and (for fallback / stalled
// window) drive the render from the main loop. Called early in gameLoop so it
// runs even while a minigame's early-return path is active.
function updatePiPLifecycle() {
    const pip = gameState.pip;
    const allowed = isPiPAllowed();

    if (pip.btn) {
        // Shown on mobile too: Android Chrome gets real Video PiP; iOS Safari
        // (no Document PiP / captureStream) gets the in-page panel.
        pip.btn.classList.toggle('visible', allowed && !pip.active);
    }

    // Pre-warm the Video-PiP pipeline while the button is available so the click
    // can enter PiP instantly (self-guards; only acts on the Video-PiP path —
    // i.e. Android Chrome and any browser with captureStream + PiP).
    if (allowed && !pip.active) _pipPrimeVideo();

    if (pip.active && !allowed) { closePiPMode(); return; }
    if (!pip.active) return;

    if (pip.mode === 'fallback' || pip.mode === 'video') {
        // In-page surface / video-stream source: the main loop drives it each
        // frame (smooth while foregrounded; the video backstop covers hidden tabs).
        updatePiPCamera();
        renderPiPInto(pip.ctx, pip.canvas, pip.dpr);
        _pipUpdateChrome();
        pip._lastFrameAt = performance.now();
    } else if (pip.mode === 'window') {
        // A popup the user closed via the OS chrome → tear down cleanly.
        if (pip.win && pip.win.closed) { closePiPMode(); return; }
        // Drive the popup from the main game loop every frame — consistent with
        // fallback/video modes. _pipFrame (popup rAF) runs in parallel and provides
        // smooth 60fps when the popup is the focused window; this watchdog ensures
        // the canvas never goes stale when the opener tab is throttled or the popup
        // rAF is paused by the browser (e.g. Safari background throttling).
        updatePiPCamera();
        renderPiPInto(pip.ctx, pip.canvas, pip.dpr);
        _pipUpdateChrome();
        pip._lastFrameAt = performance.now();
    }
}

function setupPiPUI() {
    const pip = gameState.pip;
    pip.supported = pipSupported();
    pip.btn = document.getElementById('pip-toggle-btn');
    pip.blackout = document.getElementById('pip-blackout');
    pip.fallbackEl = document.getElementById('pip-fallback');

    if (pip.btn) pip.btn.addEventListener('click', () => togglePiPMode());
    const endBtn = document.getElementById('pip-blackout-end');
    if (endBtn) endBtn.addEventListener('click', () => closePiPMode());

    // Close the PiP window if the opener navigates away / logs out / refreshes.
    window.addEventListener('pagehide', () => {
        if (gameState.pip.win) { try { gameState.pip.win.close(); } catch (e) {} }
    });

    _pipSetupFallback();
}

function spPath(sub) { return lobbyPath(`sharedPomo/${sub}`); }

// ── Settings (device-local, persisted in localStorage) ───────────────────────

// Returns the explicit stored tier, or null when on device-auto (no explicit choice).
function getGraphicsQuality() {
    const v = localStorage.getItem(SETTINGS_GRAPHICS_KEY);
    return (v === 'high' || v === 'low' || v === 'potato') ? v : null;
}

// Resolve to a concrete tier: an explicit choice, else the device default — mobile
// → 'low' (atmosphere gradients ON, cheap compositing), desktop → 'high'.
function graphicsTier() {
    return getGraphicsQuality() || (isMobile() ? 'low' : 'high');
}

// Reduced compositing: DPR cap, no live backdrop-filter, no canvas shadows, fewer
// particles. True on BOTH 'low' and 'potato' — i.e. mobile by default. These are
// the cheap-but-huge wins that don't change the art, so they apply on low too.
function isReducedGraphics() {
    const t = graphicsTier();
    return t === 'low' || t === 'potato';
}

// Potato (بطاطس): the most aggressive tier — additionally drops the atmosphere
// gradients (sun wash, parallax background, focus-fade, fog, ambient motes). This
// is exactly the old mobile-low behaviour, kept for very weak phones.
function isPotato() { return graphicsTier() === 'potato'; }

// Back-compat alias: historically "low graphics" meant the reduced-compositing set.
function isLowGraphics() { return isReducedGraphics(); }

function getHideNames() {
    return localStorage.getItem(SETTINGS_NAMES_KEY) === '1';
}

function setupSettingsUI() {
    const settingsBtn   = document.getElementById('settings-btn');
    const panel         = document.getElementById('settings-panel');
    const closeBtn      = document.getElementById('settings-panel-close');
    const graphicsBtn   = document.getElementById('settings-graphics-btn');
    const graphicsLabel = document.getElementById('settings-graphics-label');
    const namesBtn      = document.getElementById('settings-names-btn');
    const namesLabel    = document.getElementById('settings-names-label');
    const joystickBtn   = document.getElementById('settings-joystick-btn');
    const joystickLabel = document.getElementById('settings-joystick-label');
    const idleBtn       = document.getElementById('settings-idle-btn');
    const idleLabel     = document.getElementById('settings-idle-label');
    const azkarRandBtn  = document.getElementById('settings-azkar-random-btn');
    const azkarRandLabel= document.getElementById('settings-azkar-random-label');
    if (!settingsBtn || !panel) return;

    function _reflectJoystick() {
        if (!joystickBtn) return;
        const shown = joystickShouldShow();   // resolves auto for display
        joystickBtn.dataset.value = shown ? 'on' : 'off';
        joystickBtn.classList.toggle('settings-toggle-on', shown);
        joystickBtn.classList.toggle('settings-toggle-low', !shown);
        if (joystickLabel) joystickLabel.textContent = shown ? 'ظاهرة' : 'مغلقة';
    }

    function _reflectGraphics() {
        const tier = graphicsTier();           // always concrete (device default until chosen)
        graphicsBtn.dataset.value = tier;
        graphicsBtn.classList.toggle('settings-toggle-on',  tier === 'high');
        graphicsBtn.classList.toggle('settings-toggle-low', tier === 'potato');
        const labels = { high: 'عالية', low: 'منخفضة', potato: 'بطاطس' };
        graphicsLabel.textContent = labels[tier];
        _applyGraphicsSetting();
    }

    function _reflectNames() {
        const hide = getHideNames();
        namesBtn.dataset.value = hide ? 'hide' : 'show';
        namesBtn.classList.toggle('settings-toggle-on', !hide);
        namesLabel.textContent = hide ? 'مخفية' : 'ظاهرة';
    }

    function _reflectIdle() {
        if (!idleBtn) return;
        // "حركة الجلوس مفعّلة" = idle animation ON (default). Disabled = OFF.
        const disabled = getDisableIdleAnim();
        idleBtn.dataset.value = disabled ? 'off' : 'on';
        idleBtn.classList.toggle('settings-toggle-on', !disabled);
        idleLabel.textContent = disabled ? 'مغلقة' : 'مفعّلة';
    }

    function _reflectAzkarRandom() {
        if (!azkarRandBtn) return;
        const on = getRandomizeAzkar();
        azkarRandBtn.dataset.value = on ? 'on' : 'off';
        azkarRandBtn.classList.toggle('settings-toggle-on', on);
        azkarRandLabel.textContent = on ? 'مفعّل' : 'مغلق';
    }

    function _applyGraphicsSetting() {
        // Bokeh (live backdrop-filter blur): hide on reduced tiers (low + potato).
        const bokeh = document.getElementById('edge-bokeh');
        if (bokeh && isReducedGraphics()) bokeh.style.display = 'none';
        else if (bokeh) bokeh.style.display = '';
        // Re-apply the DPR cap and refresh the cached tier flags so the shadow guard
        // and atmosphere gates react immediately.
        gameState._lowGfx = isReducedGraphics();
        gameState._potato = isPotato();
        applyGraphicsBodyClass();   // toggle reduced-gfx/potato-gfx body classes for the CSS wins
        resizeCanvas();
    }

    // Cycles the explicit tiers: عالية → منخفضة → بطاطس. Operates on the resolved tier
    // (device default until first chosen) so a press always visibly changes something.
    graphicsBtn.addEventListener('click', () => {
        const cycle = { high: 'low', low: 'potato', potato: 'high' };
        const next = cycle[graphicsTier()] || 'low';
        localStorage.setItem(SETTINGS_GRAPHICS_KEY, next);
        _reflectGraphics();
    });

    namesBtn.addEventListener('click', () => {
        const next = getHideNames() ? '0' : '1';
        localStorage.setItem(SETTINGS_NAMES_KEY, next);
        _reflectNames();
    });

    if (joystickBtn) {
        joystickBtn.addEventListener('click', () => {
            // Binary toggle: flip the resolved visible state.
            setJoystickMode(joystickShouldShow() ? 'off' : 'on');
            _reflectJoystick();
        });
    }

    if (idleBtn) {
        idleBtn.addEventListener('click', () => {
            const next = getDisableIdleAnim() ? '0' : '1';
            localStorage.setItem(SETTINGS_NOIDLE_KEY, next);
            _reflectIdle();
        });
    }

    if (azkarRandBtn) {
        azkarRandBtn.addEventListener('click', () => {
            const next = getRandomizeAzkar() ? '0' : '1';
            localStorage.setItem(SETTINGS_AZKAR_RANDOM_KEY, next);
            _reflectAzkarRandom();
        });
    }

    settingsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        panel.classList.toggle('hidden');
        settingsBtn.classList.toggle('active', !panel.classList.contains('hidden'));
    });

    closeBtn.addEventListener('click', () => {
        panel.classList.add('hidden');
        settingsBtn.classList.remove('active');
    });

    document.addEventListener('click', (e) => {
        if (!panel.classList.contains('hidden') &&
            !panel.contains(e.target) &&
            e.target !== settingsBtn) {
            panel.classList.add('hidden');
            settingsBtn.classList.remove('active');
        }
    });

    _reflectGraphics();
    _reflectNames();
    _reflectJoystick();
    _reflectIdle();
    _reflectAzkarRandom();
}

// ── Init ──────────────────────────────────────────────────────────────────────

function initSharedPomo() {
    const sp = gameState.sharedPomo;

    // Listen for invites addressed to us
    const inviteRef = ref(database, spPath(`invites/${gameState.userId}`));
    sp.unsubInvite = onValue(inviteRef, snap => {
        const invite = snap.val();
        if (!invite) { if (sp.phase === 'idle' || sp.phase === 'gathering') hideSpToast(); return; }
        // Free mode users can't accept invites — they must end their session first
        if (gameState.freeMode.active) {
            update(ref(database), { [spPath(`invites/${gameState.userId}`)]: null });
            return;
        }
        // Allow receiving invites when idle OR when hosting a gathering (can swap to guest)
        if (sp.phase !== 'idle' && sp.phase !== 'gathering') return;
        const age = Date.now() - (invite.sentAt || 0);
        if (age > SP_INVITE_TTL) {
            update(ref(database), { [spPath(`invites/${gameState.userId}`)]: null });
            return;
        }
        sp.pendingInvite = invite;
        showSpToast(invite);
    });

    // Wire guest-leave button once
    document.getElementById('sp-guest-leave')?.addEventListener('click', leaveSharedPomo);
}

function setupSpSessionListener(sessionId) {
    const sp = gameState.sharedPomo;
    if (sp.unsubSession) { sp.unsubSession(); sp.unsubSession = null; }
    const sessRef = ref(database, spPath(`sessions/${sessionId}`));
    sp.unsubSession = onValue(sessRef, snap => {
        const session = snap.val();
        if (!session) {
            if (sp.phase !== 'idle' && sp.phase !== 'active') onSpSessionCancelled();
            return;
        }
        sp.session = session;
        if (session.phase === 'gathering') {
            if (sp.isHost) renderSpGatherPanel(session);
        } else if (session.phase === 'active' && sp.phase !== 'active') {
            launchSharedPomoWork(session);
        }
    });
}

// ── Proximity panel ───────────────────────────────────────────────────────────

function updateSharedPomoProximity() {
    const sp = gameState.sharedPomo;
    // When hosting a gathering, keep showing nearby players so more can be invited
    const hostIsGathering = sp.phase === 'gathering' && sp.isHost;
    if ((!hostIsGathering && sp.phase !== 'idle') || gameState.pomodoro.active || gameState.freeMode.active) {
        renderSpNearbyPanel([]);
        if (!gameState.pomodoro.active && !gameState.freeMode.active) {
            // Still detect nearby coop sessions even when not idle for join flow
            checkNearbyCoopSession();
        } else {
            // In my OWN session — a join panel must never linger/stay clickable.
            // (checkNearbyCoopSession is skipped here, so hide it explicitly.)
            sp.nearbyCoopId = '';
            sp.nearbySoloId = '';
            document.getElementById('sp-join-panel')?.classList.add('hidden');
        }
        return;
    }
    const local = gameState.players[gameState.userId];
    if (!local) { renderSpNearbyPanel([]); return; }

    // Free players → invite panel (skip free-mode users — they can't be invited)
    const nearby = [];
    for (const p of Object.values(gameState.players)) {
        if (p.userId === gameState.userId) continue;
        if (!p.activeInGame) continue;
        if (p.isWorking || p.isOnBreak || p.inFreeMode) continue;
        if (sp.session?.participants?.[p.userId]) continue;
        const dx = p.x - local.x, dy = p.y - local.y;
        if (dx*dx + dy*dy < SP_PROXIMITY_SQ) nearby.push({ p, d: dx*dx + dy*dy });
    }
    nearby.sort((a, b) => a.d - b.d);
    const players = nearby.map(n => n.p);

    const newIds = players.map(p => p.userId).join(',');
    if (newIds !== sp.nearbyPlayerIds) {
        sp.nearbyPlayerIds = newIds;
        sp.nearbyPlayers = players;
        renderSpNearbyPanel(players);
    }

    // Active coop sessions nearby → join panel
    checkNearbyCoopSession();
}

function checkNearbyCoopSession() {
    const sp = gameState.sharedPomo;
    if (sp.phase !== 'idle' || gameState.pomodoro.active || gameState.freeMode.active) {
        if (sp.nearbyCoopId)  { sp.nearbyCoopId  = ''; document.getElementById('sp-join-panel')?.classList.add('hidden'); }
        if (sp.nearbySoloId)  { sp.nearbySoloId  = ''; }
        return;
    }
    const local = gameState.players[gameState.userId];
    if (!local) return;

    // ── Active coop sessions (highest priority) ──────────────────────────────
    let bestCoopHostId = null, bestDist = Infinity;
    for (const p of Object.values(gameState.players)) {
        if (p.userId === gameState.userId) continue;
        if (!p.isWorking || !p.coopHostId) continue;
        const dx = p.x - local.x, dy = p.y - local.y;
        const d = dx*dx + dy*dy;
        if (d < SP_PROXIMITY_SQ && d < bestDist) { bestDist = d; bestCoopHostId = p.coopHostId; }
    }

    if (bestCoopHostId) {
        if (sp.nearbySoloId) sp.nearbySoloId = ''; // coop wins over solo
        if (bestCoopHostId !== sp.nearbyCoopId) {
            sp.nearbyCoopId = bestCoopHostId;
            sp.joinDetails  = null;
            showSpJoinPanel(bestCoopHostId);
        }
        return;
    }

    // No coop session — hide stale coop panel
    if (sp.nearbyCoopId) { sp.nearbyCoopId = ''; document.getElementById('sp-join-panel')?.classList.add('hidden'); }

    // ── Solo workers (can be converted to shared pomo) ────────────────────────
    let bestSoloId = null; bestDist = Infinity;
    for (const p of Object.values(gameState.players)) {
        if (p.userId === gameState.userId) continue;
        // Free mode workers are excluded — shared free mode join is not supported
        if (!p.isWorking || p.coopHostId || p.inFreeMode) continue;
        const dx = p.x - local.x, dy = p.y - local.y;
        const d = dx*dx + dy*dy;
        if (d < SP_PROXIMITY_SQ && d < bestDist) { bestDist = d; bestSoloId = p.userId; }
    }

    if (bestSoloId) {
        if (bestSoloId !== sp.nearbySoloId) {
            sp.nearbySoloId = bestSoloId;
            sp.joinDetails  = null;
            showSoloJoinPanel(bestSoloId);
        }
    } else {
        if (sp.nearbySoloId) { sp.nearbySoloId = ''; document.getElementById('sp-join-panel')?.classList.add('hidden'); }
    }
}

function renderSpNearbyPanel(players) {
    const panel = document.getElementById('sp-nearby');
    if (!panel) return;
    if (players.length === 0) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    panel.innerHTML = `<div class="sp-nearby-label">مجاورون</div>` +
        players.map(p => {
            const av = p.avatar ? `<img src="${p.avatar}" alt="">` : (p.username||'?').charAt(0).toUpperCase();
            const sp = gameState.sharedPomo;
            const isPending = sp.session?.participants?.[p.userId]?.status === 'invited';
            return `<div class="sp-nearby-chip${isPending?' sp-chip-sent':''}" data-uid="${p.userId}">
                <div class="sp-chip-av">${av}</div>
                <span class="sp-chip-name">${p.username||''}</span>
                <span class="sp-chip-icon">${isPending ? '⏳' : '+'}</span>
            </div>`;
        }).join('');
    panel.querySelectorAll('.sp-nearby-chip:not(.sp-chip-sent)').forEach(chip =>
        chip.addEventListener('click', () => sendSpInvite(chip.dataset.uid))
    );
}

// ── Join mid-session flow ─────────────────────────────────────────────────────

function showSpJoinPanel(hostId) {
    const panel = document.getElementById('sp-join-panel');
    if (!panel) return;

    // Reset to peek state
    document.getElementById('sp-join-details')?.classList.add('hidden');
    document.getElementById('sp-join-confirm')?.classList.add('hidden');
    document.getElementById('sp-join-peek')?.classList.remove('hidden');

    // Restore coop subtitle in case the solo-join path changed it
    const subEl = panel.querySelector('.sp-join-sub');
    if (subEl) subEl.textContent = 'جلسة عمل جارية';

    // Fetch live session data
    get(ref(database, spPath(`live/${hostId}`))).then(snap => {
        const data = snap.val();
        if (!data) return;
        gameState.sharedPomo.joinDetails = data;

        // Render avatars
        const avEl = document.getElementById('sp-join-avatars');
        if (avEl) {
            const parts = Object.values(data.participants || {});
            avEl.innerHTML = parts.slice(0, 4).map(p =>
                `<div class="sp-join-av">${p.avatar ? `<img src="${p.avatar}" alt="">` : (p.username||'?').charAt(0).toUpperCase()}</div>`
            ).join('');
        }

        // Title = names
        const titleEl = document.getElementById('sp-join-title');
        if (titleEl) {
            const names = Object.values(data.participants || {}).map(p => p.username).join(' & ');
            titleEl.textContent = names;
        }
    });

    panel.classList.remove('hidden');

    // Wire buttons (clone to prevent stacking)
    ['sp-join-peek', 'sp-join-confirm', 'sp-join-cancel'].forEach(id => {
        const btn = document.getElementById(id);
        if (!btn) return;
        const fresh = btn.cloneNode(true);
        btn.replaceWith(fresh);
    });

    document.getElementById('sp-join-peek')?.addEventListener('click', () => {
        const data = gameState.sharedPomo.joinDetails;
        if (!data) return;
        const timerEl = document.getElementById('sp-join-timer');
        const breakEl = document.getElementById('sp-join-break');
        const sessEl  = document.getElementById('sp-join-sess');
        const isFreeMode = !!data.freePhase;
        if (isFreeMode) {
            const elapsed = data.freeStartTime ? Date.now() - data.freeStartTime : 0;
            if (timerEl) timerEl.textContent = formatTime(elapsed / 1000);
            if (breakEl) breakEl.textContent = 'وضع حر';
            if (sessEl)  sessEl.textContent  = '∞';
        } else {
            const remaining = Math.max(0, data.endTime - Date.now());
            const mm = String(Math.floor(remaining / 60000)).padStart(2,'0');
            const ss = String(Math.floor((remaining % 60000) / 1000)).padStart(2,'0');
            if (timerEl) timerEl.textContent = `${mm}:${ss}`;
            if (breakEl) breakEl.textContent = `${data.breakDuration} د`;
            if (sessEl)  sessEl.textContent  = data.sessionsLeft || '—';
        }
        document.getElementById('sp-join-details')?.classList.remove('hidden');
        document.getElementById('sp-join-confirm')?.classList.remove('hidden');
        document.getElementById('sp-join-peek')?.classList.add('hidden');
    });

    document.getElementById('sp-join-confirm')?.addEventListener('click', confirmJoinCoopSession);

    document.getElementById('sp-join-cancel')?.addEventListener('click', () => {
        document.getElementById('sp-join-panel')?.classList.add('hidden');
        gameState.sharedPomo.nearbyCoopId = '';
        gameState.sharedPomo.joinDetails  = null;
    });
}

function confirmJoinCoopSession() {
    const sp = gameState.sharedPomo;
    const data = sp.joinDetails;
    if (!data) return;
    // Never join while already in a session (the panel may have lingered).
    if (gameState.pomodoro.active || gameState.freeMode.active || sp.phase !== 'idle') {
        document.getElementById('sp-join-panel')?.classList.add('hidden');
        return;
    }

    document.getElementById('sp-join-panel')?.classList.add('hidden');

    const local = gameState.players[gameState.userId];
    if (!local) return;

    // Add ourselves to local group tracking
    sp.phase = 'active';
    sp.isHost = false;
    sp.sessionId = data.hostId;
    const existingUids = Object.keys(data.participants || {});
    if (!existingUids.includes(gameState.userId)) existingUids.push(gameState.userId);
    sp.activeGroupMembers = existingUids.sort();
    sp.coopAnim.members = {};
    sp.coopAnim.emojiFloats = [];

    // ── Free mode shared session join ─────────────────────────────────────────
    if (data.freePhase) {
        // startFreeMode(null, true) will find nearest free laptop and do kidnap animation
        startFreeMode(null, true);
        update(ref(database), {
            [spPath(`live/${data.hostId}/participants/${gameState.userId}`)]: {
                username: local.username, avatar: local.avatar || null,
            }
        });
        setupSpLiveListener(data.hostId);
        showSpInfoToast('انضممت للجلسة!');
        return;
    }

    const laptop = gameState.laptops.find(l => l.id === data.hostLaptopId);
    if (!laptop) { showSpInfoToast('تعذر الدخول — اللابتوب غير متاح'); return; }

    // Teleport to host's laptop sit point (coop animation handles visual spread)
    teleportEntity(local, laptop.sitX, laptop.sitY);
    updatePlayerPosition(laptop.sitX, laptop.sitY);
    gameState.isLockedIn = true;

    // Set pomo state using remaining time
    gameState.pomodoro.active        = true;
    gameState.pomodoro.laptopId      = laptop.id;
    gameState.pomodoro.workDuration  = data.workDuration;
    gameState.pomodoro.breakDuration = data.breakDuration;
    gameState.pomodoro.sessionsLeft  = data.sessionsLeft;
    gameState.pomodoro.totalSessions = data.sessionsLeft;
    gameState.pomodoro.createdAt     = Date.now();
    gameState.pomodoro.phase         = 'work';
    gameState.pomodoro.endTime       = data.endTime;
    gameState.pomodoro.transitioning = false;

    // Write ourselves into the live doc so host + others see the update
    update(ref(database), {
        [spPath(`live/${data.hostId}/participants/${gameState.userId}`)]: {
            username: local.username, avatar: local.avatar || null,
        }
    });

    // Show focus UI (same as normal pomo start)
    const focusPanel = document.getElementById('focus-sounds-panel');
    const taskPanel  = document.getElementById('current-task-panel');
    if (focusPanel) focusPanel.classList.add('active');
    if (taskPanel)  taskPanel.classList.add('active');
    setMobileFocusMode(true);

    // Listen for further participant changes (more late joiners)
    setupSpLiveListener(data.hostId);

    showSpInfoToast('انضممت للجلسة!');
}

// ── Solo-to-shared join flow ──────────────────────────────────────────────────

function showSoloJoinPanel(hostId) {
    const sp = gameState.sharedPomo;
    const panel = document.getElementById('sp-join-panel');
    if (!panel) return;
    const hostPlayer = gameState.players[hostId];
    const laptop = gameState.laptops.find(l => l.claimedBy === hostId && (l.phase === 'work' || l.phase === 'break'));
    if (!laptop || !hostPlayer) return;

    sp.joinDetails = { hostId, isSolo: true };

    // Reset panel to peek state
    document.getElementById('sp-join-details')?.classList.add('hidden');
    document.getElementById('sp-join-confirm')?.classList.add('hidden');
    document.getElementById('sp-join-peek')?.classList.remove('hidden');

    // Host avatar + name
    const avEl = document.getElementById('sp-join-avatars');
    if (avEl) avEl.innerHTML = `<div class="sp-join-av">${hostPlayer.avatar ? `<img src="${hostPlayer.avatar}" alt="">` : (hostPlayer.username||'?').charAt(0).toUpperCase()}</div>`;
    const titleEl = document.getElementById('sp-join-title');
    if (titleEl) titleEl.textContent = hostPlayer.username;
    const subEl = panel.querySelector('.sp-join-sub');
    if (subEl) subEl.textContent = 'يعمل بمفرده';

    panel.classList.remove('hidden');

    // Wire buttons (clone to prevent stacking)
    ['sp-join-peek', 'sp-join-confirm', 'sp-join-cancel'].forEach(id => {
        const btn = document.getElementById(id);
        if (!btn) return;
        const fresh = btn.cloneNode(true);
        btn.replaceWith(fresh);
    });

    document.getElementById('sp-join-peek')?.addEventListener('click', () => {
        const remaining = Math.max(0, laptop.endTime - Date.now());
        const mm = String(Math.floor(remaining / 60000)).padStart(2,'0');
        const ss = String(Math.floor((remaining % 60000) / 1000)).padStart(2,'0');
        const timerEl = document.getElementById('sp-join-timer');
        const breakEl = document.getElementById('sp-join-break');
        const sessEl  = document.getElementById('sp-join-sess');
        if (timerEl) timerEl.textContent = `${mm}:${ss}`;
        if (breakEl) breakEl.textContent = `${laptop.breakDuration || '?'} د`;
        if (sessEl)  sessEl.textContent  = laptop.sessionsLeft || '—';
        document.getElementById('sp-join-details')?.classList.remove('hidden');
        document.getElementById('sp-join-confirm')?.classList.remove('hidden');
        document.getElementById('sp-join-peek')?.classList.add('hidden');
    });

    document.getElementById('sp-join-confirm')?.addEventListener('click', confirmJoinSoloSession);

    document.getElementById('sp-join-cancel')?.addEventListener('click', () => {
        document.getElementById('sp-join-panel')?.classList.add('hidden');
        const sub2 = document.querySelector('.sp-join-sub');
        if (sub2) sub2.textContent = 'جلسة عمل جارية';
        sp.nearbySoloId = '';
        sp.joinDetails  = null;
    });
}

function confirmJoinSoloSession() {
    const sp = gameState.sharedPomo;
    const data = sp.joinDetails;
    if (!data?.isSolo) return;
    // Never join while already in a session (the panel may have lingered).
    if (gameState.pomodoro.active || gameState.freeMode.active || sp.phase !== 'idle') {
        document.getElementById('sp-join-panel')?.classList.add('hidden');
        return;
    }

    document.getElementById('sp-join-panel')?.classList.add('hidden');
    const sub = document.querySelector('.sp-join-sub');
    if (sub) sub.textContent = 'جلسة عمل جارية';

    const hostId = data.hostId;
    const laptop = gameState.laptops.find(l => l.claimedBy === hostId);
    if (!laptop) { showSpInfoToast('تعذر الدخول — اللابتوب غير متاح'); return; }

    const hostPlayer = gameState.players[hostId];
    const local = gameState.players[gameState.userId];
    if (!local || !hostPlayer) return;

    // Write live doc — triggers host's upgrade listener
    const liveDoc = {
        hostId,
        hostName: hostPlayer.username,
        hostLaptopId: laptop.id,
        endTime: laptop.endTime,
        workDuration: laptop.workDuration,
        breakDuration: laptop.breakDuration || 5,
        sessionsLeft: laptop.sessionsLeft || 1,
        participants: {
            [hostId]:           { username: hostPlayer.username, avatar: hostPlayer.avatar || null },
            [gameState.userId]: { username: local.username,      avatar: local.avatar      || null },
        },
    };
    update(ref(database), { [spPath(`live/${hostId}`)]: liveDoc });

    // Local shared-pomo state
    sp.phase = 'active';
    sp.isHost = false;
    sp.sessionId = hostId;
    sp.activeGroupMembers = [hostId, gameState.userId].sort();
    sp.coopAnim.members = {};
    sp.coopAnim.emojiFloats = [];
    for (const uid of sp.activeGroupMembers) {
        sp.coopAnim.members[uid] = {
            state: 'idle', stateTimer: 60 + Math.random() * 100, stateProgress: 0,
            orbitAngle: Math.random() * Math.PI * 2,
            dxBlend: 0, dyBlend: 0, scaleXBlend: 1, scaleYBlend: 1, angleBlend: 0,
        };
    }

    // Teleport to host's laptop
    teleportEntity(local, laptop.sitX, laptop.sitY);
    updatePlayerPosition(laptop.sitX, laptop.sitY);
    gameState.isLockedIn = true;

    // Sync local pomo to host's timer (don't recalculate endTime — use host's)
    gameState.pomodoro.active        = true;
    gameState.pomodoro.laptopId      = laptop.id;
    gameState.pomodoro.workDuration  = laptop.workDuration;
    gameState.pomodoro.breakDuration = laptop.breakDuration || 5;
    gameState.pomodoro.sessionsLeft  = laptop.sessionsLeft  || 1;
    gameState.pomodoro.totalSessions = laptop.totalSessions || laptop.sessionsLeft || 1;
    gameState.pomodoro.phase         = laptop.phase || 'work';
    gameState.pomodoro.endTime       = laptop.endTime;
    gameState.pomodoro.transitioning = false;

    // Show focus UI
    document.getElementById('focus-sounds-panel')?.classList.add('active');
    document.getElementById('current-task-panel')?.classList.add('active');
    setMobileFocusMode(true);

    // Start audio if joining mid-work
    if (laptop.phase !== 'break' && gameState.focusAudioEngine) {
        gameState.focusAudioEngine.fadeToMaster(1.0, 1.5);
        for (const [name, cfg] of Object.entries(gameState.focusAudioEngine.sounds)) {
            if (cfg.active) gameState.focusAudioEngine.startSound(name);
        }
    }

    setupSpLiveListener(hostId);
    showSpInfoToast('انضممت للجلسة!');
}

// Called when a solo pomo starts — watches for anyone writing a live doc (= someone joining us)
function setupSoloUpgradeListener() {
    const sp = gameState.sharedPomo;
    if (sp.unsubSoloUpgrade) { sp.unsubSoloUpgrade(); sp.unsubSoloUpgrade = null; }

    sp.unsubSoloUpgrade = onValue(ref(database, spPath(`live/${gameState.userId}`)), snap => {
        const data = snap.val();
        if (!data) return;                              // doc deleted / doesn't exist yet
        if (sp.phase !== 'idle') return;               // already in a session
        if (!gameState.pomodoro.active) return;        // pomo ended before anyone joined

        const uids = Object.keys(data.participants || {});
        if (uids.length < 2) return;                   // need at least host + 1 guest

        // Upgrade from solo → shared
        sp.phase = 'active';
        sp.isHost = true;
        sp.sessionId = gameState.userId;
        sp.activeGroupMembers = [...uids].sort();
        sp.coopAnim.members = {};
        sp.coopAnim.emojiFloats = [];
        for (const uid of sp.activeGroupMembers) {
            sp.coopAnim.members[uid] = {
                state: 'idle', stateTimer: 60 + Math.random() * 100, stateProgress: 0,
                orbitAngle: Math.random() * Math.PI * 2,
                dxBlend: 0, dyBlend: 0, scaleXBlend: 1, scaleYBlend: 1, angleBlend: 0,
            };
        }

        // Stop solo listener, hand off to proper live listener
        if (sp.unsubSoloUpgrade) { sp.unsubSoloUpgrade(); sp.unsubSoloUpgrade = null; }
        setupSpLiveListener(gameState.userId);

        // coopHostId written to Firebase on the next writePlayerState tick
        const joinerUid  = uids.find(uid => uid !== gameState.userId);
        const joinerName = joinerUid ? data.participants[joinerUid]?.username : null;
        showSpInfoToast(`${joinerName || '?'} انضم إليك! 🎉`);
    });
}

// ── Invite flow ───────────────────────────────────────────────────────────────

function sendSpInvite(targetUid) {
    const sp = gameState.sharedPomo;
    const local = gameState.players[gameState.userId];
    if (!local) return;
    // Guard: don't re-invite someone already pending
    if (sp.session?.participants?.[targetUid]) return;

    const sessionId = gameState.userId;

    if (sp.phase === 'idle') {
        sp.phase     = 'gathering';
        sp.isHost    = true;
        sp.sessionId = sessionId;
        const sessionData = {
            hostId: gameState.userId, hostName: local.username,
            hostAvatar: local.avatar || null, phase: 'gathering',
            participants: {
                [gameState.userId]: { username: local.username, avatar: local.avatar || null, status: 'ready' }
            }
        };
        update(ref(database), { [spPath(`sessions/${sessionId}`)]: sessionData });
        setupSpSessionListener(sessionId);
        setupSpGatherPanel();
    }

    const target = gameState.players[targetUid];
    const invite = { fromId: gameState.userId, fromName: local.username,
        fromAvatar: local.avatar || null, sessionId, sentAt: serverNow() };
    update(ref(database), {
        [spPath(`invites/${targetUid}`)]: invite,
        [spPath(`sessions/${sessionId}/participants/${targetUid}`)]: {
            username: target?.username || '', avatar: target?.avatar || null, status: 'invited'
        }
    });

    // Auto-expire invite
    setTimeout(() => {
        const part = gameState.sharedPomo.session?.participants?.[targetUid];
        if (part?.status === 'invited') {
            update(ref(database), {
                [spPath(`invites/${targetUid}`)]: null,
                [spPath(`sessions/${sessionId}/participants/${targetUid}`)]: null
            });
        }
    }, SP_INVITE_TTL + 500);
}

function acceptSpInvite() {
    const sp = gameState.sharedPomo;
    const invite = sp.pendingInvite;
    if (!invite) return;
    if (gameState.azkar?.active) closeAzkarOverlay(false);
    hideSpToast();

    // Guest hears accepted sound immediately
    if (gameState.focusAudioEngine) gameState.focusAudioEngine.playEffect('inviteAccepted');

    // If we were hosting a gathering, cleanly cancel it first
    if (sp.isHost && sp.sessionId && sp.phase === 'gathering') {
        update(ref(database), { [spPath(`sessions/${sp.sessionId}`)]: null });
        document.getElementById('sp-gather')?.classList.add('hidden');
        if (sp.unsubSession) { sp.unsubSession(); sp.unsubSession = null; }
        if (sp.unsubLive)    { sp.unsubLive();    sp.unsubLive    = null; }
        sp.session = null; sp.sessionId = null; sp.isHost = false;
        sp.nearbyPlayerIds = '';
    }

    sp.phase     = 'guest-waiting';
    sp.isHost    = false;
    sp.sessionId = invite.sessionId;

    // Teleport to near host
    const host = gameState.players[invite.fromId];
    const local = gameState.players[gameState.userId];
    if (host && local) {
        const offsetX = local.x < host.x ? -90 : 90;
        teleportEntity(local, host.x + offsetX, host.y);
        updatePlayerPosition(host.x + offsetX, host.y);
    }
    gameState.isLockedIn = true;

    update(ref(database), {
        [spPath(`sessions/${invite.sessionId}/participants/${gameState.userId}/status`)]: 'ready',
        [spPath(`invites/${gameState.userId}`)]: null
    });
    sp.pendingInvite = null;

    setupSpSessionListener(invite.sessionId);
    showSpWaitPanel({ hostName: invite.fromName, hostAvatar: invite.fromAvatar });
}

function declineSpInvite() {
    const sp = gameState.sharedPomo;
    const invite = sp.pendingInvite;
    hideSpToast();
    if (invite) update(ref(database), {
        [spPath(`invites/${gameState.userId}`)]: null,
        [spPath(`sessions/${invite.sessionId}/participants/${gameState.userId}`)]: null
    });
    sp.pendingInvite = null;
}

// ── Gathering panel (host) ────────────────────────────────────────────────────

function setupSpGatherPanel() {
    const panel = document.getElementById('sp-gather');
    if (!panel) return;
    panel.classList.remove('hidden');

    // Populate host avatar
    const local = gameState.players[gameState.userId];
    const hostAvEl = document.getElementById('sp-gather-host-av');
    if (hostAvEl && local) {
        hostAvEl.innerHTML = local.avatar
            ? `<img src="${local.avatar}" alt="">`
            : (local.username || '?').charAt(0).toUpperCase();
    }

    renderSpGatherPanel(gameState.sharedPomo.session || { participants: {} });

    // Config option buttons — clicking a preset clears the custom input
    ['sp-cfg-work-opts','sp-cfg-break-opts','sp-cfg-sess-opts'].forEach(id => {
        const container = document.getElementById(id);
        if (!container) return;
        const btns = container.querySelectorAll('.sp-opt');
        const inp  = container.querySelector('.sp-cfg-input');
        btns.forEach(btn => {
            btn.addEventListener('click', () => {
                btns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                if (inp) inp.value = '';
            });
        });
        // Typing in custom input deselects presets; clearing it restores first preset
        if (inp) {
            inp.addEventListener('input', () => {
                if (inp.value) {
                    btns.forEach(b => b.classList.remove('active'));
                } else {
                    btns[0]?.classList.add('active');
                }
            });
        }
    });

    // Start button — clone to avoid stacked listeners
    const startBtn = document.getElementById('sp-start-btn');
    if (startBtn) {
        const fresh = startBtn.cloneNode(true);
        startBtn.replaceWith(fresh);
        fresh.addEventListener('click', () => { if (!fresh.disabled) startSharedPomoSession(); });
    }
    // Cancel
    const cancelBtn = document.getElementById('sp-gather-cancel');
    if (cancelBtn) {
        const fresh = cancelBtn.cloneNode(true);
        cancelBtn.replaceWith(fresh);
        fresh.addEventListener('click', cancelSharedPomo);
    }
}

function renderSpGatherPanel(session) {
    const membersEl = document.getElementById('sp-gather-members');
    if (!membersEl) return;
    const parts = Object.entries(session.participants || {}).filter(([uid]) => uid !== gameState.userId);

    // ── Diff-based DOM update (enables enter/leave animations) ──
    // Snapshot existing chips
    const existingChips = {};
    membersEl.querySelectorAll('.sp-member-chip[data-uid]').forEach(c => {
        existingChips[c.dataset.uid] = c;
    });
    const currentUids = new Set(parts.map(([uid]) => uid));

    // Mark chips that are leaving — fade out then remove
    for (const [uid, chip] of Object.entries(existingChips)) {
        if (!currentUids.has(uid)) {
            chip.classList.add('sp-chip-leaving');
            setTimeout(() => { if (chip.parentNode) chip.remove(); updateEmptyHint(); }, 320);
        }
    }

    // Add or update chips that are present
    for (const [uid, p] of parts) {
        const ready = p.status === 'ready';
        const av = p.avatar ? `<img src="${p.avatar}" alt="">` : (p.username||'?').charAt(0).toUpperCase();

        if (existingChips[uid]) {
            // Update status classes on existing chip
            const chip = existingChips[uid];
            const wasPending = chip.classList.contains('sp-chip-pending');
            chip.classList.toggle('sp-chip-pending', !ready);
            chip.querySelector('.sp-member-av')?.classList.toggle('sp-av-ready', ready);
            chip.querySelector('.sp-member-dot')?.classList.toggle('sp-dot-ready', ready);
            // Host hears accepted sound when a guest transitions from pending → ready
            if (wasPending && ready && gameState.focusAudioEngine) {
                gameState.focusAudioEngine.playEffect('inviteAccepted');
            }
        } else {
            // New chip — enter animation
            const chip = document.createElement('div');
            chip.className = `sp-member-chip sp-chip-entering${ready ? '' : ' sp-chip-pending'}`;
            chip.dataset.uid = uid;
            chip.innerHTML = `<div class="sp-member-av${ready?' sp-av-ready':''}">${av}</div>
                <span class="sp-member-name">${p.username||''}</span>
                <div class="sp-member-dot${ready?' sp-dot-ready':''}"></div>`;
            membersEl.appendChild(chip);
            // Trigger enter animation next frame
            requestAnimationFrame(() => requestAnimationFrame(() => chip.classList.remove('sp-chip-entering')));
        }
    }

    function updateEmptyHint() {
        const hasAny = membersEl.querySelectorAll('.sp-member-chip:not(.sp-chip-leaving)').length > 0;
        let hint = membersEl.querySelector('.sp-empty-hint');
        if (!hasAny && !hint) {
            hint = document.createElement('span');
            hint.className = 'sp-empty-hint';
            hint.textContent = 'في انتظار القبول…';
            membersEl.appendChild(hint);
        } else if (hasAny && hint) {
            hint.remove();
        }
    }
    updateEmptyHint();

    // Update start / free-mode buttons
    const startBtn = document.getElementById('sp-start-btn');
    const hasReady = parts.some(([, p]) => p.status === 'ready');
    if (startBtn) {
        startBtn.disabled = !hasReady;
        startBtn.textContent = hasReady ? 'نحن لها 🚀' : 'انتظر المشاركين…';
    }
}

// ── Guest waiting panel ───────────────────────────────────────────────────────

function showSpWaitPanel(hostInfo) {
    const panel = document.getElementById('sp-guest-wait');
    if (!panel) return;
    const avEl   = document.getElementById('sp-wait-host-av');
    const nameEl = document.getElementById('sp-wait-host-name');
    if (avEl) avEl.innerHTML = hostInfo.hostAvatar
        ? `<img src="${hostInfo.hostAvatar}" alt="">`
        : (hostInfo.hostName||'?').charAt(0).toUpperCase();
    if (nameEl) nameEl.textContent = hostInfo.hostName || '';
    panel.classList.remove('hidden');
}

// ── Start / launch ────────────────────────────────────────────────────────────

function spGetCfgVal(optsId, inputId, def) {
    const inp = document.getElementById(inputId);
    if (inp?.value) { const v = parseInt(inp.value); if (v > 0) return v; }
    const active = document.getElementById(optsId)?.querySelector('.sp-opt.active');
    return active ? parseInt(active.dataset.val) : def;
}

function startSharedPomoSession() {
    const sp = gameState.sharedPomo;
    if (!sp.isHost || !sp.sessionId) return;
    const workMins  = spGetCfgVal('sp-cfg-work-opts',  'sp-cfg-work',  25);
    const breakMins = spGetCfgVal('sp-cfg-break-opts', 'sp-cfg-break', 5);
    const sessions  = spGetCfgVal('sp-cfg-sess-opts',  'sp-cfg-sess',   1);
    const startTime = serverNow();
    const endTime   = startTime + workMins * 60000;

    // Find host's nearest free laptop now so all clients know which laptop to gather at
    const local = gameState.players[gameState.userId];
    let hostLaptopId = null;
    if (local) {
        let best = Infinity;
        for (const l of gameState.laptops) {
            if (l.claimedBy) continue;
            const d = (l.x - local.x) ** 2 + (l.y - local.y) ** 2;
            if (d < best) { best = d; hostLaptopId = l.id; }
        }
    }

    update(ref(database), {
        [spPath(`sessions/${sp.sessionId}/phase`)]:         'active',
        [spPath(`sessions/${sp.sessionId}/workDuration`)]:  workMins,
        [spPath(`sessions/${sp.sessionId}/breakDuration`)]: breakMins,
        [spPath(`sessions/${sp.sessionId}/sessionsLeft`)]:  sessions,
        [spPath(`sessions/${sp.sessionId}/totalSessions`)]: sessions,
        [spPath(`sessions/${sp.sessionId}/startTime`)]:     startTime,
        [spPath(`sessions/${sp.sessionId}/endTime`)]:       endTime,
        [spPath(`sessions/${sp.sessionId}/hostLaptopId`)]:  hostLaptopId,
    });
    document.getElementById('sp-gather')?.classList.add('hidden');
}

function launchSharedPomoWork(session) {
    const sp = gameState.sharedPomo;
    sp.phase = 'active';

    // Snapshot group members for canvas indicators, then unsubscribe.
    // Sort so home-position indices are identical on every client regardless of
    // Firebase key return order (which is lexicographic, not insertion order).
    sp.activeGroupMembers = Object.keys(session.participants || {}).sort();
    // Reset coop animation state for new session
    sp.coopAnim.members = {};
    sp.coopAnim.emojiFloats = [];
    sp.coopAnim.syncBobPhase = 0;
    sp.coopAnim.swapTimer = 0;
    if (sp.unsubSession) { sp.unsubSession(); sp.unsubSession = null; }

    // Hide all shared pomo panels
    document.getElementById('sp-gather')?.classList.add('hidden');
    document.getElementById('sp-guest-wait')?.classList.add('hidden');
    gameState.isLockedIn = false;

    if (gameState.pomodoro.active || gameState.freeMode.active) return; // already in a session

    // All participants share the host's laptop
    const laptop = gameState.laptops.find(l => l.id === session.hostLaptopId);
    if (!laptop) return; // host laptop not found — edge case

    // ── Free mode shared session ──────────────────────────────────────────────
    if (session.mode === 'free') {
        // Guests no longer join shared free mode sessions (feature removed — too unstable).
        // Only the host enters free mode from this path.
        if (!sp.isHost) return;
        const hostId = session.hostId || sp.sessionId;
        startFreeMode(laptop.id, false); // solo free mode only
        // Clean up the gather session doc
        setTimeout(() => {
            update(ref(database), { [spPath(`sessions/${sp.sessionId}`)]: null });
        }, 3000);
        cleanupSpLocal(false); // clear shared pomo state, keep pomo unaffected
        return;
    }

    const isHost = sp.isHost;

    if (isHost) {
        // Host: claim the laptop and do kidnap animation
        gameState.pomodoro.active        = true;
        gameState.pomodoro.laptopId      = laptop.id;
        gameState.pomodoro.phase         = 'wait';
        gameState.pomodoro.workDuration  = session.workDuration;
        gameState.pomodoro.breakDuration = session.breakDuration;
        gameState.pomodoro.sessionsLeft  = session.sessionsLeft;
        gameState.pomodoro.totalSessions = session.totalSessions;
        gameState.pomodoro.createdAt     = Date.now();
        sp.agreedEndTime                 = session.endTime;

        update(ref(database), { [lobbyPath(`pomodoro/${laptop.id}`)]: {
            claimedBy: gameState.userId, phase: 'wait', endTime: 0,
            workDuration: session.workDuration, breakDuration: session.breakDuration,
            sessionsLeft: session.sessionsLeft, totalSessions: session.totalSessions,
            createdAt: Date.now()
        }});

        onDisconnect(ref(database, lobbyPath(`pomodoro/${laptop.id}`))).remove();

        // Write a "live" doc so nearby players can see the session and request to join
        const liveData = {
            hostId: gameState.userId,
            hostName: gameState.players[gameState.userId]?.username || '',
            hostLaptopId: laptop.id,
            endTime: session.endTime,
            workDuration: session.workDuration,
            breakDuration: session.breakDuration,
            sessionsLeft: session.sessionsLeft,
            participants: Object.fromEntries(
                Object.entries(session.participants || {}).map(([uid, p]) => [uid, { username: p.username, avatar: p.avatar || null }])
            ),
        };
        update(ref(database), { [spPath(`live/${sp.sessionId}`)]: liveData });
        onDisconnect(ref(database, spPath(`live/${sp.sessionId}`))).remove();

        // Start kidnap immediately — no countdown delay
        if (gameState.sharedPomo.phase === 'active') startKidnapAnimation(laptop);

        // Clean up shared session doc after everyone has had time to start
        setTimeout(() => {
            update(ref(database), { [spPath(`sessions/${sp.sessionId}`)]: null });
        }, 12000);

        // Listen to live doc so late joiners appear in our activeGroupMembers
        setupSpLiveListener(sp.sessionId);

    } else {
        // Guest: same kidnap animation as host — starts immediately
        if (gameState.sharedPomo.phase !== 'active') return;

        gameState.pomodoro.active        = true;
        gameState.pomodoro.laptopId      = laptop.id;
        gameState.pomodoro.phase         = 'wait';
        gameState.pomodoro.workDuration  = session.workDuration;
        gameState.pomodoro.breakDuration = session.breakDuration;
        gameState.pomodoro.sessionsLeft  = session.sessionsLeft;
        gameState.pomodoro.totalSessions = session.totalSessions;
        gameState.pomodoro.createdAt     = Date.now();
        sp.agreedEndTime                 = session.endTime;

        // Kidnap animation pulls guest to laptop — startPomodoroPhase fires at animation end
        startKidnapAnimation(laptop);

        // Remove participant entry from live doc if this tab closes mid-session
        const _guestHostId = session.hostId || sp.sessionId;
        onDisconnect(ref(database, spPath(`live/${_guestHostId}/participants/${gameState.userId}`))).remove();

        // Listen to live doc so late joiners appear in our activeGroupMembers
        setupSpLiveListener(_guestHostId);
    }
}

// ── Cancel / leave ────────────────────────────────────────────────────────────

function cancelSharedPomo() {
    const sp = gameState.sharedPomo;
    if (!sp.isHost || !sp.sessionId) return;
    update(ref(database), { [spPath(`sessions/${sp.sessionId}`)]: null });
    document.getElementById('sp-gather')?.classList.add('hidden');
    cleanupSpLocal();
}

function leaveSharedPomo() {
    const sp = gameState.sharedPomo;
    if (sp.sessionId) update(ref(database), {
        [spPath(`sessions/${sp.sessionId}/participants/${gameState.userId}`)]: null
    });
    gameState.isLockedIn = false;
    document.getElementById('sp-guest-wait')?.classList.add('hidden');
    cleanupSpLocal(true);
}

function onSpSessionCancelled() {
    gameState.isLockedIn = false;
    document.getElementById('sp-gather')?.classList.add('hidden');
    document.getElementById('sp-guest-wait')?.classList.add('hidden');
    showSpInfoToast('تم إلغاء الجلسة المشتركة');
    cleanupSpLocal();
}

function cleanupSpLocal(clearGroup = false) {
    const sp = gameState.sharedPomo;
    if (sp.unsubSession)     { sp.unsubSession();     sp.unsubSession     = null; }
    if (sp.unsubLive)        { sp.unsubLive();        sp.unsubLive        = null; }
    if (sp.unsubSoloUpgrade) { sp.unsubSoloUpgrade(); sp.unsubSoloUpgrade = null; }
    if (sp.isHost && sp.sessionId) {
        update(ref(database), { [spPath(`live/${sp.sessionId}`)]: null });
    }
    sp.session = null; sp.sessionId = null; sp.isHost = false;
    sp.phase = 'idle'; sp.agreedEndTime = 0;
    sp.nearbyPlayerIds = ''; // force panel re-render
    if (clearGroup) sp.activeGroupMembers = [];

    // Clear coop animation state so players stop spinning after session ends
    sp.coopAnim.members = {};
    sp.coopAnim.emojiFloats = [];
    sp.extCoopAnims = {};

    // Clear our own coopHostId in Firebase so others see we're no longer in a session
    if (gameState.userId) {
        update(ref(database), { [`users/${gameState.userId}/coopHostId`]: null });
    }

    document.getElementById('sp-coop-tasks')?.classList.add('hidden');
    document.getElementById('sp-join-panel')?.classList.add('hidden');
}

// Called when our live doc disappears (host left). Promotes a remaining guest to
// host or falls back to solo if everyone else is gone too.
function handleHostLeft() {
    const sp = gameState.sharedPomo;
    if (sp.phase !== 'active') return;

    const departedHostId = sp.sessionId;
    const remaining = sp.activeGroupMembers.filter(uid => uid !== departedHostId);
    delete sp.coopAnim.members[departedHostId];

    if (remaining.length < 2) {
        // We're alone — drop shared state but keep the pomo running
        sp.phase = 'idle';
        sp.sessionId = null;
        sp.isHost = false;
        sp.activeGroupMembers = [];
        sp.coopAnim.members = {};
        sp.coopAnim.emojiFloats = [];
        document.getElementById('sp-coop-tasks')?.classList.add('hidden');
        showSpInfoToast('المضيف غادر — تكمل بمفردك');
        return;
    }

    // All remaining guests sort the list the same way → same new host chosen everywhere
    const newHostId = [...remaining].sort()[0];
    sp.activeGroupMembers = remaining;

    if (newHostId === gameState.userId) {
        // Promote self — write a new live doc so new joiners can find us
        sp.isHost    = true;
        sp.sessionId = gameState.userId;

        // Clear stale solo-upgrade watcher if somehow still set
        if (sp.unsubSoloUpgrade) { sp.unsubSoloUpgrade(); sp.unsubSoloUpgrade = null; }

        const local = gameState.players[gameState.userId];
        const liveDoc = {
            hostId:       gameState.userId,
            hostName:     local?.username  || '',
            hostLaptopId: gameState.pomodoro.laptopId,
            endTime:      gameState.pomodoro.endTime,
            workDuration:  gameState.pomodoro.workDuration,
            breakDuration: gameState.pomodoro.breakDuration || 5,
            sessionsLeft:  gameState.pomodoro.sessionsLeft  || 1,
            participants: Object.fromEntries(
                remaining.map(uid => {
                    const p = gameState.players[uid];
                    return [uid, { username: p?.username || uid, avatar: p?.avatar || null }];
                })
            ),
        };
        update(ref(database), { [spPath(`live/${gameState.userId}`)]: liveDoc });
        onDisconnect(ref(database, spPath(`live/${gameState.userId}`))).remove();
        if (gameState.pomodoro.laptopId != null) {
            update(ref(database), { [lobbyPath(`pomodoro/${gameState.pomodoro.laptopId}`)]: {
                claimedBy:    gameState.userId,
                phase:        gameState.pomodoro.phase,
                endTime:      gameState.pomodoro.endTime,
                workDuration: gameState.pomodoro.workDuration,
                breakDuration: gameState.pomodoro.breakDuration || 5,
                sessionsLeft:  gameState.pomodoro.sessionsLeft  || 1,
                totalSessions: gameState.pomodoro.totalSessions || 1,
                createdAt:     gameState.pomodoro.createdAt || Date.now(),
            }});
            onDisconnect(ref(database, lobbyPath(`pomodoro/${gameState.pomodoro.laptopId}`))).remove();
        }
        setupSpLiveListener(gameState.userId);
        showSpInfoToast('أصبحت مضيف الجلسة');
    } else {
        // Re-point at the new host's live doc
        sp.isHost    = false;
        sp.sessionId = newHostId;
        setupSpLiveListener(newHostId);
    }
}

// Listen to the live doc so late joiners appear in all members' activeGroupMembers
function setupSpLiveListener(hostId) {
    const sp = gameState.sharedPomo;
    if (sp.unsubLive) { sp.unsubLive(); sp.unsubLive = null; }
    sp.unsubLive = onValue(ref(database, spPath(`live/${hostId}`)), snap => {
        const data = snap.val();
        if (!data) {
            // Live doc deleted — host may have left; hand off to remaining members
            if (sp.phase === 'active') handleHostLeft();
            return;
        }
        const uids = Object.keys(data.participants || {});
        if (!uids.length) return;
        const uidsSet = new Set(uids);

        // Remove members who left (no longer in live doc participants)
        let changed = false;
        sp.activeGroupMembers = sp.activeGroupMembers.filter(uid => {
            if (!uidsSet.has(uid)) {
                delete sp.coopAnim.members[uid]; // stop animating them
                changed = true;
                return false;
            }
            return true;
        });

        // Add any UIDs we don't know about yet (late joiners), then keep sorted
        for (const uid of uids) {
            if (!sp.activeGroupMembers.includes(uid)) {
                sp.activeGroupMembers.push(uid);
                changed = true;
            }
        }
        if (changed) sp.activeGroupMembers.sort();

        // Init animation state for newly discovered members
        if (changed) {
            const total = sp.activeGroupMembers.length;
            for (let i = 0; i < total; i++) {
                const uid = sp.activeGroupMembers[i];
                if (!sp.coopAnim.members[uid]) {
                    // Start late joiners directly at their grid slot so they don't
                    // slide in from the center over several seconds.
                    const { homeX, homeY } = _coopMemberHome(i, total);
                    sp.coopAnim.members[uid] = {
                        state: 'idle', stateTimer: 60 + Math.random() * 100, stateProgress: 0,
                        orbitAngle: Math.random() * Math.PI * 2,
                        dxBlend: homeX, dyBlend: homeY, scaleXBlend: 1, scaleYBlend: 1, angleBlend: 0,
                    };
                }
            }
        }

        // ── Phase timer sync for guests (break + subsequent work cycles) ─────
        // The host writes phaseEndTime + currentPhase to the live doc whenever
        // startPomodoroPhase fires. Guests read it here and correct drift, or
        // force-transition if the host has already moved to a different phase.
        if (!sp.isHost && sp.phase === 'active' && gameState.pomodoro.active && data.phaseEndTime) {
            const hostPhase = data.currentPhase; // 'work' | 'break' | undefined
            const guestPhase = gameState.pomodoro.phase;
            const drift = Math.abs(gameState.pomodoro.endTime - data.phaseEndTime);

            // Host switched to break but guest is still in work — force the transition
            // so the guest doesn't miss their break (root cause of the join-then-miss-break bug).
            if (hostPhase === 'break' && guestPhase === 'work' && !gameState.pomodoro.transitioning) {
                gameState.pomodoro.phase = 'break';
                gameState.pomodoro.endTime = data.phaseEndTime;
                gameState.pomodoro.transitioning = false;
                // Mirror the UI side-effects from startPomodoroPhase('break')
                gameState.isLockedIn = false;
                if (gameState.anim.active) {
                    gameState.anim.active = false; gameState.anim.phase = 'none'; gameState.anim.progress = 0;
                }
                const _breakPanel = document.getElementById('focus-sounds-panel');
                if (_breakPanel) {
                    gameState._drawerWasOpen = _breakPanel.classList.contains('drawer-open');
                    _breakPanel.classList.remove('active');
                }
                setMobileFocusMode(false);
                document.getElementById('prayer-panel')?.classList.add('break-compact');
            } else if (drift > 1500) {
                // Same phase — just correct the end time
                if (guestPhase === 'break' || guestPhase === 'work') {
                    gameState.pomodoro.endTime = data.phaseEndTime;
                } else if (guestPhase === 'wait') {
                    // Kidnap animation in progress — store for startPomodoroPhase to consume
                    sp.agreedEndTime = data.phaseEndTime;
                }
            }
        }

        // ── Free mode: sync session end ───────────────────────────────────────
        const fm = gameState.freeMode;
        if (fm.active && fm.isShared && !sp.isHost) {
            // Host ended the session — guests follow
            if (data.freePhase === 'ended') {
                endFreeMode(); return;
            }
        }
    });
}

// ── Free mode ────────────────────────────────────────────────────────────────

function startFreeMode(laptopId, isShared = false) {
    if (gameState.pomodoro.active || gameState.freeMode.active) return;

    let laptop = laptopId != null
        ? gameState.laptops.find(l => l.id === laptopId)
        : gameState.lastActiveLaptop;

    // If no specific laptop and lastActiveLaptop is gone, find nearest free one
    if (!laptop || (laptop.claimedBy && laptop.claimedBy !== gameState.userId)) {
        const local = gameState.players[gameState.userId];
        if (!local) return;
        let best = Infinity;
        for (const l of gameState.laptops) {
            if (l.claimedBy) continue;
            const d = (l.x - local.x) ** 2 + (l.y - local.y) ** 2;
            if (d < best) { best = d; laptop = l; }
        }
    }
    if (!laptop || (laptop.claimedBy && laptop.claimedBy !== gameState.userId)) return;

    const fm = gameState.freeMode;
    fm.active            = true;
    fm.laptopId          = laptop.id;
    fm.isShared          = isShared;
    fm.phase             = 'idle';
    fm.workStartTime     = 0;
    fm.totalWorkMs       = 0;
    fm.breakEndTime      = 0;
    fm.nextBreakPromptMs = 25 * 60 * 1000;
    fm.breakPromptShown  = false;
    fm.breakVotes        = {};
    fm.selectedBreakMins = 5;
    fm.workMsAtLastBreak = 0;
    fm._breakEndTimer    = null;
    fm._createdAt        = Date.now();

    update(ref(database), { [lobbyPath(`pomodoro/${laptop.id}`)]: {
        claimedBy:   gameState.userId,
        phase:       'free-work',
        mode:        'free',
        createdAt:   Date.now(),
        endTime:     0,
        totalWorkMs: 0,
        breakEndTime: 0,
        savedAt:     0,
    }});
    // On disconnect: free the laptop immediately (others see nothing — no AFK
    // ghost) and stash the session so it can be reclaimed within 4h on next login.
    if (gameState.isSirajGhost) {
        onDisconnect(ref(database, lobbyPath(`pomodoro/${laptop.id}`))).remove();
    } else {
        trackSessionForReclaim();
    }

    document.getElementById('pomodoro-modal')?.classList.remove('active');
    updatePomoLeaveBtn();
    startKidnapAnimation(laptop);
}

function _startFreeModeWork() {
    const fm = gameState.freeMode;
    fm.phase         = 'work';
    fm.workStartTime = Date.now();
    gameState.isLockedIn = true;

    document.getElementById('free-mode-panel')?.classList.remove('hidden');
    document.getElementById('pomodoro-large-timer')?.classList.add('hidden');
    document.getElementById('pomodoro-small-timer')?.classList.add('hidden');
    document.getElementById('focus-sounds-panel')?.classList.add('active');
    document.getElementById('current-task-panel')?.classList.add('active');
    setMobileFocusMode(true);
    updatePomoLeaveBtn();

    // Always restore master volume when entering work — fixes case where masterGain
    // was left at 0 from prayer overlay or previous session teardown
    if (gameState.focusAudioEngine) gameState.focusAudioEngine.fadeToMaster(1.0, 0.8);

    // Fade in and resume YouTube player (was faded out on break start)
    if (gameState.focusYTPlayer?.videoId) gameState.focusYTPlayer.fadeInAndResume(1500);
}

function saveFreeModStateToFirebase() {
    const fm = gameState.freeMode;
    if (!fm.active || fm.laptopId == null) return;
    let currentTotalMs = fm.totalWorkMs;
    if (fm.phase === 'work' && fm.workStartTime > 0) {
        currentTotalMs += Date.now() - fm.workStartTime;
    }
    fm._lastSavedAt = Date.now();

    // Write full doc so Firebase has the correct totalWorkMs on restore
    update(ref(database), { [lobbyPath(`pomodoro/${fm.laptopId}`)]: {
        claimedBy:    gameState.userId,
        phase:        fm.phase === 'break' ? 'free-break' : 'free-work',
        mode:         'free',
        createdAt:    fm._createdAt || Date.now(),
        endTime:      0,
        totalWorkMs:  currentTotalMs,
        breakEndTime: fm.phase === 'break' ? fm.breakEndTime : 0,
        savedAt:      Date.now(),
    }});

    // Refresh the reclaim stash (with current totalWorkMs) + re-arm the disconnect
    // handlers so a sudden disconnect frees the laptop and preserves progress.
    if (!gameState.isSirajGhost) trackSessionForReclaim();
}

function updateFreeMode() {
    const fm = gameState.freeMode;
    if (!fm.active) return;

    // On login restore, start work on the first frame of the game loop
    if (fm.needsResume) {
        fm.needsResume = false;
        _startFreeModeWork();
        return;
    }

    const timerEl = document.getElementById('free-timer-text');

    // Azkar overlay: freeze the count-up timer (and break countdown) while reading
    if (gameState.azkar.active) {
        if (fm.phase === 'work' && fm.workStartTime > 0) {
            fm.totalWorkMs  += Date.now() - fm.workStartTime;
            fm.workStartTime = 0;
        }
        if (fm.phase === 'break' && gameState.azkar.pausedFreeWorkSnap > 0) {
            fm.breakEndTime = Date.now() + gameState.azkar.pausedFreeWorkSnap;
        }
        return;
    }

    // Prayer overlay: freeze the count-up timer while praying
    if (gameState.prayer.isOverlayActive) {
        updatePrayerOverlayTimer(); // keep the dismiss-button countdown ticking
        if (fm.phase === 'work' && fm.workStartTime > 0) {
            // Snapshot accumulated ms so resuming later is seamless
            fm.totalWorkMs  += Date.now() - fm.workStartTime;
            fm.workStartTime = 0;
        }
        return;
    }

    // Resume after prayer dismissed
    if (fm.phase === 'work' && fm.workStartTime === 0) {
        fm.workStartTime = Date.now();
    }

    // Check prayer trigger (only if pomodoro isn't already handling it)
    if (!gameState.pomodoro.active && !gameState.prayer.isOverlayActive) checkPrayerTrigger();

    // Periodically persist totalWorkMs + RE-ARM the disconnect/reclaim handlers so
    // a sudden tab close is always caught. This runs during BREAK too (not just
    // work): the break used to arm the onDisconnect only once at break-start, so a
    // mid-break network blip that consumed that handler left the session
    // unreclaimable — and free mode has no cross-user stash fallback like pomo.
    // Re-saving every 15s also keeps `savedAt` fresh so a long break doesn't trip
    // the 1-hour free-mode expiry measured from break-start.
    const _fmTimerRunning = (fm.phase === 'work' && fm.workStartTime > 0) || fm.phase === 'break';
    if (_fmTimerRunning && Date.now() - fm._lastSavedAt > 15000) {
        saveFreeModStateToFirebase();
    }

    if (fm.phase === 'work') {
        const elapsedMs = fm.totalWorkMs + (Date.now() - fm.workStartTime);
        if (timerEl) timerEl.textContent = formatTime(elapsedMs / 1000);

        // Threshold is relative to work done SINCE the last break (not total session time)
        const msSinceLastBreak = elapsedMs - (fm.workMsAtLastBreak || 0);
        const threshold = gameState.isSirajGhost ? 10000 : fm.nextBreakPromptMs;
        if (!fm.breakPromptShown && msSinceLastBreak >= threshold) {
            fm.breakPromptShown = true;
            showFreeModeBreakPrompt();
        }
    } else if (fm.phase === 'break') {
        const remaining = Math.max(0, fm.breakEndTime - Date.now());
        const smallText = document.getElementById('small-timer-text');
        if (smallText) smallText.textContent = formatTime(remaining / 1000);
        if (remaining <= 0) endFreeModeBreak();
    }
}

function showFreeModeBreakPrompt() {
    const fm    = gameState.freeMode;
    const label = document.getElementById('free-prompt-label');
    const prompt = document.getElementById('free-break-prompt');
    if (!prompt) return;

    const totalMins = Math.floor((fm.totalWorkMs + (Date.now() - fm.workStartTime)) / 60000);
    if (label) label.textContent = `عملت ${formatDurationArabic(totalMins)} — هل تريد راحة؟`;

    prompt.classList.remove('hidden');
}

function startFreeModeBreak(durationMins) {
    const fm = gameState.freeMode;
    if (fm.phase !== 'work') return;

    fm.totalWorkMs        += Date.now() - fm.workStartTime;
    fm.workMsAtLastBreak   = fm.totalWorkMs;  // snapshot for next 25-min countdown
    fm.phase               = 'break';
    fm.breakEndTime        = Date.now() + durationMins * 60000;
    fm.breakPromptShown    = false;
    fm.nextBreakPromptMs   = 25 * 60 * 1000;

    saveFreeModStateToFirebase();
    gameState.isLockedIn = false;
    if (gameState.anim.active) { gameState.anim.active = false; gameState.anim.phase = 'none'; }

    document.getElementById('free-break-prompt')?.classList.add('hidden');
    document.getElementById('free-break-picker')?.classList.add('hidden');
    document.getElementById('free-mode-panel')?.classList.add('hidden');
    document.getElementById('focus-sounds-panel')?.classList.remove('active');
    document.getElementById('current-task-panel')?.classList.remove('active');
    setMobileFocusMode(false);

    // Show small استراحة timer (same as regular pomo break)
    const smallTimer = document.getElementById('pomodoro-small-timer');
    const smallText  = document.getElementById('small-timer-text');
    if (smallTimer) smallTimer.classList.remove('hidden');
    if (smallText)  smallText.textContent = formatTime(durationMins * 60);

    updatePomoLeaveBtn();

    // Fade out and pause YouTube player during break
    if (gameState.focusYTPlayer?.videoId) gameState.focusYTPlayer.fadeOutAndPause(1500);

    if (gameState.focusAudioEngine) {
        gameState.focusAudioEngine.playEffect('breakAdded');
        gameState.focusAudioEngine.fadeToMaster(0, 1.5);
    } else {
        playSoundRobust(gameState.sounds.breakAdded);
    }
}

function endFreeModeBreak() {
    const fm = gameState.freeMode;
    if (fm.phase !== 'break') return;

    // Set phase to idle — _startFreeModeWork() fires at kidnap animation end
    fm.phase        = 'idle';
    fm.breakEndTime = 0;

    // Exit any active minigame first
    if (gameState.race?.active)   returnFromRace(true);
    if (gameState.coffee?.active) returnFromCoffee(true);
    if (gameState.laptopBoss?.active) returnFromLaptopBoss(true);

    // Hide the small break timer
    document.getElementById('pomodoro-small-timer')?.classList.add('hidden');

    // Play TimeReturn sound (Web Audio — works in background tabs)
    if (gameState.focusAudioEngine) {
        gameState.focusAudioEngine.playEffect('timeReturn');
    } else {
        playSoundRobust(gameState.sounds.timeReturn);
    }

    const doKidnap = () => {
        fm._breakEndTimer = null;
        if (!fm.active || fm.phase !== 'idle') return; // session ended during wait
        const laptop = gameState.laptops.find(l => l.id === fm.laptopId);
        if (!laptop) { _startFreeModeWork(); return; }
        startKidnapAnimation(laptop);
        // _startFreeModeWork() fires automatically at animation end
        // (updateAnimation: freeMode.active && freeMode.phase === 'idle')
    };

    // Wait 2 seconds then grab — same pattern as pomo break-to-work
    fm._breakEndTimer = setTimeout(doKidnap, 2000);
}

function endFreeMode() {
    const fm = gameState.freeMode;
    if (!fm.active) return;

    // Cancel pending post-break kidnap if session ends during 2-second wait
    if (fm._breakEndTimer) { clearTimeout(fm._breakEndTimer); fm._breakEndTimer = null; }
    if (gameState.focusYTPlayer?.videoId) gameState.focusYTPlayer.fadeOutAndPause(1000);

    let totalMs = fm.totalWorkMs;
    if (fm.phase === 'work' && fm.workStartTime > 0) totalMs += Date.now() - fm.workStartTime;
    const totalMins = Math.floor(totalMs / 60000);

    if (fm.isShared && gameState.sharedPomo.isHost) {
        update(ref(database), { [spPath(`live/${gameState.sharedPomo.sessionId}/freePhase`)]: 'ended' });
    }

    if (fm.laptopId != null) {
        // Clean end — cancel the disconnect handlers + wipe the reclaim stash, then
        // free the laptop. (cancelSessionDisconnect also cancels the laptop remove.)
        cancelSessionDisconnect(true);
        onDisconnect(ref(database, lobbyPath(`pomodoro/${fm.laptopId}`))).cancel();
        update(ref(database), { [lobbyPath(`pomodoro/${fm.laptopId}`)]: null });
        const lp = gameState.laptops.find(l => l.id === fm.laptopId);
        if (lp) { lp.claimedBy = null; lp.phase = 'none'; }
    }

    if (fm.isShared) cleanupSpLocal(true);

    fm.active        = false;
    fm.laptopId      = null;
    fm.isShared      = false;
    fm.phase         = 'idle';
    fm.workStartTime = 0;
    fm.totalWorkMs   = 0;
    fm.breakEndTime  = 0;
    fm.breakPromptShown = false;

    gameState.isLockedIn  = false;
    gameState.anim.active = false;
    gameState.anim.phase  = 'none';

    document.getElementById('free-mode-panel')?.classList.add('hidden');
    document.getElementById('free-break-prompt')?.classList.add('hidden');
    document.getElementById('free-break-picker')?.classList.add('hidden');
    document.getElementById('free-votes-pill')?.classList.add('hidden');
    document.getElementById('focus-sounds-panel')?.classList.remove('active');
    document.getElementById('current-task-panel')?.classList.remove('active');
    document.getElementById('leave-wrap')?.classList.add('leave-wrap-hidden');
    document.getElementById('pomo-leave-confirm1')?.classList.add('pomo-leave-confirm-hidden');
    document.getElementById('pomo-leave-confirm2')?.classList.add('pomo-leave-confirm-hidden');
    document.getElementById('pomodoro-large-timer')?.classList.add('hidden');
    document.getElementById('pomodoro-small-timer')?.classList.add('hidden');
    setMobileFocusMode(false);

    if (gameState.focusAudioEngine) gameState.focusAudioEngine.fadeToMaster(0, 1.0);

    const local = gameState.players[gameState.userId];
    if (local && isInBreakRoom(local.y)) {
        const exitY = ROOM_SEAM_Y - 80;
        teleportEntity(local, local.x, exitY);
        updatePlayerPosition(local.x, exitY);
    } else {
        updatePlayerPosition(local?.x || 0, local?.y || 0);
    }

    showFreeModeSuccessModal(totalMins, getCurrentTaskText());
}

function showFreeModeSuccessModal(totalMins, taskText = '') {
    const modal = document.getElementById('success-modal');
    if (!modal) return;

    document.getElementById('success-total-time').textContent = formatDurationArabic(totalMins);

    const sessRow = document.getElementById('success-sessions-count')?.parentElement;
    if (sessRow) sessRow.style.display = 'none';

    const taskEl = document.getElementById('success-task');
    if (taskEl) {
        const cleanTask = taskText.trim();
        taskEl.textContent = cleanTask ? `عملت على ${cleanTask}` : '';
        taskEl.style.display = cleanTask ? 'block' : 'none';
    }

    const localPlayer = gameState.players[gameState.userId];
    const nameEl      = document.getElementById('success-name');
    const avatarImg   = document.getElementById('success-avatar-img');
    const avatarText  = document.getElementById('success-avatar-text');

    if (localPlayer) {
        if (nameEl) nameEl.textContent = localPlayer.username;
        if (localPlayer.avatar) {
            if (avatarImg)  { avatarImg.src = localPlayer.avatar; avatarImg.style.display = 'block'; }
            if (avatarText) avatarText.style.display = 'none';
        } else {
            if (avatarImg)  avatarImg.style.display = 'none';
            if (avatarText) { avatarText.style.display = 'block'; avatarText.textContent = (localPlayer.username || '?').charAt(0).toUpperCase(); }
        }
    }

    modal.classList.add('active');
    document.getElementById('success-close').onclick = () => {
        modal.classList.remove('active');
        if (sessRow) sessRow.style.display = '';
        if (taskEl) taskEl.style.display = 'none';
    };

    if (gameState.focusAudioEngine) {
        gameState.focusAudioEngine.playEffect('yipee');
    } else {
        playSoundRobust(gameState.sounds.yipee);
    }
}


function setupFreeModeUI() {
    const freeBtn = document.getElementById('free-mode-btn');
    if (freeBtn) {
        freeBtn.addEventListener('click', () => {
            document.getElementById('pomodoro-modal')?.classList.remove('active');
            startFreeMode(null, false);
        });
    }

    // Shared free mode join is disabled — hide the button entirely
    const spFreeBtn = document.getElementById('sp-free-btn');
    if (spFreeBtn) spFreeBtn.style.display = 'none';

    const openPicker = () => {
        const customInput = document.getElementById('fbp-custom');
        if (customInput) { customInput.value = ''; customInput.classList.remove('visible'); }
        document.querySelectorAll('.fbp-btn').forEach(b => b.classList.remove('active'));
        const defaultBtn = document.querySelector('.fbp-btn[data-val="5"]');
        if (defaultBtn) defaultBtn.classList.add('active');
        gameState.freeMode.selectedBreakMins = 5;
        document.getElementById('free-break-picker')?.classList.remove('hidden');
    };

    document.getElementById('free-break-yes-btn')?.addEventListener('click', () => {
        document.getElementById('free-break-prompt')?.classList.add('hidden');
        openPicker();
    });

    document.querySelectorAll('.fbp-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const customInput = document.getElementById('fbp-custom');
            document.querySelectorAll('.fbp-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            if (btn.dataset.val === 'custom') {
                if (customInput) { customInput.classList.add('visible'); customInput.focus(); }
                // keep selectedBreakMins at last value until user types
            } else {
                if (customInput) { customInput.value = ''; customInput.classList.remove('visible'); }
                gameState.freeMode.selectedBreakMins = parseInt(btn.dataset.val) || 5;
            }
        });
    });

    const customInput = document.getElementById('fbp-custom');
    if (customInput) {
        customInput.addEventListener('input', () => {
            const val = Math.min(15, Math.max(1, parseInt(customInput.value) || 0));
            const errEl = document.getElementById('fbp-max-error');
            if (customInput.value) {
                gameState.freeMode.selectedBreakMins = val;
                if (errEl) errEl.textContent = parseInt(customInput.value) > 15 ? 'الحد الأقصى ١٥ دقيقة' : '';
            } else {
                if (errEl) errEl.textContent = '';
            }
        });
        customInput.addEventListener('blur', () => {
            if (customInput.value) {
                const clamped = Math.min(15, Math.max(1, parseInt(customInput.value) || 1));
                customInput.value = clamped;
                gameState.freeMode.selectedBreakMins = clamped;
                const errEl = document.getElementById('fbp-max-error');
                if (errEl) errEl.textContent = '';
            }
        });
    }

    document.getElementById('fbp-back-btn')?.addEventListener('click', () => {
        document.getElementById('free-break-picker')?.classList.add('hidden');
        document.getElementById('free-break-prompt')?.classList.remove('hidden');
    });

    document.getElementById('free-break-go-btn')?.addEventListener('click', () => {
        startFreeModeBreak(gameState.freeMode.selectedBreakMins);
    });
}

function startSharedFreeModeSession() {
    const sp = gameState.sharedPomo;
    if (!sp.isHost || !sp.sessionId) return;

    const local = gameState.players[gameState.userId];
    let hostLaptopId = null;
    if (local) {
        let best = Infinity;
        for (const l of gameState.laptops) {
            if (l.claimedBy) continue;
            const d = (l.x - local.x) ** 2 + (l.y - local.y) ** 2;
            if (d < best) { best = d; hostLaptopId = l.id; }
        }
    }

    update(ref(database), {
        [spPath(`sessions/${sp.sessionId}/phase`)]:        'active',
        [spPath(`sessions/${sp.sessionId}/mode`)]:         'free',
        [spPath(`sessions/${sp.sessionId}/startTime`)]:    serverNow(),
        [spPath(`sessions/${sp.sessionId}/hostLaptopId`)]: hostLaptopId,
    });
    document.getElementById('sp-gather')?.classList.add('hidden');
}

// ── Toast (invite) ────────────────────────────────────────────────────────────

function showSpToast(invite) {
    const sp = gameState.sharedPomo;
    const toast = document.getElementById('sp-invite-toast');
    if (!toast) return;

    const avEl = document.getElementById('sp-toast-avatar');
    if (avEl) avEl.innerHTML = invite.fromAvatar
        ? `<img src="${invite.fromAvatar}" alt="">`
        : (invite.fromName||'?').charAt(0).toUpperCase();
    const nameEl = document.getElementById('sp-toast-name');
    if (nameEl) nameEl.textContent = invite.fromName || '';

    toast.classList.remove('hidden');

    // Invite notification sound — Web Audio so it works in background tabs
    if (gameState.focusAudioEngine) gameState.focusAudioEngine.playEffect('inviteSent');

    // Animate progress bar
    const bar = document.getElementById('sp-toast-bar');
    const elapsed0 = Date.now() - (invite.sentAt || Date.now());
    const remaining = Math.max(500, SP_INVITE_TTL - elapsed0);

    if (bar) bar.style.width = ((remaining / SP_INVITE_TTL) * 100) + '%';
    if (sp.toastInterval) clearInterval(sp.toastInterval);
    const start = Date.now();
    sp.toastInterval = setInterval(() => {
        const pct = Math.max(0, ((remaining - (Date.now() - start)) / remaining) * 100);
        if (bar) bar.style.width = pct + '%';
        if (pct <= 0) { clearInterval(sp.toastInterval); sp.toastInterval = null; hideSpToast(); }
    }, 100);

    if (sp.toastTimeout) clearTimeout(sp.toastTimeout);
    sp.toastTimeout = setTimeout(() => {
        hideSpToast();
        update(ref(database), { [spPath(`invites/${gameState.userId}`)]: null });
        sp.pendingInvite = null;
    }, remaining);

    // Wire buttons (clone to prevent stacking)
    ['sp-toast-yes','sp-toast-no'].forEach(id => {
        const btn = document.getElementById(id);
        if (!btn) return;
        const fresh = btn.cloneNode(true);
        btn.replaceWith(fresh);
        fresh.addEventListener('click', id === 'sp-toast-yes' ? acceptSpInvite : declineSpInvite);
    });

    // Watch the session doc — if host cancels before we accept, dismiss immediately
    if (sp.toastSessionUnsub) { sp.toastSessionUnsub(); sp.toastSessionUnsub = null; }
    sp.toastSessionUnsub = onValue(ref(database, spPath(`sessions/${invite.sessionId}`)), snap => {
        if (!snap.val() && sp.pendingInvite?.sessionId === invite.sessionId) {
            hideSpToast();
            update(ref(database), { [spPath(`invites/${gameState.userId}`)]: null });
            sp.pendingInvite = null;
            showSpInfoToast('المضيف الغى الجلسة المشتركة');
        }
    });
}

function hideSpToast() {
    const sp = gameState.sharedPomo;
    document.getElementById('sp-invite-toast')?.classList.add('hidden');
    if (sp.toastInterval)      { clearInterval(sp.toastInterval);  sp.toastInterval     = null; }
    if (sp.toastTimeout)       { clearTimeout(sp.toastTimeout);    sp.toastTimeout      = null; }
    if (sp.toastSessionUnsub)  { sp.toastSessionUnsub();           sp.toastSessionUnsub = null; }
}

function showSpInfoToast(message) {
    const el = document.createElement('div');
    el.className = 'sp-info-toast';
    el.textContent = message;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('sp-info-toast-show'));
    setTimeout(() => { el.classList.remove('sp-info-toast-show'); setTimeout(() => el.remove(), 350); }, 2500);
}

// ── Leave pomo ────────────────────────────────────────────────────────────────

function setupPomoLeaveBtn() {
    const wrap   = document.getElementById('leave-wrap');
    const btn    = document.getElementById('pomo-leave-btn');
    const c1     = document.getElementById('pomo-leave-confirm1');
    const c2     = document.getElementById('pomo-leave-confirm2');
    if (!wrap || !btn || !c1 || !c2) return;

    const HIDDEN = 'pomo-leave-confirm-hidden';
    let _autoReset = null;

    function resetToBtn() {
        if (_autoReset) { clearTimeout(_autoReset); _autoReset = null; }
        c1.classList.add(HIDDEN);
        c2.classList.add(HIDDEN);
    }

    function showConfirm1() {
        if (_autoReset) clearTimeout(_autoReset);
        c2.classList.add(HIDDEN);
        c1.classList.remove(HIDDEN);
        // Auto-dismiss if user doesn't act within 4 seconds
        _autoReset = setTimeout(resetToBtn, 4000);
    }

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        // Shared test mode: Siraj host can't end session unilaterally
        if (gameState.freeMode.active && gameState.freeMode.isShared && gameState.isSirajGhost) return;
        showConfirm1();
    });

    document.getElementById('plc1-yes').addEventListener('click', (e) => {
        e.stopPropagation();
        resetToBtn();
        if (gameState.freeMode.active) {
            endFreeMode();
        } else {
            // Pomodoro: second confirmation step
            if (_autoReset) clearTimeout(_autoReset);
            c2.classList.remove(HIDDEN);
            _autoReset = setTimeout(resetToBtn, 4000);
        }
    });
    document.getElementById('plc1-no').addEventListener('click', (e) => {
        e.stopPropagation();
        resetToBtn();
    });
    document.getElementById('plc2-yes').addEventListener('click', (e) => {
        e.stopPropagation();
        resetToBtn();
        exitPomoNow();
    });
    document.getElementById('plc2-no').addEventListener('click', (e) => {
        e.stopPropagation();
        resetToBtn();
    });

    // إنهاء الاستراحة — end the break early, no confirmation needed.
    document.getElementById('end-break-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        endBreakEarly();
    });
}

let _leaveBtnLastText = '';
let _leaveBtnLastVisible = null;

function updatePomoLeaveBtn() {
    const wrap = document.getElementById('leave-wrap');
    const btn  = document.getElementById('pomo-leave-btn');
    if (!wrap || !btn) return;

    let newText, shouldShow;
    if (gameState.freeMode.active) {
        newText    = 'انهاء الجلسة';
        // Wait for the kidnap animation to finish (locked-in) before showing — keeps
        // it in sync with focus sounds / task box instead of popping up on select.
        shouldShow = !!(gameState.isLockedIn || gameState.freeMode.phase === 'break');
    } else {
        newText    = 'مغادرة الجلسة';
        shouldShow = !!(gameState.pomodoro.active &&
            (gameState.isLockedIn || gameState.pomodoro.phase === 'break'));
    }

    // Only write to DOM when state actually changes — avoids 60fps mutations
    // that interfere with click event delivery
    if (newText !== _leaveBtnLastText) {
        btn.textContent = newText;
        _leaveBtnLastText = newText;
    }
    if (shouldShow !== _leaveBtnLastVisible) {
        wrap.classList.toggle('leave-wrap-hidden', !shouldShow);
        if (!shouldShow) {
            document.getElementById('pomo-leave-confirm1')?.classList.add('pomo-leave-confirm-hidden');
            document.getElementById('pomo-leave-confirm2')?.classList.add('pomo-leave-confirm-hidden');
        }
        _leaveBtnLastVisible = shouldShow;
    }

    // "إنهاء الاستراحة" — only while on break (solo pomo or free mode) and NOT in a
    // minigame. Excludes shared-pomo break, whose timing is host-synchronized.
    const endBreakBtn = document.getElementById('end-break-btn');
    if (endBreakBtn) {
        const showEndBreak = shouldShow && isBreakActive() && !isMinigameActive()
            && gameState.sharedPomo.phase !== 'active';
        const disp = showEndBreak ? 'block' : 'none';
        if (endBreakBtn.style.display !== disp) endBreakBtn.style.display = disp;
    }
}

// End the current break early and kick off the normal comeback-to-work sequence
// (TimeReturn sound → 2 s pause → kidnap animation → work phase).
function endBreakEarly() {
    if (isMinigameActive()) return;
    const fm = gameState.freeMode;
    if (fm.active && fm.phase === 'break') { endFreeModeBreak(); return; }
    // Solo pomo break: force the timer to zero so updatePomodoro runs its natural
    // break-end transition next frame (writes the 'wait' doc + starts the kidnap).
    if (gameState.pomodoro.active && gameState.pomodoro.phase === 'break'
        && gameState.sharedPomo.phase !== 'active') {
        gameState.pomodoro.endTime = Date.now();
    }
}

function exitPomoNow() {
    if (gameState.freeMode.active) { endFreeMode(); return; }
    const sp = gameState.sharedPomo;

    // Leave coop session if in one
    if (sp.phase === 'active') {
        if (sp.isHost) {
            // Unsubscribe before deleting so our own write doesn't trigger handleHostLeft
            if (sp.unsubLive) { sp.unsubLive(); sp.unsubLive = null; }
            update(ref(database), {
                [spPath(`live/${sp.sessionId}`)]: null,
                [spPath(`sessions/${sp.sessionId}`)]: null,
            });
        } else if (sp.sessionId) {
            update(ref(database), {
                [spPath(`sessions/${sp.sessionId}/participants/${gameState.userId}`)]: null,
                [spPath(`live/${sp.sessionId}/participants/${gameState.userId}`)]: null,
            });
        }
        cleanupSpLocal(true);
    }

    // Clean exit — cancel the disconnect handlers and wipe the reclaim stash so
    // we spawn fresh next time instead of being offered an old session.
    cancelSessionDisconnect(true);

    // Release laptop on Firebase — only if WE own it (host/solo).
    // Guests share the host's laptop; releasing it would kill the host's session.
    if (gameState.pomodoro.laptopId) {
        const _laptop = gameState.laptops.find(l => l.id === gameState.pomodoro.laptopId);
        const weOwnIt = _laptop?.claimedBy === gameState.userId;
        if (weOwnIt) {
            update(ref(database), { [lobbyPath(`pomodoro/${gameState.pomodoro.laptopId}`)]: null });
            _laptop.claimedBy = null;
            _laptop.phase = 'none';
        }
    }

    // Reset local pomo state
    gameState.pomodoro.active       = false;
    gameState.pomodoro.phase        = 'none';
    gameState.pomodoro.endTime      = 0;
    gameState.pomodoro.transitioning = false;
    gameState.pomodoro.laptopId     = null;
    gameState.isLockedIn            = false;
    gameState.anim.active           = false;
    gameState.anim.phase            = 'none';

    // Clear any coop session that was tied to this pomo
    cleanupSpLocal(true);

    // Hide all focus / pomo UI
    document.getElementById('focus-sounds-panel')?.classList.remove('active');
    document.getElementById('current-task-panel')?.classList.remove('active');
    document.getElementById('leave-wrap')?.classList.add('leave-wrap-hidden');
    document.getElementById('pomo-leave-confirm1')?.classList.add('pomo-leave-confirm-hidden');
    document.getElementById('pomo-leave-confirm2')?.classList.add('pomo-leave-confirm-hidden');
    document.getElementById('pomodoro-large-timer')?.classList.add('hidden');
    document.getElementById('pomodoro-small-timer')?.classList.add('hidden');
    setMobileFocusMode(false);

    const local = gameState.players[gameState.userId];
    // If leaving while in the break room, eject to work room (door is only passable during a break)
    if (local && isInBreakRoom(local.y)) {
        const exitY = ROOM_SEAM_Y - 80;
        teleportEntity(local, local.x, exitY);
        updatePlayerPosition(local.x, exitY);
    } else {
        updatePlayerPosition(local?.x || 0, local?.y || 0);
    }
}

// ── Coop animation ────────────────────────────────────────────────────────────

const COOP_EMOJIS  = ['🔨','⚡','💡','✨','🚀','🎯','🔥','💪'];
// flip/jump removed — flip caused 3D disappear, jump was too bouncy
const COOP_STATES  = ['idle','orbit','wiggle','spin','hammer'];

function _coopMemberHome(idx, total) {
    const cols = total === 1 ? 1 : 2;
    const col  = idx % cols;
    const row  = Math.floor(idx / cols);
    const homeX = (col - (cols - 1) / 2) * 90;
    const homeY = row * 62;
    return { homeX, homeY };
}

function _initCoopMem(idx, total) {
    const { homeX, homeY } = _coopMemberHome(idx, total);
    return {
        state: 'idle',
        stateTimer: 55 + Math.random() * 110,
        stateProgress: 0,
        orbitAngle: Math.random() * Math.PI * 2,
        dxBlend: homeX, dyBlend: homeY,
        scaleXBlend: 1, scaleYBlend: 1,
        angleBlend: 0,
        prevState: 'idle',
    };
}

function _advanceCoopMems(memberUids, membersDict, dt, syncBobPhase, emojiFloats) {
    const total = memberUids.length;
    for (let i = 0; i < total; i++) {
        const uid = memberUids[i];
        if (!membersDict[uid]) membersDict[uid] = _initCoopMem(i, total);
        const m = membersDict[uid];
        m.stateTimer -= dt;
        m.stateProgress += dt;

        const { homeX, homeY } = _coopMemberHome(i, total);

        if (m.stateTimer <= 0) {
            m.prevState = m.state;
            // On leaving spin, reset angle to near 0 so lerp back is smooth
            if (m.prevState === 'spin') m.angleBlend = 0;
            const opts = COOP_STATES.filter(s => s !== m.state);
            m.state         = opts[Math.floor(Math.random() * opts.length)];
            m.stateTimer    = 65 + Math.random() * 140;
            m.stateProgress = 0;
            if (m.state === 'hammer' || (m.state === 'orbit' && Math.random() < 0.3)) {
                const player = gameState.players[uid];
                if (player) {
                    gameState.sharedPomo.coopAnim.emojiFloats?.push({
                        wx: player.renderX + (Math.random() - 0.5) * 18,
                        wy: player.renderY - PLAYER_SIZE * 0.9,
                        emoji: COOP_EMOJIS[Math.floor(Math.random() * COOP_EMOJIS.length)],
                        age: 0, maxAge: 70, vy: -0.5,
                    });
                }
            }
        }

        if (m.state === 'orbit') m.orbitAngle += 0.013 * dt;

        const syncBob = Math.sin(syncBobPhase) * 3;
        let tDX = homeX, tDY = homeY + syncBob, tSX = 1, tSY = 1, tAngle = 0;
        let directAngle = false;

        switch (m.state) {
            case 'orbit':
                tDX = homeX + Math.cos(m.orbitAngle) * 18;
                tDY = homeY + syncBob + Math.sin(m.orbitAngle) * 8;
                break;
            case 'wiggle':
                tAngle = Math.sin(m.stateProgress * 0.12) * 0.2;
                break;
            case 'spin':
                m.angleBlend += 0.13 * dt; // continuous full rotation
                directAngle = true;
                break;
            case 'hammer': {
                const sh = Math.sin(m.stateProgress * 0.72) * 0.15;
                tSX = 1 + sh; tSY = 1 - sh * 0.4;
                tDY = homeY + syncBob - Math.abs(sh) * 4;
                break;
            }
        }

        const ls = 0.065 * dt;
        m.dxBlend     += (tDX - m.dxBlend)     * ls;
        m.dyBlend     += (tDY - m.dyBlend)     * ls;
        m.scaleXBlend += (tSX - m.scaleXBlend) * ls;
        m.scaleYBlend += (tSY - m.scaleYBlend) * ls;
        if (!directAngle) m.angleBlend += (tAngle - m.angleBlend) * ls;
    }
}

function updateCoopAnimation() {
    const sp = gameState.sharedPomo;
    const ca = sp.coopAnim;
    const dt = gameState.dtFactor;

    ca.syncBobPhase += 0.04 * dt;

    // Our own session members
    if (sp.phase === 'active' && sp.activeGroupMembers.length > 1) {
        _advanceCoopMems(sp.activeGroupMembers, ca.members, dt, ca.syncBobPhase);
    }

    // External coop groups (spectator view)
    // Build groups: hostId → sorted uid list
    const extGroups = {};
    for (const p of Object.values(gameState.players)) {
        if (!p.coopHostId) continue;
        if (sp.activeGroupMembers.includes(p.userId)) continue; // already in our session
        if (!extGroups[p.coopHostId]) extGroups[p.coopHostId] = [];
        extGroups[p.coopHostId].push(p.userId);
    }
    for (const [hostId, uids] of Object.entries(extGroups)) {
        // Sort so home-position index is stable regardless of gameState.players iteration order
        const sorted = [...new Set([hostId, ...uids])].sort();
        _advanceCoopMems(sorted, sp.extCoopAnims, dt, ca.syncBobPhase);
    }

    // Age out floats
    for (let i = ca.emojiFloats.length - 1; i >= 0; i--) {
        const f = ca.emojiFloats[i];
        f.age += dt; f.wy += f.vy * dt;
        if (f.age >= f.maxAge) ca.emojiFloats.splice(i, 1);
    }
}

function drawCoopEmojiFloats() {
    const sp = gameState.sharedPomo;
    if (sp.phase !== 'active') return;
    const ctx = gameState.ctx;
    const ca  = sp.coopAnim;
    if (!ca.emojiFloats.length) return;

    for (const f of ca.emojiFloats) {
        const alpha = 1 - f.age / f.maxAge;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.font = '18px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(f.emoji, f.wx, f.wy);
        ctx.restore();
    }
}

function drawCoopGroupLabels() {
    const sp  = gameState.sharedPomo;
    const ctx = gameState.ctx;

    // Build external groups: only players NOT in our own session
    const groups = {};
    for (const p of Object.values(gameState.players)) {
        if (!p.coopHostId) continue;
        if (sp.activeGroupMembers.includes(p.userId)) continue; // skip own session
        if (!groups[p.coopHostId]) groups[p.coopHostId] = [];
        groups[p.coopHostId].push(p);
    }

    for (const members of Object.values(groups)) {
        if (members.length < 2) continue; // need ≥2 to call it a group

        // Average draw position — deliberately ignore coop dance offsets so the
        // label stays anchored above the static badge box, not bobbing with sprites.
        let sumX = 0, minY = Infinity;
        for (const p of members) {
            const { x: rx, y: ry } = getPlayerRenderPos(p);
            sumX += rx;
            minY = Math.min(minY, ry);
        }
        const cx = sumX / members.length;

        // Replicate getLaptopBadgePosition's offset (PLAYER_SIZE/2 + 20 = 55)
        // to get the true topY that drawCoopBadge receives, then place the pill
        // 10 px above the badge's top edge.
        const _rowH = 26, _gapRows = 3, _timerH = 28;
        const badgeH = members.length * _rowH + (members.length - 1) * _gapRows + _gapRows + _timerH;
        const badgeTopY = minY - (PLAYER_SIZE / 2 + 20) - badgeH;
        const labelY = badgeTopY - 10;

        ctx.save();
        ctx.font = 'bold 12px Rubik';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const text = 'نعمل على';
        const tw = ctx.measureText(text).width;
        const ph = 21, pw = tw + 20, pr = 11;

        ctx.shadowBlur = 8; ctx.shadowColor = 'rgba(0,0,0,0.45)';
        ctx.fillStyle = 'rgba(15,15,15,0.78)';
        _rrect(ctx, cx - pw / 2, labelY - ph / 2, pw, ph, pr);
        ctx.fill();
        ctx.shadowBlur = 0;

        ctx.fillStyle = 'rgba(255,255,255,0.90)';
        ctx.fillText(text, cx, labelY);
        ctx.restore();
    }
}

// ── Coop task panel ───────────────────────────────────────────────────────────

function updateCoopTaskPanel() {
    const sp    = gameState.sharedPomo;
    const panel = document.getElementById('sp-coop-tasks');
    if (!panel) return;

    // Show to any member (host or guest) during active work phase
    const shouldShow = sp.phase === 'active' && sp.activeGroupMembers.length > 1
        && gameState.pomodoro.active && gameState.pomodoro.phase === 'work';

    if (!shouldShow) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');

    const remaining = Math.max(0, gameState.pomodoro.endTime - Date.now());
    const mm = String(Math.floor(remaining / 60000)).padStart(2, '0');
    const ss = String(Math.floor((remaining % 60000) / 1000)).padStart(2, '0');

    let html = `<div class="sp-coop-timer">${mm}:${ss}</div>`;
    for (const uid of sp.activeGroupMembers) {
        const player = gameState.players[uid];
        if (!player) continue;
        const av = player.avatar ? `<img src="${player.avatar}" alt="">` : (player.username||'?').charAt(0).toUpperCase();
        // Only show task text for the current user — others' tasks are private
        const taskText = uid === gameState.userId ? (player.currentTask || '…') : '…';
        html += `<div class="sp-coop-row">
            <div class="sp-coop-av">${av}</div>
            <span class="sp-coop-task">${taskText}</span>
        </div>`;
    }
    panel.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRAYER TIMES SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════

const PRAYER_DATA = [
    { key: 'Fajr',    arabic: 'الفَجْر'   },
    { key: 'Dhuhr',   arabic: 'الظُّهْر'  },
    { key: 'Asr',     arabic: 'العَصْر'   },
    { key: 'Maghrib', arabic: 'المَغْرِب' },
    { key: 'Isha',    arabic: 'العِشَاء'  },
];

const PRAYER_ICON_SVG = {
    Fajr:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/><circle cx="17" cy="5" r="1" fill="currentColor" stroke="none"/></svg>',
    Dhuhr:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>',
    Asr:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="14" r="4.5"/><line x1="12" y1="5" x2="12" y2="7.5"/><line x1="5.64" y1="8.64" x2="7.05" y2="10.05"/><line x1="3" y1="14" x2="5" y2="14"/><line x1="19" y1="14" x2="21" y2="14"/><line x1="16.95" y1="10.05" x2="18.36" y2="8.64"/><line x1="2" y1="21" x2="22" y2="21"/></svg>',
    Maghrib: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M17 18a5 5 0 1 0-10 0"/><line x1="12" y1="9" x2="12" y2="11.5"/><line x1="7.05" y1="13.05" x2="8.46" y2="14.46"/><line x1="4" y1="18" x2="6" y2="18"/><line x1="18" y1="18" x2="20" y2="18"/><line x1="15.54" y1="14.46" x2="16.95" y2="13.05"/><line x1="2" y1="21" x2="22" y2="21"/></svg>',
    Isha:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/><circle cx="18" cy="5" r="0.8" fill="currentColor" stroke="none"/><circle cx="15" cy="3" r="0.6" fill="currentColor" stroke="none"/><circle cx="20" cy="8" r="0.5" fill="currentColor" stroke="none"/></svg>',
};

const PRAYER_LOCATIONS = [
    { country: 'مصر', cities: [
        { name: 'القاهرة', lat: 30.0444, lon: 31.2357 },
        { name: 'الإسكندرية', lat: 31.2001, lon: 29.9187 },
        { name: 'الجيزة', lat: 30.0131, lon: 31.2089 },
        { name: 'المنصورة', lat: 31.0409, lon: 31.3785 },
        { name: 'طنطا', lat: 30.7865, lon: 31.0004 },
        { name: 'أسيوط', lat: 27.1783, lon: 31.1859 },
    ]},
    { country: 'السعودية', cities: [
        { name: 'مكة المكرمة', lat: 21.4225, lon: 39.8262 },
        { name: 'المدينة المنورة', lat: 24.4672, lon: 39.6024 },
        { name: 'الرياض', lat: 24.7136, lon: 46.6753 },
        { name: 'جدة', lat: 21.4858, lon: 39.1925 },
    ]},
    { country: 'الإمارات', cities: [
        { name: 'دبي', lat: 25.2048, lon: 55.2708 },
        { name: 'أبوظبي', lat: 24.4539, lon: 54.3773 },
    ]},
    { country: 'فلسطين', cities: [
        { name: 'القدس', lat: 31.7683, lon: 35.2137 },
        { name: 'غزة', lat: 31.5017, lon: 34.4668 },
    ]},
    { country: 'الأردن', cities: [
        { name: 'عمّان', lat: 31.9454, lon: 35.9284 },
    ]},
    { country: 'العراق', cities: [
        { name: 'بغداد', lat: 33.3152, lon: 44.3661 },
    ]},
    { country: 'الكويت', cities: [
        { name: 'الكويت', lat: 29.3759, lon: 47.9774 },
    ]},
    { country: 'اليمن', cities: [
        { name: 'صنعاء', lat: 15.3694, lon: 44.1910 },
        { name: 'عدن', lat: 12.7794, lon: 45.0367 },
        { name: 'تعز', lat: 13.5795, lon: 44.0209 },
        { name: 'الحديدة', lat: 14.7978, lon: 42.9545 },
        { name: 'المكلا', lat: 14.5426, lon: 49.1242 },
        { name: 'إب', lat: 13.9667, lon: 44.1833 },
    ]},
    { country: 'قطر', cities: [
        { name: 'الدوحة', lat: 25.2854, lon: 51.5310 },
    ]},
    { country: 'البحرين', cities: [
        { name: 'المنامة', lat: 26.2285, lon: 50.5860 },
    ]},
    { country: 'عُمان', cities: [
        { name: 'مسقط', lat: 23.5880, lon: 58.3829 },
        { name: 'صلالة', lat: 17.0151, lon: 54.0924 },
    ]},
    { country: 'سوريا', cities: [
        { name: 'دمشق', lat: 33.5138, lon: 36.2765 },
        { name: 'حلب', lat: 36.2021, lon: 37.1343 },
        { name: 'حمص', lat: 34.7324, lon: 36.7137 },
    ]},
    { country: 'لبنان', cities: [
        { name: 'بيروت', lat: 33.8938, lon: 35.5018 },
        { name: 'طرابلس', lat: 34.4367, lon: 35.8497 },
    ]},
    { country: 'السودان', cities: [
        { name: 'الخرطوم', lat: 15.5007, lon: 32.5599 },
        { name: 'أم درمان', lat: 15.6445, lon: 32.4777 },
        { name: 'بورتسودان', lat: 19.6175, lon: 37.2164 },
    ]},
    { country: 'ليبيا', cities: [
        { name: 'طرابلس', lat: 32.8872, lon: 13.1913 },
        { name: 'بنغازي', lat: 32.1167, lon: 20.0686 },
        { name: 'مصراتة', lat: 32.3754, lon: 15.0925 },
    ]},
    { country: 'تونس', cities: [
        { name: 'تونس', lat: 36.8065, lon: 10.1815 },
        { name: 'صفاقس', lat: 34.7406, lon: 10.7603 },
        { name: 'سوسة', lat: 35.8256, lon: 10.6360 },
    ]},
    { country: 'الجزائر', cities: [
        { name: 'الجزائر', lat: 36.7538, lon: 3.0588 },
        { name: 'وهران', lat: 35.6976, lon: -0.6337 },
        { name: 'قسنطينة', lat: 36.3650, lon: 6.6147 },
    ]},
    { country: 'المغرب', cities: [
        { name: 'الدار البيضاء', lat: 33.5731, lon: -7.5898 },
        { name: 'الرباط', lat: 34.0209, lon: -6.8416 },
        { name: 'مراكش', lat: 31.6295, lon: -7.9811 },
        { name: 'فاس', lat: 34.0181, lon: -5.0078 },
        { name: 'طنجة', lat: 35.7595, lon: -5.8340 },
    ]},
    { country: 'موريتانيا', cities: [
        { name: 'نواكشوط', lat: 18.0735, lon: -15.9582 },
    ]},
    { country: 'الصومال', cities: [
        { name: 'مقديشو', lat: 2.0469, lon: 45.3182 },
    ]},
    { country: 'جيبوتي', cities: [
        { name: 'جيبوتي', lat: 11.5721, lon: 43.1456 },
    ]},
    { country: 'جزر القمر', cities: [
        { name: 'موروني', lat: -11.7172, lon: 43.2473 },
    ]},
    { country: 'إندونيسيا', cities: [
        { name: 'جاكرتا', lat: -6.2088, lon: 106.8456 },
        { name: 'سورابايا', lat: -7.2575, lon: 112.7521 },
        { name: 'باندونغ', lat: -6.9175, lon: 107.6191 },
    ]},
    { country: 'باكستان', cities: [
        { name: 'كراتشي', lat: 24.8607, lon: 67.0011 },
        { name: 'لاهور', lat: 31.5204, lon: 74.3587 },
        { name: 'إسلام آباد', lat: 33.6844, lon: 73.0479 },
    ]},
    { country: 'بنغلاديش', cities: [
        { name: 'دكا', lat: 23.8103, lon: 90.4125 },
        { name: 'شيتاغونغ', lat: 22.3569, lon: 91.7832 },
    ]},
    { country: 'الهند', cities: [
        { name: 'نيودلهي', lat: 28.6139, lon: 77.2090 },
        { name: 'مومباي', lat: 19.0760, lon: 72.8777 },
        { name: 'حيدر آباد', lat: 17.3850, lon: 78.4867 },
    ]},
    { country: 'إيران', cities: [
        { name: 'طهران', lat: 35.6892, lon: 51.3890 },
        { name: 'مشهد', lat: 36.2605, lon: 59.6168 },
    ]},
    { country: 'أفغانستان', cities: [
        { name: 'كابول', lat: 34.5553, lon: 69.2075 },
    ]},
    { country: 'نيجيريا', cities: [
        { name: 'لاغوس', lat: 6.5244, lon: 3.3792 },
        { name: 'كانو', lat: 12.0022, lon: 8.5920 },
        { name: 'أبوجا', lat: 9.0765, lon: 7.3986 },
    ]},
    { country: 'تشاد', cities: [
        { name: 'إنجامينا', lat: 12.1348, lon: 15.0557 },
    ]},
    { country: 'النيجر', cities: [
        { name: 'نيامي', lat: 13.5116, lon: 2.1254 },
    ]},
    { country: 'السنغال', cities: [
        { name: 'داكار', lat: 14.7167, lon: -17.4677 },
    ]},
    { country: 'أذربيجان', cities: [
        { name: 'باكو', lat: 40.4093, lon: 49.8671 },
    ]},
    { country: 'كازاخستان', cities: [
        { name: 'ألماتي', lat: 43.2220, lon: 76.8512 },
        { name: 'أستانا', lat: 51.1694, lon: 71.4491 },
    ]},
    { country: 'أوزبكستان', cities: [
        { name: 'طشقند', lat: 41.2995, lon: 69.2401 },
    ]},
    { country: 'ألمانيا', cities: [
        { name: 'برلين', lat: 52.5200, lon: 13.4050 },
        { name: 'ميونخ', lat: 48.1351, lon: 11.5820 },
        { name: 'فرانكفورت', lat: 50.1109, lon: 8.6821 },
    ]},
    { country: 'فرنسا', cities: [
        { name: 'باريس', lat: 48.8566, lon: 2.3522 },
        { name: 'مرسيليا', lat: 43.2965, lon: 5.3698 },
        { name: 'ليون', lat: 45.7640, lon: 4.8357 },
    ]},
    { country: 'هولندا', cities: [
        { name: 'أمستردام', lat: 52.3676, lon: 4.9041 },
    ]},
    { country: 'بلجيكا', cities: [
        { name: 'بروكسل', lat: 50.8503, lon: 4.3517 },
    ]},
    { country: 'السويد', cities: [
        { name: 'ستوكهولم', lat: 59.3293, lon: 18.0686 },
    ]},
    { country: 'إسبانيا', cities: [
        { name: 'مدريد', lat: 40.4168, lon: -3.7038 },
        { name: 'برشلونة', lat: 41.3851, lon: 2.1734 },
    ]},
    { country: 'إيطاليا', cities: [
        { name: 'روما', lat: 41.9028, lon: 12.4964 },
        { name: 'ميلانو', lat: 45.4642, lon: 9.1900 },
    ]},
    { country: 'أستراليا', cities: [
        { name: 'سيدني', lat: -33.8688, lon: 151.2093 },
        { name: 'ملبورن', lat: -37.8136, lon: 144.9631 },
    ]},
    { country: 'تركيا', cities: [
        { name: 'اسطنبول', lat: 41.0082, lon: 28.9784 },
        { name: 'أنقرة', lat: 39.9334, lon: 32.8597 },
    ]},
    { country: 'الولايات المتحدة', cities: [
        { name: 'نيويورك', lat: 40.7128, lon: -74.0060 },
        { name: 'لوس أنجلوس', lat: 34.0522, lon: -118.2437 },
        { name: 'هيوستن', lat: 29.7604, lon: -95.3698 },
        { name: 'شيكاغو', lat: 41.8781, lon: -87.6298 },
    ]},
    { country: 'بريطانيا', cities: [
        { name: 'لندن', lat: 51.5074, lon: -0.1278 },
    ]},
    { country: 'كندا', cities: [
        { name: 'تورنتو', lat: 43.6532, lon: -79.3832 },
    ]},
    { country: 'ماليزيا', cities: [
        { name: 'كوالالمبور', lat: 3.139, lon: 101.6869 },
    ]},
];

// ── Init ─────────────────────────────────────────────────────────────────────

// Ask for notification permission once, at a calm moment after game entry. Siraj
// ghosts skip it (ephemeral). No-op if already granted/denied or unsupported.
function maybeRequestNotificationPermission() {
    if (gameState.isSirajGhost) return;
    try {
        if (typeof Notification === 'undefined') return;
        if (Notification.permission !== 'default') return;
        setTimeout(() => {
            try { Notification.requestPermission().catch(() => {}); } catch (e) {}
        }, 3500);
    } catch (e) {}
}

function initPrayerSystem() {
    if (gameState.isSirajGhost) gameState.prayer.prayerLockMs = 5000; // 5 s for Siraj

    // Preload athan buffer so it's ready for background playback
    const _preloadAthan = () => {
        if (!gameState.focusAudioEngine?.ctx) return;
        const ctx = gameState.focusAudioEngine.ctx;
        fetch('Sound/Prayer_CallToPrayer.mp3')
            .then(r => r.arrayBuffer())
            .then(buf => ctx.decodeAudioData(buf))
            .then(decoded => { gameState.prayer._athanBuffer = decoded; })
            .catch(() => {});
    };
    // Delay slightly to let AudioContext initialize first
    setTimeout(_preloadAthan, 2000);

    // Request notification permission once, shortly after entering the game (still
    // close to the entry click gesture). Doing it here — rather than at the athan
    // moment — keeps the prayer overlay from being interrupted by a browser prompt.
    maybeRequestNotificationPermission();

    // On mobile, move prayer panel + YT inside the focus drawer for proper scrolling.
    // Prayer panel comes first so it's visible as soon as the drawer opens,
    // YT block comes after (scroll down to reach it).
    if (isMobile()) {
        const drawer = document.getElementById('focus-sounds-panel');
        const yt = document.getElementById('yt-focus-block');
        const pp = document.getElementById('prayer-panel');
        if (drawer && pp) drawer.appendChild(pp);
        if (drawer && yt) drawer.appendChild(yt);
    }

    // Read location from Firebase (city + country only — exact coords are never stored)
    get(ref(database, `users/${gameState.userId}/prayerLocation`)).then(snap => {
        const loc = snap.val();
        if (loc && (loc.city || loc.country)) {
            // Privacy migration: scrub any legacy lat/lon left in this user's record
            // from older builds. Rewrite the node with city/country only.
            if (loc.lat != null || loc.lon != null) {
                set(ref(database, `users/${gameState.userId}/prayerLocation`), {
                    city: loc.city || '', country: loc.country || ''
                }).catch(() => {});
                delete loc.lat; delete loc.lon;
            }
            gameState.prayer.location = loc;
            document.getElementById('prayer-blur-overlay')?.classList.add('hidden');
            fetchPrayerTimes();
        }
    });

    // Read adjustments
    get(ref(database, `users/${gameState.userId}/prayerAdjustments`)).then(snap => {
        const adj = snap.val();
        if (adj) gameState.prayer.adjustments = adj;
    });

    setupPrayerUI();
}

// ── API fetch ────────────────────────────────────────────────────────────────

// ── Local (offline) prayer-time computation ───────────────────────────────────
// Self-contained astronomical calculation so prayer times work even when the
// Aladhan API is unreachable (some ISPs / VPN exit nodes block api.aladhan.com —
// that was the cause of the "--:--" report). Matches method=5 (Egyptian General
// Authority of Survey): Fajr 19.5°, Isha 17.5°, Asr factor 1 (standard/Shafii).
// Verified to within ~1 min of the Aladhan API for multiple cities.
function computePrayerTimesLocal(lat, lng, date, tzOffsetHours) {
    const dtr = d => d * Math.PI / 180, rtd = r => r * 180 / Math.PI;
    const sin = d => Math.sin(dtr(d)), cos = d => Math.cos(dtr(d)), tan = d => Math.tan(dtr(d));
    const arcsin = x => rtd(Math.asin(x)), arccos = x => rtd(Math.acos(x));
    const arctan2 = (y, x) => rtd(Math.atan2(y, x)), arccot = x => rtd(Math.atan(1 / x));
    const fixAngle = a => { a %= 360; return a < 0 ? a + 360 : a; };
    const fixHour  = a => { a %= 24;  return a < 0 ? a + 24  : a; };

    let y = date.getFullYear(), mo = date.getMonth() + 1, d = date.getDate();
    if (mo <= 2) { y -= 1; mo += 12; }
    const A = Math.floor(y / 100), B = 2 - A + Math.floor(A / 4);
    const jDate = Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (mo + 1)) + d + B - 1524.5
                  - lng / (15 * 24);

    const sunPos = jd => {
        const D = jd - 2451545.0;
        const g = fixAngle(357.529 + 0.98560028 * D);
        const q = fixAngle(280.459 + 0.98564736 * D);
        const L = fixAngle(q + 1.915 * sin(g) + 0.020 * sin(2 * g));
        const e = 23.439 - 0.00000036 * D;
        const RA = arctan2(cos(e) * sin(L), cos(L)) / 15;
        return { declination: arcsin(sin(e) * sin(L)), equation: q / 15 - fixHour(RA) };
    };
    const midDay = t => fixHour(12 - sunPos(jDate + t).equation);
    const sunAngle = (angle, t, dir) => {
        const decl = sunPos(jDate + t).declination;
        const v = (-sin(angle) - sin(decl) * sin(lat)) / (cos(decl) * cos(lat));
        return midDay(t) + (dir === 'ccw' ? -1 : 1) * (1 / 15) * arccos(v);
    };
    const asr = t => {
        const decl = sunPos(jDate + t).declination;
        return sunAngle(-arccot(1 + tan(Math.abs(lat - decl))), t, 'cw'); // shadow factor 1
    };

    let times = { Fajr: 5, Sunrise: 6, Dhuhr: 12, Asr: 13, Maghrib: 18, Isha: 18 };
    for (let i = 0; i < 2; i++) { // iterate to converge
        const t = {};
        for (const k in times) t[k] = times[k] / 24;
        times = {
            Fajr:    sunAngle(19.5, t.Fajr, 'ccw'),
            Sunrise: sunAngle(0.833, t.Sunrise, 'ccw'),
            Dhuhr:   midDay(t.Dhuhr),
            Asr:     asr(t.Asr),
            Maghrib: sunAngle(0.833, t.Maghrib, 'cw'),
            Isha:    sunAngle(17.5, t.Isha, 'cw'),
        };
    }
    const out = {};
    for (const k in times) {
        const v = fixHour(times[k] + tzOffsetHours - lng / 15 + 0.5 / 60); // +30s → round to min
        const h = Math.floor(v), m = Math.floor((v - h) * 60);
        out[k] = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
    return out;
}

// Resolve a saved (Arabic) city/country to curated city-centre coordinates, or null.
function curatedCityCoords(cityName, countryName) {
    for (const c of PRAYER_LOCATIONS) {
        if (c.country === countryName) {
            const m = c.cities.find(ci => ci.name === cityName);
            if (m) return { lat: m.lat, lon: m.lon };
        }
    }
    return null;
}

let _prayerRetryTimer = null;
function schedulePrayerRetry(delayMs) {
    if (_prayerRetryTimer) return; // keep at most one pending retry
    _prayerRetryTimer = setTimeout(() => {
        _prayerRetryTimer = null;
        gameState.prayer.lastFetchDate = null;
        fetchPrayerTimes();
    }, delayMs || 30000);
}

function _applyPrayerTimings(timings, dateStr) {
    const pr = gameState.prayer;
    pr.times = {};
    for (const p of PRAYER_DATA) pr.times[p.key] = timings[p.key]; // e.g. "12:30"
    pr.lastFetchDate = dateStr;
    computeNextPrayer();
    _lastPrayerPanelUpdate = 0; // force tickPrayerPanel to recompute next frame
    updatePrayerPanelDOM();
    document.getElementById('prayer-blur-overlay')?.classList.add('hidden');
}

async function fetchPrayerTimes() {
    const pr = gameState.prayer;
    const loc = pr.location;
    if (!loc) return;

    const today = new Date();
    const dateStr = `${String(today.getDate()).padStart(2, '0')}-${String(today.getMonth() + 1).padStart(2, '0')}-${today.getFullYear()}`;
    if (pr.lastFetchDate === dateStr && pr.times) return;

    // Resolve coordinates: in-memory exact (this session) or curated city-centre.
    let lat = loc._lat, lon = loc._lon;
    if (lat == null || lon == null) {
        const cc = curatedCityCoords(loc.city || '', loc.country || '');
        if (cc) { lat = cc.lat; lon = cc.lon; }
    }

    // 1) Try the Aladhan API first (authoritative). Fail fast (8s abort) so a
    //    blocked/slow endpoint can't hang the user on "--:--".
    let applied = false;
    try {
        const url = (lat != null && lon != null)
            ? `https://api.aladhan.com/v1/timings/${dateStr}?latitude=${lat}&longitude=${lon}&method=5`
            : `https://api.aladhan.com/v1/timingsByCity/${dateStr}?city=${encodeURIComponent(loc.city || '')}&country=${encodeURIComponent(loc.country || '')}&method=5`;
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 8000);
        const res = await fetch(url, { signal: ctrl.signal });
        clearTimeout(to);
        const json = await res.json();
        if (json.code === 200 && json.data && json.data.timings) {
            _applyPrayerTimings(json.data.timings, dateStr);
            applied = true;
        }
    } catch (e) {
        console.warn('[prayer] API unavailable, falling back to local computation:', e?.message || e);
    }

    // 2) Offline fallback: compute locally when the API failed but we have coords.
    //    Uses the device's UTC offset (which the OS keeps DST-correct) — the user
    //    is physically at the location they set, so this matches their local clock.
    if (!applied && lat != null && lon != null) {
        const tzOffset = -today.getTimezoneOffset() / 60;
        _applyPrayerTimings(computePrayerTimesLocal(lat, lon, today, tzOffset), dateStr);
        applied = true;
        console.info('[prayer] using offline prayer-time computation');
    }

    // 3) No coords AND API down → retry shortly (e.g. uncurated city + offline).
    if (!applied) schedulePrayerRetry(20000);
}

// ── Compute next prayer ──────────────────────────────────────────────────────

function prayerTimeToMs(timeStr, adjMinutes) {
    const [h, m] = timeStr.split(':').map(Number);
    const d = new Date();
    d.setHours(h, m + (adjMinutes || 0), 0, 0);
    return d.getTime();
}

function computeNextPrayer() {
    const pr = gameState.prayer;
    if (!pr.times) return;

    const now = Date.now();
    const adj = pr.adjustments;
    const dayMs = [];

    for (let i = 0; i < PRAYER_DATA.length; i++) {
        const p = PRAYER_DATA[i];
        let ms = prayerTimeToMs(pr.times[p.key], adj[p.key] || 0);
        // Siraj test mode: override next upcoming prayer to be 1 min from now
        if (gameState.isSirajGhost && ms > now && !pr._sirajOverrideApplied) {
            ms = now + 60000; // 1 minute from now
            pr._sirajOverrideApplied = true;
        }
        dayMs.push({ ...p, timeMs: ms });
    }

    // Find first prayer that hasn't passed yet
    let next = null;
    for (let i = 0; i < dayMs.length; i++) {
        if (dayMs[i].timeMs > now) {
            const prevMs = i > 0 ? dayMs[i - 1].timeMs : prayerTimeToMs('00:00', 0);
            next = { ...dayMs[i], prevTimeMs: prevMs };
            break;
        }
    }
    // All passed → next is tomorrow's Fajr
    if (!next) {
        const tmrw = new Date();
        tmrw.setDate(tmrw.getDate() + 1);
        tmrw.setHours(...pr.times.Fajr.split(':').map(Number), 0, 0);
        next = { key: 'Fajr', arabic: PRAYER_DATA[0].arabic, timeMs: tmrw.getTime(), prevTimeMs: dayMs[dayMs.length - 1].timeMs };
    }

    pr.nextPrayer = next;

    // Reset triggered flags at midnight
    const todayStr = new Date().toDateString();
    if (pr.lastDayCheck !== todayStr) {
        pr.triggeredToday = {};
        pr.lastDayCheck = todayStr;
        pr._sirajOverrideApplied = false;
        // Re-fetch times for new day
        pr.lastFetchDate = null;
        fetchPrayerTimes();
    }
}

// ── DOM update ───────────────────────────────────────────────────────────────

function updatePrayerPanelDOM() {
    const pr = gameState.prayer;
    if (!pr.times) return;

    const now = Date.now();
    const adj = pr.adjustments;

    for (const p of PRAYER_DATA) {
        const ms = prayerTimeToMs(pr.times[p.key], adj[p.key] || 0);
        const d = new Date(ms);
        let hrs = d.getHours(), ampm = hrs >= 12 ? 'م' : 'ص';
        hrs = hrs % 12 || 12;
        const tStr = `${hrs}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`;
        const el = document.getElementById(`pt-${p.key}`);
        if (el) el.textContent = tStr;

        // Mark active / passed
        const item = el?.closest('.prayer-icon-item');
        if (item) {
            const isPassed = ms <= now;
            const isNext = pr.nextPrayer && pr.nextPrayer.key === p.key;
            item.classList.toggle('passed', isPassed && !isNext);
            item.classList.toggle('active', isNext);
        }
    }

    // Next prayer info
    if (pr.nextPrayer) {
        const nel = document.getElementById('prayer-next-name');
        const tel = document.getElementById('prayer-next-time');
        if (nel) nel.textContent = pr.nextPrayer.arabic;
        if (tel) {
            const d = new Date(pr.nextPrayer.timeMs);
            let hrs = d.getHours(), ampm = hrs >= 12 ? 'م' : 'ص';
            hrs = hrs % 12 || 12;
            tel.textContent = `${hrs}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`;
        }

        // Progress bar
        const remaining = Math.max(0, pr.nextPrayer.timeMs - now);
        const fill = document.getElementById('prayer-progress-fill');
        if (fill) {
            const total = pr.nextPrayer.timeMs - pr.nextPrayer.prevTimeMs;
            // Fill from 0% (prayer just passed) → 100% (prayer right now)
            const pct = total > 0 ? Math.max(0, Math.min(100, ((total - remaining) / total) * 100)) : 0;
            fill.style.width = `${pct}%`;
        }

        // Live countdown to the next prayer
        const cd = document.getElementById('prayer-next-countdown');
        if (cd) cd.textContent = formatPrayerCountdown(remaining);
    }
}

// Call every ~1 s from the game loop to keep the panel live
let _lastPrayerPanelUpdate = 0;
function tickPrayerPanel() {
    const now = Date.now();
    if (now - _lastPrayerPanelUpdate < 1000) return;
    _lastPrayerPanelUpdate = now;
    if (!gameState.prayer.location || !gameState.prayer.times) return;
    computeNextPrayer();
    updatePrayerPanelDOM();
}

// ── Prayer trigger check ─────────────────────────────────────────────────────

function checkPrayerTrigger() {
    const pr = gameState.prayer;
    if (!pr.nextPrayer || pr.isOverlayActive) return;
    if (!gameState.pomodoro.active && !gameState.freeMode.active) return;

    const now = Date.now();
    if (now >= pr.nextPrayer.timeMs && !pr.triggeredToday[pr.nextPrayer.key]) {
        triggerPrayerOverlay(pr.nextPrayer.key, pr.nextPrayer.arabic);
    }
}

// ── Trigger overlay ──────────────────────────────────────────────────────────

function triggerPrayerOverlay(prayerKey, arabicName) {
    // Prayer takes priority over a running break minigame — pull the player straight
    // back out to the break room before showing the overlay.
    if (isMinigameActive()) exitAnyMinigame();
    // Prayer takes priority over azkar — close azkar without marking complete
    if (gameState.azkar && gameState.azkar.active) {
        closeAzkarOverlay(false);
    }
    const pr = gameState.prayer;
    pr.triggeredToday[prayerKey] = true;

    // Save timer state — only pause the timer in solo pomo; shared sessions keep running
    if (gameState.sharedPomo.phase !== 'active') {
        pr.pausedRemaining = Math.max(0, gameState.pomodoro.endTime - Date.now());
        pr.pausedPhase = gameState.pomodoro.phase;
    } else {
        pr.pausedRemaining = 0;
        pr.pausedPhase = null;
    }
    pr.overlayPrayer = prayerKey;
    pr.isOverlayActive = true;
    pr.overlayStartTime = Date.now();

    // System notification — only fire if already granted. Never call
    // requestPermission() here: a browser permission prompt at the exact moment the
    // athan plays interrupts the overlay. Permission is requested once at game start
    // (see initPrayerSystem → maybeRequestNotificationPermission).
    try {
        if (Notification.permission === 'granted') {
            new Notification(`🕌 وقت صلاة ${arabicName}`, { body: 'حان وقت الصلاة — الله أكبر' });
        }
    } catch(e) {}

    // Stop player movement so they don't stay stuck in sprint/walk animation
    const _localPlayer = gameState.players[gameState.userId];
    if (_localPlayer) { _localPlayer.isMoving = false; _localPlayer.isSprinting = false; }
    gameState.joystick.active = false;
    gameState.joystick.dx = 0; gameState.joystick.dy = 0;
    gameState.joystick.magnitude = 0; gameState.joystick.sprinting = false;
    ['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','ShiftLeft','ShiftRight']
        .forEach(k => { gameState.keys[k] = false; });

    // Fade out focus sounds and YT player so athan is heard clearly
    if (gameState.focusAudioEngine) gameState.focusAudioEngine.fadeToMaster(0, 2.0);
    if (gameState.focusYTPlayer) gameState.focusYTPlayer.fadeOutAndPause(2000);

    // Play athan via Web Audio API (works even in background/unfocused tab)
    const _playAthan = () => {
        if (!gameState.focusAudioEngine?.ctx) return;
        const ctx = gameState.focusAudioEngine.ctx;
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        const playBuffer = (decoded) => {
            if (!gameState.prayer.isOverlayActive) return;
            const src = ctx.createBufferSource();
            src.buffer = decoded;
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.9, ctx.currentTime);
            src.connect(g);
            g.connect(ctx.destination);
            src.start();
            gameState.prayer._webAudioAthanSource = src;
            gameState.prayer._webAudioAthanGain = g;
        };
        if (gameState.prayer._athanBuffer) {
            playBuffer(gameState.prayer._athanBuffer);
        } else {
            fetch('Sound/Prayer_CallToPrayer.mp3')
                .then(r => r.arrayBuffer())
                .then(buf => ctx.decodeAudioData(buf))
                .then(decoded => { gameState.prayer._athanBuffer = decoded; playBuffer(decoded); })
                .catch(() => {
                    // Fallback to HTML Audio
                    try { gameState.sounds.prayerCall.currentTime = 0; gameState.sounds.prayerCall.play().catch(() => {}); } catch(e) {}
                });
        }
    };
    _playAthan();

    // After 6.5 s (from athan start) show the visual overlay
    setTimeout(() => {
        if (!pr.isOverlayActive) return; // dismissed early?
        showPrayerOverlayDOM(prayerKey, arabicName);
    }, 5900);
}

function showPrayerOverlayDOM(prayerKey, arabicName) {
    const overlay = document.getElementById('prayer-overlay');
    if (!overlay) return;

    // Set prayer-specific theme
    const normKey = prayerKey.charAt(0).toUpperCase() + prayerKey.slice(1).toLowerCase();
    overlay.dataset.prayer = normKey.toLowerCase();

    // Remove display:none, then next frame fade in
    overlay.classList.remove('hidden');
    requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('active')));

    // Icon — normalize key capitalisation (handles 'dhuhr' from test mode as well as 'Dhuhr')
    const iconEl = document.getElementById('prayer-overlay-icon');
    if (iconEl) {
        const iconKey = prayerKey.charAt(0).toUpperCase() + prayerKey.slice(1);
        iconEl.innerHTML = PRAYER_ICON_SVG[iconKey] || PRAYER_ICON_SVG[prayerKey] || '';
    }

    // Name
    const nameEl = document.getElementById('prayer-overlay-name');
    if (nameEl) nameEl.textContent = `وقت صلاة ${arabicName}`;

    // Button: locked
    const btn = document.getElementById('prayer-overlay-btn');
    if (btn) { btn.disabled = true; btn.classList.remove('unlocked'); }

    // Start rain
    startPrayerRain();
}

// ── Prayer rain ───────────────────────────────────────────────────────────────
let _prayerRainRAF = null;

function startPrayerRain() {
    const canvas = document.getElementById('prayer-rain-canvas');
    if (!canvas) return;
    stopPrayerRain(); // clear any previous run

    const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
    resize();
    let _rainResizeTimer = null;
    const debouncedResize = () => {
        if (_rainResizeTimer) clearTimeout(_rainResizeTimer);
        _rainResizeTimer = setTimeout(() => { resize(); _rainResizeTimer = null; }, 150);
    };
    canvas._rainResizeHandler = debouncedResize;
    window.addEventListener('resize', debouncedResize);

    // 110 gentle drops — thin, slow, slightly angled left
    const drops = Array.from({ length: 110 }, () => ({
        x:       Math.random() * canvas.width,
        y:       Math.random() * canvas.height,
        len:     7 + Math.random() * 13,
        speed:   0.9 + Math.random() * 1.6,
        opacity: 0.08 + Math.random() * 0.18,
        width:   0.4 + Math.random() * 0.6,
    }));

    const ctx = canvas.getContext('2d');
    const draw = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (const d of drops) {
            ctx.beginPath();
            ctx.strokeStyle = `rgba(180,230,225,${d.opacity})`;
            ctx.lineWidth   = d.width;
            ctx.moveTo(d.x, d.y);
            ctx.lineTo(d.x - d.len * 0.18, d.y + d.len); // slight left lean
            ctx.stroke();
            d.y += d.speed;
            d.x -= d.speed * 0.18;
            if (d.y > canvas.height + d.len) { d.y = -d.len; d.x = Math.random() * canvas.width; }
            if (d.x < -20)                   { d.x = canvas.width; }
        }
        _prayerRainRAF = requestAnimationFrame(draw);
    };
    draw();
}

function stopPrayerRain() {
    if (_prayerRainRAF) { cancelAnimationFrame(_prayerRainRAF); _prayerRainRAF = null; }
    const canvas = document.getElementById('prayer-rain-canvas');
    if (!canvas) return;
    if (canvas._rainResizeHandler) {
        window.removeEventListener('resize', canvas._rainResizeHandler);
        canvas._rainResizeHandler = null;
    }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function updatePrayerOverlayTimer() {
    const pr = gameState.prayer;
    if (!pr.isOverlayActive) return;

    const elapsed = Date.now() - pr.overlayStartTime;
    const remaining = Math.max(0, pr.prayerLockMs - elapsed);
    const btn = document.getElementById('prayer-overlay-btn');
    const timerEl = document.getElementById('prayer-overlay-timer');

    if (remaining <= 0) {
        // Unlock
        if (btn) { btn.disabled = false; btn.classList.add('unlocked'); }
        if (timerEl) timerEl.textContent = '';
    } else {
        const m = Math.floor(remaining / 60000);
        const s = Math.floor((remaining % 60000) / 1000);
        if (timerEl) timerEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
    }
}

function dismissPrayerOverlay() {
    const pr = gameState.prayer;
    if (!pr.isOverlayActive) return;

    pr.isOverlayActive = false;

    // Resume timer — in solo pomo restore the frozen endTime and sync to Firebase;
    // in shared pomo the timer was never frozen, so endTime is already correct for everyone
    if (gameState.sharedPomo.phase !== 'active') {
        gameState.pomodoro.endTime = Date.now() + pr.pausedRemaining;
        if (gameState.pomodoro.laptopId !== null) {
            const updates = {};
            updates[lobbyPath(`pomodoro/${gameState.pomodoro.laptopId}/endTime`)] = gameState.pomodoro.endTime;
            update(ref(database), updates);
        }
    }

    // If the coop pomo transitioned to 'wait' (kidnap pending) while prayer was up,
    // the kidnap animation was blocked. Trigger it now that prayer is dismissed.
    if (gameState.sharedPomo.phase === 'active' &&
        gameState.pomodoro.phase === 'wait' &&
        !gameState.anim.active) {
        const _kLaptop = gameState.laptops.find(l => l.id === gameState.pomodoro.laptopId);
        if (_kLaptop) startKidnapAnimation(_kLaptop);
    }

    // Stop athan if still playing
    try { gameState.sounds.prayerCall.pause(); gameState.sounds.prayerCall.currentTime = 0; } catch (e) {}
    try { gameState.prayer._webAudioAthanSource?.stop(); } catch (e) {}
    gameState.prayer._webAudioAthanSource = null;

    // Fade focus sounds + YT back in
    const _inWorkPhase = gameState.pomodoro.phase === 'work'
        || (gameState.freeMode.active && gameState.freeMode.phase === 'work');
    if (gameState.focusAudioEngine && _inWorkPhase) {
        gameState.focusAudioEngine.fadeToMaster(1.0, 2.0);
        if (gameState.focusYTPlayer) {
            const targetPct = gameState.focusYTPlayer.volume ?? 80;
            gameState.focusYTPlayer.setVolumePercent(0);
            gameState.focusYTPlayer.resume().then(() => {
                let elapsed = 0;
                const iv = setInterval(() => {
                    elapsed += 50;
                    gameState.focusYTPlayer.setVolumePercent(Math.min(targetPct, Math.round(targetPct * elapsed / 2000)));
                    if (elapsed >= 2000) clearInterval(iv);
                }, 50);
            }).catch(() => { gameState.focusYTPlayer.setVolumePercent(targetPct); });
        }
    }

    // Fade out overlay, then fully hide and stop rain
    const _ov = document.getElementById('prayer-overlay');
    if (_ov) {
        _ov.classList.remove('active');
        setTimeout(() => {
            _ov.classList.add('hidden');
            stopPrayerRain();
        }, 880);
    }

    // Recalculate next prayer
    pr.overlayPrayer = null;
    computeNextPrayer();
    updatePrayerPanelDOM();
}

// ── UI wiring ────────────────────────────────────────────────────────────────

function setupPrayerUI() {
    // Setup button → open location modal
    document.getElementById('prayer-setup-btn')?.addEventListener('click', () => {
        document.getElementById('prayer-loc-modal')?.classList.remove('hidden');
    });

    // Edit button → open edit modal
    document.getElementById('prayer-edit-btn')?.addEventListener('click', () => {
        openPrayerEditModal();
    });

    // Overlay dismiss button
    document.getElementById('prayer-overlay-btn')?.addEventListener('click', () => {
        if (!document.getElementById('prayer-overlay-btn')?.disabled) {
            dismissPrayerOverlay();
        }
    });

    // "قراءة أذكار الصلاة؟" — open the post-salah azkar overlay ON TOP of the prayer
    // overlay. It doesn't resume the timer; only pressing انتهيت (which closes both
    // overlays) does that, returning to a normal work session.
    document.getElementById('prayer-azkar-btn')?.addEventListener('click', () => {
        if (gameState.azkar && gameState.azkar.active) return;
        openAzkarOverlay('morning', { afterPrayer: true });
    });

    // Location modal
    setupPrayerLocationModal();

    // Change location from edit modal
    document.getElementById('prayer-change-loc')?.addEventListener('click', () => {
        document.getElementById('prayer-edit-modal')?.classList.add('hidden');
        document.getElementById('prayer-loc-modal')?.classList.remove('hidden');
    });
}

function setupPrayerLocationModal() {
    const modal = document.getElementById('prayer-loc-modal');
    const closeBtn = document.getElementById('prayer-loc-close');
    const autoBtn = document.getElementById('prayer-loc-auto');
    const manualBtn = document.getElementById('prayer-loc-manual-btn');
    const manualDiv = document.getElementById('prayer-loc-manual');
    const countrySel = document.getElementById('prayer-country-select');
    const citySel = document.getElementById('prayer-city-select');
    const saveBtn = document.getElementById('prayer-loc-save');
    const statusEl = document.getElementById('prayer-loc-status');

    if (!modal) return;

    closeBtn?.addEventListener('click', () => modal.classList.add('hidden'));

    // Populate country select
    if (countrySel) {
        for (const c of PRAYER_LOCATIONS) {
            const opt = document.createElement('option');
            opt.value = c.country;
            opt.textContent = c.country;
            countrySel.appendChild(opt);
        }
    }

    // Auto location — try browser geolocation first, then IP-based fallback
    autoBtn?.addEventListener('click', async () => {
        if (statusEl) statusEl.textContent = 'جارٍ تحديد الموقع…';

        // Helper: reverse geocode lat/lon to city name
        const reverseGeocode = async (lat, lon) => {
            try {
                const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=ar`);
                const j = await r.json();
                const city = j.address?.city || j.address?.town || j.address?.village || j.address?.state || 'تلقائي';
                const country = j.address?.country || 'تلقائي';
                return { city, country };
            } catch { return { city: 'تلقائي', country: 'تلقائي' }; }
        };

        // Try browser geolocation
        const tryBrowserGeo = () => new Promise((resolve, reject) => {
            if (!navigator.geolocation) return reject('unsupported');
            navigator.geolocation.getCurrentPosition(
                (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
                (err) => reject(err),
                { timeout: 8000, enableHighAccuracy: false }
            );
        });

        // Try IP-based geolocation
        const tryIpGeo = async () => {
            const r = await fetch('https://ipapi.co/json/');
            const j = await r.json();
            if (j.latitude && j.longitude) return { lat: j.latitude, lon: j.longitude, city: j.city || 'تلقائي', country: j.country_name || 'تلقائي' };
            throw new Error('IP geo failed');
        };

        try {
            let coords, city, country;
            try {
                coords = await tryBrowserGeo();
                const names = await reverseGeocode(coords.lat, coords.lon);
                city = names.city; country = names.country;
            } catch {
                // Fallback to IP geolocation
                const ipResult = await tryIpGeo();
                coords = { lat: ipResult.lat, lon: ipResult.lon };
                city = ipResult.city; country = ipResult.country;
            }
            const loc = { city, country };
            loc._lat = coords.lat; loc._lon = coords.lon;
            // Only city/country are saved to Firebase; lat/lon stay in memory
            // for this session's accurate API calls (privacy: never persist coords).
            savePrayerLocation(loc);
            modal.classList.add('hidden');
            if (statusEl) statusEl.textContent = '';
        } catch (e) {
            if (statusEl) statusEl.textContent = 'فشل تحديد الموقع — جرب الاختيار اليدوي';
        }
    });

    // Manual toggle
    manualBtn?.addEventListener('click', () => {
        manualDiv?.classList.remove('hidden');
    });

    // Country change → populate cities
    countrySel?.addEventListener('change', () => {
        const sel = PRAYER_LOCATIONS.find(c => c.country === countrySel.value);
        if (!sel || !citySel) return;
        citySel.innerHTML = '<option value="">اختر المدينة</option>';
        for (const city of sel.cities) {
            const opt = document.createElement('option');
            opt.value = city.name;
            opt.textContent = city.name;
            opt.dataset.lat = city.lat;
            opt.dataset.lon = city.lon;
            citySel.appendChild(opt);
        }
        citySel.classList.remove('hidden');
        saveBtn?.classList.add('hidden');
    });

    // City change → show save
    citySel?.addEventListener('change', () => {
        if (citySel.value) saveBtn?.classList.remove('hidden');
    });

    // Save — only city/country saved to Firebase, lat/lon kept in memory for API
    saveBtn?.addEventListener('click', () => {
        const opt = citySel?.selectedOptions[0];
        if (!opt || !opt.dataset.lat) return;
        const loc = {
            city: opt.value,
            country: countrySel?.value || '',
            // Keep lat/lon in memory only for accurate API call
            _lat: parseFloat(opt.dataset.lat),
            _lon: parseFloat(opt.dataset.lon),
        };
        savePrayerLocation(loc);
        modal.classList.add('hidden');
    });
}

function savePrayerLocation(loc) {
    gameState.prayer.location = loc;
    gameState.prayer.lastFetchDate = null; // force re-fetch
    gameState.prayer._sirajOverrideApplied = false;
    // Privacy: ONLY city + country are ever written to Firebase. Exact lat/lon are
    // never persisted — they stay in memory (loc._lat/_lon) for this session only.
    // `set` (not update) replaces the whole node so any legacy lat/lon is wiped.
    const fbData = { city: loc.city || '', country: loc.country || '' };
    set(ref(database, `users/${gameState.userId}/prayerLocation`), fbData);
    document.getElementById('prayer-blur-overlay')?.classList.add('hidden');
    fetchPrayerTimes();
}

// ── Edit modal ───────────────────────────────────────────────────────────────

function openPrayerEditModal() {
    const pr = gameState.prayer;
    if (!pr.times) return;
    const modal = document.getElementById('prayer-edit-modal');
    const rowsDiv = document.getElementById('prayer-edit-rows');
    if (!modal || !rowsDiv) return;

    rowsDiv.innerHTML = '';
    const adj = { ...pr.adjustments };

    for (const p of PRAYER_DATA) {
        const baseTime = pr.times[p.key];
        const cur = adj[p.key] || 0;
        const row = document.createElement('div');
        row.className = 'prayer-edit-row';
        row.innerHTML = `
            <span class="pe-name">${p.arabic}</span>
            <span class="pe-time">${baseTime}</span>
            <div class="pe-adj">
                <button class="pe-minus">−</button>
                <span class="pe-adj-val" data-key="${p.key}">${cur >= 0 ? '+' : ''}${cur}</span>
                <button class="pe-plus">+</button>
            </div>`;
        row.querySelector('.pe-minus').addEventListener('click', () => {
            adj[p.key] = (adj[p.key] || 0) - 1;
            row.querySelector('.pe-adj-val').textContent = `${adj[p.key] >= 0 ? '+' : ''}${adj[p.key]}`;
        });
        row.querySelector('.pe-plus').addEventListener('click', () => {
            adj[p.key] = (adj[p.key] || 0) + 1;
            row.querySelector('.pe-adj-val').textContent = `${adj[p.key] >= 0 ? '+' : ''}${adj[p.key]}`;
        });
        rowsDiv.appendChild(row);
    }

    document.getElementById('prayer-edit-save')?.addEventListener('click', () => {
        gameState.prayer.adjustments = adj;
        update(ref(database), { [`users/${gameState.userId}/prayerAdjustments`]: adj });
        computeNextPrayer();
        updatePrayerPanelDOM();
        modal.classList.add('hidden');
    }, { once: true });

    document.getElementById('prayer-edit-cancel')?.addEventListener('click', () => {
        modal.classList.add('hidden');
    }, { once: true });

    document.getElementById('prayer-edit-close')?.addEventListener('click', () => {
        modal.classList.add('hidden');
    });

    modal.classList.remove('hidden');
}

// ── Tick from game loop ──────────────────────────────────────────────────────
// Called from the main game loop (updateLoop) every frame

function updatePrayerSystem() {
    tickPrayerPanel();
}

// ═════════════════════════════════════════════════════════════════════════════
// AZKAR (Morning / Evening remembrance) System
// ═════════════════════════════════════════════════════════════════════════════

// Each item: { text, highlight, count }
// `highlight` is the leading phrase rendered in bold; `text` is the rest of the zikr.
// `count` is repetition (1 unless specified). For "مائة مرة أو أكثر" we default to 100.
const AZKAR_MORNING = [
    { highlight: 'قراءة آية الكرسي:', text: '{اللهُ لَا إِلَهَ إِلَّا هُوَ الْحَيُّ الْقَيُّومُ لَا تَأْخُذُهُ سِنَةٌ وَلَا نَوْمٌ لَهُ مَا فِي السَّمَاوَاتِ وَمَا فِي الْأَرْضِ مَنْ ذَا الَّذِي يَشْفَعُ عِنْدَهُ إِلَّا بِإِذْنِهِ يَعْلَمُ مَا بَيْنَ أَيْدِيهِمْ وَمَا خَلْفَهُمْ وَلَا يُحِيطُونَ بِشَيْءٍ مِنْ عِلْمِهِ إِلَّا بِمَا شَاءَ وَسِعَ كُرْسِيُّهُ السَّمَاوَاتِ وَالْأَرْضَ وَلَا يَؤُودُهُ حِفْظُهُمَا وَهُوَ الْعَلِيُّ الْعَظِيمُ} (البقرة:255).' , count: 1 },
    { highlight: '', text: 'أصبحنا على فطرة الإسلام وكلِمة الإخلاص، ودين نبينا محمد ﷺ، ومِلَّةِ أبينا إبراهيم، حنيفاً مسلماً، وما كان من المشركين.', count: 1 },
    { highlight: '', text: 'رضيت بالله رباً، وبالإسلام ديناً، وبمحمد ﷺ نبياً.', count: 1 },
    { highlight: '', text: 'اللهم إني أسألك علماً نافعاً، ورزقاً طيباً، وعملاً متقبلاً.', count: 1 },
    { highlight: '', text: 'اللهم بك أصبحنا، وبك أمسينا، وبك نحيا، وبك نموت، وإليك النشور.', count: 1 },
    { highlight: '', text: 'لا إله إلا الله وحده، لا شريك له، له الملك، وله الحمد، وهو على كل شيء قدير.', count: 1 },
    { highlight: '', text: 'يا حيُّ يا قيوم برحمتك أستغيثُ، أصلح لي شأني كله، ولا تَكلني إلى نفسي طَرْفَةَ عينٍ أبدًا.', count: 1 },
    { highlight: 'سيد الاستغفار:', text: 'اللهم أنت ربي، لا إله إلا أنت، خلقتني وأنا عبدُك، وأنا على عهدِك ووعدِك ما استطعتُ، أعوذ بك من شر ما صنعتُ، أبوءُ لَكَ بنعمتكَ عليّ، وأبوء بذنبي، فاغفر لي، فإنه لا يغفرُ الذنوب إلا أنت.', count: 1 },
    { highlight: '', text: 'اللهم فاطر السموات والأرض، عالم الغيب والشهادة، رب كل شيء ومليكه، أشهد أن لا إله إلا أنت، أعوذ بك من شر نفسي، ومن شر الشيطان وشركه، وأن أقترف على نفسي سوءاً، أو أجره إلى مسلم.', count: 1 },
    { highlight: '', text: 'أصبحنا وأصبح الملك لله، والحمد لله، ولا إله إلا الله وحده لا شريك له، له الملك وله الحمد، وهو على كل شيء قدير، أسألك خير ما في هذا اليوم، وخير ما بعده، وأعوذ بك من شر هذا اليوم، وشر ما بعده، وأعوذ بك من الكسل وسوء الكِبَر، وأعوذ بك من عذاب النار وعذاب القبر.', count: 1 },
    { highlight: '', text: 'اللهم إني أسألك العفو والعافية في الدنيا والآخرة، اللهم إني أسألك العفو والعافية في ديني ودنياي وأهلي ومالي، اللهم استر عوراتي، وآمن روعاتي، واحفظني من بين يدي، ومن خلفي، وعن يميني، وعن شمالي، ومن فوقي، وأعوذ بك أن أُغتال من تحتي.', count: 1 },
    { highlight: '', text: 'بسم الله الذي لا يضر مع اسمه شيءٌ في الأرض ولا في السماء، وهو السميع العليم.', count: 3 },
    { highlight: '', text: 'سبحان الله عدد خلقه، سبحان الله رضا نفسه، سبحان الله زنة عرشه، سبحان الله مداد كلماته.', count: 3 },
    { highlight: '', text: 'اللهم عافني في بدني، اللهم عافني في سمعي، اللهم عافني في بصري، لا إله إلا أنت. اللهم إني أعوذ بك من الكفر والفقر، اللهم إني أعوذ بك من عذاب القبر، لا إله إلا أنت.', count: 3 },
    { highlight: '', text: 'قراءة سور: الإخلاص، والفلق، والناس.', count: 3 },
    { highlight: '', text: '{حسبي الله لا إله إلا هو عليه توكلت وهو رب العرش العظيم} (التوبة:129).', count: 7 },
    { highlight: '', text: 'اللهم إني أصبحت أُشهدك، وأُشهد حملة عرشك، وملائكتك، وجميع خلقك أنك أنت الله، وحدك لا شريك لك، وأن محمداً عبدك ورسولك.', count: 4 },
    { highlight: '', text: 'لا إله إلا الله وحده، لا شريك له، له الملك، وله الحمد، يحيي ويميت، وهو على كل شيء قدير.', count: 10 },
    { highlight: '', text: 'سبحان الله العظيم وبحمده.', count: 100 },
    { highlight: '', text: 'أستغفر الله.', count: 100 },
    { highlight: '', text: 'سبحان الله، والحمد لله، والله أكبر، لا إله إلا الله وحده، لا شريك له، له الملك، وله الحمد، وهو على كل شيء قدير.', count: 100 },
];

const AZKAR_EVENING = [
    { highlight: 'قراءة آية الكرسي:', text: '{اللهُ لَا إِلَهَ إِلَّا هُوَ الْحَيُّ الْقَيُّومُ لَا تَأْخُذُهُ سِنَةٌ وَلَا نَوْمٌ لَهُ مَا فِي السَّمَاوَاتِ وَمَا فِي الْأَرْضِ مَنْ ذَا الَّذِي يَشْفَعُ عِنْدَهُ إِلَّا بِإِذْنِهِ يَعْلَمُ مَا بَيْنَ أَيْدِيهِمْ وَمَا خَلْفَهُمْ وَلَا يُحِيطُونَ بِشَيْءٍ مِنْ عِلْمِهِ إِلَّا بِمَا شَاءَ وَسِعَ كُرْسِيُّهُ السَّمَاوَاتِ وَالْأَرْضَ وَلَا يَؤُودُهُ حِفْظُهُمَا وَهُوَ الْعَلِيُّ الْعَظِيمُ} (البقرة:255).', count: 1 },
    { highlight: '', text: 'أمسينا على فطرة الإسلام وكلِمة الإخلاص، ودين نبينا محمد ﷺ، ومِلَّةِ أبينا إبراهيم، حنيفاً مسلماً، وما كان من المشركين.', count: 1 },
    { highlight: '', text: 'رضيت بالله رباً، وبالإسلام ديناً، وبمحمد ﷺ نبياً.', count: 1 },
    { highlight: '', text: 'اللهم بك أمسينا، وبك أصبحنا، وبك نحيا، وبك نموت، وإليك المصير.', count: 1 },
    { highlight: '', text: 'لا إله إلا الله وحده، لا شريك له، له الملك، وله الحمد، وهو على كل شيء قدير.', count: 1 },
    { highlight: '', text: 'يا حيُّ يا قيوم برحمتك أستغيثُ، أصلح لي شأني كله، ولا تَكلني إلى نفسي طَرْفَةَ عينٍ أبدًا.', count: 1 },
    { highlight: 'سيد الاستغفار:', text: 'اللهم أنت ربي، لا إله إلا أنت، خلقتني وأنا عبدُك، وأنا على عهدِك ووعدِك ما استطعتُ، أعوذ بك من شر ما صنعتُ، أبوءُ لَكَ بنعمتكَ عليّ، وأبوء بذنبي، فاغفر لي، فإنه لا يغفرُ الذنوب إلا أنت.', count: 1 },
    { highlight: '', text: 'اللهم فاطر السموات والأرض، عالم الغيب والشهادة، رب كل شيء ومليكه، أشهد أن لا إله إلا أنت، أعوذ بك من شر نفسي، ومن شر الشيطان وشركه، وأن أقترف على نفسي سوءاً، أو أجره إلى مسلم.', count: 1 },
    { highlight: '', text: 'أمسينا وأمسى الملك لله، والحمد لله، لا إله إلا الله وحده لا شريك له، اللهم إني أسألك من خير ما في هذه الليلة، وخير ما بعدها، اللهم إني أعوذ بك من شر هذه الليلة وشر ما بعدها، اللهم إني أعوذ بك من الكسل وسوء الكِبَر، وأعوذ بك من عذاب في النار وعذاب في القبر.', count: 1 },
    { highlight: '', text: 'اللهم إني أسألك العفو والعافية في الدنيا والآخرة، اللهم إني أسألك العفو والعافية في ديني ودنياي وأهلي ومالي، اللهم استر عوراتي، وآمن روعاتي، واحفظني من بين يدي، ومن خلفي، وعن يميني، وعن شمالي، ومن فوقي، وأعوذ بك أن أُغتال من تحتي.', count: 1 },
    { highlight: '', text: 'بسم الله الذي لا يضر مع اسمه شيءٌ في الأرض ولا في السماء، وهو السميع العليم.', count: 3 },
    { highlight: '', text: 'أعوذ بكلمات الله التامَّات من شر ما خلق.', count: 3 },
    { highlight: '', text: 'اللهم عافني في بدني، اللهم عافني في سمعي، اللهم عافني في بصري، لا إله إلا أنت. اللهم إني أعوذ بك من الكفر والفقر، اللهم إني أعوذ بك من عذاب القبر، لا إله إلا أنت.', count: 3 },
    { highlight: '', text: 'قراءة سور: الإخلاص، والفلق، والناس.', count: 3 },
    { highlight: '', text: '{حسبي الله لا إله إلا هو عليه توكلت وهو رب العرش العظيم} (التوبة:129).', count: 7 },
    { highlight: '', text: 'اللهم إني أمسيت أُشهدك، وأُشهد حملة عرشك، وملائكتك، وجميع خلقك، أنك أنت الله، وحدك لا شريك لك، وأن محمداً عبدك ورسولك.', count: 4 },
    { highlight: '', text: 'لا إله إلا الله وحده، لا شريك له، له الملك، وله الحمد، يحيي ويميت، وهو على كل شيء قدير.', count: 10 },
    { highlight: '', text: 'سبحان الله العظيم وبحمده.', count: 100 },
    { highlight: '', text: 'أستغفر الله.', count: 100 },
    { highlight: '', text: 'سبحان الله، والحمد لله، والله أكبر، لا إله إلا الله وحده، لا شريك له، له الملك، وله الحمد، وهو على كل شيء قدير.', count: 100 },
];

// أذكار بعد الصلاة — opened from the prayer overlay after dismissing the athan.
const AZKAR_AFTER_PRAYER = [
    { highlight: '', text: 'أَسْتَغْفِرُ اللَّهَ (ثَلاَثَاً)، اللَّهُمَّ أَنْتَ السَّلاَمُ، وَمِنْكَ السَّلاَمُ، تَبَارَكْتَ يَا ذَا الْجَلاَلِ وَالْإِكْرَامِ.', count: 3 },
    { highlight: '', text: 'لاَ إِلَهَ إِلاَّ اللَّهُ وَحْدَهُ لاَ شَرِيكَ لَهُ، لَهُ الْمُلْكُ وَلَهُ الْحَمْدُ وَهُوَ عَلَى كُلِّ شَيْءٍ قَدِيرٌ، اللَّهُمَّ لاَ مَانِعَ لِمَا أَعْطَيْتَ، وَلاَ مُعْطِيَ لِمَا مَنَعْتَ، وَلاَ يَنْفَعُ ذَا الْجَدِّ مِنْكَ الجَدُّ.', count: 3 },
    { highlight: '', text: 'لَا إِلَهَ إِلاَّ اللَّهُ وَحْدَهُ لاَ شَرِيكَ لَهُ، لَهُ الْمُلْكُ، وَلَهُ الْحَمدُ، وَهُوَ عَلَى كُلِّ شَيْءٍ قَدِيرٌ. لاَ حَوْلَ وَلاَ قُوَّةَ إِلاَّ بِاللَّهِ، لاَ إِلَهَ إِلاَّ اللَّهُ، وَلاَ نَعْبُدُ إِلاَّ إِيَّاهُ، لَهُ النِّعْمَةُ وَلَهُ الْفَضْلُ وَلَهُ الثَّنَاءُ الْحَسَنُ، لَا إِلَهَ إِلاَّ اللَّهُ مُخْلِصِينَ لَهُ الدِّينَ وَلَوْ كَرِهَ الكَافِرُونَ.', count: 1 },
    { highlight: '', text: 'سُبْحَانَ اللَّهِ، وَالْحَمْدُ لِلَّهِ، وَاللَّهُ أَكْبَرُ (ثلاثاً وثلاثين)، ثُمَّ: لاَ إِلَهَ إِلاَّ اللَّهُ وَحْدَهُ لاَ شَرِيكَ لَهُ، لَهُ الْمُلْكُ وَلَهُ الْحَمْدُ وَهُوَ عَلَى كُلِّ شَيْءٍ قَدِيرٌ.', count: 33 },
    { highlight: 'بعد كل صلاة:', text: 'بِسْمِ اللهِ الرَّحْمَنِ الرَّحِيمِ ﴿قُلْ هُوَ اللَّهُ أَحَدٌ * اللَّهُ الصَّمَدُ * لَمْ يَلِدْ وَلَمْ يُولَدْ * وَلَمْ يَكُن لَّهُ كُفُواً أَحَدٌ﴾، ﴿قُلْ أَعُوذُ بِرَبِّ الْفَلَقِ * مِن شَرِّ مَا خَلَقَ * وَمِن شَرِّ غَاسِقٍ إِذَا وَقَبَ * وَمِن شَرِّ النَّفَّاثَاتِ فِي الْعُقَدِ * وَمِن شَرِّ حَاسِدٍ إِذَا حَسَدَ﴾، ﴿قُلْ أَعُوذُ بِرَبِّ النَّاسِ * مَلِكِ النَّاسِ * إِلَهِ النَّاسِ * مِن شَرِّ الْوَسْوَاسِ الْخَنَّاسِ * الَّذِي يُوَسْوِسُ فِي صُدُورِ النَّاسِ * مِنَ الْجِنَّةِ وَالنَّاسِ﴾.', count: 1 },
    { highlight: 'آية الكرسي عقب كل صلاة:', text: '﴿اللَّهُ لاَ إِلَهَ إِلاَّ هُوَ الْحَيُّ الْقَيُّومُ لاَ تَأْخُذُهُ سِنَةٌ وَلاَ نَوْمٌ، لَّهُ مَا فِي السَّمَوَاتِ وَمَا فِي الأَرْضِ، مَن ذَا الَّذِي يَشْفَعُ عِنْدَهُ إِلاَّ بِإِذْنِهِ، يَعْلَمُ مَا بَيْنَ أَيْدِيهِمْ وَمَا خَلْفَهُمْ، وَلاَ يُحِيطُونَ بِشَيْءٍ مِّنْ عِلْمِهِ إِلاَّ بِمَا شَاءَ، وَسِعَ كُرْسِيُّهُ السَّمَوَاتِ وَالأَرْضَ، وَلاَ يَؤُودُهُ حِفْظُهُمَا، وَهُوَ الْعَلِيُّ الْعَظِيمُ﴾.', count: 1 },
    { highlight: 'عشر مرات بعد المغرب والصبح:', text: 'لاَ إِلَهَ إِلاَّ اللَّهُ وَحْدَهُ لاَ شَرِيكَ لَهُ، لَهُ الْمُلْكُ وَلَهُ الْحَمْدُ يُحْيِي وَيُمِيتُ وَهُوَ عَلَى كُلِّ شَيْءٍ قَدِيرٌ.', count: 10 },
    { highlight: 'بعد السلام من صلاة الفجر:', text: 'اللَّهُمَّ إِنِّي أَسْأَلُكَ عِلْماً نافِعاً، وَرِزْقاً طَيِّباً، وَعَمَلاً مُتَقَبَّلاً.', count: 1 },
];

// Fallback prayer windows for Cairo when no location yet (approximate year-round)
const AZKAR_FALLBACK_TIMES = { Fajr: '04:30', Dhuhr: '12:00', Asr: '15:30', Maghrib: '18:00', Isha: '19:30' };

// Siraj-only: fake current time for testing azkar windows (cleared on page unload / logout)
let _azkarFakeHour = null; // 0-23, or null = use real time
let _azkarFakeMin  = null;

// Returns 'morning' (Fajr→Dhuhr), 'evening' (Asr→Isha), or null
function getCurrentAzkarType() {
    const times = (gameState.prayer && gameState.prayer.times) ? gameState.prayer.times : AZKAR_FALLBACK_TIMES;
    const toMin = (s) => { if (!s) return null; const [h, m] = s.split(':').map(Number); return h * 60 + m; };
    const fajr  = toMin(times.Fajr);
    const dhuhr = toMin(times.Dhuhr);
    const asr   = toMin(times.Asr);
    const isha  = toMin(times.Isha);
    if (fajr == null || dhuhr == null || asr == null || isha == null) return null;
    let cur;
    if (_azkarFakeHour !== null) {
        cur = _azkarFakeHour * 60 + (_azkarFakeMin || 0);
    } else {
        const now = new Date();
        cur = now.getHours() * 60 + now.getMinutes();
    }
    if (cur >= fajr && cur < dhuhr) return 'morning';
    if (cur >= asr && cur < isha)   return 'evening';
    return null;
}

function _todayDateStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function updateAzkarButton() {
    const btn = document.getElementById('azkar-btn');
    if (!btn) return;

    // Throttle to ~1/s (called from main loop)
    const now = Date.now();
    if (now - gameState.azkar._lastButtonRefresh < 1000) return;
    gameState.azkar._lastButtonRefresh = now;

    const type = getCurrentAzkarType();
    const inSharedPomo = gameState.sharedPomo && gameState.sharedPomo.phase && gameState.sharedPomo.phase !== 'idle';
    const inPrayerOverlay = gameState.prayer && gameState.prayer.isOverlayActive;
    const azkarOpen = gameState.azkar.active;
    const today = _todayDateStr();
    const doneToday = type && gameState.azkar.completed && gameState.azkar.completed[type] === today;

    // Gate on _completionLoaded so the button never flashes on start before we've
    // checked Firebase (it used to show, then snap away once "already read" loaded).
    const az = gameState.azkar;
    const shouldShow = az._completionLoaded
        && !!type && !inSharedPomo && !inPrayerOverlay && !azkarOpen && !doneToday;

    const wasShown = az._btnShown === true;
    if (shouldShow && !wasShown) {
        // Appear — fade/scale in.
        if (az._btnHideTimer) { clearTimeout(az._btnHideTimer); az._btnHideTimer = null; }
        btn.classList.remove('hidden', 'azkar-leaving');
        btn.classList.add('azkar-entering');
        setTimeout(() => btn.classList.remove('azkar-entering'), 380);
        az._btnShown = true;
    } else if (!shouldShow && wasShown) {
        // Disappear — fade/scale out, THEN collapse (display:none) so it never snaps.
        btn.classList.remove('azkar-entering');
        btn.classList.add('azkar-leaving');
        if (az._btnHideTimer) clearTimeout(az._btnHideTimer);
        az._btnHideTimer = setTimeout(() => {
            btn.classList.add('hidden');
            btn.classList.remove('azkar-leaving');
            az._btnHideTimer = null;
        }, 340);
        az._btnShown = false;
    } else if (!shouldShow && !wasShown && !az._btnHideTimer) {
        // Steady hidden (incl. initial state) — no animation.
        btn.classList.add('hidden');
    }

    if (!shouldShow) {
        hideAzkarConfirm();
    }

    const label = document.getElementById('azkar-btn-label');
    if (shouldShow) {
        if (type === 'morning') {
            btn.classList.add('morning'); btn.classList.remove('evening');
            if (label) label.textContent = 'أذكار الصباح';
        } else {
            btn.classList.add('evening'); btn.classList.remove('morning');
            if (label) label.textContent = 'أذكار المساء';
        }
    }

    // Mobile floating button: show when card is focus-hidden and azkar conditions are met
    const floatBtn = document.getElementById('azkar-focus-float-btn');
    if (floatBtn && isMobile()) {
        const cardHidden = document.getElementById('user-card')?.classList.contains('focus-hidden');
        const floatShouldShow = shouldShow && !!cardHidden;
        // Use style.display directly — avoids any CSS class specificity issues
        floatBtn.style.display = floatShouldShow ? 'flex' : 'none';
        if (floatShouldShow && type) {
            floatBtn.textContent = type === 'morning' ? 'أذكار الصباح' : 'أذكار المساء';
            floatBtn.classList.toggle('morning', type === 'morning');
            floatBtn.classList.toggle('evening', type === 'evening');
        }
    } else if (floatBtn) {
        floatBtn.style.display = 'none'; // always hidden on desktop
    }
}

function showAzkarConfirm() {
    const type = getCurrentAzkarType();
    const modal = document.getElementById('azkar-confirm-modal');
    if (!modal) return;
    const typeEl = document.getElementById('azkar-confirm-modal-type');
    if (typeEl) typeEl.textContent = type === 'morning' ? 'أذكار الصباح' : 'أذكار المساء';
    modal.classList.remove('hidden');
}
function hideAzkarConfirm() {
    document.getElementById('azkar-confirm-modal')?.classList.add('hidden');
}

function markAzkarCompleted(type) {
    const today = _todayDateStr();
    gameState.azkar.completed = gameState.azkar.completed || {};
    gameState.azkar.completed[type] = today;
    if (gameState.userId) {
        update(ref(database), { [`users/${gameState.userId}/azkarCompleted`]: gameState.azkar.completed }).catch(() => {});
    }
    gameState.azkar._lastButtonRefresh = 0;   // bypass the 1/s throttle so the fade-out fires now
    updateAzkarButton();
}

function loadAzkarCompletedFromFirebase() {
    if (!gameState.userId) return;
    get(ref(database, `users/${gameState.userId}/azkarCompleted`)).then(snap => {
        gameState.azkar.completed = snap.val() || {};
        gameState.azkar._completionLoaded = true;
        updateAzkarButton();
    }).catch(() => {
        // Offline / read failed — assume not-done so the button can still appear.
        gameState.azkar._completionLoaded = true;
        updateAzkarButton();
    });
}

// Fisher–Yates shuffle (returns a new array, leaves the source untouched).
function _shuffledCopy(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// opts.afterPrayer = post-salah azkar opened ON TOP of the prayer overlay; the
// prayer overlay already froze the timer + faded audio, so we DON'T touch them
// here (closeAzkarOverlay delegates the resume to dismissPrayerOverlay).
function openAzkarOverlay(type, opts) {
    const az = gameState.azkar;
    if (az.active) return;
    opts = opts || {};
    const afterPrayer = !!opts.afterPrayer;

    az.active = true;
    az.type = type;
    az.afterPrayer = afterPrayer;
    az.startTime = Date.now();
    az.currentIndex = 0;
    // Build the active list: custom (after-prayer) or the standard morning/evening
    // set, optionally shuffled if the user enabled "ترتيب الأذكار عشوائي".
    let baseList = afterPrayer ? AZKAR_AFTER_PRAYER
                 : (type === 'morning' ? AZKAR_MORNING : AZKAR_EVENING);
    az.items = (getRandomizeAzkar() && !afterPrayer) ? _shuffledCopy(baseList) : baseList.slice();
    az.counts = az.items.map(z => z.count);

    // Siraj: shorter lock for testing. After-prayer azkar: no forced wait — these
    // are short post-salah adhkar, so انتهيت is usable as soon as they're done.
    az.minLockMs = afterPrayer ? 0 : (gameState.isSirajGhost ? 3000 : 180000);

    document.body.classList.add('azkar-active');
    if (afterPrayer) document.body.classList.add('azkar-after-prayer');
    else document.body.classList.remove('azkar-after-prayer');
    document.body.classList.remove('azkar-sounds-collapsed'); // always start expanded
    const overlay = document.getElementById('azkar-overlay');
    if (overlay) {
        // After-prayer azkar uses the morning (sky-blue) look regardless of time.
        overlay.dataset.mode = afterPrayer ? 'morning' : type;
        overlay.classList.remove('hidden');
        requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('active')));
    }

    // ── Pause pomodoro / freeMode timers ──
    // After-prayer azkar skips this entirely — the prayer overlay already froze
    // everything and owns the resume when it's dismissed.
    if (!afterPrayer) {
        // Solo pomo: snapshot remaining ms (we'll keep extending endTime in update loop)
        if (gameState.pomodoro.active && gameState.sharedPomo.phase !== 'active') {
            az.pausedPomoRemaining = Math.max(0, gameState.pomodoro.endTime - Date.now());
            az.pausedPomoPhase = gameState.pomodoro.phase;
            // Push the frozen endTime to Firebase so other lobby members watching
            // this laptop don't see it expire while the user is in azkar.
            if (gameState.pomodoro.laptopId !== null) {
                update(ref(database), {
                    [lobbyPath(`pomodoro/${gameState.pomodoro.laptopId}/endTime`)]:
                        Date.now() + az.pausedPomoRemaining
                }).catch(() => {});
            }
        }
        // Free mode: snapshot accumulated work, freeze workStartTime
        if (gameState.freeMode.active) {
            const fm = gameState.freeMode;
            if (fm.phase === 'work' && fm.workStartTime > 0) {
                fm.totalWorkMs  += Date.now() - fm.workStartTime;
                fm.workStartTime = 0;
            }
            if (fm.phase === 'break') {
                az.pausedFreeWorkSnap = Math.max(0, fm.breakEndTime - Date.now());
            }
        }
    }

    // Stop player movement
    const _local = gameState.players[gameState.userId];
    if (_local) { _local.isMoving = false; _local.isSprinting = false; }
    if (gameState.joystick) { gameState.joystick.active = false; gameState.joystick.dx = 0; gameState.joystick.dy = 0; gameState.joystick.magnitude = 0; gameState.joystick.sprinting = false; }
    ['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','ShiftLeft','ShiftRight']
        .forEach(k => { if (gameState.keys) gameState.keys[k] = false; });

    // ── Stop YouTube (remember if was playing so we can restore) ──
    // After-prayer azkar: the prayer overlay already faded YT out and owns the
    // restore, so don't touch it here.
    if (!afterPrayer && gameState.focusYTPlayer) {
        try {
            const state = gameState.focusYTPlayer.player?.getPlayerState?.() ?? -1;
            az.ytWasPlaying = (state === 1 /* PLAYING */);
            az.ytVolumeBefore = gameState.focusYTPlayer.volume ?? 80;
        } catch (e) { az.ytWasPlaying = false; }
        gameState.focusYTPlayer.fadeOutAndPause(1200);
    }
    // Show "انتهي من أذكارك" overlay above YT
    if (!afterPrayer) document.getElementById('yt-azkar-overlay')?.classList.add('active');

    // On mobile: un-hide user card / logout if they were hidden by focus mode (we need an exit)
    az.focusMobileWasActive = document.body.classList.contains('mobile-focus-mode') ||
        document.querySelector('.user-card.focus-hidden') != null;

    // Block wheel events on the overlay so they don't zoom the game or scroll the page
    const _overlayEl = document.getElementById('azkar-overlay');
    if (_overlayEl && !_overlayEl._azkarWheelBlock) {
        _overlayEl._azkarWheelBlock = (e) => {
            // Allow scroll within the azkar list; block everything else
            if (!e.target.closest('.azkar-list')) {
                e.preventDefault();
            }
            e.stopPropagation();
        };
        _overlayEl.addEventListener('wheel', _overlayEl._azkarWheelBlock, { passive: false });
    }

    // Render & start lock timer
    renderAzkarList();
    // Reset scroll to top so first azkar is always visible
    const _listEl = document.getElementById('azkar-list');
    if (_listEl) _listEl.scrollTop = 0;
    updateAzkarFinishTimer();

    // The lock countdown must not depend on the rAF game loop — that loop is throttled
    // (or paused) in a backgrounded tab, which froze the انتهيت timer mid-count. A plain
    // interval keeps ticking (and unlocks) even when the tab isn't focused.
    if (az._lockInterval) clearInterval(az._lockInterval);
    az._lockInterval = setInterval(updateAzkarFinishTimer, 250);
}

function _ar(n) {
    const map = ['٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
    return String(n).split('').map(c => map[c] || c).join('');
}

function renderAzkarList() {
    const az = gameState.azkar;
    const listEl = document.getElementById('azkar-list');
    const titleEl = document.getElementById('azkar-title');
    const progEl = document.getElementById('azkar-progress');
    if (!listEl) return;

    const items = az.items;
    if (titleEl) titleEl.textContent = az.afterPrayer ? 'أذكار بعد الصلاة'
        : (az.type === 'morning' ? 'أذكار الصباح' : 'أذكار المساء');
    const completedCount = az.counts.filter(c => c === 0).length;
    if (progEl) progEl.textContent = `${_ar(completedCount)} / ${_ar(items.length)}`;

    listEl.innerHTML = '';
    items.forEach((z, i) => {
        const wrap = document.createElement('div');
        wrap.className = 'azkar-item';
        wrap.style.animationDelay = `${Math.min(i, 12) * 50}ms`;
        if (i === az.currentIndex) wrap.classList.add('current');
        if (az.counts[i] === 0) { wrap.classList.add('done'); wrap.classList.remove('current'); }

        const txt = document.createElement('div');
        txt.className = 'azkar-item-text';
        // Compose: bold highlight (if any), then the rest
        if (z.highlight && z.highlight.trim()) {
            const hi = document.createElement('span');
            hi.className = 'azkar-highlight';
            hi.textContent = z.highlight + ' ';
            txt.appendChild(hi);
        }
        txt.appendChild(document.createTextNode(z.text));
        wrap.appendChild(txt);

        const footer = document.createElement('div');
        footer.className = 'azkar-item-footer';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'azkar-count-btn';
        btn.dataset.idx = String(i);
        const remaining = az.counts[i];
        if (remaining > 0) {
            btn.textContent = _ar(remaining);
        } else {
            btn.classList.add('done');
            btn.textContent = '✓';
            btn.disabled = true;
        }
        btn.addEventListener('click', (e) => {
            if (document.body.classList.contains('is-mobile')) e.stopPropagation();
            onAzkarCountClick(i);
        });
        footer.appendChild(btn);
        wrap.appendChild(footer);

        // Mobile: tap anywhere on the row triggers the count, not just the tiny button
        wrap.addEventListener('click', () => {
            if (!document.body.classList.contains('is-mobile')) return;
            onAzkarCountClick(i);
        });

        listEl.appendChild(wrap);

        if (i < items.length - 1) {
            const sep = document.createElement('div');
            sep.className = 'azkar-sep';
            listEl.appendChild(sep);
        }
    });
}

function onAzkarCountClick(idx) {
    const az = gameState.azkar;
    if (!az.active) return;
    if (az.counts[idx] <= 0) return;
    az.counts[idx] -= 1;
    const items = az.items;
    const listEl = document.getElementById('azkar-list');
    const itemEls = listEl?.querySelectorAll('.azkar-item');
    if (!itemEls) return;
    const itemEl = itemEls[idx];
    const btn = itemEl?.querySelector('.azkar-count-btn');

    if (az.counts[idx] === 0) {
        // Mark done
        if (btn) { btn.classList.add('done'); btn.textContent = '✓'; btn.disabled = true; }
        itemEl?.classList.add('done');
        itemEl?.classList.remove('current');

        // Update progress label
        const progEl = document.getElementById('azkar-progress');
        const completedCount = az.counts.filter(c => c === 0).length;
        if (progEl) progEl.textContent = `${_ar(completedCount)} / ${_ar(items.length)}`;

        // Advance to next non-done index
        let next = idx + 1;
        while (next < items.length && az.counts[next] === 0) next++;
        if (next < items.length) {
            az.currentIndex = next;
            itemEls.forEach((el, j) => el.classList.toggle('current', j === next));
            // Smooth scroll to next — scroll ONLY the list, never let it bubble to the
            // overlay/page (scrollIntoView used to scroll the whole overlay down, which
            // looked like the overlay jumping when the list couldn't scroll on its own).
            const nextEl = itemEls[next];
            if (nextEl && listEl) {
                setTimeout(() => {
                    const lr = listEl.getBoundingClientRect();
                    const nr = nextEl.getBoundingClientRect();
                    const delta = (nr.top - lr.top) - (listEl.clientHeight / 2 - nr.height / 2);
                    const maxTop = listEl.scrollHeight - listEl.clientHeight;
                    const top = Math.max(0, Math.min(maxTop, listEl.scrollTop + delta));
                    listEl.scrollTo({ top, behavior: 'smooth' });
                }, 220);
            }
        }
    } else {
        if (btn) btn.textContent = _ar(az.counts[idx]);
    }
}

function updateAzkarFinishTimer() {
    const az = gameState.azkar;
    if (!az.active) return;
    const elapsed = Date.now() - az.startTime;
    const remaining = Math.max(0, az.minLockMs - elapsed);
    const btn = document.getElementById('azkar-finish-btn');
    const timerEl = document.getElementById('azkar-finish-timer');
    if (remaining <= 0) {
        if (btn) { btn.removeAttribute('disabled'); btn.classList.add('unlocked'); }
        if (timerEl) timerEl.textContent = '';
    } else {
        const m = Math.floor(remaining / 60000);
        const s = Math.floor((remaining % 60000) / 1000);
        if (timerEl) timerEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
        // Don't use disabled — it leaks taps on iOS. Use class only; click handler checks .unlocked.
        if (btn) { btn.removeAttribute('disabled'); btn.classList.remove('unlocked'); }
    }
}

function closeAzkarOverlay(markDone) {
    const az = gameState.azkar;
    if (!az.active) return;
    const wasAfterPrayer = az.afterPrayer;
    az.active = false;
    az.afterPrayer = false;

    // After-prayer azkar: the prayer overlay owns the timer/audio resume. Just fade
    // the azkar overlay out and then dismiss the prayer overlay (which un-freezes the
    // timer + fades focus sounds / YouTube back in → normal work session). Skip all
    // the solo/free resume logic below so we don't double-resume.
    if (wasAfterPrayer) {
        const overlay = document.getElementById('azkar-overlay');
        if (overlay) {
            overlay.classList.remove('active');
            setTimeout(() => { overlay.classList.add('hidden'); }, 700);
        }
        document.body.classList.remove('azkar-active');
        document.body.classList.remove('azkar-after-prayer');
        document.body.classList.remove('azkar-sounds-collapsed');
        if (az._lockInterval) { clearInterval(az._lockInterval); az._lockInterval = null; }
        az.type = null;
        az.items = [];
        // Dismiss the prayer overlay underneath — this resumes the work session.
        if (gameState.prayer && gameState.prayer.isOverlayActive) dismissPrayerOverlay();
        updateAzkarButton();
        return;
    }

    // Resume pomodoro endTime (solo)
    if (gameState.pomodoro.active && gameState.sharedPomo.phase !== 'active') {
        if (az.pausedPomoRemaining > 0) {
            gameState.pomodoro.endTime = Date.now() + az.pausedPomoRemaining;
            if (gameState.pomodoro.laptopId !== null) {
                const updates = {};
                updates[lobbyPath(`pomodoro/${gameState.pomodoro.laptopId}/endTime`)] = gameState.pomodoro.endTime;
                update(ref(database), updates).catch(() => {});
            }
        }
    }
    // Resume free-mode
    if (gameState.freeMode.active) {
        const fm = gameState.freeMode;
        if (fm.phase === 'work' && fm.workStartTime === 0) {
            fm.workStartTime = Date.now();
        }
        if (fm.phase === 'break' && az.pausedFreeWorkSnap > 0) {
            fm.breakEndTime = Date.now() + az.pausedFreeWorkSnap;
        }
    }

    // Restore YouTube
    document.getElementById('yt-azkar-overlay')?.classList.remove('active');
    if (gameState.focusYTPlayer && az.ytWasPlaying) {
        const targetPct = az.ytVolumeBefore || gameState.focusYTPlayer.volume || 80;
        try {
            gameState.focusYTPlayer.setVolumePercent(0);
            gameState.focusYTPlayer.resume().then(() => {
                let e = 0;
                const iv = setInterval(() => {
                    e += 50;
                    gameState.focusYTPlayer.setVolumePercent(Math.min(targetPct, Math.round(targetPct * e / 1500)));
                    if (e >= 1500) clearInterval(iv);
                }, 50);
            }).catch(() => { gameState.focusYTPlayer.setVolumePercent(targetPct); });
        } catch (e) {}
    }
    az.ytWasPlaying = false;

    // Fade out overlay
    const overlay = document.getElementById('azkar-overlay');
    if (overlay) {
        overlay.classList.remove('active');
        setTimeout(() => { overlay.classList.add('hidden'); }, 700);
    }
    document.body.classList.remove('azkar-active');

    if (markDone && az.type) markAzkarCompleted(az.type);

    // Stop the independent lock countdown
    if (az._lockInterval) { clearInterval(az._lockInterval); az._lockInterval = null; }

    // If the panel was used as a live mixer outside a work phase, fade master back
    // down so ambient sounds don't keep playing after azkar closes.
    const inWork = (gameState.pomodoro.active && gameState.pomodoro.phase === 'work')
        || (gameState.freeMode.active && gameState.freeMode.phase === 'work');
    if (gameState.focusAudioEngine && !inWork) gameState.focusAudioEngine.fadeToMaster(0, 0.6);

    // Reset the collapsed state so the panel is expanded next time
    document.body.classList.remove('azkar-sounds-collapsed');

    az.type = null;
    az.pausedPomoRemaining = 0;
    az.pausedFreeWorkSnap = 0;
    az.pausedPomoPhase = null;
    updateAzkarButton();
}

function setupAzkarTimePicker() {
    const spoofBtn = document.getElementById('azkar-time-spoof-btn');
    const modal    = document.getElementById('azkar-time-picker-modal');
    const hEl      = document.getElementById('azkar-tp-h');
    const mEl      = document.getElementById('azkar-tp-m');
    const preview  = document.getElementById('azkar-tp-preview');
    const setBtn   = document.getElementById('azkar-tp-set');
    const clearBtn = document.getElementById('azkar-tp-close-x'); // alias below
    const clearBtn2= document.getElementById('azkar-tp-clear');
    const closeBtn = document.getElementById('azkar-tp-close');
    if (!spoofBtn || !modal) return;

    let tpH = _azkarFakeHour !== null ? _azkarFakeHour : new Date().getHours();
    let tpM = _azkarFakeMin  !== null ? _azkarFakeMin  : new Date().getMinutes();

    function fmt2(n) { return String(n).padStart(2, '0'); }

    function _updatePreview() {
        hEl.textContent = fmt2(tpH);
        mEl.textContent = fmt2(tpM);
        // compute what azkar type this would yield using real prayer times
        const times = (gameState.prayer && gameState.prayer.times) ? gameState.prayer.times : AZKAR_FALLBACK_TIMES;
        const toMin = (s) => { if (!s) return null; const [h, m] = s.split(':').map(Number); return h * 60 + m; };
        const fajr  = toMin(times.Fajr);
        const dhuhr = toMin(times.Dhuhr);
        const asr   = toMin(times.Asr);
        const isha  = toMin(times.Isha);
        const cur   = tpH * 60 + tpM;
        let label = 'خارج النافذة';
        if (fajr != null && dhuhr != null && cur >= fajr && cur < dhuhr) label = 'أذكار الصباح 🌅';
        else if (asr != null && isha != null && cur >= asr && cur < isha)  label = 'أذكار المساء 🌙';
        preview.textContent = label;
    }

    function _open() {
        tpH = _azkarFakeHour !== null ? _azkarFakeHour : new Date().getHours();
        tpM = _azkarFakeMin  !== null ? _azkarFakeMin  : new Date().getMinutes();
        _updatePreview();
        modal.classList.remove('hidden');
        spoofBtn.classList.add('active');
    }
    function _close() {
        modal.classList.add('hidden');
        // Keep 'active' styling on the button when a fake time is in effect
        if (_azkarFakeHour === null) spoofBtn.classList.remove('active');
    }

    spoofBtn.addEventListener('click', (e) => { e.stopPropagation(); _open(); });

    modal.addEventListener('click', (e) => { if (e.target === modal) _close(); });
    closeBtn?.addEventListener('click', _close);

    // Arrow buttons
    modal.querySelectorAll('.azkar-tp-arrow').forEach(btn => {
        btn.addEventListener('click', () => {
            const field = btn.dataset.field;
            const isUp  = btn.classList.contains('azkar-tp-up');
            if (field === 'h') { tpH = (tpH + (isUp ? 1 : -1) + 24) % 24; }
            if (field === 'm') { tpM = (tpM + (isUp ? 5 : -5) + 60) % 60; }
            _updatePreview();
        });
    });

    // Scroll wheel — normalize by deltaMode so one physical click = one unit on any mouse
    const _scrollAcc = { h: 0, m: 0 };
    [hEl, mEl].forEach(el => {
        el.addEventListener('wheel', (e) => {
            e.preventDefault();
            const key = el === hEl ? 'h' : 'm';
            // Normalize: pixels(0)→as-is, lines(1)→×40, pages(2)→×800
            const norm = e.deltaMode === 0 ? e.deltaY : e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY * 800;
            _scrollAcc[key] += norm;
            if (Math.abs(_scrollAcc[key]) >= 40) {
                const dir = _scrollAcc[key] > 0 ? -1 : 1;
                _scrollAcc[key] = 0;
                if (key === 'h') tpH = (tpH + dir + 24) % 24;
                else             tpM = (tpM + dir + 60) % 60;
                _updatePreview();
            }
        }, { passive: false });
    });

    // Apply — also clears azkarCompleted so the button appears fresh for the new time window
    setBtn?.addEventListener('click', () => {
        _azkarFakeHour = tpH;
        _azkarFakeMin  = tpM;
        spoofBtn.title = `الوقت التجريبي: ${fmt2(tpH)}:${fmt2(tpM)}`;
        // Clear local completion state
        gameState.azkar.completed = {};
        // Clear from Firebase
        if (gameState.userId) {
            update(ref(database), { [`users/${gameState.userId}/azkarCompleted`]: null }).catch(() => {});
        }
        gameState.azkar._lastButtonRefresh = 0; // force immediate button refresh
        _close(); // _close keeps active class when fake time is set
    });

    // Clear fake time
    clearBtn2?.addEventListener('click', () => {
        _azkarFakeHour = null;
        _azkarFakeMin  = null;
        spoofBtn.title = 'تغيير الوقت (سراج)';
        spoofBtn.classList.remove('active');
        gameState.azkar._lastButtonRefresh = 0;
        _close();
    });
}

function setupAzkarUI() {
    // Both the regular button and the mobile float button open the confirm popup
    const _openConfirm = () => showAzkarConfirm();

    document.getElementById('azkar-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        _openConfirm();
    });

    // Mobile floating azkar button — also shows confirm modal (same flow on all devices)
    document.getElementById('azkar-focus-float-btn')?.addEventListener('click', () => {
        _openConfirm();
    });

    // Confirm modal buttons
    document.getElementById('azkar-confirm-modal-yes')?.addEventListener('click', () => {
        const type = getCurrentAzkarType();
        if (type) markAzkarCompleted(type);
        hideAzkarConfirm();
    });

    document.getElementById('azkar-confirm-modal-no')?.addEventListener('click', () => {
        const type = getCurrentAzkarType();
        hideAzkarConfirm();
        if (type) openAzkarOverlay(type);
    });

    // Clicking outside the modal box closes it
    document.getElementById('azkar-confirm-modal')?.addEventListener('click', (e) => {
        if (e.target === document.getElementById('azkar-confirm-modal')) hideAzkarConfirm();
    });

    document.getElementById('azkar-finish-btn')?.addEventListener('click', () => {
        const fb = document.getElementById('azkar-finish-btn');
        if (!fb?.classList.contains('unlocked')) return; // still locked
        closeAzkarOverlay(true);
    });

    // Hide / show the focus-sounds panel during azkar (smooth slide, CSS-driven)
    document.getElementById('azkar-sounds-hide')?.addEventListener('click', () => {
        document.body.classList.add('azkar-sounds-collapsed');
    });
    document.getElementById('azkar-sounds-show')?.addEventListener('click', () => {
        document.body.classList.remove('azkar-sounds-collapsed');
    });

    loadAzkarCompletedFromFirebase();

    // Show time-spoof button only for Siraj
    if (gameState.isSirajGhost) {
        document.getElementById('azkar-time-spoof-btn')?.classList.remove('hidden');
        setupAzkarTimePicker();
    }
}

// Called every frame; lightweight (button update is throttled, timer only when overlay open).
function updateAzkarSystem() {
    if (gameState.azkar.active) {
        updateAzkarFinishTimer();
    }
    updateAzkarButton();
}

// ─── Laptop Boss Fight Minigame ───────────────────────────────────────────────
// Single-player platformer boss fight. Mirrors the race/coffee minigame structure
// (Firebase session, teleport animation, return point) but the gameplay is local-only.

function laptopBossSessionPath(sub) {
    const k = gameState.laptopBoss.sessionKey;
    if (!k) return null;
    return lobbyPath(`minigames/laptop-boss/sessions/${k}${sub ? '/' + sub : ''}`);
}

function drawLaptopBossMachine() {
    if (!isBreakActive()) return;
    const ctx = gameState.ctx;
    const img = gameState.assets.laptopBossZone;
    if (!img || !img.complete || !img.naturalWidth) return;

    const cx = LAPTOP_BOSS_ZONE_CX;
    const cy = LAPTOP_BOSS_ZONE_CY;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    if (gameState.activeLaptopBossZone && !gameState.laptopBoss.teleportAnim) {
        ctx.shadowBlur  = 28;
        ctx.shadowColor = 'rgba(180, 80, 255, 0.7)';
    }
    ctx.drawImage(img, cx - LAPTOP_BOSS_ZONE_IMG_W / 2, cy - LAPTOP_BOSS_ZONE_IMG_H / 2, LAPTOP_BOSS_ZONE_IMG_W, LAPTOP_BOSS_ZONE_IMG_H);
    ctx.shadowBlur = 0;

    const zonePlayers = gameState.laptopBossZonePlayers;
    if (zonePlayers.length > 0 && !gameState.laptopBoss.teleportAnim) {
        drawBossReadyList(ctx, cx, cy - LAPTOP_BOSS_ZONE_IMG_H / 2 - 6, zonePlayers);
    }
    ctx.restore();
}

function drawBossReadyList(ctx, cx, bottomY, players) {
    const rowH = 34, listW = 158, padTop = 22;
    const listH = players.length * rowH + padTop + 4;
    const listX = cx - listW / 2;
    const listY = bottomY - listH - 6;

    ctx.save();
    ctx.fillStyle = 'rgba(18, 8, 28, 0.90)';
    drawRoundedRectPath(ctx, listX, listY, listW, listH, 10);
    ctx.fill();
    ctx.strokeStyle = 'rgba(180,100,255,0.18)';
    ctx.lineWidth   = 1;
    drawRoundedRectPath(ctx, listX, listY, listW, listH, 10);
    ctx.stroke();

    ctx.fillStyle = 'rgba(220,180,255,0.85)';
    ctx.font      = 'bold 12px Rubik';
    ctx.textAlign = 'center';
    ctx.fillText('جاهز للقتال ⚔', cx, listY + 15);

    players.forEach((p, i) => {
        const rowY    = listY + padTop + i * rowH;
        const avatarR = 12;
        const avatarX = listX + 22;
        const avatarCY = rowY + rowH / 2;

        ctx.beginPath();
        ctx.arc(avatarX, avatarCY, avatarR, 0, Math.PI * 2);
        ctx.fillStyle = p.userId === gameState.userId ? COLORS.blue : '#444';
        ctx.fill();

        const avImg = gameState.avatarCache[p.userId];
        if (avImg && avImg !== 'failed') {
            ctx.save();
            ctx.beginPath();
            ctx.arc(avatarX, avatarCY, avatarR, 0, Math.PI * 2);
            ctx.clip();
            ctx.drawImage(avImg, avatarX - avatarR, avatarCY - avatarR, avatarR * 2, avatarR * 2);
            ctx.restore();
        }
        ctx.fillStyle = 'white';
        ctx.font      = '13px Rubik';
        ctx.textAlign = 'left';
        ctx.fillText((p.username || '?').slice(0, 12), listX + 40, avatarCY + 4);
        ctx.fillStyle = '#c084fc';
        ctx.font      = 'bold 11px Rubik';
        ctx.textAlign = 'right';
        ctx.fillText('✓', listX + listW - 8, avatarCY + 4);
    });
    ctx.restore();
}

function drawLaptopBossHint() {
    if (!gameState.activeLaptopBossZone) return;
    if (gameState.laptopBoss.teleportAnim) return;
    const ctx = gameState.ctx;
    ctx.save();
    ctx.fillStyle   = 'white';
    ctx.font        = 'bold 13px Rubik';
    ctx.textAlign   = 'center';
    ctx.shadowBlur  = 6;
    ctx.shadowColor = 'black';
    ctx.fillText('اضغط زر البدء', LAPTOP_BOSS_BTN_CX, LAPTOP_BOSS_BTN_CY - LAPTOP_BOSS_BTN_R - 10);
    ctx.shadowBlur = 0;
    ctx.restore();
}

function listenToLaptopBoss() {
    onValue(ref(database, lobbyPath('minigames/laptop-boss/sessions')), (snap) => {
        const sessions = snap.val() || {};
        const active = {};
        const now = Date.now();
        for (const [key, s] of Object.entries(sessions)) {
            if (!s) continue;
            // Stale cleanup — sessions older than 15 min go away
            if (s.createdAt && now - s.createdAt > 15 * 60 * 1000) {
                update(ref(database), { [lobbyPath(`minigames/laptop-boss/sessions/${key}`)]: null });
                continue;
            }
            active[key] = s;
        }
        gameState.laptopBoss.activeSessions = active;

        let myKey = null, mySession = null;
        for (const [key, s] of Object.entries(active)) {
            if (s.participants?.[gameState.userId]) { myKey = key; mySession = s; break; }
        }

        if (!mySession) {
            if (gameState.laptopBoss.active) returnFromLaptopBoss(false);
            gameState.laptopBoss.session = null;
            gameState.laptopBoss.sessionKey = null;
            return;
        }

        gameState.laptopBoss.session = mySession;
        gameState.laptopBoss.sessionKey = myKey;

        if (mySession.phase === 'teleporting') {
            if (!gameState.laptopBoss.teleportAnim) {
                const elapsed = Math.max(0, (serverNow() - (mySession.teleportAt || serverNow())) / 1000);
                gameState.laptopBoss.teleportAnim = {
                    t: elapsed, phase: 'fly', flyProgress: 0, screenAlpha: 0,
                    pendingSession: null, gameStarted: false, sessionCreated: false,
                    isHost: mySession.hostId === gameState.userId,
                    players: [{
                        userId: gameState.userId,
                        startX: (gameState.players[gameState.userId]?.x) || 0,
                        startY: (gameState.players[gameState.userId]?.y) || 0,
                    }],
                };
            }
        } else if (mySession.phase === 'active') {
            if (gameState.laptopBoss.teleportAnim) {
                gameState.laptopBoss.teleportAnim.pendingSession = gameState.laptopBoss.teleportAnim.pendingSession || mySession;
            } else {
                startLocalLaptopBoss(mySession);
            }
        } else if (mySession.phase === 'finished') {
            gameState.laptopBoss.active = true;
            gameState.laptopBoss.session = mySession;
            gameState.laptopBoss.showResultsInGame = true;
        }
    });
}

async function triggerLaptopBossTeleport() {
    if (!gameState.userId || !isBreakActive()) return;
    if (gameState.laptopBoss.teleportAnim) return;
    if (gameState.laptopBoss.active) return;
    const player = gameState.players[gameState.userId];
    if (!player) return;

    // Make sure the boss SFX (deferred at startup) are loading — the teleport
    // animation gives them time to arrive before gameplay starts.
    gameState.focusAudioEngine?.ensureBossSounds?.();

    playSoundRobust(gameState.sounds.minigameButtonPressed);

    const alreadyIn = Object.values(gameState.laptopBoss.activeSessions || {}).some(
        s => s && s.participants?.[gameState.userId]
    );
    if (alreadyIn) return;

    const sessionId = `${gameState.userId}_${Date.now()}`;
    // Single-player game — safe to auto-remove session on disconnect.
    onDisconnect(ref(database, lobbyPath(`minigames/laptop-boss/sessions/${sessionId}`))).remove();

    update(ref(database), {
        [lobbyPath(`minigames/laptop-boss/sessions/${sessionId}`)]: {
            id:         sessionId,
            hostId:     gameState.userId,
            phase:      'teleporting',
            createdAt:  Date.now(),
            teleportAt: serverNow(),
            participants: {
                [gameState.userId]: {
                    username:    player.username || gameState.currentUser || 'لاعب',
                    avatar:      player.avatar || '',
                    returnPoint: { x: player.x, y: player.y },
                }
            }
        }
    });
}

function createLaptopBossSession() {
    if (!gameState.laptopBoss.sessionKey) return;
    update(ref(database), {
        [laptopBossSessionPath('phase')]:     'active',
        [laptopBossSessionPath('startTime')]: serverNow() + 800,  // tiny lead-in so player can settle
    });
}

function updateLaptopBossTeleportAnim() {
    const anim = gameState.laptopBoss.teleportAnim;
    if (!anim) return;
    const FLY_DUR = 0.45, FADE_DUR = 0.30, HOLD_DUR = 0.40, FADEIN_DUR = 0.60;
    anim.t += gameState.dtFactor / 60;

    const tryStart = () => {
        if (anim.pendingSession && !anim.gameStarted) {
            anim.gameStarted = true;
            startLocalLaptopBoss(anim.pendingSession);
        }
    };

    if (anim.t < FLY_DUR) {
        anim.phase = 'fly'; anim.flyProgress = anim.t / FLY_DUR; anim.screenAlpha = 0;
    } else if (anim.t < FLY_DUR + FADE_DUR) {
        anim.phase = 'fade'; anim.flyProgress = 1;
        anim.screenAlpha = (anim.t - FLY_DUR) / FADE_DUR;
    } else if (anim.t < FLY_DUR + FADE_DUR + HOLD_DUR) {
        anim.phase = 'hold'; anim.flyProgress = 1; anim.screenAlpha = 1;
        if (anim.isHost && !anim.sessionCreated) {
            anim.sessionCreated = true;
            createLaptopBossSession();
        }
        tryStart();
    } else if (anim.t < FLY_DUR + FADE_DUR + HOLD_DUR + FADEIN_DUR) {
        anim.phase = 'fadein'; anim.flyProgress = 1;
        anim.screenAlpha = 1 - (anim.t - FLY_DUR - FADE_DUR - HOLD_DUR) / FADEIN_DUR;
        tryStart();
    } else {
        tryStart();
        gameState.laptopBoss.teleportAnim = null;
    }
}

// ─── Boss audio helpers ───────────────────────────────────────────────────────
// All boss sounds go through the FocusAudioEngine's Web Audio context so they
// work in background tabs. They bypass the focus mixer's masterGain and connect
// directly to ctx.destination via their own gain nodes.

function _bossCtx() {
    const eng = gameState.focusAudioEngine;
    if (!eng) return null;
    if (!eng.ctx) eng.init();
    return eng.ctx;
}

// Play a one-shot boss sound by buffer key
// Volume levels for each one-shot boss sound.
// Crowd/applause are loud by default; gameplay SFX need a boost.
const BOSS_APPLAUSE_VOL = 0.45; // max volume for the looping applause track
const BOSS_SOUND_VOLUMES = {
    crowdCheer:         0.60,
    crowdShock:         0.60,
    bossAnticipate:     2.0,
    bossAttackInitiate: 2.0,
    bossGrabInitiate:   2.0,
    bossGrabSuccess:    2.0,
    bossWeakInitiate:   2.0,
    bossWeakEnd:        2.0,
    bossHit:            2.0,
    bossAttackStomp:    2.0,
    playerHitBoss:      2.0,
    playerLooseBoss:    2.0,
    playerWinBoss:      2.0,
    bossWeakIdle:       1.0,  // managed separately (loop)
};

function bossPlaySound(key) {
    const ctx = _bossCtx();
    if (!ctx) return;
    const buf = gameState.focusAudioEngine.buffers[key];
    if (!buf) return;
    const vol = BOSS_SOUND_VOLUMES[key] ?? 1.0;
    ctx.resume().then(() => {
        try {
            const src = ctx.createBufferSource();
            src.buffer = buf;
            const g = ctx.createGain();
            g.gain.setValueAtTime(vol, ctx.currentTime);
            src.connect(g);
            g.connect(ctx.destination);
            src.start(0);
        } catch(e) {}
    });
}

// Start the looping crowd applause for the boss fight.
// Trims first 4 s and last 4 s by using loopStart/loopEnd.
// Fades in over fadeMs milliseconds.
function startBossApplause(fadeMs = 1500) {
    const ctx = _bossCtx();
    const ba = gameState.laptopBoss.bossAudio;
    if (!ctx) return;
    const buf = gameState.focusAudioEngine.buffers.bossApplause;
    if (!buf) return;
    ctx.resume().then(() => {
        try {
            const dur = buf.duration;
            const loopStart = 4.0;
            const loopEnd   = Math.max(loopStart + 1, dur - 4.0);

            const gainNode = ctx.createGain();
            gainNode.gain.setValueAtTime(0, ctx.currentTime);
            gainNode.gain.linearRampToValueAtTime(BOSS_APPLAUSE_VOL, ctx.currentTime + fadeMs / 1000);
            gainNode.connect(ctx.destination);

            const src = ctx.createBufferSource();
            src.buffer = buf;
            src.loop = true;
            src.loopStart = loopStart;
            src.loopEnd   = loopEnd;
            src.connect(gainNode);
            src.start(0, loopStart); // skip into audio past the file's own fade-in

            ba.applauseSource = src;
            ba.applauseGain   = gainNode;
        } catch(e) {}
    });
}

// Fade out and stop the applause. fadeMs = 0 means instant.
function stopBossApplause(fadeMs = 1200) {
    const ctx = _bossCtx();
    const ba  = gameState.laptopBoss.bossAudio;
    if (!ctx || !ba.applauseSource) return;
    const src  = ba.applauseSource;
    const gain = ba.applauseGain;
    ba.applauseSource = null;
    ba.applauseGain   = null;
    if (ba.duckTimer) { clearTimeout(ba.duckTimer); ba.duckTimer = null; }
    try {
        gain.gain.cancelScheduledValues(ctx.currentTime);
        gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
        if (fadeMs > 0) {
            gain.gain.linearRampToValueAtTime(0, ctx.currentTime + fadeMs / 1000);
            setTimeout(() => { try { src.stop(); } catch(e) {} }, fadeMs + 50);
        } else {
            src.stop();
        }
    } catch(e) {}
}

// Duck applause to 20%, play a crowd sound, then ramp back up.
// duckKey = 'crowdCheer' | 'crowdShock'
function bossDuckApplause(duckKey) {
    const ctx = _bossCtx();
    const ba  = gameState.laptopBoss.bossAudio;
    bossPlaySound(duckKey);
    if (!ctx || !ba.applauseGain) return;
    const g = ba.applauseGain;
    if (ba.duckTimer) { clearTimeout(ba.duckTimer); ba.duckTimer = null; }
    try {
        g.gain.cancelScheduledValues(ctx.currentTime);
        g.gain.setValueAtTime(g.gain.value, ctx.currentTime);
        g.gain.linearRampToValueAtTime(0.20, ctx.currentTime + 0.30); // duck in 300 ms
    } catch(e) {}
    // Recover after 2 s
    ba.duckTimer = setTimeout(() => {
        ba.duckTimer = null;
        if (!ba.applauseGain) return;
        try {
            g.gain.cancelScheduledValues(ctx.currentTime);
            g.gain.setValueAtTime(g.gain.value, ctx.currentTime);
            g.gain.linearRampToValueAtTime(BOSS_APPLAUSE_VOL, ctx.currentTime + 0.80); // ramp up 800 ms
        } catch(e) {}
    }, 2000);
}

// Start looping weak-idle sound, with a 1-second startup delay and fade-in.
function startBossWeakIdle() {
    const ba = gameState.laptopBoss.bossAudio;
    if (ba.weakIdleTimer) { clearTimeout(ba.weakIdleTimer); ba.weakIdleTimer = null; }
    stopBossWeakIdle(0); // kill any existing one instantly
    ba.weakIdleTimer = setTimeout(() => {
        ba.weakIdleTimer = null;
        const ctx = _bossCtx();
        if (!ctx) return;
        const buf = gameState.focusAudioEngine.buffers.bossWeakIdle;
        if (!buf) return;
        ctx.resume().then(() => {
            try {
                const gainNode = ctx.createGain();
                gainNode.gain.setValueAtTime(0, ctx.currentTime);
                gainNode.gain.linearRampToValueAtTime(1.0, ctx.currentTime + 0.5);
                gainNode.connect(ctx.destination);

                const src = ctx.createBufferSource();
                src.buffer = buf;
                src.loop = true;
                src.connect(gainNode);
                src.start(0);

                ba.weakIdleSource = src;
                ba.weakIdleGain   = gainNode;
            } catch(e) {}
        });
    }, 1000);
}

// Fade out and stop the weak-idle loop.
function stopBossWeakIdle(fadeMs = 500) {
    const ctx = _bossCtx();
    const ba  = gameState.laptopBoss.bossAudio;
    if (ba.weakIdleTimer) { clearTimeout(ba.weakIdleTimer); ba.weakIdleTimer = null; }
    if (!ba.weakIdleSource) return;
    const src  = ba.weakIdleSource;
    const gain = ba.weakIdleGain;
    ba.weakIdleSource = null;
    ba.weakIdleGain   = null;
    try {
        if (fadeMs > 0 && ctx) {
            gain.gain.cancelScheduledValues(ctx.currentTime);
            gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
            gain.gain.linearRampToValueAtTime(0, ctx.currentTime + fadeMs / 1000);
            setTimeout(() => { try { src.stop(); } catch(e) {} }, fadeMs + 50);
        } else {
            src.stop();
        }
    } catch(e) {}
}

// Stop all boss audio (called on fight end / return to world)
function stopAllBossAudio() {
    stopBossApplause(1200);
    stopBossWeakIdle(400);
}

function startLocalLaptopBoss(session) {
    if (gameState.laptopBoss.active && gameState.laptopBoss.local) return;

    // Hide world UI; show our own mobile controls
    const _uc = document.getElementById('user-card');
    if (_uc) _uc.style.display = 'none';
    const _jy = document.getElementById('mobile-joystick');
    if (_jy) _jy.style.display = 'none';
    setMinigameHideUI(true);
    showMobileBossButtons(true);

    const participant = session.participants?.[gameState.userId] || {};
    gameState.laptopBoss.active        = true;
    gameState.laptopBoss.returnPoint   = participant.returnPoint || null;

    const canvas = gameState.canvas;
    const dpr = gameState.dpr || 1;
    const W = canvas ? canvas.width / dpr : window.innerWidth;
    const H = canvas ? canvas.height / dpr : window.innerHeight;
    const groundY = H * 0.84;

    // Reduce particle counts on mobile for weaker devices
    const lowEnd = isMobile();
    const auraCount = lowEnd ? 14 : 22;
    const windCount = lowEnd ? 10 : 20;

    gameState.laptopBoss.local = {
        // Player
        player: {
            x: W * 0.82, y: groundY - 36,
            vx: 0, vy: 0,
            w: 72, h: 72,
            onGround: true,
            coyoteT: 0,
            jumpHoldT: 0,
            jumping: false,
            invulnT: 0,
            flashRedT: 0,
            flashWhiteT: 0,
            squashT: 1,
            health: PLAYER_BOSS_MAX_HEALTH,
            dead: false,
            fallDoneT: 0,
        },
        // Boss
        boss: {
            x: W * 0.22, y: H * 0.42,
            baseY: H * 0.42,
            floatT: 0,
            state: 'intro',         // intro → idle → grab/attack → weak → ...
            stateT: 0,
            stateDur: 1.0,
            attackCount: 0,         // number of grab/attack since last weak (resets to 0 after weak)
            scoopStartX: 0, scoopStartY: 0,
            scoopTargetX: 0, scoopTargetY: 0,
            scoopProgress: 0,
            grabTargetX: 0, grabTargetY: 0,    // locked at end of phase 1 of grab
            grabPullStartT: 0,                  // time at which pull started
            grabHitFired: false,
            attackHitFired: false,
            scale: 1,
            scaleTarget: 1,
            health: BOSS_MAX_HEALTH,
            flashWhiteT: 0,
            knockbackX: 0, knockbackY: 0,
            recoveryFromX: 0, recoveryFromY: 0,
            motionTrail: [],        // {x,y,t} for motion blur
            endFallVy: 0,
            offScreen: false,
            attacksThisCycle: 0,    // 0..3 then weak
            shieldAlpha: 0.10,      // rendered over boss when NOT in weak state
            shieldScale: 1.0,       // animates up on weak entry, down on exit
            reboundVX: 0, reboundVY: 0, // physics velocity during rebound
            _trailTimer: 0,
        },
        // World
        groundY,
        W, H,
        // FX
        particles: [],
        floatTexts: [],
        screenShakeX: 0, screenShakeY: 0, shakeT: 0, shakeAmp: 0,
        aura: Array.from({ length: auraCount }, (_, i) => ({
            angle: (Math.PI * 2 * i) / auraCount,
            speed: 0.0009 + Math.random() * 0.0006,
            r: 70 + Math.random() * 18,
            phase: Math.random() * Math.PI * 2,
        })),
        windParticles: Array.from({ length: windCount }, () => ({
            x: Math.random() * W,
            y: Math.random() * H,
            vx: -(0.4 + Math.random() * 0.9),
            size: 1 + Math.floor(Math.random() * 2),
            len: 4 + Math.floor(Math.random() * 5),
            alpha: 0.08 + Math.random() * 0.18,
        })),
        // Weak-state stepping platform (one-way, jumps through from below)
        stair: { alpha: 0, x: 0, y: 0, w: 170, h: 14 },
        // Avatar image
        avatarImg: gameState.avatarCache[gameState.userId] || null,
        groundImpact: null, // { x, t, maxT } shockwave ring
        outcome: null, // 'win' | 'lose' | null
        outcomeT: 0,
        startedAt: Date.now(),
        introT: 0,
        // Touch input ids
        _touchLeftId: null,
        _touchRightId: null,
        _touchJumpId: null,
    };

    setupBossKeyHandlers();
    setupBossTouchHandlers();

    // Start fight applause (fades in over 1.5 s)
    startBossApplause(1500);

    // Siraj ghost cleanup
    if (gameState.isSirajGhost && gameState.laptopBoss.sessionKey) {
        const cleanupPath = lobbyPath(`minigames/laptop-boss/sessions/${gameState.laptopBoss.sessionKey}`);
        onDisconnect(ref(database, cleanupPath)).remove();
        if (gameState.laptopBoss._sirajCleanupTimer) clearTimeout(gameState.laptopBoss._sirajCleanupTimer);
        gameState.laptopBoss._sirajCleanupTimer = setTimeout(() => {
            update(ref(database), { [cleanupPath]: null });
            gameState.laptopBoss._sirajCleanupTimer = null;
        }, 90000);
    }

    // Mark player as "working" so others see them as busy
    update(ref(database), { [`users/${gameState.userId}/isWorking`]: true });
}

function setupBossKeyHandlers() {
    if (gameState.laptopBoss._keyDownHandler) return;
    gameState.laptopBoss._keyDownHandler = (e) => {
        if (!gameState.laptopBoss.active) return;
        if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
            e.preventDefault();
            gameState.laptopBossButtons.jump = true;
            gameState.laptopBossButtons.jumpPressed = true;
        }
    };
    gameState.laptopBoss._keyUpHandler = (e) => {
        if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
            gameState.laptopBossButtons.jump = false;
        }
    };
    window.addEventListener('keydown', gameState.laptopBoss._keyDownHandler);
    window.addEventListener('keyup', gameState.laptopBoss._keyUpHandler);
}

function setupBossTouchHandlers() {
    // Wired once in initMobileControls()
}

function showMobileBossButtons(show) {
    const dpad = document.getElementById('mobile-boss-btns');
    const joystick = document.getElementById('mobile-joystick');
    if (dpad) dpad.classList.toggle('hidden', !show);
    if (joystick && isMobile()) joystick.style.display = show ? 'none' : '';
    if (!show) {
        gameState.laptopBossButtons.left = false;
        gameState.laptopBossButtons.right = false;
        gameState.laptopBossButtons.jump = false;
        gameState.laptopBossButtons.jumpPressed = false;
    }
}

function returnFromLaptopBoss(clearState) {
    stopAllBossAudio();
    if (gameState.laptopBoss._sirajCleanupTimer) {
        clearTimeout(gameState.laptopBoss._sirajCleanupTimer);
        gameState.laptopBoss._sirajCleanupTimer = null;
    }
    if (gameState.laptopBoss._keyDownHandler) {
        window.removeEventListener('keydown', gameState.laptopBoss._keyDownHandler);
        gameState.laptopBoss._keyDownHandler = null;
    }
    if (gameState.laptopBoss._keyUpHandler) {
        window.removeEventListener('keyup', gameState.laptopBoss._keyUpHandler);
        gameState.laptopBoss._keyUpHandler = null;
    }
    // Restore world UI
    const _uc = document.getElementById('user-card');
    if (_uc) _uc.style.display = '';
    const _jy = document.getElementById('mobile-joystick');
    if (_jy) _jy.style.display = '';
    setMinigameHideUI(false);
    showMobileBossButtons(false);

    const sessionKeyToDelete = gameState.laptopBoss.sessionKey;
    if (sessionKeyToDelete) {
        update(ref(database), { [lobbyPath(`minigames/laptop-boss/sessions/${sessionKeyToDelete}`)]: null });
    }

    const player = gameState.players[gameState.userId];
    const returnPoint = gameState.laptopBoss.returnPoint;
    if (player && returnPoint) {
        teleportEntity(player, returnPoint.x, returnPoint.y);
        updatePlayerPosition(returnPoint.x, returnPoint.y);
    }
    gameState.laptopBoss.active = false;
    gameState.laptopBoss.local = null;
    gameState.laptopBoss.session = null;
    gameState.laptopBoss.sessionKey = null;
    gameState.laptopBoss.showResultsInGame = false;
    gameState.laptopBoss.resultsButtonRect = null;
    if (gameState.userId) update(ref(database), { [`users/${gameState.userId}/isWorking`]: false });
}

// ─── Boss game tick ───────────────────────────────────────────────────────────

const BOSS_GRAVITY = 0.6;                 // per-frame at 60fps; multiplied by dtFactor
const BOSS_JUMP_VEL = -15.5;             // initial jump velocity
const BOSS_JUMP_HOLD_BOOST = -0.62;      // extra upward accel while holding jump
const BOSS_JUMP_HOLD_MAX = 12;           // frames of hold boost
const BOSS_MOVE_ACCEL = 2.2;
const BOSS_MOVE_MAX = 7.5;
const BOSS_MOVE_FRICTION = 0.80;
const BOSS_COYOTE_MAX = 8;

function bossSpawnParticles(local, x, y, count, opts = {}) {
    const color = opts.color || 'rgba(220,180,255,0.9)';
    const speed = opts.speed || 4;
    const life = opts.life || 30;
    const size = opts.size || 4;
    for (let i = 0; i < count; i++) {
        const angle = (Math.PI * 2 * i / count) + (Math.random() - 0.5) * 0.6;
        const sp = speed * (0.6 + Math.random() * 0.8);
        local.particles.push({
            x, y, vx: Math.cos(angle) * sp, vy: Math.sin(angle) * sp,
            life, maxLife: life, color, size,
        });
    }
}

function bossAddShake(local, amp) {
    local.shakeAmp = Math.max(local.shakeAmp || 0, amp);
    local.shakeT = 10;
}

function bossFloatText(local, x, y, text, color) {
    local.floatTexts.push({ x, y, text, color: color || '#ff4d6d', life: 60, maxLife: 60, vy: -1.2 });
}

function bossSetState(boss, state, dur) {
    boss.state = state;
    boss.stateT = 0;
    boss.stateDur = dur;
}

function updateLaptopBoss() {
    const local = gameState.laptopBoss.local;
    if (!local) return;
    const dt = Math.min(2, gameState.dtFactor || 1);
    const session = gameState.laptopBoss.session;

    // Hard exit if break ends mid-fight
    if (!isBreakActive()) {
        if (session && session.hostId === gameState.userId) {
            update(ref(database), { [lobbyPath(`minigames/laptop-boss/sessions/${gameState.laptopBoss.sessionKey}`)]: null });
        }
        returnFromLaptopBoss(false);
        return;
    }

    // Prayer overlay or azkar steal priority — pause boss
    if (gameState.prayer?.isOverlayActive || gameState.azkar?.active) {
        // freeze updates
        return;
    }

    const player = local.player;
    const boss = local.boss;

    // ── Input ────────────────────────────────────────────────────────────────
    const k = gameState.keys || {};
    const leftHeld  = !!(k['ArrowLeft']  || k['KeyA'] || gameState.laptopBossButtons.left);
    const rightHeld = !!(k['ArrowRight'] || k['KeyD'] || gameState.laptopBossButtons.right);
    const jumpHeld  = !!(k['Space'] || k['ArrowUp'] || k['KeyW'] || gameState.laptopBossButtons.jump);

    // ── Player physics ───────────────────────────────────────────────────────
    if (!player.dead && !boss.grabbedPlayer) {
        // Horizontal
        if (leftHeld && !rightHeld) player.vx -= BOSS_MOVE_ACCEL * dt;
        else if (rightHeld && !leftHeld) player.vx += BOSS_MOVE_ACCEL * dt;
        else {
            // Friction when no input
            player.vx *= Math.pow(BOSS_MOVE_FRICTION, dt);
            if (Math.abs(player.vx) < 0.05) player.vx = 0;
        }
        player.vx = Math.max(-BOSS_MOVE_MAX, Math.min(BOSS_MOVE_MAX, player.vx));

        // Coyote tracking
        if (player.onGround) player.coyoteT = BOSS_COYOTE_MAX;
        else player.coyoteT = Math.max(0, player.coyoteT - dt);

        // Jump
        if (gameState.laptopBossButtons.jumpPressed && (player.onGround || player.coyoteT > 0)) {
            player.vy = BOSS_JUMP_VEL;
            player.onGround = false;
            player.jumping = true;
            player.jumpHoldT = BOSS_JUMP_HOLD_MAX;
            player.coyoteT = 0;
            // Squash for jump anim
            player.squashT = 0.5;
            // Tiny dust
            bossSpawnParticles(local, player.x, player.y + player.h / 2, 4, { color: 'rgba(160,160,180,0.6)', speed: 1.5, life: 18, size: 3 });
        }
        gameState.laptopBossButtons.jumpPressed = false; // consume edge

        // Variable jump height
        if (player.jumping && jumpHeld && player.jumpHoldT > 0 && player.vy < 0) {
            player.vy += BOSS_JUMP_HOLD_BOOST * dt;
            player.jumpHoldT -= dt;
        } else if (!jumpHeld) {
            player.jumping = false;
            player.jumpHoldT = 0;
        }

        // Gravity
        player.vy += BOSS_GRAVITY * dt;
        player.vy = Math.min(18, player.vy);

        // Integrate
        player.x += player.vx * dt;
        player.y += player.vy * dt;

        // Bounds (world walls)
        const halfW = player.w / 2;
        if (player.x < halfW) { player.x = halfW; player.vx = 0; }
        if (player.x > local.W - halfW) { player.x = local.W - halfW; player.vx = 0; }

        // Ground collision (offset +10 so player sits flush with visual floor)
        const feetY = player.y + player.h / 2;
        const groundSnap = local.groundY + 10;
        if (feetY >= groundSnap) {
            player.y = groundSnap - player.h / 2;
            const wasFalling = player.vy > 4;
            player.vy = 0;
            if (!player.onGround && wasFalling) {
                bossSpawnParticles(local, player.x, groundSnap, 5, { color: 'rgba(140,140,160,0.55)', speed: 2, life: 18, size: 3 });
                player.squashT = 0.5;
            }
            player.onGround = true;
            player.jumping = false;
            player.jumpHoldT = 0;
        } else {
            // One-way stair platform: land only when falling down onto top face
            const stair = local.stair;
            const prevFeetY = feetY - player.vy * dt;
            if (stair.alpha > 0.1 && player.vy > 0 &&
                prevFeetY <= stair.y && feetY >= stair.y &&
                player.x + player.w / 2 > stair.x && player.x - player.w / 2 < stair.x + stair.w) {
                player.y = stair.y - player.h / 2;
                player.vy = 0;
                if (!player.onGround) {
                    bossSpawnParticles(local, player.x, stair.y, 5, { color: 'rgba(140,140,160,0.55)', speed: 2, life: 18, size: 3 });
                    player.squashT = 0.5;
                }
                player.onGround = true;
                player.jumping = false;
                player.jumpHoldT = 0;
            } else {
                player.onGround = false;
            }
        }
    } else {
        // Death fall — keep falling till offscreen
        player.vy += BOSS_GRAVITY * dt;
        player.y += player.vy * dt;
        if (player.y > local.H + 200 && !player.fallDoneT) {
            player.fallDoneT = Date.now();
            local.outcome = 'lose';
            local.outcomeT = 0;
        }
    }

    // Visual timers
    if (player.invulnT > 0) player.invulnT -= dt;
    if (player.flashRedT > 0) player.flashRedT -= dt;
    if (player.flashWhiteT > 0) player.flashWhiteT -= dt;
    player.squashT += (1 - player.squashT) * 0.16 * dt;

    // ── Boss AI ──────────────────────────────────────────────────────────────
    boss.floatT += dt / 60;
    boss.stateT += dt;

    // Float anim when not in motion states
    const floatingStates = ['intro', 'idle', 'grab_predict', 'grab_shoot', 'grab_hold', 'grab_release_kidnap', 'attack_anticipate', 'attack_return', 'weak'];
    if (floatingStates.includes(boss.state)) {
        boss.y = boss.baseY + Math.sin(boss.floatT * Math.PI) * 20;
    }

    // Scale ease toward target
    boss.scale += (boss.scaleTarget - boss.scale) * 0.12 * dt;
    if (boss.flashWhiteT > 0) boss.flashWhiteT -= dt;

    // State machine
    const startedActive = session && session.startTime && serverNow() >= session.startTime;

    if (boss.state === 'intro') {
        // Wait for startTime to elapse
        if (startedActive) {
            bossSetState(boss, 'idle', 90); // 1.5s @ 60fps
        }
    } else if (boss.state === 'idle') {
        if (boss.stateT >= boss.stateDur) {
            // If player is dead, just keep idling — finish current animation, don't attack
            if (player.dead) {
                bossSetState(boss, 'idle', 60 * 2);
            } else {
                // Pick next attack: grab or scoop
                boss.attacksThisCycle++;
                if (boss.attacksThisCycle > 3) {
                    // Go to weak
                    bossSetState(boss, 'weak', 60 * 3); // 3 s weak window
                    boss.attacksThisCycle = 0;
                    bossSpawnParticles(local, boss.x, boss.y, 14, { color: 'rgba(120,80,255,0.85)', speed: 5, life: 36, size: 4 });
                    // ♪ weak entry sounds
                    bossPlaySound('bossWeakInitiate');
                    startBossWeakIdle();
                } else {
                    const grabRoll = Math.random() < 0.5;
                    if (grabRoll) {
                        boss.grabHitFired = false;
                        bossSetState(boss, 'grab_predict', 60 * 1.2);  // 1.2s
                        bossPlaySound('bossAnticipate');  // anticipation starts
                    } else {
                        boss.scaleTarget = 1.15;
                        boss.attackHitFired = false;
                        bossSetState(boss, 'attack_anticipate', 60 * 0.8); // 0.8s
                        bossPlaySound('bossAnticipate');  // anticipation starts
                    }
                }
            }
        }
    } else if (boss.state === 'grab_predict') {
        if (boss.stateT >= boss.stateDur) {
            // Lock target at player's current position and shoot
            boss.grabTargetX = player.x;
            boss.grabTargetY = player.y;
            bossSetState(boss, 'grab_shoot', 60 * 0.35); // line extends over 0.35s
            bossPlaySound('bossGrabInitiate'); // grab sequence begins
        }
    } else if (boss.state === 'grab_shoot') {
        if (boss.stateT >= boss.stateDur) {
            // Check if player is still near the locked target
            const gdx = player.x - boss.grabTargetX;
            const gdy = player.y - boss.grabTargetY;
            if (Math.hypot(gdx, gdy) < 60 && player.invulnT <= 0 && !player.dead) {
                // Hit — start kidnap pull
                boss.grabbedPlayer = true;
                boss.grabPullStartX = player.x;
                boss.grabPullStartY = player.y;
                boss.grabDamageFired = false;
                bossSetState(boss, 'grab_pull', 60 * 0.45);
                bossPlaySound('bossGrabSuccess'); // grab connected
            } else {
                // Miss
                bossSetState(boss, 'idle', 60 * 1.5);
            }
        }
    } else if (boss.state === 'grab_pull') {
        // Smoothly pull player to front of boss — hold last attack frame throughout
        const pullP = Math.min(1, boss.stateT / boss.stateDur);
        const pullEased = 1 - Math.pow(1 - pullP, 2.5);
        const destX = boss.x + 95;
        const destY = boss.y;
        player.x = boss.grabPullStartX + (destX - boss.grabPullStartX) * pullEased;
        player.y = boss.grabPullStartY + (destY - boss.grabPullStartY) * pullEased;
        player.vx = 0; player.vy = 0; player.onGround = false;
        if (boss.stateT >= boss.stateDur) {
            bossSetState(boss, 'grab_hold', 60 * 0.5);
        }
    } else if (boss.state === 'grab_hold') {
        // Hold player in place — deal damage once after a short pause
        player.x = boss.x + 95;
        player.y = boss.y;
        player.vx = 0; player.vy = 0; player.onGround = false;
        if (!boss.grabDamageFired && boss.stateT >= 8) {
            boss.grabDamageFired = true;
            damagePlayer(local, player, boss, true /*fromGrab*/);
            // Override damagePlayer's knockback — player stays held
            player.vx = 0; player.vy = 0;
        }
        if (boss.stateT >= boss.stateDur) {
            // Release with knockback
            boss.grabbedPlayer = false;
            player.vx = 9; // flung right away from boss
            player.vy = -10;
            player.onGround = false;
            bossSetState(boss, 'grab_release_kidnap', 60 * 0.35);
        }
    } else if (boss.state === 'grab_release_kidnap') {
        if (boss.stateT >= boss.stateDur) {
            bossSetState(boss, 'idle', 60 * 1.5);
        }
    } else if (boss.state === 'attack_anticipate') {
        if (boss.stateT >= boss.stateDur) {
            // Anticipation done — fire attack
            boss.scoopStartX = boss.x;
            boss.scoopStartY = boss.y;
            boss.scoopTargetX = player.x;
            boss.scoopTargetY = local.groundY + 10 - 20; // boss center near ground
            boss.attackHitFired = false;
            boss.scaleTarget = 1.0;
            boss.motionTrail = [];
            boss._trailTimer = 0;
            bossSetState(boss, 'attack_stomp', 60 * 0.60);
            bossPlaySound('bossAttackInitiate'); // attack (not grab) launches
        }
    } else if (boss.state === 'attack_stomp') {
        const p = Math.min(1, boss.stateT / boss.stateDur);
        // Ease-in cubic for fast approach
        const ease = p < 0.5
            ? 4 * p * p * p
            : 1 - Math.pow(-2 * p + 2, 3) / 2;
        // Arc: X smooth, Y curves up slightly then slams down
        boss.x = boss.scoopStartX + (boss.scoopTargetX - boss.scoopStartX) * ease;
        boss.y = (boss.scoopStartY + (boss.scoopTargetY - boss.scoopStartY) * ease)
                 - Math.sin(p * Math.PI) * 60;

        // Motion trail — add position every 3 frames
        boss._trailTimer += dt;
        if (boss._trailTimer >= 3) {
            boss._trailTimer = 0;
            boss.motionTrail.unshift({ x: boss.x, y: boss.y, alpha: 0.55 });
            if (boss.motionTrail.length > 5) boss.motionTrail.pop();
        }

        // Damage player on contact during dive
        if (!boss.attackHitFired) {
            const ddx = player.x - boss.x;
            const ddy = player.y - boss.y;
            if (Math.hypot(ddx, ddy) < 70 && player.invulnT <= 0) {
                boss.attackHitFired = true;
                damagePlayer(local, player, boss, false /*fromStomp*/);
            }
        }

        if (boss.stateT >= boss.stateDur) {
            // GROUND IMPACT
            boss.x = boss.scoopTargetX;
            boss.y = boss.scoopTargetY;
            boss.motionTrail = [];
            bossAddShake(local, 16);
            boss.flashWhiteT = 22;
            bossSpawnParticles(local, boss.x, local.groundY + 10, 24, {
                color: 'rgba(255,255,180,0.95)', speed: 9, life: 38, size: 5
            });
            bossSpawnParticles(local, boss.x, local.groundY + 10, 10, {
                color: 'rgba(255,200,100,0.80)', speed: 5, life: 28, size: 3
            });
            local.groundImpact = { x: boss.x, t: 0, maxT: 36 };
            bossPlaySound('bossAttackStomp'); // ground slam
            bossSetState(boss, 'attack_impact', 60 * 0.32);
        }
    } else if (boss.state === 'attack_impact') {
        // Freeze boss at impact point while effects play
        boss.x = boss.scoopTargetX;
        boss.y = boss.scoopTargetY;
        if (boss.stateT >= boss.stateDur) {
            // Launch rebound — continues RIGHT (same direction as stomp) and upward off-screen
            boss.reboundVX = 20;
            boss.reboundVY = -15;
            boss._trailTimer = 0;
            bossSetState(boss, 'attack_rebound', 9999);
        }
    } else if (boss.state === 'attack_rebound') {
        // Physics-driven bounce off screen
        boss.reboundVY += 0.38 * dt;
        boss.x += boss.reboundVX * dt;
        boss.y += boss.reboundVY * dt;

        // Trail during rebound
        boss._trailTimer += dt;
        if (boss._trailTimer >= 3) {
            boss._trailTimer = 0;
            boss.motionTrail.unshift({ x: boss.x, y: boss.y, alpha: 0.45 });
            if (boss.motionTrail.length > 5) boss.motionTrail.pop();
        }

        // Once fully off-screen right, instant-snap to off-screen left, then return
        if (boss.x > local.W + 200) {
            boss.motionTrail = [];
            // One-frame snap to off-screen LEFT — no transition
            boss.x = -180;
            boss.y = local.H * 0.42;
            bossSetState(boss, 'attack_return', 60 * 0.75);
        }
    } else if (boss.state === 'attack_return') {
        const p = Math.min(1, boss.stateT / boss.stateDur);
        const eased = 1 - Math.pow(1 - p, 3);
        boss.x = -180 + (local.W * 0.22 - (-180)) * eased;
        boss.y = local.H * 0.42;
        boss.baseY = local.H * 0.42;
        if (boss.stateT >= boss.stateDur) {
            boss.x = local.W * 0.22;
            bossSetState(boss, 'idle', 60 * 1.5);
        }
    } else if (boss.state === 'weak') {
        // Decay trail
        boss.motionTrail = [];
        // Check player collision with boss
        if (player.invulnT <= 0) {
            const ddx = player.x - boss.x;
            const ddy = player.y - boss.y;
            if (Math.hypot(ddx, ddy) < 60) {
                // Player hits boss
                boss.health -= 1;
                boss.flashWhiteT = 12;
                player.flashWhiteT = 12;
                player.invulnT = 18;
                // Knockback boss slightly
                boss.x += 20 * (player.x < boss.x ? 1 : -1);
                bossSpawnParticles(local, boss.x, boss.y, 12, { color: 'rgba(255,255,255,0.95)', speed: 6, life: 30, size: 4 });
                bossAddShake(local, 6);
                bossFloatText(local, boss.x, boss.y - 40, '-1 HP', '#ff4d6d');
                // Bounce player up
                player.vy = -10;
                player.onGround = false;

                if (boss.health <= 0) {
                    // ♪ player wins — kill boss; fade out applause (don't duck-and-recover)
                    bossPlaySound('playerWinBoss');
                    bossPlaySound('crowdCheer');
                    stopBossApplause(2500);
                    stopBossWeakIdle(300);
                    bossSetState(boss, 'end', 9999);
                    boss.endFallVy = 0;
                } else {
                    // ♪ boss takes a hit but survives — wakes up
                    bossPlaySound('bossHit');
                    bossDuckApplause('crowdCheer');
                    stopBossWeakIdle(200);
                    bossSetState(boss, 'idle', 60 * 1.5);
                }
            }
        }
        // Time window expired — boss recovers on its own
        if (boss.state === 'weak' && boss.stateT >= boss.stateDur) {
            bossPlaySound('bossWeakEnd');
            stopBossWeakIdle(400);
            bossSetState(boss, 'idle', 60 * 1.5);
        }
    } else if (boss.state === 'end') {
        // Drop straight down
        boss.endFallVy += 0.3 * dt;
        boss.endFallVy = Math.min(8, boss.endFallVy);
        boss.y += boss.endFallVy * dt;
        if (boss.y > local.H + 200 && !boss.offScreen) {
            boss.offScreen = true;
            local.outcome = 'win';
            local.outcomeT = 0;
            bossSpawnParticles(local, boss.x, local.groundY, 18, { color: 'rgba(220,180,255,0.95)', speed: 7, life: 40, size: 5 });
            bossAddShake(local, 10);
        }
        // Sparkle particles
        if (Math.random() < 0.4) {
            bossSpawnParticles(local, boss.x + (Math.random() - 0.5) * 60, boss.y, 1, { color: 'rgba(220,180,255,0.7)', speed: 1.4, life: 24, size: 3 });
        }
    }

    // ── Shield alpha/scale (visible when not weak, animates on transition) ──
    const isWeak = boss.state === 'weak' || boss.state === 'end';
    const shieldAlphaTarget = isWeak ? 0 : 0.10;
    const shieldScaleTarget = isWeak ? 1.35 : 1.0;
    boss.shieldAlpha += (shieldAlphaTarget - boss.shieldAlpha) * 0.10 * dt;
    boss.shieldScale += (shieldScaleTarget - boss.shieldScale) * 0.10 * dt;
    if (boss.shieldAlpha < 0.002) boss.shieldAlpha = 0;

    // ── Stair alpha (fade in during weak, fade out otherwise) ────────────────
    const stair = local.stair;
    stair.x = local.W * 0.40 - stair.w / 2;
    stair.y = local.groundY - 165;
    const stairTarget = (boss.state === 'weak') ? 1 : 0;
    stair.alpha += (stairTarget - stair.alpha) * 0.08 * dt;
    if (stair.alpha < 0.01) stair.alpha = 0;
    // If player was standing on stair and stair fades out, drop them
    if (stair.alpha < 0.1 && player.onGround) {
        const feetY2 = player.y + player.h / 2;
        if (Math.abs(feetY2 - stair.y) < 4) player.onGround = false;
    }

    // ── Ground impact timer (advances every frame, cleared when expired) ──────
    if (local.groundImpact) {
        local.groundImpact.t += dt;
        if (local.groundImpact.t >= local.groundImpact.maxT) local.groundImpact = null;
    }

    // ── Particles tick ──────────────────────────────────────────────────────
    local.particles = local.particles.filter(p => {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += 0.15 * dt;
        p.life -= dt;
        return p.life > 0;
    });

    // Float texts
    local.floatTexts = local.floatTexts.filter(t => {
        t.y += t.vy * dt;
        t.life -= dt;
        return t.life > 0;
    });

    // Wind particles
    local.windParticles.forEach(wp => {
        wp.x += wp.vx * dt;
        if (wp.x < -20) { wp.x = local.W + 20; wp.y = Math.random() * local.H; }
    });

    // Aura update — handled in render via boss state
    local.aura.forEach(a => a.phase += a.speed * 1000 * dt);

    // Shake decay
    if (local.shakeT > 0) {
        local.shakeT -= dt;
        const amp = local.shakeAmp * (local.shakeT / 10);
        local.screenShakeX = (Math.random() - 0.5) * 2 * amp;
        local.screenShakeY = (Math.random() - 0.5) * 2 * amp * 0.6;
        if (local.shakeT <= 0) { local.screenShakeX = 0; local.screenShakeY = 0; local.shakeAmp = 0; }
    } else {
        local.screenShakeX = 0; local.screenShakeY = 0;
    }

    // Outcome handling
    if (local.outcome && session && session.phase === 'active') {
        local.outcomeT += dt;
        if (local.outcomeT > 60 * 0.8) {
            update(ref(database), { [laptopBossSessionPath('phase')]: 'finished' });
        }
    }
}

function damagePlayer(local, player, boss, fromGrab = false) {
    if (player.invulnT > 0 || player.dead) return;
    player.health -= 1;
    player.flashRedT = 14;
    player.invulnT = 60; // 1s invuln
    // Knockback away from boss
    const dir = player.x < boss.x ? -1 : 1;
    player.vx = dir * 7;
    player.vy = -8;
    player.onGround = false;
    bossSpawnParticles(local, player.x, player.y, 8, { color: 'rgba(255,80,80,0.85)', speed: 4, life: 28, size: 4 });
    bossAddShake(local, 5);
    bossFloatText(local, player.x, player.y - 30, '-1', '#ff4d6d');
    if (player.health <= 0) {
        player.dead = true;
        player.vy = -10;
        // ♪ player loses
        bossPlaySound('playerLooseBoss');
        bossDuckApplause('crowdShock');
        stopBossApplause(1400);
    } else {
        // ♪ player takes damage (not from grab, not final hit)
        if (!fromGrab) {
            bossPlaySound('playerHitBoss');
        }
        bossDuckApplause('crowdShock');
    }
}

// ─── Boss render ──────────────────────────────────────────────────────────────

function renderLaptopBoss() {
    const ctx = gameState.ctx;
    const canvas = gameState.canvas;
    const local = gameState.laptopBoss.local;
    const session = gameState.laptopBoss.session;
    if (!ctx || !canvas) return;

    // Defensive reset — clears any leaked canvas state from previous frames
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.setLineDash([]);

    const dpr = gameState.dpr || 1;
    const W = canvas.width / dpr;
    const H = canvas.height / dpr;

    // Update local W/H if window changed
    if (local && (local.W !== W || local.H !== H)) {
        // Recalc groundY proportionally
        local.W = W; local.H = H;
        local.groundY = H * 0.84;
        // Snap player to new ground if was on ground
        if (local.player && local.player.onGround) {
            local.player.y = local.groundY - local.player.h / 2;
        }
        if (local.boss) {
            local.boss.baseY = H * 0.42;
        }
        // Stair position is recomputed each frame in update, so no action needed
    }

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.imageSmoothingEnabled = false;

    // Background — fallback gradient if image not loaded
    const bgImg = gameState.assets.bossBg;
    if (bgImg && bgImg.complete && bgImg.naturalWidth) {
        ctx.drawImage(bgImg, 0, 0, W, H);
    } else {
        const g = ctx.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, '#1a0f2e');
        g.addColorStop(1, '#0a0617');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
    }

    if (!local) {
        // No local state — just darken (teleport hold)
        ctx.restore();
        // Apply teleport overlay if active
        ctx.save();
        ctx.scale(dpr, dpr);
        drawTeleportOverlay(W, H);
        ctx.restore();
        return;
    }

    const player = local.player;
    const boss = local.boss;

    // Screen shake transform
    ctx.save();
    ctx.translate(local.screenShakeX, local.screenShakeY);

    // Wind particles (background polish)
    ctx.save();
    local.windParticles.forEach(wp => {
        ctx.fillStyle = `rgba(220,220,255,${wp.alpha})`;
        ctx.fillRect(wp.x, wp.y, wp.len, wp.size);
    });
    ctx.restore();

    // Ground image
    const groundImg = gameState.assets.bossGround;
    if (groundImg && groundImg.complete && groundImg.naturalWidth) {
        ctx.drawImage(groundImg, 0, 0, W, H);
    } else {
        ctx.fillStyle = '#3a2d1c';
        ctx.fillRect(0, local.groundY, W, H - local.groundY);
    }

    // Stepping platform (weak state only, fades in/out) — pixel-art yellow
    if (local.stair.alpha > 0.01) {
        const st = local.stair;
        ctx.save();
        ctx.globalAlpha = st.alpha;
        ctx.imageSmoothingEnabled = false;
        // Dark shadow band underneath
        ctx.fillStyle = '#5a3e00';
        ctx.fillRect(st.x, st.y + st.h, st.w, 4);
        // Main platform body — bright gold
        ctx.fillStyle = '#f5c400';
        ctx.fillRect(st.x, st.y, st.w, st.h);
        // Dark shading bottom 3px
        ctx.fillStyle = '#b88f00';
        ctx.fillRect(st.x, st.y + st.h - 3, st.w, 3);
        // Pixel-art checkerboard highlight on top row
        const tileW = 8;
        for (let tx = st.x; tx < st.x + st.w; tx += tileW * 2) {
            ctx.fillStyle = '#ffe066';
            ctx.fillRect(tx, st.y, tileW, 3);
        }
        ctx.restore();
    }

    // Aura around boss (skip during weak/end)
    if (boss.state !== 'weak' && boss.state !== 'end') {
        local.aura.forEach(a => {
            const ax = boss.x + Math.cos(a.phase) * a.r;
            const ay = boss.y + Math.sin(a.phase) * a.r * 0.7;
            const alpha = 0.35 + Math.sin(a.phase * 1.5) * 0.18;
            ctx.fillStyle = `rgba(190,140,255,${alpha})`;
            ctx.beginPath();
            ctx.arc(ax, ay, 3, 0, Math.PI * 2);
            ctx.fill();
        });
    }

    // Grab target circle (predict phase)
    if (boss.state === 'grab_predict') {
        // Lock to player live during predict
        const p = boss.stateT / boss.stateDur;
        const pulse = 0.6 + Math.abs(Math.sin(p * Math.PI * 4)) * 0.4;
        ctx.save();
        ctx.strokeStyle = `rgba(0,0,0,${pulse})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(player.x, player.y, 40, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }

    // Grab line — shoot phase (extends from boss to locked target)
    if (boss.state === 'grab_shoot') {
        const lerpT = Math.min(1, (boss.stateT / boss.stateDur) * 2.5);
        ctx.save();
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(boss.x, boss.y);
        ctx.lineTo(boss.x + (boss.grabTargetX - boss.x) * lerpT, boss.y + (boss.grabTargetY - boss.y) * lerpT);
        ctx.stroke();
        ctx.restore();
    }
    // Grab line — pull/hold phase (tether from boss to held player)
    if (boss.state === 'grab_pull' || boss.state === 'grab_hold') {
        ctx.save();
        ctx.strokeStyle = 'rgba(0,0,0,0.60)';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(boss.x, boss.y);
        ctx.lineTo(player.x, player.y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
    }

    // Ground impact shockwave ring
    if (local.groundImpact && local.groundImpact.t < local.groundImpact.maxT) {
        const gi = local.groundImpact;
        const ip = Math.max(0.01, gi.t / gi.maxT); // never 0 — avoids zero-radius ellipse crash
        const ir = ip * 140;
        const ia = (1 - ip) * 0.75;
        ctx.save();
        if (ir > 1) { // guard against sub-pixel radius
            ctx.strokeStyle = `rgba(255,240,140,${ia})`;
            ctx.lineWidth = 3 * (1 - ip) + 1;
            ctx.beginPath();
            ctx.ellipse(gi.x, local.groundY + 10, ir, Math.max(1, ir * 0.3), 0, Math.PI, 0);
            ctx.stroke();
        }
        // Inner ring slightly delayed
        if (ip > 0.15) {
            const ir2 = (ip - 0.15) / 0.85 * 80;
            const ia2 = (1 - ip) * 0.4;
            if (ir2 > 1) {
                ctx.strokeStyle = `rgba(255,200,80,${ia2})`;
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.ellipse(gi.x, local.groundY + 10, ir2, Math.max(1, ir2 * 0.28), 0, Math.PI, 0);
                ctx.stroke();
            }
        }
        ctx.restore();
    }

    // Motion trail echoes — stomp dive and rebound
    if ((boss.state === 'attack_stomp' || boss.state === 'attack_rebound') && boss.motionTrail.length > 0) {
        boss.motionTrail.forEach((tr, i) => {
            if (tr.alpha > 0) drawBossSprite(ctx, boss, tr.x, tr.y, tr.alpha * 0.45);
            tr.alpha = Math.max(0, tr.alpha - 0.018);
        });
    }

    // Boss sprite
    drawBossSprite(ctx, boss, boss.x, boss.y, 1);

    // Shield overlay (over boss sprite, visible when NOT weak)
    const shieldImg = gameState.assets.bossShield;
    if (boss.shieldAlpha > 0.005 && shieldImg && shieldImg.complete && shieldImg.naturalWidth) {
        const sw = BOSS_FRAME_W * BOSS_SPRITE_SCALE * boss.shieldScale * 1.5;
        const sh = BOSS_FRAME_H * BOSS_SPRITE_SCALE * boss.shieldScale * 1.5;
        ctx.save();
        ctx.globalAlpha = boss.shieldAlpha;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(shieldImg, boss.x - sw / 2, boss.y - sh / 2, sw, sh);
        ctx.restore();
    }

    // Boss hearts above boss
    drawBossHearts(ctx, boss.x, boss.y - 90, boss.health, BOSS_MAX_HEALTH, 1);

    // Weak-state time bar (below hearts, depletes over 3 s)
    if (boss.state === 'weak') {
        const barW = 80;
        const barH = 6;
        const barX = boss.x - barW / 2;
        const barY = boss.y - 90 + 38; // just below hearts row
        const pct  = Math.max(0, 1 - boss.stateT / boss.stateDur);
        // Background track
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(barX - 1, barY - 1, barW + 2, barH + 2, 3);
        else ctx.rect(barX - 1, barY - 1, barW + 2, barH + 2);
        ctx.fill();
        // Fill — yellow → red as it drains
        const r = Math.round(255);
        const g = Math.round(220 * pct);
        ctx.fillStyle = `rgb(${r},${g},0)`;
        if (ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(barX, barY, barW * pct, barH, 2);
            ctx.fill();
        } else {
            ctx.fillRect(barX, barY, barW * pct, barH);
        }
        ctx.restore();
    }

    // Player avatar
    if (!player.dead || player.y < local.H + 100) {
        drawPlayerAvatar(ctx, player, local);
    }

    // Player hearts above avatar (world space, moves with player)
    if (!player.dead || player.y < local.H + 100) {
        drawBossHearts(ctx, player.x, player.y - player.h / 2 - 36, player.health, PLAYER_BOSS_MAX_HEALTH, 0.8, false);
    }

    // Particles
    local.particles.forEach(p => {
        const a = Math.max(0, p.life / p.maxLife);
        ctx.fillStyle = p.color.replace(/[\d.]+\)$/, `${a.toFixed(2)})`);
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    });

    // Float texts
    local.floatTexts.forEach(t => {
        const a = t.life / t.maxLife;
        ctx.save();
        ctx.fillStyle = t.color;
        ctx.globalAlpha = a;
        ctx.font = 'bold 18px Rubik';
        ctx.textAlign = 'center';
        ctx.fillText(t.text, t.x, t.y);
        ctx.restore();
    });

    ctx.restore(); // shake

    // Countdown overlay (if not yet started)
    if (session && session.startTime && serverNow() < session.startTime) {
        const remaining = Math.max(0, session.startTime - serverNow());
        const sec = Math.ceil(remaining / 1000);
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 90px Rubik';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(sec.toString(), W / 2, H / 2);
        ctx.font = 'bold 22px Rubik';
        ctx.fillText('استعد', W / 2, H / 2 + 70);
        ctx.restore();
    }

    // Outcome overlay (win/lose pre-results screen)
    if (local.outcome) {
        const a = Math.min(1, local.outcomeT / 30);
        ctx.save();
        ctx.fillStyle = `rgba(0,0,0,${0.55 * a})`;
        ctx.fillRect(0, 0, W, H);
        if (gameState.laptopBoss.showResultsInGame) {
            drawBossResultsPanel(ctx, W, H, local.outcome);
        }
        ctx.restore();
    } else if (gameState.laptopBoss.showResultsInGame && session?.phase === 'finished') {
        // Direct render of results panel (re-entered finished phase)
        ctx.save();
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(0, 0, W, H);
        drawBossResultsPanel(ctx, W, H, local.outcome || 'win');
        ctx.restore();
    }

    // Teleport overlay (fade in/out)
    drawTeleportOverlay(W, H);

    ctx.restore(); // dpr
}

function drawBossSprite(ctx, boss, x, y, alpha) {
    let sheet = null;
    let frames = 0;
    let frameIdx = 0;
    if (boss.state === 'intro' || boss.state === 'idle') {
        sheet = gameState.assets.bossIdle;
        frames = BOSS_IDLE_FRAMES;
        frameIdx = Math.floor((boss.floatT * 600) / 100) % frames;
    } else if (boss.state === 'grab_predict' || boss.state === 'attack_anticipate') {
        sheet = gameState.assets.bossAnticipation;
        frames = BOSS_ANTICIPATION_FRAMES;
        // Play through 0..7 across the state's duration
        frameIdx = Math.min(frames - 1, Math.floor((boss.stateT / boss.stateDur) * frames));
    } else if (boss.state === 'grab_shoot' || boss.state === 'attack_stomp') {
        sheet = gameState.assets.bossAttack;
        frames = BOSS_ATTACK_FRAMES;
        frameIdx = Math.min(frames - 1, Math.floor((boss.stateT / boss.stateDur) * frames));
    } else if (boss.state === 'grab_pull' || boss.state === 'grab_hold' ||
               boss.state === 'attack_impact' || boss.state === 'attack_rebound') {
        // Hold last frame of attack sheet
        sheet = gameState.assets.bossAttack;
        frames = BOSS_ATTACK_FRAMES;
        frameIdx = frames - 1;
    } else if (boss.state === 'grab_release_kidnap' || boss.state === 'attack_return') {
        sheet = gameState.assets.bossIdle;
        frames = BOSS_IDLE_FRAMES;
        frameIdx = Math.floor((boss.floatT * 600) / 100) % frames;
    } else if (boss.state === 'weak' || boss.state === 'end') {
        sheet = gameState.assets.bossWeak;
        frames = BOSS_WEAK_FRAMES;
        if (boss.state === 'weak') {
            // Animate once, then hold
            frameIdx = Math.min(frames - 1, Math.floor(boss.stateT / 6));  // 100ms/frame at 60fps = 6 frames per sprite frame
        } else {
            frameIdx = frames - 1;
        }
    }

    if (!sheet || !sheet.complete || !sheet.naturalWidth) {
        // Fallback: solid purple box
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = '#7b4dff';
        const w = BOSS_FRAME_W * BOSS_SPRITE_SCALE;
        const h = BOSS_FRAME_H * BOSS_SPRITE_SCALE;
        ctx.fillRect(x - w / 2, y - h / 2, w, h);
        ctx.restore();
        return;
    }

    const sw = BOSS_FRAME_W;
    const sh = BOSS_FRAME_H;
    const dw = sw * BOSS_SPRITE_SCALE * (boss.scale || 1);
    const dh = sh * BOSS_SPRITE_SCALE * (boss.scale || 1);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.imageSmoothingEnabled = false;
    if (boss.flashWhiteT > 0) {
        ctx.filter = 'brightness(2.5)';
    }
    ctx.drawImage(sheet, frameIdx * sw, 0, sw, sh, x - dw / 2, y - dh / 2, dw, dh);
    ctx.filter = 'none';
    ctx.restore();
}

function drawPlayerAvatar(ctx, player, local) {
    const r = player.w / 2;
    // Squash/stretch
    const sx = 1 + (1 - player.squashT) * 0.25;
    const sy = player.squashT;

    // Blink during invuln
    const blink = player.invulnT > 0 && Math.floor(player.invulnT / 4) % 2 === 0;
    if (blink) {
        // skip drawing for a flicker effect
        return;
    }

    ctx.save();
    ctx.translate(player.x, player.y);
    ctx.scale(sx, sy);
    // Avatar circle clip
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.clip();
    const av = gameState.avatarCache[gameState.userId];
    if (av && av !== 'failed' && av.complete) {
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(av, -r, -r, r * 2, r * 2);
    } else {
        ctx.fillStyle = COLORS.blue;
        ctx.fillRect(-r, -r, r * 2, r * 2);
    }
    // Flash overlays
    if (player.flashRedT > 0) {
        ctx.fillStyle = `rgba(255,40,40,${Math.min(1, player.flashRedT / 14)})`;
        ctx.fillRect(-r, -r, r * 2, r * 2);
    }
    if (player.flashWhiteT > 0) {
        ctx.fillStyle = `rgba(255,255,255,${Math.min(1, player.flashWhiteT / 14)})`;
        ctx.fillRect(-r, -r, r * 2, r * 2);
    }
    ctx.restore();

    // Outline ring
    ctx.save();
    ctx.beginPath();
    ctx.arc(player.x, player.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
}

function drawBossHearts(ctx, x, y, current, max, scale, leftAnchored) {
    const heartSize = 30 * (scale || 1);
    const gap = 6;
    const totalW = max * heartSize + (max - 1) * gap;
    const startX = leftAnchored ? x - heartSize / 2 : x - totalW / 2;
    const fullImg = gameState.assets.bossHeart;
    const deadImg = gameState.assets.bossHeartDead;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    for (let i = 0; i < max; i++) {
        const hx = startX + i * (heartSize + gap);
        const hy = y;
        const img = i < current ? fullImg : deadImg;
        if (img && img.complete && img.naturalWidth) {
            ctx.drawImage(img, hx, hy, heartSize, heartSize);
        } else {
            ctx.fillStyle = i < current ? '#ff4d6d' : '#444';
            ctx.fillRect(hx, hy, heartSize, heartSize);
        }
    }
    ctx.restore();
}

function drawBossResultsPanel(ctx, W, H, outcome) {
    const panelW = 360;
    const panelH = 220;
    const px = (W - panelW) / 2;
    const py = (H - panelH) / 2;
    ctx.save();
    ctx.fillStyle = 'rgba(20,12,32,0.94)';
    if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(px, py, panelW, panelH, 18);
        ctx.fill();
    } else {
        ctx.fillRect(px, py, panelW, panelH);
    }
    ctx.strokeStyle = 'rgba(180,140,255,0.20)';
    ctx.lineWidth = 1;
    if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(px, py, panelW, panelH, 18);
        ctx.stroke();
    }
    ctx.fillStyle = 'white';
    ctx.font = 'bold 36px Rubik';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(outcome === 'win' ? 'انتصرت!' : 'هزمت!', W / 2, py + 60);
    ctx.font = 'bold 18px Rubik';
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText(outcome === 'win' ? 'لقد قضيت على الحاسوب' : 'حاول مرة أخرى', W / 2, py + 110);

    // Return button
    const btnW = 160, btnH = 48;
    const bx = px + (panelW - btnW) / 2;
    const by = py + panelH - btnH - 22;
    ctx.fillStyle = outcome === 'win' ? '#5b3aff' : '#553344';
    if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(bx, by, btnW, btnH, 24);
        ctx.fill();
    } else {
        ctx.fillRect(bx, by, btnW, btnH);
    }
    ctx.fillStyle = 'white';
    ctx.font = 'bold 18px Rubik';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('عودة', bx + btnW / 2, by + btnH / 2);
    gameState.laptopBoss.resultsButtonRect = { x: bx, y: by, w: btnW, h: btnH };
    ctx.restore();
}

// EOF
