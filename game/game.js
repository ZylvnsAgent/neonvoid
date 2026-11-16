'use strict';
/* ==========================================================================
   NEONVOID — a neon twin-stick arena shooter.
   100% original: no copied art, names, assets, libraries or network calls.
   Canvas 2D only. Procedural WebAudio only. Desktop keyboard + mouse.

   How it plays
   - WASD / arrows to move, mouse to aim, hold left-click (or Space) to fire.
   - P or Esc pauses, R restarts from game over, M mutes, E detonates a bomb.
   - Survive waves of geometric hunters. Kills chain a combo multiplier
     (x1..x8). Taking a hit resets it. Power-ups drop from kills.
   ========================================================================== */

const TAU = Math.PI * 2;

/* ---------------- configuration ---------------- */
const CFG = {
  playerSpeed: 335,        // px/s
  playerRadius: 12,
  playerAccel: 14,         // lerp rate toward target velocity
  bulletSpeed: 780,
  bulletLife: 0.85,        // s (range ~660px)
  fireInterval: 0.13,      // s between shots (base)
  comboWindow: 2.5,        // s between kills to keep the combo alive
  maxParticles: 500,
  maxBullets: 220,
  maxEBullets: 140,
  maxEnemiesAlive: 26,
  powerupDropChance: 0.12,
  powerupLife: 10,         // s before a dropped power-up fades
  invulnAfterHit: 2.5,     // s of blinking invulnerability
  bestKey: 'neonvoid_best',
};

/* Enemy type table: color / shape / behaviour are all defined here. */
const ETYPES = {
  chaser:   { color: '#ff2d95', r: 14, hp: 1, speed: 152, score: 100, shape: 'diamond' },
  weaver:   { color: '#00e5ff', r: 15, hp: 1, speed: 128, score: 150, shape: 'square' },
  shooter:  { color: '#ff9f1c', r: 17, hp: 2, speed: 112, score: 200, shape: 'hex' },
  splitter: { color: '#39ff6a', r: 18, hp: 2, speed: 96,  score: 150, shape: 'pent' },
  shard:    { color: '#7dff9e', r: 8,  hp: 1, speed: 272, score: 50,  shape: 'tri' },
  orbiter:  { color: '#b537f2', r: 16, hp: 3, speed: 150, score: 250, shape: 'circle' },
};

/* Power-up table: letter drawn inside a glowing ring. */
const PTYPES = {
  spread: { letter: 'S', color: '#00e5ff', label: 'SPREAD SHOT' },
  rapid:  { letter: 'R', color: '#ffe14d', label: 'RAPID FIRE' },
  shield: { letter: 'H', color: '#4d8dff', label: 'SHIELD' },
  bomb:   { letter: 'B', color: '#ff5a3c', label: 'BOMB' },
};

/* ---------------- canvas ---------------- */
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let W = 0;
let H = 0;

function resize() {
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = W;
  canvas.height = H;
  // Keep the player inside the new bounds.
  if (player) {
    player.x = Math.min(Math.max(player.x, 20), W - 20);
    player.y = Math.min(Math.max(player.y, 20), H - 20);
  }
}
window.addEventListener('resize', resize);

/* ---------------- tiny utils ---------------- */
const rand = (a, b) => a + Math.random() * (b - a);
const randi = (a, b) => Math.floor(rand(a, b + 1));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const dist2 = (ax, ay, bx, by) => { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; };
const angTo = (ax, ay, bx, by) => Math.atan2(by - ay, bx - ax);

/* Remove every object flagged .dead, in place (swap-remove, no garbage). */
function sweep(arr) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].dead) { arr[i] = arr[arr.length - 1]; arr.pop(); }
  }
}

/* ---------------- audio: procedural WebAudio, no files ----------------
   The context is created lazily on the first user gesture, so the game is
   silent until the player actually interacts. M toggles mute. */
const AudioSys = {
  ctx: null,
  master: null,
  noiseBuf: null,
  muted: false,
  ready: false,

  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.4;
      this.master.connect(this.ctx.destination);
      // One shared 0.5s noise buffer for all explosion / hit sounds.
      const len = Math.floor(this.ctx.sampleRate * 0.5);
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.ready = true;
    } catch (e) {
      this.ready = false; // no audio available: game stays silent, never crashes
    }
  },

  /* Short oscillator blip with an exponential decay envelope. */
  tone(freq, dur, type, vol, slideTo, delay) {
    if (!this.ready || this.muted) return;
    const t0 = this.ctx.currentTime + (delay || 0);
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type || 'square';
    o.frequency.setValueAtTime(Math.max(1, freq), t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t0 + dur);
    g.gain.setValueAtTime(vol || 0.1, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(this.master);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  },

  /* Filtered noise burst (explosions, hits). */
  noise(dur, vol, cutoff) {
    if (!this.ready || this.muted) return;
    const t0 = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff || 1200;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol || 0.2, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  },

  shoot()      { this.tone(rand(680, 820), 0.07, 'square', 0.045, 320); },
  enemyShoot() { this.tone(280, 0.09, 'square', 0.035, 160); },
  explode(big) {
    this.noise(big ? 0.4 : 0.22, big ? 0.28 : 0.15, big ? 900 : 1400);
    this.tone(big ? 180 : 220, big ? 0.35 : 0.2, 'sawtooth', 0.13, 40);
  },
  hit()   { this.noise(0.3, 0.25, 700); this.tone(130, 0.3, 'sawtooth', 0.2, 45); },
  power() {
    this.tone(520, 0.09, 'sine', 0.13);
    this.tone(780, 0.12, 'sine', 0.13, 0, 0.08);
    this.tone(1040, 0.14, 'sine', 0.09, 0, 0.16);
  },
  wave() {
    this.tone(440, 0.1, 'triangle', 0.11);
    this.tone(660, 0.1, 'triangle', 0.11, 0, 0.1);
    this.tone(880, 0.16, 'triangle', 0.11, 0, 0.2);
  },
  bomb() { this.noise(0.7, 0.35, 500); this.tone(90, 0.6, 'sawtooth', 0.24, 30); },

  toggleMute() {
    this.muted = !this.muted;
    return this.muted;
  },
};

