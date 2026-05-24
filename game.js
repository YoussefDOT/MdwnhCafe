import { database, ref, onValue, update, get, onDisconnect, set, remove } from './firebase-config.js';

// ─── Mobile detection ────────────────────────────────────────────────────────
const MOBILE_BREAKPOINT = 1024;
function isMobile() { return window.innerWidth < MOBILE_BREAKPOINT; }
function setMobileClass() {
    document.body.classList.toggle('is-mobile', isMobile());
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
    const data = snap.val();
    if (!data) return null;
    if (data.lobby && LOBBY_CONFIG[data.lobby]) return data.lobby;
    if (data.categoryName) {
        for (const [key, cfg] of Object.entries(LOBBY_CONFIG)) {
            if (cfg.categoryName === data.categoryName) return key;
        }
    }
    return null;
}

async function enterGameAsDiscordUser(user, lobby) {
    gameState.selectedLobby = lobby;

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
    }

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
                        if (sound.nodes) {
                            try { sound.nodes.source?.stop(); } catch(e) {}
                            try { sound.nodes.gainNode?.disconnect(); } catch(e) {}
                            sound.nodes.secondaryNodes?.forEach(n => {
                                try { n.stop(); } catch(e) {}
                                try { n.disconnect(); } catch(e) {}
                            });
                            sound.nodes = null;
                        }
                        this.startSound(name);
                    }
                }).catch(e => {});
            }
        });
    }

    async loadSoundEffects() {
        try {
            const loadBuffer = async (url) => {
                const response = await fetch(url);
                const arrayBuffer = await response.arrayBuffer();
                return await this.ctx.decodeAudioData(arrayBuffer);
            };
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
    }

    async loadFocusSoundBuffers() {
        const files = {
            rain:         'Sound/Focus Sounds/Rain.mp3',
            rain_muffled: 'Sound/Focus Sounds/Muffled rain.mp3',
            fire:         'Sound/Focus Sounds/Boiling.mp3',
            forest:       'Sound/Focus Sounds/Forest.mp3',
            brown:        'Sound/Focus Sounds/Brown Noise.mp3',
            wind:         'Sound/Focus Sounds/Wind.mp3',
            ocean:        'Sound/Focus Sounds/Ocean.mp3',
        };
        // Load all sounds in parallel — each starts playing as soon as its own buffer is ready
        // (previously sequential: one slow file blocked all others on mobile)
        await Promise.all(Object.entries(files).map(async ([key, url]) => {
            try {
                const response = await fetch(url);
                const arrayBuffer = await response.arrayBuffer();
                this.focusBuffers[key] = await this.ctx.decodeAudioData(arrayBuffer);
                // Remove loading indicator now that this sound is buffered
                const el = document.querySelector(`.sound-item[data-sound="${key}"]`);
                if (el) el.classList.remove('sound-loading');
                // If the user toggled this sound on while it was still loading, start it now
                const sound = this.sounds[key];
                if (sound?.active && !sound.nodes && this.ctx.state === 'running') {
                    this.startSound(key);
                }
            } catch(e) {
                console.log(`Failed to load focus sound [${key}]:`, e);
            }
        }));
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

        if (['rain', 'rain_muffled', 'fire', 'forest', 'brown', 'wind', 'ocean'].includes(name)) {
            const buf = this.focusBuffers?.[name];
            if (!buf) { gainNode.disconnect(); return; }
            source = this.ctx.createBufferSource();
            source.buffer = buf;
            source.loop = true;
            // Skip fade-in at start and fade-out at end for seamless looping
            const fadePad = Math.min(2.0, buf.duration * 0.08);
            source.loopStart = fadePad;
            source.loopEnd = buf.duration - fadePad;
            source.connect(gainNode);
            source.start(0, fadePad);
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
        }

        sound.nodes = { source, gainNode, secondaryNodes };
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

        const gainNode = sound.nodes.gainNode;
        const nodesToStop = [sound.nodes.source, ...sound.nodes.secondaryNodes];
        sound.nodes = null; // immediately clear so startSound can restart without blocking

        try {
            gainNode.gain.cancelScheduledValues(this.ctx.currentTime);
            gainNode.gain.setValueAtTime(gainNode.gain.value, this.ctx.currentTime);
            gainNode.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.5);
        } catch (e) {
            gainNode.gain.value = 0;
        }

        setTimeout(() => {
            nodesToStop.forEach(n => {
                try { n.stop(); } catch(e) {}
                try { n.disconnect(); } catch(e) {}
            });
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
    }

    updateOverallVolume(val) {
        this.overallVolume = parseFloat(val);
        const inWorkPhase = (gameState.pomodoro.active && gameState.pomodoro.phase === 'work')
            || (gameState.freeMode.active && gameState.freeMode.phase === 'work');
        if (this.masterGain && inWorkPhase) {
            this.masterGain.gain.setValueAtTime(this.overallVolume, this.ctx.currentTime);
        }
        this.saveToFirebase();
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
            if (gameState.userId && (Math.floor(cur) % 5 === 0)) {
                update(ref(database), { [`users/${gameState.userId}/focusPlayer/timestamp`]: Math.floor(cur) });
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
    laptops: [],
    activeLaptop: null,
    isLockedIn: false,
    focusAlpha: 0,
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
        type: null,                // 'morning' | 'evening'
        startTime: 0,              // overlay opened at
        minLockMs: 180000,         // 3 min lock before انتهيت enables (5 s for Siraj)
        counts: [],                // remaining count per zikr index
        currentIndex: 0,
        completed: {},             // { morning: 'YYYY-MM-DD', evening: 'YYYY-MM-DD' }
        // saved-state to restore on close
        pausedPomoRemaining: 0,
        pausedPomoPhase: null,
        pausedFreeWorkStart: 0,
        pausedFreeWorkSnap: 0,
        ytWasPlaying: false,
        ytVolumeBefore: 80,
        focusMobileWasActive: false,
        _lastButtonRefresh: 0,
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

function isBreakActive() {
    return (gameState.pomodoro.active && gameState.pomodoro.phase === 'break')
        || (gameState.freeMode.active && gameState.freeMode.phase === 'break');
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
        lerpEntityRenderTowardTarget(player);
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

// Initialize game
function init() {
    setMobileClass(); // set body.is-mobile before anything renders
    loadAssets();
    loadRaceTrackAsset();
    setupLobbySelection();   // ← shows lobby screen first; calls setupUserSelection internally
    setupModal();
    initWindParticles();
    initLaptops();
    initDiscordOAuth();      // Discord button on lobby; auto-resume if session exists
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
}

function initWindParticles() {
    const count = isMobile() ? WIND_PARTICLE_COUNT_MOBILE : WIND_PARTICLE_COUNT;
    for (let i = 0; i < count; i++) {
        gameState.windParticles.push({
            x: Math.random() * window.innerWidth,
            y: Math.random() * window.innerHeight,
            size: 2 + Math.floor(Math.random() * 2),
            length: 2 + Math.floor(Math.random() * 3),
            speed: 3 + Math.random() * 5,
            opacity: 0.1 + Math.random() * 0.4,
            parallax: 1.3 + Math.random() * 0.6
        });
    }
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

    onValue(usersRef, (snapshot) => {
        const users = snapshot.val();
        if (gameState.userId) return;

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

    // Set HUD avatar image
    const hudAvatar = document.getElementById('hud-avatar');
    if (hudAvatar && userData.avatar) hudAvatar.src = userData.avatar;

    // Apply mobile class immediately
    setMobileClass();

    // Initialize Focus Audio Engine & Setup Focus UI
    gameState.focusAudioEngine = new FocusAudioEngine();
    gameState.focusYTPlayer = new FocusYouTubePlayer();
    setupFocusPanelUI();

    // Set active presence in game and set up disconnect presence cleanup
    const activeRef = ref(database, `users/${gameState.userId}/activeInGame`);
    set(activeRef, true);
    if (gameState.isSirajGhost) {
        // Siraj ghost: delete entire user entry on disconnect
        onDisconnect(ref(database, `users/${gameState.userId}`)).remove();
    } else {
        onDisconnect(activeRef).set(false);

        // Single-session enforcement: each login writes a unique token. If another
        // tab/device logs in with the same account, it overwrites the token. The
        // original tab detects the mismatch and shows a "logged in elsewhere" overlay.
        const _tok = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        gameState._sessionToken = _tok;
        const sessionRef = ref(database, `users/${gameState.userId}/activeSession`);
        set(sessionRef, _tok);
        onDisconnect(sessionRef).set(null);
        onValue(sessionRef, snap => {
            const live = snap.val();
            if (live && live !== gameState._sessionToken) {
                document.getElementById('dup-session-overlay')?.classList.add('active');
                // Halt the game loop gently — the overlay reload button will refresh.
                gameState._dupSessionDetected = true;
            }
        });
    }

    document.getElementById('login-screen').classList.remove('active');
    document.getElementById('game-screen').classList.add('active');
    document.body.classList.add('game-ready');
    document.getElementById('current-user').textContent = userData.username;
    document.getElementById('channel-name').textContent = userData.channelName || 'قناة غير معروفة';
    gameState.canvas = document.getElementById('game-canvas');
    gameState.ctx = gameState.canvas.getContext('2d');
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
    listenToPomodoro();
    listenToRace();
    listenToCoffee();
    initSharedPomo();
    setupPomoLeaveBtn();
    setupFreeModeUI();
    initPrayerSystem();
    setupAzkarUI();

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
                    // Restore laptop doc to active state and re-register onDisconnect
                    update(ref(database), {
                        [lobbyPath(`pomodoro/${lapId}/phase`)]: 'free-work',
                        [lobbyPath(`pomodoro/${lapId}/savedAt`)]: 0,
                    });
                    onDisconnect(ref(database, lobbyPath(`pomodoro/${lapId}`))).update({
                        phase: 'wait',
                        savedAt: { '.sv': 'timestamp' },
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

            // Reclaim an abandoned session (saved by cleanupAbandonedPomoSessions on a previous login)
            if (activeLaptopId === null && data?.lastPomoSession) {
                const ls = data.lastPomoSession;
                const FOUR_HOURS = 4 * 60 * 60 * 1000;
                const now = Date.now();
                const stillValid = ls.abandonedAt && (now - ls.abandonedAt < FOUR_HOURS) && ls.sessionsLeft > 0;
                const freeLaptop = stillValid ? gameState.laptops.find(l => !l.claimedBy) : null;
                if (freeLaptop) {
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
                        [lobbyPath(`pomodoro/${freeLaptop.id}`)]: restoredDoc,
                        [`users/${gameState.userId}/lastPomoSession`]: null,
                    });
                    applyPomodoroStateToLaptop(freeLaptop, restoredDoc);
                    activeLaptopId = freeLaptop.id;
                    gameState.pomodoro.active       = true;
                    gameState.pomodoro.laptopId     = freeLaptop.id;
                    gameState.pomodoro.phase        = restoredPhase;
                    gameState.pomodoro.endTime      = newEndTime;
                    gameState.pomodoro.sessionsLeft = ls.sessionsLeft;
                    gameState.pomodoro.workDuration = ls.workDuration;
                    gameState.pomodoro.breakDuration = ls.breakDuration || 5;
                    gameState.pomodoro.totalSessions = ls.totalSessions || ls.sessionsLeft || 1;
                    gameState.pomodoro.createdAt    = ls.createdAt || now;
                    locked = restoredPhase === 'work';
                } else {
                    // Stale or no free device — discard
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

    gameLoop();
}

function resizeCanvas() {
    if (!gameState.canvas) return;
    const dpr = window.devicePixelRatio || 1;
    gameState.dpr = dpr;
    const w = window.innerWidth;
    const h = window.innerHeight;
    gameState.canvas.width  = w * dpr;
    gameState.canvas.height = h * dpr;
    gameState.canvas.style.width  = w + 'px';
    gameState.canvas.style.height = h + 'px';
}

let _resizeTimer = null;
window.addEventListener('resize', () => {
    if (_resizeTimer) clearTimeout(_resizeTimer);
    _resizeTimer = setTimeout(() => {
        resizeCanvas();
        setMobileClass();
        _resizeTimer = null;
    }, 150);
});

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
    if (leaveWrap) leaveWrap.style.visibility = hidden ? 'hidden' : '';
    if (logoutBtn) logoutBtn.style.visibility = hidden ? 'hidden' : '';
}

/** Show/hide user card during focus work phase (mobile only) */
function setMobileFocusMode(active) {
    const card     = document.getElementById('user-card');
    const logout   = document.getElementById('logout-btn');
    const joystick = document.getElementById('mobile-joystick');
    if (active && isMobile()) {
        if (card)     card.classList.add('focus-hidden');
        if (logout)   logout.classList.add('focus-hidden');
        if (joystick) joystick.classList.add('focus-hidden');
    } else {
        if (card)     card.classList.remove('focus-hidden');
        if (logout)   logout.classList.remove('focus-hidden');
        if (joystick) joystick.classList.remove('focus-hidden');
    }
}

/** Show or hide the race d-pad, and toggle joystick visibility */
function showMobileRaceButtons(show) {
    if (!isMobile()) return;
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
    if (gameState.isSirajGhost) {
        document.getElementById('test-mode-modal').classList.add('active');
    } else {
        document.getElementById('mode-select-modal').classList.add('active');
    }
}

function setupModeSelectUI() {
    const modal = document.getElementById('mode-select-modal');
    if (!modal) return;

    document.getElementById('mode-select-back')?.addEventListener('click', () => {
        modal.classList.remove('active');
    });

    document.getElementById('mode-select-pomo')?.addEventListener('click', () => {
        modal.classList.remove('active');
        document.getElementById('pomodoro-modal').classList.add('active');
    });

    document.getElementById('mode-select-free')?.addEventListener('click', () => {
        modal.classList.remove('active');
        startFreeMode(null, false);
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
        modal.classList.remove('active');
        document.getElementById('mode-select-modal').classList.add('active');
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
        // Host pushes phaseEndTime to the live doc so guests stay in sync across
        // break and subsequent work cycles (agreedEndTime only covers the first cycle).
        const _sp = gameState.sharedPomo;
        if (_sp.isHost && _sp.phase === 'active' && _sp.sessionId) {
            updates[spPath(`live/${_sp.sessionId}/phaseEndTime`)] = gameState.pomodoro.endTime;
        }
        update(ref(database), updates);
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
                        // If this is a VC ghost with no saved position, assign a random
                        // non-overlapping spawn and persist it so they inherit it on login.
                        let spawnX = userData.x || 0;
                        let spawnY = userData.y || 0;
                        if (!isCurrentUser && !userData.x) {
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
                        };
                    } else {
                        const player = gameState.players[userId];
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
                            setEntityTarget(player, userData.x || 0, userData.y || 0);
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
                if (id !== gameState.userId && !currentIdsInSnapshot.has(id)) { delete gameState.players[id]; }
            });
            const playerCount = Object.keys(gameState.players).length;
            const countElem = document.getElementById('player-count');
            if (countElem) countElem.textContent = `${playerCount} مستخدم${playerCount > 10 ? '' : (playerCount > 2 ? 'ين' : '')}`;
        }
    });
}

function updatePlayerPosition(x, y) {
    if (!gameState.userId) return;
    const player = gameState.players[gameState.userId];
    const updates = {};
    updates[`users/${gameState.userId}/x`] = x;
    updates[`users/${gameState.userId}/y`] = y;
    updates[`users/${gameState.userId}/lobby`] = gameState.selectedLobby;
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
        updatePlayerPosition(player.x, player.y);

        if (Math.random() < (isSprinting ? 0.8 : 0.4) * gameState.dtFactor) {
            spawnDust(player.renderX, player.renderY, isSprinting ? 2 : 1, false);
        }
    } else {
        if (player.isMoving) {
            player.isMoving = false;
            player.isSprinting = false;
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
    let closestDist = 120;
    let minDist = Infinity;

    gameState.laptops.forEach(laptop => {
        const dist = Math.sqrt(Math.pow(player.x - laptop.x, 2) + Math.pow(player.y - laptop.y, 2));
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

    const baseAlpha = gameState.isLockedIn ? 0.475 : 0.4;
    let targetAlpha = 0;
    if (gameState.isLockedIn) {
        // Always full darkening when locked in — don't rely on proximity
        targetAlpha = baseAlpha;
    } else if (gameState.activeLaptop) {
        // Proximity fade when approaching a laptop
        targetAlpha = Math.min(baseAlpha, Math.max(0, (1 - minDist / 120) * 1.5));
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

function updateDustParticles() {
    for (let i = gameState.dustParticles.length - 1; i >= 0; i--) {
        const p = gameState.dustParticles[i];
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
    // On mobile, cap dtFactor more aggressively to reduce stutters from dropped frames
    if (isMobile() && gameState.dtFactor > 2) gameState.dtFactor = 2;

    try {
        updatePomodoro();
        updateTeleportAnim();
        updateCoffeeTeleportAnim();
        cleanupStaleRaceSession(gameState.race.session);
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
        updatePlayerBobbing();
        updateNametags();
        updateAvatarColorFade();
        updateWindParticles();
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

    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(gameState.zoom, gameState.zoom);
    ctx.translate(gameState.camera.x, gameState.camera.y);

    drawRooms();
    if (gameState.assets.tables.complete) {
        ctx.drawImage(gameState.assets.tables, TABLE_BOX.minX, TABLE_BOX.minY, TABLE_WIDTH, TABLE_HEIGHT);
    }
    drawBreakDoor();
    drawRaceMachine();
    drawCoffeeMachine();

    drawConnections();

    if (gameState.anim.active && (gameState.anim.phase === 'reach' || gameState.anim.phase === 'align' || gameState.anim.phase === 'pull')) {
        drawKidnapLine();
    }

    drawDustParticles();
    drawPlayers(false);
    drawCoopEmojiFloats();
    drawCoopGroupLabels();
    drawTimers();

    drawRoomShadows();
    drawBreakDoor();
    drawRaceHint();
    drawCoffeeHint();

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
        const showPrayer = gameState.pomodoro.active || gameState.freeMode.active;
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

    const player = gameState.players[gameState.userId];
    if (player && Math.hypot(player.x, player.y - y) < 190) {
        ctx.font = 'bold 15px Rubik';
        ctx.textAlign = 'center';
        ctx.fillStyle = 'white';
        ctx.shadowBlur = 8;
        ctx.shadowColor = 'black';
        ctx.fillText(open ? 'باب الاستراحة مفتوح' : 'باب الاستراحة مغلق', 0, y - 72);
        ctx.shadowBlur = 0;
    }
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
    const anim = gameState.race.teleportAnim || gameState.coffee.teleportAnim;
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
    const laptop = gameState.isLockedIn ? null : (gameState.activeLaptop || gameState.lastActiveLaptop);

    if (player) {
        mCtx.globalCompositeOperation = 'destination-out';
        const centerX = mCanvas.width  / 2;
        const centerY = mCanvas.height / 2;
        const zoom = gameState.zoom;
        const { x: playerX, y: playerY } = getPlayerRenderPos(player);
        const pScreenX = centerX + (playerX + gameState.camera.x) * zoom * dpr;
        const pScreenY = centerY + (playerY + gameState.camera.y) * zoom * dpr;

        const pRadius = (gameState.isLockedIn ? 85 : 75) * zoom * dpr;
        if (isMobile()) {
            // Skip gradient allocation on mobile — solid circle is imperceptible difference
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

        if (laptop && !gameState.isLockedIn) {
            const lScreenX = centerX + (laptop.x + gameState.camera.x) * zoom * dpr;
            const lScreenY = centerY + (laptop.y + gameState.camera.y) * zoom * dpr;
            const lRadius = 100 * zoom * dpr;
            if (isMobile()) {
                mCtx.fillStyle = 'rgba(255, 255, 255, 1)';
            } else {
                const lGrad = mCtx.createRadialGradient(lScreenX, lScreenY, lRadius * 0.4, lScreenX, lScreenY, lRadius);
                lGrad.addColorStop(0, 'rgba(255, 255, 255, 1)');
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
    if (gameState.activeLaptop && !gameState.isLockedIn && !gameState.anim.active) {
        drawPrompt(gameState.activeLaptop);
    }
    ctx.restore();
}

function drawPrompt(laptop) {
    const ctx = gameState.ctx;

    // If already in a Pomodoro or free mode, don't show prompt to start another one
    if (gameState.pomodoro.active || gameState.freeMode.active) {
        if (laptop.claimedBy && laptop.claimedBy !== gameState.userId) {
            let ownerName = "شخص آخر";
            const owner = gameState.players[laptop.claimedBy];
            if (owner) {
                ownerName = owner.username;
            }
            ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
            ctx.font = 'bold 14px Rubik';
            ctx.textAlign = 'center';
            ctx.shadowBlur = 4;
            ctx.shadowColor = 'black';
            ctx.fillText(`هذا الجهاز تابع لـ ${ownerName}`, laptop.x, laptop.y - 45);
            ctx.shadowBlur = 0;
        }
        return;
    }

    if (laptop.claimedBy) {
        let ownerName = "شخص آخر";
        const owner = gameState.players[laptop.claimedBy];
        if (owner) {
            ownerName = owner.username;
        }
        ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
        ctx.font = 'bold 14px Rubik';
        ctx.textAlign = 'center';
        ctx.shadowBlur = 4;
        ctx.shadowColor = 'black';
        ctx.fillText(`هذا الجهاز تابع لـ ${ownerName}`, laptop.x, laptop.y - 45);
        ctx.shadowBlur = 0;
        return;
    }

    ctx.fillStyle = 'white';
    ctx.font = 'bold 16px Rubik';
    ctx.textAlign = 'center';
    ctx.shadowBlur = 4;
    ctx.shadowColor = 'black';
    ctx.fillText('انقر للبدء', laptop.x, laptop.y - 45);
    ctx.shadowBlur = 0;
}

function enforceAudioFailsafe() {
    if (gameState.isLockedIn) return;
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
    ctx.save();
    gameState.windParticles.forEach(p => {
        const offsetX = gameState.camera.x * (p.parallax - 1.0) * gameState.zoom;
        const offsetY = gameState.camera.y * (p.parallax - 1.0) * gameState.zoom;
        let drawX = (p.x + offsetX) % w;
        let drawY = (p.y + offsetY) % h;
        if (drawX < 0) drawX += w;
        if (drawY < 0) drawY += h;
        ctx.fillStyle = `rgba(255, 255, 255, ${p.opacity})`;
        for (let i = 0; i < p.length; i++) {
            ctx.fillRect(drawX + (i * p.size), drawY, p.size, p.size);
        }
    });
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

    if (isMobile()) {
        // Simple static overlay on mobile — no gradient allocation every frame
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
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.setLineDash([5, 5]);
    ctx.lineWidth = 2;
    for (const players of Object.values(channelGroups)) {
        if (players.length > 1) {
            for (let i = 0; i < players.length; i++) {
                for (let j = i + 1; j < players.length; j++) {
                    const p1 = players[i], p2 = players[j];
                    ctx.beginPath();
                    const pos1 = getPlayerRenderPos(p1);
                    const pos2 = getPlayerRenderPos(p2);
                    ctx.moveTo(pos1.x, pos1.y);
                    ctx.lineTo(pos2.x, pos2.y);
                    ctx.stroke();
                }
            }
        }
    }
    ctx.setLineDash([]);
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

        if (isWorking && !tpData) {
            const workT = Date.now() * 0.005;
            workBob = Math.sin(workT) * 3;
            workAngle = Math.sin(workT * 0.5) * 0.08;
            workScaleY = 1.0 + Math.sin(workT) * 0.04;
            workScaleX = 1.0 - Math.sin(workT) * 0.04;
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

        const colorAlpha = isCurrentUser ? 1 : (player.avatarColorAlpha ?? 0);
        const grayMix = 1 - colorAlpha;
        const ringColor = isCurrentUser ? COLORS.blue : '#ffffff';
        const mutedRing = '#8a8a8a';

        ctx.save();
        if (tpFadeOut > 0.01) ctx.globalAlpha = 1 - tpFadeOut;
        ctx.translate(screenX + coopDX, screenY + workBob + coopDY + tpFlyOffsetY);
        ctx.rotate(workAngle);
        ctx.scale(workScaleX, workScaleY);

        if (grayMix > 0.01) {
            ctx.filter = `saturate(${colorAlpha}) brightness(${0.72 + 0.28 * colorAlpha})`;
            ctx.globalAlpha = 0.55 + 0.45 * colorAlpha;
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

        if (player.nameAlpha > 0.01 && !tpData) {
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

function spPath(sub) { return lobbyPath(`sharedPomo/${sub}`); }

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
        // Still detect nearby coop sessions even when not idle for join flow
        if (!gameState.pomodoro.active && !gameState.freeMode.active) checkNearbyCoopSession();
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
        // The host writes phaseEndTime to the live doc whenever startPomodoroPhase
        // fires. Guests read it here and correct any drift from loading-time variance.
        if (!sp.isHost && sp.phase === 'active' && gameState.pomodoro.active && data.phaseEndTime) {
            const drift = Math.abs(gameState.pomodoro.endTime - data.phaseEndTime);
            if (drift > 1500) { // only correct if off by more than 1.5 s
                if (gameState.pomodoro.phase === 'break' || gameState.pomodoro.phase === 'work') {
                    gameState.pomodoro.endTime = data.phaseEndTime;
                } else if (gameState.pomodoro.phase === 'wait') {
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
    // On disconnect: keep laptop claimed but mark as 'wait' so others see the AFK badge.
    // Don't remove — we want to restore on reconnect.
    onDisconnect(ref(database, lobbyPath(`pomodoro/${laptop.id}`))).update({
        phase: 'wait',
        savedAt: { '.sv': 'timestamp' },
    });

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

    // Re-register onDisconnect with the current totalWorkMs so a sudden disconnect
    // doesn't roll back to the last-saved value.
    onDisconnect(ref(database, lobbyPath(`pomodoro/${fm.laptopId}`))).update({
        phase:       'wait',
        totalWorkMs: currentTotalMs,
        savedAt:     { '.sv': 'timestamp' },
    });
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

    // Periodically persist totalWorkMs so it's available if the tab closes
    if (fm.phase === 'work' && fm.workStartTime > 0 && Date.now() - fm._lastSavedAt > 15000) {
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
        // Cancel the onDisconnect 'wait' handler so explicit end doesn't trigger it
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
        shouldShow = true;
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
    { country: 'المغرب', cities: [
        { name: 'الدار البيضاء', lat: 33.5731, lon: -7.5898 },
        { name: 'الرباط', lat: 34.0209, lon: -6.8416 },
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

    // Read location from Firebase (city + country only)
    get(ref(database, `users/${gameState.userId}/prayerLocation`)).then(snap => {
        const loc = snap.val();
        if (loc && (loc.city || loc.country)) {
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

async function fetchPrayerTimes() {
    const loc = gameState.prayer.location;
    if (!loc) return;

    const today = new Date();
    const dateStr = `${String(today.getDate()).padStart(2, '0')}-${String(today.getMonth() + 1).padStart(2, '0')}-${today.getFullYear()}`;
    if (gameState.prayer.lastFetchDate === dateStr && gameState.prayer.times) return;

    try {
        let url;
        if (loc._lat != null && loc._lon != null) {
            // In-memory lat/lon from auto-detect this session
            url = `https://api.aladhan.com/v1/timings/${dateStr}?latitude=${loc._lat}&longitude=${loc._lon}&method=5`;
        } else {
            // Loaded from Firebase (city+country only) — use city-based lookup
            const cityName = loc.city || '';
            const countryName = loc.country || '';
            // Try to match city in PRAYER_LOCATIONS for lat/lon
            let matched = null;
            for (const c of PRAYER_LOCATIONS) {
                if (c.country === countryName) {
                    matched = c.cities.find(ci => ci.name === cityName);
                    if (matched) break;
                }
            }
            if (matched) {
                url = `https://api.aladhan.com/v1/timings/${dateStr}?latitude=${matched.lat}&longitude=${matched.lon}&method=5`;
            } else {
                // Use Aladhan city-based API
                url = `https://api.aladhan.com/v1/timingsByCity/${dateStr}?city=${encodeURIComponent(cityName)}&country=${encodeURIComponent(countryName)}&method=5`;
            }
        }
        const res = await fetch(url);
        const json = await res.json();
        if (json.code === 200 && json.data && json.data.timings) {
            const t = json.data.timings;
            gameState.prayer.times = {};
            for (const p of PRAYER_DATA) {
                gameState.prayer.times[p.key] = t[p.key]; // e.g. "12:30"
            }
            gameState.prayer.lastFetchDate = dateStr;
            computeNextPrayer();
            _lastPrayerPanelUpdate = 0; // force tickPrayerPanel to recompute on very next frame
            updatePrayerPanelDOM();
        }
    } catch (e) {
        console.error('[prayer] fetch failed:', e);
    }
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
        const fill = document.getElementById('prayer-progress-fill');
        if (fill) {
            const total = pr.nextPrayer.timeMs - pr.nextPrayer.prevTimeMs;
            const remaining = Math.max(0, pr.nextPrayer.timeMs - now);
            // Fill from 0% (prayer just passed) → 100% (prayer right now)
            const pct = total > 0 ? Math.max(0, Math.min(100, ((total - remaining) / total) * 100)) : 0;
            fill.style.width = `${pct}%`;
        }
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

    // System notification
    try {
        if (Notification.permission === 'granted') {
            new Notification(`🕌 وقت صلاة ${arabicName}`, { body: 'حان وقت الصلاة — الله أكبر' });
        } else if (Notification.permission !== 'denied') {
            Notification.requestPermission().then(p => {
                if (p === 'granted') new Notification(`🕌 وقت صلاة ${arabicName}`, { body: 'حان وقت الصلاة — الله أكبر' });
            });
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
            // Store lat/lon only in memory for API call, not in Firebase
            loc._lat = coords.lat; loc._lon = coords.lon;
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
    // Only save city + country to Firebase (no lat/lon for privacy)
    const fbData = { city: loc.city || '', country: loc.country || '' };
    update(ref(database), { [`users/${gameState.userId}/prayerLocation`]: fbData });
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
    const confirm = document.getElementById('azkar-confirm');
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

    const shouldShow = !!type && !inSharedPomo && !inPrayerOverlay && !azkarOpen && !doneToday;
    btn.classList.toggle('hidden', !shouldShow);
    if (!shouldShow) {
        confirm?.classList.add('hidden');
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
    const confirm = document.getElementById('azkar-confirm');
    confirm?.classList.remove('hidden');
}
function hideAzkarConfirm() {
    document.getElementById('azkar-confirm')?.classList.add('hidden');
}

function markAzkarCompleted(type) {
    const today = _todayDateStr();
    gameState.azkar.completed = gameState.azkar.completed || {};
    gameState.azkar.completed[type] = today;
    if (gameState.userId) {
        update(ref(database), { [`users/${gameState.userId}/azkarCompleted`]: gameState.azkar.completed }).catch(() => {});
    }
    updateAzkarButton();
}

function loadAzkarCompletedFromFirebase() {
    if (!gameState.userId) return;
    get(ref(database, `users/${gameState.userId}/azkarCompleted`)).then(snap => {
        const v = snap.val() || {};
        gameState.azkar.completed = v;
        updateAzkarButton();
    }).catch(() => {});
}

function openAzkarOverlay(type) {
    const az = gameState.azkar;
    if (az.active) return;

    az.active = true;
    az.type = type;
    az.startTime = Date.now();
    az.currentIndex = 0;
    const list = type === 'morning' ? AZKAR_MORNING : AZKAR_EVENING;
    az.counts = list.map(z => z.count);

    // Siraj: shorter lock for testing
    az.minLockMs = gameState.isSirajGhost ? 3000 : 180000;

    document.body.classList.add('azkar-active');
    const overlay = document.getElementById('azkar-overlay');
    if (overlay) {
        overlay.dataset.mode = type;
        overlay.classList.remove('hidden');
        requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('active')));
    }

    // ── Pause pomodoro / freeMode timers ──
    // Solo pomo: snapshot remaining ms (we'll keep extending endTime in update loop)
    if (gameState.pomodoro.active && gameState.sharedPomo.phase !== 'active') {
        az.pausedPomoRemaining = Math.max(0, gameState.pomodoro.endTime - Date.now());
        az.pausedPomoPhase = gameState.pomodoro.phase;
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

    // Stop player movement
    const _local = gameState.players[gameState.userId];
    if (_local) { _local.isMoving = false; _local.isSprinting = false; }
    if (gameState.joystick) { gameState.joystick.active = false; gameState.joystick.dx = 0; gameState.joystick.dy = 0; gameState.joystick.magnitude = 0; gameState.joystick.sprinting = false; }
    ['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','ShiftLeft','ShiftRight']
        .forEach(k => { if (gameState.keys) gameState.keys[k] = false; });

    // ── Stop YouTube (remember if was playing so we can restore) ──
    if (gameState.focusYTPlayer) {
        try {
            const state = gameState.focusYTPlayer.player?.getPlayerState?.() ?? -1;
            az.ytWasPlaying = (state === 1 /* PLAYING */);
            az.ytVolumeBefore = gameState.focusYTPlayer.volume ?? 80;
        } catch (e) { az.ytWasPlaying = false; }
        gameState.focusYTPlayer.fadeOutAndPause(1200);
    }
    // Show "انتهي من أذكارك" overlay above YT
    document.getElementById('yt-azkar-overlay')?.classList.add('active');

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

    const items = az.type === 'morning' ? AZKAR_MORNING : AZKAR_EVENING;
    if (titleEl) titleEl.textContent = az.type === 'morning' ? 'أذكار الصباح' : 'أذكار المساء';
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
        btn.addEventListener('click', () => onAzkarCountClick(i));
        footer.appendChild(btn);
        wrap.appendChild(footer);

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
    const items = az.type === 'morning' ? AZKAR_MORNING : AZKAR_EVENING;
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
            // Smooth scroll to next
            const nextEl = itemEls[next];
            if (nextEl) {
                setTimeout(() => {
                    nextEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
    az.active = false;

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
    const btn = document.getElementById('azkar-btn');
    btn?.addEventListener('click', (e) => {
        e.stopPropagation();
        const confirm = document.getElementById('azkar-confirm');
        if (confirm && !confirm.classList.contains('hidden')) hideAzkarConfirm();
        else showAzkarConfirm();
    });

    document.getElementById('azkar-confirm-yes')?.addEventListener('click', () => {
        const type = getCurrentAzkarType();
        if (type) markAzkarCompleted(type);
        hideAzkarConfirm();
    });

    document.getElementById('azkar-confirm-no')?.addEventListener('click', () => {
        const type = getCurrentAzkarType();
        hideAzkarConfirm();
        if (type) openAzkarOverlay(type);
    });

    document.getElementById('azkar-finish-btn')?.addEventListener('click', () => {
        const fb = document.getElementById('azkar-finish-btn');
        if (!fb?.classList.contains('unlocked')) return; // still locked
        closeAzkarOverlay(true);
    });

    // Click anywhere outside the user card hides the confirm popup
    document.addEventListener('click', (e) => {
        const card = document.getElementById('user-card');
        if (!card) return;
        if (!card.contains(e.target)) hideAzkarConfirm();
    });

    // Mobile floating azkar button — tapping directly opens overlay (no confirm; card is hidden)
    document.getElementById('azkar-focus-float-btn')?.addEventListener('click', () => {
        const type = getCurrentAzkarType();
        if (type) openAzkarOverlay(type);
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

// EOF
