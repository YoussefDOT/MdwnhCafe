import { database, ref, onValue, update, get } from './firebase-config.js';

// Game State
const gameState = {
    currentUser: null,
    userId: null,
    players: {},
    avatarCache: {}, // Cache for loaded avatar images
    assets: {
        bg: new Image(),
        shadow: new Image(),
        tables: new Image()
    },
    sounds: {
        kidnap: new Audio('Sound/LaptopGrab.mp3')
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
    lastActiveLaptop: null,
    isLockedIn: false,
    focusAlpha: 0,
    
    // Animation State
    anim: {
        active: false,
        phase: 'none', 
        progress: 0,
        laptop: null,
        startPos: { x: 0, y: 0 },
        intermediatePos: { x: 0, y: 0 },
        targetPos: { x: 0, y: 0 }
    }
};

// Preload Sound
gameState.sounds.kidnap.preload = 'auto';

// Constants
const COLORS = {
    black: '#000000',
    snow: '#faf9f7',
    raisin: '#262626',
    blue: '#086fb6'
};

const PLAYER_SIZE = 70;
const MOVE_SPEED = 5;
const SPAWN_RADIUS = 100;

// Asset Base Dimensions
const BASE_BG_WIDTH = 2390;
const BASE_BG_HEIGHT = 1750;
const BASE_TABLE_WIDTH = 1460;
const BASE_TABLE_HEIGHT = 510;

// Visual Scaling
const ASSET_SCALE = 0.33;

const BG_WIDTH = BASE_BG_WIDTH * ASSET_SCALE;
const BG_HEIGHT = BASE_BG_HEIGHT * ASSET_SCALE;
const TABLE_WIDTH = BASE_TABLE_WIDTH * ASSET_SCALE;
const TABLE_HEIGHT = BASE_TABLE_HEIGHT * ASSET_SCALE;

// World Boundaries
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
    minY: -BG_HEIGHT / 2 + TABLE_OFFSET,
    maxY: -BG_HEIGHT / 2 + TABLE_HEIGHT + TABLE_OFFSET
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
            userItem.className = 'user-item';
            const avatarHtml = userData.avatar 
                ? `<img src="${userData.avatar}" alt="${userData.username}">`
                : `<div class="placeholder-avatar">${userData.username.charAt(0).toUpperCase()}</div>`;
            userItem.innerHTML = `<div class="avatar-circle">${avatarHtml}</div><div class="name">${userData.username}</div><div class="channel">${userData.channelName || 'قناة صوتية'}</div>`;
            userItem.addEventListener('click', () => showConfirmModal({ userId, ...userData }));
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

function startGame(userData) {
    gameState.currentUser = userData.username;
    gameState.userId = userData.userId;
    document.getElementById('login-screen').classList.remove('active');
    document.getElementById('game-screen').classList.add('active');
    document.getElementById('current-user').textContent = userData.username;
    document.getElementById('channel-name').textContent = userData.channelName || 'قناة غير معروفة';
    gameState.canvas = document.getElementById('game-canvas');
    gameState.ctx = gameState.canvas.getContext('2d');
    resizeCanvas();
    setupControls();
    setupLogout();
    listenToPlayers();
    get(ref(database, `users/${gameState.userId}`)).then((snapshot) => {
        const data = snapshot.val();
        if (data && (data.x !== undefined && data.y !== undefined) && data.x !== 0) {
            if (checkCollision(data.x, data.y)) { initializePlayerPosition(); } 
            else {
                if (!gameState.players[gameState.userId]) {
                    gameState.players[gameState.userId] = { userId: gameState.userId, username: gameState.currentUser, x: data.x, y: data.y };
                }
                gameState.positionInitialized = true;
            }
        } else { initializePlayerPosition(); }
    });
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
        if (e.code === 'Escape' && gameState.isLockedIn) {
            gameState.isLockedIn = false;
        }
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
        if (gameState.activeLaptop && !gameState.isLockedIn && !gameState.anim.active) {
            startKidnapAnimation(gameState.activeLaptop);
        }
    });
}