/* ---------------- game state ---------------- */
let state = 'menu'; // 'menu' | 'playing' | 'paused' | 'over'
let score = 0;
let best = 0;
let wave = 0;
let lives = 3;
let combo = 0;          // kills inside the combo window
let comboTimer = 0;     // s left on the combo window
let mult = 1;           // score multiplier x1..x8, derived from combo
let shake = 0;          // screen-shake magnitude (px), decays
let hitStop = 0;        // freeze timer (s) — brief pause on big kills / hits
let flashA = 0;         // white flash alpha (bomb / player hit)
let tGlobal = 0;        // ever-increasing clock for twinkle / bobbing
let newBest = false;    // set when the run beats the stored best

try { best = parseInt(localStorage.getItem(CFG.bestKey) || '0', 10) || 0; }
catch (e) { best = 0; }

function saveBest() {
  try { localStorage.setItem(CFG.bestKey, String(best)); } catch (e) { /* private mode */ }
}

/* Wave flow: 'active' spawns the queue, then 'breather' (2s) before next. */
let waveState = 'idle';
let waveTimer = 0;
let spawnTimer = 0;
let spawnQueue = [];
let bannerText = '';
let bannerT = 0;

/* ---------------- entities ---------------- */
const player = {
  x: 0, y: 0, vx: 0, vy: 0, angle: -Math.PI / 2, r: CFG.playerRadius,
  alive: false, invuln: 0, fireCd: 0, spreadT: 0, rapidT: 0,
  shield: false, bombs: 0, thrustT: 0,
};
const bullets = [];    // player bullets
const ebullets = [];   // enemy bullets
const enemies = [];
const particles = [];
const texts = [];      // floating score / event text
const powerups = [];
const stars = [];      // background starfield

function initStars() {
  stars.length = 0;
  const n = Math.floor((W * H) / 12000);
  for (let i = 0; i < n; i++) {
    stars.push({
      x: rand(0, W), y: rand(0, H),
      vx: rand(-6, -1), vy: rand(1, 6),       // slow drift, slight parallax feel
      size: rand(0.6, 2.1), tw: rand(0.5, 2.5), ph: rand(0, TAU),
      cyan: Math.random() < 0.25,             // a few cyan stars among the white
    });
  }
}

/* ---------------- input ---------------- */
const keys = {};
const mouse = { x: 0, y: 0, down: false };

function firstGesture() { AudioSys.ensure(); }

window.addEventListener('keydown', (e) => {
  firstGesture();
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
    e.preventDefault(); // never let the page scroll while playing
  }
  if (e.repeat) return;
  keys[e.code] = true;

  if (e.code === 'Enter') {
    if (state === 'menu' || state === 'over') startGame();
  } else if (e.code === 'KeyR') {
    if (state === 'over') startGame();
  } else if (e.code === 'KeyP' || e.code === 'Escape') {
    if (state === 'playing') state = 'paused';
    else if (state === 'paused') state = 'playing';
  } else if (e.code === 'KeyM') {
    AudioSys.toggleMute();
  } else if (e.code === 'KeyE') {
    if (state === 'playing') detonateBomb();
  }
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });
window.addEventListener('blur', () => {
  for (const k in keys) keys[k] = false;
  mouse.down = false;
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state === 'playing') state = 'paused';
});
window.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });
window.addEventListener('mousedown', (e) => {
  firstGesture();
  if (e.button !== 0) return;
  mouse.down = true;
  mouse.x = e.clientX; mouse.y = e.clientY;
  if (state === 'menu' || state === 'over') startGame();
});
window.addEventListener('mouseup', (e) => { if (e.button === 0) mouse.down = false; });
window.addEventListener('contextmenu', (e) => e.preventDefault());

/* ---------------- waves & spawning ---------------- */
function startGame() {
  score = 0; wave = 0; lives = 3;
  combo = 0; comboTimer = 0; mult = 1;
  newBest = false;
  shake = 0; hitStop = 0; flashA = 0;
  bullets.length = 0; ebullets.length = 0; enemies.length = 0;
  particles.length = 0; texts.length = 0; powerups.length = 0;
  player.x = W / 2; player.y = H / 2;
  player.vx = 0; player.vy = 0; player.angle = -Math.PI / 2;
  player.alive = true; player.invuln = 0; player.fireCd = 0;
  player.spreadT = 0; player.rapidT = 0; player.shield = false; player.bombs = 0;
  state = 'playing';
  startWave(1);
}

function startWave(n) {
  wave = n;
  spawnQueue = buildWaveQueue(n);
  waveState = 'active';
  spawnTimer = 0.4;
  bannerText = 'WAVE ' + n;
  bannerT = 2.2;
  AudioSys.wave();
}

/* Wave N: 5 + 3N enemies, mix widens as waves climb. */
function buildWaveQueue(n) {
  const total = Math.min(42, 5 + n * 3);
  const bag = [];
  const add = (type, weight) => { for (let i = 0; i < weight; i++) bag.push(type); };
  add('chaser', 10);
  if (n >= 2) { add('weaver', 6); add('splitter', 4); }
  if (n >= 3) add('shooter', 5);
  if (n >= 4) add('orbiter', 4);
  const q = [];
  while (q.length < total) q.push(pick(bag));
  return q;
}

/* Spawn at a screen edge, at least ~280px from the player. */
function spawnPos() {
  for (let tries = 0; tries < 20; tries++) {
    const edge = randi(0, 3);
    let x, y;
    if (edge === 0) { x = rand(0, W); y = -30; }
    else if (edge === 1) { x = W + 30; y = rand(0, H); }
    else if (edge === 2) { x = rand(0, W); y = H + 30; }
    else { x = -30; y = rand(0, H); }
    if (dist2(x, y, player.x, player.y) > 280 * 280) return { x, y };
  }
  return { x: W / 2, y: -30 };
}

