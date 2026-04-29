import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

function log() {}
function logErr() {}

// Pre-fetch audio before user gesture (decoding happens later)
const SONG_PATH = './assets/DAOUD%20-%20ok%20-%2001%20-%20dijon__16b-44k-FR9W12517721.mp3';
let songArrayBuffer = null;
let hasSong = false;
fetch(SONG_PATH).then(r => r.arrayBuffer()).then(b => { songArrayBuffer = b; hasSong = true; }).catch(() => {});

(async function () {

  // ====== PARAMS ======
  const DECAL_RADIUS  = 0.18;
  const DECAL_TTL     = 5.0;
  const DECAL_FADE    = 1.0;
  const MAX_DECALS    = 256;

  const MAX_PARTS      = 400;
  const PARTS_PER_HIT  = 28;
  const PART_TTL       = 0.85;
  const PART_SPEED_MIN = 2.2;
  const PART_SPEED_MAX = 4.5;
  const PART_DRAG      = 0.87;
  const PART_GRAVITY   = new THREE.Vector3(0, -5.0, 0);

  // Spring squash & stretch
  const HEAD_BASE_SCALE = 7.0;
  let   headScaleCur    = HEAD_BASE_SCALE;
  let   headScaleVel    = 0.0;
  const SPRING_K        = 320;
  const SPRING_D        = 17;

  // Recoil position spring
  const headRecoilPos = new THREE.Vector3();
  const headRecoilVel = new THREE.Vector3();
  const RECOIL_K      = 260;
  const RECOIL_D      = 14;

  // ====== SCENE ======
  const scene = new THREE.Scene();
  // No scene.background — body CSS halftone shows through (alpha:true renderer)

  const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.01, 100);
  camera.position.set(0, 1.1, 3.8);

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const renderer = new THREE.WebGPURenderer({ antialias: true, alpha: true });
  await renderer.init();
  renderer.setPixelRatio(dpr);
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);
  renderer.domElement.style.cssText += 'touch-action:none;position:relative;z-index:2;';
  log('Renderer OK');

  // Cartoon lighting
  scene.add(new THREE.AmbientLight(0xffffff, 0.10));
  const sun = new THREE.DirectionalLight(0xfff5cc, 2.4);
  sun.position.set(4, 8, 6);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xaaccff, 0.45);
  fill.position.set(-4, 1, -3);
  scene.add(fill);
  // Rim light from behind — adds cartoon silhouette depth
  const rim = new THREE.DirectionalLight(0xff8800, 0.6);
  rim.position.set(0, -2, -6);
  scene.add(rim);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  const raycaster = new THREE.Raycaster();
  const ndc       = new THREE.Vector2();

  // Reusable temps — never allocate these inside hot loops
  const _v1        = new THREE.Vector3();
  const _v2        = new THREE.Vector3();
  const _headPos   = new THREE.Vector3();
  const _baseColor = new THREE.Color();
  const _white     = new THREE.Color(0xffffff);

  // ====== LOAD GLTF ======
  let faceMesh = null;
  let headRoot = null;

  // Iterative BFS — replaces all recursive traverse/getObjectByName to avoid stack overflow
  function findByName(root, name) {
    const q = [root];
    while (q.length) {
      const o = q.shift();
      if (o.name === name) return o;
      for (let i = 0; i < o.children.length; i++) q.push(o.children[i]);
    }
    return null;
  }

  function collectMeshes(root) {
    const meshes = [];
    const q = [root];
    while (q.length) {
      const o = q.shift();
      if (o.isMesh) meshes.push(o);
      for (let i = 0; i < o.children.length; i++) q.push(o.children[i]);
    }
    return meshes;
  }

  log('Loading GLB...');
  new GLTFLoader().load('./assets/head_expressions.glb', (gltf) => {
    log('GLB loaded');

    const headSrc = findByName(gltf.scene, 'soldier_head') ?? gltf.scene;
    log('headSrc: ' + headSrc.name);

    headRoot = new THREE.Group();
    headRoot.position.set(0, 0.55, -0.25);
    headRoot.scale.setScalar(HEAD_BASE_SCALE);
    scene.add(headRoot);
    headRoot.add(headSrc);

    const meshes = collectMeshes(headSrc);
    log('meshes found: ' + meshes.length);

    for (const n of meshes) {
      if (!faceMesh) faceMesh = n;

      const srcMat = Array.isArray(n.material) ? n.material[0] : n.material;
      n.material = new THREE.MeshToonMaterial({
        color: srcMat?.color?.clone() ?? new THREE.Color(0xe0b48a),
        map:   srcMat?.map   ?? null,
      });

      const outline = new THREE.Mesh(
        n.geometry,
        new THREE.MeshBasicMaterial({
          color: 0x111111, side: THREE.BackSide,
          polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
        })
      );
      outline.scale.setScalar(1.03);
      outline.renderOrder = -1;
      n.add(outline);
    }

    if (!faceMesh) { logErr('Aucun mesh trouvé'); return; }
    log('Head ready ✓');
    const wp = new THREE.Vector3();
    faceMesh.getWorldPosition(wp);
    controls.target.copy(wp);
    controls.update();
  }, null, (e) => logErr('GLTF: ' + e));

  // ====== DECAL TEXTURE (cartoon blood) ======
  function makeDecalTex(size = 256) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const cx = size / 2, r = size * 0.44;
    const gr = g.createRadialGradient(cx, cx, 0, cx, cx, r);
    gr.addColorStop(0.00, 'rgba(220,20,20,1)');
    gr.addColorStop(0.50, 'rgba(170, 8, 8,0.9)');
    gr.addColorStop(0.82, 'rgba( 90, 0, 0,0.5)');
    gr.addColorStop(1.00, 'rgba(  0, 0, 0,0)');
    g.fillStyle = gr;
    g.beginPath(); g.arc(cx, cx, r, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#300000'; g.lineWidth = 3;
    g.beginPath(); g.arc(cx, cx, r * 0.72, 0, Math.PI * 2); g.stroke();
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  const decalTex = makeDecalTex();

  // ====== DECALS ======
  const planeGeo = new THREE.PlaneGeometry(1, 1);
  const decals   = [];

  function spawnDecal(pt, normal) {
    const mat = new THREE.MeshBasicMaterial({
      map: decalTex, transparent: true, opacity: 1,
      depthTest: false, depthWrite: false,
      side: THREE.DoubleSide, toneMapped: false,
    });
    const m = new THREE.Mesh(planeGeo, mat);
    const n = normal.clone().normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    q.multiply(new THREE.Quaternion().setFromAxisAngle(n, Math.random() * Math.PI * 2));
    m.quaternion.copy(q);
    m.position.copy(pt).addScaledVector(n, 0.018);
    m.scale.setScalar(DECAL_RADIUS * 2);
    m.renderOrder = 2000;
    scene.add(m);
    decals.push({ mesh: m, ttl: DECAL_TTL });

    if (decals.length > MAX_DECALS) {
      const old = decals.shift();
      old.mesh.parent?.remove(old.mesh);
      old.mesh.material.dispose();
    }
  }

  function updateDecals(dt) {
    for (let i = decals.length - 1; i >= 0; i--) {
      const d = decals[i];
      d.ttl -= dt;
      d.mesh.material.opacity = Math.exp(-DECAL_FADE * (DECAL_TTL - Math.max(0, d.ttl)));
      if (d.ttl <= 0) {
        d.mesh.parent?.remove(d.mesh);
        d.mesh.material.dispose();
        decals.splice(i, 1);
      }
    }
  }

  // ====== STAR TEXTURE ======
  function makeStarTex() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.clearRect(0, 0, 64, 64);
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = (i * Math.PI / 5) - Math.PI / 2;
      const r = i % 2 === 0 ? 28 : 11;
      i === 0 ? g.moveTo(32 + r * Math.cos(a), 32 + r * Math.sin(a))
              : g.lineTo(32 + r * Math.cos(a), 32 + r * Math.sin(a));
    }
    g.closePath();
    g.fillStyle   = '#FFE500';
    g.strokeStyle = '#FF6600';
    g.lineWidth   = 3;
    g.fill(); g.stroke();
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  // ====== PARTICLES (stars via Sprites — InstancedMesh unreliable on WebGPU) ======
  const starTex    = makeStarTex();
  const starPool   = [];   // reusable sprites
  const activeParts = [];  // { sprite, vel, ttl }

  function getStarSprite() {
    if (starPool.length > 0) {
      const s = starPool.pop();
      s.material.opacity = 1;
      return s;
    }
    return new THREE.Sprite(new THREE.SpriteMaterial({
      map: starTex, depthTest: false, transparent: true, toneMapped: false,
    }));
  }

  function spawnParticles(pt, normal, count) {
    const n = normal.clone().normalize();
    for (let i = 0; i < count; i++) {
      const sprite = getStarSprite();
      sprite.position.copy(pt).addScaledVector(n, 0.05);
      sprite.scale.setScalar(0.2);
      sprite.renderOrder = 2500;
      scene.add(sprite);

      _v2.randomDirection();
      const dot     = _v2.dot(n);
      const tangent = _v2.sub(n.clone().multiplyScalar(dot)).normalize();
      const speed   = THREE.MathUtils.lerp(PART_SPEED_MIN, PART_SPEED_MAX, Math.random());
      const vel     = n.clone().multiplyScalar(speed * 0.45).addScaledVector(tangent, speed);

      activeParts.push({ sprite, vel, ttl: PART_TTL });
    }
  }

  function updateParticles(dt) {
    for (let i = activeParts.length - 1; i >= 0; i--) {
      const p = activeParts[i];
      p.vel.addScaledVector(PART_GRAVITY, dt);
      p.vel.multiplyScalar(Math.pow(PART_DRAG, dt * 60));
      p.sprite.position.addScaledVector(p.vel, dt);

      const life = p.ttl / PART_TTL;
      p.sprite.scale.setScalar(life * 0.2);
      p.sprite.material.opacity = life;
      p.ttl -= dt;

      if (p.ttl <= 0) {
        scene.remove(p.sprite);
        starPool.push(p.sprite);
        activeParts.splice(i, 1);
      }
    }
  }

  // ====== ONOMATOPOEIA ======
  // Pre-bake textures at startup: 256×128 canvas (4× less memory than 512×256)
  const WORD_PALETTE = {
    'POW!': '#FFE500', 'BAM!': '#FF4400', 'SMACK!': '#00EEFF',
    'WHAM!': '#FF00BB', 'KA-POW!': '#44FF22', 'BOUM!': '#FF8800', 'CRACK!': '#ffffff',
  };
  const WORDS = Object.keys(WORD_PALETTE);
  const onoma_mat = {};  // word → SpriteMaterial (shared, never recreated)
  for (const [word, col] of Object.entries(WORD_PALETTE)) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 128;
    const g = c.getContext('2d');
    const fs = Math.min(80, Math.floor(280 / word.length));
    g.font = `bold ${fs}px Impact, Arial Black, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.strokeStyle = '#000'; g.lineWidth = 10; g.strokeText(word, 128, 64);
    g.fillStyle = col;                        g.fillText(word, 128, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    onoma_mat[word] = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, toneMapped: false });
  }

  const onomaList = [];
  const onomaPool = [];  // recycled sprites

  function spawnOnoma(pt, normal) {
    const word   = WORDS[Math.floor(Math.random() * WORDS.length)];
    const sprite = onomaPool.length > 0 ? onomaPool.pop() : new THREE.Sprite();
    sprite.material = onoma_mat[word];

    _v1.set((Math.random() - 0.5) * 0.5, 0.15 + Math.random() * 0.25, 0);
    sprite.position.copy(pt).addScaledVector(normal, 0.25 + Math.random() * 0.2).add(_v1);
    sprite.scale.set(0.01, 0.005, 1);
    sprite.material.opacity = 1;
    sprite.renderOrder = 3000;
    scene.add(sprite);
    onomaList.push({ sprite, ttl: 0.85, maxTtl: 0.85 });
  }

  function updateOnoma(dt) {
    for (let i = onomaList.length - 1; i >= 0; i--) {
      const o    = onomaList[i];
      o.ttl     -= dt;
      const life = Math.max(0, o.ttl) / o.maxTtl;

      // Pop in quickly, hold, then fade out
      let sc;
      if (life > 0.65) {
        const t = 1 - (life - 0.65) / 0.35;
        sc = easeOutBack(t) * 0.85;
      } else {
        sc = 0.85;
        o.sprite.material.opacity = life / 0.65;
      }
      o.sprite.scale.set(sc, sc * 0.5, 1);

      if (o.ttl <= 0) {
        o.sprite.parent?.remove(o.sprite);
        if (onomaPool.length < 20) onomaPool.push(o.sprite);
        onomaList.splice(i, 1);
      }
    }
  }

  function easeOutBack(t) {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }

  // ====== SQUASH & STRETCH ======
  function triggerSquash(hitNormal) {
    headScaleVel = -22.0;
    headRecoilVel.copy(hitNormal).multiplyScalar(-0.35);
  }

  function updateHeadSpring(dt) {
    if (!headRoot) return;

    // Scale spring (uniform squash)
    const sAcc = (HEAD_BASE_SCALE - headScaleCur) * SPRING_K - headScaleVel * SPRING_D;
    headScaleVel += sAcc * dt;
    headScaleCur += headScaleVel * dt;
    headRoot.scale.setScalar(headScaleCur);

    // Position recoil spring (reuse _v1, no allocation)
    _v1.copy(headRecoilPos).multiplyScalar(-RECOIL_K).addScaledVector(headRecoilVel, -RECOIL_D);
    headRecoilVel.addScaledVector(_v1, dt);
    headRecoilPos.addScaledVector(headRecoilVel, dt);
    headRoot.position.set(0, 0.55, -0.25).add(headRecoilPos);
  }

  // ====== RHYTHM ENGINE ======
  const BPM           = 86;                  // DAOUD - ok
  const BEAT_OFFSET   = 0.0;                // ← delay (s) before 1st beat in song
  const BEAT_INTERVAL = 60 / BPM;
  const LOOK_AHEAD    = 0.9;                 // seconds: ring spawns this early
  const PERFECT_WIN   = 0.08;               // ±80 ms
  const GOOD_WIN      = 0.18;               // ±180 ms

  let audioCtx    = null;
  let nextBeatT   = 0;
  let rhythmOn    = false;
  let score       = 0;
  let combo       = 0;
  let maxCombo    = 0;
  const beats     = [];                      // {time, state:'pending'|'hit'|'missed'}

  async function startRhythm() {
    if (rhythmOn) return;
    rhythmOn = true;
    tapPrompt.style.display = 'none';
    audioCtx  = new AudioContext();
    nextBeatT = audioCtx.currentTime + 0.05;

    if (hasSong && songArrayBuffer) {
      try {
        const buffer = await audioCtx.decodeAudioData(songArrayBuffer);
        const src    = audioCtx.createBufferSource();
        src.buffer   = buffer;
        src.connect(audioCtx.destination);
        src.start(audioCtx.currentTime);
        nextBeatT = audioCtx.currentTime + BEAT_OFFSET;
      } catch (e) {
        hasSong = false;   // fallback to click metronome
      }
    }
  }

  // Click metronome — only used when no song loaded
  function scheduleClick(t) {
    if (hasSong) return;
    const osc  = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.frequency.value = 900;
    gain.gain.setValueAtTime(0.12, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
    osc.start(t); osc.stop(t + 0.04);
  }

  function scheduleBeats() {
    if (!rhythmOn) return;
    const now     = audioCtx.currentTime;
    const horizon = now + LOOK_AHEAD + 0.15;

    // Purge beats older than 3 seconds to prevent array growing unbounded
    let cut = 0;
    while (cut < beats.length && beats[cut].time < now - 3) cut++;
    if (cut > 0) beats.splice(0, cut);

    while (nextBeatT < horizon) {
      scheduleClick(nextBeatT);
      beats.push({ time: nextBeatT, state: 'pending' });
      nextBeatT += BEAT_INTERVAL;
    }
  }

  // Beat ring — canvas overlay (zero DOM reflow, one draw call per frame)
  const ringCv  = document.createElement('canvas');
  ringCv.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:4000;';
  ringCv.width  = Math.round(innerWidth  * dpr);
  ringCv.height = Math.round(innerHeight * dpr);
  document.body.appendChild(ringCv);
  const ringCtx = ringCv.getContext('2d');

  function updateBeatRing() {
    ringCtx.clearRect(0, 0, ringCv.width, ringCv.height);
    if (!rhythmOn) return;
    const now  = audioCtx.currentTime;
    const next = beats.find(b => b.state === 'pending');
    if (!next) return;

    const until = next.time - now;
    if (until > LOOK_AHEAD) return;

    if (until < -(GOOD_WIN + 0.05)) {
      if (next.state === 'pending') {
        next.state = 'missed';
        breakCombo();
        showJudgment('MISS', '#ff2200');
      }
      return;
    }

    const t      = Math.max(0, 1 - until / LOOK_AHEAD);
    const radius = (110 - t * 80) * dpr;                 // 110→30 logical px
    const hue    = until < 0.25 ? 20 : 50;
    const alpha  = Math.min(1, t * 2);
    const glow   = (12 + t * 20) * dpr;
    const color  = `hsl(${hue},100%,55%)`;
    const cx     = ringCv.width  * 0.5;
    const cy     = ringCv.height * 0.44;

    ringCtx.save();
    ringCtx.globalAlpha = alpha;
    ringCtx.strokeStyle = color;
    ringCtx.lineWidth   = 5 * dpr;
    ringCtx.shadowBlur  = glow;
    ringCtx.shadowColor = color;
    ringCtx.beginPath();
    ringCtx.arc(cx, cy, radius, 0, Math.PI * 2);
    ringCtx.stroke();
    ringCtx.restore();
  }

  // Judgment
  const judgEl = document.createElement('div');
  Object.assign(judgEl.style, {
    position: 'fixed', left: '50%', top: '30%',
    transform: 'translate(-50%,-50%)',
    fontFamily: 'Impact, Arial Black, sans-serif',
    fontSize: '54px', letterSpacing: '4px',
    textShadow: '3px 3px 0 #000',
    pointerEvents: 'none', zIndex: '6000', opacity: '0',
  });
  document.body.appendChild(judgEl);
  let judgTimer = 0;

  function showJudgment(text, color) {
    judgEl.textContent = text;
    judgEl.style.color  = color;
    judgEl.style.opacity = '1';
    judgTimer = 0.55;
  }
  function updateJudgment(dt) {
    if (judgTimer <= 0) { judgEl.style.opacity = '0'; return; }
    judgTimer -= dt;
    judgEl.style.opacity = String(Math.min(1, judgTimer / 0.15));
  }

  function breakCombo() {
    if (combo >= 4) triggerDazed();
    combo = 0;
    updateScoreHUD();
  }

  function judgeHit() {
    if (!rhythmOn) return;
    const now = audioCtx.currentTime;
    let   best = null, bestDist = Infinity;
    for (const b of beats) {
      if (b.state !== 'pending') continue;
      const d = Math.abs(b.time - now);
      if (d < bestDist) { bestDist = d; best = b; }
    }
    if (!best || bestDist > GOOD_WIN) { breakCombo(); showJudgment('MISS', '#ff2200'); return; }
    best.state = 'hit';
    combo++;
    maxCombo = Math.max(maxCombo, combo);
    const mult = Math.min(combo, 4);
    if (bestDist <= PERFECT_WIN) {
      score += 300 * mult;
      showJudgment('PERFECT!', '#FFE500');
    } else {
      score += 100 * mult;
      showJudgment('GOOD!', '#ffffff');
    }
    updateScoreHUD();
  }

  // ====== PHASE 3: BEAT REACTIONS + ORBITAL STARS ======

  // Camera FOV spring (pulses on beat)
  let camFOVCur = 70, camFOVVel = 0;
  let camTargetFOV = 70;      // updated by cinematic shot selector
  let lastBeatVizT = -999;

  function updateBeatReactions(dt) {
    if (!rhythmOn) return;
    const now = audioCtx.currentTime;

    // Detect beat crossing → kick camera + background
    for (const b of beats) {
      if (b.time <= now + 0.02 && b.time > lastBeatVizT) {
        lastBeatVizT = b.time;
        camFOVVel = -10;
      }
    }

    // FOV spring — targets shot FOV in auto mode, 70 in manual
    const fovAcc = ((autoMode ? camTargetFOV : 70) - camFOVCur) * 250 - camFOVVel * 16;
    camFOVVel += fovAcc * dt;
    camFOVCur += camFOVVel * dt;
    camera.fov = camFOVCur;
    camera.updateProjectionMatrix();

    // Flash overlay — white pulse on every beat
    const sinceBeat = now - lastBeatVizT;
    const flash     = Math.max(0, 1 - sinceBeat / 0.12);
    flashEl.style.opacity = (flash * 0.32).toFixed(3);

    // Body background shifts warmer as combo rises (only when tier changes)
    const tier = combo >= 12 ? 3 : combo >= 8 ? 2 : combo >= 4 ? 1 : 0;
    if (tier !== _lastComboTier) {
      _lastComboTier = tier;
      document.body.style.backgroundColor =
        ['#ffe94e', '#ffcc00', '#ffaa00', '#ff7700'][tier];
    }
  }

  // Orbital dazed stars
  const orbitalStars = [];
  let   dazedUntil   = -1;

  function triggerDazed() {
    dazedUntil = rhythmOn ? audioCtx.currentTime + 2.0 : performance.now() / 1000 + 2.0;
    for (let i = 0; i < 4; i++) {
      const sp = getStarSprite();
      sp.scale.setScalar(0.14);
      sp.renderOrder = 2500;
      scene.add(sp);
      orbitalStars.push({ sprite: sp, angle: (i / 4) * Math.PI * 2 });
    }
  }

  function updateOrbitalStars(dt) {
    const now  = rhythmOn ? audioCtx.currentTime : performance.now() / 1000;
    const done = now >= dazedUntil;

    if (done && orbitalStars.length > 0) {
      for (const s of orbitalStars) { scene.remove(s.sprite); starPool.push(s.sprite); }
      orbitalStars.length = 0;
      return;
    }

    if (!headRoot || orbitalStars.length === 0) return;
    headRoot.getWorldPosition(_headPos);

    for (const s of orbitalStars) {
      s.angle += dt * 3.5;
      s.sprite.position.set(
        _headPos.x + Math.cos(s.angle) * 0.55,
        _headPos.y + 0.35 + Math.sin(s.angle * 1.3) * 0.12,
        _headPos.z + Math.sin(s.angle) * 0.25,
      );
    }
  }

  // ====== PHASE 4: AUTO MODE + INTRO + POLISH ======

  // --- Random surface point on faceMesh ---
  function randomFacePoint() {
    if (!faceMesh) return null;
    faceMesh.updateWorldMatrix(true, false);
    const pos  = faceMesh.geometry.attributes.position;
    const norm = faceMesh.geometry.attributes.normal;
    const idx  = Math.floor(Math.random() * pos.count);
    const p    = new THREE.Vector3(pos.getX(idx),  pos.getY(idx),  pos.getZ(idx));
    const n    = new THREE.Vector3(norm.getX(idx), norm.getY(idx), norm.getZ(idx));
    p.applyMatrix4(faceMesh.matrixWorld);
    n.transformDirection(faceMesh.matrixWorld).normalize();
    return { point: p, normal: n };
  }

  // --- Auto mode state ---
  let autoMode     = false;
  let autoCamAngle = 0;

  // ---- Cinematic shot sequencer ----
  // Each shot: { dist, yOff, angleSpeed, fov, beats }
  // angleSpeed=0 → camera parks at current angle (slow drift only)
  const CINEMATIC_SHOTS = [
    { dist: 3.6, yOff:  0.25, angleSpeed: 0.18, fov: 70, beats: 8  }, // orbit
    { dist: 1.7, yOff:  0.05, angleSpeed: 0.06, fov: 52, beats: 4  }, // closeup
    { dist: 3.0, yOff: -0.18, angleSpeed: 0.02, fov: 66, beats: 6  }, // side / parked
    { dist: 2.4, yOff: -0.55, angleSpeed: 0.10, fov: 84, beats: 4  }, // low angle
    { dist: 5.0, yOff:  0.65, angleSpeed: 0.14, fov: 58, beats: 4  }, // pull-back
  ];
  let camShotIdx       = 0;
  let camShotBeatsLeft = CINEMATIC_SHOTS[0].beats;
  const camWantPos     = new THREE.Vector3();

  function autoFirePunch() {
    const r = randomFacePoint();
    if (!r) return;
    const { point, normal } = r;
    spawnDecal(point, normal);
    spawnParticles(point, normal, PARTS_PER_HIT);
    spawnOnoma(point, normal);
    triggerSquash(normal);
    camera.position.add(new THREE.Vector3(
      (Math.random() - 0.5) * 0.07,
      (Math.random() - 0.5) * 0.04,
      (Math.random() - 0.5) * 0.04,
    ));
    if (navigator.vibrate) navigator.vibrate(18);
    combo++;
    maxCombo = Math.max(maxCombo, combo);
    score += 300 * Math.min(combo, 4);
    showJudgment('PERFECT!', '#FFE500');
    updateScoreHUD();
  }

  function processAutoPunches() {
    if (!autoMode || !rhythmOn || !faceMesh) return;
    const now = audioCtx.currentTime;
    for (const b of beats) {
      if (!b.autoDone && Math.abs(b.time - now) < 0.055) {
        b.autoDone = true;
        b.state    = 'hit';
        if (Math.random() < 0.88) autoFirePunch();  // 88% of beats get a punch
      }
    }
  }

  function updateAutoCamera(dt) {
    if (!autoMode || !controls.target) return;
    const t = controls.target;

    // Advance shot counter on each beat
    if (rhythmOn) {
      const now = audioCtx.currentTime;
      for (const b of beats) {
        if (!b.camDone && b.time <= now + 0.04) {
          b.camDone = true;
          camShotBeatsLeft--;
          if (camShotBeatsLeft <= 0) {
            camShotIdx = (camShotIdx + 1) % CINEMATIC_SHOTS.length;
            camShotBeatsLeft = CINEMATIC_SHOTS[camShotIdx].beats;
          }
        }
      }
    }

    const shot = CINEMATIC_SHOTS[camShotIdx];
    camTargetFOV = shot.fov;
    autoCamAngle += dt * shot.angleSpeed;

    // Breathe: subtle sinusoidal distance variation
    const r = shot.dist + Math.sin(autoCamAngle * 0.4) * 0.18;
    camWantPos.set(
      t.x + Math.sin(autoCamAngle) * r,
      t.y + shot.yOff + Math.sin(autoCamAngle * 0.5) * 0.1,
      t.z + Math.cos(autoCamAngle) * r,
    );

    // Lerp toward target — fast on first frame of new shot (8×dt), cruising (3×dt)
    const lerpK = camShotBeatsLeft === shot.beats ? 8 : 3;
    camera.position.lerp(camWantPos, Math.min(1, dt * lerpK));
    camera.lookAt(t);
  }

  // --- Mode toggle button ---
  const modeBtn = document.createElement('button');
  Object.assign(modeBtn.style, {
    position: 'fixed', bottom: '3vh', right: '3vw',
    fontFamily: 'Impact, Arial Black, sans-serif',
    fontSize: '14px', letterSpacing: '2px',
    color: '#FFE500', background: '#111',
    border: '3px solid #FFE500', borderRadius: '3px',
    padding: '7px 14px', cursor: 'pointer', zIndex: '5000',
  });
  modeBtn.textContent = 'AUTO';
  modeBtn.addEventListener('click', () => {
    autoMode = !autoMode;
    modeBtn.textContent      = autoMode ? 'MANUEL' : 'AUTO';
    modeBtn.style.background = autoMode ? '#FFE500' : '#111';
    modeBtn.style.color      = autoMode ? '#111'    : '#FFE500';
    controls.enabled         = !autoMode;
    if (autoMode && !rhythmOn) startRhythm();
  });
  document.body.appendChild(modeBtn);

  // --- Cinema button (hides HUD for filming) ---
  let cinemaMode = false;
  const cinemaBtn = document.createElement('button');
  Object.assign(cinemaBtn.style, {
    position: 'fixed', bottom: '3vh', left: '3vw',
    fontFamily: 'Impact, Arial Black, sans-serif',
    fontSize: '14px', letterSpacing: '2px',
    color: '#FFE500', background: '#111',
    border: '3px solid #FFE500', borderRadius: '3px',
    padding: '7px 14px', cursor: 'pointer', zIndex: '5000',
  });
  cinemaBtn.textContent = 'FILM';
  cinemaBtn.addEventListener('click', () => {
    cinemaMode = !cinemaMode;
    // Elements to hide when filming
    const hudEls = [scoreEl, comboEl, tapPrompt, judgEl, ringCv];
    for (const el of hudEls) el.style.visibility = cinemaMode ? 'hidden' : '';
    cinemaBtn.textContent      = cinemaMode ? 'HUD' : 'FILM';
    cinemaBtn.style.background = cinemaMode ? '#FFE500' : '#111';
    cinemaBtn.style.color      = cinemaMode ? '#111'    : '#FFE500';
  });
  document.body.appendChild(cinemaBtn);

  // --- Intro screen ---
  const introEl = document.createElement('div');
  Object.assign(introEl.style, {
    position: 'fixed', inset: '0',
    background: '#000',
    display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center',
    zIndex: '9999', transition: 'opacity 1.2s',
    pointerEvents: 'none',
  });
  introEl.innerHTML = `
    <div style="font-family:Impact,Arial Black,sans-serif;color:#FFE500;
                font-size:56px;letter-spacing:10px;text-shadow:0 0 40px #FFE500">DAOUD</div>
    <div style="font-family:Impact,Arial Black,sans-serif;color:#fff;
                font-size:24px;letter-spacing:6px;margin-top:6px">OK</div>
    <div style="font-family:Arial,sans-serif;color:#555;
                font-size:13px;margin-top:48px;letter-spacing:3px">TAP TO START</div>
  `;
  document.body.appendChild(introEl);
  // Fade out on first interaction
  renderer.domElement.addEventListener('pointerdown', () => {
    introEl.style.opacity = '0';
    setTimeout(() => introEl.remove(), 1300);
  }, { once: true });

  // ====== CSS OVERLAYS ======
  // White flash on beat (above 3D canvas, below ring/HUD)
  const flashEl = document.createElement('div');
  Object.assign(flashEl.style, {
    position: 'fixed', inset: '0',
    background: '#fff', opacity: '0',
    pointerEvents: 'none', zIndex: '3',
  });
  document.body.appendChild(flashEl);

  // Vignette — dark radial gradient for focus/depth
  const vignetteEl = document.createElement('div');
  Object.assign(vignetteEl.style, {
    position: 'fixed', inset: '0',
    background: 'radial-gradient(ellipse at center, transparent 38%, rgba(0,0,0,0.52) 100%)',
    pointerEvents: 'none', zIndex: '3',
  });
  document.body.appendChild(vignetteEl);

  let _lastComboTier = -1;

  // ====== HUD ======
  const css = `
    position:fixed; font-family:Impact,Arial Black,sans-serif;
    color:#FFE500; text-shadow:2px 2px 0 #000; user-select:none;
    background:#111; border:3px solid #FFE500; border-radius:3px; padding:4px 12px;
  `;
  const scoreEl = document.createElement('div');
  scoreEl.style.cssText = css + 'top:2vh; left:2vw; font-size:22px;';
  scoreEl.textContent = 'SCORE: 0';
  document.body.appendChild(scoreEl);

  const comboEl = document.createElement('div');
  comboEl.style.cssText = css + 'top:2vh; right:2vw; font-size:22px;';
  comboEl.textContent = 'COMBO: 0';
  document.body.appendChild(comboEl);

  const tapPrompt = document.createElement('div');
  Object.assign(tapPrompt.style, {
    position: 'fixed', bottom: '6vh', left: '50%',
    transform: 'translateX(-50%)',
    fontFamily: 'Impact, Arial Black, sans-serif',
    fontSize: '20px', color: '#111',
    background: '#FFE500', border: '3px solid #111',
    padding: '8px 20px', borderRadius: '3px',
    pointerEvents: 'none', zIndex: '5000',
    animation: 'pulse 0.6s ease-in-out infinite alternate',
  });
  tapPrompt.textContent = '👊 TAPE LA TÊTE POUR COMMENCER';
  document.body.appendChild(tapPrompt);

  // Pulse animation
  const style = document.createElement('style');
  style.textContent = '@keyframes pulse { from{opacity:1} to{opacity:0.4} }';
  document.head.appendChild(style);

  function updateScoreHUD() {
    scoreEl.textContent = `SCORE: ${score}`;
    comboEl.textContent = combo > 1 ? `x${combo} COMBO` : 'COMBO: 0';
    if (combo > 1) comboEl.style.color = combo >= 8 ? '#ff4400' : '#FFE500';
  }

  // ====== PUNCH ======
  function punchAt(clientX, clientY) {
    if (!faceMesh) return;
    startRhythm();   // starts on first punch (user gesture → AudioContext allowed)

    ndc.x = (clientX / innerWidth)  *  2 - 1;
    ndc.y = (clientY / innerHeight) * -2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(faceMesh, true)[0];
    if (!hit) return;

    const n = hit.face
      ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize()
      : new THREE.Vector3(0, 0, 1);

    judgeHit();
    spawnDecal(hit.point, n);
    spawnParticles(hit.point, n, PARTS_PER_HIT);
    spawnOnoma(hit.point, n);
    triggerSquash(n);

    camera.position.add(new THREE.Vector3(
      (Math.random() - 0.5) * 0.07,
      (Math.random() - 0.5) * 0.04,
      (Math.random() - 0.5) * 0.04,
    ));
    if (navigator.vibrate) navigator.vibrate(18);
  }

  // ====== INPUT ======
  let isPunching = false;
  const activeTouches = new Map();

  function tryHit(clientX, clientY) {
    ndc.x = (clientX / innerWidth)  *  2 - 1;
    ndc.y = (clientY / innerHeight) * -2 + 1;
    raycaster.setFromCamera(ndc, camera);
    return faceMesh ? raycaster.intersectObject(faceMesh, true).length > 0 : false;
  }

  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') {
      activeTouches.set(e.pointerId, true);
      if (activeTouches.size >= 2) { isPunching = false; controls.enabled = true; return; }
    } else {
      renderer.domElement.setPointerCapture(e.pointerId);
    }
    if (tryHit(e.clientX, e.clientY)) {
      isPunching = true; controls.enabled = false; punchAt(e.clientX, e.clientY);
    } else {
      isPunching = false; controls.enabled = true;
    }
  });

  let _lastMoveFrame = 0;
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' && activeTouches.size >= 2) return;
    if (!isPunching) return;
    // Throttle: at most one raycast per ~3 rendered frames (~50ms) on mobile
    const frame = Math.floor(performance.now() / 50);
    if (frame === _lastMoveFrame) return;
    _lastMoveFrame = frame;
    punchAt(e.clientX, e.clientY);
  });

  function endPointer(e) {
    if (e.pointerType === 'touch') {
      activeTouches.delete(e.pointerId);
      if (activeTouches.size === 0) { isPunching = false; controls.enabled = true; }
    } else {
      isPunching = false; controls.enabled = true;
      renderer.domElement.releasePointerCapture(e.pointerId);
    }
  }
  renderer.domElement.addEventListener('pointerup',     endPointer);
  renderer.domElement.addEventListener('pointercancel', endPointer);
  renderer.domElement.addEventListener('pointerleave',  endPointer);

  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    ringCv.width  = Math.round(innerWidth  * dpr);
    ringCv.height = Math.round(innerHeight * dpr);
  });

  // ====== LOOP ======
  let last = performance.now();
  function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(0.05, (performance.now() - last) / 1000);
    last = performance.now();

    controls.update();
    scheduleBeats();
    processAutoPunches();
    updateBeatRing();
    updateBeatReactions(dt);
    updateJudgment(dt);
    updateHeadSpring(dt);
    updateParticles(dt);
    updateOrbitalStars(dt);
    updateDecals(dt);
    updateOnoma(dt);
    updateAutoCamera(dt);
    renderer.render(scene, camera);
  }
  animate();

})();
