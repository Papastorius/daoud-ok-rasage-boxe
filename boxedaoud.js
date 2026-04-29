import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

function log() {}
function logErr() {}

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
  scene.background = new THREE.Color(0xffdd00);  // cartoon yellow

  const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.01, 100);
  camera.position.set(0, 1.1, 3.8);

  log('Init renderer...');
  const renderer = new THREE.WebGPURenderer({ antialias: true });
  await renderer.init();
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);
  log('Renderer OK');

  // Cartoon lighting
  scene.add(new THREE.AmbientLight(0xffffff, 0.12));
  const sun = new THREE.DirectionalLight(0xfff5cc, 2.2);
  sun.position.set(4, 8, 6);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x88aaff, 0.5);
  fill.position.set(-4, 1, -3);
  scene.add(fill);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  const raycaster = new THREE.Raycaster();
  const ndc       = new THREE.Vector2();

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
        new THREE.MeshBasicMaterial({ color: 0x111111, side: THREE.BackSide })
      );
      outline.scale.setScalar(1.045);
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

      const rand    = new THREE.Vector3().randomDirection();
      const tangent = rand.sub(n.clone().multiplyScalar(rand.dot(n))).normalize();
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
  const WORDS  = ['POW!', 'BAM!', 'SMACK!', 'WHAM!', 'KA-POW!', 'BOUM!', 'CRACK!'];
  const COLORS = ['#FFE500', '#FF4400', '#00EEFF', '#FF00BB', '#44FF22', '#FF8800'];

  function makeOnomaSprite(word) {
    const col  = COLORS[Math.floor(Math.random() * COLORS.length)];
    const c    = document.createElement('canvas');
    c.width = 512; c.height = 256;
    const g    = c.getContext('2d');
    const size = Math.min(160, Math.floor(560 / word.length));
    g.font      = `bold ${size}px Impact, Arial Black, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineJoin  = 'round';
    g.strokeStyle = '#000'; g.lineWidth = 18; g.strokeText(word, 256, 128);
    g.fillStyle   = col;                      g.fillText(word, 256, 128);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, depthTest: false, transparent: true, toneMapped: false,
    }));
  }

  const onomaList = [];

  function spawnOnoma(pt, normal) {
    const word   = WORDS[Math.floor(Math.random() * WORDS.length)];
    const sprite = makeOnomaSprite(word);
    sprite.position.copy(pt)
      .addScaledVector(normal, 0.25 + Math.random() * 0.2)
      .add(new THREE.Vector3((Math.random() - 0.5) * 0.5, 0.15 + Math.random() * 0.25, 0));
    sprite.scale.set(0.01, 0.005, 1);
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
        o.sprite.material.map?.dispose();
        o.sprite.material.dispose();
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

    // Position recoil spring
    const rAcc = headRecoilPos.clone().multiplyScalar(-RECOIL_K)
                   .addScaledVector(headRecoilVel, -RECOIL_D);
    headRecoilVel.addScaledVector(rAcc, dt);
    headRecoilPos.addScaledVector(headRecoilVel, dt);
    headRoot.position.set(0, 0.55, -0.25).add(headRecoilPos);
  }

  // ====== RHYTHM ENGINE ======
  const BPM           = 100;                 // ← change to match your track
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

  function startRhythm() {
    if (rhythmOn) return;
    audioCtx = new AudioContext();
    nextBeatT = audioCtx.currentTime + 0.1;
    rhythmOn  = true;
    tapPrompt.style.display = 'none';
  }

  function scheduleClick(t) {
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
    const horizon = audioCtx.currentTime + LOOK_AHEAD + 0.15;
    while (nextBeatT < horizon) {
      scheduleClick(nextBeatT);
      beats.push({ time: nextBeatT, state: 'pending' });
      nextBeatT += BEAT_INTERVAL;
    }
  }

  // Beat ring (CSS overlay — reliable on all renderers)
  const beatRing = document.createElement('div');
  Object.assign(beatRing.style, {
    position: 'fixed', borderRadius: '50%',
    border: '5px solid #FFE500',
    boxShadow: '0 0 18px #FFE500',
    transform: 'translate(-50%, -50%)',
    pointerEvents: 'none', zIndex: '4000',
    opacity: '0', left: '50%', top: '44%',
  });
  document.body.appendChild(beatRing);

  function updateBeatRing() {
    if (!rhythmOn) return;
    const now  = audioCtx.currentTime;
    const next = beats.find(b => b.state === 'pending');
    if (!next) { beatRing.style.opacity = '0'; return; }

    const until = next.time - now;
    if (until > LOOK_AHEAD) { beatRing.style.opacity = '0'; return; }

    if (until < -(GOOD_WIN + 0.05)) {
      if (next.state === 'pending') {
        next.state = 'missed';
        breakCombo();
        showJudgment('MISS', '#ff2200');
      }
      beatRing.style.opacity = '0';
      return;
    }

    const t    = Math.max(0, 1 - until / LOOK_AHEAD);   // 0→1 as beat approaches
    const size = Math.round(220 - t * 160);              // 220px → 60px
    const hue  = until < 0.25 ? 20 : 50;               // shifts orange near beat
    beatRing.style.width   = size + 'px';
    beatRing.style.height  = size + 'px';
    beatRing.style.opacity = String(Math.min(1, t * 2));
    beatRing.style.borderColor = `hsl(${hue},100%,55%)`;
    beatRing.style.boxShadow   = `0 0 ${12 + t * 20}px hsl(${hue},100%,55%)`;
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

  renderer.domElement.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' && activeTouches.size >= 2) return;
    if (isPunching) punchAt(e.clientX, e.clientY);
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
  });

  // ====== LOOP ======
  let last = performance.now();
  function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(0.05, (performance.now() - last) / 1000);
    last = performance.now();

    controls.update();
    scheduleBeats();
    updateBeatRing();
    updateJudgment(dt);
    updateHeadSpring(dt);
    updateParticles(dt);
    updateDecals(dt);
    updateOnoma(dt);
    renderer.render(scene, camera);
  }
  animate();

})();