function spawnEnemy(type, x, y) {
  const base = ETYPES[type];
  const hpBonus = type === 'shard' ? 0 : Math.min(2, Math.floor((wave - 1) / 5));
  const spdScale = 1 + Math.min(0.5, (wave - 1) * 0.04);
  const p = (x === undefined) ? spawnPos() : { x, y };
  enemies.push({
    type, x: p.x, y: p.y, vx: 0, vy: 0,
    r: base.r, hp: base.hp + hpBonus, maxHp: base.hp + hpBonus,
    speed: base.speed * spdScale, score: base.score,
    color: base.color, shape: base.shape,
    t: rand(0, TAU), spawnT: 0.5, flash: 0,
    fireCd: rand(1.2, 2.4),
    state: 'orbit', stateT: rand(2, 3.5), // orbiter only
    angle: rand(0, TAU), lungeA: 0,        // orbiter only
    dead: false,
  });
}

/* ---------------- fx helpers ---------------- */
function spawnParticles(x, y, n, color, speed, life, size) {
  for (let i = 0; i < n; i++) {
    if (particles.length >= CFG.maxParticles) return;
    const a = rand(0, TAU);
    const s = rand(speed * 0.25, speed);
    particles.push({
      x, y,
      vx: Math.cos(a) * s, vy: Math.sin(a) * s,
      life: rand(life * 0.5, life), max: life,
      size: rand(size * 0.6, size * 1.4),
      color, drag: 0.92, dead: false,
    });
  }
}

function explode(x, y, color, n, power) {
  spawnParticles(x, y, n, color, 280 * power, 0.7, 3);
  spawnParticles(x, y, Math.floor(n / 3), '#ffffff', 180 * power, 0.4, 2);
}

function addText(x, y, txt, color, size) {
  texts.push({ x, y, txt, color: color || '#ffffff', size: size || 14, life: 0.9, max: 0.9, dead: false });
}

/* ---------------- combat ---------------- */
function fireBullet() {
  const angles = player.spreadT > 0 ? [-0.16, 0, 0.16] : [0];
  for (const off of angles) {
    if (bullets.length >= CFG.maxBullets) break;
    const a = player.angle + off;
    bullets.push({
      x: player.x + Math.cos(a) * 18,
      y: player.y + Math.sin(a) * 18,
      vx: Math.cos(a) * CFG.bulletSpeed,
      vy: Math.sin(a) * CFG.bulletSpeed,
      life: CFG.bulletLife, dead: false,
    });
  }
  // Muzzle flash: a few bright sparks at the nose.
  spawnParticles(
    player.x + Math.cos(player.angle) * 20,
    player.y + Math.sin(player.angle) * 20,
    3, '#9df2ff', 130, 0.14, 2
  );
  AudioSys.shoot();
}

function damageEnemy(e, dmg) {
  if (e.dead) return;
  e.hp -= dmg;
  e.flash = 0.09;
  spawnParticles(e.x, e.y, 3, e.color, 140, 0.25, 2);
  if (e.hp <= 0) killEnemy(e, true, true);
}

/* award: add score + combo. allowDrop: may drop a power-up. */
function killEnemy(e, award, allowDrop) {
  if (e.dead) return;
  e.dead = true;
  const big = e.type === 'orbiter' || e.type === 'splitter';
  explode(e.x, e.y, e.color, big ? 26 : 14, big ? 1.2 : 0.9);
  AudioSys.explode(big);
  if (big) hitStop = Math.max(hitStop, 0.06); // hit-stop on big kills
  if (award) {
    combo += 1;
    comboTimer = CFG.comboWindow;
    mult = Math.min(8, 1 + Math.floor(combo / 4));
    const pts = e.score * mult;
    score += pts;
    addText(e.x, e.y - 10, '+' + pts, mult > 1 ? '#ffe14d' : '#ffffff', mult > 1 ? 17 : 14);
    if (allowDrop && Math.random() < CFG.powerupDropChance) dropPowerup(e.x, e.y);
  }
  if (e.type === 'splitter') {
    // Splits into 3 small fast shards that scatter from the corpse.
    for (let i = 0; i < 3; i++) {
      const a = rand(0, TAU);
      const s = spawnEnemyAt('shard', e.x + Math.cos(a) * 14, e.y + Math.sin(a) * 14);
      if (s) { s.vx = Math.cos(a) * 200; s.vy = Math.sin(a) * 200; s.spawnT = 0.15; }
    }
  }
}

/* Spawn one enemy at an exact spot (used by the splitter). */
function spawnEnemyAt(type, x, y) {
  const before = enemies.length;
  spawnEnemy(type, x, y);
  return enemies[before] || null;
}

function dropPowerup(x, y) {
  const roll = Math.random();
  const type = roll < 0.3 ? 'spread' : roll < 0.6 ? 'rapid' : roll < 0.8 ? 'shield' : 'bomb';
  powerups.push({
    x, y, vx: rand(-30, 30), vy: rand(-30, 30),
    type, letter: PTYPES[type].letter, color: PTYPES[type].color,
    t: CFG.powerupLife, dead: false,
  });
}

function applyPowerup(p) {
  AudioSys.power();
  if (p.type === 'spread') { player.spreadT = 12; addText(player.x, player.y - 24, 'SPREAD SHOT!', '#00e5ff', 16); }
  else if (p.type === 'rapid') { player.rapidT = 12; addText(player.x, player.y - 24, 'RAPID FIRE!', '#ffe14d', 16); }
  else if (p.type === 'shield') { player.shield = true; addText(player.x, player.y - 24, 'SHIELD UP!', '#4d8dff', 16); }
  else if (p.type === 'bomb') {
    if (player.bombs > 0) detonateBomb(); // holding one already: new pickup fires at once
    else { player.bombs = 1; addText(player.x, player.y - 24, 'BOMB READY — E!', '#ff5a3c', 16); }
  }
}

/* Clear every on-screen enemy. Costs one bomb charge. */
function detonateBomb() {
  if (player.bombs <= 0 || state !== 'playing') return;
  player.bombs -= 1;
  flashA = 0.55;
  shake = Math.max(shake, 18);
  hitStop = Math.max(hitStop, 0.08);
  AudioSys.bomb();
  addText(player.x, player.y - 30, 'VOID BOMB!', '#ff5a3c', 22);
  for (const e of [...enemies]) {
    if (!e.dead) killEnemy(e, true, false); // score, no drops — bomb ignores spawn-in protection
  }
}

