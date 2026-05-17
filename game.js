import { database, ref, onValue, update, get, onDisconnect, set } from './firebase-config.js';

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

    stopAll() {
        for (const name of Object.keys(this.sounds)) {
            this.stopSound(name);
            this.sounds[name].active = false;
        }
    }
}

// Game State
const gameState = {
    currentUser: null,
    userId: null,
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
        totalSessions: 1
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
    red: '#e1352e'
};

const PLAYER_SIZE = 70;
const MOVE_SPEED = 5;
const SPAWN_RADIUS = 100;

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

// World Boundaries (Updated for new BG size)
const BOUNDS = {
    minX: -BG_WIDTH / 2 + PLAYER_SIZE / 2 + 10,
    maxX: BG_WIDTH / 2 - PLAYER_SIZE / 2 - 10,
    minY: -BG_HEIGHT / 2 + PLAYER_SIZE / 2 + 10,
    maxY: BG_HEIGHT / 2 - PLAYER_SIZE / 2 - 10
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

// Initialize game
function init() {
    loadAssets();
    setupUserSelection();
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
                intermediateY: intermediateY
            });
        });
    });
}

// Setup User Selection UI
function setupUserSelection() {
    const userListContainer = document.getElementById('user-list');
    const usersRef = ref(database, 'users');
    onValue(usersRef, (snapshot) => {
        const users = snapshot.val();
        if (gameState.userId) return;
        if (!users) {
            userListContainer.innerHTML = '<div class="loading-users">لا يوجد مستخدمون متصلون حالياً.</div>';
            return;
        }
        const onlineUsers = Object.entries(users).filter(([_, data]) => data.status === 'in-voice');
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
    setupLogout();
    listenToPlayers();
    listenToPomodoro();
    get(ref(database, 'pomodoro')).then((pomoSnapshot) => {
        const pomoData = pomoSnapshot.val() || {};
        let activeLaptopId = null;
        for (const [lapId, state] of Object.entries(pomoData)) {
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
            } else if (data && (data.x !== undefined && data.y !== undefined) && data.x !== 0 && !checkCollision(data.x, data.y)) {
                spawnX = data.x;
                spawnY = data.y;
            }
            
            if (!gameState.players[gameState.userId]) {
                gameState.players[gameState.userId] = { userId: gameState.userId, username: gameState.currentUser, x: spawnX, y: spawnY };
            } else {
                gameState.players[gameState.userId].x = spawnX;
                gameState.players[gameState.userId].y = spawnY;
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
        const zoomSpeed = 0.001;
        gameState.zoom -= e.deltaY * zoomSpeed;
        gameState.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, gameState.zoom));
    }, { passive: false });

    gameState.canvas.addEventListener('mousedown', (e) => {
        if (gameState.pomodoro.active) return; // Completely disable starting another Pomodoro
        if (gameState.activeLaptop && !gameState.isLockedIn && !gameState.anim.active) {
            if (gameState.activeLaptop.claimedBy) return; // Ignore if claimed
            document.getElementById('pomodoro-modal').classList.add('active');
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
        player.x = laptop.sitX;
        player.y = laptop.sitY;
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
            gameState.pomodoro.breakDuration = 10 / 60; // 10 seconds
            gameState.pomodoro.sessionsLeft = 2;
            gameState.pomodoro.totalSessions = 2;
            gameState.pomodoro.phase = 'wait';
            
            const updates = {};
            updates[`pomodoro/${laptop.id}`] = {
                claimedBy: gameState.userId,
                phase: 'wait',
                endTime: 0,
                workDuration: 10 / 60,
                breakDuration: 10 / 60,
                sessionsLeft: 2,
                totalSessions: 2
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
        gameState.pomodoro.phase = 'wait';
        
        const updates = {};
        updates[`pomodoro/${laptop.id}`] = {
            claimedBy: gameState.userId,
            phase: 'wait',
            endTime: 0,
            workDuration: workMins,
            breakDuration: breakMins,
            sessionsLeft: sessions,
            totalSessions: sessions
        };
        update(ref(database), updates);
        
        startKidnapAnimation(laptop);
    });
}

function showSuccessModal(totalSessions, workDuration) {
    const modal = document.getElementById('success-modal');
    if (!modal) return;
    
    const totalMins = Math.floor(totalSessions * workDuration);
    document.getElementById('success-total-time').textContent = `${totalMins} دقيقة`;
    document.getElementById('success-sessions-count').textContent = totalSessions;
    
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
            totalSessions: gameState.pomodoro.totalSessions
        };
        updates[`pomodoro/${gameState.pomodoro.laptopId}`] = pomoData;
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
        }
    }
    const player = gameState.players[gameState.userId];
    if (player) {
        updatePlayerPosition(player.x, player.y);
    }
}

