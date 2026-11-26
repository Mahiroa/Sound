// 模块: TerrainScene.jsx
// 高性能 3D 场景组件：
//   - 160×160 GPU 离屏高度场模拟 FBO（MRT count=2，每柱 1 次计算替代 20 顶点重复计算，ALU -95%）
//   - 4×4 空间瓦片分块 + 真实视锥剔除 + 逐帧从近到远排序（大幅降低柱群自遮挡 Overdraw）
//   - 16B 紧凑实例属性 aInstPos（告别 64B mat4，VRAM 与顶点抓取带宽 -75%）
//   - 全屏单三角形 Early-Z 天空（排在地形柱之后渲染，遮挡天空片元零执行）
//   - 非活跃特效零绘制 + 主题插值零 GC 下沉 + 全生命周期显式 dispose()
import * as le from "react";
import * as Dt from "react/jsx-runtime";
import { useThree as tL, useFrame as vH, extend as iL } from "@react-three/fiber";
import {
  AdditiveBlending,
  Box3,
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color as se,
  DoubleSide,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LatheGeometry,
  LessEqualDepth,
  MathUtils as e_,
  Matrix3,
  Matrix4 as jt,
  Mesh,
  NearestFilter,
  OctahedronGeometry,
  OrthographicCamera,
  Plane as Ql,
  Quaternion as Js,
  Raycaster as j1,
  RingGeometry,
  Scene,
  Sphere,
  Vector2 as Xe,
  Vector3 as j,
  WebGLRenderTarget,
} from "three";
import { themes, themeCycleOrder } from "../theme/themes.js";
import { audioEngine } from "../audio/audio-engine.js";
import {
  StaticPillarBakeMaterial,
  HeightfieldSimMaterial,
  MapShaderMaterial,
  FloorDiscMaterial,
  SkyShaderMaterial,
  MeteorShaderMaterial,
  SparkShaderMaterial,
  ShockRingMaterial,
} from "./shaders.js";

iL({
  SkyShaderMaterial,
  MeteorShaderMaterial,
  SparkShaderMaterial,
  ShockRingMaterial,
});

// 构造 5 面方柱几何（去除永远朝下不可见的 -Y 底面，20 顶点 / 10 三角形）
function createOpenBottomPillarGeometry(width) {
  const hw = width * 0.5;
  const hh = 0.5;
  const positions = new Float32Array([
    // +Y Top
    -hw, hh,  hw,   hw, hh,  hw,   hw, hh, -hw,  -hw, hh, -hw,
    // +X Right
     hw, -hh,  hw,  hw, -hh, -hw,  hw,  hh, -hw,  hw,  hh,  hw,
    // -X Left
    -hw, -hh, -hw, -hw, -hh,  hw, -hw,  hh,  hw, -hw,  hh, -hw,
    // +Z Front
    -hw, -hh,  hw,  hw, -hh,  hw,  hw,  hh,  hw, -hw,  hh,  hw,
    // -Z Back
     hw, -hh, -hw, -hw, -hh, -hw, -hw,  hh, -hw,  hw,  hh, -hw,
  ]);
  const normals = new Float32Array([
    0, 1, 0,  0, 1, 0,  0, 1, 0,  0, 1, 0,
    1, 0, 0,  1, 0, 0,  1, 0, 0,  1, 0, 0,
   -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0,
    0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1,
    0, 0,-1,  0, 0,-1,  0, 0,-1,  0, 0,-1,
  ]);
  const uvs = new Float32Array([
    0, 0,  1, 0,  1, 1,  0, 1,
    0, 0,  1, 0,  1, 1,  0, 1,
    0, 0,  1, 0,  1, 1,  0, 1,
    0, 0,  1, 0,  1, 1,  0, 1,
    0, 0,  1, 0,  1, 1,  0, 1,
  ]);
  const indices = new Uint16Array([
     0,  1,  2,   0,  2,  3,
     4,  5,  6,   4,  6,  7,
     8,  9, 10,   8, 10, 11,
    12, 13, 14,  12, 14, 15,
    16, 17, 18,  16, 18, 19,
  ]);
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(positions, 3));
  geo.setAttribute("normal", new BufferAttribute(normals, 3));
  geo.setAttribute("uv", new BufferAttribute(uvs, 2));
  geo.setIndex(new BufferAttribute(indices, 1));
  return geo;
}

// 构造全屏单三角形几何（3 顶点，供离屏 FBO 与 Early-Z 天空复用）
function createFullscreenTriangleGeometry() {
  const geo = new BufferGeometry();
  geo.setAttribute(
    "position",
    new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
  );
  return geo;
}

// 构造修长流线彗星流星几何（~42 三角形）
function createCometGeometry() {
  const pts = [
    new Xe(0.0, 0.0),
    new Xe(0.22, 0.36),
    new Xe(0.16, 1.65),
    new Xe(0.075, 5.2),
    new Xe(0.012, 11.5),
  ];
  return new LatheGeometry(pts, 7);
}

function nextCycleIndex(fromIdx) {
  const len = themeCycleOrder.length;
  if (len <= 1) return 0;
  let next = Math.floor(Math.random() * len);
  while (next === fromIdx) next = Math.floor(Math.random() * len);
  return next;
}

function parseCoverColor(cv, out) {
  if (!cv) return false;
  const parts = String(cv).trim().split(/\s+/).map(Number);
  if (parts.length >= 3 && parts.every((n) => !isNaN(n))) {
    out.setRGB(parts[0], parts[1], parts[2]);
    return true;
  }
  try {
    out.set(cv);
    return true;
  } catch {
    return false;
  }
}

function colorDistSq(a, b) {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return dr * dr + dg * dg + db * db;
}

const UP_VEC = new j(0, 1, 0);
const TILES_DIM = 4;