function playerHit() {
  if (player.invuln > 0 || !player.alive) return;
  if (player.shield) {
    // Shield absorbs the blow and pops.
    player.shield = false;
    player.invuln = 1;
    shake = Math.max(shake, 8);
    AudioSys.hit();
    addText(player.x, player.y - 24, 'SHIELD DOWN', '#4d8dff', 16);
    return;
  }
  lives -= 1;
  combo = 0; comboTimer = 0; mult = 1; // a hit resets the combo
  player.invuln = CFG.invulnAfterHit;
  shake = 15;
  hitStop = Math.max(hitStop, 0.12);
  flashA = 0.28;
  explode(player.x, player.y, '#7df9ff', 30, 1.2);
  AudioSys.hit();
  if (lives <= 0) gameOver();
}

function gameOver() {
  player.alive = false;
  state = 'over';
  explode(player.x, player.y, '#ff2d95', 46, 1.6);
  explode(player.x, player.y, '#7df9ff', 30, 1.3);
  shake = 20;
  if (score > best) { best = score; newBest = true; saveBest(); }
}

/* ---------------- update ---------------- */
function update(dt) {
  tGlobal += dt;
  if (bannerT > 0) bannerT -= dt;
  if (flashA > 0) flashA = Math.max(0, flashA - dt * 2.2);
  if (shake > 0) shake = Math.max(0, shake - dt * 34);

  updateStars(dt);
  updateParticles(dt);
  updateTexts(dt);
  if (state !== 'playing') return; // menu / paused / over: background only

  // Combo decay.
  if (comboTimer > 0) {
    comboTimer -= dt;
    if (comboTimer <= 0) { combo = 0; mult = 1; }
  }

  updatePlayer(dt);
  updateSpawner(dt);
  updateBullets(dt);
  updateEnemies(dt);
  updateEBullets(dt);
  updatePowerups(dt);
  separateEnemies();
  checkCollisions();

  sweep(bullets); sweep(ebullets); sweep(enemies);
  sweep(particles); sweep(texts); sweep(powerups);
}

function updateStars(dt) {
  for (const s of stars) {
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    if (s.x < -4) s.x = W + 4;
    if (s.y > H + 4) s.y = -4;
  }
}

function updateParticles(dt) {
  for (const p of particles) {
    p.life -= dt;
    if (p.life <= 0) { p.dead = true; continue; }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= p.drag;
    p.vy *= p.drag;
  }
}

function updateTexts(dt) {
  for (const t of texts) {
    t.life -= dt;
    if (t.life <= 0) { t.dead = true; continue; }
    t.y -= 42 * dt; // float upward
  }
}

function updatePlayer(dt) {
  if (!player.alive) return;
  if (player.invuln > 0) player.invuln -= dt;
  if (player.fireCd > 0) player.fireCd -= dt;
  if (player.spreadT > 0) player.spreadT -= dt;
  if (player.rapidT > 0) player.rapidT -= dt;

  // Movement: WASD or arrows, lerped toward target velocity (smooth, weighty).
  let ix = 0, iy = 0;
  if (keys['KeyA'] || keys['ArrowLeft']) ix -= 1;
  if (keys['KeyD'] || keys['ArrowRight']) ix += 1;
  if (keys['KeyW'] || keys['ArrowUp']) iy -= 1;
  if (keys['KeyS'] || keys['ArrowDown']) iy += 1;
  if (ix !== 0 || iy !== 0) {
    const il = Math.hypot(ix, iy);
    ix /= il; iy /= il;
  }
  const k = Math.min(1, CFG.playerAccel * dt);
  player.vx += (ix * CFG.playerSpeed - player.vx) * k;
  player.vy += (iy * CFG.playerSpeed - player.vy) * k;
  player.x += player.vx * dt;
  player.y += player.vy * dt;
  // Clamp to the playfield.
  if (player.x < player.r) { player.x = player.r; player.vx = Math.max(0, player.vx); }
  if (player.x > W - player.r) { player.x = W - player.r; player.vx = Math.min(0, player.vx); }
  if (player.y < player.r) { player.y = player.r; player.vy = Math.max(0, player.vy); }
  if (player.y > H - player.r) { player.y = H - player.r; player.vy = Math.min(0, player.vy); }

  // Aim at the mouse.
  player.angle = angTo(player.x, player.y, mouse.x, mouse.y);

  // Thrust particles while moving.
  const spd = Math.hypot(player.vx, player.vy);
  if (spd > 60) {
    player.thrustT -= dt;
    if (player.thrustT <= 0) {
      player.thrustT = 0.03;
      const back = Math.atan2(player.vy, player.vx) + Math.PI;
      spawnParticles(
        player.x + Math.cos(back) * 12,
        player.y + Math.sin(back) * 12,
        1, '#4dd7ff', 60, 0.35, 2
      );
    }
  }

  // Fire while holding left-click or Space.
  if ((mouse.down || keys['Space']) && player.fireCd <= 0) {
    fireBullet();
    player.fireCd = player.rapidT > 0 ? CFG.fireInterval / 2 : CFG.fireInterval;
  }
}

function updateSpawner(dt) {
  if (waveState === 'active') {
    if (spawnQueue.length > 0) {
      spawnTimer -= dt;
      if (spawnTimer <= 0 && enemies.length < CFG.maxEnemiesAlive) {
        spawnEnemy(spawnQueue.shift());
        spawnTimer = Math.max(0.22, 0.5 - wave * 0.015);
      }
    } else if (enemies.length === 0) {
      // Wave cleared: 2s breather, then the next wave.
      waveState = 'breather';
      waveTimer = 2;
      bannerText = 'WAVE ' + wave + ' CLEARED';
      bannerT = 1.6;
    }
  } else if (waveState === 'breather') {
    waveTimer -= dt;
    if (waveTimer <= 0) startWave(wave + 1);
  }
}

