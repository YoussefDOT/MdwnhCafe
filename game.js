import { database, ref, onValue, update, get, onDisconnect, set } from './firebase-config.js';

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

// Returns a Firebase path scoped to the active lobby.
// All minigame and pomodoro data is segregated per lobby.
function lobbyPath(subpath) {
    const lobby = gameState.selectedLobby;
    if (!lobby) throw new Error('lobbyPath called before lobby was selected');
    return `lobbies/${lobby}/${subpath}`;
}
// ─────────────────────────────────────────────────────────────────────────────

class FocusAudioEngine {
    constructor() {
        this.ctx = null;
        this.sampleRate = 44100;
        this.masterGain = null;
        this.overallVolume = 0.5;
        this.sounds = {
            plane: { active: false, volume: 0.5, nodes: null },
            rain_muffled: { active: false, volume: 0.5, nodes: null },
            white_muffled: { active: false, volume: 0.5, nodes: null },
            brown_muffled: { active: false, volume: 0.5, nodes: null },
            wind: { active: false, volume: 0.5, nodes: null }
        };
        // Normalized ambient silent levels
        this.baseVolumeScale = {
            plane: 0.09,
            rain_muffled: 0.15,
            white_muffled: 0.05,
            brown_muffled: 0.21,
            wind: 0.09
        };
        this.buffers = {
            timeBreak: null,
            timeReturn: null,
            kidnap: null,
            yipee: null
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

        const resumeCtx = () => {
            if (this.ctx && this.ctx.state === 'suspended') {
                this.ctx.resume().then(() => {
                    document.removeEventListener('click', resumeCtx);
                    document.removeEventListener('keydown', resumeCtx);
                }).catch(e => {});
            }
        };
        document.addEventListener('click', resumeCtx);
        document.addEventListener('keydown', resumeCtx);
    }

    async loadSoundEffects() {
        try {
            const loadBuffer = async (url) => {
                const response = await fetch(url);
                const arrayBuffer = await response.arrayBuffer();
                return await this.ctx.decodeAudioData(arrayBuffer);
            };
            this.buffers.timeBreak = await loadBuffer('Sound/TimeBreak.mp3');
            this.buffers.timeReturn = await loadBuffer('Sound/TimeReturn.mp3');
            this.buffers.kidnap = await loadBuffer('Sound/LaptopGrab.mp3');
            this.buffers.yipee = await loadBuffer('Sound/Yipee.mp3');
        } catch(e) {
            console.log("Failed to load Web Audio sound effects:", e);
        }
    }

    playEffect(name) {
        if (!this.ctx) this.init();
        if (this.ctx.state === 'suspended') {
            this.ctx.resume().catch(e=>{});
        }
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
            if (gameState.sounds[name]) {
                gameState.sounds[name].play().catch(e=>{});
            }
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
        if (this.ctx.state === 'suspended') {
            this.ctx.resume().catch(e=>{});
        }

        const sound = this.sounds[name];
        if (sound.nodes) return;

        const gainNode = this.ctx.createGain();
        gainNode.connect(this.masterGain);

        let source = null;
        let secondaryNodes = [];

        if (name === 'white') {
            source = this.createWhiteNoiseNode();
            source.connect(gainNode);
            source.start();
        } else if (name === 'white_muffled') {
            source = this.createWhiteNoiseNode();
            const filter = this.ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.setValueAtTime(250, this.ctx.currentTime);
            source.connect(filter);
            filter.connect(gainNode);
            source.start();
            secondaryNodes.push(filter);
        } else if (name === 'brown') {
            source = this.createBrownNoiseNode();
            source.connect(gainNode);
            source.start();
        } else if (name === 'brown_muffled') {
            source = this.createBrownNoiseNode();
            const filter = this.ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.setValueAtTime(150, this.ctx.currentTime);
            source.connect(filter);
            filter.connect(gainNode);
            source.start();
            secondaryNodes.push(filter);
        } else if (name === 'rain') {
            source = this.createWhiteNoiseNode();
            const filter = this.ctx.createBiquadFilter();
            filter.type = 'bandpass';
            filter.frequency.setValueAtTime(1000, this.ctx.currentTime);
            filter.Q.setValueAtTime(0.8, this.ctx.currentTime);
            source.connect(filter);
            filter.connect(gainNode);
            source.start();
            secondaryNodes.push(filter);
        } else if (name === 'rain_muffled') {
            source = this.createWhiteNoiseNode();
            const filter = this.ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.setValueAtTime(500, this.ctx.currentTime);
            source.connect(filter);
            filter.connect(gainNode);
            source.start();
            secondaryNodes.push(filter);
        } else if (name === 'wind') {
            source = this.createBrownNoiseNode();
            const filter = this.ctx.createBiquadFilter();
            filter.type = 'bandpass';
            filter.frequency.setValueAtTime(400, this.ctx.currentTime);
            filter.Q.setValueAtTime(2.0, this.ctx.currentTime);

            const lfo = this.ctx.createOscillator();
            lfo.frequency.setValueAtTime(0.08, this.ctx.currentTime);

            const lfoGain = this.ctx.createGain();
            lfoGain.gain.setValueAtTime(250, this.ctx.currentTime);

            lfo.connect(lfoGain);
            lfoGain.connect(filter.frequency);

            source.connect(filter);
            filter.connect(gainNode);

            source.start();
            lfo.start();

            secondaryNodes.push(filter, lfo, lfoGain);
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

        try {
            gainNode.gain.cancelScheduledValues(this.ctx.currentTime);
            gainNode.gain.setValueAtTime(gainNode.gain.value, this.ctx.currentTime);
            gainNode.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 0.5);
        } catch (e) {
            gainNode.gain.value = 0;
        }

        setTimeout(() => {
            nodesToStop.forEach(n => {
                try {
                    n.stop();
                } catch(e) {}
                try {
                    n.disconnect();
                } catch(e) {}
            });
            if (sound.nodes) {
                sound.nodes.gainNode.disconnect();
                sound.nodes = null;
            }
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
        if (this.masterGain && gameState.pomodoro.active && gameState.pomodoro.phase === 'work') {
            this.masterGain.gain.setValueAtTime(this.overallVolume, this.ctx.currentTime);
        }
        this.saveToFirebase();
    }

    toggle(name) {
        const sound = this.sounds[name];
        sound.active = !sound.active;
        if (sound.active) {
            this.startSound(name);
        } else {
            this.stopSound(name);
        }
        this.saveToFirebase();
    }

    fadeToMaster(targetVolume, duration) {
        if (!this.ctx) this.init();
        if (this.ctx.state === 'suspended') {
            this.ctx.resume().catch(e=>{});
        }
        const targetGain = targetVolume * this.overallVolume;
        try {
            this.masterGain.gain.cancelScheduledValues(this.ctx.currentTime);
            this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, this.ctx.currentTime);
            this.masterGain.gain.linearRampToValueAtTime(targetGain, this.ctx.currentTime + duration);
        } catch (e) {
            this.masterGain.gain.value = targetGain;
        }
    }

    applyState(mixState) {
        if (!mixState) return;
        this.init();

        // Restore overall mix volume
        if (mixState.overallVolume !== undefined) {
            this.overallVolume = mixState.overallVolume;
            const slider = document.getElementById('overall-vol');
            if (slider) slider.value = this.overallVolume;
            if (this.masterGain && gameState.pomodoro.active && gameState.pomodoro.phase === 'work') {
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
                    el.querySelector('.sound-vol').value = this.sounds[name].volume;
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
        this.volume = 80; // 0-100 for YT
        this._ytReady = this._ensureApiLoaded();
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
                onStateChange: (e) => { if (e.data === YT.PlayerState.ENDED && this.loop) this.player.playVideo(); }
            }
        });
    }

    async loadUrl(url, startSec = 0, saveToFirebase = true, startPaused = false) {
        const id = this.parseVideoId(url);
        if (!id) return false;
        await this.createPlayer();
        this.videoId = id;
        this.url = url;
        try {
            if (this._playerReadyPromise) await this._playerReadyPromise;
            if (startPaused) {
                this.player.cueVideoById({ videoId: id, startSeconds: Math.max(0, startSec) });
            } else {
                this.player.loadVideoById({ videoId: id, startSeconds: Math.max(0, startSec) });
                try { this.player.playVideo(); } catch(e) {}
                this._startPoll();
            }
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

    setLoop(v) { this.loop = !!v; if (gameState.userId) update(ref(database), { [`users/${gameState.userId}/focusPlayer/loop`]: this.loop }); }

    setVolumePercent(pct) { this.volume = Math.max(0, Math.min(100, Math.round(pct))); if (this.player && this.ready) this.player.setVolume(this.volume); }

    async fadeOutAndPause(duration = 1500) {
        if (!this.player) return;
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
    }

    _startPoll() {
        if (this.pollInterval) return;
        this.pollInterval = setInterval(() => this._poll(), 500);
    }

    _stopPoll() { if (this.pollInterval) { clearInterval(this.pollInterval); this.pollInterval = null; } }

    _poll() {
        if (!this.player || !this.ready) return;
        try {
            const dur = this.player.getDuration() || 0;
            const cur = this.player.getCurrentTime() || 0;
            // update UI
            const slider = document.getElementById('mini-yt-slider');
            const timeEl = document.getElementById('mini-yt-time');
            const titleEl = document.getElementById('mini-yt-title');
            if (slider && dur > 0) slider.value = Math.max(0, Math.min(100, Math.round((cur / dur) * 100)));
            if (timeEl) timeEl.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
            if (titleEl) {
                try {
                    const data = this.player.getVideoData();
                    titleEl.textContent = data?.title ? data.title : `YouTube • ${this.videoId}`;
                } catch(e) {
                    titleEl.textContent = `YouTube • ${this.videoId}`;
                }
            }
            // persist timestamp occasionally
            if (gameState.userId && (Math.floor(cur) % 5 === 0)) {
                update(ref(database), { [`users/${gameState.userId}/focusPlayer/timestamp`]: Math.floor(cur) });
            }
        } catch(e) {}
    }

    _ensureUiVisible(visible) {
        const mini = document.getElementById('mini-yt-player');
        if (!mini) return;
        if (visible) mini.classList.add('active'); else mini.classList.remove('active');
        const cover = document.getElementById('mini-yt-cover');
        if (cover && this.videoId) cover.src = `https://i.ytimg.com/vi/${this.videoId}/hqdefault.jpg`;
    }

    async loadFromProfile(profile) {
        if (!profile || !profile.url) return;
        await this.loadUrl(profile.url, profile.timestamp || 0, false, true);
        if (profile.loop) this.loop = !!profile.loop;
        if (profile.volume !== undefined) {
            this.setVolumePercent(profile.volume);
            const volSlider = document.getElementById('yt-volume-slider');
            if (volSlider) volSlider.value = profile.volume;
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
        tables: new Image()
    },
    sounds: {
        kidnap: new Audio('Sound/LaptopGrab.mp3'),
        timeBreak: new Audio('Sound/TimeBreak.mp3'),
        timeReturn: new Audio('Sound/TimeReturn.mp3'),
        yipee: new Audio('Sound/Yipee.mp3')
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
    race: {
        session: null,
        active: false,
        localCar: null,
        returnPoint: null,
        localResultSent: false,
        finishReturnTimer: null,
        lastSync: 0,
        carVisuals: {},
        camera: { x: 0, y: 0 },
        track: null
    },

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
    }
};

// Preload Sound
gameState.sounds.kidnap.preload = 'auto';
gameState.sounds.timeBreak.preload = 'auto';
gameState.sounds.timeReturn.preload = 'auto';
gameState.sounds.yipee.preload = 'auto';

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
const RACE_BUTTON = { x: 0, y: BREAK_ROOM_CENTER_Y + 110, radius: 72 };
const RACE_JOIN_RADIUS = 230;
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
const WIND_PARTICLE_COUNT = 30;

// Easing Functions
const easeOutExpo = (x) => x === 1 ? 1 : 1 - Math.pow(2, -10 * x);
const easeOutBack = (x) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
};

function isBreakActive() {
    return gameState.pomodoro.active && gameState.pomodoro.phase === 'break';
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
    if (!state || !shouldExpirePomodoroAfterCurrentTimer(state)) return false;

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

function cleanupStaleRaceSession(session) {
    if (!session) return false;

    const now = Date.now();
    const raceStartedAt = session.startTime || session.createdAt || 0;
    const isExpired = session.phase === 'race'
        ? raceStartedAt && now - raceStartedAt > RACE_MAX_AGE_MS
        : session.createdAt && now - session.createdAt > RACE_MAX_AGE_MS;

    if (!isExpired) return false;

    update(ref(database), { [lobbyPath('minigames/race/current')]: null });
    if (gameState.race.active) returnFromRace(false);
    gameState.race.session = null;
    gameState.race.localCar = null;
    hideRacePanel();
    hideRaceHud();
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
    const canvasX = clientX - rect.left;
    const canvasY = clientY - rect.top;
    return {
        x: (canvasX - gameState.canvas.width / 2) / gameState.zoom - gameState.camera.x,
        y: (canvasY - gameState.canvas.height / 2) / gameState.zoom - gameState.camera.y
    };
}

// Initialize game
function init() {
    loadAssets();
    loadRaceTrackAsset();
    setupLobbySelection();   // ← shows lobby screen first; calls setupUserSelection internally
    setupModal();
    initWindParticles();
    initLaptops();
}

function loadAssets() {
    gameState.assets.bg.src = 'Art/Bg.png';
    gameState.assets.shadow.src = 'Art/Shadow.png';
    gameState.assets.tables.src = 'Art/Tables.png';
}

function initWindParticles() {
    for (let i = 0; i < WIND_PARTICLE_COUNT; i++) {
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
}
// ─────────────────────────────────────────────────────────────────────────────

// Setup User Selection UI – filtered to the chosen lobby
function setupUserSelection() {
    const userListContainer = document.getElementById('user-list');
    const usersRef = ref(database, 'users');

    // The category name the player is allowed to see
    const allowedCategory = LOBBY_CONFIG[gameState.selectedLobby]?.categoryName;

    onValue(usersRef, (snapshot) => {
        const users = snapshot.val();
        if (gameState.userId) return;
        if (!users) {
            userListContainer.innerHTML = '<div class="loading-users">لا يوجد مستخدمون متصلون حالياً.</div>';
            return;
        }

        // Filter: only in-voice AND in the selected lobby's category
        const onlineUsers = Object.entries(users).filter(([_, data]) =>
            data.status === 'in-voice' &&
            data.categoryName === allowedCategory
        );

        if (onlineUsers.length === 0) {
            userListContainer.innerHTML = '<div class="loading-users">لا يوجد مستخدمون في قنوات الصوت حالياً.</div>';
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
    });
}

function setupModal() {
    const modal = document.getElementById('confirm-modal');
    const cancelBtn = document.getElementById('modal-cancel');
    const confirmBtn = document.getElementById('modal-confirm');
    cancelBtn.addEventListener('click', () => { modal.classList.remove('active'); gameState.selectedUser = null; });
    confirmBtn.addEventListener('click', () => { if (gameState.selectedUser) { startGame(gameState.selectedUser); modal.classList.remove('active'); } });
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

function audioObjPlayHelper(el) {
    return el.play();
}

function startGame(userData) {
    gameState.currentUser = userData.username;
    gameState.userId = userData.userId;

    // Initialize Focus Audio Engine & Setup Focus UI
    gameState.focusAudioEngine = new FocusAudioEngine();
    gameState.focusYTPlayer = new FocusYouTubePlayer();
    setupFocusPanelUI();

    // Set active presence in game and set up disconnect presence cleanup
    const activeRef = ref(database, `users/${gameState.userId}/activeInGame`);
    set(activeRef, true);
    onDisconnect(activeRef).set(false);

    document.getElementById('login-screen').classList.remove('active');
    document.getElementById('game-screen').classList.add('active');
    document.getElementById('current-user').textContent = userData.username;
    document.getElementById('channel-name').textContent = userData.channelName || 'قناة غير معروفة';
    gameState.canvas = document.getElementById('game-canvas');
    gameState.ctx = gameState.canvas.getContext('2d');
    resizeCanvas();
    setupControls();
    setupPomodoroUI();
    setupRaceUI();
    setupLogout();
    listenToPlayers();
    listenToPomodoro();
    listenToRace();
    // Track server time offset so race start/countdown is synchronized across clients
    const offsetRef = ref(database, '.info/serverTimeOffset');
    onValue(offsetRef, (snap) => {
        gameState.serverTimeOffset = snap.val() || 0;
    });
    get(ref(database, lobbyPath('pomodoro'))).then((pomoSnapshot) => {
        const pomoData = pomoSnapshot.val() || {};
        syncLaptopsFromPomodoro(pomoData);
        let activeLaptopId = null;
        for (const [lapId, state] of Object.entries(pomoData)) {
            if (cleanupStalePomodoroState(lapId, state)) continue;
            if (state && state.claimedBy === gameState.userId) {
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
        }

        get(ref(database, `users/${gameState.userId}`)).then((snapshot) => {
            const data = snapshot.val();
            let spawnX = 0, spawnY = BG_HEIGHT / 4;
            let locked = false;

            // Restore Focus Mix from User Profile instead of session!
            if (data && data.focusMix && gameState.focusAudioEngine) {
                gameState.focusAudioEngine.applyState(data.focusMix);
            }

            // Restore persisted YouTube focus player if present
            if (data && data.focusPlayer && gameState.focusYTPlayer) {
                gameState.focusYTPlayer.loadFromProfile(data.focusPlayer);
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
                    if (gameState.pomodoro.phase === 'work' || gameState.pomodoro.phase === 'wait') locked = true;
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
    };
    timerWorker.postMessage('start');

    gameLoop();
}

function resizeCanvas() {
    if (!gameState.canvas) return;
    gameState.canvas.width = window.innerWidth;
    gameState.canvas.height = window.innerHeight;
}

window.addEventListener('resize', resizeCanvas);

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
        const zoomSpeed = 0.001;
        gameState.zoom -= e.deltaY * zoomSpeed;
        gameState.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, gameState.zoom));
    }, { passive: false });

    gameState.canvas.addEventListener('mousedown', (e) => {
        const clickWorld = screenToWorld(e.clientX, e.clientY);
        const player = gameState.players[gameState.userId];
        const clickedRaceButton = player && isBreakActive() && isInBreakRoom(player.y) &&
            Math.hypot(player.x - RACE_BUTTON.x, player.y - RACE_BUTTON.y) < RACE_BUTTON.radius + PLAYER_SIZE / 2 &&
            Math.hypot(clickWorld.x - RACE_BUTTON.x, clickWorld.y - RACE_BUTTON.y) < RACE_BUTTON.radius + 12;
        if (clickedRaceButton) {
            createRaceLobby();
            return;
        }
        if (gameState.pomodoro.active) return; // Completely disable starting another Pomodoro
        if (gameState.activeLaptop && !gameState.isLockedIn && !gameState.anim.active) {
            if (gameState.activeLaptop.claimedBy) return; // Ignore if claimed
            document.getElementById('pomodoro-modal').classList.add('active');
        }
    });

    // Handle clicks on the in-game results overlay 'عودة' button
    gameState.canvas.addEventListener('click', (e) => {
        if (!gameState.race || !gameState.race.showResultsInGame) return;
        const rect = gameState.canvas.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const btn = gameState.race.resultsButtonRect;
        if (btn && cx >= btn.x && cx <= btn.x + btn.w && cy >= btn.y && cy <= btn.y + btn.h) {
            // User clicked return button in results overlay
            returnFromRace(true);
            gameState.race.showResultsInGame = false;
            gameState.race.finishedSession = null;
            gameState.race.resultsButtonRect = null;
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
            gameState.focusAudioEngine.updateVolume(soundName, e.target.value);
            gameState.focusAudioEngine.saveToFirebase();
        });
    });

    const masterSlider = document.getElementById('overall-vol');
    if (masterSlider) {
        masterSlider.addEventListener('input', (e) => {
            if (!gameState.focusAudioEngine) return;
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
    const miniPlay = document.getElementById('mini-yt-play');
    const miniPause = document.getElementById('mini-yt-pause');
    const miniBack = document.getElementById('mini-yt-back10');
    const miniForward = document.getElementById('mini-yt-forward10');
    const miniSlider = document.getElementById('mini-yt-slider');
    const miniLoop = document.getElementById('mini-yt-loop');

    if (ytLoadBtn && ytInput) {
        ytLoadBtn.addEventListener('click', async () => {
            const url = ytInput.value.trim();
            if (!url || !gameState.focusYTPlayer) return;
            await gameState.focusYTPlayer.loadUrl(url, 0, true);
            // save cover/title to profile is handled by YT class via DB writes
        });
    }

    if (miniPlay) miniPlay.addEventListener('click', () => { gameState.focusYTPlayer?.resume(); miniPlay.style.display='none'; if (miniPause) miniPause.style.display='inline-block'; });
    if (miniPause) miniPause.addEventListener('click', () => { gameState.focusYTPlayer?.pause(); miniPause.style.display='none'; if (miniPlay) miniPlay.style.display='inline-block'; });
    if (miniBack) miniBack.addEventListener('click', () => { gameState.focusYTPlayer?.back(10); });
    if (miniForward) miniForward.addEventListener('click', () => { gameState.focusYTPlayer?.forward(10); });
    if (miniLoop) miniLoop.addEventListener('change', (e) => { if (gameState.focusYTPlayer) gameState.focusYTPlayer.setLoop(e.target.checked); });
    if (miniSlider) {
        let sliding = false;
        miniSlider.addEventListener('input', async (e) => {
            if (!gameState.focusYTPlayer || !gameState.focusYTPlayer.player) return;
            sliding = true;
            const dur = gameState.focusYTPlayer.player.getDuration() || 0;
            const pct = parseFloat(e.target.value) / 100;
            const sec = Math.round(dur * pct);
            document.getElementById('mini-yt-time').textContent = `${formatTime(sec)} / ${formatTime(dur)}`;
        });
        miniSlider.addEventListener('change', async (e) => {
            if (!gameState.focusYTPlayer || !gameState.focusYTPlayer.player) return;
            const dur = gameState.focusYTPlayer.player.getDuration() || 0;
            const pct = parseFloat(e.target.value) / 100;
            const sec = Math.round(dur * pct);
            await gameState.focusYTPlayer.seekTo(sec);
            sliding = false;
            if (gameState.userId) update(ref(database), { [`users/${gameState.userId}/focusPlayer/timestamp`]: sec });
        });
    }

    // Volume slider for YouTube player — sync to Firebase
    const ytVolSlider = document.getElementById('yt-volume-slider');
    if (ytVolSlider) {
        ytVolSlider.addEventListener('input', (e) => {
            const pct = parseFloat(e.target.value);
            if (gameState.focusYTPlayer) {
                gameState.focusYTPlayer.setVolumePercent(pct);
                if (gameState.userId) {
                    update(ref(database), { [`users/${gameState.userId}/focusPlayer/volume`]: pct });
                }
            }
        });
    }

    // Detach the YouTube block from the focus panel and pin it bottom-left
    const ytBlock = document.getElementById('yt-focus-block');
    if (ytBlock) {
        // move to body so it's not semantically inside the mixer
        document.body.appendChild(ytBlock);
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
                    update(ref(database), { [lobbyPath('minigames/race/current')]: null });
                } else {
                    update(ref(database), { [lobbyPath(`minigames/race/current/participants/${gameState.userId}`)]: null });
                }
                hideRacePanel();
            } else {
                returnFromRace(true);
            }
        });
    }
}

function listenToRace() {
    const raceRef = ref(database, lobbyPath('minigames/race/current'));
    onValue(raceRef, (snapshot) => {
        const session = snapshot.val();
        if (cleanupStaleRaceSession(session)) return;
        const isParticipant = session && session.participants && session.participants[gameState.userId];

        if (!isParticipant) {
            if (gameState.race.active) returnFromRace(false);
            gameState.race.session = null;
            gameState.race.localCar = null;
            gameState.race.carVisuals = {};
            hideRacePanel();
            hideRaceHud();
            return;
        }

        gameState.race.session = session;
        gameState.race.returnPoint = session.participants[gameState.userId].returnPoint || gameState.race.returnPoint;

        if (session.phase === 'lobby') {
            gameState.race.active = false;
            gameState.race.localCar = null;
            showRaceLobby(session);
            hideRaceHud();
        } else if (session.phase === 'race') {
            hideRacePanel();
            startLocalRace(session);
        } else if (session.phase === 'finished') {
            // Keep the race rendering active so we can show results in-game
            gameState.race.active = true;
            gameState.race.session = session;
            gameState.race.showResultsInGame = true;
            gameState.race.finishedSession = session;
            hideRacePanel();
            hideRaceHud();
            scheduleRaceReturn();
        }
    });
}

async function createRaceLobby() {
    if (!gameState.userId || !isBreakActive()) return;

    const existing = await get(ref(database, lobbyPath('minigames/race/current')));
    const existingRace = existing.val();
    if (existingRace && cleanupStaleRaceSession(existingRace)) {
        // The stale race was cleared; allow a new lobby to be created below.
    } else if (existingRace && existingRace.phase !== 'finished' && Date.now() - (existingRace.createdAt || 0) < RACE_MAX_AGE_MS) {
        showRaceMessage('هناك سباق قائم الآن');
        return;
    }

    const player = gameState.players[gameState.userId];
    if (!player) return;

    const candidates = Object.values(gameState.players)
        .filter(p => p.userId && Math.hypot(p.x - player.x, p.y - player.y) <= RACE_JOIN_RADIUS)
        .filter(p => p.userId === gameState.userId || (isInBreakRoom(p.y) && !p.isWorking))
        .slice(0, 6);

    if (!candidates.some(p => p.userId === gameState.userId)) candidates.unshift(player);

    const participants = {};
    candidates.forEach((p, index) => {
        participants[p.userId] = {
            username: p.username || 'لاعب',
            avatar: p.avatar || '',
            index,
            returnPoint: { x: p.x, y: p.y }
        };
    });

    const raceId = `${gameState.userId}_${Date.now()}`;
    update(ref(database), {
        [lobbyPath('minigames/race/current')]: {
            id: raceId,
            hostId: gameState.userId,
            phase: 'lobby',
            createdAt: Date.now(),
            participants
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
        [lobbyPath('minigames/race/current/phase')]: 'race',
        // Use server-synced time so all clients start together
        [lobbyPath('minigames/race/current/startTime')]: serverNow() + 3500,
        [lobbyPath('minigames/race/current/cars')]: cars,
        [lobbyPath('minigames/race/current/results')]: null
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
    // Mark this user as working so others see avatar bobbing while racing
    update(ref(database), { [`users/${gameState.userId}/isWorking`]: true });
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
        if (session.hostId === gameState.userId) update(ref(database), { [lobbyPath('minigames/race/current')]: null });
        returnFromRace(false);
        return;
    }

    const now = serverNow();
    if (now < (session.startTime || 0) || car.finished) return;

    const up = gameState.keys['KeyW'] || gameState.keys['ArrowUp'];
    const down = gameState.keys['KeyS'] || gameState.keys['ArrowDown'];
    const left = gameState.keys['KeyA'] || gameState.keys['ArrowLeft'];
    const right = gameState.keys['KeyD'] || gameState.keys['ArrowRight'];
    const dt = gameState.dtFactor;

    if (up) car.speed += 0.16 * dt * RACE_SPEED_FACTOR;
    if (down) car.speed -= 0.11 * dt * RACE_SPEED_FACTOR;
    if (!up && !down) car.speed *= Math.pow(0.982, dt);
    // Apply global race speed factor to acceleration and clamp speeds
    // Scale the current speed clamp to RACE_SPEED_FACTOR
    car.speed = Math.max(-3.2 * RACE_SPEED_FACTOR, Math.min(8.4 * RACE_SPEED_FACTOR, car.speed));

    const turn = (right ? 1 : 0) - (left ? 1 : 0);
    if (turn !== 0 && Math.abs(car.speed) > 0.25) {
        car.angle += turn * 0.047 * dt * Math.sign(car.speed);
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
            [lobbyPath(`minigames/race/current/results/${gameState.userId}`)]: { finishTime, username: car.username },
            [lobbyPath(`minigames/race/current/cars/${gameState.userId}/finished`)]: true,
            [lobbyPath(`minigames/race/current/cars/${gameState.userId}/lap`)]: RACE_LAPS
        };
        if (participants.every(id => results[id])) {
            updates[lobbyPath('minigames/race/current/phase')] = 'finished';
            updates[lobbyPath('minigames/race/current/finishedAt')] = Date.now();
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
        [lobbyPath(`minigames/race/current/cars/${gameState.userId}`)]: {
            username: car.username,
            x: car.x,
            y: car.y,
            angle: car.angle,
            speed: car.speed,
            distance: car.distance,
            lap: car.lap,
            finished: car.finished || false
        }
    });
}

function scheduleRaceReturn() {
    if (gameState.race.finishReturnTimer) return;
    gameState.race.finishReturnTimer = setTimeout(() => returnFromRace(true), 8000);
    if (gameState.race.session && gameState.race.session.hostId === gameState.userId) {
        setTimeout(() => {
            update(ref(database), { [lobbyPath('minigames/race/current')]: null });
        }, 11000);
    }
}

function returnFromRace(clearPanel) {
    if (gameState.race.finishReturnTimer) {
        clearTimeout(gameState.race.finishReturnTimer);
        gameState.race.finishReturnTimer = null;
    }
    const player = gameState.players[gameState.userId];
    const returnPoint = gameState.race.returnPoint;
    if (player && returnPoint) {
        teleportEntity(player, returnPoint.x, returnPoint.y);
        updatePlayerPosition(returnPoint.x, returnPoint.y);
    }
    gameState.race.active = false;
    gameState.race.localCar = null;
    gameState.race.carVisuals = {};
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
}

function formatRaceTime(ms) {
    if (!Number.isFinite(ms)) return '--:--.---';
    const mins = Math.floor(ms / 60000);
    const secs = Math.floor((ms % 60000) / 1000);
    const millis = Math.floor(ms % 1000);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${millis.toString().padStart(3, '0')}`;
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
            } else {
                btns[0].classList.add('active');
            }
        });
    });

    cancelBtn.addEventListener('click', () => {
        modal.classList.remove('active');
    });

    const testBtn = document.getElementById('pomodoro-test');
    if (testBtn) {
        testBtn.addEventListener('click', () => {
            modal.classList.remove('active');
            if (Notification.permission !== "granted" && Notification.permission !== "denied") Notification.requestPermission();
            const laptop = gameState.lastActiveLaptop;
            if (!laptop || laptop.claimedBy) return;

            gameState.pomodoro.active = true;
            gameState.pomodoro.laptopId = laptop.id;
            gameState.pomodoro.workDuration = 10 / 60; // 10 seconds
            gameState.pomodoro.breakDuration = 3; // 3 minutes
            gameState.pomodoro.sessionsLeft = 3;
            gameState.pomodoro.totalSessions = 3;
            gameState.pomodoro.createdAt = Date.now();
            gameState.pomodoro.phase = 'wait';

            const updates = {};
            updates[lobbyPath(`pomodoro/${laptop.id}`)] = {
                claimedBy: gameState.userId,
                phase: 'wait',
                endTime: 0,
                workDuration: 10 / 60,
                breakDuration: 3,
                sessionsLeft: 3,
                totalSessions: 3,
                createdAt: Date.now()
            };
            update(ref(database), updates);
            startKidnapAnimation(laptop);
        });
    }

    confirmBtn.addEventListener('click', () => {
        const getVal = (type, defaultVal) => {
            const input = document.getElementById(`custom-${type}`);
            if (input.value) return parseInt(input.value);
            const activeBtn = document.querySelector(`#${type}-options .opt-btn.active`);
            return activeBtn ? parseInt(activeBtn.dataset.val) : defaultVal;
        };

        const workMins = getVal('work', 25);
        const breakMins = getVal('break', 5);
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

function showSuccessModal(totalSessions, workDuration, taskText = '') {
    const modal = document.getElementById('success-modal');
    if (!modal) return;

    const totalMins = Math.floor(totalSessions * workDuration);
    document.getElementById('success-total-time').textContent = `${totalMins} دقيقة`;
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
    gameState.pomodoro.endTime = Date.now() + duration * 60000;

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
        update(ref(database), updates);
    }

    if (phase === 'work') {
        const panel = document.getElementById('focus-sounds-panel');
        if (panel) panel.classList.add('active');
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
                gameState.focusYTPlayer.setVolumePercent(Math.round(gameState.focusAudioEngine.overallVolume * 100));
                gameState.focusYTPlayer.resume();
            }
        }
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

function setupLogout() {
    document.getElementById('logout-btn').addEventListener('click', () => {
        if (gameState.userId) {
            set(ref(database, `users/${gameState.userId}/activeInGame`), false).then(() => {
                window.location.reload();
            }).catch(() => {
                window.location.reload();
            });
        } else {
            window.location.reload();
        }
    });
}

function initializePlayerPosition() {
    const spawnX = 0;
    const spawnY = BG_HEIGHT / 4;
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
                // Hard separation: skip anyone not in the same lobby category
                if (userData.categoryName !== allowedCategory) continue;

                if (userData.status === 'in-voice') {
                    currentIdsInSnapshot.add(userId);
                    const isCurrentUser = userId === gameState.userId;
                    if (!gameState.players[userId]) {
                        const spawnX = userData.x || 0;
                        const spawnY = userData.y || 0;
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
                            isWorking: userData.isWorking || false
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
                            player.isMoving = userData.isMoving || false;
                            player.isSprinting = userData.isSprinting || false;
                            player.isLockedIn = userData.isLockedIn || false;
                            player.isWorking = userData.isWorking || false;
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
    if (player) {
        updates[`users/${gameState.userId}/isMoving`] = player.isMoving || false;
        updates[`users/${gameState.userId}/isSprinting`] = player.isSprinting || false;
        updates[`users/${gameState.userId}/isLockedIn`] = gameState.isLockedIn || false;
        updates[`users/${gameState.userId}/isWorking`] = (gameState.isLockedIn && gameState.pomodoro.active && gameState.pomodoro.phase === 'work') || false;
    }
    update(ref(database), updates);
}

function checkCollision(x, y) {
    if (x < BOUNDS.minX || x > BOUNDS.maxX || y < BOUNDS.minY || y > BOUNDS.maxY) return true;
    const inBreakDoor = isBreakActive() && isInDoorOpening(x);
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
    if (gameState.isLockedIn || gameState.anim.active) return;
    const player = gameState.players[gameState.userId];
    if (!player) return;
    let dx = 0, dy = 0;
    const isSprinting = gameState.keys['ShiftLeft'] || gameState.keys['ShiftRight'];
    const currentSpeed = (isSprinting ? MOVE_SPEED * 1.8 : MOVE_SPEED) * gameState.dtFactor;
    if (gameState.keys['KeyW'] || gameState.keys['ArrowUp']) dy -= currentSpeed;
    if (gameState.keys['KeyS'] || gameState.keys['ArrowDown']) dy += currentSpeed;
    if (gameState.keys['KeyA'] || gameState.keys['ArrowLeft']) dx -= currentSpeed;
    if (gameState.keys['KeyD'] || gameState.keys['ArrowRight']) dx += currentSpeed;
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
    const isFocused = gameState.isLockedIn && gameState.pomodoro.active && gameState.pomodoro.phase === 'work';
    const targetWindSpeed = isFocused ? 0.15 : 1.0;
    const targetFogAlpha = isFocused ? 1.0 : 0.0;

    const lerpFactor = 1 - Math.pow(1 - 0.03, gameState.dtFactor);
    gameState.windSpeedMultiplier += (targetWindSpeed - gameState.windSpeedMultiplier) * lerpFactor;
    gameState.focusFogAlpha += (targetFogAlpha - gameState.focusFogAlpha) * lerpFactor;

    gameState.windParticles.forEach(p => {
        p.x -= p.speed * gameState.dtFactor * gameState.windSpeedMultiplier;
        if (p.x < -100) {
            p.x = window.innerWidth + 100;
            p.y = Math.random() * window.innerHeight;
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

    if (isBreakActive() && isInBreakRoom(player.y)) {
        const raceDist = Math.hypot(player.x - RACE_BUTTON.x, player.y - RACE_BUTTON.y);
        gameState.activeRaceButton = raceDist < RACE_BUTTON.radius + PLAYER_SIZE / 2;
    }

    const baseAlpha = gameState.isLockedIn ? 0.95 : 0.8;
    let targetAlpha = (gameState.activeLaptop || gameState.isLockedIn) ? Math.min(baseAlpha, (1 - minDist / 120) * 1.5 || baseAlpha) : 0;

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

            if (gameState.focusYTPlayer && gameState.focusYTPlayer.videoId) {
                gameState.focusYTPlayer.resume();
            }

            if (gameState.pomodoro.active && gameState.pomodoro.phase === 'wait') {
                startPomodoroPhase('work');
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
    if (!timestamp) timestamp = performance.now();
    if (!gameState.lastTime) gameState.lastTime = timestamp;
    let deltaTime = timestamp - gameState.lastTime;
    gameState.lastTime = timestamp;

    if (deltaTime > 100) deltaTime = 100; // Cap to avoid large jumps if tab is inactive
    gameState.dtFactor = deltaTime / 16.666; // Standardize to 60fps (1000ms / 60 = 16.666ms)

    updatePomodoro();
    cleanupStaleRaceSession(gameState.race.session);
    if (gameState.race.active && gameState.race.session && gameState.race.session.phase === 'race') {
        updateRaceMode();
        updateRaceCarVisuals();
        updateRaceCamera();
        renderRace();
        requestAnimationFrame(gameLoop);
        return;
    }
    // If the race has finished, keep rendering the race screen so we can show in-game results
    if (gameState.race.active && gameState.race.session && gameState.race.session.phase === 'finished') {
        updateRaceCarVisuals();
        updateRaceCamera();
        renderRace();
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
    render();
    requestAnimationFrame(gameLoop);
}

function render() {
    const ctx = gameState.ctx;
    const canvas = gameState.canvas;
    if (!ctx) return;

    ctx.fillStyle = COLORS.black;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(gameState.zoom, gameState.zoom);
    ctx.translate(gameState.camera.x, gameState.camera.y);

    drawRooms();
    if (gameState.assets.tables.complete) {
        ctx.drawImage(gameState.assets.tables, TABLE_BOX.minX, TABLE_BOX.minY, TABLE_WIDTH, TABLE_HEIGHT);
    }
    drawBreakDoor();
    drawRaceButton();

    drawConnections();

    if (gameState.anim.active && (gameState.anim.phase === 'reach' || gameState.anim.phase === 'align' || gameState.anim.phase === 'pull')) {
        drawKidnapLine();
    }

    drawDustParticles();
    drawPlayers(false);
    drawTimers();

    drawRoomShadows();
    drawBreakDoor();
    drawRacePrompt();

    if (gameState.isLockedIn) {
        drawLockedInOverlay();
    }

    ctx.restore();

    if (gameState.focusAlpha > 0.01) {
        drawFocusMask(canvas);
    }

    drawWindParticles();
    drawFocusFog();

    const ytBlock = document.getElementById('yt-focus-block');
    if (ytBlock) {
        const shouldShow = gameState.isLockedIn;
        ytBlock.classList.toggle('visible', shouldShow);
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

function drawRaceButton() {
    const ctx = gameState.ctx;
    const active = gameState.activeRaceButton;
    const enabled = isBreakActive();

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.translate(RACE_BUTTON.x, RACE_BUTTON.y);
    ctx.shadowBlur = active ? 18 : 8;
    ctx.shadowColor = enabled ? 'rgba(244, 200, 43, 0.5)' : 'rgba(0, 0, 0, 0.35)';
    ctx.fillStyle = enabled ? '#f4c82b' : '#6b5b45';
    drawPixelDiamond(ctx, 0, 0, 72, 8);
    ctx.shadowBlur = 0;
    ctx.fillStyle = active ? '#ffffff' : '#2b2418';
    drawPixelDiamondOutline(ctx, 0, 0, 80, 8);

    ctx.fillStyle = '#262626';
    ctx.font = 'bold 24px Rubik';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('سباق', 0, -5);
    ctx.font = 'bold 16px Rubik';
    ctx.fillText('3 لفات', 0, 24);
    ctx.restore();
}

function drawPixelDiamond(ctx, x, y, radius, block) {
    for (let row = -radius; row <= radius; row += block) {
        const width = radius * 2 - Math.abs(row) * 2;
        ctx.fillRect(x - width / 2, y + row, width, block);
    }
}

function drawPixelDiamondOutline(ctx, x, y, radius, block) {
    for (let row = -radius; row <= radius; row += block) {
        const width = radius * 2 - Math.abs(row) * 2;
        ctx.fillRect(x - width / 2 - block, y + row, block, block);
        ctx.fillRect(x + width / 2, y + row, block, block);
    }
}

function drawRacePrompt() {
    if (!gameState.activeRaceButton) return;
    const ctx = gameState.ctx;
    ctx.save();
    ctx.fillStyle = 'white';
    ctx.font = 'bold 16px Rubik';
    ctx.textAlign = 'center';
    ctx.shadowBlur = 6;
    ctx.shadowColor = 'black';
    ctx.fillText('انقر للسباق', RACE_BUTTON.x, RACE_BUTTON.y - RACE_BUTTON.radius - 22);
    ctx.shadowBlur = 0;
    ctx.restore();
}

function renderRace() {
    const ctx = gameState.ctx;
    const canvas = gameState.canvas;
    const session = gameState.race.session;
    const localCar = gameState.race.localCar;
    const track = gameState.race.track;
    if (!ctx || !canvas || !session || !localCar) return;

    ctx.fillStyle = '#1a3324';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (!track || !track.image) {
        ctx.fillStyle = 'white';
        ctx.font = 'bold 24px Rubik';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('جاري تحميل حلبة السباق...', canvas.width / 2, canvas.height / 2);
        updateRaceHud(session, localCar);
        return;
    }

    const drawW = track.width * track.scale;
    const drawH = track.height * track.scale;

    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(gameState.zoom, gameState.zoom);
    ctx.translate(gameState.race.camera.x, gameState.race.camera.y);

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(track.image, -drawW / 2, -drawH / 2, drawW, drawH);

    const cars = { ...(session.cars || {}) };
    cars[gameState.userId] = localCar;
    Object.entries(cars).forEach(([userId, car]) => {
        const participant = session.participants && session.participants[userId];
        const drawCar = getRaceCarDrawState(userId, car);
        drawRaceCar(drawCar, participant ? participant.index || 0 : 0, userId === gameState.userId, userId, participant);
    });

    ctx.restore();

    const now = serverNow();
    if (now < (session.startTime || 0)) {
        const count = Math.max(1, Math.ceil(((session.startTime || 0) - now) / 1000));
        ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'white';
        ctx.font = 'bold 92px Rubik';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(count.toString(), canvas.width / 2, canvas.height / 2);
    } else if (localCar.finished) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'white';
        ctx.font = 'bold 34px Rubik';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('انتهيت!', canvas.width / 2, canvas.height / 2);
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

        const panelW = Math.min(520, canvas.width - 80);
        const rowH = 44;
        const panelH = 120 + ranked.length * rowH;
        const px = (canvas.width - panelW) / 2;
        const py = (canvas.height - panelH) / 2;

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

        // store button rect in canvas coords for click handler
        gameState.race.resultsButtonRect = { x: bx, y: by, w: btnW, h: btnH };
    }

    updateRaceHud(session, localCar);
}

function drawRaceCar(car, index, isLocal, userId, participant) {
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

    drawRaceAvatarBadge(userId, participant, car.x, car.y - 44, isLocal);

    ctx.save();
    ctx.fillStyle = 'white';
    ctx.font = 'bold 13px Rubik';
    ctx.textAlign = 'center';
    ctx.shadowBlur = 4;
    ctx.shadowColor = 'black';
    ctx.fillText(car.username || 'لاعب', car.x, car.y - 34);
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

function drawRaceAvatarBadge(userId, participant, x, y, isLocal) {
    const ctx = gameState.ctx;
    const img = gameState.avatarCache[userId];
    if (!img && participant && participant.avatar) {
        const avatar = new Image();
        avatar.crossOrigin = "anonymous";
        avatar.src = participant.avatar;
        avatar.onload = () => { gameState.avatarCache[userId] = avatar; };
        avatar.onerror = () => { gameState.avatarCache[userId] = 'failed'; };
    }

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = isLocal ? '#f4c82b' : '#ffffff';
    ctx.fillRect(x - 18, y - 18, 36, 36);
    ctx.fillStyle = '#111111';
    ctx.fillRect(x - 14, y - 14, 28, 28);

    if (img && img !== 'failed') {
        ctx.drawImage(img, x - 12, y - 12, 24, 24);
    } else {
        ctx.fillStyle = '#086fb6';
        ctx.fillRect(x - 12, y - 12, 24, 24);
        ctx.fillStyle = 'white';
        ctx.font = 'bold 14px Rubik';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText((participant?.username || '?').charAt(0).toUpperCase(), x, y + 1);
    }
    ctx.restore();
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

function drawFocusMask(canvas) {
    const ctx = gameState.ctx;
    if (!gameState.maskCanvas) {
        gameState.maskCanvas = document.createElement('canvas');
        gameState.maskCtx = gameState.maskCanvas.getContext('2d');
    }
    const mCanvas = gameState.maskCanvas;
    const mCtx = gameState.maskCtx;
    if (mCanvas.width !== canvas.width || mCanvas.height !== canvas.height) {
        mCanvas.width = canvas.width;
        mCanvas.height = canvas.height;
    }
    mCtx.clearRect(0, 0, mCanvas.width, mCanvas.height);
    mCtx.fillStyle = `rgba(0, 0, 0, ${gameState.focusAlpha})`;
    mCtx.fillRect(0, 0, mCanvas.width, mCanvas.height);

    const player = gameState.players[gameState.userId];
    const laptop = gameState.isLockedIn ? null : (gameState.activeLaptop || gameState.lastActiveLaptop);

    if (player) {
        mCtx.globalCompositeOperation = 'destination-out';
        const centerX = canvas.width / 2;
        const centerY = canvas.height / 2;
        const zoom = gameState.zoom;
        const { x: playerX, y: playerY } = getPlayerRenderPos(player);
        const pScreenX = centerX + (playerX + gameState.camera.x) * zoom;
        const pScreenY = centerY + (playerY + gameState.camera.y) * zoom;

        const pRadius = (gameState.isLockedIn ? 85 : 75) * zoom;
        const pGrad = mCtx.createRadialGradient(pScreenX, pScreenY, pRadius * 0.4, pScreenX, pScreenY, pRadius);
        pGrad.addColorStop(0, 'rgba(255, 255, 255, 1)');
        pGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
        mCtx.fillStyle = pGrad;
        mCtx.beginPath();
        mCtx.arc(pScreenX, pScreenY, pRadius, 0, Math.PI * 2);
        mCtx.fill();

        if (laptop && !gameState.isLockedIn) {
            const lScreenX = centerX + (laptop.x + gameState.camera.x) * zoom;
            const lScreenY = centerY + (laptop.y + gameState.camera.y) * zoom;
            const lRadius = 100 * zoom;
            const lGrad = mCtx.createRadialGradient(lScreenX, lScreenY, lRadius * 0.4, lScreenX, lScreenY, lRadius);
            lGrad.addColorStop(0, 'rgba(255, 255, 255, 1)');
            lGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
            mCtx.fillStyle = lGrad;
            mCtx.beginPath();
            mCtx.arc(lScreenX, lScreenY, lRadius, 0, Math.PI * 2);
            mCtx.fill();
        }
        mCtx.globalCompositeOperation = 'source-over';
    }
    ctx.drawImage(mCanvas, 0, 0);

    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
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

    // If already in a Pomodoro, don't show prompt to start another one
    if (gameState.pomodoro.active) {
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

function updatePomodoro() {
    if (!gameState.pomodoro.active) return;

    const now = Date.now();
    const remaining = Math.max(0, gameState.pomodoro.endTime - now);

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
            gameState.pomodoro.transitioning = true;
            largeTimer.classList.add('hidden');
            gameState.isLockedIn = false;

            // FADE OUT FOCUS SOUNDS
            if (gameState.focusAudioEngine) {
                gameState.focusAudioEngine.fadeToMaster(0, 1.5);
                if (gameState.focusYTPlayer) gameState.focusYTPlayer.fadeOutAndPause(1500);
            }
            const panel = document.getElementById('focus-sounds-panel');
            if (panel) panel.classList.remove('active');
            const taskPanel = document.getElementById('current-task-panel');
            if (taskPanel) taskPanel.classList.remove('active');
            const taskInput = document.getElementById('current-task-input');
            if (taskInput) taskInput.blur();

            const shouldEndAfterThisTimer = gameState.pomodoro.sessionsLeft <= 1 ||
                shouldExpirePomodoroAfterCurrentTimer(gameState.pomodoro);

            if (shouldEndAfterThisTimer) {
                // END SESSION
                const completedTaskText = getCurrentTaskText();
                gameState.pomodoro.active = false;
                const updates = {};
                updates[lobbyPath(`pomodoro/${gameState.pomodoro.laptopId}`)] = null;
                update(ref(database), updates);
                gameState.pomodoro.laptopId = null;
                if (Notification.permission === "granted") {
                    new Notification("مدونة ستوديو", { body: "لقد أتممت جميع جلسات العمل بنجاح!" });
                }

                // STOP ALL FOCUS SOUNDS
                if (gameState.focusAudioEngine) {
                    gameState.focusAudioEngine.stopAll();
                    if (gameState.focusYTPlayer) gameState.focusYTPlayer.pause();
                }
                gameState.pomodoro.transitioning = false;
                showSuccessModal(gameState.pomodoro.totalSessions, gameState.pomodoro.workDuration, completedTaskText);
            } else {
                // GO TO BREAK
                if (gameState.focusAudioEngine) {
                    gameState.focusAudioEngine.playEffect('timeBreak');
                } else {
                    playSoundRobust(gameState.sounds.timeBreak);
                }
                if (Notification.permission === "granted") {
                    new Notification("مدونة ستوديو", { body: "انتهت جلسة العمل! وقت الراحة." });
                }

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
                if (Notification.permission === "granted") {
                    new Notification("مدونة ستوديو", { body: "لقد أتممت جميع جلسات العمل بنجاح!" });
                }

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

                gameState.pomodoro.transitioning = false;
            } else {
                if (gameState.focusAudioEngine) {
                    gameState.focusAudioEngine.playEffect('timeReturn');
                } else {
                    playSoundRobust(gameState.sounds.timeReturn);
                }
                if (Notification.permission === "granted") {
                    new Notification("مدونة ستوديو", { body: "انتهى وقت الراحة. هيا للعمل!" });
                }

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

    gameState.laptops.forEach(laptop => {
        if (!laptop.claimedBy || laptop.claimedBy === gameState.userId) return;

        const player = Object.values(gameState.players).find(p => p.userId === laptop.claimedBy);
        const { x: renderX, y: renderY } = getLaptopBadgePosition(laptop);
        const taskText = (player && player.currentTask) ? `أعمل على ${player.currentTask}` : '';

        if (isLaptopSessionAfk(laptop)) {
            drawPomodoroBadgeStack(ctx, renderX, renderY, {
                taskText,
                statusText: 'AFK',
                color: COLORS.afk,
                textColor: COLORS.black
            });
            return;
        }

        if (laptop.phase !== 'work' && laptop.phase !== 'break') return;

        const remaining = Math.max(0, laptop.endTime - now);
        const mins = Math.floor(remaining / 60000);
        const secs = Math.floor((remaining % 60000) / 1000);
        const timeStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        const phaseColor = laptop.phase === 'work' ? COLORS.red : '#3bb9ab';

        drawPomodoroBadgeStack(ctx, renderX, renderY, {
            taskText,
            statusText: timeStr,
            color: phaseColor
        });
    });
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

function drawWindParticles() {
    const ctx = gameState.ctx;
    const canvas = gameState.canvas;
    ctx.save();
    gameState.windParticles.forEach(p => {
        const offsetX = gameState.camera.x * (p.parallax - 1.0) * gameState.zoom;
        const offsetY = gameState.camera.y * (p.parallax - 1.0) * gameState.zoom;
        let drawX = (p.x + offsetX) % canvas.width;
        let drawY = (p.y + offsetY) % canvas.height;
        if (drawX < 0) drawX += canvas.width;
        if (drawY < 0) drawY += canvas.height;
        ctx.fillStyle = `rgba(255, 255, 255, ${p.opacity})`;
        for (let i = 0; i < p.length; i++) {
            ctx.fillRect(drawX + (i * p.size), drawY, p.size, p.size);
        }
    });
    ctx.restore();
}

function drawFocusFog() {
    if (gameState.focusFogAlpha <= 0.01) return;
    const ctx = gameState.ctx;
    const canvas = gameState.canvas;
    const w = canvas.width;
    const h = canvas.height;

    ctx.save();
    ctx.globalAlpha = gameState.focusFogAlpha * 0.85;

    const t = Date.now() * 0.0004; // slower, extremely calming movement

    // Gradient 1: Smooth Slate/Indigo edge shadow vignette
    const grad1 = ctx.createRadialGradient(
        w / 2 + Math.sin(t) * (w * 0.15), h / 2 + Math.cos(t * 0.7) * (h * 0.15), Math.min(w, h) * 0.3,
        w / 2, h / 2, Math.max(w, h) * 0.95
    );
    grad1.addColorStop(0, 'rgba(10, 15, 30, 0)');
    grad1.addColorStop(0.6, 'rgba(10, 15, 30, 0.2)');
    grad1.addColorStop(1, 'rgba(13, 27, 42, 0.6)'); // deep blue accent
    ctx.fillStyle = grad1;
    ctx.fillRect(0, 0, w, h);

    // Gradient 2: Organic drifting emerald/teal focus highlight (creates a warm, premium organic feel)
    const grad2 = ctx.createRadialGradient(
        w * 0.3 + Math.cos(t * 0.8) * (w * 0.1), h * 0.4 + Math.sin(t * 1.1) * (h * 0.1), Math.min(w, h) * 0.25,
        w * 0.3, h * 0.4, Math.max(w, h) * 0.75
    );
    grad2.addColorStop(0, 'rgba(16, 185, 129, 0)');
    grad2.addColorStop(0.5, 'rgba(16, 185, 129, 0.04)');
    grad2.addColorStop(1, 'rgba(16, 185, 129, 0.12)');
    ctx.fillStyle = grad2;
    ctx.fillRect(0, 0, w, h);

    // Gradient 3: Soft drifting violet/indigo cloud at bottom right
    const grad3 = ctx.createRadialGradient(
        w * 0.8 + Math.sin(t * 1.3) * (w * 0.08), h * 0.8 + Math.cos(t * 0.9) * (h * 0.08), Math.min(w, h) * 0.25,
        w * 0.8, h * 0.8, Math.max(w, h) * 0.7
    );
    grad3.addColorStop(0, 'rgba(99, 102, 241, 0)');
    grad3.addColorStop(0.5, 'rgba(99, 102, 241, 0.03)');
    grad3.addColorStop(1, 'rgba(99, 102, 241, 0.15)');
    ctx.fillStyle = grad3;
    ctx.fillRect(0, 0, w, h);

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
    for (const player of Object.values(gameState.players)) {
        const isCurrentUser = player.userId === gameState.userId;
        if (onlyLocal && !isCurrentUser) continue;

        const { x: screenX, y: renderY } = getPlayerRenderPos(player);
        const screenY = renderY - (player.bobOffset || 0);

        const isWorking = isCurrentUser ?
            (gameState.isLockedIn && gameState.pomodoro.active && gameState.pomodoro.phase === 'work') :
            player.isWorking;

        const shouldGrayWorld = !isCurrentUser && !!player.isWorking;

        let workBob = 0;
        let workAngle = 0;
        let workScaleX = 1.0;
        let workScaleY = 1.0;

        if (isWorking) {
            const workT = Date.now() * 0.005;
            workBob = Math.sin(workT) * 3;
            workAngle = Math.sin(workT * 0.5) * 0.08;
            workScaleY = 1.0 + Math.sin(workT) * 0.04;
            workScaleX = 1.0 - Math.sin(workT) * 0.04;
        }

        const colorAlpha = isCurrentUser ? 1 : (player.avatarColorAlpha ?? 0);
        const grayMix = 1 - colorAlpha;
        const ringColor = isCurrentUser ? COLORS.blue : '#ffffff';
        const mutedRing = '#8a8a8a';

        ctx.save();
        ctx.translate(screenX, screenY + workBob);
        ctx.rotate(workAngle);
        ctx.scale(workScaleX, workScaleY);

        if (grayMix > 0.01) {
            ctx.filter = `saturate(${colorAlpha}) brightness(${0.72 + 0.28 * colorAlpha})`;
            ctx.globalAlpha = 0.55 + 0.45 * colorAlpha;
        }

        ctx.shadowBlur = 10;
        ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
        ctx.shadowOffsetY = 4 + (player.bobOffset || 0);
        ctx.beginPath();
        ctx.arc(0, 0, (PLAYER_SIZE / 2) + 4, 0, Math.PI * 2);
        ctx.fillStyle = grayMix > 0.01
            ? blendHexColors(ringColor, mutedRing, grayMix)
            : ringColor;
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

        if (player.nameAlpha > 0.01) {
            ctx.fillStyle = `rgba(255, 255, 255, ${player.nameAlpha})`;
            ctx.font = '500 14px Rubik';
            ctx.textAlign = 'center';
            ctx.fillText(player.username, screenX, renderY + PLAYER_SIZE / 2 + 25);
        }
    }
}

if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }

// EOF
