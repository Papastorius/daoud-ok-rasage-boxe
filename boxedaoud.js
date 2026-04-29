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

  // ====== PARTICLES (stars) ======
  const partGeo  = new THREE.PlaneGeometry(0.09, 0.09);
  const partMat  = new THREE.MeshBasicMaterial({
    map: makeStarTex(), transparent: true, opacity: 1,
    depthWrite: false, side: THREE.DoubleSide, alphaTest: 0.05, toneMapped: false,
  });
  const zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
  const partMesh   = new THREE.InstancedMesh(partGeo, partMat, MAX_PARTS);
  partMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < MAX_PARTS; i++) partMesh.setMatrixAt(i, zeroMatrix);
  partMesh.instanceMatrix.needsUpdate = true;
  scene.add(partMesh);

  const pPos    = Array.from({ length: MAX_PARTS }, () => new THREE.Vector3());
  const pVel    = Array.from({ length: MAX_PARTS }, () => new THREE.Vector3());
  const pSpin   = new Float32Array(MAX_PARTS);
  const pTTL    = new Float32Array(MAX_PARTS);
  let   pCursor = 0;

  function spawnParticles(pt, normal, count) {
    const n = normal.clone().normalize();
    for (let i = 0; i < count; i++) {
      const idx = pCursor++ % MAX_PARTS;
      pPos[idx].copy(pt).addScaledVector(n, 0.02);
      const rand    = new THREE.Vector3().randomDirection();
      const tangent = rand.sub(n.clone().multiplyScalar(rand.dot(n))).normalize();
      const speed   = THREE.MathUtils.lerp(PART_SPEED_MIN, PART_SPEED_MAX, Math.random());
      pVel[idx].copy(n).multiplyScalar(speed * 0.45).addScaledVector(tangent, speed);
      pSpin[idx] = Math.random() * Math.PI * 2;
      pTTL[idx]  = PART_TTL;
    }
  }

  function updateParticles(dt) {
    const m    = new THREE.Matrix4();
    const q    = new THREE.Quaternion();
    const Z    = new THREE.Vector3(0, 0, 1);
    const toCam = new THREE.Vector3();

    for (let i = 0; i < MAX_PARTS; i++) {
      if (pTTL[i] <= 0) { partMesh.setMatrixAt(i, zeroMatrix); continue; }

      pVel[i].addScaledVector(PART_GRAVITY, dt);
      pVel[i].multiplyScalar(Math.pow(PART_DRAG, dt * 60));
      pPos[i].addScaledVector(pVel[i], dt);
      pSpin[i] += dt * 10;

      toCam.copy(camera.position).sub(pPos[i]).normalize();
      q.setFromUnitVectors(Z, toCam);
      q.multiply(new THREE.Quaternion().setFromAxisAngle(toCam, pSpin[i]));

      const life = pTTL[i] / PART_TTL;
      const sc   = life * 0.09;
      m.compose(pPos[i], q, new THREE.Vector3(sc, sc, sc));
      partMesh.setMatrixAt(i, m);
      pTTL[i] -= dt;
    }
    partMesh.instanceMatrix.needsUpdate = true;
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

  // ====== HUD ======
  let hitsCount = 0;
  const hud = document.createElement('div');
  Object.assign(hud.style, {
    position: 'fixed', left: '50%', top: '2vh',
    transform: 'translateX(-50%)',
    padding: '6px 18px',
    background: '#111',
    color: '#FFE500',
    fontFamily: 'Impact, Arial Black, sans-serif',
    fontSize: '26px',
    border: '4px solid #FFE500',
    borderRadius: '3px',
    userSelect: 'none',
    letterSpacing: '3px',
    textShadow: '2px 2px 0 #000',
  });
  hud.textContent = 'COUPS: 0';
  document.body.appendChild(hud);

  // ====== PUNCH ======
  function punchAt(clientX, clientY) {
    if (!faceMesh) return;
    ndc.x = (clientX / innerWidth)  *  2 - 1;
    ndc.y = (clientY / innerHeight) * -2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(faceMesh, true)[0];
    if (!hit) return;

    const n = hit.face
      ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize()
      : new THREE.Vector3(0, 0, 1);

    spawnDecal(hit.point, n);
    spawnParticles(hit.point, n, PARTS_PER_HIT);
    spawnOnoma(hit.point, n);
    triggerSquash(n);

    // Camera shake
    camera.position.add(new THREE.Vector3(
      (Math.random() - 0.5) * 0.07,
      (Math.random() - 0.5) * 0.04,
      (Math.random() - 0.5) * 0.04,
    ));
    if (navigator.vibrate) navigator.vibrate(18);

    hitsCount++;
    hud.textContent = `COUPS: ${hitsCount}`;
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
    updateHeadSpring(dt);
    updateParticles(dt);
    updateDecals(dt);
    updateOnoma(dt);
    renderer.render(scene, camera);
  }
  animate();

})();