function updateBullets(dt) {
  for (const b of bullets) {
    b.life -= dt;
    if (b.life <= 0) { b.dead = true; continue; }
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    if (b.x < -20 || b.x > W + 20 || b.y < -20 || b.y > H + 20) b.dead = true;
  }
}

function updateEBullets(dt) {
  for (const b of ebullets) {
    b.life -= dt;
    if (b.life <= 0) { b.dead = true; continue; }
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    if (b.x < -20 || b.x > W + 20 || b.y < -20 || b.y > H + 20) b.dead = true;
  }
}

function updateEnemies(dt) {
  for (const e of enemies) {
    if (e.dead) continue;
    e.t += dt;
    if (e.spawnT > 0) e.spawnT -= dt;
    if (e.flash > 0) e.flash -= dt;
    const aP = angTo(e.x, e.y, player.x, player.y); // angle to player

    if (e.type === 'chaser' || e.type === 'shard') {
      // Home straight in, with a slight wobble so paths don't look robotic.
      const wob = Math.sin(e.t * 3 + e.x * 0.01) * 0.35;
      const a = aP + wob * 0.3;
      e.vx = Math.cos(a) * e.speed;
      e.vy = Math.sin(a) * e.speed;
    } else if (e.type === 'weaver') {
      // Sine-wave drift toward the player.
      const px = Math.cos(aP + Math.PI / 2), py = Math.sin(aP + Math.PI / 2);
      const wob = Math.sin(e.t * 5) * 150;
      e.vx = Math.cos(aP) * e.speed + px * wob;
      e.vy = Math.sin(aP) * e.speed + py * wob;
    } else if (e.type === 'shooter') {
      // Keep ~260px away, strafe sideways, fire aimed shots.
      const d = Math.hypot(player.x - e.x, player.y - e.y);
      const px = Math.cos(aP + Math.PI / 2), py = Math.sin(aP + Math.PI / 2);
      if (d > 300) { e.vx = Math.cos(aP) * e.speed; e.vy = Math.sin(aP) * e.speed; }
      else if (d < 220) { e.vx = -Math.cos(aP) * e.speed * 0.8; e.vy = -Math.sin(aP) * e.speed * 0.8; }
      else { e.vx = px * 70 * Math.sin(e.t * 1.5); e.vy = py * 70 * Math.sin(e.t * 1.5); }
      e.fireCd -= dt;
      if (e.fireCd <= 0 && e.spawnT <= 0 && d < 580 && player.alive) {
        e.fireCd = rand(1.8, 2.6);
        const fa = aP + rand(-0.06, 0.06);
        if (ebullets.length < CFG.maxEBullets) {
          ebullets.push({
            x: e.x + Math.cos(fa) * (e.r + 6),
            y: e.y + Math.sin(fa) * (e.r + 6),
            vx: Math.cos(fa) * 250, vy: Math.sin(fa) * 250,
            life: 3.2, dead: false,
          });
        }
        AudioSys.enemyShoot();
      }
    } else if (e.type === 'splitter') {
      // Slow, steady chase. Death is the dangerous part.
      e.vx = Math.cos(aP) * e.speed;
      e.vy = Math.sin(aP) * e.speed;
    } else if (e.type === 'orbiter') {
      e.stateT -= dt;
      if (e.state === 'orbit') {
        // Circle the player at ~190px, easing toward the orbit point.
        e.angle += dt * 1.6;
        const wantR = 190 + Math.sin(e.t * 1.3) * 40;
        const tx = player.x + Math.cos(e.angle) * wantR;
        const ty = player.y + Math.sin(e.angle) * wantR;
        const kk = Math.min(1, 3 * dt);
        e.x += (tx - e.x) * kk;
        e.y += (ty - e.y) * kk;
        if (e.stateT <= 0) {
          e.state = 'lunge';
          e.stateT = 0.55;
          e.lungeA = aP;
        }
      } else if (e.state === 'lunge') {
        // Fast dash straight at where the player was.
        e.x += Math.cos(e.lungeA) * 430 * dt;
        e.y += Math.sin(e.lungeA) * 430 * dt;
        if (e.stateT <= 0) { e.state = 'recover'; e.stateT = 1.2; }
      } else {
        // Drift back out after the lunge, then rejoin the orbit.
        const aOut = angTo(player.x, player.y, e.x, e.y);
        e.x += Math.cos(aOut) * 130 * dt;
        e.y += Math.sin(aOut) * 130 * dt;
        if (e.stateT <= 0) {
          e.state = 'orbit';
          e.stateT = rand(2.2, 3.6);
          e.angle = angTo(player.x, player.y, e.x, e.y);
        }
      }
    }

    e.x += e.vx * dt;
    e.y += e.vy * dt;
    // Softly keep enemies inside the playfield (they spawn just outside).
    if (e.x < -40) e.x = -40; if (e.x > W + 40) e.x = W + 40;
    if (e.y < -40) e.y = -40; if (e.y > H + 40) e.y = H + 40;
  }
}

function updatePowerups(dt) {
  for (const p of powerups) {
    p.t -= dt;
    if (p.t <= 0) { p.dead = true; continue; }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 0.98; p.vy *= 0.98;
    // Gentle magnet: drift toward the player when close.
    if (player.alive) {
      const d2p = dist2(p.x, p.y, player.x, player.y);
      if (d2p < 110 * 110) {
        const a = angTo(p.x, p.y, player.x, player.y);
        p.x += Math.cos(a) * 90 * dt;
        p.y += Math.sin(a) * 90 * dt;
      }
    }
  }
}

/* Push overlapping enemies apart so they never stack into one blob. */
function separateEnemies() {
  for (let i = 0; i < enemies.length; i++) {
    const a = enemies[i];
    if (a.dead) continue;
    for (let j = i + 1; j < enemies.length; j++) {
      const b = enemies[j];
      if (b.dead) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const rr = a.r + b.r;
      const d2 = dx * dx + dy * dy;
      if (d2 > 0.01 && d2 < rr * rr) {
        const d = Math.sqrt(d2);
        const push = (rr - d) / d * 0.25;
        a.x -= dx * push; a.y -= dy * push;
        b.x += dx * push; b.y += dy * push;
      }
    }
  }
}

