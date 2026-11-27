// 模块: TerrainScene.jsx
// 高性能 3D 场景组件：
//   - 离屏高度场模拟 FBO（MRT count=2 + 硬件 Scissor + 6 平面视锥丢弃，仅模拟屏幕可见柱子）
//   - 4×4 空间瓦片 + 4×4 微块两级视锥剔除 + 边界逐柱紧凑打包（仅渲染屏幕内可见柱子，静止视角零上传）
//   - 16B 紧凑实例属性 aInstPos（告别 64B mat4，VRAM 与顶点抓取带宽 -75%）
//   - 全屏单三角形 Early-Z 天空（排在地形柱之后渲染，纯俯视满屏覆盖时直接跳过绘制）
//   - 波纹/流星/火花/冲击波全链路视锥剔除 + 可见区定向生成 + 非活跃零绘制 + 全生命周期显式 dispose()
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
  DynamicDrawUsage,
  Frustum,
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
const SUB_DIM = 4;
const SKY_CORNERS = [
  new Xe(-1, -1),
  new Xe(1, -1),
  new Xe(-1, 1),
  new Xe(1, 1),
];

// 三态 AABB 视锥分类：0 = 完全在外, 1 = 相交边界, 2 = 完全在内（零分配）
function classifyBoxFrustum(planes, minX, minY, minZ, maxX, maxY, maxZ) {
  let result = 2;
  for (let k = 0; k < 6; k++) {
    const pl = planes[k];
    const nx = pl.normal.x;
    const ny = pl.normal.y;
    const nz = pl.normal.z;
    const c = pl.constant;
    const px = nx >= 0 ? maxX : minX;
    const py = ny >= 0 ? maxY : minY;
    const pz = nz >= 0 ? maxZ : minZ;
    if (nx * px + ny * py + nz * pz + c < 0) return 0;
    const qx = nx >= 0 ? minX : maxX;
    const qy = ny >= 0 ? minY : maxY;
    const qz = nz >= 0 ? minZ : maxZ;
    if (nx * qx + ny * qy + nz * qz + c < 0) result = 1;
  }
  return result;
}

// 球体与 6 平面视锥相交测试（零分配，用于流星/火花/冲击波/特效锚点剔除）
function isSphereInFrustum(planes, x, y, z, radius) {
  for (let k = 0; k < 6; k++) {
    const pl = planes[k];
    if (pl.normal.x * x + pl.normal.y * y + pl.normal.z * z + pl.constant < -radius) {
      return false;
    }
  }
  return true;
}

// 水平圆盘柱体 [0, maxY] 与 6 平面视锥相交测试（用于波纹外影响圆精确剔除）
function isRippleDiskInFrustum(planes, x, z, radius, maxY) {
  for (let k = 0; k < 6; k++) {
    const pl = planes[k];
    const nx = pl.normal.x;
    const ny = pl.normal.y;
    const nz = pl.normal.z;
    const horiz = Math.hypot(nx, nz) * radius;
    const top = ny > 0 ? ny * maxY : 0;
    if (nx * x + nz * z + horiz + top + pl.constant < 0) return false;
  }
  return true;
}

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
      outOfRangeIntensity: ori = 0.4,
      centerBoost: cb = 0.2,
      randomSpikeIntensity: rsi = 0.3,
      waveFlowIntensity: wfi = 1,
      auroraAudioIntensity: aai = 1,
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
      skyMeshRef = le.useRef(null),
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
      g.translate(0, 0.20, 0);
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

    // 4×4 空间瓦片 + 4×4 微块两级视锥层次：
    //   - 保持最多 16 次地形绘制调用，完全兼容 TILES_DIM=4 网格划分
    //   - 边界瓦片按微块块拷贝 + 逐柱精确紧凑打包，静止视角零 CPU/GPU 开销，动态旋转仅扫描视锥边缘
    const tiles = le.useMemo(() => {
      const half = (m * F) / 2;
      const diskRadiusSq = half * half;
      const subTotal = SUB_DIM * SUB_DIM;
      const buckets = Array.from({ length: TILES_DIM * TILES_DIM }, () => ({
        minX: Infinity,
        maxX: -Infinity,
        minZ: Infinity,
        maxZ: -Infinity,
        minGx: m,
        maxGx: -1,
        minGy: m,
        maxGy: -1,
        totalCount: 0,
        subs: Array.from({ length: subTotal }, () => ({
          coords: [],
          minX: Infinity,
          maxX: -Infinity,
          minZ: Infinity,
          maxZ: -Infinity,
          minGx: m,
          maxGx: -1,
          minGy: m,
          maxGy: -1,
        })),
      }));
      for (let gx = 0; gx < m; gx++) {
        const txF = (gx / m) * TILES_DIM;
        const tx = Math.min(TILES_DIM - 1, Math.floor(txF));
        const sx = Math.min(SUB_DIM - 1, Math.floor((txF - tx) * SUB_DIM));
        const xx = gx * F - half;
        for (let gy = 0; gy < m; gy++) {
          const yy = gy * F - half;
          if (xx * xx + yy * yy <= diskRadiusSq) {
            const tyF = (gy / m) * TILES_DIM;
            const ty = Math.min(TILES_DIM - 1, Math.floor(tyF));
            const sy = Math.min(SUB_DIM - 1, Math.floor((tyF - ty) * SUB_DIM));
            const b = buckets[ty * TILES_DIM + tx];
            const sub = b.subs[sy * SUB_DIM + sx];
            sub.coords.push(xx, yy, gx, gy);
            b.totalCount++;
            if (xx < b.minX) b.minX = xx;
            if (xx > b.maxX) b.maxX = xx;
            if (yy < b.minZ) b.minZ = yy;
            if (yy > b.maxZ) b.maxZ = yy;
            if (gx < b.minGx) b.minGx = gx;
            if (gx > b.maxGx) b.maxGx = gx;
            if (gy < b.minGy) b.minGy = gy;
            if (gy > b.maxGy) b.maxGy = gy;
            if (xx < sub.minX) sub.minX = xx;
            if (xx > sub.maxX) sub.maxX = xx;
            if (yy < sub.minZ) sub.minZ = yy;
            if (yy > sub.maxZ) sub.maxZ = yy;
            if (gx < sub.minGx) sub.minGx = gx;
            if (gx > sub.maxGx) sub.maxGx = gx;
            if (gy < sub.minGy) sub.minGy = gy;
            if (gy > sub.maxGy) sub.maxGy = gy;
          }
        }
      }
      const list = [];
      const pad = P * 0.6;
      for (let i = 0; i < buckets.length; i++) {
        const b = buckets[i];
        const count = b.totalCount;
        if (count === 0) continue;
        const allCoords = new Float32Array(count * 4);
        const microBlocks = [];
        let writeOffset = 0;
        for (let s = 0; s < b.subs.length; s++) {
          const sub = b.subs[s];
          const subCount = sub.coords.length >> 2;
          if (subCount === 0) continue;
          const start = writeOffset;
          allCoords.set(sub.coords, start);
          writeOffset += sub.coords.length;
          microBlocks.push({
            start,
            end: writeOffset,
            count: subCount,
            minX: sub.minX,
            maxX: sub.maxX,
            minZ: sub.minZ,
            maxZ: sub.maxZ,
            minGx: sub.minGx,
            maxGx: sub.maxGx,
            minGy: sub.minGy,
            maxGy: sub.maxGy,
            cx: (sub.minX + sub.maxX) * 0.5,
            cz: (sub.minZ + sub.maxZ) * 0.5,
            distSq: 0,
          });
        }
        const visibleCoords = new Float32Array(allCoords);
        const instAttr = new InstancedBufferAttribute(visibleCoords, 4);
        instAttr.setUsage(DynamicDrawUsage);
        const geo = new InstancedBufferGeometry();
        geo.setAttribute("position", pillarGeo.getAttribute("position"));
        geo.setAttribute("normal", pillarGeo.getAttribute("normal"));
        geo.setAttribute("uv", pillarGeo.getAttribute("uv"));
        geo.setIndex(pillarGeo.getIndex());
        geo.setAttribute("aInstPos", instAttr);
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
          instAttr,
          allCoords,
          visibleCoords,
          microBlocks,
          mbOrder: microBlocks.map((_, idx) => idx),
          totalCount: count,
          visCount: count,
          isCompacted: false,
          minX: b.minX,
          maxX: b.maxX,
          minZ: b.minZ,
          maxZ: b.maxZ,
          minGx: b.minGx,
          maxGx: b.maxGx,
          minGy: b.minGy,
          maxGy: b.maxGy,
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

    // 视锥剔除缓存状态（零 GC；静止视角下跳过全部瓦片/微块/缓冲上传）
    const cullStateRef = le.useRef({
      frustum: new Frustum(),
      viewProj: new jt(),
      prevViewProj: new Float32Array(16),
      planeNX: new Float32Array(6),
      planeNZ: new Float32Array(6),
      planeBias: new Float32Array(6),
      prevMaxY: -1,
      prevTiles: null,
      prevFbo: null,
      ready: false,
      totalVisiblePillars: 0,
      visMinGx: 0,
      visMaxGx: 0,
      visMinGy: 0,
      visMaxGy: 0,
      visCenterX: 0,
      visCenterZ: 0,
      visRadius: 84,
      skyCovered: false,
    });
    const tilesRef = le.useRef(tiles);
    tilesRef.current = tiles;

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
      hitPoint = le.useMemo(() => new j(), []),
      spawnPt = le.useMemo(() => new Xe(), []);

    // 在当前屏幕可见地形盘区域内采样随机点（优先极坐标抽样，退化时直接取可见柱子，零屏幕外浪费）
    const pickVisibleTerrainPoint = le.useCallback(
      (minR, maxR, panOffset, out) => {
        const cs = cullStateRef.current;
        const maxDiskR = W * 0.92;
        const maxDiskRSq = maxDiskR * maxDiskR;
        if (cs.ready) {
          const planes = cs.frustum.planes;
          for (let attempt = 0; attempt < 12; attempt++) {
            const ang = Math.random() * Math.PI * 2;
            const dist = minR + Math.random() * (maxR - minR);
            const rx = Math.cos(ang) * dist + panOffset;
            const rz = Math.sin(ang) * dist;
            if (rx * rx + rz * rz <= maxDiskRSq && isSphereInFrustum(planes, rx, 1.5, rz, -1.5)) {
              out.set(rx, rz);
              return out;
            }
          }
          // 若当前视角较窄/贴近导致极坐标未命中，直接从已剔除的可见柱子中加权随机抽取
          const curTiles = tilesRef.current;
          if (cs.totalVisiblePillars > 0 && curTiles.length > 0) {
            let pick = Math.floor(Math.random() * cs.totalVisiblePillars);
            for (let i = 0; i < curTiles.length; i++) {
              const vc = curTiles[i].visCount;
              if (vc <= 0) continue;
              if (pick < vc) {
                const coords = curTiles[i].visibleCoords;
                out.set(coords[pick * 4], coords[pick * 4 + 1]);
                return out;
              }
              pick -= vc;
            }
          }
        }
        const ang = Math.random() * Math.PI * 2;
        const dist = minR + Math.random() * (maxR - minR);
        out.set(Math.cos(ang) * dist + panOffset, Math.sin(ang) * dist);
        return out;
      },
      [W],
    );

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
          pickVisibleTerrainPoint(14, 52, pan * 10, spawnPt);
          // 音频自动流星采用低空高速切入（飞行约 0.2~0.3s），大幅缩减音画撞击滞后
          spawnMeteorTo(
            spawnPt.x,
            spawnPt.y,
            28 + Math.random() * 10,
            1.65 + Math.random() * 0.35 + strength * 0.38,
            strength,
          );
        },
        [R, spawnMeteorTo, pickVisibleTerrainPoint, spawnPt],
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
          const cs = cullStateRef.current;
          const anchorOffscreen =
            xt.current.initialized &&
            cs.ready &&
            !isSphereInFrustum(cs.frustum.planes, xt.current.x, 1.5, xt.current.z, 4.0);
          if (
            !xt.current.initialized ||
            anchorOffscreen ||
            now - xt.current.lastTriggerTime > Ue ||
            xt.current.hitsRemaining <= 0
          ) {
            // 锚点仅在当前可见区域中内环到外环采样，避开屏幕外不可见波纹浪费
            pickVisibleTerrainPoint(14, 46, pan * 12, spawnPt);
            xt.current.x = spawnPt.x;
            xt.current.z = spawnPt.y;
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
            pickVisibleTerrainPoint(15, 60, 0, spawnPt);
            rx = spawnPt.x;
            rz = spawnPt.y;
          }
          // 保留轻重拍强弱梯度（对应 amp ≈ 0.22..1.0，不再过早顶满）
          ne(rx, rz, Math.min(2.7, Math.max(0.55, val * 2.05)));
        }
      };
    }, [Ht, ne, pickVisibleTerrainPoint, spawnPt]);

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

    // 紧凑打包屏幕内可见实例：仅提交视锥内活跃对象，无可见项时直接隐藏跳过 draw call
    const updateMeteorMatrices = () => {
      const mesh = Y.current;
      if (!mesh) return;
      if (mu.current <= 0) {
        mesh.count = 0;
        mesh.visible = false;
        return;
      }
      const cs = cullStateRef.current;
      const planes = cs.ready ? cs.frustum.planes : null;
      let out = 0;
      for (let k = 0; k < Q; k++) {
        const mt = ze.current[k];
        if (!mt.active) continue;
        const headY = Math.max(0, mt.y);
        const lenScale = 0.85 + Math.min(0.9, mt.speed * 0.35);
        if (planes) {
          const halfTail = 5.75 * lenScale;
          const midX = mt.x - mt.dx * halfTail;
          const midY = headY - mt.dy * halfTail;
          const midZ = mt.z - mt.dz * halfTail;
          if (!isSphereInFrustum(planes, midX, midY, midZ, halfTail + 1.5)) continue;
        }
        Pe.set(mt.x, headY, mt.z);
        velDir.set(-mt.dx, -mt.dy, -mt.dz).normalize();
        ce.setFromUnitVectors(UP_VEC, velDir);
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
      const cs = cullStateRef.current;
      const planes = cs.ready ? cs.frustum.planes : null;
      let out = 0;
      for (let k = 0; k < ae; k++) {
        const p = q.current[k];
        if (!p.active) continue;
        const heat = Math.max(0, 1 - p.life / p.maxLife);
        const s = p.scale * (0.25 + 0.75 * heat);
        if (planes && !isSphereInFrustum(planes, p.x, p.y, p.z, s * 1.5 + 0.5)) continue;
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
      const cs = cullStateRef.current;
      const planes = cs.ready ? cs.frustum.planes : null;
      let out = 0;
      for (let k = 0; k < RING_POOL; k++) {
        const ring = shockRings.current[k];
        if (!ring.active) continue;
        const p = ring.life / ring.maxLife;
        const easeOut = 1 - Math.pow(1 - p, 2.6);
        const rad = 1.4 + easeOut * ring.maxRadius;
        const ringY = ring.y + easeOut * 1.15;
        if (planes && !isSphereInFrustum(planes, ring.x, ringY, ring.z, rad + 0.8)) continue;
        Pe.set(ring.x, ringY, ring.z);
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

      // 0. 相机更新 + 两级视锥剔除（静止视角零 CPU/GPU 缓冲上传；仅渲染屏幕内柱子与 FBO 区域）
      if (h) {
        C.current = (C.current + d * dt) % 360;
        Ye(C.current, c, e);
      }

      const cs = cullStateRef.current;
      A.updateMatrixWorld();
      cs.viewProj.multiplyMatrices(A.projectionMatrix, A.matrixWorldInverse);
      // 基于当前用户参数的保守安全柱高上界（不随帧音频抖动，保证静止视角零重传且屏幕底边零穿帮）
      const maxPillarY = Math.max(6, Math.min(40, 1.5 + (t ? 3.8 : 0) + 14.5 * n + 8.0));

      const vpEl = cs.viewProj.elements;
      const prevEl = cs.prevViewProj;
      let frustumDirty =
        !cs.ready ||
        cs.prevMaxY !== maxPillarY ||
        cs.prevTiles !== tiles ||
        cs.prevFbo !== fboPipe;
      if (!frustumDirty) {
        for (let i = 0; i < 16; i++) {
          if (Math.abs(vpEl[i] - prevEl[i]) > 1e-6) {
            frustumDirty = true;
            break;
          }
        }
      }

      let skyJustRevealed = false;
      if (frustumDirty) {
        prevEl.set(vpEl);
        cs.prevMaxY = maxPillarY;
        cs.prevTiles = tiles;
        cs.prevFbo = fboPipe;
        cs.ready = true;

        cs.frustum.setFromProjectionMatrix(cs.viewProj);
        const planes = cs.frustum.planes;
        const pillarPad = P * 0.6;
        // FBO 额外扩展 3.5 格边距，确保 MapShaderMaterial 5×5 圆盘邻域平滑与 FloorDiscMaterial 2×2 双线性 texel 始终有效
        const fboPad = pillarPad + F * 3.5;
        const pNX = cs.planeNX;
        const pNZ = cs.planeNZ;
        const pBias = cs.planeBias;
        const fboCullUniforms = fboPipe ? fboPipe.simMat.uniforms.uFrustumCull.value : null;
        for (let k = 0; k < 6; k++) {
          const pl = planes[k];
          const nx = pl.normal.x;
          const ny = pl.normal.y;
          const nz = pl.normal.z;
          const topY = ny > 0 ? ny * maxPillarY : 0;
          const absSum = Math.abs(nx) + Math.abs(nz);
          pNX[k] = nx;
          pNZ[k] = nz;
          pBias[k] = absSum * pillarPad + topY + pl.constant;
          if (fboCullUniforms) {
            fboCullUniforms[k].set(nx, nz, absSum * fboPad + topY + pl.constant, 0);
          }
        }

        const p0x = pNX[0], p0z = pNZ[0], p0b = pBias[0];
        const p1x = pNX[1], p1z = pNZ[1], p1b = pBias[1];
        const p2x = pNX[2], p2z = pNZ[2], p2b = pBias[2];
        const p3x = pNX[3], p3z = pNZ[3], p3b = pBias[3];
        const p4x = pNX[4], p4z = pNZ[4], p4b = pBias[4];
        const p5x = pNX[5], p5z = pNZ[5], p5b = pBias[5];

        const camX = A.position.x;
        const camZ = A.position.z;
        let totalVis = 0;
        let totalAll = 0;
        let visTiles = 0;
        let vMinGx = m, vMaxGx = -1, vMinGy = m, vMaxGy = -1;
        let vMinX = Infinity, vMaxX = -Infinity, vMinZ = Infinity, vMaxZ = -Infinity;

        for (let i = 0; i < tiles.length; i++) {
          const tile = tiles[i];
          totalAll += tile.totalCount;
          const dx = tile.cx - camX;
          const dz = tile.cz - camZ;
          tile.distSq = dx * dx + dz * dz;
          const mesh = tileMeshRefs.current[i];

          const tState = classifyBoxFrustum(
            planes,
            tile.minX - pillarPad,
            0,
            tile.minZ - pillarPad,
            tile.maxX + pillarPad,
            maxPillarY,
            tile.maxZ + pillarPad,
          );

          if (tState === 0) {
            tile.visCount = 0;
            tile.geometry.instanceCount = 0;
            if (mesh) mesh.visible = false;
            continue;
          }

          if (tState === 2) {
            if (tile.isCompacted) {
              tile.visibleCoords.set(tile.allCoords);
              tile.instAttr.clearUpdateRanges();
              tile.instAttr.addUpdateRange(0, tile.totalCount * 4);
              tile.instAttr.needsUpdate = true;
              tile.isCompacted = false;
            }
            tile.visCount = tile.totalCount;
            tile.geometry.instanceCount = tile.totalCount;
            if (mesh) mesh.visible = true;
            totalVis += tile.totalCount;
            visTiles++;
            if (tile.minGx < vMinGx) vMinGx = tile.minGx;
            if (tile.maxGx > vMaxGx) vMaxGx = tile.maxGx;
            if (tile.minGy < vMinGy) vMinGy = tile.minGy;
            if (tile.maxGy > vMaxGy) vMaxGy = tile.maxGy;
            if (tile.minX < vMinX) vMinX = tile.minX;
            if (tile.maxX > vMaxX) vMaxX = tile.maxX;
            if (tile.minZ < vMinZ) vMinZ = tile.minZ;
            if (tile.maxZ > vMaxZ) vMaxZ = tile.maxZ;
            continue;
          }

          // 边界相交瓦片：按 4×4 微块由近到远排序，整块拷贝或逐柱 6 平面精确过滤
          const mbs = tile.microBlocks;
          const order = tile.mbOrder;
          for (let s = 0; s < mbs.length; s++) {
            const mb = mbs[s];
            const mdx = mb.cx - camX;
            const mdz = mb.cz - camZ;
            mb.distSq = mdx * mdx + mdz * mdz;
          }
          order.sort((a, b) => mbs[a].distSq - mbs[b].distSq);

          const src = tile.allCoords;
          const dst = tile.visibleCoords;
          let outFloat = 0;

          for (let s = 0; s < order.length; s++) {
            const mb = mbs[order[s]];
            const mbState = classifyBoxFrustum(
              planes,
              mb.minX - pillarPad,
              0,
              mb.minZ - pillarPad,
              mb.maxX + pillarPad,
              maxPillarY,
              mb.maxZ + pillarPad,
            );
            if (mbState === 0) continue;
            if (mbState === 2) {
              const len = mb.end - mb.start;
              dst.set(src.subarray(mb.start, mb.end), outFloat);
              outFloat += len;
              if (mb.minGx < vMinGx) vMinGx = mb.minGx;
              if (mb.maxGx > vMaxGx) vMaxGx = mb.maxGx;
              if (mb.minGy < vMinGy) vMinGy = mb.minGy;
              if (mb.maxGy > vMaxGy) vMaxGy = mb.maxGy;
              if (mb.minX < vMinX) vMinX = mb.minX;
              if (mb.maxX > vMaxX) vMaxX = mb.maxX;
              if (mb.minZ < vMinZ) vMinZ = mb.minZ;
              if (mb.maxZ > vMaxZ) vMaxZ = mb.maxZ;
            } else {
              for (let off = mb.start; off < mb.end; off += 4) {
                const xx = src[off];
                const yy = src[off + 1];
                if (
                  p0x * xx + p0z * yy + p0b >= 0 &&
                  p1x * xx + p1z * yy + p1b >= 0 &&
                  p2x * xx + p2z * yy + p2b >= 0 &&
                  p3x * xx + p3z * yy + p3b >= 0 &&
                  p4x * xx + p4z * yy + p4b >= 0 &&
                  p5x * xx + p5z * yy + p5b >= 0
                ) {
                  const gx = src[off + 2];
                  const gy = src[off + 3];
                  dst[outFloat] = xx;
                  dst[outFloat + 1] = yy;
                  dst[outFloat + 2] = gx;
                  dst[outFloat + 3] = gy;
                  outFloat += 4;
                  if (gx < vMinGx) vMinGx = gx;
                  if (gx > vMaxGx) vMaxGx = gx;
                  if (gy < vMinGy) vMinGy = gy;
                  if (gy > vMaxGy) vMaxGy = gy;
                  if (xx < vMinX) vMinX = xx;
                  if (xx > vMaxX) vMaxX = xx;
                  if (yy < vMinZ) vMinZ = yy;
                  if (yy > vMaxZ) vMaxZ = yy;
                }
              }
            }
          }

          const vc = outFloat >> 2;
          tile.visCount = vc;
          tile.geometry.instanceCount = vc;
          tile.isCompacted = true;
          if (mesh) mesh.visible = vc > 0;
          if (vc > 0) {
            tile.instAttr.clearUpdateRanges();
            tile.instAttr.addUpdateRange(0, outFloat);
            tile.instAttr.needsUpdate = true;
            totalVis += vc;
            visTiles++;
          }
        }

        // 从近到远排布可见瓦片绘制顺序（硬件 Early-Z 消除柱体自遮挡 Overdraw）
        tileOrder.sort((a, b) => tiles[a].distSq - tiles[b].distSq);
        for (let rank = 0; rank < tileOrder.length; rank++) {
          const mesh = tileMeshRefs.current[tileOrder[rank]];
          if (mesh) mesh.renderOrder = 10 + rank;
        }

        cs.totalVisiblePillars = totalVis;
        if (totalVis > 0) {
          cs.visMinGx = vMinGx;
          cs.visMaxGx = vMaxGx;
          cs.visMinGy = vMinGy;
          cs.visMaxGy = vMaxGy;
          cs.visCenterX = (vMinX + vMaxX) * 0.5;
          cs.visCenterZ = (vMinZ + vMaxZ) * 0.5;
          cs.visRadius = Math.hypot((vMaxX - vMinX) * 0.5, (vMaxZ - vMinZ) * 0.5) + pillarPad;
        } else {
          cs.visMinGx = 0;
          cs.visMaxGx = -1;
          cs.visMinGy = 0;
          cs.visMaxGy = -1;
          cs.visCenterX = 0;
          cs.visCenterZ = 0;
          cs.visRadius = 0;
        }

        // 配置 FBO 硬件 Scissor 矩形（仅光栅化可见柱群外接网格 + 4 格邻域平滑安全边距）
        let scW = 0, scH = 0;
        if (fboPipe) {
          if (totalVis > 0) {
            const scMinX = Math.max(0, vMinGx - 4);
            const scMaxX = Math.min(m - 1, vMaxGx + 4);
            const scMinY = Math.max(0, vMinGy - 4);
            const scMaxY = Math.min(m - 1, vMaxGy + 4);
            scW = scMaxX - scMinX + 1;
            scH = scMaxY - scMinY + 1;
            fboPipe.simRT.scissorTest = true;
            fboPipe.simRT.scissor.set(scMinX, scMinY, scW, scH);
          } else {
            fboPipe.simRT.scissorTest = true;
            fboPipe.simRT.scissor.set(0, 0, 0, 0);
          }
        }

        // 检测屏幕四角是否 100% 落入不透明底盘圆内（纯俯视/极近视角时直接跳过天空绘制与 uniform 计算）
        const floorSafeR = Math.max(1, W - F * 0.75 - 1.5);
        const floorSafeRSq = floorSafeR * floorSafeR;
        let allCornersCovered = true;
        for (let ci = 0; ci < 4; ci++) {
          raycaster.setFromCamera(SKY_CORNERS[ci], A);
          const dirY = raycaster.ray.direction.y;
          if (dirY >= -1e-4) {
            allCornersCovered = false;
            break;
          }
          const tHit = (0.20 - raycaster.ray.origin.y) / dirY;
          if (tHit <= 0) {
            allCornersCovered = false;
            break;
          }
          const hx = raycaster.ray.origin.x + raycaster.ray.direction.x * tHit;
          const hz = raycaster.ray.origin.z + raycaster.ray.direction.z * tHit;
          if (hx * hx + hz * hz > floorSafeRSq) {
            allCornersCovered = false;
            break;
          }
        }
        if (cs.skyCovered && !allCornersCovered) skyJustRevealed = true;
        cs.skyCovered = allCornersCovered;
        if (skyMeshRef.current) skyMeshRef.current.visible = !allCornersCovered;

        // 轻量只读诊断快照（供性能验证脚本读取，仅在视角变化时写入）
        if (typeof window !== "undefined") {
          window.__soundCullStats = {
            gridSize: m,
            totalPillars: totalAll,
            visiblePillars: totalVis,
            visibleRatio: totalAll > 0 ? totalVis / totalAll : 0,
            visibleTiles: visTiles,
            totalTiles: tiles.length,
            fboScissorRatio: m > 0 ? (scW * scH) / (m * m) : 0,
            skyCovered: allCornersCovered,
          };
        }
      }

      const frustumPlanes = cs.frustum.planes;

      // 1. 物理更新：流星 / 火花 / 冲击波（空闲跳过全部循环，屏幕外流星不生成不可见拖尾/爆裂粒子）
      const meteorsHad = mu.current > 0;
      if (meteorsHad) {
        const safeRange = Math.max(0.05, r);
        const subRadius = Math.max(1, W * 0.24 * safeRange);
        const bassCenter = W * 0.22 * safeRange;
        const bassSpan = Math.max(1, W * 0.24 * safeRange);
        const outStart = W * 0.45 * safeRange;
        const outSpan = Math.max(1e-4, W * 0.40 * safeRange);
        const outClamp = Math.max(0, Math.min(2, ori));
        const centerRadius = Math.max(1e-4, W * 0.45 * safeRange);
        const centerClamp = Math.max(-0.5, Math.min(0.5, cb));
        const waveClamp = Math.max(0, Math.min(2, wfi));
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
          const outT = Math.max(0, Math.min(1, (dist - outStart) / outSpan));
          const smoothOut = outT * outT * (3 - 2 * outT);
          const outGain = 1 + (outClamp - 1) * smoothOut;
          const cT = Math.max(0, Math.min(1, 1 - dist / centerRadius));
          const smoothCenter = cT * cT * (3 - 2 * cT);
          const centerGain = Math.max(0, 1 + centerClamp * smoothCenter);
          const estSurfaceY = Math.min(
            6.5,
            0.5 +
              (nt.subBass * 4.2 * subF + nt.bass * 3.0 * bassF + nt.lowMid * 1.4 * waveClamp) *
                n *
                outGain *
                centerGain,
          );
          if (mt.y <= estSurfaceY) {
            mt.active = !1;
            mu.current--;
            ne(mt.x, mt.z, Math.min(2.7, Math.max(0.95, mt.strength * 1.15)), !0);
            const ringMaxR = 8.5 + Math.min(9.5, mt.strength * 3.2);
            if (isSphereInFrustum(frustumPlanes, mt.x, estSurfaceY + 1.0, mt.z, ringMaxR + 2.0)) {
              spawnShockRing(mt.x, estSurfaceY + 0.55, mt.z, mt.strength);
            }
            if (isSphereInFrustum(frustumPlanes, mt.x, estSurfaceY + 2.0, mt.z, 8.0)) {
              for (let s = 0; s < 14; s++) Se(mt.x, estSurfaceY + 0.45, mt.z, mt.speed * 1.15, !0);
            }
          } else if (
            Math.random() > 0.32 &&
            isSphereInFrustum(frustumPlanes, mt.x, mt.y, mt.z, 4.0)
          ) {
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

      // 3. 活跃波纹视锥与环带精确打包（仅提交当前能触及屏幕内可见柱子的波纹，无可见波纹零 GPU 循环）
      const qe = mapMat;
      let activeCount = 0;
      if (activeRippleSlots.current > 0 && cs.totalVisiblePillars > 0) {
        const geoArr = qe.uniforms.uRippleGeo.value;
        const paramArr = qe.uniforms.uRippleParam.value;
        const visCX = cs.visCenterX;
        const visCZ = cs.visCenterZ;
        const visR = cs.visRadius;
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
          // 环带 [waveRadius - 12, waveRadius + 12] 与屏幕可见地形圈及视锥 6 平面相交校验
          const outerR = waveRadius + 12.0;
          const innerR = Math.max(0, waveRadius - 12.0);
          const dVis = Math.hypot(s.x - visCX, s.z - visCZ);
          if (dVis - visR > outerR || dVis + visR < innerR) continue;
          if (!isRippleDiskInFrustum(frustumPlanes, s.x, s.z, outerR, maxPillarY)) continue;

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

      // 5. GPU 离屏高度场烘焙（硬件 Scissor + 6 平面视锥丢弃，仅模拟屏幕可见柱子）
      if (fboPipe) {
        const prevRT = E.getRenderTarget();
        const prevAutoClear = E.autoClear;
        E.autoClear = false;
        if (!fboPipe.staticBaked) {
          E.setRenderTarget(fboPipe.staticRT);
          E.render(fboPipe.staticScene, fboPipe.fsCamera);
          fboPipe.staticBaked = true;
        }
        if (cs.totalVisiblePillars > 0) {
          const sm = fboPipe.simMat;
          sm.uTime = elapsed;
          sm.uIdleWave = idleVal;
          sm.uAudioIntensity = n;
          sm.uResponseRange = r;
          sm.uOutOfRangeIntensity = ori;
          sm.uCenterBoost = cb;
          sm.uRandomSpikeIntensity = rsi;
          sm.uWaveFlowIntensity = wfi;
          sm.uPeakEnabled = v ? 1 : 0;
          sm.uPeakIntensity = y;
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
        }
        E.setRenderTarget(prevRT);
        E.autoClear = prevAutoClear;

        qe.uUseFbo = 1;
        qe.uSimTex0 = fboPipe.simRT.textures[0];
        qe.uSimTex1 = fboPipe.simRT.textures[1];
        qe.uGridSize = m;
        qe.uAudioIntensity = n;
        qe.uSubBass = nt.subBass;
        qe.uBass = nt.bass;
        qe.uLowMid = nt.lowMid;
        qe.uMid = nt.mid;
      } else {
        qe.uUseFbo = 0;
        qe.uGridSize = m;
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
        qe.uOutOfRangeIntensity = ori;
        qe.uCenterBoost = cb;
        qe.uRandomSpikeIntensity = rsi;
        qe.uWaveFlowIntensity = wfi;
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
      floorMat.uSimTex1 = qe.uSimTex1;
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

      // 6. Early-Z 全屏单三角形天空（纯俯视满屏覆盖时直接跳过绘制与 uniform 更新）
      if (sb.current && !cs.skyCovered) {
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

        if (colorDirty || skyJustRevealed) {
          su.uFogColor.value.copy(qe.uBaseColor1);
          su.uBaseColor2.value.copy(qe.uBaseColor2);
          su.uNebulaA.value.copy(qe.uCoolCore);
          su.uNebulaB.value.copy(qe.uWarmCore);
          su.uPeakColor.value.copy(qe.uPeakColor);
          su.uGlow.value = qe.uGlowIntensity;
        }
        const auroraScale = Math.max(0, Math.min(2.5, aai));
        su.uAudioResp.value =
          Math.min(1, nt.air * 0.45 + nt.treble * 0.45 + nt.energy * 0.25) * 0.42 * auroraScale;
        su.uBassResp.value = Math.min(1, nt.subBass * 0.6 + nt.bass * 0.5) * auroraScale;
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
        // 1. 4×4 空间瓦片音域地形（由自研两级视锥剔除精确控制 visible 与 instanceCount）
        tiles.map((tile, idx) =>
          Dt.jsx(
            "mesh",
            {
              ref: (el) => {
                tileMeshRefs.current[idx] = el;
              },
              geometry: tile.geometry,
              material: mapMat,
              frustumCulled: !1,
              renderOrder: 10 + idx,
            },
            tile.id,
          ),
        ),
        // 1B. Early-Z 主题暗底承托圆盘（排在柱群之后、天空之前，消除轴向对齐黑缝且零过绘）
        Dt.jsx("mesh", {
          geometry: floorGeo,
          material: floorMat,
          frustumCulled: !0,
          renderOrder: 28,
        }),
        // 2. 全屏单三角形 Early-Z 天空（排在地形柱与底盘之后，被遮挡区域零片元计算；满屏覆盖时直接隐藏）
        Dt.jsx("mesh", {
          ref: skyMeshRef,
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