function listenToPomodoro() {
    const pomodoroRef = ref(database, 'pomodoro');
    onValue(pomodoroRef, (snapshot) => {
        const data = snapshot.val() || {};
        gameState.laptops.forEach(laptop => {
            const state = data[laptop.id];
            if (state) {
                laptop.claimedBy = state.claimedBy;
                laptop.endTime = state.endTime;
                laptop.phase = state.phase;
                laptop.workDuration = state.workDuration;
                laptop.breakDuration = state.breakDuration;
                laptop.sessionsLeft = state.sessionsLeft;
                laptop.totalSessions = state.totalSessions;


            } else {
                laptop.claimedBy = null;
                laptop.endTime = 0;
                laptop.phase = 'none';
            }
        });
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
        gameState.players[gameState.userId] = { userId: gameState.userId, username: gameState.currentUser, x: spawnX, y: spawnY };
    } else {
        gameState.players[gameState.userId].x = spawnX;
        gameState.players[gameState.userId].y = spawnY;
    }
    updatePlayerPosition(spawnX, spawnY);
    gameState.positionInitialized = true;
}

function listenToPlayers() {
    const usersRef = ref(database, 'users');
    onValue(usersRef, (snapshot) => {
        const users = snapshot.val();
        if (users) {
            const currentIdsInSnapshot = new Set();
            for (const [userId, userData] of Object.entries(users)) {
                if (userData.status === 'in-voice') {
                    currentIdsInSnapshot.add(userId);
                    const isCurrentUser = userId === gameState.userId;
                    if (!gameState.players[userId]) {
                        gameState.players[userId] = { userId, username: userData.username, channelName: userData.channelName, avatar: userData.avatar, x: userData.x || 0, y: userData.y || 0 };
                    } else {
                        const player = gameState.players[userId];
                        player.username = userData.username;
                        player.channelName = userData.channelName;
                        player.avatar = userData.avatar;
                        player.currentTask = userData.currentTask || "";
                        
                        if (isCurrentUser) {
                            const taskInput = document.getElementById('current-task-input');
                            if (taskInput && !gameState.taskInputInitialized) {
                                taskInput.value = userData.currentTask || "";
                                gameState.taskInputInitialized = true;
                            }
                        }

                        if (!isCurrentUser) { 
                            const player = gameState.players[userId];
                            player.x = userData.x || 0; 
                            player.y = userData.y || 0; 
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
    const buffer = PLAYER_SIZE / 2;
    if (x > TABLE_BOX.minX - buffer && x < TABLE_BOX.maxX + buffer && y > TABLE_BOX.minY - buffer && y < TABLE_BOX.maxY + buffer) return true;
    return false;
}

function updateCamera() {
    const player = gameState.players[gameState.userId];
    if (!player) return;
    const targetX = -player.x;
    const targetY = -player.y;
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
        updatePlayerPosition(player.x, player.y);
        
        if (Math.random() < (isSprinting ? 0.8 : 0.4) * gameState.dtFactor) {
            spawnDust(player.x, player.y, isSprinting ? 2 : 1, false);
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
            
            if (gameState.pomodoro.active && gameState.pomodoro.phase === 'wait') {
                startPomodoroPhase('work');
            }
        }
    }
    
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
            if (Math.random() < 0.2 * gameState.dtFactor) spawnDust(player.x, player.y, 1, false);
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
            const dist = Math.hypot(player.x - localPlayer.x, player.y - localPlayer.y);
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

function gameLoop(timestamp) {
    if (!timestamp) timestamp = performance.now();
    if (!gameState.lastTime) gameState.lastTime = timestamp;
    let deltaTime = timestamp - gameState.lastTime;
    gameState.lastTime = timestamp;

    if (deltaTime > 100) deltaTime = 100; // Cap to avoid large jumps if tab is inactive
    gameState.dtFactor = deltaTime / 16.666; // Standardize to 60fps (1000ms / 60 = 16.666ms)

    handleMovement();
    updateAnimation();
    updateCamera();
    updatePlayerBobbing();
    updateNametags();
    updatePomodoro();
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

    if (gameState.assets.bg.complete) {
        ctx.drawImage(gameState.assets.bg, -BG_WIDTH / 2, -BG_HEIGHT / 2, BG_WIDTH, BG_HEIGHT);
    }
    if (gameState.assets.tables.complete) {
        ctx.drawImage(gameState.assets.tables, TABLE_BOX.minX, TABLE_BOX.minY, TABLE_WIDTH, TABLE_HEIGHT);
    }

    drawConnections();

    if (gameState.anim.active && (gameState.anim.phase === 'reach' || gameState.anim.phase === 'align' || gameState.anim.phase === 'pull')) {
        drawKidnapLine();
    }

    drawDustParticles();
    drawPlayers(false); 
    drawTimers();

    if (gameState.assets.shadow.complete) {
        ctx.drawImage(gameState.assets.shadow, -BG_WIDTH / 2, -BG_HEIGHT / 2, BG_WIDTH, BG_HEIGHT);
    }

    if (gameState.isLockedIn) {
        drawLockedInOverlay();
    }

    ctx.restore();

    if (gameState.focusAlpha > 0.01) {
        drawFocusMask(canvas);
    }

    drawWindParticles();
    drawFocusFog();
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

    let targetX, targetY;
    if (gameState.anim.phase === 'reach') {
        targetX = laptop.x + (player.x - laptop.x) * p;
        targetY = laptop.y + (player.y - laptop.y) * p;
    } else {
        targetX = player.x;
        targetY = player.y;
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
        const pScreenX = centerX + (player.x + gameState.camera.x) * zoom;
        const pScreenY = centerY + (player.y + gameState.camera.y) * zoom;

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
            }
            const panel = document.getElementById('focus-sounds-panel');
            if (panel) panel.classList.remove('active');
            const taskPanel = document.getElementById('current-task-panel');
            if (taskPanel) taskPanel.classList.remove('active');
            const taskInput = document.getElementById('current-task-input');
            if (taskInput) taskInput.blur();
            
            if (gameState.pomodoro.sessionsLeft <= 1) {
                // END SESSION
                gameState.pomodoro.active = false;
                const updates = {};
                updates[`pomodoro/${gameState.pomodoro.laptopId}`] = null;
                update(ref(database), updates);
                gameState.pomodoro.laptopId = null;
                if (Notification.permission === "granted") {
                    new Notification("مدونة ستوديو", { body: "لقد أتممت جميع جلسات العمل بنجاح!" });
                }
                
                // STOP ALL FOCUS SOUNDS
                if (gameState.focusAudioEngine) {
                    gameState.focusAudioEngine.stopAll();
                }
                gameState.pomodoro.transitioning = false;
                showSuccessModal(gameState.pomodoro.totalSessions, gameState.pomodoro.workDuration);
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
            
            if (gameState.pomodoro.sessionsLeft <= 0) {
                gameState.pomodoro.active = false;
                const updates = {};
                updates[`pomodoro/${gameState.pomodoro.laptopId}`] = null;
                update(ref(database), updates);
                gameState.pomodoro.laptopId = null;
                if (Notification.permission === "granted") {
                    new Notification("مدونة ستوديو", { body: "لقد أتممت جميع جلسات العمل بنجاح!" });
                }
                
                // STOP ALL FOCUS SOUNDS
                if (gameState.focusAudioEngine) {
                    gameState.focusAudioEngine.stopAll();
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
                updates[`pomodoro/${gameState.pomodoro.laptopId}/phase`] = 'wait';
                updates[`pomodoro/${gameState.pomodoro.laptopId}/endTime`] = 0;
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

function drawTimers() {
    const ctx = gameState.ctx;
    const now = Date.now();
    
    gameState.laptops.forEach(laptop => {
        if (!laptop.claimedBy || laptop.claimedBy === gameState.userId) return; // Only draw for others
        if (laptop.phase !== 'work' && laptop.phase !== 'break') return; // Don't draw if not in valid phase
        
        const remaining = Math.max(0, laptop.endTime - now);
        
        // Hide if stuck on 00:00 for more than a few seconds (e.g., owner logged out or lagged)
        if (remaining === 0 && now - laptop.endTime > 5000) return;
        
        const mins = Math.floor(remaining / 60000);
        const secs = Math.floor((remaining % 60000) / 1000);
        const timeStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        
        // Use a rounded rectangle instead of a blocky one for the background
        const textWidth = ctx.measureText(timeStr).width;
        ctx.shadowBlur = 10;
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        
        ctx.fillStyle = laptop.phase === 'work' ? COLORS.red : '#3bb9ab';
        
        let renderY = laptop.y - 70;
        let renderX = laptop.x;
        const player = Object.values(gameState.players).find(p => p.userId === laptop.claimedBy);
        if (player) {
            renderX = player.x;
            renderY = player.y - PLAYER_SIZE / 2 - 20;
        }
        
        const taskText = (player && player.currentTask) ? `أعمل على ${player.currentTask}` : '';
        
        ctx.font = 'bold 12px Rubik';
        const taskWidth = taskText ? ctx.measureText(taskText).width : 0;
        
        ctx.font = 'bold 14px Rubik';
        const timerWidth = ctx.measureText(timeStr).width;
        
        const timerH = 26;
        const taskH = 24;
        const gap = 4;
        
        const totalHeight = taskText ? (taskH + gap + timerH) : timerH;
        const startY = renderY - (totalHeight - timerH);
        
        ctx.shadowBlur = 10;
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.fillStyle = laptop.phase === 'work' ? COLORS.red : '#3bb9ab';
        
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

        if (taskText) {
            const bx = renderX - taskWidth/2 - 12;
            drawRoundedRect(bx, startY, taskWidth + 24, taskH, 12);
            
            ctx.shadowBlur = 0;
            ctx.fillStyle = 'white';
            ctx.font = 'bold 12px Rubik';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(taskText, renderX, startY + taskH / 2);
            
            ctx.shadowBlur = 10;
            ctx.shadowColor = 'rgba(0,0,0,0.5)';
            ctx.fillStyle = laptop.phase === 'work' ? COLORS.red : '#3bb9ab';
        }
        
        const timerY = taskText ? startY + taskH + gap : startY;
        const bx = renderX - timerWidth/2 - 12;
        drawRoundedRect(bx, timerY, timerWidth + 24, timerH, 13);
        
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'white';
        ctx.font = 'bold 14px Rubik';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(timeStr, renderX, timerY + timerH / 2);
        ctx.textBaseline = 'alphabetic';
    });
}

function drawLockedInOverlay() {
    const ctx = gameState.ctx;
    const player = gameState.players[gameState.userId];
    if (!player) return;
    ctx.fillStyle = 'rgba(8, 111, 182, 0.3)';
    ctx.beginPath();
    ctx.arc(player.x, player.y, PLAYER_SIZE / 2 + 10, 0, Math.PI * 2);
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
                    ctx.moveTo(p1.x, p1.y);
                    ctx.lineTo(p2.x, p2.y);
                    ctx.stroke();
                }
            }
        }
    }
    ctx.setLineDash([]);
}

function drawPlayers(onlyLocal = false) {
    const ctx = gameState.ctx;
    for (const player of Object.values(gameState.players)) {
        const isCurrentUser = player.userId === gameState.userId;
        if (onlyLocal && !isCurrentUser) continue;
        
        const screenX = player.x;
        const screenY = player.y - (player.bobOffset || 0);
        
        const isWorking = isCurrentUser ? 
            (gameState.isLockedIn && gameState.pomodoro.active && gameState.pomodoro.phase === 'work') : 
            player.isWorking;
            
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
        
        ctx.save();
        ctx.translate(screenX, screenY + workBob);
        ctx.rotate(workAngle);
        ctx.scale(workScaleX, workScaleY);
        
        ctx.shadowBlur = 10;
        ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
        ctx.shadowOffsetY = 4 + (player.bobOffset || 0);
        ctx.beginPath();
        ctx.arc(0, 0, (PLAYER_SIZE / 2) + 4, 0, Math.PI * 2);
        ctx.fillStyle = isCurrentUser ? COLORS.blue : '#ffffff';
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;
        
        ctx.save();
        ctx.beginPath();
        ctx.arc(0, 0, PLAYER_SIZE / 2, 0, Math.PI * 2);
        ctx.clip();
        
        const img = gameState.avatarCache[player.userId];
        if (img && img !== 'failed') {
            ctx.drawImage(img, -PLAYER_SIZE / 2, -PLAYER_SIZE / 2, PLAYER_SIZE, PLAYER_SIZE);
        } else {
            ctx.fillStyle = isCurrentUser ? COLORS.blue : '#ccc';
            ctx.fill();
            ctx.fillStyle = 'white';
            ctx.font = 'bold 24px Rubik';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(player.username.charAt(0).toUpperCase(), 0, 0);
        }
        ctx.restore();
        ctx.restore(); // restores translate, rotate, scale
        
        if (player.nameAlpha > 0.01) {
            ctx.fillStyle = `rgba(255, 255, 255, ${player.nameAlpha})`;
            ctx.font = '500 14px Rubik';
            ctx.textAlign = 'center';
            ctx.fillText(player.username, screenX, player.y + PLAYER_SIZE / 2 + 25);
        }
    }
}

if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }

// EOF