function checkCollisions() {
  // Player bullets vs enemies.
  for (const b of bullets) {
    if (b.dead) continue;
    for (const e of enemies) {
      if (e.dead || e.spawnT > 0.25) continue; // still materialising: untouchable
      const rr = e.r + 5;
      if (dist2(b.x, b.y, e.x, e.y) < rr * rr) {
        b.dead = true;
        damageEnemy(e, 1);
        break; // one bullet, one enemy
      }
    }
  }
  if (!player.alive) return;

  // Enemies vs player.
  for (const e of enemies) {
    if (e.dead || e.spawnT > 0.25) continue;
    const rr = e.r + player.r - 2;
    if (dist2(e.x, e.y, player.x, player.y) < rr * rr) {
      killEnemy(e, false, false); // the rammer dies too, but pays no score
      playerHit();
      if (!player.alive) return;
    }
  }

  // Enemy bullets vs player.
  for (const b of ebullets) {
    if (b.dead) continue;
    const rr = 4 + player.r - 2;
    if (dist2(b.x, b.y, player.x, player.y) < rr * rr) {
      b.dead = true;
      playerHit();
      if (!player.alive) return;
    }
  }

  // Power-ups vs player.
  for (const p of powerups) {
    if (p.dead) continue;
    const rr = 14 + player.r;
    if (dist2(p.x, p.y, player.x, player.y) < rr * rr) {
      p.dead = true;
      applyPowerup(p);
    }
  }
}

/* ---------------- rendering ---------------- */
const FONT = '"Lucida Console", Menlo, Consolas, monospace';

function drawBackground() {
  ctx.fillStyle = '#050510';
  ctx.fillRect(0, 0, W, H);

  // Subtle grid.
  ctx.strokeStyle = 'rgba(70, 90, 200, 0.09)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= W; x += 64) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); }
  for (let y = 0; y <= H; y += 64) { ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); }
  ctx.stroke();

  // Drifting starfield (twinkle by phase).
  for (const s of stars) {
    const a = 0.25 + 0.65 * Math.abs(Math.sin(tGlobal * s.tw + s.ph));
    ctx.globalAlpha = a;
    ctx.fillStyle = s.cyan ? '#9df2ff' : '#ffffff';
    ctx.fillRect(s.x, s.y, s.size, s.size);
  }
  ctx.globalAlpha = 1;
}

/* A regular polygon path, rotated; used for every geometric enemy. */
function polyPath(x, y, r, sides, rot) {
  ctx.beginPath();
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * TAU;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function drawEnemy(e) {
  // Spawn-in: scale up from 0.4 and fade in.
  const scale = e.spawnT > 0 ? 1 - (e.spawnT / 0.5) * 0.6 : 1;
  const alpha = e.spawnT > 0 ? 1 - (e.spawnT / 0.5) * 0.6 : 1;
  const r = e.r * scale;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = e.color;
  ctx.shadowBlur = 16;
  ctx.strokeStyle = e.color;
  ctx.fillStyle = e.flash > 0 ? '#ffffff' : e.color; // damage flash: white
  ctx.lineWidth = 2;
  const rot = e.t * (e.type === 'weaver' ? 1.2 : 0.6);
  if (e.shape === 'circle') {
    ctx.beginPath();
    ctx.arc(e.x, e.y, r, 0, TAU);
    ctx.fill();
    // Orbiter inner ring so it reads as a different creature, not a bullet.
    ctx.strokeStyle = '#ffffff';
    ctx.globalAlpha = alpha * 0.7;
    ctx.beginPath();
    ctx.arc(e.x, e.y, r * 0.55, 0, TAU);
    ctx.stroke();
  } else if (e.shape === 'diamond') {
    polyPath(e.x, e.y, r, 4, rot + Math.PI / 4);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.globalAlpha = alpha * 0.8;
    polyPath(e.x, e.y, r * 0.55, 4, rot + Math.PI / 4);
    ctx.stroke();
  } else if (e.shape === 'square') {
    polyPath(e.x, e.y, r, 4, rot);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.globalAlpha = alpha * 0.8;
    polyPath(e.x, e.y, r * 0.5, 4, rot);
    ctx.stroke();
  } else if (e.shape === 'hex') {
    polyPath(e.x, e.y, r, 6, rot);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.globalAlpha = alpha * 0.8;
    ctx.beginPath();
    ctx.arc(e.x, e.y, r * 0.45, 0, TAU);
    ctx.stroke();
  } else if (e.shape === 'pent') {
    polyPath(e.x, e.y, r, 5, rot);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.globalAlpha = alpha * 0.8;
    polyPath(e.x, e.y, r * 0.5, 5, -rot);
    ctx.stroke();
  } else { // tri (shard)
    polyPath(e.x, e.y, r, 3, Math.atan2(e.vy, e.vx));
    ctx.fill();
  }
  ctx.restore();

  // HP pips for tougher enemies (only when hurt, so the screen stays clean).
  if (e.maxHp > 1 && e.hp < e.maxHp) {
    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < e.maxHp; i++) {
      ctx.globalAlpha = i < e.hp ? 0.9 : 0.25;
      ctx.fillRect(e.x - e.maxHp * 4 + i * 8, e.y - e.r - 10, 6, 3);
    }
    ctx.globalAlpha = 1;
  }
}