const TerrainSceneInner = le.forwardRef(
  (
    {
      theme: themeId = "nocturnal",
      themeCycleInterval = 60,
      rootContainerRef = null,
      cameraDistance: e = 50,
      idleWaveEnabled: t = !0,
      audioIntensity: n = 1,
      responseRange: r = 1,
      cameraAngleX: o = 45,
      cameraAngleY: c = 30,
      autoRotateEnabled: h = !1,
      autoRotateSpeed: d = 10,
      gridSize: m = 160,
      peakColorEnabled: v = !0,
      peakColorIntensity: y = 1,
      lowPillarDim: lpd = 0.35,
      coverColor: cv = "",
      coverMix: cm = 0,
    },
    x,
  ) => {
    if (m * m > 4_000_000) {
      console.warn(`[Sound] gridSize ${m} 超过安全实例数, 已降级到 2048`);
      m = 2048;
    }

    const sb = le.useRef(null),
      tileMeshRefs = le.useRef([]),
      { clock: R, camera: A, gl: E } = tL(),
      C = le.useRef(o),
      lastFrameNow = le.useRef(performance.now());

    const U = 168,
      F = U / m,
      P = F * 0.857,
      W = U / 2;

    // 检测 WebGL2 半浮点 FBO 支持（桌面 DX11/ANGLE CEF 全面支持，不支持时自动无缝回退）
    const canUseFbo = le.useMemo(() => {
      if (!E?.capabilities?.isWebGL2) return false;
      return Boolean(
        E.extensions.get("EXT_color_buffer_float") ||
          E.extensions.get("EXT_color_buffer_half_float"),
      );
    }, [E]);

    // 共享几何体与材质（统一缓存与生命周期释放）
    const pillarGeo = le.useMemo(() => createOpenBottomPillarGeometry(P), [P]);
    const floorGeo = le.useMemo(() => {
      const g = new CircleGeometry(Math.max(1, W - F * 0.75), 64);
      g.rotateX(-Math.PI / 2);
      g.translate(0, 0.35, 0);
      return g;
    }, [W, F]);
    const fsTriGeo = le.useMemo(() => createFullscreenTriangleGeometry(), []);
    const cometGeo = le.useMemo(() => createCometGeometry(), []);
    const sparkGeo = le.useMemo(() => new OctahedronGeometry(0.28, 0), []);
    const shockRingGeo = le.useMemo(() => {
      const g = new RingGeometry(0.32, 1.0, 32);
      g.rotateX(-Math.PI / 2);
      return g;
    }, []);

    // 单一共享 MapShaderMaterial 与 Early-Z 主题暗底圆盘材质
    const mapMat = le.useMemo(() => new MapShaderMaterial(), []);
    const floorMat = le.useMemo(() => new FloorDiscMaterial(), []);

    // 4×4 空间瓦片：16B 紧凑实例属性 aInstPos + 精确包围球支持真实视锥剔除与从近到远排序
    const tiles = le.useMemo(() => {
      const half = (m * F) / 2;
      const diskRadiusSq = half * half;
      const buckets = Array.from({ length: TILES_DIM * TILES_DIM }, () => ({
        coords: [],
        minX: Infinity,
        maxX: -Infinity,
        minZ: Infinity,
        maxZ: -Infinity,
      }));
      for (let gx = 0; gx < m; gx++) {
        const tx = Math.min(TILES_DIM - 1, Math.floor((gx / m) * TILES_DIM));
        const xx = gx * F - half;
        for (let gy = 0; gy < m; gy++) {
          const yy = gy * F - half;
          if (xx * xx + yy * yy <= diskRadiusSq) {
            const ty = Math.min(TILES_DIM - 1, Math.floor((gy / m) * TILES_DIM));
            const b = buckets[ty * TILES_DIM + tx];
            b.coords.push(xx, yy, gx, gy);
            if (xx < b.minX) b.minX = xx;
            if (xx > b.maxX) b.maxX = xx;
            if (yy < b.minZ) b.minZ = yy;
            if (yy > b.maxZ) b.maxZ = yy;
          }
        }
      }
      const list = [];
      const pad = P * 0.6;
      for (let i = 0; i < buckets.length; i++) {
        const b = buckets[i];
        const count = b.coords.length >> 2;
        if (count === 0) continue;
        const geo = new InstancedBufferGeometry();
        geo.setAttribute("position", pillarGeo.getAttribute("position"));
        geo.setAttribute("normal", pillarGeo.getAttribute("normal"));
        geo.setAttribute("uv", pillarGeo.getAttribute("uv"));
        geo.setIndex(pillarGeo.getIndex());
        geo.setAttribute(
          "aInstPos",
          new InstancedBufferAttribute(new Float32Array(b.coords), 4),
        );
        geo.instanceCount = count;
        const box = new Box3(
          new j(b.minX - pad, 0, b.minZ - pad),
          new j(b.maxX + pad, 24, b.maxZ + pad),
        );
        const sphere = new Sphere();
        box.getBoundingSphere(sphere);
        geo.boundingBox = box;
        geo.boundingSphere = sphere;
        list.push({
          id: `${m}_${i}`,
          geometry: geo,
          cx: (b.minX + b.maxX) * 0.5,
          cz: (b.minZ + b.maxZ) * 0.5,
          distSq: 0,
          rank: i,
        });
      }
      return list;
    }, [m, F, P, pillarGeo]);

    // 预分配瓦片排序数组（零 GC）
    const tileOrder = le.useMemo(() => tiles.map((_, idx) => idx), [tiles]);

    // GPU 离屏高度场 FBO 管线（gridSize 变更时重建并释放旧目标）
    const fboPipe = le.useMemo(() => {
      if (!canUseFbo) return null;
      const staticRT = new WebGLRenderTarget(m, m, {
        type: HalfFloatType,
        minFilter: NearestFilter,
        magFilter: NearestFilter,
        depthBuffer: false,
        stencilBuffer: false,
      });
      const simRT = new WebGLRenderTarget(m, m, {
        count: 2,
        type: HalfFloatType,
        minFilter: NearestFilter,
        magFilter: NearestFilter,
        depthBuffer: false,
        stencilBuffer: false,
      });
      const staticMat = new StaticPillarBakeMaterial();
      staticMat.uGridStep = F;
      staticMat.uHalfExtent = W;

      const simMat = new HeightfieldSimMaterial();
      simMat.uStaticTex = staticRT.texture;
      simMat.uGridStep = F;
      simMat.uHalfExtent = W;
      // 与 mapMat 共享同一份波纹 Vector4 池，CPU 只需写一次
      simMat.uniforms.uRippleGeo.value = mapMat.uniforms.uRippleGeo.value;
      simMat.uniforms.uRippleParam.value = mapMat.uniforms.uRippleParam.value;

      const fsCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const staticScene = new Scene();
      staticScene.add(new Mesh(fsTriGeo, staticMat));
      const simScene = new Scene();
      simScene.add(new Mesh(fsTriGeo, simMat));

      return {
        staticRT,
        simRT,
        staticMat,
        simMat,
        fsCamera,
        staticScene,
        simScene,
        staticBaked: false,
      };
    }, [canUseFbo, m, F, W, fsTriGeo, mapMat]);

    // 显式释放所有 GPU 资源（避免 gridSize 切换或卸载时 VRAM 泄漏）
    le.useEffect(
      () => () => {
        for (let k = 0; k < tiles.length; k++) tiles[k].geometry.dispose();
      },
      [tiles],
    );
    le.useEffect(
      () => () => {
        if (!fboPipe) return;
        fboPipe.staticRT.dispose();
        fboPipe.simRT.dispose();
        fboPipe.staticMat.dispose();
        fboPipe.simMat.dispose();
      },
      [fboPipe],
    );
    le.useEffect(() => () => pillarGeo.dispose(), [pillarGeo]);
    le.useEffect(() => () => floorGeo.dispose(), [floorGeo]);
    le.useEffect(
      () => () => {
        fsTriGeo.dispose();
        cometGeo.dispose();
        sparkGeo.dispose();
        shockRingGeo.dispose();
        mapMat.dispose();
        floorMat.dispose();
      },
      [fsTriGeo, cometGeo, sparkGeo, shockRingGeo, mapMat, floorMat],
    );
    le.useEffect(
      () => () => {
        sb.current?.dispose();
        K.current?.dispose();
        Ce.current?.dispose();
        shockMatRef.current?.dispose();
      },
      [],
    );

    // 零 GC 主题插值状态（支持 random 周期轮换与封面混色，彻底消除 RootApp 每秒重渲染）
    const cycleState = le.useRef({
      fromIdx: Math.floor(Math.random() * themeCycleOrder.length),
      toIdx: 0,
      startMs: performance.now(),
      initialized: false,
    });
    if (!cycleState.current.initialized) {
      cycleState.current.toIdx = nextCycleIndex(cycleState.current.fromIdx);
      cycleState.current.initialized = true;
    }
    const targetTheme = le.useMemo(
      () => ({
        uBaseColor1: new se(),
        uBaseColor2: new se(),
        uCoolCore: new se(),
        uCoolEdge: new se(),
        uWarmCore: new se(),
        uWarmEdge: new se(),
        uMidCore: new se(),
        uMidEdge: new se(),
        uRippleColor: new se(),
        uPeakColor: new se(),
        uGlowIntensity: 1,
      }),
      [],
    );
    const parsedCover = le.useMemo(() => {
      const col = new se();
      const valid = cm > 0 && parseCoverColor(cv, col);
      return { valid, col };
    }, [cv, cm]);

    const themeConverged = le.useRef(false);
    const lastDomSyncMs = le.useRef(0);
    const lastDomHex = le.useRef({ bg: "", accent: "", peak: "" });

    // 当主题或封面混色变化时重置收敛标记
    le.useEffect(() => {
      themeConverged.current = false;
    }, [themeId, cv, cm]);

    // 波纹槽位池（就地复用，零每帧 GC + 活跃计数短路）
    const X = le.useRef(
        Array.from({ length: 20 }, () => ({
          x: 0,
          z: 0,
          time: -100,
          strength: 0,
          isActive: 0,
          rippleType: 0,
        })),
      ),
      activeRippleSlots = le.useRef(0),
      J = le.useRef(0),
      ne = le.useCallback(
        (rx, rz, strength, isMeteor = !1) => {
          const now = R.getElapsedTime();
          let idx = -1;
          for (let k = 0; k < X.current.length; k++) {
            const s = X.current[k];
            if (!s.isActive) {
              idx = k;
              break;
            }
            if (idx < 0 && now - s.time > 2.8) idx = k;
          }
          if (idx < 0) idx = J.current;
          J.current = (idx + 1) % X.current.length;
          const slot = X.current[idx];
          if (!slot.isActive) activeRippleSlots.current++;
          slot.x = rx;
          slot.z = rz;
          slot.time = now;
          slot.strength = strength;
          slot.isActive = 1;
          slot.rippleType = isMeteor ? 1 : 0;
        },
        [R],
      );

    // 流星 / 火花 / 撞击光环实例池（空闲时 visible=false 零绘制，活跃时按实际数紧凑绘制）
    const Q = 32,
      Y = le.useRef(null),
      K = le.useRef(null),
      ae = 240,
      pe = le.useRef(null),
      Ce = le.useRef(null),
      RING_POOL = 12,
      shockMeshRef = le.useRef(null),
      shockMatRef = le.useRef(null);

    const q = le.useRef(
        Array.from({ length: ae }, () => ({
          active: !1,
          x: 0,
          y: -1e3,
          z: 0,
          vx: 0,
          vy: 0,
          vz: 0,
          life: 0,
          maxLife: 1,
          scale: 1,
        })),
      ),
      ie = le.useRef(0),
      ze = le.useRef(
        Array.from({ length: Q }, () => ({
          active: !1,
          x: 0,
          y: -1e3,
          z: 0,
          dx: 0,
          dy: -1,
          dz: 0,
          speed: 0,
          strength: 0,
        })),
      ),
      Qe = le.useRef(0),
      shockRings = le.useRef(
        Array.from({ length: RING_POOL }, () => ({
          active: !1,
          x: 0,
          y: 2.1,
          z: 0,
          life: 0,
          maxLife: 0.72,
          maxRadius: 12,
        })),
      ),
      shockCursor = le.useRef(0),
      mu = le.useRef(0),
      pu = le.useRef(0),
      ru = le.useRef(0);

    // 预分配临时数学对象（零 GC）
    const Ne = le.useMemo(() => new jt(), []),
      Pe = le.useMemo(() => new j(), []),
      ce = le.useMemo(() => new Js(), []),
      Be = le.useMemo(() => new j(), []),
      velDir = le.useMemo(() => new j(), []),
      tmpColor = le.useMemo(() => new se(1, 1, 1), []),
      camRotMat3 = le.useMemo(() => new Matrix3(), []),
      raycaster = le.useMemo(() => new j1(), []),
      clickNdc = le.useMemo(() => new Xe(), []),
      groundPlane = le.useMemo(() => new Ql(new j(0, 1, 0), 0), []),
      hitPoint = le.useMemo(() => new j(), []);

    // 首帧初始化 instanceColor 属性，并将空闲特效 mesh 隐藏（0 drawcall）
    le.useLayoutEffect(() => {
      if (Y.current) {
        Y.current.count = 0;
        Y.current.visible = false;
      }
      if (pe.current) {
        for (let k = 0; k < ae; k++) pe.current.setColorAt(k, tmpColor.setRGB(1, 1, 1));
        if (pe.current.instanceColor) pe.current.instanceColor.needsUpdate = !0;
        pe.current.count = 0;
        pe.current.visible = false;
      }
      if (shockMeshRef.current) {
        for (let k = 0; k < RING_POOL; k++)
          shockMeshRef.current.setColorAt(k, tmpColor.setRGB(1, 1, 1));
        if (shockMeshRef.current.instanceColor)
          shockMeshRef.current.instanceColor.needsUpdate = !0;
        shockMeshRef.current.count = 0;
        shockMeshRef.current.visible = false;
      }
    }, [ae, RING_POOL, tmpColor]);

    // 生成火花粒子
    const Se = le.useCallback(
      (px, py, pz, speedHint, isImpact = !1) => {
        const idx = ie.current,
          p = q.current[idx];
        if (!p.active) pu.current++;
        p.active = !0;
        if (isImpact) {
          const ang = Math.random() * Math.PI * 2;
          const spd = (0.8 + Math.random() * 1.9) * Math.min(2.6, 0.7 + speedHint * 0.6);
          p.x = px + (Math.random() - 0.5) * 0.9;
          p.y = py + Math.random() * 0.5;
          p.z = pz + (Math.random() - 0.5) * 0.9;
          p.vx = Math.cos(ang) * spd;
          p.vy = 1.6 + Math.random() * 2.6 + speedHint * 0.55;
          p.vz = Math.sin(ang) * spd;
          p.life = 0;
          p.maxLife = 0.55 + Math.random() * 0.55;
          p.scale = 0.65 + Math.random() * 0.75;
        } else {
          p.x = px + (Math.random() - 0.5) * 0.7;
          p.y = py + (Math.random() - 0.5) * 0.7;
          p.z = pz + (Math.random() - 0.5) * 0.7;
          p.vx = (Math.random() - 0.5) * 0.8;
          p.vy = 0.35 + Math.random() * 0.9;
          p.vz = (Math.random() - 0.5) * 0.8;
          p.life = 0;
          p.maxLife = 0.32 + Math.random() * 0.34;
          p.scale = 0.32 + Math.random() * 0.42;
        }
        ie.current = (idx + 1) % ae;
      },
      [ae],
    );

    const spawnShockRing = le.useCallback(
      (rx, ry, rz, strength) => {
        const idx = shockCursor.current;
        const ring = shockRings.current[idx];
        if (!ring.active) ru.current++;
        ring.active = !0;
        ring.x = rx;
        ring.y = ry;
        ring.z = rz;
        ring.life = 0;
        ring.maxLife = 0.62 + Math.min(0.28, strength * 0.1);
        ring.maxRadius = 8.5 + Math.min(9.5, strength * 3.2);
        shockCursor.current = (idx + 1) % RING_POOL;
      },
      [RING_POOL],
    );

    // 生成斜射流星
    const spawnMeteorTo = le.useCallback(
      (targetX, targetZ, startY, speed, strength) => {
        const idx = Qe.current,
          mt = ze.current[idx];
        if (!mt.active) mu.current++;
        const slantAz = Math.random() * Math.PI * 2;
        const tilt = 0.28 + Math.random() * 0.16;
        const horizRatio = Math.tan(tilt);
        const startX = targetX - Math.cos(slantAz) * startY * horizRatio;
        const startZ = targetZ - Math.sin(slantAz) * startY * horizRatio;
        const vx = targetX - startX;
        const vy = -startY;
        const vz = targetZ - startZ;
        const len = Math.hypot(vx, vy, vz) || 1;
        mt.active = !0;
        mt.x = startX;
        mt.y = startY;
        mt.z = startZ;
        mt.dx = vx / len;
        mt.dy = vy / len;
        mt.dz = vz / len;
        mt.speed = speed;
        mt.strength = strength;
        Qe.current = (idx + 1) % Q;
      },
      [Q],
    );

    const Pt = le.useRef(-1 / 0),
      _t = le.useRef(-1 / 0),
      Ht = le.useCallback(
        (strength, pan = 0) => {
          // 冷却已由 audioEngine.meteorTrigger.beatHold 统一控制，这里仅保留防同帧重入保护
          const now = R.getElapsedTime();
          if (now - Pt.current < 0.08) return;
          Pt.current = now;
          const ang = Math.random() * Math.PI * 2,
            dist = 14 + Math.random() * 38;
          const tx = Math.cos(ang) * dist + pan * 10;
          const tz = Math.sin(ang) * dist;
          // 音频自动流星采用低空高速切入（飞行约 0.2~0.3s），大幅缩减音画撞击滞后
          spawnMeteorTo(
            tx,
            tz,
            28 + Math.random() * 10,
            1.65 + Math.random() * 0.35 + strength * 0.38,
            strength,
          );
        },
        [R, spawnMeteorTo],
      );

    const xt = le.useRef({
        x: 0,
        z: 0,
        initialized: !1,
        lastTriggerTime: 0,
        hitsRemaining: 0,
      }),
      Ue = 1400;

    le.useEffect(() => {
      audioEngine.onFreqTrigger = (val, kind, action, pan = 0) => {
        if (action === "Meteor") {
          Ht(Math.min(2.6, Math.max(0.55, val * 1.45)), pan);
        } else {
          const now = performance.now();
          if (
            !xt.current.initialized ||
            now - xt.current.lastTriggerTime > Ue ||
            xt.current.hitsRemaining <= 0
          ) {
            // 锚点分布在中内环到外环（半径 14..46），避开与中心低音主峰重叠，并轻微响应声像偏置
            const ang = Math.random() * Math.PI * 2;
            const dist = 14 + Math.random() * 32;
            xt.current.x = Math.cos(ang) * dist + pan * 12;
            xt.current.z = Math.sin(ang) * dist;
            xt.current.hitsRemaining = 3 + Math.floor(Math.random() * 5);
            xt.current.initialized = !0;
          }
          xt.current.hitsRemaining--;
          xt.current.lastTriggerTime = now;
          let rx, rz;
          if (kind === "Kick") {
            rx = xt.current.x + (Math.random() - 0.5) * 9;
            rz = xt.current.z + (Math.random() - 0.5) * 9;
          } else {
            const ang = Math.random() * Math.PI * 2,
              dist = 15 + Math.random() * 45;
            rx = Math.cos(ang) * dist;
            rz = Math.sin(ang) * dist;
          }
          // 保留轻重拍强弱梯度（对应 amp ≈ 0.22..1.0，不再过早顶满）
          ne(rx, rz, Math.min(2.7, Math.max(0.55, val * 2.05)));
        }
      };
    }, [Ht, ne]);

    le.useImperativeHandle(
      x,
      () => ({
        triggerMeteorAt: (clientX, clientY) => {
          const rect = E.domElement.getBoundingClientRect();
          clickNdc.set(
            ((clientX - rect.left) / rect.width) * 2 - 1,
            -((clientY - rect.top) / rect.height) * 2 + 1,
          );
          raycaster.setFromCamera(clickNdc, A);
          if (!raycaster.ray.intersectPlane(groundPlane, hitPoint)) {
            raycaster.ray.at(60, hitPoint);
          }
          const now = R.getElapsedTime();
          if (now - _t.current < 0.14) return;
          _t.current = now;
          spawnMeteorTo(
            hitPoint.x,
            hitPoint.z,
            46 + Math.random() * 10,
            1.1 + Math.random() * 0.35,
            1.6,
          );
        },
      }),
      [A, E, R, raycaster, clickNdc, groundPlane, hitPoint, spawnMeteorTo],
    );

    const Ye = le.useCallback(
      (angX, angY, dist) => {
        const rx = (angX * Math.PI) / 180,
          ry = (angY * Math.PI) / 180,
          horiz = dist * Math.cos(ry);
        A.position.x = horiz * Math.sin(rx);
        A.position.z = horiz * Math.cos(rx);
        A.position.y = dist * Math.sin(ry);
        A.lookAt(0, 0, 0);
        A.updateMatrixWorld();
      },
      [A],
    );

    le.useEffect(() => {
      if (h) C.current = o;
      Ye(o, c, e);
    }, [o, c, e, h, Ye]);

    // 紧凑打包活跃实例：仅提交活跃数量，空闲时直接隐藏跳过 draw call
    const updateMeteorMatrices = () => {
      const mesh = Y.current;
      if (!mesh) return;
      if (mu.current <= 0) {
        mesh.count = 0;
        mesh.visible = false;
        return;
      }
      let out = 0;
      for (let k = 0; k < Q; k++) {
        const mt = ze.current[k];
        if (!mt.active) continue;
        Pe.set(mt.x, Math.max(0, mt.y), mt.z);
        velDir.set(-mt.dx, -mt.dy, -mt.dz).normalize();
        ce.setFromUnitVectors(UP_VEC, velDir);
        const lenScale = 0.85 + Math.min(0.9, mt.speed * 0.35);
        Be.set(1.05, lenScale, 1.05);
        Ne.compose(Pe, ce, Be);
        mesh.setMatrixAt(out++, Ne);
      }
      mesh.count = out;
      mesh.visible = out > 0;
      if (out > 0) mesh.instanceMatrix.needsUpdate = !0;
    };

    const updateParticleMatrices = () => {
      const mesh = pe.current;
      if (!mesh) return;
      if (pu.current <= 0) {
        mesh.count = 0;
        mesh.visible = false;
        return;
      }
      let out = 0;
      for (let k = 0; k < ae; k++) {
        const p = q.current[k];
        if (!p.active) continue;
        const heat = Math.max(0, 1 - p.life / p.maxLife);
        const s = p.scale * (0.25 + 0.75 * heat);
        const spd = Math.hypot(p.vx, p.vy, p.vz);
        if (spd > 0.05) {
          velDir.set(p.vx / spd, p.vy / spd, p.vz / spd);
          ce.setFromUnitVectors(UP_VEC, velDir);
        } else {
          ce.identity();
        }
        Pe.set(p.x, p.y, p.z);
        Be.set(s * 0.65, s * (1.2 + Math.min(2.6, spd * 0.55)), s * 0.65);
        Ne.compose(Pe, ce, Be);
        mesh.setMatrixAt(out, Ne);
        mesh.setColorAt(out, tmpColor.setRGB(heat, heat, heat));
        out++;
      }
      mesh.count = out;
      mesh.visible = out > 0;
      if (out > 0) {
        mesh.instanceMatrix.needsUpdate = !0;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = !0;
      }
    };

    const updateShockRingMatrices = () => {
      const mesh = shockMeshRef.current;
      if (!mesh) return;
      if (ru.current <= 0) {
        mesh.count = 0;
        mesh.visible = false;
        return;
      }
      let out = 0;
      for (let k = 0; k < RING_POOL; k++) {
        const ring = shockRings.current[k];
        if (!ring.active) continue;
        const p = ring.life / ring.maxLife;
        const easeOut = 1 - Math.pow(1 - p, 2.6);
        const rad = 1.4 + easeOut * ring.maxRadius;
        Pe.set(ring.x, ring.y + easeOut * 1.15, ring.z);
        ce.identity();
        Be.set(rad, 1, rad);
        Ne.compose(Pe, ce, Be);
        mesh.setMatrixAt(out, Ne);
        const rem = Math.max(0, 1 - p);
        mesh.setColorAt(out, tmpColor.setRGB(rem, rem, rem));
        out++;
      }
      mesh.count = out;
      mesh.visible = out > 0;
      if (out > 0) {
        mesh.instanceMatrix.needsUpdate = !0;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = !0;
      }
    };

    // 统一单循环驱动
    vH((state) => {
      const nowMs = performance.now();
      const dt = Math.min((nowMs - lastFrameNow.current) / 1e3, 0.1);
      lastFrameNow.current = nowMs;

      const elapsed = state.clock.getElapsedTime();
      const nt = audioEngine.getAudioData(dt);
      const idleIntensity = audioEngine.getIdleWaveIntensity(dt);

      // 1. 物理更新：流星 / 火花 / 冲击波（空闲跳过全部循环）
      const meteorsHad = mu.current > 0;
      if (meteorsHad) {
        const subRadius = Math.max(1, W * 0.24 * r);
        const bassCenter = W * 0.22 * r;
        const bassSpan = Math.max(1, W * 0.24 * r);
        for (let k = 0; k < Q; k++) {
          const mt = ze.current[k];
          if (!mt.active) continue;
          const step = mt.speed * 60 * dt;
          mt.x += mt.dx * step;
          mt.y += mt.dy * step;
          mt.z += mt.dz * step;
          // 估算落点处柱面高度，避免流星穿透高柱才引爆
          const dist = Math.hypot(mt.x, mt.z);
          const subF = Math.max(0, 1 - dist / subRadius);
          const bassF = Math.max(0, 1 - Math.abs(dist - bassCenter) / bassSpan);
          const estSurfaceY = Math.min(
            6.5,
            0.5 + (nt.subBass * 4.2 * subF + nt.bass * 3.0 * bassF + nt.lowMid * 1.4) * n,
          );
          if (mt.y <= estSurfaceY) {
            mt.active = !1;
            mu.current--;
            ne(mt.x, mt.z, Math.min(2.7, Math.max(0.95, mt.strength * 1.15)), !0);
            spawnShockRing(mt.x, estSurfaceY + 0.55, mt.z, mt.strength);
            for (let s = 0; s < 14; s++) Se(mt.x, estSurfaceY + 0.45, mt.z, mt.speed * 1.15, !0);
          } else if (Math.random() > 0.32) {
            Se(mt.x, mt.y, mt.z, mt.speed * 0.22, !1);
          }
        }
      }

      const particlesHad = pu.current > 0;
      if (particlesHad) {
        const drag = Math.pow(0.92, dt * 60);
        for (let k = 0; k < ae; k++) {
          const p = q.current[k];
          if (!p.active) continue;
          p.life += dt;
          if (p.life >= p.maxLife) {
            p.active = !1;
            pu.current--;
          } else {
            p.vx *= drag;
            p.vz *= drag;
            p.vy -= 4.2 * dt;
            p.x += p.vx * dt * 9.5;
            p.y += p.vy * dt * 9.5;
            p.z += p.vz * dt * 9.5;
            if (p.y < 0.35) {
              p.y = 0.35;
              if (p.vy < -0.2) {
                p.vy = -p.vy * 0.38;
                p.vx *= 0.72;
                p.vz *= 0.72;
              } else {
                p.vy = 0;
              }
            }
          }
        }
      }

      const ringsHad = ru.current > 0;
      if (ringsHad) {
        for (let k = 0; k < RING_POOL; k++) {
          const ring = shockRings.current[k];
          if (!ring.active) continue;
          ring.life += dt;
          if (ring.life >= ring.maxLife) {
            ring.active = !1;
            ru.current--;
          }
        }
      }

      if (h) {
        C.current = (C.current + d * dt) % 360;
        Ye(C.current, c, e);
      }

      // 2. 空间瓦片从近到远排序（仅 ~12 个瓦片，赋予 renderOrder 10..25 触发硬件 Early-Z 消除柱体 Overdraw）
      const camX = A.position.x;
      const camZ = A.position.z;
      for (let i = 0; i < tiles.length; i++) {
        const dx = tiles[i].cx - camX;
        const dz = tiles[i].cz - camZ;
        tiles[i].distSq = dx * dx + dz * dz;
      }
      tileOrder.sort((a, b) => tiles[a].distSq - tiles[b].distSq);
      for (let rank = 0; rank < tileOrder.length; rank++) {
        const mesh = tileMeshRefs.current[tileOrder[rank]];
        if (mesh) mesh.renderOrder = 10 + rank;
      }

      // 3. 活跃波纹打包（无活跃波纹时直接 O(1) 跳过）
      const qe = mapMat;
      let activeCount = 0;
      if (activeRippleSlots.current > 0) {
        const geoArr = qe.uniforms.uRippleGeo.value;
        const paramArr = qe.uniforms.uRippleParam.value;
        for (let k = 0; k < X.current.length; k++) {
          const s = X.current[k];
          if (!s.isActive) continue;
          const timeSince = elapsed - s.time;
          if (timeSince < 0) continue;
          const isMeteor = s.rippleType > 0.5;
          const curSpeed = isMeteor ? 21.0 : 14.5;
          const waveRadius = (isMeteor ? 1.6 : 0.6) + timeSince * curSpeed;
          const curWidth = isMeteor
            ? Math.min(4.6, 1.6 + timeSince * 3.8)
            : Math.min(5.2, 2.2 + timeSince * 3.2);
          const curFadeDist = isMeteor ? 26.0 : 24.0;
          const elevationScale = isMeteor ? 3.5 : 3.1;
          const fade = Math.exp(-waveRadius / curFadeDist);
          const amp = fade * Math.min(1, s.strength * 0.38);
          if (amp < 0.008 || waveRadius > W * 2.25) {
            s.isActive = 0;
            activeRippleSlots.current = Math.max(0, activeRippleSlots.current - 1);
            continue;
          }
          geoArr[activeCount].set(s.x, s.z, waveRadius, amp);
          paramArr[activeCount].set(1.0 / curWidth, isMeteor ? 1.0 : 0.0, elevationScale, 12.0);
          activeCount++;
        }
      }
      qe.uniforms.uActiveRipples.value = activeCount;

      // 4. 零 GC 主题色插值与收敛跳过
      const isRandom = themeId === "random";
      let colorDirty = isRandom || !themeConverged.current;
      if (colorDirty) {
        if (isRandom) {
          const cs = cycleState.current;
          let prog = (nowMs - cs.startMs) / 1000 / Math.max(1, themeCycleInterval);
          if (prog >= 1) {
            cs.fromIdx = cs.toIdx;
            cs.toIdx = nextCycleIndex(cs.fromIdx);
            cs.startMs = nowMs;
            prog = 0;
          }
          const fromT = themes[themeCycleOrder[cs.fromIdx]];
          const toT = themes[themeCycleOrder[cs.toIdx]];
          targetTheme.uBaseColor1.lerpColors(fromT.uBaseColor1, toT.uBaseColor1, prog);
          targetTheme.uBaseColor2.lerpColors(fromT.uBaseColor2, toT.uBaseColor2, prog);
          targetTheme.uCoolCore.lerpColors(fromT.uCoolCore, toT.uCoolCore, prog);
          targetTheme.uCoolEdge.lerpColors(fromT.uCoolEdge, toT.uCoolEdge, prog);
          targetTheme.uWarmCore.lerpColors(fromT.uWarmCore, toT.uWarmCore, prog);
          targetTheme.uWarmEdge.lerpColors(fromT.uWarmEdge, toT.uWarmEdge, prog);
          targetTheme.uMidCore.lerpColors(fromT.uMidCore, toT.uMidCore, prog);
          targetTheme.uMidEdge.lerpColors(fromT.uMidEdge, toT.uMidEdge, prog);
          targetTheme.uRippleColor.lerpColors(fromT.uRippleColor, toT.uRippleColor, prog);
          targetTheme.uPeakColor.lerpColors(fromT.uPeakColor, toT.uPeakColor, prog);
          targetTheme.uGlowIntensity = e_.lerp(fromT.uGlowIntensity, toT.uGlowIntensity, prog);
        } else {
          const baseT = themes[themeId] || themes.nocturnal;
          targetTheme.uBaseColor1.copy(baseT.uBaseColor1);
          targetTheme.uBaseColor2.copy(baseT.uBaseColor2);
          targetTheme.uCoolCore.copy(baseT.uCoolCore);
          targetTheme.uCoolEdge.copy(baseT.uCoolEdge);
          targetTheme.uWarmCore.copy(baseT.uWarmCore);
          targetTheme.uWarmEdge.copy(baseT.uWarmEdge);
          targetTheme.uMidCore.copy(baseT.uMidCore);
          targetTheme.uMidEdge.copy(baseT.uMidEdge);
          targetTheme.uRippleColor.copy(baseT.uRippleColor);
          targetTheme.uPeakColor.copy(baseT.uPeakColor);
          targetTheme.uGlowIntensity = baseT.uGlowIntensity;
        }
        if (parsedCover.valid && cm > 0) {
          targetTheme.uBaseColor2.lerp(parsedCover.col, cm);
          targetTheme.uPeakColor.lerp(parsedCover.col, cm);
        }

        const lerpAlpha = isRandom ? Math.min(1, 0.12 * (dt * 60)) : Math.min(1, 0.05 * (dt * 60));
        qe.uBaseColor1.lerp(targetTheme.uBaseColor1, lerpAlpha);
        qe.uBaseColor2.lerp(targetTheme.uBaseColor2, lerpAlpha);
        qe.uCoolCore.lerp(targetTheme.uCoolCore, lerpAlpha);
        qe.uCoolEdge.lerp(targetTheme.uCoolEdge, lerpAlpha);
        qe.uWarmCore.lerp(targetTheme.uWarmCore, lerpAlpha);
        qe.uWarmEdge.lerp(targetTheme.uWarmEdge, lerpAlpha);
        qe.uMidCore.lerp(targetTheme.uMidCore, lerpAlpha);
        qe.uMidEdge.lerp(targetTheme.uMidEdge, lerpAlpha);
        qe.uRippleColor.lerp(targetTheme.uRippleColor, lerpAlpha);
        qe.uPeakColor.lerp(targetTheme.uPeakColor, lerpAlpha);
        qe.uGlowIntensity = e_.lerp(qe.uGlowIntensity, targetTheme.uGlowIntensity, lerpAlpha);

        if (
          !isRandom &&
          colorDistSq(qe.uBaseColor1, targetTheme.uBaseColor1) < 1e-6 &&
          colorDistSq(qe.uCoolCore, targetTheme.uCoolCore) < 1e-6 &&
          colorDistSq(qe.uWarmCore, targetTheme.uWarmCore) < 1e-6 &&
          colorDistSq(qe.uPeakColor, targetTheme.uPeakColor) < 1e-6 &&
          Math.abs(qe.uGlowIntensity - targetTheme.uGlowIntensity) < 1e-4
        ) {
          themeConverged.current = true;
        }

        // 低频将当前主题色同步到根 DOM CSS 变量（零 React 重渲染）
        const rootEl = rootContainerRef?.current;
        if (rootEl && (nowMs - lastDomSyncMs.current > 400 || themeConverged.current)) {
          lastDomSyncMs.current = nowMs;
          const bg = `#${qe.uBaseColor1.getHexString()}`;
          const accent = `#${qe.uRippleColor.getHexString()}`;
          const peak = `#${qe.uPeakColor.getHexString()}`;
          const prev = lastDomHex.current;
          if (bg !== prev.bg) {
            rootEl.style.backgroundColor = bg;
            prev.bg = bg;
          }
          if (accent !== prev.accent) {
            rootEl.style.setProperty("--sw-accent", accent);
            prev.accent = accent;
          }
          if (peak !== prev.peak) {
            rootEl.style.setProperty("--sw-peak", peak);
            prev.peak = peak;
          }
        }
      }

      const idleVal = t ? idleIntensity : 0;

      // 5. GPU 160×160 高度场离屏烘焙（每柱 1 次计算替代 20 顶点重复计算）
      if (fboPipe) {
        const prevRT = E.getRenderTarget();
        if (!fboPipe.staticBaked) {
          E.setRenderTarget(fboPipe.staticRT);
          E.render(fboPipe.staticScene, fboPipe.fsCamera);
          fboPipe.staticBaked = true;
        }
        const sm = fboPipe.simMat;
        sm.uTime = elapsed;
        sm.uIdleWave = idleVal;
        sm.uAudioIntensity = n;
        sm.uResponseRange = r;
        sm.uSubBass = nt.subBass;
        sm.uBass = nt.bass;
        sm.uLowMid = nt.lowMid;
        sm.uMid = nt.mid;
        sm.uHighMid = nt.highMid;
        sm.uTreble = nt.treble;
        sm.uSmoothness = nt.smoothness;
        sm.uDensity = nt.density;
        sm.uEnergy = nt.energy;
        sm.uniforms.uActiveRipples.value = activeCount;

        E.setRenderTarget(fboPipe.simRT);
        E.render(fboPipe.simScene, fboPipe.fsCamera);
        E.setRenderTarget(prevRT);

        qe.uUseFbo = 1;
        qe.uSimTex0 = fboPipe.simRT.textures[0];
        qe.uSimTex1 = fboPipe.simRT.textures[1];
      } else {
        qe.uUseFbo = 0;
        qe.uTime = elapsed;
        qe.uBass = nt.bass;
        qe.uMid = nt.mid;
        qe.uEnergy = nt.energy;
        qe.uSubBass = nt.subBass;
        qe.uLowMid = nt.lowMid;
        qe.uHighMid = nt.highMid;
        qe.uTreble = nt.treble;
        qe.uSmoothness = nt.smoothness;
        qe.uDensity = nt.density;
        qe.uAudioIntensity = n;
        qe.uResponseRange = r;
      }

      // MapShaderMaterial 与 FloorDiscMaterial 共享色算 uniform 同步
      qe.uPeakEnabled = v ? 1 : 0;
      qe.uPeakIntensity = y;
      qe.uLowPillarDim = lpd;
      qe.uWarmth = nt.warmth;
      qe.uBrightness = nt.brightness;
      qe.uIdleWave = idleVal;
      qe.uHalfExtent = W;

      floorMat.uUseFbo = qe.uUseFbo;
      floorMat.uSimTex0 = qe.uSimTex0;
      floorMat.uHalfExtent = W;
      floorMat.uGridStep = F;
      floorMat.uGridSize = m;
      floorMat.uPeakEnabled = qe.uPeakEnabled;
      floorMat.uPeakIntensity = qe.uPeakIntensity;
      floorMat.uLowPillarDim = lpd;
      floorMat.uEnergy = nt.energy;
      if (colorDirty) {
        floorMat.uBaseColor1.copy(qe.uBaseColor1);
        floorMat.uBaseColor2.copy(qe.uBaseColor2);
        floorMat.uCoolCore.copy(qe.uCoolCore);
        floorMat.uMidCore.copy(qe.uMidCore);
        floorMat.uWarmCore.copy(qe.uWarmCore);
        floorMat.uPeakColor.copy(qe.uPeakColor);
        floorMat.uGlowIntensity = qe.uGlowIntensity;
      }

      // 6. Early-Z 全屏单三角形天空（视角自适应圆盘曲率地平线 + 全屏主题暗底，CPU 预计算旋转）
      if (sb.current) {
        const su = sb.current.uniforms;
        su.uTime.value = elapsed;
        su.uHalfExtent.value = W;
        su.uInvProj.value.copy(A.projectionMatrixInverse);
        su.uCamRot.value.copy(camRotMat3.setFromMatrix4(A.matrixWorld));

        const starAngle = -(C.current * (Math.PI / 180)) * 0.1;
        const gRot = starAngle * 0.12;
        const aurRot = elapsed * 0.032;
        const sa0 = starAngle * 2.5 + elapsed * 0.0038;
        const sa1 = starAngle * 1.5 + elapsed * 0.0015;
        const sa2 = starAngle * 0.7 + elapsed * 0.0006;
        const sa3 = starAngle * 0.4 + elapsed * 0.0003;
        su.uGalRot.value.set(Math.cos(gRot), Math.sin(gRot));
        su.uAurRot.value.set(Math.cos(aurRot), Math.sin(aurRot));
        su.uStarRot0.value.set(Math.cos(sa0), Math.sin(sa0));
        su.uStarRot1.value.set(Math.cos(sa1), Math.sin(sa1));
        su.uStarRot2.value.set(Math.cos(sa2), Math.sin(sa2));
        su.uStarRot3.value.set(Math.cos(sa3), Math.sin(sa3));

        if (colorDirty) {
          su.uFogColor.value.copy(qe.uBaseColor1);
          su.uBaseColor2.value.copy(qe.uBaseColor2);
          su.uNebulaA.value.copy(qe.uCoolCore);
          su.uNebulaB.value.copy(qe.uWarmCore);
          su.uPeakColor.value.copy(qe.uPeakColor);
          su.uGlow.value = qe.uGlowIntensity;
        }
        su.uAudioResp.value =
          Math.min(1, nt.air * 0.45 + nt.treble * 0.45 + nt.energy * 0.25) * 0.38;
        su.uBassResp.value = Math.min(1, nt.subBass * 0.6 + nt.bass * 0.5);
      }

      // 7. 特效材质与紧凑实例矩阵更新（流星/火花/冲击波均取主题主体色 uCoolCore/uWarmCore/uRippleColor）
      if (K.current && (meteorsHad || colorDirty)) {
        K.current.uniforms.uTime.value = elapsed;
        if (colorDirty) {
          K.current.uniforms.uCoreColor.value.copy(qe.uCoolCore);
          K.current.uniforms.uGlowColor.value.copy(qe.uWarmCore);
        }
      }
      if (Ce.current && colorDirty) {
        Ce.current.uniforms.uCoreColor.value.copy(qe.uCoolCore);
        Ce.current.uniforms.uGlowColor.value.copy(qe.uWarmCore);
      }
      if (shockMatRef.current && colorDirty) {
        shockMatRef.current.uniforms.uRippleColor.value.copy(qe.uRippleColor);
        shockMatRef.current.uniforms.uGlowColor.value.copy(qe.uWarmCore);
      }

      if (meteorsHad) updateMeteorMatrices();
      if (particlesHad) updateParticleMatrices();
      if (ringsHad) updateShockRingMatrices();
    });

    return Dt.jsxs(Dt.Fragment, {
      children: [
        // 1. 4×4 空间瓦片音域地形（renderOrder 10..25 由近到远，真实视锥剔除 + 硬件 Early-Z）
        tiles.map((tile, idx) =>
          Dt.jsx(
            "mesh",
            {
              ref: (el) => {
                tileMeshRefs.current[idx] = el;
              },
              geometry: tile.geometry,
              material: mapMat,
              frustumCulled: !0,
              renderOrder: 10 + idx,
            },
            tile.id,
          ),
        ),
        // 1B. Early-Z 主题暗底承托圆盘（排在柱群之后、天空之前，消除轴向对齐黑缝且零过绘）
        Dt.jsx("mesh", {
          geometry: floorGeo,
          material: floorMat,
          frustumCulled: !1,
          renderOrder: 28,
        }),
        // 2. 全屏单三角形 Early-Z 天空（排在地形柱与底盘之后，被遮挡区域零片元计算）
        Dt.jsx("mesh", {
          geometry: fsTriGeo,
          renderOrder: 30,
          frustumCulled: !1,
          children: Dt.jsx("skyShaderMaterial", {
            ref: sb,
            depthTest: !0,
            depthWrite: !1,
            depthFunc: LessEqualDepth,
          }),
        }),
        // 3. 落点地面光环冲击波（空闲 visible=false 零绘制）
        Dt.jsx("instancedMesh", {
          ref: shockMeshRef,
          args: [shockRingGeo, void 0, RING_POOL],
          frustumCulled: !1,
          renderOrder: 40,
          children: Dt.jsx("shockRingMaterial", {
            ref: shockMatRef,
            transparent: !0,
            depthWrite: !1,
            blending: AdditiveBlending,
            side: DoubleSide,
          }),
        }),
        // 4. 炽热等离子彗星流星（空闲 visible=false 零绘制）
        Dt.jsx("instancedMesh", {
          ref: Y,
          args: [cometGeo, void 0, Q],
          frustumCulled: !1,
          renderOrder: 41,
          children: Dt.jsx("meteorShaderMaterial", {
            ref: K,
            transparent: !0,
            depthWrite: !1,
            blending: AdditiveBlending,
          }),
        }),
        // 5. 撞击迸溅余烬火花（空闲 visible=false 零绘制）
        Dt.jsx("instancedMesh", {
          ref: pe,
          args: [sparkGeo, void 0, ae],
          frustumCulled: !1,
          renderOrder: 42,
          children: Dt.jsx("sparkShaderMaterial", {
            ref: Ce,
            transparent: !0,
            depthWrite: !1,
            blending: AdditiveBlending,
          }),
        }),
      ],
    });
  },
);

const TerrainScene = le.memo(TerrainSceneInner);

export { TerrainScene };