function startKidnapAnimation(laptop) {
    const player = gameState.players[gameState.userId];
    if (!player) return;

    gameState.anim.active = true;
    gameState.anim.phase = 'reach';
    gameState.anim.progress = 0;
    gameState.anim.laptop = laptop;
    gameState.anim.startPos = { x: player.x, y: player.y };

    // Play Sound
    gameState.sounds.kidnap.currentTime = 0;
    gameState.sounds.kidnap.play().catch(e => console.log("Audio play failed:", e));
}

function setupLogout() {
    document.getElementById('logout-btn').addEventListener('click', () => window.location.reload());
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
                        if (!isCurrentUser) { player.x = userData.x || 0; player.y = userData.y || 0; }
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
    const updates = {};
    updates[`users/${gameState.userId}/x`] = x;
    updates[`users/${gameState.userId}/y`] = y;
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
    gameState.camera.x += (targetX - gameState.camera.x) * CAMERA_SMOOTHING;
    gameState.camera.y += (targetY - gameState.camera.y) * CAMERA_SMOOTHING;
}

function handleMovement() {
    if (gameState.isLockedIn || gameState.anim.active) return;
    const player = gameState.players[gameState.userId];
    if (!player) return;
    let dx = 0, dy = 0;
    if (gameState.keys['KeyW'] || gameState.keys['ArrowUp']) dy -= MOVE_SPEED;
    if (gameState.keys['KeyS'] || gameState.keys['ArrowDown']) dy += MOVE_SPEED;
    if (gameState.keys['KeyA'] || gameState.keys['ArrowLeft']) dx -= MOVE_SPEED;
    if (gameState.keys['KeyD'] || gameState.keys['ArrowRight']) dx += MOVE_SPEED;
    if (dx !== 0 || dy !== 0) {
        const nextX = player.x + dx;
        const nextY = player.y + dy;
        if (!checkCollision(nextX, player.y)) player.x = nextX;
        if (!checkCollision(player.x, nextY)) player.y = nextY;
        updatePlayerPosition(player.x, player.y);
    }
}