/* The player's arrow ship. */
function drawShip(x, y, angle, scale, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.scale(scale, scale);
  ctx.shadowColor = color;
  ctx.shadowBlur = 14;
  ctx.fillStyle = color;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(16, 0);
  ctx.lineTo(-11, 10);
  ctx.lineTo(-6, 0);
  ctx.lineTo(-11, -10);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawPowerup(p) {
  const bob = Math.sin(tGlobal * 3 + p.x * 0.05) * 2;
  const blink = p.t < 3 ? (Math.sin(tGlobal * 10) > 0 ? 1 : 0.25) : 1; // fade warning
  ctx.save();
  ctx.globalAlpha = blink;
  ctx.shadowColor = p.color;
  ctx.shadowBlur = 14;
  ctx.strokeStyle = p.color;
  ctx.fillStyle = 'rgba(5, 5, 16, 0.85)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(p.x, p.y + bob, 13, 0, TAU);
  ctx.fill();
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = p.color;
  ctx.font = 'bold 13px ' + FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(p.letter, p.x, p.y + bob + 0.5);
  ctx.restore();
}

function render() {
  ctx.save();
  // Screen shake: random offset scaled by current magnitude.
  if (shake > 0.2) ctx.translate(rand(-shake, shake) * 0.5, rand(-shake, shake) * 0.5);

  drawBackground();

  // Power-ups under the action.
  for (const p of powerups) drawPowerup(p);

  // Enemies (additive glow pass).
  ctx.globalCompositeOperation = 'lighter';
  for (const e of enemies) if (!e.dead) drawEnemy(e);

  // Enemy bullets: hot orange-red orbs.
  for (const b of ebullets) {
    if (b.dead) continue;
    ctx.shadowColor = '#ff5a3c';
    ctx.shadowBlur = 10;
    ctx.fillStyle = '#ff7a4d';
    ctx.beginPath();
    ctx.arc(b.x, b.y, 4.5, 0, TAU);
    ctx.fill();
  }

  // Player bullets: bright streaks with a short trail.
  ctx.strokeStyle = '#bff6ff';
  ctx.lineWidth = 3;
  ctx.shadowColor = '#59d8ff';
  ctx.shadowBlur = 10;
  ctx.beginPath();
  for (const b of bullets) {
    if (b.dead) continue;
    ctx.moveTo(b.x - b.vx * 0.028, b.y - b.vy * 0.028);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
  ctx.globalCompositeOperation = 'source-over';
  ctx.shadowBlur = 0;

  // Player: blink while invulnerable (skip the draw every other 0.1s).
  if (player.alive && (state === 'playing' || state === 'paused')) {
    const blinkOff = player.invuln > 0 && Math.floor(tGlobal * 10) % 2 === 0;
    if (!blinkOff) drawShip(player.x, player.y, player.angle, 1, '#7df9ff');
    if (player.shield) {
      ctx.save();
      ctx.strokeStyle = 'rgba(77, 141, 255, 0.9)';
      ctx.shadowColor = '#4d8dff';
      ctx.shadowBlur = 12;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(player.x, player.y, player.r + 9 + Math.sin(tGlobal * 4) * 1.5, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
  }

  // Particles (plain additive dots — no shadowBlur, keeps 60fps).
  ctx.globalCompositeOperation = 'lighter';
  for (const p of particles) {
    if (p.dead) continue;
    ctx.globalAlpha = Math.max(0, p.life / p.max);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  // Floating score text.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const t of texts) {
    if (t.dead) continue;
    ctx.globalAlpha = Math.max(0, t.life / t.max);
    ctx.font = 'bold ' + t.size + 'px ' + FONT;
    ctx.fillStyle = t.color;
    ctx.fillText(t.txt, t.x, t.y);
  }
  ctx.globalAlpha = 1;

  // Bomb / hit flash.
  if (flashA > 0) {
    ctx.fillStyle = 'rgba(255, 255, 255, ' + flashA.toFixed(3) + ')';
    ctx.fillRect(-20, -20, W + 40, H + 40);
  }
  ctx.restore();

  drawHUD();
  if (bannerT > 0 && (state === 'playing' || state === 'paused')) drawBanner();
  if (state === 'menu') drawMenu();
  else if (state === 'paused') drawPaused();
  else if (state === 'over') drawGameOver();
}

function drawHUD() {
  if (state === 'menu') return;
  ctx.textBaseline = 'alphabetic';
  // Score, top-left.
  ctx.textAlign = 'left';
  ctx.fillStyle = '#8b93b8';
  ctx.font = '11px ' + FONT;
  ctx.fillText('SCORE', 18, 24);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 24px ' + FONT;
  ctx.fillText(String(score).padStart(6, '0'), 18, 50);
  ctx.fillStyle = '#8b93b8';
  ctx.font = '11px ' + FONT;
  ctx.fillText('BEST  ' + String(Math.max(best, score)).padStart(6, '0'), 18, 70);

  // Wave + combo, top-center.
  ctx.textAlign = 'center';
  ctx.fillStyle = '#8b93b8';
  ctx.font = '11px ' + FONT;
  ctx.fillText('WAVE', W / 2, 24);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 24px ' + FONT;
  ctx.fillText(String(wave), W / 2, 50);
  if (mult > 1 && state === 'playing') {
    ctx.fillStyle = mult >= 6 ? '#ff5a3c' : '#ffe14d';
    ctx.font = 'bold 18px ' + FONT;
    ctx.fillText('x' + mult + ' COMBO', W / 2, 76);
    // Combo time bar.
    const bw = 90;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.fillRect(W / 2 - bw / 2, 84, bw, 4);
    ctx.fillStyle = mult >= 6 ? '#ff5a3c' : '#ffe14d';
    ctx.fillRect(W / 2 - bw / 2, 84, bw * clamp(comboTimer / CFG.comboWindow, 0, 1), 4);
  }

  // Lives (ship icons) + power-ups, top-right.
  ctx.textAlign = 'right';
  ctx.fillStyle = '#8b93b8';
  ctx.font = '11px ' + FONT;
  ctx.fillText('LIVES', W - 18, 24);
  for (let i = 0; i < Math.max(0, lives); i++) {
    drawShip(W - 30 - i * 26, 44, -Math.PI / 2, 0.8, '#7df9ff');
  }
  let py = 74;
  ctx.font = 'bold 12px ' + FONT;
  if (player.spreadT > 0) {
    ctx.fillStyle = '#00e5ff';
    ctx.fillText('SPREAD ' + Math.ceil(player.spreadT) + 's', W - 18, py); py += 18;
  }
  if (player.rapidT > 0) {
    ctx.fillStyle = '#ffe14d';
    ctx.fillText('RAPID ' + Math.ceil(player.rapidT) + 's', W - 18, py); py += 18;
  }
  if (player.shield) {
    ctx.fillStyle = '#4d8dff';
    ctx.fillText('SHIELD', W - 18, py); py += 18;
  }
  if (player.bombs > 0) {
    ctx.fillStyle = '#ff5a3c';
    ctx.fillText('BOMB [E]', W - 18, py); py += 18;
  }

  // Mute hint, bottom-right.
  ctx.textAlign = 'right';
  ctx.fillStyle = AudioSys.muted ? '#ff5a3c' : '#5a6285';
  ctx.font = '11px ' + FONT;
  ctx.fillText(AudioSys.muted ? 'MUTED  [M]' : '[M] SOUND', W - 18, H - 16);
}

function drawBanner() {
  const a = clamp(bannerT, 0, 1);
  ctx.save();
  ctx.globalAlpha = a;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = '#7df9ff';
  ctx.shadowBlur = 26;
  ctx.fillStyle = '#dffaff';
  ctx.font = 'bold 52px ' + FONT;
  ctx.fillText(bannerText, W / 2, H * 0.32);
  ctx.restore();
}

function drawMenu() {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Title with neon glow.
  ctx.shadowColor = '#00e5ff';
  ctx.shadowBlur = 34;
  ctx.fillStyle = '#aef4ff';
  ctx.font = 'bold 84px ' + FONT;
  ctx.fillText('NEONVOID', W / 2, H * 0.26);
  ctx.shadowBlur = 12;
  ctx.fillStyle = '#ff2d95';
  ctx.font = 'bold 20px ' + FONT;
  ctx.fillText('— A NEON ARENA SHOOTER —', W / 2, H * 0.26 + 56);

  ctx.shadowBlur = 0;
  ctx.fillStyle = '#c6cbe0';
  ctx.font = '15px ' + FONT;
  const lines = [
    'WASD / ARROWS — move      MOUSE — aim',
    'HOLD CLICK or SPACE — shoot      E — detonate bomb',
    'P / ESC — pause      R — restart      M — mute',
    '',
    'Chain kills to raise your combo multiplier (x1 – x8).',
    'A hit resets it. Grab drops: S spread, R rapid, H shield, B bomb.',
    'Desktop keyboard + mouse only — no touch support.',
  ];
  lines.forEach((ln, i) => ctx.fillText(ln, W / 2, H * 0.44 + i * 26));

  // Start prompt, gently pulsing.
  const pulse = 0.65 + 0.35 * Math.sin(tGlobal * 3);
  ctx.globalAlpha = pulse;
  ctx.fillStyle = '#ffe14d';
  ctx.font = 'bold 22px ' + FONT;
  ctx.fillText('CLICK OR PRESS ENTER TO START', W / 2, H * 0.72);
  ctx.globalAlpha = 1;

  if (best > 0) {
    ctx.fillStyle = '#8b93b8';
    ctx.font = '14px ' + FONT;
    ctx.fillText('BEST  ' + String(best).padStart(6, '0'), W / 2, H * 0.72 + 34);
  }
  ctx.restore();
}

function drawPaused() {
  ctx.save();
  ctx.fillStyle = 'rgba(3, 3, 12, 0.55)';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = '#7df9ff';
  ctx.shadowBlur = 22;
  ctx.fillStyle = '#dffaff';
  ctx.font = 'bold 48px ' + FONT;
  ctx.fillText('PAUSED', W / 2, H * 0.42);
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#c6cbe0';
  ctx.font = '16px ' + FONT;
  ctx.fillText('P / ESC TO RESUME', W / 2, H * 0.42 + 52);
  ctx.restore();
}

function drawGameOver() {
  ctx.save();
  ctx.fillStyle = 'rgba(3, 3, 12, 0.6)';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = '#ff2d55';
  ctx.shadowBlur = 28;
  ctx.fillStyle = '#ffb3c2';
  ctx.font = 'bold 64px ' + FONT;
  ctx.fillText('GAME OVER', W / 2, H * 0.3);
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 26px ' + FONT;
  ctx.fillText('SCORE  ' + String(score).padStart(6, '0'), W / 2, H * 0.3 + 74);
  ctx.fillStyle = '#c6cbe0';
  ctx.font = '18px ' + FONT;
  ctx.fillText('WAVE REACHED  ' + wave, W / 2, H * 0.3 + 112);
  ctx.fillText('BEST  ' + String(best).padStart(6, '0'), W / 2, H * 0.3 + 142);
  if (newBest) {
    ctx.fillStyle = '#ffe14d';
    ctx.font = 'bold 20px ' + FONT;
    ctx.fillText('★ NEW BEST! ★', W / 2, H * 0.3 + 178);
  }
  const pulse = 0.65 + 0.35 * Math.sin(tGlobal * 3);
  ctx.globalAlpha = pulse;
  ctx.fillStyle = '#ffe14d';
  ctx.font = 'bold 22px ' + FONT;
  ctx.fillText('PRESS R OR CLICK TO RESTART', W / 2, H * 0.3 + 232);
  ctx.globalAlpha = 1;
  ctx.restore();
}

/* ---------------- main loop ---------------- */
let last = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.033, (now - last) / 1000);
  last = now;
  if (hitStop > 0) {
    // Hit-stop: freeze the world for a beat, but keep rendering.
    hitStop -= dt;
    render();
    return;
  }
  update(dt);
  render();
}

/* ---------------- boot ---------------- */
resize();
initStars();
requestAnimationFrame(loop);

/* ---------------- test hook ----------------
   Read-only state accessors + a few scenario helpers, used by the
   automated smoke test. Harmless in production: no UI, no cheats shown. */
window.__NV__ = {
  state: () => state,
  score: () => score,
  lives: () => lives,
  wave: () => wave,
  combo: () => combo,
  mult: () => mult,
  enemies: () => enemies.length,
  bullets: () => bullets.length,
  player: () => player,
  start: () => startGame(),
  hurt: () => { player.invuln = 0; playerHit(); },
  killAll: () => { for (const e of [...enemies]) killEnemy(e, true, true); },
  spawn: (t) => spawnEnemy(t || 'chaser'),
  bomb: () => detonateBomb(),
};
