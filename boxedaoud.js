import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

function log() {}
function logErr() {}

// Pre-fetch audio before user gesture (decoding happens later)
const SONG_FILE = 'DAOUD - ok - 03 - la fievre__16b-44k-FR9W12517726.mp3';
const SONG_PATH = './assets/' + encodeURIComponent(SONG_FILE);
const WEBGPU_THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.webgpu.js';
let songArrayBuffer = null;
let hasSong = false;
const songReadyPromise = fetch(SONG_PATH)
  .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status + ' on ' + SONG_PATH); return r.arrayBuffer(); })
  .then(b => { songArrayBuffer = b; hasSong = true; })
  .catch(e => { console.warn('[audio] song fetch failed:', e.message); });

(async function () {

  // ====== PARAMS ======
  function getViewportSize() {
    const vv = window.visualViewport;
    return {
      width: Math.round(vv?.width || window.innerWidth || document.documentElement.clientWidth || 1),
      height: Math.round(vv?.height || window.innerHeight || document.documentElement.clientHeight || 1),
    };
  }

  function getViewportWidth() {
    return getViewportSize().width;
  }

  function getViewportHeight() {
    return getViewportSize().height;
  }

  function detectQualityProfile() {
    const profiles = {
      low:    { name: 'low',    dprCap: 1.0,  maxParts: 180, partsPerHit: 14, damageSamples: 620, antialias: false, contactShadow: false, fpsCap: 30 },
      medium: { name: 'medium', dprCap: 1.35, maxParts: 280, partsPerHit: 22, damageSamples: 800, antialias: true,  contactShadow: true,  fpsCap: 45 },
      high:   { name: 'high',   dprCap: 1.75, maxParts: 400, partsPerHit: 28, damageSamples: 950, antialias: true,  contactShadow: true,  fpsCap: 60 },
    };
    const urlQuality = new URLSearchParams(location.search).get('quality');
    let storedQuality = null;
    try { storedQuality = localStorage.getItem('daoudQuality'); } catch {}
    const forced = urlQuality || storedQuality;
    if (profiles[forced]) return profiles[forced];

    const rawDpr = window.devicePixelRatio || 1;
    const coarsePointer = matchMedia?.('(pointer: coarse)')?.matches ?? false;
    const memory = navigator.deviceMemory ?? 4;
    const cores = navigator.hardwareConcurrency ?? 4;
    const viewport = getViewportSize();
    const pixelLoad = viewport.width * viewport.height * rawDpr * rawDpr;

    if (memory <= 2 || cores <= 2 || pixelLoad > 5200000) return profiles.low;
    if (coarsePointer || memory <= 4 || cores <= 4 || pixelLoad > 3000000) return profiles.medium;
    return profiles.high;
  }

  const QUALITY = detectQualityProfile();
  function makeGraphicsProfile(rendererKind) {
    const webgpu = rendererKind === 'webgpu';
    if (!webgpu) return { ...QUALITY, webgpu: false, materialStyle: 'toon' };

    const dprCap = QUALITY.name === 'high' ? 2.15 : QUALITY.name === 'medium' ? 1.65 : 1.18;
    const boost  = QUALITY.name === 'high' ? 1.48 : QUALITY.name === 'medium' ? 1.32 : 1.14;
    return {
      ...QUALITY,
      webgpu: true,
      materialStyle: 'pbr',
      dprCap: Math.max(QUALITY.dprCap, dprCap),
      maxParts: Math.round(QUALITY.maxParts * boost),
      partsPerHit: Math.round(QUALITY.partsPerHit * boost),
      damageSamples: Math.round(QUALITY.damageSamples * boost),
      contactShadow: true,
      particleScale: QUALITY.name === 'high' ? 1.28 : 1.16,
      flashScale: 1.12,
    };
  }

  const DECAL_RADIUS  = 0.18;
  const DECAL_TTL     = 24.0;
  const DECAL_FADE    = 0.08;
  const MAX_DECALS    = 256;

  // Spring squash & stretch
  const HEAD_BASE_SCALE = 7.0;
  const HEAD_BASE_Y     = 0.10;
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
  // No scene.background: the page keeps the requested flat, solid color.

  const viewport = getViewportSize();
  const camera = new THREE.PerspectiveCamera(70, viewport.width / viewport.height, 0.01, 100);
  camera.position.set(0, 1.1, 3.8);

  const rendererStatus = { kind: '', reason: '' };

  let dpr = Math.min(window.devicePixelRatio || 1, QUALITY.dprCap);
  let renderer = await createBestRenderer(viewport);
  let rendererKind = renderer.userData?.kind ?? 'webgl';
  rendererStatus.kind = rendererKind;
  const GRAPHICS = makeGraphicsProfile(rendererKind);
  dpr = Math.min(window.devicePixelRatio || 1, GRAPHICS.dprCap);
  configureRenderer(renderer, viewport);
  renderer.toneMappingExposure = GRAPHICS.webgpu ? 1.02 : 1.08;
  log('Renderer OK: ' + rendererKind);

  // Visible renderer badge — tap to expand the fallback reason
  const rendererBadge = document.createElement('div');
  Object.assign(rendererBadge.style, {
    position: 'fixed', top: '6px', left: '6px', zIndex: '9999',
    padding: '4px 8px', borderRadius: '4px',
    font: '11px/1.2 monospace',
    background: rendererKind === 'webgpu' ? 'rgba(0,160,80,0.85)' : 'rgba(200,60,40,0.85)',
    color: '#fff', maxWidth: '70vw', whiteSpace: 'pre-wrap',
    pointerEvents: 'auto', cursor: 'pointer',
  });
  const renderShort = rendererKind.toUpperCase();
  const reasonShort = rendererStatus.reason ? ' · ' + rendererStatus.reason.slice(0, 60) : '';
  rendererBadge.textContent = renderShort + reasonShort;
  rendererBadge.addEventListener('click', () => {
    rendererBadge.textContent = rendererKind.toUpperCase()
      + '\nnavigator.gpu: ' + (!!navigator.gpu)
      + '\nUA: ' + navigator.userAgent
      + (rendererStatus.reason ? '\nreason: ' + rendererStatus.reason : '');
  });
  document.body.appendChild(rendererBadge);

  const MAX_PARTS      = GRAPHICS.maxParts;
  const PARTS_PER_HIT  = GRAPHICS.partsPerHit;
  const PART_TTL       = 0.85;
  const PART_SPEED_MIN = 2.2;
  const PART_SPEED_MAX = 4.5;
  const PART_DRAG      = 0.87;
  const PART_GRAVITY   = new THREE.Vector3(0, -5.0, 0);

  function configureRenderer(r, size = getViewportSize()) {
    r.setPixelRatio(dpr);
    r.setSize(size.width, size.height);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.08;
    r.domElement.style.cssText += 'touch-action:none;position:fixed;inset:0;z-index:2;width:100vw;height:100dvh;';
    return r;
  }

  function canCreateWebGLRenderer() {
    return typeof THREE.WebGLRenderer === 'function';
  }

  function redirectToWebGLPage(reason = 'webgpu-fallback') {
    const url = new URL('./webgl.html', location.href);
    const params = new URLSearchParams(location.search);
    params.set('renderer', 'webgl');
    params.set('fallback', reason);
    url.search = params.toString();
    location.replace(url.href);
  }

  function createWebGLRenderer(size = getViewportSize()) {
    if (!canCreateWebGLRenderer()) throw new Error('WebGLRenderer unavailable in this Three.js build');
    const r = new THREE.WebGLRenderer({
      antialias: QUALITY.antialias,
      alpha: true,
      powerPreference: 'high-performance',
    });
    r.userData = { ...(r.userData ?? {}), kind: 'webgl' };
    return configureRenderer(r, size);
  }

  async function createBestRenderer(size = getViewportSize()) {
    const forcedRenderer = new URLSearchParams(location.search).get('renderer');
    if (forcedRenderer === 'webgl') {
      rendererStatus.reason = 'forced via ?renderer=webgl';
      if (!canCreateWebGLRenderer()) {
        redirectToWebGLPage('forced-webgl');
        return await new Promise(() => {});
      }
      return createWebGLRenderer(size);
    }
    if (!navigator.gpu) {
      rendererStatus.reason = 'navigator.gpu absent';
      if (!canCreateWebGLRenderer()) {
        redirectToWebGLPage('no-webgpu');
        return await new Promise(() => {});
      }
      return createWebGLRenderer(size);
    }
    try {
      const adapter = await navigator.gpu.requestAdapter().catch(e => { throw new Error('requestAdapter: ' + (e?.message ?? e)); });
      if (!adapter) throw new Error('requestAdapter returned null (GPU not on allowlist?)');
      const webgpuThree = THREE.WebGPURenderer ? THREE : await import(WEBGPU_THREE_URL);
      if (!webgpuThree.WebGPURenderer) throw new Error('WebGPURenderer export missing');
      const r = new webgpuThree.WebGPURenderer({
        antialias: QUALITY.antialias,
        alpha: true,
      });
      await r.init();
      r.userData = { ...(r.userData ?? {}), kind: 'webgpu' };
      return configureRenderer(r, size);
    } catch (e) {
      const msg = e?.message ?? String(e);
      console.warn('[renderer] WebGPU unavailable, using WebGL:', msg);
      rendererStatus.reason = msg;
      if (!canCreateWebGLRenderer()) {
        redirectToWebGLPage('webgpu-init');
        return await new Promise(() => {});
      }
      return createWebGLRenderer(size);
    }
  }

  function switchToWebGLRenderer() {
    if (rendererKind === 'webgl') return false;
    if (!canCreateWebGLRenderer()) {
      redirectToWebGLPage('webgpu-render');
      return true;
    }
    console.warn('[renderer] WebGPU render failed, switching to WebGL');
    const oldCanvas = renderer.domElement;
    let nextRenderer;
    try {
      nextRenderer = createWebGLRenderer();
    } catch {
      redirectToWebGLPage('webgpu-render');
      return true;
    }
    oldCanvas.replaceWith(nextRenderer.domElement);
    try { renderer.dispose?.(); } catch {}
    renderer = nextRenderer;
    rendererKind = 'webgl';
    bindInputEvents(renderer.domElement);
    resizeOverlayCanvases();
    return true;
  }

  document.body.appendChild(renderer.domElement);

  // Stylized three-point lighting: clear key, restrained fill, warm rim.
  scene.add(new THREE.AmbientLight(0xffffff, GRAPHICS.webgpu ? 0.16 : 0.18));
  scene.add(new THREE.HemisphereLight(0xfff1d2, 0xd9a5bd, GRAPHICS.webgpu ? 0.40 : 0.44));
  const sun = new THREE.DirectionalLight(0xfff0c0, GRAPHICS.webgpu ? 1.75 : 1.85);
  sun.position.set(3.8, 7.5, 5.4);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xaecbff, GRAPHICS.webgpu ? 0.55 : 0.55);
  fill.position.set(-4.2, 1.4, 2.2);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xff7a2a, GRAPHICS.webgpu ? 1.10 : 1.05);
  rim.position.set(-1.4, 1.2, -4.8);
  scene.add(rim);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enabled       = false;   // camera always cinematic — input fully reserved for glove

  // Reusable temps — never allocate these inside hot loops
  const _v1        = new THREE.Vector3();
  const _v2        = new THREE.Vector3();
  const _headPos   = new THREE.Vector3();
  const _aimNdc    = new THREE.Vector2();
  const _baseColor = new THREE.Color();
  const _white     = new THREE.Color(0xffffff);
  const _camRight  = new THREE.Vector3();
  const _camUp     = new THREE.Vector3();
  const _recoilDir = new THREE.Vector3();
  const raycaster   = new THREE.Raycaster();

  function makeContactShadowTex(size = 256) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size * 0.48);
    grad.addColorStop(0.00, 'rgba(0,0,0,0.32)');
    grad.addColorStop(0.58, 'rgba(0,0,0,0.12)');
    grad.addColorStop(1.00, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = false;
    return tex;
  }

  if (GRAPHICS.contactShadow) {
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: makeContactShadowTex(GRAPHICS.webgpu ? 384 : 256),
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      })
    );
    shadow.position.set(0, -1.38, -0.25);
    shadow.rotation.x = -Math.PI / 2;
    shadow.scale.set(2.35, 0.72, 1);
    shadow.renderOrder = -5;
    scene.add(shadow);
  }

  // ====== LOAD GLTF ======
  let faceMesh = null;
  let headRoot = null;
  let headReady = false;            // GLB + textures fully loaded
  let userTappedIntro = false;      // first pointerdown happened
  let faceBaseTex = null;           // GLB-loaded source map — kept around so we
                                     // can restore it as the active material map
                                     // between rounds (CanvasTexture is unreliable
                                     // on WebGPU mobile, GLB texture is stable).

  // Paintable damage layer (canvas overlaid on the face texture)
  let faceDmgCanvas = null;
  let faceDmgCtx    = null;
  let faceDmgTex    = null;
  let faceDmgFlipY  = false;
  let faceDmgBaseImg = null;     // original face image (for reset)

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

  function makeHeadMaterial(srcMat, mapForMat) {
    const color = srcMat?.color?.clone() ?? new THREE.Color(0xe0b48a);
    if (GRAPHICS.materialStyle === 'pbr') {
      const emissive = color.clone().multiplyScalar(0.18);
      return new THREE.MeshStandardMaterial({
        color,
        map: mapForMat,
        roughness: 0.78,
        metalness: 0,
        emissive,
        emissiveIntensity: 0.06,
        envMapIntensity: 0.38,
      });
    }
    return new THREE.MeshToonMaterial({
      color,
      map: mapForMat,
    });
  }

  log('Loading GLB...');
  new GLTFLoader().load('./assets/head_low.glb', (gltf) => {
    log('GLB loaded');

    const headSrc = findByName(gltf.scene, 'soldier_head') ?? gltf.scene;
    log('headSrc: ' + headSrc.name);

    headRoot = new THREE.Group();
    headRoot.position.set(0, HEAD_BASE_Y, -0.25);
    headRoot.scale.setScalar(HEAD_BASE_SCALE);
    scene.add(headRoot);
    headRoot.add(headSrc);

    const meshes = collectMeshes(headSrc);
    log('meshes found: ' + meshes.length);

    for (const n of meshes) {
      if (!faceMesh) faceMesh = n;

      const srcMat = Array.isArray(n.material) ? n.material[0] : n.material;
      const isTheFace = n === faceMesh;

      // For the face mesh, build a paintable canvas-based damage map (clone of source texture)
      let mapForMat = srcMat?.map ?? null;
      if (isTheFace) {
        const baseTex = srcMat?.map;
        const baseImg = baseTex?.image;
        faceDmgBaseImg = baseImg ?? null;
        // Use natural dimensions when available — `.width` on an undecoded
        // HTMLImageElement can be 0 even though the texture object exists.
        const imgW = baseImg?.naturalWidth || baseImg?.width || 0;
        const imgH = baseImg?.naturalHeight || baseImg?.height || 0;
        const W = imgW || 1024;
        const H = imgH || 1024;
        faceDmgCanvas = document.createElement('canvas');
        faceDmgCanvas.width = W; faceDmgCanvas.height = H;
        faceDmgCtx = faceDmgCanvas.getContext('2d');
        // Always paint the skin-tone background FIRST so a silent drawImage
        // failure (image with 0 size, decode error, etc.) leaves a flesh
        // color instead of transparent → black on the material.
        faceDmgCtx.fillStyle = '#e0b48a';
        faceDmgCtx.fillRect(0, 0, W, H);
        if (baseImg && imgW > 0 && imgH > 0) {
          try { faceDmgCtx.drawImage(baseImg, 0, 0, W, H); } catch {}
        }
        faceDmgTex = new THREE.CanvasTexture(faceDmgCanvas);
        faceDmgTex.colorSpace = THREE.SRGBColorSpace;
        faceDmgTex.flipY = baseTex?.flipY ?? false;     // GLTF default is false
        faceDmgTex.wrapS = baseTex?.wrapS ?? THREE.ClampToEdgeWrapping;
        faceDmgTex.wrapT = baseTex?.wrapT ?? THREE.ClampToEdgeWrapping;
        faceDmgTex.generateMipmaps = false;
        faceDmgTex.minFilter = THREE.LinearFilter;
        faceDmgTex.magFilter = THREE.LinearFilter;
        faceDmgTex.needsUpdate = true;
        faceDmgFlipY = faceDmgTex.flipY;
        // IMPORTANT: keep srcMat.map (the GLB-loaded texture) as the initial
        // material map. CanvasTexture upload is unreliable on WebGPU mobile
        // and can cause the head to render fully black. We swap to faceDmgTex
        // lazily on the first damage paint, when the canvas content actually
        // diverges from the GLB texture.
        faceBaseTex = baseTex ?? null;
        mapForMat = baseTex ?? faceDmgTex;
      }

      n.material = makeHeadMaterial(srcMat, mapForMat);

      // TEMP: outline désactivé pour test (dark layer issue avec nouveau mesh)
      // const outline = new THREE.Mesh(
      //   n.geometry,
      //   new THREE.MeshBasicMaterial({
      //     color: 0x111111, side: THREE.BackSide,
      //     polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      //   })
      // );
      // outline.scale.setScalar(1.03);
      // outline.renderOrder = -1;
      // n.add(outline);
    }

    if (!faceMesh) { logErr('Aucun mesh trouvé'); return; }
    log('Head ready ✓');
    const wp = new THREE.Vector3();
    faceMesh.getWorldPosition(wp);
    controls.target.copy(wp);
    controls.update();
    buildFaceDamageMap();
    headReady = true;
    maybeFadeOutIntro();
  }, null, (e) => logErr('GLTF: ' + e));

  // ====== FACE DESTRUCTION ======
  const DAMAGE_TARGET        = 98;   // percent needed for a full clear
  const DAMAGE_SAMPLE_MAX    = GRAPHICS.damageSamples;
  const DAMAGE_RADIUS_MIN    = 0.18;
  const DAMAGE_RADIUS_MAX    = 0.42;
  const DAMAGE_AMOUNT_MIN    = 0.18;
  const DAMAGE_AMOUNT_MAX    = 0.54;
  const DENT_DEPTH_MIN       = 0.018;
  const DENT_DEPTH_MAX       = 0.075;
  const DENT_BULGE           = 0.38;
  const DENT_LIMIT           = 0.16;

  let damageSpots = [];   // { local: Vector3, damage: 0..1 }
  let faceBasePositions = null;
  let faceBaseNormals = null;
  let faceDeformOffsets = null;
  let destruction = 0;
  let faceDestroyed = false;

  function buildFaceDamageMap() {
    if (!faceMesh) return;
    faceMesh.geometry.computeBoundingBox();
    const bb = faceMesh.geometry.boundingBox;
    const center = bb.getCenter(new THREE.Vector3());
    const half = bb.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    const frontCut = center.z + half.z * 0.10;
    const pos = faceMesh.geometry.attributes.position;
    const uv  = faceMesh.geometry.attributes.uv;
    if (!faceBasePositions || faceBasePositions.length !== pos.array.length) {
      faceBasePositions = new Float32Array(pos.array);
      faceBaseNormals = faceMesh.geometry.attributes.normal
        ? new Float32Array(faceMesh.geometry.attributes.normal.array)
        : null;
      faceDeformOffsets = new Float32Array(pos.count);
    } else {
      pos.array.set(faceBasePositions);
      faceDeformOffsets.fill(0);
      pos.needsUpdate = true;
      faceMesh.geometry.computeVertexNormals();
    }
    const step = Math.max(1, Math.ceil(pos.count / DAMAGE_SAMPLE_MAX));
    damageSpots = [];
    for (let i = 0; i < pos.count; i += step) {
      const bx = faceBasePositions[i * 3];
      const by = faceBasePositions[i * 3 + 1];
      const bz = faceBasePositions[i * 3 + 2];
      if (bz < frontCut) continue;
      damageSpots.push({
        local: new THREE.Vector3(bx, by, bz),
        damage: 0,
        idx: i,
        u: uv ? uv.getX(i) : 0.5,
        v: uv ? uv.getY(i) : 0.5,
      });
    }
    if (damageSpots.length < 80) {
      damageSpots = [];
      for (let i = 0; i < pos.count; i += step) {
        const bx = faceBasePositions[i * 3];
        const by = faceBasePositions[i * 3 + 1];
        const bz = faceBasePositions[i * 3 + 2];
        damageSpots.push({
          local: new THREE.Vector3(bx, by, bz),
          damage: 0,
          idx: i,
          u: uv ? uv.getX(i) : 0.5,
          v: uv ? uv.getY(i) : 0.5,
        });
      }
    }

    // Wipe painted damage; restore original face image
    if (faceDmgCtx && faceDmgCanvas) {
      const W = faceDmgCanvas.width, H = faceDmgCanvas.height;
      faceDmgCtx.fillStyle = '#e0b48a';
      faceDmgCtx.fillRect(0, 0, W, H);
      if (faceDmgBaseImg) {
        try { faceDmgCtx.drawImage(faceDmgBaseImg, 0, 0, W, H); } catch {}
      }
      if (faceDmgTex) faceDmgTex.needsUpdate = true;
    }
    // Swap back to the GLB texture between rounds — keeps WebGPU mobile from
    // sitting on a stale CanvasTexture binding when no damage has been painted
    // on the new round yet.
    if (faceMesh && faceBaseTex && faceMesh.material.map !== faceBaseTex) {
      faceMesh.material.map = faceBaseTex;
      faceMesh.material.needsUpdate = true;
    }

    destruction = 0;
    faceDestroyed = false;
    updateScoreHUD();
  }

  function deformFaceAt(localPoint, charge, timingMult, radiusLocal) {
    if (!faceMesh || !faceBasePositions || !faceDeformOffsets) return;
    const pos = faceMesh.geometry.attributes.position;
    const norm = faceMesh.geometry.attributes.normal;
    if (!pos || !norm) return;

    const push = THREE.MathUtils.lerp(DENT_DEPTH_MIN, DENT_DEPTH_MAX, charge) * Math.max(0.55, timingMult);
    const outerRadius = radiusLocal * 1.28;
    const innerRadius = radiusLocal * 0.55;
    const outerSq = outerRadius * outerRadius;

    for (let i = 0; i < pos.count; i++) {
      const bi = i * 3;
      const bx = faceBasePositions[bi];
      const by = faceBasePositions[bi + 1];
      const bz = faceBasePositions[bi + 2];
      const dx = bx - localPoint.x;
      const dy = by - localPoint.y;
      const dz = bz - localPoint.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > outerSq) continue;

      const dist = Math.sqrt(distSq);
      const centerFalloff = Math.max(0, 1 - dist / innerRadius);
      const rimT = THREE.MathUtils.clamp((dist - innerRadius) / Math.max(0.0001, outerRadius - innerRadius), 0, 1);
      const rimFalloff = Math.sin(rimT * Math.PI);
      const delta = (-push * centerFalloff * centerFalloff) + (push * DENT_BULGE * rimFalloff);

      faceDeformOffsets[i] = THREE.MathUtils.clamp(faceDeformOffsets[i] + delta, -DENT_LIMIT, DENT_LIMIT * 0.55);
      const nx = faceBaseNormals ? faceBaseNormals[bi] : norm.getX(i);
      const ny = faceBaseNormals ? faceBaseNormals[bi + 1] : norm.getY(i);
      const nz = faceBaseNormals ? faceBaseNormals[bi + 2] : norm.getZ(i);
      pos.setXYZ(
        i,
        bx + nx * faceDeformOffsets[i],
        by + ny * faceDeformOffsets[i],
        bz + nz * faceDeformOffsets[i],
      );
    }

    pos.needsUpdate = true;
    faceMesh.geometry.computeVertexNormals();
    faceMesh.geometry.computeBoundingSphere();
  }

  function getFaceScale() {
    if (!faceMesh) return HEAD_BASE_SCALE;
    faceMesh.getWorldScale(_v2);
    return Math.max(0.001, (_v2.x + _v2.y + _v2.z) / 3);
  }

  function applyFaceDamage(worldPoint, charge, timingMult) {
    if (!faceMesh || damageSpots.length === 0) {
      return { progressGain: 0, freshness: 1, radius: DAMAGE_RADIUS_MIN };
    }

    faceMesh.updateWorldMatrix(true, false);
    const localPoint = faceMesh.worldToLocal(worldPoint.clone());
    const radiusWorld = THREE.MathUtils.lerp(DAMAGE_RADIUS_MIN, DAMAGE_RADIUS_MAX, charge);
    const radiusLocal = radiusWorld / getFaceScale();
    const radiusSq = radiusLocal * radiusLocal;
    const amount = THREE.MathUtils.lerp(DAMAGE_AMOUNT_MIN, DAMAGE_AMOUNT_MAX, charge) * timingMult;
    deformFaceAt(localPoint, charge, timingMult, radiusLocal);

    let freshWeight = 0;
    let totalWeight = 0;
    let totalDamage = 0;
    const before = destruction;

    // Track UVs of newly-damaged spots so we paint them once (after the loop)
    const paintQueue = [];

    for (const spot of damageSpots) {
      const distSq = spot.local.distanceToSquared(localPoint);
      if (distSq <= radiusSq) {
        const dist = Math.sqrt(distSq);
        const falloff = 1 - dist / radiusLocal;
        const weight = falloff * falloff;
        totalWeight += weight;
        freshWeight += weight * (1 - spot.damage);
        const prevDmg = spot.damage;
        spot.damage = Math.min(1, spot.damage + amount * weight * (1 - spot.damage * 0.72));
        const delta = spot.damage - prevDmg;
        if (delta > 0.001 && faceDmgCtx) {
          paintQueue.push({ u: spot.u, v: spot.v, d: spot.damage, delta });
        }
      }
      totalDamage += spot.damage;
    }

    // First time damage is applied, swap the material map from the stable
    // GLB-loaded texture to our paintable canvas texture. Doing it lazily
    // avoids the WebGPU-mobile "black head" issue when a CanvasTexture upload
    // would have occurred at start-up before any damage existed.
    if (paintQueue.length > 0 && faceMesh && faceDmgTex && faceMesh.material.map !== faceDmgTex) {
      faceMesh.material.map = faceDmgTex;
      faceMesh.material.needsUpdate = true;
      faceDmgTex.needsUpdate = true;
    }

    // Paint impact marks on the face canvas — layered bruise look:
    // 1) wide reddish/purple halo (multiply) so it tints the skin instead of pasting black
    // 2) dark central contusion stamped from a few jittered blobs (irregular edge)
    // 3) tiny scattered specks for spatter / scab feel
    if (paintQueue.length > 0 && faceDmgCtx && faceDmgCanvas) {
      const W = faceDmgCanvas.width, H = faceDmgCanvas.height;
      const ctx = faceDmgCtx;
      ctx.save();

      // Centroid of the impact (weighted by how much each spot was freshly damaged)
      let impactU = 0, impactV = 0, impactWeight = 0;
      for (const p of paintQueue) {
        const w = Math.max(0.001, p.delta);
        impactU += p.u * w;
        impactV += p.v * w;
        impactWeight += w;
      }
      if (impactWeight > 0) {
        const cx = (impactU / impactWeight) * W;
        const cy = (faceDmgFlipY ? (1 - impactV / impactWeight) : (impactV / impactWeight)) * H;
        const r  = 38 + charge * 56;
        const haloA = 0.32 + charge * 0.30;

        // ---- 1. Bruise halo (multiply) — purple/red outer ring that fades to skin
        ctx.globalCompositeOperation = 'multiply';
        const halo = ctx.createRadialGradient(cx, cy, r * 0.18, cx, cy, r * 1.15);
        halo.addColorStop(0.00, `rgba(120, 30, 40, ${(haloA * 0.85).toFixed(3)})`);
        halo.addColorStop(0.45, `rgba( 90, 25, 55, ${(haloA * 0.55).toFixed(3)})`);
        halo.addColorStop(0.78, `rgba( 70, 30, 70, ${(haloA * 0.28).toFixed(3)})`);
        halo.addColorStop(1.00, 'rgba(80,40,80,0)');
        ctx.fillStyle = halo;
        const ang = Math.random() * Math.PI;
        ctx.beginPath();
        ctx.ellipse(cx, cy, r * 1.10, r * 0.78, ang, 0, Math.PI * 2);
        ctx.fill();

        // ---- 2. Dark contusion core — 3 jittered blobs for irregular outline (multiply)
        const coreA = 0.55 + charge * 0.32;
        const blobs = 3;
        for (let i = 0; i < blobs; i++) {
          const t  = i / blobs;
          const jr = r * (0.38 + Math.random() * 0.34);
          const jx = cx + Math.cos(ang + t * 5.1) * r * 0.18 * Math.random();
          const jy = cy + Math.sin(ang + t * 5.1) * r * 0.18 * Math.random();
          const a  = coreA * (i === 0 ? 1 : (0.55 + Math.random() * 0.35));
          const core = ctx.createRadialGradient(jx, jy, 0, jx, jy, jr);
          core.addColorStop(0.00, `rgba( 18,  8, 12, ${a.toFixed(3)})`);
          core.addColorStop(0.55, `rgba( 35, 18, 28, ${(a * 0.55).toFixed(3)})`);
          core.addColorStop(1.00, 'rgba(40,20,30,0)');
          ctx.fillStyle = core;
          ctx.beginPath();
          ctx.arc(jx, jy, jr, 0, Math.PI * 2);
          ctx.fill();
        }

        // ---- 3. Spatter specks — tiny dark dots around the rim (source-over)
        ctx.globalCompositeOperation = 'source-over';
        const specks = 4 + ((charge * 6) | 0);
        for (let i = 0; i < specks; i++) {
          const sa = Math.random() * Math.PI * 2;
          const sd = r * (0.55 + Math.random() * 0.55);
          const sx = cx + Math.cos(sa) * sd;
          const sy = cy + Math.sin(sa) * sd;
          const sr = 1.2 + Math.random() * 2.4;
          ctx.fillStyle = `rgba(${20 + (Math.random() * 30) | 0}, ${8 + (Math.random() * 14) | 0}, ${10 + (Math.random() * 16) | 0}, ${(0.45 + Math.random() * 0.35).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(sx, sy, sr, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // ---- 4. Per-spot accumulation — stains that deepen where damage piles up.
      // Multiply blend keeps the underlying skin/texture detail readable.
      ctx.globalCompositeOperation = 'multiply';
      for (const p of paintQueue) {
        const cx = p.u * W;
        const cy = (faceDmgFlipY ? (1 - p.v) : p.v) * H;
        const r  = Math.max(9, 14 + p.d * 32);
        const d = p.d;
        // Color shifts from red (fresh) toward dark purple/black as damage piles up.
        const rC = (60  - d * 40) | 0;
        const gC = (22  - d * 15) | 0;
        const bC = (32  - d * 18) | 0;
        const innerA = (0.34 + d * 0.45) * Math.min(1, p.delta * 14);
        const midA   = innerA * 0.55;
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        grad.addColorStop(0.00, `rgba(${rC},${gC},${bC},${innerA.toFixed(3)})`);
        grad.addColorStop(0.50, `rgba(${(rC * 0.7) | 0},${(gC * 0.7) | 0},${(bC * 0.7) | 0},${midA.toFixed(3)})`);
        grad.addColorStop(1.00, `rgba(${rC},${gC},${bC},0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
      if (faceDmgTex) faceDmgTex.needsUpdate = true;
    }

    destruction = Math.min(100, (totalDamage / damageSpots.length) * 100);
    const progressGain = Math.max(0, destruction - before);
    const freshness = totalWeight > 0 ? freshWeight / totalWeight : 0;

    return { progressGain, freshness, radius: radiusWorld };
  }

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
    t.generateMipmaps = false;
    return t;
  }
  const decalTex = makeDecalTex();

  // ====== DECALS ======
  const planeGeo = new THREE.PlaneGeometry(1, 1);
  const decals   = [];

  function spawnDecal(pt, normal, radius = DECAL_RADIUS) {
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
    m.scale.setScalar(radius * 2);
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
    t.generateMipmaps = false;
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
    const spawnCount = Math.min(count, Math.max(0, MAX_PARTS - activeParts.length));
    for (let i = 0; i < spawnCount; i++) {
      const sprite = getStarSprite();
      sprite.position.copy(pt).addScaledVector(n, 0.05);
      sprite.scale.setScalar(0.2 * (GRAPHICS.particleScale ?? 1));
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
      p.sprite.scale.setScalar(life * 0.2 * (GRAPHICS.particleScale ?? 1));
      p.sprite.material.opacity = life;
      p.ttl -= dt;

      if (p.ttl <= 0) {
        scene.remove(p.sprite);
        starPool.push(p.sprite);
        activeParts.splice(i, 1);
      }
    }
  }

  function easeOutBack(t) {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }

  // ====== SQUASH & STRETCH ======
  function triggerSquash(hitNormal, charge = 0.6, punchMotion = null) {
    headScaleVel = -20.0 - charge * 12.0;

    _camRight.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    _camUp.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    _recoilDir.copy(hitNormal).multiplyScalar(-0.28);

    if (punchMotion) {
      const len = Math.hypot(punchMotion.x, punchMotion.y) || 1;
      const sx = punchMotion.x / len;
      const sy = punchMotion.y / len;
      _recoilDir
        .addScaledVector(_camRight, sx * (1.75 + charge * 0.65))
        .addScaledVector(_camUp, -sy * (1.75 + charge * 0.65));
    } else {
      _recoilDir.addScaledVector(_camUp, 0.12);
    }

    headRecoilVel.copy(_recoilDir.multiplyScalar(1.10 + charge * 0.55));
  }

  function updateHeadSpring(dt) {
    if (!headRoot) return;

    // Scale spring (uniform squash)
    const sAcc = (HEAD_BASE_SCALE - headScaleCur) * SPRING_K - headScaleVel * SPRING_D;
    headScaleVel += sAcc * dt;
    headScaleCur += headScaleVel * dt;
    if (headScaleCur > HEAD_BASE_SCALE) {
      headScaleCur = HEAD_BASE_SCALE;
      if (headScaleVel > 0) headScaleVel = 0;
    }
    headRoot.scale.setScalar(headScaleCur);

    // Position recoil spring (reuse _v1, no allocation)
    _v1.copy(headRecoilPos).multiplyScalar(-RECOIL_K).addScaledVector(headRecoilVel, -RECOIL_D);
    headRecoilVel.addScaledVector(_v1, dt);
    headRecoilPos.addScaledVector(headRecoilVel, dt);
    headRoot.position.set(0, HEAD_BASE_Y, -0.25).add(headRecoilPos);
  }

  // ====== RHYTHM ENGINE ======
  const BPM           = 125;                 // DAOUD - ok - 03 - la fievre
  const BEAT_OFFSET   = 0.0;                // ← delay (s) before 1st beat in song
  const BEAT_INTERVAL = 60 / BPM;
  const LOOK_AHEAD    = 0.9;                 // seconds: ring spawns this early
  const PERFECT_WIN   = 0.08;               // ±80 ms
  const GOOD_WIN      = 0.18;               // ±180 ms
  const INTRO_GRACE_PUNCHES = 4;            // wider timing while the player learns
  const EASY_PERFECT_WIN    = 0.11;
  const EASY_GOOD_WIN       = 0.25;
  const CHARGE_FULL_MS      = 760;

  // ---- Slice playback: each session plays a random bar-aligned chunk ----
  const ROUND_SECONDS = 30;
  const SLICE_LEN   = ROUND_SECONDS;
  const TAIL_SAFETY = 1.0;                  // extra cushion past the silence-detector

  let audioCtx    = null;
  let musicGain   = null;   // master for the song — sidechain-ducked on impacts
  let sfxGain     = null;   // master for impact SFX (kept clean of duck)
  let nextBeatT   = 0;
  let rhythmOn    = false;
  let rhythmStarting = false;
  let score       = 0;
  let combo       = 0;
  let maxCombo    = 0;
  let perfectCount = 0;
  let niceCount   = 0;
  let missCount   = 0;
  let decodedBuffer  = null;   // cached decoded audio for replay
  let currentSongSrc = null;   // active BufferSource — stop on replay
  let roundEndAt  = 0;
  let roundOver   = false;
  let punchesThrown = 0;
  let lastPunchKind = '';
  let varietyStreak = 0;
  const beats     = [];                      // {time, state:'pending'|'hit'|'missed'}
  let sliceEndTimer     = null;
  let sliceEndTriggered = false;
  let effectiveStart    = -1;                 // computed once after decode (skip leading silence)
  let effectiveEnd      = -1;                 // skip trailing silence / fadeout
  let iosAudioSink      = null;               // <audio playsinline> sink — bypasses iPhone silent switch

  function ensureAudioSink() {
    if (iosAudioSink) return iosAudioSink;
    const a = document.createElement('audio');
    a.setAttribute('playsinline', '');
    a.setAttribute('webkit-playsinline', '');
    a.muted = false;
    a.autoplay = true;
    a.controls = false;
    Object.assign(a.style, {
      position: 'fixed', left: '-9999px', top: '0',
      width: '1px', height: '1px', opacity: '0', pointerEvents: 'none',
    });
    document.body.appendChild(a);
    iosAudioSink = a;
    return a;
  }

  async function startRhythm() {
    if (rhythmOn || rhythmStarting || roundOver) return;
    rhythmStarting = true;
    tapPrompt.textContent = 'CHARGEMENT AUDIO';
    tapPrompt.style.display = '';
    audioCtx  = new AudioContext();

    // iOS-only: route through an <audio playsinline> element so playback uses
    // the media audio session and ignores the hardware silent switch. Other
    // platforms use the plain destination (the MediaStream trick can have
    // playback quirks on Android/desktop).
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    let outNode = audioCtx.destination;
    if (isIOS) {
      try {
        const sink = ensureAudioSink();
        const mediaDest = audioCtx.createMediaStreamDestination();
        sink.srcObject = mediaDest.stream;
        const p = sink.play();
        if (p && typeof p.then === 'function') p.catch(() => {});
        outNode = mediaDest;
      } catch { outNode = audioCtx.destination; }
    }

    // Master buses — music can be ducked, SFX stays clean
    musicGain = audioCtx.createGain();
    musicGain.gain.value = 1.0;
    musicGain.connect(outNode);
    sfxGain = audioCtx.createGain();
    sfxGain.gain.value = 2.85;        // boosted — coups plus presents
    // Soft limiter so the louder SFX bus doesn't clip on stacked impacts.
    const sfxLimiter = audioCtx.createDynamicsCompressor();
    sfxLimiter.threshold.value = -4;
    sfxLimiter.knee.value      = 6;
    sfxLimiter.ratio.value     = 14;
    sfxLimiter.attack.value    = 0.002;
    sfxLimiter.release.value   = 0.08;
    sfxGain.connect(sfxLimiter);
    sfxLimiter.connect(outNode);

    unlockAudio();
    // Ensure the context is actually running before any source.start() — on
    // mobile, BufferSource.start() into a suspended context yields silence.
    if (audioCtx.state !== 'running') {
      try { await audioCtx.resume(); } catch {}
    }
    await songReadyPromise;

    rhythmOn = true;
    rhythmStarting = false;
    tapPrompt.style.display = 'none';
    nextBeatT = audioCtx.currentTime + 0.05;

    if (hasSong && songArrayBuffer) {
      try {
        decodedBuffer = await audioCtx.decodeAudioData(songArrayBuffer);
        startSongPlayback();
      } catch (e) {
        hasSong = false;   // fallback to click metronome
      }
    }
    if (!hasSong) startFallbackRoundTimer();
  }

  function unlockAudio() {
    if (!audioCtx || !sfxGain) return;
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.00001, now + 0.02);
    osc.connect(gain).connect(sfxGain);
    osc.start(now);
    osc.stop(now + 0.03);
  }

  function getTimingWindows() {
    const learning = punchesThrown < INTRO_GRACE_PUNCHES;
    return {
      perfect: learning ? EASY_PERFECT_WIN : PERFECT_WIN,
      good: learning ? EASY_GOOD_WIN : GOOD_WIN,
    };
  }

  // Detect leading/trailing silence so random slices never fall on a dead zone.
  // Scans up to 15 s from each end, mono channel 0, threshold ~ -54 dBFS.
  function findEffectiveStart(buffer, threshold = 0.002) {
    const ch = buffer.getChannelData(0);
    const sr = buffer.sampleRate;
    const lookahead = Math.min(ch.length, 15 * sr);
    for (let i = 0; i < lookahead; i++) {
      if (Math.abs(ch[i]) > threshold) return i / sr;
    }
    return 0;
  }
  function findEffectiveEnd(buffer, threshold = 0.002) {
    const ch = buffer.getChannelData(0);
    const sr = buffer.sampleRate;
    const lookback = Math.min(ch.length, 15 * sr);
    for (let i = ch.length - 1; i > ch.length - lookback; i--) {
      if (Math.abs(ch[i]) > threshold) return i / sr;
    }
    return buffer.duration;
  }

  function startFallbackRoundTimer() {
    if (!audioCtx) return;
    if (sliceEndTimer) clearTimeout(sliceEndTimer);
    sliceEndTriggered = false;
    roundEndAt = audioCtx.currentTime + SLICE_LEN;
    sliceEndTimer = setTimeout(() => {
      sliceEndTimer = null;
      if (!sliceEndTriggered && !faceDestroyed) {
        sliceEndTriggered = true;
        triggerEndScreen('time');
      }
    }, SLICE_LEN * 1000);
  }

  function startSongPlayback() {
    if (!audioCtx || !decodedBuffer || !musicGain) return false;
    if (currentSongSrc) { try { currentSongSrc.stop(); } catch {} currentSongSrc = null; }
    if (sliceEndTimer)  { clearTimeout(sliceEndTimer); sliceEndTimer = null; }
    sliceEndTriggered = false;
    musicGain.gain.cancelScheduledValues(audioCtx.currentTime);
    musicGain.gain.setValueAtTime(1.0, audioCtx.currentTime);

    if (effectiveStart < 0) {
      effectiveStart = findEffectiveStart(decodedBuffer);
      effectiveEnd   = findEffectiveEnd(decodedBuffer);
    }

    // Pick a random bar-aligned start within [effectiveStart, effectiveEnd - SLICE_LEN - TAIL_SAFETY]
    const barLen   = 4 * BEAT_INTERVAL;
    const minStart = effectiveStart;
    const maxStart = Math.max(minStart, effectiveEnd - SLICE_LEN - TAIL_SAFETY);
    const firstBar = Math.ceil((minStart - BEAT_OFFSET) / barLen);
    const lastBar  = Math.floor((maxStart - BEAT_OFFSET) / barLen);
    const barIdx   = firstBar + Math.floor(Math.random() * Math.max(1, lastBar - firstBar + 1));
    const startOffset = Math.max(0, BEAT_OFFSET + barIdx * barLen);

    const src = audioCtx.createBufferSource();
    src.buffer = decodedBuffer;
    src.connect(musicGain);
    const startAt = audioCtx.currentTime;
    src.start(startAt, startOffset);
    src.stop(startAt + SLICE_LEN);            // hard cut at end of slice
    currentSongSrc = src;
    nextBeatT = startAt;                       // bar-aligned slice → next beat is now
    roundEndAt = startAt + SLICE_LEN;

    // Time-based end: if face isn't already KO when the slice runs out, end the run.
    sliceEndTimer = setTimeout(() => {
      sliceEndTimer = null;
      if (!sliceEndTriggered && !faceDestroyed) {
        sliceEndTriggered = true;
        triggerEndScreen('time');
      }
    }, SLICE_LEN * 1000);

    return true;
  }

  // Click metronome — only used when no song loaded
  function scheduleClick(t) {
    if (hasSong) return;
    const osc  = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain); gain.connect(sfxGain ?? audioCtx.destination);
    osc.frequency.value = 900;
    gain.gain.setValueAtTime(0.12, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
    osc.start(t); osc.stop(t + 0.04);
  }

  // Impact SFX — sub thump + transient click, with sidechain duck on the music.
  function playImpactSFX(charge, isPerfect, isTimed = true) {
    if (!audioCtx || !sfxGain) return;
    const now = audioCtx.currentTime;
    const intensity = (0.6 + charge * 0.4) * (isTimed ? 1.0 : 0.92);

    // Sub-bass thump (sine sweep down, 80→35 Hz)
    const osc = audioCtx.createOscillator();
    const oscGain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(isPerfect ? 110 : (isTimed ? 85 : 72), now);
    osc.frequency.exponentialRampToValueAtTime(35, now + 0.09);
    const subPeak = (isPerfect ? 0.88 : (isTimed ? 0.64 : 0.62)) * intensity;
    oscGain.gain.setValueAtTime(0.0001, now);
    oscGain.gain.exponentialRampToValueAtTime(subPeak, now + 0.005);
    oscGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
    osc.connect(oscGain).connect(sfxGain);
    osc.start(now);
    osc.stop(now + 0.22);

    // Transient click — high-passed noise burst, short
    const noiseBuf = audioCtx.createBuffer(1, 512, audioCtx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < 512; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / 512);
    const noise = audioCtx.createBufferSource();
    noise.buffer = noiseBuf;
    const hp = audioCtx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = isPerfect ? 3800 : (isTimed ? 2600 : 2100);
    const noiseAmp = audioCtx.createGain();
    const clickPeak = (isPerfect ? 0.54 : (isTimed ? 0.36 : 0.40)) * intensity;
    noiseAmp.gain.setValueAtTime(clickPeak, now);
    noiseAmp.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
    noise.connect(hp).connect(noiseAmp).connect(sfxGain);
    noise.start(now);

    // Sidechain duck on the music — ~-3.5dB for ~110ms, retriggerable
    if (musicGain) {
      const g = musicGain.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(isPerfect ? 0.54 : (isTimed ? 0.64 : 0.76), now + 0.008);
      g.exponentialRampToValueAtTime(1.0, now + 0.13);
    }
  }

  function scheduleBeats() {
    if (!rhythmOn || roundOver) return;
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
  document.body.appendChild(ringCv);
  const ringCtx = ringCv.getContext('2d');

  function resizeOverlayCanvases() {
    const rect = ringCv.getBoundingClientRect();
    const viewport = getViewportSize();
    const w = rect.width || viewport.width;
    const h = rect.height || viewport.height;
    ringCv.width  = Math.round(w * dpr);
    ringCv.height = Math.round(h * dpr);
  }

  function applyRenderDpr(nextDpr) {
    dpr = THREE.MathUtils.clamp(nextDpr, 0.85, QUALITY.dprCap);
    const viewport = getViewportSize();
    renderer.setPixelRatio(dpr);
    renderer.setSize(viewport.width, viewport.height);
    resizeOverlayCanvases();
  }

  resizeOverlayCanvases();

  function updateBeatRing() {
    ringCtx.clearRect(0, 0, ringCv.width, ringCv.height);
    if (!rhythmOn || roundOver) return;
    const now  = audioCtx.currentTime;
    const next = beats.find(b => b.state === 'pending');
    if (!next) return;

    const until = next.time - now;
    if (until > LOOK_AHEAD) return;
    const timingWin = getTimingWindows();

    if (until < -(timingWin.good + 0.05)) {
      if (next.state === 'pending') {
        // No auto-miss: only beats the player ACTIVELY tries to hit (and
        // mistimes) count as misses. Beats that pass without an attempt are
        // silently consumed — keeps the scoring fair when not every beat is
        // meant to be punched.
        next.state = 'skipped';
      }
      return;
    }

    const t = THREE.MathUtils.clamp(1 - until / LOOK_AHEAD, 0, 1);
    const ease = 1 - Math.pow(1 - t, 3);
    const alpha = Math.min(1, t * 2.4);
    const ringRect = ringCv.getBoundingClientRect();
    const target = currentAimHit
      ? getWorldScreen(currentAimHit.point)
      : { x: ringRect.left + ringRect.width * 0.5, y: ringRect.top + ringRect.height * 0.72 };
    const sx = ringCv.width / Math.max(1, ringRect.width);
    const sy = ringCv.height / Math.max(1, ringRect.height);
    const cx = (target.x - ringRect.left) * sx;
    const cy = (target.y - ringRect.top) * sy;

    ringCtx.save();
    ringCtx.globalAlpha = alpha;
    ringCtx.lineCap     = 'round';

    const isPerfect = Math.abs(until) < timingWin.perfect;
    const isGood = Math.abs(until) < timingWin.good;
    const color = isPerfect ? '#ff2200' : (until < timingWin.good ? '#ff9900' : '#FFE500');
    const ringScale = (sx + sy) * 0.5;
    const targetRadius = 30 * ringScale;
    const pulseRadius = THREE.MathUtils.lerp(108 * ringScale, targetRadius, ease);

    // Timing target: release when the outer ring reaches the fixed center ring.
    ringCtx.strokeStyle = 'rgba(17,17,17,0.95)';
    ringCtx.lineWidth = 8 * ringScale;
    ringCtx.shadowBlur = 0;
    ringCtx.beginPath();
    ringCtx.arc(cx, cy, targetRadius, 0, Math.PI * 2);
    ringCtx.stroke();

    ringCtx.strokeStyle = '#fff';
    ringCtx.lineWidth = 3 * ringScale;
    ringCtx.beginPath();
    ringCtx.arc(cx, cy, targetRadius, 0, Math.PI * 2);
    ringCtx.stroke();

    ringCtx.strokeStyle = color;
    ringCtx.lineWidth = (4 + (isGood ? 2 : 0)) * ringScale;
    ringCtx.shadowBlur = (10 + t * 14) * ringScale;
    ringCtx.shadowColor = color;
    ringCtx.beginPath();
    ringCtx.arc(cx, cy, pulseRadius, 0, Math.PI * 2);
    ringCtx.stroke();

    if (isPerfect) {
      ringCtx.globalAlpha = 0.92;
      ringCtx.fillStyle = 'rgba(255,34,0,0.22)';
      ringCtx.shadowBlur = 24 * ringScale;
      ringCtx.shadowColor = '#ff2200';
      ringCtx.beginPath();
      ringCtx.arc(cx, cy, targetRadius * 1.35, 0, Math.PI * 2);
      ringCtx.fill();
    }

    ringCtx.restore();
  }

  // Judgment
  const judgEl = document.createElement('div');
  judgEl.className = 'judgment-text';
  Object.assign(judgEl.style, {
    position: 'fixed', left: '50%', top: '24%',
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

  // Punch-type label (smaller, below the timing judgment)
  const punchTypeEl = document.createElement('div');
  punchTypeEl.className = 'punch-type-text';
  Object.assign(punchTypeEl.style, {
    position: 'fixed', left: '50%', top: '33%',
    transform: 'translate(-50%,-50%)',
    fontFamily: 'Impact, Arial Black, sans-serif',
    fontSize: '28px', letterSpacing: '5px',
    textShadow: '2px 2px 0 #000',
    pointerEvents: 'none', zIndex: '6000', opacity: '0',
  });
  document.body.appendChild(punchTypeEl);
  let punchTypeTimer = 0;

  function showPunchType(text, color) {
    punchTypeEl.textContent = text;
    punchTypeEl.style.color = color;
    punchTypeEl.style.opacity = '1';
    punchTypeTimer = 0.6;
  }
  function updatePunchType(dt) {
    if (punchTypeTimer <= 0) { punchTypeEl.style.opacity = '0'; return; }
    punchTypeTimer -= dt;
    punchTypeEl.style.opacity = String(Math.min(1, punchTypeTimer / 0.15));
  }

  function breakCombo() {
    if (combo >= 4) triggerDazed();
    combo = 0;
    varietyStreak = 0;
    updateScoreHUD();
  }

  function judgeHit() {
    if (!rhythmOn) return { ok: true, timingMult: 0.7, label: 'FREE', color: '#aaaaff' };
    const now = audioCtx.currentTime;
    const timingWin = getTimingWindows();
    let   best = null, bestDist = Infinity;
    for (const b of beats) {
      if (b.state !== 'pending') continue;
      const d = Math.abs(b.time - now);
      if (d < bestDist) { bestDist = d; best = b; }
    }
    if (!best || bestDist > timingWin.good) {
      // If the closest beat is already past, consume it so updateBeatRing
      // doesn't fire a second auto-miss when its expiry window hits.
      if (best && best.time < now) best.state = 'missed';
      missCount++;
      breakCombo();
      showJudgment('MISS', '#ff2200');
      return { ok: false, timingMult: 0.32, label: 'MISS', color: '#ff2200' };
    }
    best.state = 'hit';

    combo++;
    maxCombo = Math.max(maxCombo, combo);

    if (bestDist <= timingWin.perfect) {
      perfectCount++;
      showJudgment('PERFECT!', '#FFE500');
      return { ok: true, timingMult: 1.25, label: 'PERFECT!', color: '#FFE500', beat: best };
    } else {
      niceCount++;
      showJudgment('NICE!', '#FFD700');
      return { ok: true, timingMult: 0.92, label: 'NICE!', color: '#FFD700', beat: best };
    }
  }

  // ====== PHASE 3: BEAT REACTIONS + ORBITAL STARS ======

  // Camera FOV spring (pulses on beat)
  let camFOVCur = 70, camFOVVel = 0;
  let camTargetFOV = 70;      // updated by cinematic shot selector
  let lastBeatVizT = -999;

  // Screen shake
  let shakeAmt = 0;
  const shakeOffset = new THREE.Vector3();

  function triggerShake(intensity) {
    if (intensity > shakeAmt) shakeAmt = intensity;
  }

  function updateShake(dt) {
    shakeAmt = Math.max(0, shakeAmt - dt * 5.5);
    if (shakeAmt > 0.001) {
      shakeOffset.set(
        (Math.random() - 0.5) * shakeAmt * 2.0,
        (Math.random() - 0.5) * shakeAmt * 1.4,
        (Math.random() - 0.5) * shakeAmt * 1.0,
      );
    } else {
      shakeOffset.set(0, 0, 0);
    }
  }

  function updateBeatReactions(dt) {
    if (!rhythmOn || roundOver) return;
    const now = audioCtx.currentTime;

    // Detect beat crossing → kick camera + background
    for (const b of beats) {
      if (b.time <= now + 0.02 && b.time > lastBeatVizT) {
        lastBeatVizT = b.time;
        camFOVVel = 3;
      }
    }

    // FOV spring — always targets the cinematic camera's wanted FOV
    const fovAcc = (camTargetFOV - camFOVCur) * 250 - camFOVVel * 16;
    camFOVVel += fovAcc * dt;
    camFOVCur += camFOVVel * dt;
    camera.fov = camFOVCur;
    camera.updateProjectionMatrix();

    // Flash overlay — white pulse on every beat
    const sinceBeat = now - lastBeatVizT;
    const flash     = Math.max(0, 1 - sinceBeat / 0.12);
    flashEl.style.opacity = (flash * 0.32 * (GRAPHICS.flashScale ?? 1)).toFixed(3);

    // Body background shifts warmer as combo rises (only when tier changes)
    const tier = combo >= 12 ? 3 : combo >= 8 ? 2 : combo >= 4 ? 1 : 0;
    if (tier !== _lastComboTier) {
      _lastComboTier = tier;
      document.body.style.backgroundColor =
        ['#E8BDC8', '#f5a8b8', '#ed7383', '#e04860'][tier];
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
    if (!faceMesh.geometry.boundingBox) faceMesh.geometry.computeBoundingBox();
    const bb = faceMesh.geometry.boundingBox;
    const center = bb.getCenter(new THREE.Vector3());
    const half = bb.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    const frontCut = center.z - half.z * 0.15;
    const pos  = faceMesh.geometry.attributes.position;
    const norm = faceMesh.geometry.attributes.normal;
    let idx = Math.floor(Math.random() * pos.count);
    for (let tries = 0; tries < 18; tries++) {
      idx = Math.floor(Math.random() * pos.count);
      if (pos.getZ(idx) >= frontCut) break;
    }
    const p    = new THREE.Vector3(pos.getX(idx),  pos.getY(idx),  pos.getZ(idx));
    const n    = new THREE.Vector3(norm.getX(idx), norm.getY(idx), norm.getZ(idx));
    p.applyMatrix4(faceMesh.matrixWorld);
    n.transformDirection(faceMesh.matrixWorld).normalize();
    return { point: p, normal: n };
  }

  // --- Auto mode state ---
  let autoMode     = false;
  let autoCamAngle = 0;

  // ---- Front-arc swing camera (always on, never goes behind the head) ----
  const SWING_HALF_ANGLE = Math.PI * 0.36;   // ±65° around face-front axis
  const SWING_SPEED      = 0.32;             // rad/sec on the angle accumulator
  const camWantPos       = new THREE.Vector3();

  function autoFirePunch() {
    const r = randomFacePoint();
    if (!r) return;
    combo++;
    maxCombo = Math.max(maxCombo, combo);
    showJudgment('PERFECT!', '#FFE500');
    registerImpact(r.point, r.normal, THREE.MathUtils.lerp(0.45, 1, Math.random()), {
      ok: true,
      timingMult: 1.18,
    });
  }

  function processAutoPunches() {
    if (!autoMode || !rhythmOn || !faceMesh || roundOver) return;
    const now = audioCtx.currentTime;
    for (const b of beats) {
      if (!b.autoDone && Math.abs(b.time - now) < 0.055) {
        b.autoDone = true;
        b.state    = 'hit';
        if (Math.random() < 0.88) autoFirePunch();
      }
    }
  }

  function updateAutoCamera(dt) {
    if (!faceMesh) return;
    // Lock camera to the neutral face center so recoil remains visible on screen.
    faceMesh.getWorldPosition(_v1);
    _v1.sub(headRecoilPos);
    controls.target.lerp(_v1, Math.min(1, dt * 2.0));
    const t = controls.target;

    autoCamAngle += dt * SWING_SPEED;

    // Aller-retour swing in front of face: sin → ±SWING_HALF_ANGLE around +Z (face front)
    const yaw   = Math.sin(autoCamAngle) * SWING_HALF_ANGLE;
    const dist  = 3.75;                                                // fixed distance: no zoom creep
    const yOff  = 0.08 + Math.sin(autoCamAngle * 0.43) * 0.10;         // gentle rise/fall
    const fov   = 72;                                                  // fixed framing

    camWantPos.set(
      t.x + Math.sin(yaw) * dist,
      t.y + yOff,
      t.z + Math.cos(yaw) * dist,    // cos > 0 because |yaw| < 90° → camera always in front
    );
    camTargetFOV = fov;

    camera.position.lerp(camWantPos, Math.min(1, dt * 2.6));
    camera.position.add(shakeOffset);
    camera.lookAt(t);
  }

  // --- Intro screen ---
  const introEl = document.createElement('div');
  Object.assign(introEl.style, {
    position: 'fixed', inset: '0',
    width: '100vw', height: '100dvh',
    background: '#000',
    display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center',
    zIndex: '9999', transition: 'opacity 1.2s',
    pointerEvents: 'none',
    padding: '24px 18px', boxSizing: 'border-box',
    overflowY: 'auto',
  });
  introEl.innerHTML = `
    <img src="./assets/logo.png" alt="Daoud" style="
                width:min(46vw, 280px);height:auto;display:block;
                filter:drop-shadow(0 0 34px rgba(255,229,0,0.45));
                margin-bottom:-4px">
    <div style="font-family:Impact,Arial Black,sans-serif;color:#fff;
                font-size:22px;letter-spacing:6px;margin-top:4px">OK</div>

    <div style="font-family:Impact,Arial Black,sans-serif;color:#FFE500;
                font-size:clamp(30px, 8vw, 38px);letter-spacing:3px;
                margin-top:22px;text-shadow:3px 3px 0 #000;text-align:center">
      JEU DE RYTHME
    </div>
    <div style="font-family:Arial,sans-serif;color:#fff;font-weight:700;
                font-size:clamp(17px, 4.6vw, 19px);letter-spacing:1.5px;
                margin-top:8px;text-align:center;max-width:560px;line-height:1.4">
      Frappe le visage <span style="color:#FFE500">EN RYTHME</span> avec la musique
    </div>

    <div style="margin-top:24px;display:flex;flex-direction:column;gap:10px;
                width:min(560px, 100%);">
      <div style="display:flex;align-items:center;gap:12px;
                  background:rgba(255,229,0,0.12);border:2px solid #FFE500;
                  border-radius:4px;padding:12px 14px;">
        <div style="font-family:Impact,Arial Black,sans-serif;color:#111;
                    background:#FFE500;border:2px solid #FFE500;
                    width:42px;height:42px;display:flex;align-items:center;
                    justify-content:center;font-size:24px;flex-shrink:0">1</div>
        <div style="font-family:Arial,sans-serif;color:#fff;font-weight:700;
                    font-size:clamp(16px, 4.2vw, 18px);line-height:1.35;text-align:left">
          <span style="color:#FFE500">MAINTIENS</span> ton doigt sur le visage
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:12px;
                  background:rgba(255,229,0,0.12);border:2px solid #FFE500;
                  border-radius:4px;padding:12px 14px;">
        <div style="font-family:Impact,Arial Black,sans-serif;color:#111;
                    background:#FFE500;border:2px solid #FFE500;
                    width:42px;height:42px;display:flex;align-items:center;
                    justify-content:center;font-size:24px;flex-shrink:0">2</div>
        <div style="font-family:Arial,sans-serif;color:#fff;font-weight:700;
                    font-size:clamp(16px, 4.2vw, 18px);line-height:1.35;text-align:left">
          <span style="color:#FFE500">TIRE</span> le gant pour charger
          <span style="color:#bbb;font-weight:400;font-size:0.88em">(haut = uppercut, cote = crochet)</span>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:12px;
                  background:rgba(255,229,0,0.12);border:2px solid #FFE500;
                  border-radius:4px;padding:12px 14px;">
        <div style="font-family:Impact,Arial Black,sans-serif;color:#111;
                    background:#FFE500;border:2px solid #FFE500;
                    width:42px;height:42px;display:flex;align-items:center;
                    justify-content:center;font-size:24px;flex-shrink:0">3</div>
        <div style="font-family:Arial,sans-serif;color:#fff;font-weight:700;
                    font-size:clamp(16px, 4.2vw, 18px);line-height:1.35;text-align:left">
          <span style="color:#FFE500">RELACHE</span> pour que ton coup <span style="color:#FFE500">FRAPPE EN MUSIQUE</span>
          <span style="color:#bbb;font-weight:400;font-size:0.88em;display:block;margin-top:2px">(l'anneau qui se ferme te guide)</span>
        </div>
      </div>
    </div>

    <div id="introCta" style="font-family:Impact,Arial Black,sans-serif;color:#111;
                background:#FFE500;border:4px solid #FFE500;border-radius:4px;
                font-size:clamp(26px, 7vw, 32px);letter-spacing:5px;
                margin-top:28px;padding:16px 38px;
                box-shadow:6px 6px 0 rgba(255,229,0,0.4);
                animation:pulse 0.7s ease-in-out infinite alternate">
      APPUIE POUR JOUER
    </div>
  `;
  document.body.appendChild(introEl);

  // Only fade out the intro once BOTH conditions are true: the user tapped AND
  // the head GLB+texture are loaded. Avoids the "black head" flash on slow links.
  function maybeFadeOutIntro() {
    if (!introEl.isConnected) return;
    if (!headReady || !userTappedIntro) return;
    if (introEl.dataset.faded === '1') return;
    introEl.dataset.faded = '1';
    introEl.style.opacity = '0';
    setTimeout(() => introEl.remove(), 1300);
  }

  document.addEventListener('pointerdown', () => {
    if (userTappedIntro) return;
    userTappedIntro = true;
    if (!headReady) {
      const cta = introEl.querySelector('#introCta');
      if (cta) cta.textContent = 'CHARGEMENT...';
    }
    maybeFadeOutIntro();
  });

  // --- End screen (KO) ---
  const endScreen = document.createElement('div');
  Object.assign(endScreen.style, {
    position: 'fixed', inset: '0',
    width: '100vw', height: '100dvh',
    background: 'rgba(0,0,0,0.88)',
    display: 'none', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center',
    zIndex: '9000', opacity: '0',
    transition: 'opacity 0.55s ease',
    pointerEvents: 'none', textAlign: 'center',
  });
  endScreen.innerHTML = `
    <div id="endTitle" style="
      font-family:Impact,Arial Black,sans-serif;color:#ff2200;
      font-size:96px;letter-spacing:8px;text-shadow:5px 5px 0 #000;
      margin-bottom:6px">K.O.</div>
    <div id="endScore" style="
      font-family:Impact,Arial Black,sans-serif;color:#FFE500;
      font-size:36px;letter-spacing:3px;text-shadow:3px 3px 0 #000;
      margin-bottom:4px">SCORE: 0</div>
    <div id="endCombo" style="
      font-family:Impact,Arial Black,sans-serif;color:#fff;
      font-size:22px;letter-spacing:3px;text-shadow:2px 2px 0 #000;
      margin-bottom:24px">MAX COMBO: 0</div>
    <div id="endStats" style="
      font-family:Arial,sans-serif;color:#ddd;
      font-size:16px;line-height:1.7;letter-spacing:2px;
      margin-bottom:36px"></div>
    <button id="endReplayBtn" style="
      font-family:Impact,Arial Black,sans-serif;
      font-size:22px;letter-spacing:4px;
      color:#111;background:#FFE500;
      border:4px solid #111;border-radius:3px;
      padding:14px 38px;cursor:pointer;
      box-shadow:5px 5px 0 #111;
      pointer-events:auto;">REJOUER</button>
  `;
  document.body.appendChild(endScreen);
  const endTitleEl  = endScreen.querySelector('#endTitle');
  const endScoreEl  = endScreen.querySelector('#endScore');
  const endComboEl  = endScreen.querySelector('#endCombo');
  const endStatsEl  = endScreen.querySelector('#endStats');
  const endReplayBtn = endScreen.querySelector('#endReplayBtn');

  function triggerEndScreen(reason = 'ko') {
    if (roundOver) return;
    roundOver = true;
    gloveMode = 'idle';
    hideAimFeedback();
    chargeEl.style.opacity = '0';
    if (sliceEndTimer) { clearTimeout(sliceEndTimer); sliceEndTimer = null; }
    if (musicGain && audioCtx) {
      musicGain.gain.cancelScheduledValues(audioCtx.currentTime);
      musicGain.gain.setValueAtTime(musicGain.gain.value, audioCtx.currentTime);
      musicGain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.45);
      const endingSongSrc = currentSongSrc;
      setTimeout(() => {
        if (currentSongSrc && currentSongSrc === endingSongSrc) {
          try { currentSongSrc.stop(); } catch {}
          currentSongSrc = null;
        }
      }, 520);
    }
    endTitleEl.textContent = reason === 'time' ? 'FIN DU ROUND' : 'K.O.';
    endTitleEl.style.fontSize = reason === 'time' ? '72px' : '96px';
    endScoreEl.textContent = `SCORE: ${score.toLocaleString()}`;
    endComboEl.textContent = `MAX COMBO: ${maxCombo}`;
    endStatsEl.innerHTML =
      `<div>PERFECTs : <span style="color:#FFE500">${perfectCount}</span></div>` +
      `<div>NICEs : <span style="color:#FFD700">${niceCount}</span></div>` +
      `<div>MISSes : <span style="color:#ff2200">${missCount}</span></div>`;
    endScreen.style.display = 'flex';
    requestAnimationFrame(() => {
      endScreen.style.opacity = '1';
      endScreen.style.pointerEvents = 'auto';
    });
  }

  function resetGame() {
    // Clear visuals
    for (const d of decals) {
      d.mesh.parent?.remove(d.mesh);
      d.mesh.material.dispose();
    }
    decals.length = 0;
    for (const p of activeParts) {
      scene.remove(p.sprite);
      starPool.push(p.sprite);
    }
    activeParts.length = 0;
    for (const s of orbitalStars) {
      scene.remove(s.sprite);
      starPool.push(s.sprite);
    }
    orbitalStars.length = 0;

    // Reset gameplay state
    score = 0;
    combo = 0;
    maxCombo = 0;
    perfectCount = 0;
    niceCount = 0;
    missCount = 0;
    punchesThrown = 0;
    lastPunchKind = '';
    varietyStreak = 0;
    roundOver = false;
    roundEndAt = 0;
    shakeAmt = 0;
    shakeOffset.set(0, 0, 0);
    beats.length = 0;
    _lastComboTier = -1;
    document.body.style.backgroundColor = '#E8BDC8';

    // Restore face geometry + texture
    buildFaceDamageMap();

    updateScoreHUD();

    // Hide end screen
    endScreen.style.opacity = '0';
    endScreen.style.pointerEvents = 'none';
    setTimeout(() => { endScreen.style.display = 'none'; }, 600);

    // Restart round
    if (!startSongPlayback()) startFallbackRoundTimer();
  }

  endReplayBtn.addEventListener('click', resetGame);

  // ====== CSS OVERLAYS ======
  // White flash on beat (above 3D canvas, below ring/HUD)
  const flashEl = document.createElement('div');
  Object.assign(flashEl.style, {
    position: 'fixed', inset: '0',
    width: '100vw', height: '100dvh',
    background: '#fff', opacity: '0',
    pointerEvents: 'none', zIndex: '3',
  });
  document.body.appendChild(flashEl);

  // Vignette — dark radial gradient for focus/depth
  const vignetteEl = document.createElement('div');
  Object.assign(vignetteEl.style, {
    position: 'fixed', inset: '0',
    width: '100vw', height: '100dvh',
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
  scoreEl.className = 'hud-pill';
  scoreEl.style.cssText = css + 'top:calc(env(safe-area-inset-top, 0px) + 10px); left:2vw; font-size:22px;';
  scoreEl.textContent = 'SCORE: 0';
  document.body.appendChild(scoreEl);

  const comboEl = document.createElement('div');
  comboEl.className = 'hud-pill';
  comboEl.style.cssText = css + 'top:calc(env(safe-area-inset-top, 0px) + 10px); right:2vw; font-size:22px;';
  comboEl.textContent = 'COMBO: 0';
  document.body.appendChild(comboEl);

  const roundEl = document.createElement('div');
  roundEl.className = 'hud-pill';
  roundEl.style.cssText = css + 'top:calc(env(safe-area-inset-top, 0px) + 10px); left:50%; transform:translateX(-50%); font-size:20px;';
  roundEl.textContent = 'ROUND 30s';
  document.body.appendChild(roundEl);

  const tapPrompt = document.createElement('div');
  Object.assign(tapPrompt.style, {
    position: 'fixed', bottom: 'calc(env(safe-area-inset-bottom, 0px) + 6vh)', left: '50%',
    transform: 'translateX(-50%)',
    fontFamily: 'Impact, Arial Black, sans-serif',
    fontSize: '24px', color: '#111', letterSpacing: '3px',
    background: '#FFE500', border: '4px solid #111',
    padding: '10px 26px', borderRadius: '3px',
    pointerEvents: 'none', zIndex: '5000',
    boxShadow: '5px 5px 0 #000',
    textAlign: 'center',
    animation: 'pulse 0.6s ease-in-out infinite alternate',
  });
  tapPrompt.innerHTML = `FRAPPE EN RYTHME<div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:1px;font-weight:700;margin-top:3px">APPUIE SUR LE VISAGE</div>`;
  document.body.appendChild(tapPrompt);

  const tutorialEl = document.createElement('div');
  tutorialEl.className = 'tutorial-panel';
  tutorialEl.innerHTML = `
    <div class="tutorial-title">COMMENT JOUER</div>
    <div class="tutorial-copy">1. <b>MAINTIENS</b> sur le visage &nbsp;&rarr;&nbsp; 2. <b>TIRE</b> le gant &nbsp;&rarr;&nbsp; 3. <b>RELACHE</b> pour <b>FRAPPER EN MUSIQUE</b></div>
    <div class="tutorial-tags"><span>SUIS LE RYTHME</span><span>HAUT = UPPERCUT</span><span>COTE = CROCHET</span></div>
  `;
  document.body.appendChild(tutorialEl);
  const tutorialCopyEl = tutorialEl.querySelector('.tutorial-copy');

  const chargeEl = document.createElement('div');
  chargeEl.className = 'charge-meter';
  chargeEl.innerHTML = '<div class="charge-fill"></div><span>PUISSANCE</span>';
  document.body.appendChild(chargeEl);
  const chargeFillEl = chargeEl.querySelector('.charge-fill');

  // Pulse animation
  const style = document.createElement('style');
  style.textContent = `
    @keyframes pulse { from{opacity:1} to{opacity:0.4} }
    @keyframes aimPulse {
      from { box-shadow:0 0 0 3px #111, 0 0 14px rgba(255,229,0,0.45); }
      to   { box-shadow:0 0 0 3px #111, 0 0 26px rgba(255,229,0,0.95); }
    }
    .aim-reticle {
      position:fixed; width:58px; height:58px;
      transform:translate(-50%, -50%) scale(0.92);
      pointer-events:none; z-index:4400; opacity:0;
      border:4px solid #FFE500; border-radius:50%;
      box-shadow:0 0 0 3px #111, 0 0 18px rgba(255,229,0,0.7);
      transition:opacity 0.08s ease, transform 0.08s ease, border-color 0.08s ease;
      animation:aimPulse 0.45s ease-in-out infinite alternate;
    }
    .aim-reticle::before,
    .aim-reticle::after {
      content:""; position:absolute; left:50%; top:50%;
      width:82px; height:6px; background:#111;
      transform:translate(-50%, -50%);
      box-shadow:0 0 0 2px #FFE500;
    }
    .aim-reticle::after { width:6px; height:82px; }
    .aim-reticle .dot {
      position:absolute; left:50%; top:50%; width:12px; height:12px;
      background:#ff2200; border:3px solid #fff; border-radius:50%;
      transform:translate(-50%, -50%); box-shadow:0 0 0 3px #111;
    }
    .aim-reticle.nearest {
      border-color:#fff;
      box-shadow:0 0 0 3px #111, 0 0 18px rgba(255,255,255,0.65);
    }
    .tutorial-panel {
      position:fixed; left:50%; bottom:calc(env(safe-area-inset-bottom, 0px) + 16vh); transform:translateX(-50%);
      width:min(720px, calc(100vw - 24px)); box-sizing:border-box;
      background:rgba(0,0,0,0.92); color:#fff;
      border:4px solid #FFE500; border-radius:4px;
      padding:14px 18px; z-index:5200; pointer-events:none;
      box-shadow:6px 6px 0 rgba(0,0,0,0.55);
      transition:opacity 0.25s ease, transform 0.25s ease;
    }
    .tutorial-title {
      font-family:Impact,Arial Black,sans-serif;
      color:#FFE500; letter-spacing:4px; font-size:20px; margin-bottom:6px;
      text-shadow:2px 2px 0 #000;
    }
    .tutorial-copy {
      font-family:Arial,sans-serif; font-weight:700;
      font-size:16px; line-height:1.45; letter-spacing:0.5px;
    }
    .tutorial-copy b { color:#FFE500; }
    .tutorial-tags {
      display:flex; flex-wrap:wrap; gap:7px; margin-top:10px;
      font-family:Impact,Arial Black,sans-serif; font-size:13px; letter-spacing:1.5px;
      color:#111;
    }
    .tutorial-tags span {
      background:#FFE500; border:2px solid #111; padding:4px 8px; border-radius:3px;
    }
    .charge-meter {
      position:fixed; width:168px; height:22px; box-sizing:border-box;
      border:3px solid #111; background:#fff; border-radius:3px;
      z-index:4700; pointer-events:none; opacity:0;
      transform:translate(-50%, -50%);
      box-shadow:4px 4px 0 rgba(0,0,0,0.6);
      overflow:hidden;
    }
    .charge-fill {
      position:absolute; left:0; top:0; bottom:0; width:0%;
      background:linear-gradient(90deg, #FFE500, #ff8800, #ff2200);
    }
    .charge-meter span {
      position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
      font-family:Impact,Arial Black,sans-serif; font-size:12px; letter-spacing:2px;
      color:#111; text-shadow:1px 1px 0 rgba(255,255,255,0.7);
    }
    @media (max-width: 640px) {
      .hud-pill { font-size:15px !important; padding:4px 8px !important; }
      .judgment-text {
        top:20% !important;
        font-size:34px !important;
        letter-spacing:2px !important;
        text-shadow:2px 2px 0 #000 !important;
      }
      .punch-type-text {
        top:28% !important;
        font-size:17px !important;
        letter-spacing:2px !important;
        text-shadow:1px 1px 0 #000 !important;
        white-space:nowrap;
      }
      .tutorial-panel { bottom:calc(env(safe-area-inset-bottom, 0px) + 13vh); padding:11px 13px; }
      .tutorial-title { font-size:16px; letter-spacing:3px; }
      .tutorial-copy { font-size:13px; line-height:1.35; }
      .tutorial-tags { gap:5px; font-size:11px; }
      .charge-meter { width:138px; height:20px; }
    }
  `;
  document.head.appendChild(style);

  function updateScoreHUD() {
    scoreEl.textContent = `SCORE: ${score}`;
    comboEl.textContent = combo > 1 ? `x${combo} COMBO` : 'COMBO: 0';
    comboEl.style.color = combo >= 8 ? '#ff4400' : '#FFE500';
  }

  function updateRoundHUD() {
    if (roundOver) {
      roundEl.textContent = 'FIN';
      roundEl.style.color = '#ff2200';
      return;
    }
    if (!rhythmOn || !audioCtx || !roundEndAt) {
      roundEl.textContent = `ROUND ${Math.ceil(SLICE_LEN)}s`;
      roundEl.style.color = '#FFE500';
      return;
    }
    const left = Math.max(0, roundEndAt - audioCtx.currentTime);
    const minutes = Math.floor(left / 60);
    const seconds = Math.ceil(left % 60).toString().padStart(2, '0');
    roundEl.textContent = `${minutes}:${seconds}`;
    roundEl.style.color = left <= 10 ? '#ff2200' : '#FFE500';
  }

  function updateTutorial() {
    if (!tutorialEl) return;
    // Stay visible until the player has clearly understood: 8 punches OR 2 perfects.
    const learned = punchesThrown >= 8 || perfectCount >= 2;
    if (roundOver || learned) {
      tutorialEl.style.opacity = '0';
      tutorialEl.style.transform = 'translateX(-50%) translateY(10px)';
      return;
    }

    tutorialEl.style.opacity = rhythmOn ? '0.96' : '1';
    tutorialEl.style.transform = 'translateX(-50%) translateY(0)';
    if (gloveMode === 'pulled') {
      tutorialCopyEl.innerHTML = "<b>TIRE</b> pour charger &nbsp;&rarr;&nbsp; <b>RELACHE</b> pour <b>FRAPPER EN MUSIQUE</b>";
    } else if (punchesThrown > 0) {
      tutorialCopyEl.innerHTML = "<b>FRAPPE EN MUSIQUE</b> &nbsp;&middot;&nbsp; varie les zones (haut / cote / centre)";
    } else {
      tutorialCopyEl.innerHTML = "1. <b>MAINTIENS</b> sur le visage &nbsp;&rarr;&nbsp; 2. <b>TIRE</b> le gant &nbsp;&rarr;&nbsp; 3. <b>RELACHE</b> pour <b>FRAPPER EN MUSIQUE</b>";
    }
  }

  // ====== BOXING GLOVE (PULL & RELEASE) ======
  // Inline SVG — renders identically across browsers/OS, no external file.
  const GLOVE_SVG = `
    <svg viewBox="0 0 120 130" xmlns="http://www.w3.org/2000/svg"
         style="width:100%;height:100%;display:block;overflow:visible">
      <!-- Wrist cuff -->
      <rect x="32" y="94" width="56" height="30" rx="3"
            fill="#fff" stroke="#111" stroke-width="4"/>
      <rect x="32" y="106" width="56" height="6"
            fill="#cc1f1f" stroke="#111" stroke-width="2"/>
      <!-- Glove body -->
      <path d="M 22,48 C 22,14 98,14 98,48 L 98,90
               C 98,96 92,98 86,98 L 34,98
               C 28,98 22,96 22,90 Z"
            fill="#cc1f1f" stroke="#111" stroke-width="4" stroke-linejoin="round"/>
      <!-- Thumb -->
      <path d="M 22,58 C 10,58 8,72 16,78
               C 22,82 30,80 28,72 L 28,58 Z"
            fill="#cc1f1f" stroke="#111" stroke-width="4" stroke-linejoin="round"/>
      <!-- Knuckle crease -->
      <path d="M 30,55 Q 60,48 90,55"
            fill="none" stroke="#111" stroke-width="3" stroke-linecap="round"/>
      <!-- Sheen highlight -->
      <ellipse cx="42" cy="32" rx="14" ry="9" fill="#ff5050" opacity="0.75"/>
    </svg>`;

  const gloveEl = document.createElement('div');
  gloveEl.innerHTML = GLOVE_SVG;
  Object.assign(gloveEl.style, {
    position: 'fixed', left: '50%', top: '88%',
    transform: 'translate(-50%, -50%) scale(1)',
    width: '120px', height: '130px',
    userSelect: 'none', pointerEvents: 'none',
    zIndex: '4500', willChange: 'transform, left, top',
    filter: 'drop-shadow(5px 5px 0 rgba(0,0,0,0.7))',
  });
  document.body.appendChild(gloveEl);

  const aimLine = document.createElement('div');
  Object.assign(aimLine.style, {
    position: 'fixed', left: '0', top: '0',
    width: '0px', height: '6px',
    transformOrigin: '0 50%',
    background: 'linear-gradient(90deg, rgba(17,17,17,0), #111 18%, #FFE500 45%, #ff2200 100%)',
    boxShadow: '0 0 0 2px #111, 0 0 14px rgba(255,229,0,0.65)',
    pointerEvents: 'none', zIndex: '4300',
    opacity: '0', transition: 'opacity 0.08s ease',
  });
  document.body.appendChild(aimLine);

  const aimReticle = document.createElement('div');
  aimReticle.className = 'aim-reticle';
  aimReticle.innerHTML = '<span class="dot"></span>';
  document.body.appendChild(aimReticle);

  const gloveRest = { x: getViewportWidth() * 0.5, y: getViewportHeight() * 0.88 };
  const glovePos  = { x: gloveRest.x, y: gloveRest.y };
  const aimStart  = { x: gloveRest.x, y: gloveRest.y };
  const aimScreen = { x: gloveRest.x, y: gloveRest.y };
  let gloveMode   = 'idle';   // 'idle' | 'pulled' | 'punching'
  let currentAimHit = null;
  let pullStartMs = 0;
  let lastGhostMs = 0;        // throttle for trail spawning

  function spawnGloveGhost(scale) {
    const g = document.createElement('div');
    g.innerHTML = GLOVE_SVG;
    g.style.cssText = `
      position:fixed; left:${glovePos.x}px; top:${glovePos.y}px;
      transform:translate(-50%,-50%) scale(${scale});
      width:120px; height:130px; opacity:0.55; z-index:4400;
      pointer-events:none; user-select:none;
      transition:opacity 0.18s linear, transform 0.18s ease-out;
      filter:drop-shadow(4px 4px 0 rgba(0,0,0,0.35));
    `;
    document.body.appendChild(g);
    requestAnimationFrame(() => {
      g.style.opacity = '0';
      g.style.transform = `translate(-50%,-50%) scale(${(scale * 0.55).toFixed(2)})`;
    });
    setTimeout(() => g.remove(), 220);
  }
  const punchAnim = {
    t: 0, dur: 0.34, fromX: 0, fromY: 0, toX: 0, toY: 0,
    hit: null, fired: false,
  };

  function recalcGloveRest() {
    const viewport = getViewportSize();
    gloveRest.x = viewport.width * 0.5;
    gloveRest.y = viewport.height * 0.88;
  }

  function applyGlove() {
    const charge = gloveMode === 'pulled' ? getPunchCharge() : 0;
    let scale = 1 + charge * 0.35;
    if (gloveMode === 'punching') {
      const k = Math.min(1, punchAnim.t / punchAnim.dur);
      scale = k < 0.45 ? 1 + (k / 0.45) * 0.6 : 1.6 - ((k - 0.45) / 0.55) * 0.6;
    }
    gloveEl.style.left = glovePos.x + 'px';
    gloveEl.style.top  = glovePos.y + 'px';
    gloveEl.style.transform = `translate(-50%, -50%) scale(${scale})`;
    gloveEl.style.filter = `drop-shadow(5px 5px 0 rgba(0,0,0,0.7)) brightness(${1 + charge * 0.65})`;

    if (gloveMode === 'pulled') {
      chargeEl.style.opacity = '1';
      chargeEl.style.left = glovePos.x + 'px';
      chargeEl.style.top = Math.max(58, glovePos.y - 92) + 'px';
      chargeFillEl.style.width = `${Math.round(charge * 100)}%`;
    } else {
      chargeEl.style.opacity = '0';
    }
  }

  function getPunchCharge() {
    if (gloveMode !== 'pulled') return 0;
    return THREE.MathUtils.clamp((performance.now() - pullStartMs) / CHARGE_FULL_MS, 0, 1);
  }

  function getCanvasRect() {
    return renderer.domElement.getBoundingClientRect();
  }

  function getWorldScreen(point) {
    const rect = getCanvasRect();
    _v1.copy(point).project(camera);
    return {
      x: rect.left + ((_v1.x + 1) / 2) * rect.width,
      y: rect.top + ((-_v1.y + 1) / 2) * rect.height,
    };
  }

  function getNearestVisibleFacePoint(screenX, screenY) {
    if (!faceMesh || damageSpots.length === 0) return null;

    faceMesh.updateWorldMatrix(true, false);
    const norm = faceMesh.geometry.attributes.normal;
    const rect = getCanvasRect();
    let best = null;
    let bestDistSq = Infinity;

    for (const spot of damageSpots) {
      _v1.copy(spot.local).applyMatrix4(faceMesh.matrixWorld).project(camera);
      if (_v1.z < -1 || _v1.z > 1) continue;

      const x = rect.left + ((_v1.x + 1) / 2) * rect.width;
      const y = rect.top + ((-_v1.y + 1) / 2) * rect.height;
      const dx = x - screenX;
      const dy = y - screenY;
      const distSq = dx * dx + dy * dy;
      if (distSq >= bestDistSq) continue;

      const point = spot.local.clone().applyMatrix4(faceMesh.matrixWorld);
      let normal;
      if (norm && spot.idx !== undefined) {
        normal = new THREE.Vector3(
          norm.getX(spot.idx),
          norm.getY(spot.idx),
          norm.getZ(spot.idx),
        ).transformDirection(faceMesh.matrixWorld).normalize();
      } else {
        normal = camera.position.clone().sub(point).normalize();
      }
      best = { point, normal, exact: false };
      bestDistSq = distSq;
    }

    return best;
  }

  function resolveAimHit(screenX, screenY) {
    if (!faceMesh) return null;

    const rect = getCanvasRect();
    _aimNdc.set(
      ((screenX - rect.left) / rect.width) * 2 - 1,
      -((screenY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(_aimNdc, camera);
    const hits = raycaster.intersectObject(faceMesh, false);
    if (hits.length > 0) {
      const h = hits[0];
      const normal = h.face?.normal
        ? h.face.normal.clone().transformDirection(h.object.matrixWorld).normalize()
        : camera.position.clone().sub(h.point).normalize();
      return { point: h.point.clone(), normal, exact: true };
    }

    return getNearestVisibleFacePoint(screenX, screenY);
  }

  function getDefaultAimHit() {
    if (!faceMesh) return null;
    faceMesh.updateWorldMatrix(true, false);
    faceMesh.getWorldPosition(_v1);
    return {
      point: _v1.clone(),
      normal: camera.position.clone().sub(_v1).normalize(),
      exact: true,
    };
  }

  function getDragAimScreen() {
    aimScreen.x = aimStart.x;
    aimScreen.y = aimStart.y;
    return aimScreen;
  }

  function resolveDragAimHit() {
    const screen = getDragAimScreen();
    const hit = resolveAimHit(screen.x, screen.y);
    if (hit) hit.aimScreen = { x: screen.x, y: screen.y };
    return hit;
  }

  function hideAimFeedback() {
    currentAimHit = null;
    aimReticle.style.opacity = '0';
    aimLine.style.opacity = '0';
  }

  function showAimFeedback(hit, showLine = true) {
    if (!hit) {
      hideAimFeedback();
      return;
    }

    const target = getWorldScreen(hit.point);
    aimReticle.style.left = target.x + 'px';
    aimReticle.style.top  = target.y + 'px';
    aimReticle.style.opacity = '1';
    aimReticle.style.transform = `translate(-50%, -50%) scale(${hit.exact ? 1 : 0.86})`;
    aimReticle.classList.toggle('nearest', !hit.exact);

    const dx = target.x - glovePos.x;
    const dy = target.y - glovePos.y;
    const len = Math.hypot(dx, dy);
    aimLine.style.width = Math.max(0, len - 26) + 'px';
    aimLine.style.transform = `translate(${glovePos.x}px, ${glovePos.y}px) rotate(${Math.atan2(dy, dx)}rad)`;
    aimLine.style.opacity = showLine ? '0.78' : '0';
  }

  function registerImpact(point, normal, charge, timing, punchMotion = null) {
    const hit = applyFaceDamage(point, charge, timing?.timingMult ?? 0.7);
    playImpactSFX(charge, (timing?.timingMult ?? 0) >= 1.1, timing?.ok !== false);
    const comboMult = Math.min(Math.max(combo, 1), 4);
    const freshMult = THREE.MathUtils.lerp(0.35, 1.25, hit.freshness);
    const timingMult = Math.max(0.45, timing?.timingMult ?? 0.7);
    const addedScore = Math.round(
      (70 + hit.progressGain * 1350) *
      (1 + charge * 1.15) *
      freshMult *
      timingMult *
      comboMult
    );

    score += addedScore;
    spawnParticles(point, normal, Math.round(PARTS_PER_HIT * (0.65 + charge * 1.1)));
    triggerSquash(normal, charge, punchMotion);

    // Screen shake — scales with charge; PERFECT gets a much harder kick
    const isPerfect = (timing?.timingMult ?? 0) >= 1.1;
    triggerShake((0.045 + charge * 0.06) * (isPerfect ? 1.8 : 1.0));

    if (navigator.vibrate) navigator.vibrate(Math.round(12 + charge * 26));

    if (!faceDestroyed && destruction >= DAMAGE_TARGET) {
      faceDestroyed = true;
      score += 10000 + maxCombo * 250;
      showJudgment('VISAGE KO!', '#ff2200');
      setTimeout(() => triggerEndScreen('ko'), 900);
    } else if (hit.freshness < 0.2 && timing?.ok !== false) {
      showJudgment('VARIE!', '#aaaaff');
    }
    updateScoreHUD();
  }

  function fireGloveImpact() {
    punchAnim.fired = true;
    if (!punchAnim.hit) return;
    const { point, normal, charge, timing, motion } = punchAnim.hit;
    registerImpact(point, normal, charge, timing, motion);
  }

  function releaseGlove() {
    if (!faceMesh || roundOver) { gloveMode = 'idle'; return; }
    const timing = judgeHit();
    const charge = getPunchCharge();
    punchesThrown++;

    const r = resolveDragAimHit() ?? randomFacePoint();
    if (!r) { gloveMode = 'idle'; return; }
    const hitPoint  = r.point;
    const hitNormal = r.normal;

    const target = getWorldScreen(hitPoint);

    // Punch-type detection from drag direction (glovePos relative to aimStart).
    // - Strong UP drag → UPPERCUT (heavier, comes from below)
    // - Strong SIDE drag → CROCHET (timing bonus, comes from off-screen edge)
    // - Anything else → JAB (default, straight from cursor)
    const dx = glovePos.x - aimStart.x;
    const dy = glovePos.y - aimStart.y;
    const adx = Math.abs(dx), ady = Math.abs(dy);

    let punchType   = 'JAB';
    let chargeMult  = 1;
    let timingBoost = 1;
    let kindColor = '#FFE500';
    let fromX = glovePos.x;
    let fromY = glovePos.y;

    if (dy < -60 && ady > adx) {
      punchType  = 'UPPERCUT';
      chargeMult = 1.15;
      kindColor = '#ff8800';
      fromX = target.x;
      fromY = getViewportHeight() + 80;     // come up from below screen
    } else if (adx > 80 && adx > ady * 1.15) {
      const fromLeft = dx < 0;
      punchType   = fromLeft ? 'CROCHET ←' : 'CROCHET →';
      timingBoost = 1.1;
      kindColor = '#aaccff';
      fromX = fromLeft ? -80 : getViewportWidth() + 80;
      fromY = target.y + 20;
    }

    const kindKey = punchType.split(' ')[0];
    const varied = lastPunchKind !== '' && kindKey !== lastPunchKind;
    varietyStreak = varied ? Math.min(3, varietyStreak + 1) : 0;
    lastPunchKind = kindKey;
    const varietyBoost = 1 + varietyStreak * 0.06;
    showPunchType(varied ? `${punchType} + VARIETE` : punchType, kindColor);

    const finalCharge = Math.min(1, charge * chargeMult);
    const finalTiming = timing
      ? { ...timing, timingMult: (timing.timingMult ?? 0.7) * timingBoost * varietyBoost }
      : timing;

    punchAnim.fromX = fromX;
    punchAnim.fromY = fromY;
    punchAnim.toX   = target.x;
    punchAnim.toY   = target.y;
    punchAnim.t     = 0;
    punchAnim.dur   = THREE.MathUtils.lerp(0.30, 0.42, finalCharge);
    punchAnim.hit   = {
      point: hitPoint,
      normal: hitNormal,
      charge: finalCharge,
      timing: finalTiming,
      exact: r.exact,
      kind: punchType,
      motion: { x: target.x - fromX, y: target.y - fromY },
    };
    punchAnim.fired = false;
    gloveMode       = 'punching';
  }

  function updateGlove(dt) {
    if (roundOver || faceDestroyed) {
      hideAimFeedback();
      applyGlove();
      return;
    }

    if (gloveMode === 'punching') {
      punchAnim.t += dt;
      const k = Math.min(1, punchAnim.t / punchAnim.dur);
      if (k < 0.45) {
        const e  = k / 0.45;
        const ke = e * e;
        glovePos.x = punchAnim.fromX + (punchAnim.toX - punchAnim.fromX) * ke;
        glovePos.y = punchAnim.fromY + (punchAnim.toY - punchAnim.fromY) * ke;
        // Speed trail — spawn fading ghosts every ~18ms during the rapid-out phase
        const nowMs = performance.now();
        if (nowMs - lastGhostMs > 18) {
          const trailScale = 1 + (e * 0.6);
          spawnGloveGhost(trailScale);
          lastGhostMs = nowMs;
        }
        if (e >= 1 && !punchAnim.fired) fireGloveImpact();
      } else {
        if (!punchAnim.fired) fireGloveImpact();
        const e  = (k - 0.45) / 0.55;
        const ke = 1 - Math.pow(1 - e, 2);
        glovePos.x = punchAnim.toX + (gloveRest.x - punchAnim.toX) * ke;
        glovePos.y = punchAnim.toY + (gloveRest.y - punchAnim.toY) * ke;
      }
      if (k >= 1) {
        gloveMode  = 'idle';
        glovePos.x = gloveRest.x;
        glovePos.y = gloveRest.y;
      }
    } else if (gloveMode === 'idle') {
      const k = Math.min(1, dt * 8);
      glovePos.x += (gloveRest.x - glovePos.x) * k;
      glovePos.y += (gloveRest.y - glovePos.y) * k;
    }
    applyGlove();
    if (gloveMode === 'pulled') {
      currentAimHit = resolveDragAimHit();
      showAimFeedback(currentAimHit, true);
    } else if (gloveMode === 'punching' && punchAnim.hit) {
      currentAimHit = punchAnim.hit;
      showAimFeedback(punchAnim.hit, true);
    } else {
      currentAimHit = getDefaultAimHit();
      showAimFeedback(currentAimHit, false);
    }
  }

  // ====== INPUT ======
  const activeTouches = new Map();

  function handlePointerDown(e) {
    e.preventDefault();
    if (roundOver || faceDestroyed) return;
    if (e.pointerType === 'touch') {
      if (activeTouches.size >= 1) return;            // only first finger pulls
      activeTouches.set(e.pointerId, true);
      try { renderer.domElement.setPointerCapture(e.pointerId); } catch {}
    } else {
      if (e.button !== 0) return;                      // ignore right/middle click
      renderer.domElement.setPointerCapture(e.pointerId);
    }
    startRhythm();
    if (autoMode || gloveMode === 'punching') return;
    gloveMode = 'pulled';
    pullStartMs = performance.now();
    aimStart.x = e.clientX;
    aimStart.y = e.clientY;
    glovePos.x = e.clientX;
    glovePos.y = e.clientY;
  }

  function handlePointerMove(e) {
    e.preventDefault();
    if (gloveMode !== 'pulled') return;
    glovePos.x = e.clientX;
    glovePos.y = e.clientY;
  }

  function endPointer(e) {
    e.preventDefault();
    if (e.pointerType === 'touch') {
      if (!activeTouches.has(e.pointerId)) return;
      activeTouches.delete(e.pointerId);
      try { renderer.domElement.releasePointerCapture(e.pointerId); } catch {}
    } else {
      if (e.button !== undefined && e.button !== 0) return;
      try { renderer.domElement.releasePointerCapture(e.pointerId); } catch {}
    }
    if (gloveMode === 'pulled') releaseGlove();
  }

  function bindInputEvents(el) {
    el.addEventListener('pointerdown', handlePointerDown, { passive: false });
    el.addEventListener('pointermove', handlePointerMove, { passive: false });
    el.addEventListener('pointerup', endPointer, { passive: false });
    el.addEventListener('pointercancel', endPointer, { passive: false });
    el.addEventListener('pointerleave', endPointer, { passive: false });
  }

  bindInputEvents(renderer.domElement);

  function resizeGameViewport() {
    const viewport = getViewportSize();
    camera.aspect = viewport.width / viewport.height;
    camera.updateProjectionMatrix();
    renderer.setSize(viewport.width, viewport.height);
    resizeOverlayCanvases();
    recalcGloveRest();
  }

  window.addEventListener('resize', resizeGameViewport);
  window.visualViewport?.addEventListener('resize', resizeGameViewport);
  window.visualViewport?.addEventListener('scroll', resizeGameViewport);

  // Pause when the tab loses visibility — suspends the AudioContext so the
  // song AND the rhythm clock both freeze. Resumes cleanly on return.
  document.addEventListener('visibilitychange', () => {
    if (!audioCtx) return;
    if (document.hidden) {
      if (audioCtx.state === 'running') audioCtx.suspend().catch(() => {});
    } else {
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      last = performance.now();   // avoid huge dt spike on first frame back
    }
  });

  // Short runtime check: if the device struggles, drop resolution once.
  let perfSampleT = 0;
  let perfFrameCount = 0;
  let perfWorstDt = 0;
  let adaptiveDropDone = QUALITY.name === 'low';

  function updateAdaptiveQuality(dt) {
    if (adaptiveDropDone || roundOver) return;
    perfSampleT += dt;
    perfFrameCount++;
    perfWorstDt = Math.max(perfWorstDt, dt);
    if (perfSampleT < 2.8 || perfFrameCount < 80) return;

    const avgFrame = perfSampleT / perfFrameCount;
    if ((avgFrame > 1 / 38 || perfWorstDt > 0.055) && dpr > 1.0) {
      applyRenderDpr(Math.max(1.0, dpr - 0.35));
    }
    adaptiveDropDone = true;
  }

  // ====== LOOP ======
  let last = performance.now();
  let lastFrameMs = last;
  function animate() {
    requestAnimationFrame(animate);
    const nowMs = performance.now();
    const minFrameMs = 1000 / (QUALITY.fpsCap || 60);
    if (nowMs - lastFrameMs < minFrameMs) return;
    lastFrameMs = nowMs;
    const dt = Math.min(0.05, (nowMs - last) / 1000);
    last = nowMs;

    controls.update();
    updateAdaptiveQuality(dt);
    scheduleBeats();
    processAutoPunches();
    updateHeadSpring(dt);
    updateShake(dt);
    updateAutoCamera(dt);
    updateGlove(dt);
    updateBeatRing();
    updateBeatReactions(dt);
    updateRoundHUD();
    updateTutorial();
    updateJudgment(dt);
    updatePunchType(dt);
    updateParticles(dt);
    updateOrbitalStars(dt);
    updateDecals(dt);
    try {
      renderer.render(scene, camera);
    } catch (e) {
      if (!switchToWebGLRenderer()) throw e;
    }
  }
  animate();

})();