function updateWindParticles() {
    gameState.windParticles.forEach(p => {
        p.x -= p.speed;
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
    const targetAlpha = (gameState.activeLaptop || gameState.isLockedIn) ? Math.min(baseAlpha, (1 - minDist / 120) * 1.5 || baseAlpha) : 0;
    
    const animAlphaMult = (gameState.anim.active && gameState.anim.phase !== 'none') ? 0 : 1;
    gameState.focusAlpha += (targetAlpha * animAlphaMult - gameState.focusAlpha) * 0.1;
}

function updateAnimation() {
    if (!gameState.anim.active) return;

    const player = gameState.players[gameState.userId];
    const laptop = gameState.anim.laptop;
    if (!player || !laptop) return;

    if (gameState.anim.phase === 'reach') {
        gameState.anim.progress += 0.08;
        if (gameState.anim.progress >= 1) {
            gameState.anim.phase = 'align'; 
            gameState.anim.progress = 0;
            gameState.anim.startPos = { x: player.x, y: player.y };
        }
    } else if (gameState.anim.phase === 'align') {
        gameState.anim.progress += 0.025; 
        const t = easeOutBack(gameState.anim.progress); 
        
        player.x = gameState.anim.startPos.x + (laptop.sitX - gameState.anim.startPos.x) * t;
        player.y = gameState.anim.startPos.y + (laptop.intermediateY - gameState.anim.startPos.y) * t;

        if (gameState.anim.progress >= 1) {
            gameState.anim.phase = 'pull';
            gameState.anim.progress = 0;
            gameState.anim.startPos = { x: player.x, y: player.y };
        }
    } else if (gameState.anim.phase === 'pull') {
        gameState.anim.progress += 0.045; 
        const t = easeOutBack(Math.pow(gameState.anim.progress, 2.5)); 
        
        player.y = gameState.anim.startPos.y + (laptop.sitY - gameState.anim.startPos.y) * t;

        if (gameState.anim.progress >= 1) {
            gameState.anim.active = false;
            gameState.anim.phase = 'none';
            gameState.isLockedIn = true;
            updatePlayerPosition(player.x, player.y);
        }
    }
}

function gameLoop() {
    handleMovement();
    updateAnimation();
    updateCamera();
    updateWindParticles();
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

    // Draw Animation Line UNDER players
    if (gameState.anim.active && (gameState.anim.phase === 'reach' || gameState.anim.phase === 'align' || gameState.anim.phase === 'pull')) {
        drawKidnapLine();
    }

    drawPlayers(false); 

    if (gameState.assets.shadow.complete) {
        ctx.drawImage(gameState.assets.shadow, -BG_WIDTH / 2, -BG_HEIGHT / 2, BG_WIDTH, BG_HEIGHT);
    }

    if (gameState.isLockedIn) {
        drawLockedInOverlay();
    }

    ctx.restore();

    // --- Focus/Darken Overlay ---
    if (gameState.focusAlpha > 0.01) {
        drawFocusMask(canvas);
    }

    drawWindParticles();
}

function drawKidnapLine() {
    const ctx = gameState.ctx;
    const player = gameState.players[gameState.userId];
    const laptop = gameState.anim.laptop;
    const p = gameState.anim.progress;
    
    ctx.strokeStyle = 'white'; // Changed to white as requested
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
    ctx.fillStyle = 'white';
    ctx.font = 'bold 16px Rubik';
    ctx.textAlign = 'center';
    ctx.shadowBlur = 4;
    ctx.shadowColor = 'black';
    ctx.fillText('انقر للبدء', laptop.x, laptop.y - 45);
    ctx.shadowBlur = 0;
}

function drawLockedInOverlay() {
    const ctx = gameState.ctx;
    const player = gameState.players[gameState.userId];
    if (!player) return;
    ctx.fillStyle = 'rgba(8, 111, 182, 0.3)';
    ctx.beginPath();
    ctx.arc(player.x, player.y, PLAYER_SIZE / 2 + 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'white';
    ctx.font = '500 12px Rubik';
    ctx.textAlign = 'center';
    ctx.fillText('ESC للخروج', player.x, player.y + PLAYER_SIZE / 2 + 45);
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
        const screenY = player.y;
        ctx.shadowBlur = 10;
        ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
        ctx.shadowOffsetY = 4;
        ctx.beginPath();
        ctx.arc(screenX, screenY, (PLAYER_SIZE / 2) + 4, 0, Math.PI * 2);
        ctx.fillStyle = isCurrentUser ? COLORS.blue : '#ffffff';
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;
        ctx.save();
        ctx.beginPath();
        ctx.arc(screenX, screenY, PLAYER_SIZE / 2, 0, Math.PI * 2);
        ctx.clip();
        const img = gameState.avatarCache[player.userId];
        if (img && img !== 'failed') {
            ctx.drawImage(img, screenX - PLAYER_SIZE / 2, screenY - PLAYER_SIZE / 2, PLAYER_SIZE, PLAYER_SIZE);
        } else {
            ctx.fillStyle = isCurrentUser ? COLORS.blue : '#ccc';
            ctx.fill();
            ctx.fillStyle = 'white';
            ctx.font = 'bold 24px Rubik';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(player.username.charAt(0).toUpperCase(), screenX, screenY);
        }
        ctx.restore();
        ctx.fillStyle = 'white';
        ctx.font = '500 14px Rubik';
        ctx.textAlign = 'center';
        ctx.fillText(player.username, screenX, screenY + PLAYER_SIZE / 2 + 25);
        if (isCurrentUser) {
            ctx.fillStyle = COLORS.blue;
            ctx.font = '700 10px Rubik';
            ctx.fillText('أنت', screenX, screenY - PLAYER_SIZE / 2 - 15);
        }
    }
}

if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }
