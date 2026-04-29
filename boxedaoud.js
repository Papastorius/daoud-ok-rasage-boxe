import * as THREE from '../build/three.webgpu.js';
import { OrbitControls } from '../build/addons/OrbitControls.js';
import { GLTFLoader } from '../build/addons/GLTFLoader.js';

(async function () {
  // ====== PARAMS ======
  const DECAL_RADIUS_WORLD = 0.12; // m
  const DECAL_TTL = 6.0;           // s
  const DECAL_FADE = 0.9;          // e^{-DECAL_FADE * t}
  const MAX_DECALS = 512;

  const MAX_PARTS = 600;
  const PARTS_PER_HIT = 40;
  const PART_TTL = 0.9;
  const PART_SPEED_MIN = 1.2;
  const PART_SPEED_MAX = 2.4;
  const PART_DRAG = 0.90;
  const PART_GRAVITY = new THREE.Vector3(0, -2.0, 0);

  const DEBUG_HITS = true;   // <-- mets false pour couper le marqueur

  // ====== SCÈNE / CAM / RDR ======
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf4f8ff);

  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 100);
  camera.position.set(0, 1.1, 3.8);

  const renderer = new THREE.WebGPURenderer({ antialias: true });
  await renderer.init();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.body.appendChild(renderer.domElement);

  scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(4, 8, 6);
  scene.add(dir);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  // ====== VISAGE (soldier_head seulement) ======
  let faceMesh = null;
  let headRoot = null;
  const loader = new GLTFLoader();

  loader.load(
    '../assets/head_expressions.glb',
    (gltf) => {
      const headSrc = gltf.scene.getObjectByName('soldier_head');
      if (!headSrc) { console.error('soldier_head introuvable'); return; }

      headRoot = new THREE.Group();
      headRoot.position.set(0, 0.55, -0.25);
      headRoot.scale.set(7, 7, 7);
      scene.add(headRoot);

      const headClone = headSrc.clone(true);
      headRoot.add(headClone);

      headClone.traverse(n => { if (n.isMesh && !faceMesh) faceMesh = n; });
      if (!faceMesh) { console.error('Aucun mesh dans soldier_head'); return; }

      const worldPos = new THREE.Vector3();
      faceMesh.getWorldPosition(worldPos);
      controls.target.copy(worldPos);
      controls.update();

      console.log('soldier_head isolé prêt');
    },
    (xhr) => console.log(`Chargement GLTF : ${(xhr.loaded / xhr.total * 100).toFixed(1)}%`),
    (err) => console.error('Erreur GLTF :', err)
  );

  // ====== TEXTURE DÉCAL ======
  function makeDecalTexture(size = 256) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');

    g.clearRect(0, 0, size, size);
    const cx = size * 0.5, cy = size * 0.5, r = size * 0.5;
    const grd = g.createRadialGradient(cx, cy, 0, cx, cy, r);
    grd.addColorStop(0.00, 'rgba(210,30,30,0.96)');
    grd.addColorStop(0.35, 'rgba(180,20,20,0.82)');
    grd.addColorStop(0.70, 'rgba(120,10,10,0.45)');
    grd.addColorStop(1.00, 'rgba(0,0,0,0.00)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }
  const decalTexture = makeDecalTexture();

  // ====== DÉCALS WORLD-SPACE ======
  const planeGeo = new THREE.PlaneGeometry(1, 1); // normal +Z
  function makeDecalMaterial() {
    return new THREE.MeshBasicMaterial({
      map: decalTexture,
      transparent: true,
      opacity: 1.0,
      // 🔒 Toujours visible :
      depthTest: false,       // <— clé anti-“caché”
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      toneMapped: false
    });
  }

  const decals = []; // {mesh, ttl, baseOpacity}
  function spawnDecal(worldPoint, worldNormal, radius = DECAL_RADIUS_WORLD) {
    if (!headRoot) return;

    const mat = makeDecalMaterial();
    const m = new THREE.Mesh(planeGeo, mat);

    // +Z → normale
    const z = new THREE.Vector3(0, 0, 1);
    const n = worldNormal.clone().normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(z, n);
    // rotation aléatoire autour de la normale
    const qSpin = new THREE.Quaternion().setFromAxisAngle(n, Math.random() * Math.PI * 2);
    q.multiply(qSpin);
    m.quaternion.copy(q);

    // Offset fort pour qu’il soit décollé de la peau
    const safeOffset = Math.max(0.001, radius * 0.5);
    m.position.copy(worldPoint).addScaledVector(n, safeOffset);

    m.scale.setScalar(radius * 2);
    m.renderOrder = 2000; // très après

    headRoot.add(m);
    decals.push({ mesh: m, ttl: DECAL_TTL, baseOpacity: 1.0 });

    if (decals.length > MAX_DECALS) {
      const old = decals.shift();
      old.mesh.parent?.remove(old.mesh);
      old.mesh.geometry?.dispose();
      old.mesh.material?.dispose?.();
    }
  }

  function updateDecals(dt) {
    for (let i = decals.length - 1; i >= 0; i--) {
      const d = decals[i];
      d.ttl -= dt;
      const t = Math.max(0, d.ttl);
      const alpha = Math.exp(-DECAL_FADE * (DECAL_TTL - t));
      d.mesh.material.opacity = d.baseOpacity * alpha;

      if (t <= 0) {
        d.mesh.parent?.remove(d.mesh);
        decals.splice(i, 1);
        d.mesh.geometry?.dispose();
        d.mesh.material?.dispose?.();
      }
    }
  }

  // ====== PARTICULES (billboard) ======
  const partGeom = new THREE.PlaneGeometry(0.06, 0.06);
  const partMat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    side: THREE.FrontSide,
    alphaTest: 0.02,
    toneMapped: false
  });
  const partMesh = new THREE.InstancedMesh(partGeom, partMat, MAX_PARTS);
  partMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(partMesh);

  const pPos = Array(MAX_PARTS).fill(0).map(() => new THREE.Vector3());
  const pVel = Array(MAX_PARTS).fill(0).map(() => new THREE.Vector3());
  const pSpin = new Float32Array(MAX_PARTS).fill(0);
  const pTTL  = new Float32Array(MAX_PARTS).fill(0);
  let pCursor = 0;

  function spawnImpactParticles(point, normal, count) {
    const n = normal ? normal.clone().normalize() : new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < count; i++) {
      const idx = pCursor++ % MAX_PARTS;
      pPos[idx].copy(point).addScaledVector(n, 0.01);
      const randDir = new THREE.Vector3().randomDirection();
      const tangent = randDir.sub(n.clone().multiplyScalar(randDir.dot(n))).normalize();
      const speed = THREE.MathUtils.lerp(PART_SPEED_MIN, PART_SPEED_MAX, Math.random());
      pVel[idx].copy(n).multiplyScalar(speed * 0.6).addScaledVector(tangent, speed * 0.8);
      pSpin[idx] = Math.random() * Math.PI * 2;
      pTTL[idx] = PART_TTL;
    }
  }

  function updateParticles(dt) {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const qBill = new THREE.Quaternion();
    const qSpin = new THREE.Quaternion();
    const toCam = new THREE.Vector3();
    const Z = new THREE.Vector3(0, 0, 1);

    let anyAlive = false;

    for (let i = 0; i < MAX_PARTS; i++) {
      if (pTTL[i] <= 0) continue;
      anyAlive = true;

      pVel[i].addScaledVector(PART_GRAVITY, dt);
      pVel[i].multiplyScalar(Math.pow(PART_DRAG, dt * 60));
      pPos[i].addScaledVector(pVel[i], dt);

      toCam.copy(camera.position).sub(pPos[i]).normalize();
      qBill.setFromUnitVectors(Z, toCam);
      pSpin[i] += dt * 8.0;
      qSpin.setFromAxisAngle(toCam, pSpin[i]);
      q.multiplyQuaternions(qBill, qSpin);

      m.compose(pPos[i], q, new THREE.Vector3(1, 1, 1));
      partMesh.setMatrixAt(i, m);

      pTTL[i] -= dt;
    }
    if (anyAlive) partMesh.instanceMatrix.needsUpdate = true;
    partMat.opacity = 0.25 + 0.7 * (anyAlive ? 1 : 0);
  }

  // ====== DEBUG: marqueur de hit ======
  const debugSpheres = [];
  function spawnDebugMarker(p, ttl = 0.5) {
    if (!DEBUG_HITS) return;
    const g = new THREE.SphereGeometry(0.01, 8, 8);
    const m = new THREE.MeshBasicMaterial({ color: 0x00ff88, depthTest: false, toneMapped: false });
    const s = new THREE.Mesh(g, m);
    s.position.copy(p);
    s.renderOrder = 3000;
    scene.add(s);
    debugSpheres.push({ s, ttl });
  }
  function updateDebug(dt) {
    for (let i = debugSpheres.length - 1; i >= 0; i--) {
      const d = debugSpheres[i];
      d.ttl -= dt;
      if (d.ttl <= 0) {
        d.s.parent?.remove(d.s);
        debugSpheres.splice(i, 1);
        d.s.geometry.dispose();
        d.s.material.dispose();
      }
    }
  }

  // ====== HUD SCORE ======
  let hitsCount = 0;
  const hud = document.createElement('div');
  hud.style.position = 'fixed';
  hud.style.left = '50%';
  hud.style.top = '2vh';
  hud.style.transform = 'translateX(-50%)';
  hud.style.padding = '6px 10px';
  hud.style.background = 'rgba(0,0,0,0.35)';
  hud.style.color = '#fff';
  hud.style.fontFamily = 'system-ui, sans-serif';
  hud.style.fontSize = '14px';
  hud.style.borderRadius = '8px';
  hud.style.userSelect = 'none';
  hud.textContent = 'Coups: 0';
  document.body.appendChild(hud);

  // ====== ACTION PUNCH ======
  function punchAt(clientX, clientY) {
    if (!faceMesh) return;

    ndc.x = (clientX / window.innerWidth) * 2 - 1;
    ndc.y = -(clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(faceMesh, true)[0];
    if (!hit) return;

    const worldNormal = hit.face
      ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize()
      : new THREE.Vector3(0, 1, 0);

    // Marqueur debug
    spawnDebugMarker(hit.point);

    // Décal world-space (toujours visible)
    spawnDecal(hit.point, worldNormal, DECAL_RADIUS_WORLD);

    // Particules
    spawnImpactParticles(hit.point, worldNormal, PARTS_PER_HIT);

    // Shake + haptics
    camera.position.addScaledVector(
      new THREE.Vector3((Math.random() - 0.5) * 0.05, (Math.random() - 0.5) * 0.03, (Math.random() - 0.5) * 0.05),
      1
    );
    if (navigator.vibrate) navigator.vibrate(12);

    try { window.rnbo?.messRNBO?.('punch', 1); } catch (e) {}

    hitsCount++; hud.textContent = `Coups: ${hitsCount}`;
  }

  // ====== INPUTS ======
  let isPunching = false;
  const activeTouches = new Map();

  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') {
      activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (activeTouches.size >= 2) {
        isPunching = false;
        controls.enabled = true;
      } else {
        ndc.x = (e.clientX / window.innerWidth) * 2 - 1;
        ndc.y = -(e.clientY / window.innerHeight) * 2 + 1;
        raycaster.setFromCamera(ndc, camera);
        const hit = faceMesh ? raycaster.intersectObject(faceMesh, true) : [];
        if (hit.length) {
          isPunching = true;
          controls.enabled = false;
          punchAt(e.clientX, e.clientY);
        } else {
          isPunching = false;
          controls.enabled = true;
        }
      }
    } else {
      ndc.x = (e.clientX / window.innerWidth) * 2 - 1;
      ndc.y = -(e.clientY / window.innerHeight) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      const hit = faceMesh ? raycaster.intersectObject(faceMesh, true) : [];
      if (hit.length) {
        isPunching = true;
        controls.enabled = false;
        punchAt(e.clientX, e.clientY);
      } else {
        isPunching = false;
        controls.enabled = true;
      }
      renderer.domElement.setPointerCapture(e.pointerId);
    }
  });

  renderer.domElement.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') {
      if (activeTouches.has(e.pointerId)) {
        activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
      if (activeTouches.size >= 2) {
        isPunching = false;
        controls.enabled = true;
      } else if (isPunching) {
        punchAt(e.clientX, e.clientY);
      }
    } else {
      if (isPunching) punchAt(e.clientX, e.clientY);
    }
  });

  function endTouch(e) {
    if (e.pointerType === 'touch') {
      activeTouches.delete(e.pointerId);
      if (activeTouches.size === 0) {
        isPunching = false;
        controls.enabled = true;
      }
    } else {
      isPunching = false;
      controls.enabled = true;
      renderer.domElement.releasePointerCapture(e.pointerId);
    }
  }
  renderer.domElement.addEventListener('pointerup', endTouch);
  renderer.domElement.addEventListener('pointercancel', endTouch);
  renderer.domElement.addEventListener('pointerleave', endTouch);

  // ====== RESIZE ======
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ====== LOOP ======
  let last = performance.now();
  function animate() {
    requestAnimationFrame(animate);
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    controls.update();
    updateParticles(dt);
    updateDecals(dt);
    updateDebug(dt);

    renderer.render(scene, camera);
  }
  animate();
})();
