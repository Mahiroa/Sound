// 模块: shaders.js
// 高性能 GLSL 着色器与材质定义:
//   - StaticPillarBakeMaterial 一次性静态预烘焙（centerDist, rnd, riverNoise, colorVar）
//   - HeightfieldSimMaterial   160×160 离屏高度场模拟（每柱仅算 1 次噪声+波纹，GPU ALU -95%）
//   - MapShaderMaterial        3D 音域地形柱（16B 紧凑实例属性、逐柱色算前移顶点、精简片元）
//   - FloorDiscMaterial        Early-Z 主题暗底承托圆盘（消除轴向对齐黑缝，与地形共享空气透视）
//   - SkyShaderMaterial        全屏单三角形 Early-Z 天空（视角自适应曲率地平线 + 全屏主题暗底，零黑边裁剪）
//   - MeteorShaderMaterial     炽热等离子彗星流星
//   - SparkShaderMaterial      流星撞击火花/余烬
//   - ShockRingMaterial        流星撞击地面光环冲击波
import {
  ShaderMaterial as Jr,
  Uniform as T_,
  UniformsUtils as N1,
  MathUtils as e_,
  Matrix3,
  Matrix4,
  Vector2 as V2,
  Vector4 as V4,
  Color as se,
  GLSL3,
} from "three";

function createShaderMaterial(uniformDefaults, vertexShader, fragmentShader, extraOpts = {}) {
  let MaterialClass;
  return (
    (MaterialClass = class extends Jr {
      constructor(props) {
        super({ vertexShader, fragmentShader, ...extraOpts, ...props });
        for (const key in uniformDefaults)
          ((this.uniforms[key] = new T_(uniformDefaults[key])),
            Object.defineProperty(this, key, {
              get() {
                return this.uniforms[key].value;
              },
              set(value) {
                this.uniforms[key].value = value;
              },
            }));
        this.uniforms = N1.clone(this.uniforms);
      }
    }),
    (MaterialClass.key = e_.generateUUID()),
    MaterialClass
  );
}

// 公共 GLSL 片段: 2D Simplex Noise
const GLSL_SNOISE = `
  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }
  float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
    vec2 i  = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289(i);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
    m = m * m;
    m = m * m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
    vec3 g;
    g.x  = a0.x * x0.x + h.x * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }
`;

// 公共 GLSL 片段: 电影感高光柔和滚降 + IGN 8-bit 去色带抖动
const GLSL_FILMIC = `
  vec3 acesSoft(vec3 x) {
    vec3 mapped = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
    float luma = dot(x, vec3(0.2126, 0.7152, 0.0722));
    vec3 satKeep = x / (1.0 + luma * 0.48);
    return clamp(mix(satKeep, mapped, 0.42), 0.0, 1.0);
  }
  float ignDither(vec2 fragCoord) {
    return fract(52.9829189 * fract(dot(fragCoord, vec2(0.06711056, 0.00583715))));
  }
`;

// 公共 GLSL 片段: 高度场缓动函数
const GLSL_LIFTS = `
  float easeLift(float raw, float maxHeight) {
    float x = clamp(raw, 0.0, 1.0);
    float inv = 1.0 - x;
    float eased = 1.0 - inv * inv;
    float bounce = sin(x * 3.14159) * (x * x) * 0.35;
    return (eased + bounce) * maxHeight;
  }

  float flowLift(float raw, float maxHeight) {
    float x = clamp(raw, 0.0, 1.0);
    float eased = pow(x, 0.75);
    float breathe = sin(x * 3.14159) * 0.12;
    return (eased + breathe) * maxHeight;
  }
`;

// 全屏三角形通用 GLSL3 顶点着色器（用于离屏烘焙 pass）
const FULLSCREEN_VS_GLSL3 = `
  void main() {
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// ============================================================
// 0A. StaticPillarBakeMaterial — gridSize 变更时一次性静态预烘焙
//     输出 RGBA16F: r = centerDist, g = rnd, b = riverNoise, a = colorVariation
// ============================================================
const StaticPillarBakeMaterial = createShaderMaterial(
  {
    uGridStep: 1.05,
    uHalfExtent: 84.0,
  },
  FULLSCREEN_VS_GLSL3,
  `
    precision highp float;
    uniform float uGridStep;
    uniform float uHalfExtent;
    layout(location = 0) out vec4 outStatic;

    ${GLSL_SNOISE}

    float random(vec2 st) {
      return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
    }

    void main() {
      vec2 gridCoord = floor(gl_FragCoord.xy);
      vec2 pos2D = gridCoord * uGridStep - vec2(uHalfExtent);
      float centerDist = length(pos2D);
      float rnd = random(pos2D);
      float riverNoise = snoise(pos2D * 0.095);
      float colorVar = sin(pos2D.x * 0.075 + pos2D.y * 0.058) * 0.5 + 0.5;
      outStatic = vec4(centerDist, rnd, riverNoise, colorVar);
    }
  `,
  { glslVersion: GLSL3, depthTest: false, depthWrite: false },
);

// ============================================================
// 0B. HeightfieldSimMaterial — 每帧 m×m 离屏高度场模拟 (MRT count=2)
//     每根柱子仅执行 1 次噪声+频段+波纹，彻底消除 20 顶点重复计算 (-95% GPU ALU)
//     outSim0 = vec4(elevation, peakIntensity, rippleNormal, rippleWhite)
//     outSim1 = vec4(rippleCrest, colorVar, centerDist, 1.0)
// ============================================================
const HeightfieldSimMaterial = createShaderMaterial(
  {
    uStaticTex: null,
    uGridStep: 1.05,
    uHalfExtent: 84.0,
    uTime: 0,
    uIdleWave: 0,
    uAudioIntensity: 1,
    uResponseRange: 1,
    uOutOfRangeIntensity: 0.4,
    uCenterBoost: 0.2,
    uRandomSpikeIntensity: 0.3,
    uWaveFlowIntensity: 1,
    uSubBass: 0,
    uBass: 0,
    uLowMid: 0,
    uMid: 0,
    uHighMid: 0,
    uTreble: 0,
    uSmoothness: 0,
    uDensity: 0,
    uEnergy: 0,
    uActiveRipples: 0,
    uRippleGeo: Array.from({ length: 20 }, () => new V4(0, 0, 0, 0)),
    uRippleParam: Array.from({ length: 20 }, () => new V4(0.2, 0, 3.0, 12.0)),
    uFrustumCull: Array.from({ length: 6 }, () => new V4(0, 0, 1, 0)),
  },
  FULLSCREEN_VS_GLSL3,
  `
    precision highp float;
    uniform sampler2D uStaticTex;
    uniform float uGridStep;
    uniform float uHalfExtent;
    uniform float uTime;
    uniform float uIdleWave;
    uniform float uAudioIntensity;
    uniform float uResponseRange;
    uniform float uOutOfRangeIntensity;
    uniform float uCenterBoost;
    uniform float uRandomSpikeIntensity;
    uniform float uWaveFlowIntensity;

    uniform float uSubBass;
    uniform float uBass;
    uniform float uLowMid;
    uniform float uMid;
    uniform float uHighMid;
    uniform float uTreble;
    uniform float uSmoothness;
    uniform float uDensity;
    uniform float uEnergy;

    uniform int uActiveRipples;
    uniform vec4 uRippleGeo[20];
    uniform vec4 uRippleParam[20];
    uniform vec4 uFrustumCull[6];

    layout(location = 0) out vec4 outSim0;
    layout(location = 1) out vec4 outSim1;

    ${GLSL_SNOISE}
    ${GLSL_LIFTS}

    void main() {
      ivec2 cell = ivec2(gl_FragCoord.xy);
      vec4 st = texelFetch(uStaticTex, cell, 0);
      float centerDist = st.r;

      // 圆盘外网格直接早退，省去 ~21.5% 噪声与波纹开销
      if (centerDist > uHalfExtent + 0.01) {
        outSim0 = vec4(0.0);
        outSim1 = vec4(0.0);
        return;
      }

      vec2 pos2D = vec2(cell) * uGridStep - vec2(uHalfExtent);

      // 视锥 6 平面精确剔除：屏幕外柱子直接丢弃，零噪声/频段/波纹计算与 MRT 写出
      for (int p = 0; p < 6; p++) {
        vec4 pl = uFrustumCull[p];
        if (dot(pl.xy, pos2D) + pl.z < 0.0) {
          discard;
        }
      }
      float rnd = st.g;
      float riverNoise = st.b;
      float colorVar = st.a;

      float range = max(uResponseRange, 0.05);
      float falloffT = smoothstep(uHalfExtent * 0.32 * range, uHalfExtent * 0.90 * range, centerDist);
      float globalFalloff = mix(1.0, 0.76, falloffT);
      // 非响应范围（超出 responseRange 外围区域）独立音频强度系数：拉开响应区与非响应区层次对比
      float outRangeT = smoothstep(uHalfExtent * 0.45 * range, uHalfExtent * 0.85 * range, centerDist);
      float audioRangeFalloff = mix(1.0, clamp(uOutOfRangeIntensity, 0.0, 2.0), outRangeT);
      // 响应区域中心增强：在响应区内核 [0, 0.45 * range] 内按 -0.5~0.5 增益平滑叠加
      float centerMask = smoothstep(uHalfExtent * 0.45 * range, 0.0, centerDist);
      float centerGain = max(0.0, 1.0 + clamp(uCenterBoost, -0.5, 0.5) * centerMask);
      // 音频随机起落幅值与外围孤立尖柱二次收敛（保持外围暗海沉稳整洁）
      float spikeScale = clamp(uRandomSpikeIntensity, 0.0, 2.0);
      float outerSpikeDamp = mix(1.0, 0.35, outRangeT);
      float spikeWeight = spikeScale * outerSpikeDamp;
      // 规律流河/波动（lowMid 全场涌浪 + mid 对角线波带）独立幅值控制
      float waveScale = clamp(uWaveFlowIntensity, 0.0, 2.0);
      // 圆盘最外圈平滑收坡，避免地平线边缘出现突兀锯齿柱墙
      float outerSkirt = mix(0.28, 1.0, smoothstep(uHalfExtent, uHalfExtent * 0.80, centerDist));

      // 1. 空闲涌动（舒展大波长起伏 + 极低逐柱抖动，消除远景细碎噪点）
      float idleElevation = 0.0;
      float idleBlockWave = 0.0;
      if (uIdleWave > 0.001) {
        vec2 movingPos = pos2D * 0.034 + vec2(uTime * 0.075, uTime * 0.040);
        float baseNoise = (snoise(movingPos) + 1.0) * 0.5;
        float wave = snoise(pos2D * 0.068 - vec2(uTime * 0.095, -uTime * 0.055)) * 0.5 + 0.5;
        float swellA = sin(pos2D.x * 0.042 + pos2D.y * 0.026 - uTime * 0.38 + baseNoise * 1.9) * 0.5 + 0.5;
        float swellB = sin(centerDist * 0.062 - uTime * 0.48 + wave * 1.2) * 0.5 + 0.5;
        idleElevation = mix(baseNoise, wave, uSmoothness * 0.5 + 0.2) * 0.72 * globalFalloff * outerSkirt * uIdleWave;
        float combinedWave = baseNoise * 0.42 + wave * 0.22 + swellA * 0.22 + swellB * 0.14 + (rnd - 0.5) * 0.035;
        combinedWave = smoothstep(0.14, 0.88, combinedWave);
        idleBlockWave = combinedWave * uIdleWave * 2.85 * globalFalloff * outerSkirt;
      }

      // 2. 分层频段地形响应（内核 SubBass -> 内环 Bass -> 全场 LowMid -> 中环流河 Mid -> 外环尖刺 HighMid -> 外缘星光 Treble）
      float subLift = 0.0;
      float bassLift = 0.0;
      float lowMidLift = 0.0;
      float midLift = 0.0;
      float highMidLift = 0.0;
      float trebleLift = 0.0;
      float audioElevation = 0.0;

      if (uAudioIntensity > 0.001) {
        if (uSubBass > 0.001) {
          float subRegion = smoothstep(uHalfExtent * 0.24 * range, 0.0, centerDist);
          subLift = easeLift(uSubBass, 5.2) * subRegion;
        }
        if (uBass > 0.001) {
          float bassNoise = snoise(pos2D * 0.095 - vec2(0.0, uTime * 0.22));
          float bassInner = smoothstep(uHalfExtent * 0.06 * range, uHalfExtent * 0.20 * range, centerDist);
          float bassOuter = smoothstep(uHalfExtent * 0.46 * range, uHalfExtent * 0.16 * range, centerDist + bassNoise * 5.2);
          float bassRegion = mix(0.32, 1.0, bassInner) * bassOuter;
          float bassRndRaw = smoothstep(0.0, 1.0, mix(rnd, 0.65, uSmoothness * 0.35) + uDensity * 0.45);
          float bassRnd = mix(0.76, bassRndRaw, min(spikeScale, 1.0));
          bassLift = easeLift(uBass, 4.6) * bassRegion * bassRnd;
        }
        if (uLowMid > 0.001 && waveScale > 0.001) {
          float lowMidNoise = snoise(pos2D * 0.05 + vec2(uTime * 0.1, 0.0));
          lowMidLift = flowLift(uLowMid, 2.7) * (lowMidNoise * 0.5 + 0.5) * waveScale;
        }
        if (uMid > 0.001 && waveScale > 0.001) {
          float riverFlow = sin(pos2D.x * 0.19 + pos2D.y * 0.19 + riverNoise * 2.1 - uTime * 1.9);
          float midRing = smoothstep(uHalfExtent * 0.08 * range, uHalfExtent * 0.26 * range, centerDist)
                        * smoothstep(uHalfExtent * 0.92 * range, uHalfExtent * 0.56 * range, centerDist);
          midLift = flowLift(uMid, 3.6) * smoothstep(-0.18, 0.18, riverFlow) * mix(0.42, 1.0, midRing) * waveScale;
        }
        if (uHighMid > 0.001 && spikeWeight > 0.001 && fract(rnd * 13.3) > 0.74) {
          float highMidRegion = smoothstep(uHalfExtent * 0.22 * range, uHalfExtent * 0.68 * range, centerDist);
          float hmRaw = easeLift(uHighMid, 3.4);
          highMidLift = hmRaw * highMidRegion * (0.28 + 0.72 * fract(rnd * 7.7)) * spikeWeight;
        }
        if (uTreble > 0.001 && spikeWeight > 0.001) {
          float trebleRegion = smoothstep(uHalfExtent * 0.40 * range, uHalfExtent * 0.78 * range, centerDist);
          float sparkle = sin(pos2D.x * 0.34 - pos2D.y * 0.29 + uTime * 3.8 + rnd * 6.283) * 0.5 + 0.5;
          float trebleGate = smoothstep(0.32, 0.95, fract(rnd * 19.7));
          trebleLift = easeLift(uTreble, 3.0) * trebleRegion * mix(0.28, 1.0, sparkle) * (0.35 + 0.65 * trebleGate) * spikeWeight;
        }

        audioElevation = (subLift + bassLift + lowMidLift + midLift + highMidLift + trebleLift) * uAudioIntensity;

        if (uEnergy > 0.001 && spikeWeight > 0.001 && rnd > 0.986) {
          float energyRaw = clamp(uEnergy, 0.0, 1.0);
          float energyBounce = 1.0 - pow(1.0 - energyRaw, 1.5);
          energyBounce += sin(energyRaw * 6.283 * 2.0) * exp(-energyRaw * 5.0) * 0.2;
          audioElevation += energyBounce * 4.8 * uAudioIntensity * spikeWeight;
        }
        audioElevation *= audioRangeFalloff * centerGain * outerSkirt;
      }

      float subPeak = clamp((subLift * centerGain) / 4.8, 0.0, 1.0);
      float globalPeak = clamp((audioElevation - 3.8) / 5.2, 0.0, 1.0);
      float peakIntensity = clamp(max(subPeak, globalPeak * 0.85), 0.0, 1.0);

      float elevation = idleElevation + audioElevation + idleBlockWave;

      // 3. 双谐波物理波纹
      float rippleElevation = 0.0;
      float rippleIntensityNormal = 0.0;
      float rippleIntensityWhite = 0.0;
      float rippleCrest = 0.0;

      for (int i = 0; i < 20; i++) {
        if (i >= uActiveRipples) break;
        vec4 geo = uRippleGeo[i];
        float d = length(pos2D - geo.xy) - geo.z;
        vec4 param = uRippleParam[i];

        if (abs(d) < param.w) {
          float mainWave = exp(-d * d * param.x);
          float dTrail = d + 3.4;
          float trailWave = 0.26 * exp(-dTrail * dTrail * param.x * 1.35) * step(d, 0.5);
          float sharpFront = exp(-d * d * param.x * 4.2);

          float rPulse = (mainWave + trailWave) * geo.w;
          rippleElevation += rPulse * param.z;
          rippleCrest += sharpFront * geo.w;

          if (param.y > 0.5) {
            rippleIntensityWhite += rPulse;
          } else {
            rippleIntensityNormal += rPulse;
          }
        }
      }

      elevation += rippleElevation;
      outSim0 = vec4(
        elevation,
        peakIntensity,
        clamp(sqrt(rippleIntensityNormal), 0.0, 1.0),
        clamp(sqrt(rippleIntensityWhite), 0.0, 1.0)
      );
      outSim1 = vec4(
        clamp(sqrt(rippleCrest), 0.0, 1.0),
        colorVar,
        centerDist,
        1.0
      );
    }
  `,
  { glslVersion: GLSL3, depthTest: false, depthWrite: false },
);

// ============================================================
// 1. MapShaderMaterial — 音域地形柱材质
//    - 使用 16B 紧凑实例属性 aInstPos (xx, yy, gx, gy)，省 75% 实例缓冲带宽
//    - FBO 模式下顶点着色器 2 次 texelFetch 直接取高度/波纹，自动回退内联计算
//    - 所有逐柱恒定色彩/能量/波纹叠加前移顶点着色器，片元着色器 ALU -55%
// ============================================================
const MapShaderMaterial = createShaderMaterial(
  {
    uUseFbo: 0,
    uSimTex0: null,
    uSimTex1: null,
    uTime: 0,
    uSubBass: 0,
    uBass: 0,
    uLowMid: 0,
    uMid: 0,
    uHighMid: 0,
    uTreble: 0,
    uWarmth: 0,
    uBrightness: 0,
    uSmoothness: 0,
    uDensity: 0,
    uEnergy: 0,
    uIdleWave: 0,
    uAudioIntensity: 1,
    uResponseRange: 1,
    uOutOfRangeIntensity: 0.4,
    uCenterBoost: 0.2,
    uRandomSpikeIntensity: 0.3,
    uWaveFlowIntensity: 1,
    uHalfExtent: 84,
    uActiveRipples: 0,
    uRippleGeo: Array.from({ length: 20 }, () => new V4(0, 0, 0, 0)),
    uRippleParam: Array.from({ length: 20 }, () => new V4(0.2, 0, 3.0, 12.0)),
    uBaseColor1: new se(0.01, 0.02, 0.04),
    uBaseColor2: new se(0.03, 0.05, 0.09),
    uCoolCore: new se(0, 0.3, 1),
    uCoolEdge: new se(0.6, 0.2, 1),
    uWarmCore: new se(1, 0.2, 0.1),
    uWarmEdge: new se(1, 0.6, 0),
    uMidCore: new se(0.6, 0.25, 0.9),
    uMidEdge: new se(0.35, 0.12, 0.65),
    uRippleColor: new se(0.2, 0.9, 1),
    uPeakColor: new se(1, 1, 1),
    uGlowIntensity: 1,
    uPeakEnabled: 1,
    uPeakIntensity: 1,
    uLowPillarDim: 0.35,
  },
  `
    in vec4 aInstPos; // xy = world xz, zw = grid index (gx, gy)

    uniform float uUseFbo;
    uniform sampler2D uSimTex0;
    uniform sampler2D uSimTex1;

    uniform float uTime;
    uniform float uIdleWave;
    uniform float uAudioIntensity;
    uniform float uResponseRange;
    uniform float uOutOfRangeIntensity;
    uniform float uCenterBoost;
    uniform float uRandomSpikeIntensity;
    uniform float uWaveFlowIntensity;
    uniform float uHalfExtent;

    uniform float uSubBass;
    uniform float uBass;
    uniform float uLowMid;
    uniform float uMid;
    uniform float uHighMid;
    uniform float uTreble;
    uniform float uSmoothness;
    uniform float uDensity;
    uniform float uEnergy;
    uniform float uWarmth;
    uniform float uBrightness;

    uniform int uActiveRipples;
    uniform vec4 uRippleGeo[20];
    uniform vec4 uRippleParam[20];

    uniform vec3 uBaseColor1;
    uniform vec3 uBaseColor2;
    uniform vec3 uCoolCore;
    uniform vec3 uCoolEdge;
    uniform vec3 uWarmCore;
    uniform vec3 uWarmEdge;
    uniform vec3 uMidCore;
    uniform vec3 uMidEdge;
    uniform vec3 uRippleColor;
    uniform vec3 uPeakColor;
    uniform float uGlowIntensity;
    uniform float uPeakEnabled;
    uniform float uPeakIntensity;
    uniform float uLowPillarDim;

    out vec2 vUv;
    out vec3 vNormal;
    out vec2 vHeightInfo; // x=relativeY, y=totalHeight
    out vec3 vWorldPos;
    // 逐柱不变量前移顶点着色器（避免每帧数百万次片元重复计算）
    out vec3 vCurrentGlow;
    out vec3 vTargetGlow;
    out vec3 vRippleAdd;
    out vec4 vPillarA; // x=normElevation, y=lowHeightDim, z=distFade, w=peakClamped
    out vec4 vPillarB; // x=rippleLift, y=idleCrest, z=aerialFog, w=peakBlend
    out vec3 vFaceLight; // x=sideDirShade, y=sideLightMod, z=warmBlend

    ${GLSL_SNOISE}
    ${GLSL_LIFTS}

    float random(vec2 st) {
      return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
    }

    void main() {
      vUv = uv;
      vNormal = normal;

      vec2 pos2D = aInstPos.xy;
      float elevation;
      float peakIntensity;
      vec3 rippleAnim;
      float colorVariation;
      float centerDist;

      if (uUseFbo > 0.5) {
        ivec2 cell = ivec2(aInstPos.zw + 0.5);
        vec4 sim0 = texelFetch(uSimTex0, cell, 0);
        vec4 sim1 = texelFetch(uSimTex1, cell, 0);
        elevation = sim0.x;
        peakIntensity = sim0.y;
        rippleAnim = vec3(sim0.z, sim0.w, sim1.x);
        colorVariation = sim1.y;
        centerDist = sim1.z;
      } else {
        // 无半浮点 FBO 支持时的完整回退路径
        centerDist = length(pos2D);
        float rnd = random(pos2D);
        colorVariation = sin(pos2D.x * 0.075 + pos2D.y * 0.058) * 0.5 + 0.5;

        float range = max(uResponseRange, 0.05);
        float falloffT = smoothstep(uHalfExtent * 0.32 * range, uHalfExtent * 0.90 * range, centerDist);
        float globalFalloff = mix(1.0, 0.76, falloffT);
        float outRangeT = smoothstep(uHalfExtent * 0.45 * range, uHalfExtent * 0.85 * range, centerDist);
        float audioRangeFalloff = mix(1.0, clamp(uOutOfRangeIntensity, 0.0, 2.0), outRangeT);
        float centerMask = smoothstep(uHalfExtent * 0.45 * range, 0.0, centerDist);
        float centerGain = max(0.0, 1.0 + clamp(uCenterBoost, -0.5, 0.5) * centerMask);
        float spikeScale = clamp(uRandomSpikeIntensity, 0.0, 2.0);
        float outerSpikeDamp = mix(1.0, 0.35, outRangeT);
        float spikeWeight = spikeScale * outerSpikeDamp;
        float waveScale = clamp(uWaveFlowIntensity, 0.0, 2.0);
        float outerSkirt = mix(0.28, 1.0, smoothstep(uHalfExtent, uHalfExtent * 0.80, centerDist));

        float idleElevation = 0.0;
        float idleBlockWave = 0.0;
        if (uIdleWave > 0.001) {
          vec2 movingPos = pos2D * 0.034 + vec2(uTime * 0.075, uTime * 0.040);
          float baseNoise = (snoise(movingPos) + 1.0) * 0.5;
          float wave = snoise(pos2D * 0.068 - vec2(uTime * 0.095, -uTime * 0.055)) * 0.5 + 0.5;
          float swellA = sin(pos2D.x * 0.042 + pos2D.y * 0.026 - uTime * 0.38 + baseNoise * 1.9) * 0.5 + 0.5;
          float swellB = sin(centerDist * 0.062 - uTime * 0.48 + wave * 1.2) * 0.5 + 0.5;
          idleElevation = mix(baseNoise, wave, uSmoothness * 0.5 + 0.2) * 0.72 * globalFalloff * outerSkirt * uIdleWave;
          float combinedWave = baseNoise * 0.42 + wave * 0.22 + swellA * 0.22 + swellB * 0.14 + (rnd - 0.5) * 0.035;
          combinedWave = smoothstep(0.14, 0.88, combinedWave);
          idleBlockWave = combinedWave * uIdleWave * 2.85 * globalFalloff * outerSkirt;
        }

        float subRegion = smoothstep(uHalfExtent * 0.24 * range, 0.0, centerDist);
        float subLift = easeLift(uSubBass, 5.2) * subRegion;
        float bassNoise = uBass > 0.001 ? snoise(pos2D * 0.095 - vec2(0.0, uTime * 0.22)) : 0.0;
        float bassInner = smoothstep(uHalfExtent * 0.06 * range, uHalfExtent * 0.20 * range, centerDist);
        float bassOuter = smoothstep(uHalfExtent * 0.46 * range, uHalfExtent * 0.16 * range, centerDist + bassNoise * 5.2);
        float bassRegion = mix(0.32, 1.0, bassInner) * bassOuter;
        float bassRndRaw = smoothstep(0.0, 1.0, mix(rnd, 0.65, uSmoothness * 0.35) + uDensity * 0.45);
        float bassRnd = mix(0.76, bassRndRaw, min(spikeScale, 1.0));
        float bassLift = easeLift(uBass, 4.6) * bassRegion * bassRnd;
        float lowMidNoise = (uLowMid > 0.001 && waveScale > 0.001) ? snoise(pos2D * 0.05 + vec2(uTime * 0.1, 0.0)) : 0.0;
        float lowMidLift = (uLowMid > 0.001 && waveScale > 0.001) ? flowLift(uLowMid, 2.7) * (lowMidNoise * 0.5 + 0.5) * waveScale : 0.0;
        float riverFlow = (uMid > 0.001 && waveScale > 0.001) ? sin(pos2D.x * 0.19 + pos2D.y * 0.19 + snoise(pos2D * 0.095) * 2.1 - uTime * 1.9) : 0.0;
        float midRing = smoothstep(uHalfExtent * 0.08 * range, uHalfExtent * 0.26 * range, centerDist)
                      * smoothstep(uHalfExtent * 0.92 * range, uHalfExtent * 0.56 * range, centerDist);
        float midLift = (uMid > 0.001 && waveScale > 0.001) ? flowLift(uMid, 3.6) * smoothstep(-0.18, 0.18, riverFlow) * mix(0.42, 1.0, midRing) * waveScale : 0.0;
        float highMidRegion = smoothstep(uHalfExtent * 0.22 * range, uHalfExtent * 0.68 * range, centerDist);
        float highMidLift = (spikeWeight > 0.001 && fract(rnd * 13.3) > 0.74) ? easeLift(uHighMid, 3.4) * highMidRegion * (0.28 + 0.72 * fract(rnd * 7.7)) * spikeWeight : 0.0;
        float trebleRegion = smoothstep(uHalfExtent * 0.40 * range, uHalfExtent * 0.78 * range, centerDist);
        float trebleSparkle = sin(pos2D.x * 0.34 - pos2D.y * 0.29 + uTime * 3.8 + rnd * 6.283) * 0.5 + 0.5;
        float trebleGate = smoothstep(0.32, 0.95, fract(rnd * 19.7));
        float trebleLift = (uTreble > 0.001 && spikeWeight > 0.001) ? easeLift(uTreble, 3.0) * trebleRegion * mix(0.28, 1.0, trebleSparkle) * (0.35 + 0.65 * trebleGate) * spikeWeight : 0.0;

        float audioElevation = (subLift + bassLift + lowMidLift + midLift + highMidLift + trebleLift) * uAudioIntensity;
        if (spikeWeight > 0.001 && rnd > 0.986) {
          float energyRaw = clamp(uEnergy, 0.0, 1.0);
          float energyBounce = 1.0 - pow(1.0 - energyRaw, 1.5);
          energyBounce += sin(energyRaw * 6.283 * 2.0) * exp(-energyRaw * 5.0) * 0.2;
          audioElevation += energyBounce * 4.8 * uAudioIntensity * spikeWeight;
        }
        audioElevation *= audioRangeFalloff * centerGain * outerSkirt;

        float subPeak = clamp((subLift * centerGain) / 4.8, 0.0, 1.0);
        float globalPeak = clamp((audioElevation - 3.8) / 5.2, 0.0, 1.0);
        peakIntensity = clamp(max(subPeak, globalPeak * 0.85), 0.0, 1.0);
        elevation = idleElevation + audioElevation + idleBlockWave;

        float rippleElevation = 0.0;
        float rNorm = 0.0;
        float rWhite = 0.0;
        float rCrest = 0.0;
        for (int i = 0; i < 20; i++) {
          if (i >= uActiveRipples) break;
          vec4 geo = uRippleGeo[i];
          float d = length(pos2D - geo.xy) - geo.z;
          vec4 param = uRippleParam[i];
          if (abs(d) < param.w) {
            float mainWave = exp(-d * d * param.x);
            float dTrail = d + 3.4;
            float trailWave = 0.26 * exp(-dTrail * dTrail * param.x * 1.35) * step(d, 0.5);
            float sharpFront = exp(-d * d * param.x * 4.2);
            float rPulse = (mainWave + trailWave) * geo.w;
            rippleElevation += rPulse * param.z;
            rCrest += sharpFront * geo.w;
            if (param.y > 0.5) rWhite += rPulse;
            else rNorm += rPulse;
          }
        }
        elevation += rippleElevation;
        rippleAnim = vec3(clamp(sqrt(rNorm), 0.0, 1.0), clamp(sqrt(rWhite), 0.0, 1.0), clamp(sqrt(rCrest), 0.0, 1.0));
      }

      // 顶点位移（无 mat4 矩阵乘法，直接平移 x/z 与拉伸 y）
      float yPos = position.y + 0.5;
      float totalHeight = 1.0 + elevation;
      vHeightInfo = vec2(yPos, totalHeight);
      vec3 worldPos = vec3(position.x + pos2D.x, yPos * totalHeight, position.z + pos2D.y);
      vWorldPos = worldPos;
      gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);

      // 逐柱恒定色彩/光照不变量（原在片元着色器执行，前移后省 55% 片元 ALU）
      float normElevation = clamp(elevation / 7.5, 0.0, 1.0);
      float bandT = clamp(centerDist / uHalfExtent, 0.0, 1.0);
      float innerW = 1.0 - smoothstep(0.28, 0.44, bandT);
      float outerW = smoothstep(0.56, 0.76, bandT);
      float midW = max(0.0, 1.0 - innerW - outerW);

      vec3 innerGlow = mix(uWarmCore, uWarmEdge, colorVariation);
      vec3 midGlow   = mix(uMidCore,  uMidEdge,  colorVariation);
      vec3 outerGlow = mix(uCoolCore, uCoolEdge, colorVariation);
      vec3 targetGlow = innerGlow * innerW + midGlow * midW + outerGlow * outerW;

      float warmBlend = smoothstep(0.0, 1.0, uWarmth * 1.5);
      targetGlow = mix(targetGlow, innerGlow, warmBlend * 0.36);
      vec3 crispCyan = mix(uCoolCore, vec3(0.55, 0.88, 1.0), 0.55);
      targetGlow = mix(targetGlow, crispCyan, uBrightness * 0.45);
      vTargetGlow = targetGlow;

      // 基于相机真实距离的空气透视与圆盘外缘柔化（纯俯视自动减弱雾气以保持全盘清晰）
      float camOriginDist = max(length(cameraPosition), 1.0);
      float camDist = length(cameraPosition - worldPos);
      float grazing = 1.0 - smoothstep(0.58, 0.94, cameraPosition.y / camOriginDist);
      float fogStart = camOriginDist * 0.68;
      float fogEnd = camOriginDist + uHalfExtent * 0.82;
      float camFogT = smoothstep(fogStart, fogEnd, camDist);
      float diskEdgeFade = smoothstep(uHalfExtent * 0.76, uHalfExtent * 0.995, centerDist);

      float distFade = mix(1.0, 0.66, clamp(camFogT * 0.82 * grazing + diskEdgeFade * 0.35, 0.0, 1.0));
      float dim = clamp(uLowPillarDim, 0.0, 1.0);
      float heightPow = pow(normElevation, mix(0.85, 1.48, dim));
      vec3 glowBase = mix(uBaseColor2 * 1.05, uBaseColor1 * 0.82, dim);
      vec3 currentGlow = mix(glowBase, targetGlow, heightPow) * uGlowIntensity * distFade;

      float normalBlend = rippleAnim.x * rippleAnim.x;
      float whiteBlend = rippleAnim.y * rippleAnim.y;
      float crestBlend = rippleAnim.z * rippleAnim.z;
      float rippleLift = max(normalBlend, whiteBlend);
      currentGlow = mix(currentGlow, uRippleColor * 1.16, normalBlend * 0.78);
      vec3 meteorTint = mix(uRippleColor * 1.24, vec3(0.94, 0.97, 1.04), 0.40);
      currentGlow = mix(currentGlow, meteorTint, whiteBlend * 0.84);

      float tallGate = smoothstep(0.45, 0.78, peakIntensity);
      float peakBlend = pow(peakIntensity, 0.85) * tallGate * uPeakEnabled * uPeakIntensity;
      float peakClamped = clamp(peakBlend, 0.0, 1.0);
      currentGlow = mix(currentGlow, uPeakColor * 1.22, peakClamped * 0.80);
      vCurrentGlow = currentGlow;

      float lowHeightDim = mix(mix(1.0, 0.56, dim), 1.0, smoothstep(0.05, 0.48, normElevation));
      lowHeightDim = mix(lowHeightDim, 1.0, clamp(rippleLift * 1.35, 0.0, 1.0));
      float idleCrest = smoothstep(0.44, 0.92, normElevation) * uIdleWave * uPeakEnabled * uPeakIntensity;
      float aerialFog = clamp(max(camFogT * grazing, diskEdgeFade * 0.85), 0.0, 1.0);

      vPillarA = vec4(normElevation, lowHeightDim, distFade, peakClamped);
      vPillarB = vec4(rippleLift, idleCrest, aerialFog, peakBlend);

      // 逐柱恒定波纹叠加色（高光保留主题色相与立体切面层次，避免过曝泛白）
      vec3 meteorWaveCol = mix(uRippleColor * 1.24, mix(uWarmCore * 1.22, vec3(1.02, 1.06, 1.12), 0.36), crestBlend);
      vRippleAdd = uRippleColor * normalBlend * 0.36
                 + meteorWaveCol * whiteBlend * 0.56
                 + mix(uRippleColor * 1.15, vec3(0.96, 0.97, 1.0), 0.28) * crestBlend * (normalBlend * 0.40 + whiteBlend * 0.48);

      // 平面法向方向光照（每个面法向恒定，直接顶点计算）
      const vec3 Lkey = vec3(0.501577, 0.790948, 0.347246); // normalize(0.52, 0.82, 0.36)
      const vec3 Lrim = vec3(-0.655284, 0.423414, -0.625040); // normalize(-0.65, 0.42, -0.62)
      float NdotL = max(dot(normal, Lkey), 0.0);
      float NdotRim = max(dot(normal, Lrim), 0.0);
      vFaceLight = vec3(
        0.62 + 0.46 * NdotL + 0.22 * NdotRim,
        0.76 + 0.30 * NdotL + 0.16 * NdotRim,
        warmBlend
      );
    }
  `,
  `
    precision highp float;

    uniform vec3 uBaseColor1;
    uniform vec3 uBaseColor2;
    uniform vec3 uCoolCore;
    uniform vec3 uWarmCore;
    uniform vec3 uPeakColor;
    uniform float uGlowIntensity;
    uniform float uLowPillarDim;

    in vec2 vUv;
    in vec3 vNormal;
    in vec2 vHeightInfo;
    in vec3 vWorldPos;
    in vec3 vCurrentGlow;
    in vec3 vTargetGlow;
    in vec3 vRippleAdd;
    in vec4 vPillarA;
    in vec4 vPillarB;
    in vec3 vFaceLight;

    out vec4 fragColor;

    ${GLSL_FILMIC}

    void main() {
      // 立方柱面法线在单三角形内恒为单位向量，无需 normalize(vNormal)
      vec3 N = vNormal;
      vec3 V = normalize(cameraPosition - vWorldPos);
      bool isTop = N.y > 0.5;
      float relY = vHeightInfo.x;
      float totalHeight = vHeightInfo.y;
      float worldDistFromTop = (1.0 - relY) * totalHeight;

      float normElevation = vPillarA.x;
      float lowHeightDim  = vPillarA.y;
      float distFade      = vPillarA.z;
      float peakClamped   = vPillarA.w;
      float rippleLift    = vPillarB.x;
      float idleCrest     = vPillarB.y;
      float aerialFog     = vPillarB.z;
      float peakBlend     = vPillarB.w;
      float dim = clamp(uLowPillarDim, 0.0, 1.0);

      // 抗锯齿屏幕空间导数 + 中远景高频细节提前收拢（杜绝远景蜂窝颗粒与摩尔纹）
      float uvFw = max(fwidth(vUv.x), fwidth(vUv.y));
      float farSoft = clamp(max(smoothstep(0.055, 0.18, uvFw), smoothstep(0.18, 0.72, aerialFog)), 0.0, 1.0);
      float detailFade = (1.0 - smoothstep(0.032, 0.135, uvFw)) * (1.0 - smoothstep(0.16, 0.60, aerialFog));

      // 高级通透水晶光学项：深邃琉璃底 + 紧致玻璃镜面高光 + 锐利掠射菲涅尔（彻底杜绝发灰塑料感）
      float NdotV = max(dot(N, V), 0.0);
      float omv = 1.0 - NdotV;
      float fresnel = omv * omv * omv; // 仅在真正掠射角亮起，不冲淡正面暗部

      const vec3 LkeyFrag = vec3(0.501577, 0.790948, 0.347246);
      const vec3 LrimFrag = vec3(-0.655284, 0.423414, -0.625040);
      vec3 Hkey = normalize(LkeyFrag + V);
      float NdotH = max(dot(N, Hkey), 0.0);
      // 紧致清透的切面玻璃高光（替代宽泛发灰的塑料漫反射高光）
      float glassSpec = pow(NdotH, 56.0);
      vec3 deepGemTint = pow(max(vTargetGlow, vec3(0.001)), vec3(1.42));

      float riseT = smoothstep(0.16, 0.74, normElevation);
      float energyBoost = clamp(riseT + peakClamped * 0.65 + rippleLift * 0.55, 0.0, 1.0);

      // 全柱精细抗锯齿水晶细描边（~1.2px 锐利棱线）：颜色严格跟随柱体主体色与峰值/波纹高亮，不泛白、不串色
      float highlightFollow = smoothstep(0.10, 0.56, normElevation + rippleLift * 0.75 + peakClamped * 0.85);
      vec3 pillarEdgeSrc = mix(vTargetGlow, vCurrentGlow, highlightFollow);
      pillarEdgeSrc = mix(pillarEdgeSrc, uPeakColor * 1.18, clamp(peakClamped * 0.78 + idleCrest * 0.20, 0.0, 0.92));
      pillarEdgeSrc += vRippleAdd * 0.42;

      float edgeMaxC = max(max(pillarEdgeSrc.r, pillarEdgeSrc.g), max(pillarEdgeSrc.b, 0.001));
      vec3 normEdgeHue = clamp(pillarEdgeSrc / edgeMaxC, 0.0, 1.0);
      vec3 luminousEdgeHue = clamp(pow(normEdgeHue + vec3(0.035), vec3(0.62)), 0.0, 1.0);
      vec3 specTint = mix(luminousEdgeHue, vec3(1.0), 0.28);

      float lineHeightGain = smoothstep(mix(0.06, 0.16, dim), mix(0.52, 0.70, dim), normElevation);
      float lineStrength = clamp(mix(0.38, 0.26, dim) + lineHeightGain * 0.62 + peakClamped * 0.35 + rippleLift * 0.42, 0.0, 1.0);
      vec3 hairlineCol = mix(normEdgeHue, luminousEdgeHue, clamp(0.18 + energyBoost * 0.58 + peakClamped * 0.28 + rippleLift * 0.25, 0.0, 1.0))
                       * clamp(uGlowIntensity, 0.72, 1.32) * distFade;

      vec3 finalColor;

      if (isTop) {
        float topIntensity = smoothstep(mix(0.02, 0.10, dim), mix(0.48, 0.66, dim), normElevation) + clamp(peakBlend * 0.45, 0.0, 1.0);
        topIntensity *= mix(1.0, 0.86, farSoft);
        float topClamped = clamp(topIntensity, 0.0, 1.0);

        // 深邃高饱和琉璃暗底（不发白发灰，保留通透宝石感）
        vec3 baseFloorCol = mix(uBaseColor2 * 1.02, uBaseColor1 * 0.84, dim)
                          + deepGemTint * mix(0.048, 0.024, dim) * min(uGlowIntensity, 1.35);
        vec3 darkCrystalCap = mix(baseFloorCol, uBaseColor2 * mix(1.12, 0.88, dim) + deepGemTint * 0.075, smoothstep(0.0, 0.38, normElevation)) * lowHeightDim;

        // 升起晶柱顶面：通透清亮且高光保色，微弱斜向透射渐变体现晶面厚度
        vec3 topGlowCol = mix(vCurrentGlow, uPeakColor * 1.20, peakClamped * 0.45 + idleCrest * 0.22);
        topGlowCol = mix(topGlowCol, topGlowCol * 0.86 + luminousEdgeHue * 0.22, energyBoost * 0.32);
        float lightGrad = 0.95 + 0.10 * dot(vUv - 0.5, vec2(0.75, 0.66));
        vec3 crownCol = topGlowCol * (1.06 + 0.14 * energyBoost) * lightGrad;
        vec3 capBase = mix(darkCrystalCap, crownCol, topClamped);

        // 紧致玻璃镜面闪烁 + 同色系克制掠射菲涅尔
        capBase += specTint * glassSpec * (0.20 + 0.22 * energyBoost) * distFade;
        capBase += luminousEdgeHue * fresnel * (0.14 + 0.16 * energyBoost) * distFade;

        // 精致细描边（锐利抗锯齿细线，跟随主体色与高亮色，远景随 detailFade 自动柔化防噪）
        float edgeDist = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
        float hairW = max(0.017, uvFw * 1.05);
        float topHairline = (1.0 - smoothstep(hairW * 0.45, hairW * 1.45, edgeDist)) * detailFade;
        capBase += hairlineCol * topHairline * lineStrength * (0.48 + 0.16 * energyBoost);

        finalColor = capBase;
      } else {
        // 底部沉稳压暗，保持水晶柱群立体接地感（中远景柔化防噪）
        float worldCrevice = smoothstep(0.0, 1.85, vWorldPos.y);
        float relCrevice = smoothstep(0.0, 0.38, relY);
        float creviceAO = mix(mix(0.50, 0.30, dim), 1.0, max(worldCrevice, relCrevice * 0.60));
        creviceAO = mix(creviceAO, mix(creviceAO, 0.88, 0.72), farSoft);

        // 深邃饱和琉璃柱底（Beer-Lambert 深度饱和，非泛白塑料）
        vec3 deepCrystalRoot = mix(uBaseColor1 * mix(0.88, 0.68, dim), uBaseColor2 * mix(1.12, 0.88, dim), relY * distFade)
                             + deepGemTint * (0.022 + 0.055 * relY) * mix(1.0, 0.58, dim) * min(uGlowIntensity, 1.35);
        vec3 bodyColor = deepCrystalRoot * vFaceLight.x * lowHeightDim;

        // 内部由底向上渐强的清透发光（底部深邃，中上部通透发亮）
        float sideGrad = pow(smoothstep(0.0, 0.98, relY), 0.82);
        float heightEnergy = pow(max(normElevation, 0.001), mix(0.86, 1.18, dim));
        float shaftFloor = smoothstep(0.20, 0.78, normElevation) * 0.30 * worldCrevice;
        float sideGlow = clamp(mix(shaftFloor, 1.0, sideGrad) * heightEnergy * 1.12, 0.0, 1.0);

        vec3 sideGlowColor = mix(vCurrentGlow, uPeakColor * 1.18, peakClamped * 0.42 + idleCrest * 0.18);
        finalColor = mix(bodyColor, sideGlowColor * vFaceLight.y, sideGlow);

        // 克制清透的内部逆光透射（仅高穿透方向微亮，保持切面高对比度）
        float backTrans = pow(clamp(dot(V, normalize(-LkeyFrag + N * 0.42)), 0.0, 1.0), 3.4);
        float rimTrans = pow(clamp(dot(V, normalize(-LrimFrag + N * 0.42)), 0.0, 1.0), 3.8);
        float sssWeight = (0.10 + 0.22 * energyBoost) * (0.30 + 0.70 * relY) * distFade;
        finalColor += mix(deepGemTint, sideGlowColor, 0.62) * (backTrans * 0.55 + rimTrans * 0.35) * sssWeight;

        // 紧致玻璃镜面反光 + 同色系掠射菲涅尔
        finalColor += specTint * glassSpec * (0.16 + 0.20 * energyBoost) * (0.35 + 0.65 * relY) * distFade;
        finalColor += luminousEdgeHue * fresnel * (0.12 + 0.16 * energyBoost) * relY * distFade;

        // 侧面精细锐利棱线描边（随主体色/高亮色及受光面自然变化，绝非纯白描边）
        float topSideW = max(0.022, uvFw * totalHeight * 1.05);
        float topSideLine = (1.0 - smoothstep(topSideW * 0.45, topSideW * 1.45, worldDistFromTop)) * detailFade;
        finalColor += hairlineCol * topSideLine * lineStrength * (0.20 + 0.10 * energyBoost) * vFaceLight.y;

        float sideEdgeDist = min(vUv.x, 1.0 - vUv.x);
        float sideHairW = max(0.015, uvFw * 1.05);
        float sideHairline = (1.0 - smoothstep(sideHairW * 0.45, sideHairW * 1.45, sideEdgeDist)) * detailFade;
        finalColor += hairlineCol * sideHairline * lineStrength * (0.26 + 0.20 * energyBoost) * (0.38 + 0.62 * relY) * vFaceLight.y * creviceAO;

        finalColor *= creviceAO;
      }

      finalColor = mix(finalColor, uPeakColor * 1.15, peakClamped * 0.14);
      finalColor += vRippleAdd;

      if (aerialFog > 0.001) {
        float glowCap = min(uGlowIntensity, 1.38);
        // 越靠近地平线，雾色越贴合天空地平线辉光，避免远端出现生硬黑边
        float horizonGlowT = smoothstep(0.45, 1.0, aerialFog);
        vec3 atmosphericColor = mix(uBaseColor1 * 0.75, uBaseColor2 * 0.92, 0.45)
                              + mix(uCoolCore, uWarmCore, 0.40) * (0.055 + 0.075 * horizonGlowT) * glowCap;
        float fogStrength = pow(aerialFog, 1.38) * 0.86;
        fogStrength *= (1.0 - peakClamped * 0.16 - rippleLift * 0.14);
        finalColor = mix(finalColor, atmosphericColor, clamp(fogStrength, 0.0, 0.92));
      }

      finalColor = acesSoft(finalColor * 1.10);
      finalColor += (ignDither(gl_FragCoord.xy) - 0.5) / 255.0;

      fragColor = vec4(finalColor, 1.0);
    }
  `,
  { glslVersion: GLSL3 },
);

// ============================================================
// 1B. FloorDiscMaterial — Early-Z 主题暗底承托圆盘
//     - 排在地形柱之后绘制 (renderOrder 28)，被柱体遮挡的 ~98% 像素由硬件 Early-Z 剔除
//     - 填补柱列与屏幕底边平行时的直通暗缝，带邻近高柱柔光反射与一致的相机距离雾效
// ============================================================
const FloorDiscMaterial = createShaderMaterial(
  {
    uUseFbo: 0,
    uSimTex0: null,
    uHalfExtent: 84,
    uGridStep: 1.05,
    uGridSize: 96,
    uBaseColor1: new se(0.01, 0.02, 0.04),
    uBaseColor2: new se(0.03, 0.05, 0.09),
    uCoolCore: new se(0, 0.3, 1),
    uMidCore: new se(0.6, 0.25, 0.9),
    uWarmCore: new se(1, 0.2, 0.1),
    uPeakColor: new se(1, 1, 1),
    uPeakEnabled: 1,
    uPeakIntensity: 1,
    uGlowIntensity: 1,
    uLowPillarDim: 0.35,
    uEnergy: 0,
  },
  `
    out vec3 vWorldPos;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorldPos = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `,
  `
    precision highp float;

    uniform float uUseFbo;
    uniform sampler2D uSimTex0;
    uniform float uHalfExtent;
    uniform float uGridStep;
    uniform float uGridSize;
    uniform vec3 uBaseColor1;
    uniform vec3 uBaseColor2;
    uniform vec3 uCoolCore;
    uniform vec3 uMidCore;
    uniform vec3 uWarmCore;
    uniform vec3 uPeakColor;
    uniform float uPeakEnabled;
    uniform float uPeakIntensity;
    uniform float uGlowIntensity;
    uniform float uLowPillarDim;
    uniform float uEnergy;

    in vec3 vWorldPos;
    out vec4 fragColor;

    ${GLSL_FILMIC}

    void main() {
      vec2 pos2D = vWorldPos.xz;
      float centerDist = length(pos2D);

      // 与 MapShaderMaterial 完全一致的相机真实距离空气透视（俯视自动减弱雾气）
      float camOriginDist = max(length(cameraPosition), 1.0);
      float camDist = length(cameraPosition - vWorldPos);
      float grazing = 1.0 - smoothstep(0.58, 0.94, cameraPosition.y / camOriginDist);
      float fogStart = camOriginDist * 0.68;
      float fogEnd = camOriginDist + uHalfExtent * 0.82;
      float camFogT = smoothstep(fogStart, fogEnd, camDist);
      float diskEdgeFade = smoothstep(uHalfExtent * 0.76, uHalfExtent * 0.995, centerDist);
      float aerialFog = clamp(max(camFogT * grazing, diskEdgeFade * 0.85), 0.0, 1.0);

      float dim = clamp(uLowPillarDim, 0.0, 1.0);
      float glowCap = min(uGlowIntensity, 1.38);
      vec3 themeTint = mix(uCoolCore, uWarmCore, 0.40);

      // 与柱群同环带的主体色（内暖 -> 中环 -> 外冷）
      float bandT = clamp(centerDist / max(uHalfExtent, 1.0), 0.0, 1.0);
      float innerW = 1.0 - smoothstep(0.28, 0.44, bandT);
      float outerW = smoothstep(0.56, 0.76, bandT);
      float midW = max(0.0, 1.0 - innerW - outerW);
      vec3 localThemeCol = uWarmCore * innerW + uMidCore * midW + uCoolCore * outerW;

      // 略微压暗的主体底色：暗谷处克制不发亮，与柱底自然融合
      vec3 floorCol = mix(uBaseColor1 * 0.85, uBaseColor2 * 1.02, mix(0.50, 0.25, dim))
                    + localThemeCol * mix(0.042, 0.022, dim) * glowCap;

      // 邻近升起高柱与峰值的缝隙漫反射余光（避免高亮柱群与俯视中出现深色十字/竖缝）
      float localElev = 0.0;
      float localPeak = 0.0;
      if (uUseFbo > 0.5) {
        vec2 gf = (pos2D + vec2(uHalfExtent)) / max(uGridStep, 1e-4);
        ivec2 maxIdx = ivec2(max(int(uGridSize) - 1, 0));
        ivec2 c0 = clamp(ivec2(floor(gf)), ivec2(0), maxIdx);
        ivec2 c1 = clamp(c0 + ivec2(1, 0), ivec2(0), maxIdx);
        ivec2 c2 = clamp(c0 + ivec2(0, 1), ivec2(0), maxIdx);
        ivec2 c3 = clamp(c0 + ivec2(1, 1), ivec2(0), maxIdx);
        vec2 fr = clamp(fract(gf), 0.0, 1.0);
        vec2 s0 = mix(texelFetch(uSimTex0, c0, 0).xy, texelFetch(uSimTex0, c1, 0).xy, fr.x);
        vec2 s1 = mix(texelFetch(uSimTex0, c2, 0).xy, texelFetch(uSimTex0, c3, 0).xy, fr.x);
        vec2 sim = mix(s0, s1, fr.y);
        localElev = sim.x;
        localPeak = sim.y;
      } else {
        localElev = uEnergy * 3.5 * smoothstep(uHalfExtent, 0.0, centerDist);
      }
      float tallGate = smoothstep(0.45, 0.78, localPeak);
      float peakClamped = clamp(pow(localPeak, 0.85) * tallGate * uPeakEnabled * uPeakIntensity, 0.0, 1.0);
      vec3 bounceCol = mix(localThemeCol, uPeakColor * 1.15, peakClamped * 0.78);
      float bounceT = smoothstep(0.75, 4.8, localElev);
      floorCol = mix(floorCol, bounceCol * glowCap * mix(0.62, 0.46, dim), bounceT * 0.76);

      if (aerialFog > 0.001) {
        float horizonGlowT = smoothstep(0.45, 1.0, aerialFog);
        vec3 atmosphericColor = mix(uBaseColor1 * 0.75, uBaseColor2 * 0.92, 0.45)
                              + themeTint * (0.055 + 0.075 * horizonGlowT) * glowCap;
        float fogStrength = pow(aerialFog, 1.38) * 0.86;
        floorCol = mix(floorCol, atmosphericColor, clamp(fogStrength, 0.0, 0.92));
      }

      floorCol = acesSoft(floorCol * 1.10);
      floorCol += (ignDither(gl_FragCoord.xy) - 0.5) / 255.0;
      fragColor = vec4(floorCol, 1.0);
    }
  `,
  { glslVersion: GLSL3 },
);

// ============================================================
// 2. SkyShaderMaterial — 全屏单三角形 + 硬件 Early-Z 深度剔除
//    - 底层全屏填充略微压暗的主题色（无黑边硬裁剪），上层星空/星云/极光按视角自适应圆盘曲率贴合地平线
//    - 仅 3 顶点，在地形与底盘之后绘制 (z = 0.99999)，被遮挡像素 0 片元着色开销
//    - 6 组全屏恒定 (cos, sin) 旋转矩阵由 CPU 每帧预计算传入，每像素省 12 次三角函数
// ============================================================
const SkyShaderMaterial = createShaderMaterial(
  {
    uTime: 0,
    uHalfExtent: 84,
    uFogColor: new se(0.005, 0.008, 0.025),
    uBaseColor2: new se(0.015, 0.025, 0.07),
    uNebulaA: new se(0.35, 0.1, 0.9),
    uNebulaB: new se(0.65, 0.25, 1),
    uPeakColor: new se(1, 0.55, 0.05),
    uAudioResp: 0,
    uBassResp: 0,
    uGlow: 1,
    uInvProj: new Matrix4(),
    uCamRot: new Matrix3(),
    // CPU 预计算旋转 (cos, sin)
    uGalRot: new V2(1, 0),
    uAurRot: new V2(1, 0),
    uStarRot0: new V2(1, 0),
    uStarRot1: new V2(1, 0),
    uStarRot2: new V2(1, 0),
    uStarRot3: new V2(1, 0),
  },
  `
    uniform mat4 uInvProj;
    uniform mat3 uCamRot;
    varying vec3 vRay;
    void main() {
      vec4 clip = vec4(position.xy, 1.0, 1.0);
      vec4 viewPos = uInvProj * clip;
      vRay = uCamRot * (viewPos.xyz / viewPos.w);
      // 紧贴远平面且严格 < 1.0，与地形深度缓冲配合触发硬件 Early-Z
      gl_Position = vec4(position.xy, 0.99999, 1.0);
    }
  `,
  `
    uniform float uTime;
    uniform float uHalfExtent;
    uniform vec3 uFogColor;
    uniform vec3 uBaseColor2;
    uniform vec3 uNebulaA;
    uniform vec3 uNebulaB;
    uniform vec3 uPeakColor;
    uniform float uAudioResp;
    uniform float uBassResp;
    uniform float uGlow;
    uniform vec2 uGalRot;
    uniform vec2 uAurRot;
    uniform vec2 uStarRot0;
    uniform vec2 uStarRot1;
    uniform vec2 uStarRot2;
    uniform vec2 uStarRot3;

    varying vec3 vRay;

    ${GLSL_SNOISE}
    ${GLSL_FILMIC}

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    float hash13(vec3 p) {
      p = fract(p * 0.1031);
      p += dot(p, p.zyx + 31.32);
      return fract((p.x + p.y) * p.z);
    }

    vec3 starLayer(vec3 dir, vec2 rotCS, float gridDensity, float sizeScale,
                   float brightScale, vec2 layerSeed, vec2 periodRange, float keepFraction, bool allowCross) {
      vec3 sdir = vec3(rotCS.x * dir.x + rotCS.y * dir.z, dir.y, -rotCS.y * dir.x + rotCS.x * dir.z);
      vec3 cell = floor(sdir * gridDensity);
      float keep = hash13(cell + vec3(layerSeed, layerSeed.x));
      if (keep < keepFraction) return vec3(0.0);

      vec3 f = fract(sdir * gridDensity) - 0.5;
      vec3 off = vec3(
        hash12(cell.xy + 3.3 + layerSeed),
        hash12(cell.yz + 7.7 + layerSeed.yx),
        hash12(cell.xz + 11.3 + layerSeed.xy)
      ) - 0.5;
      vec3 delta = f - off * 0.6;
      float d = length(delta);

      float sizeRand = hash12(cell.xy + 21.7 + layerSeed);
      float size = sizeScale * (0.20 + 0.44 * sizeRand);
      float brightRand = hash12(cell.xy + 31.1 + layerSeed.yx);
      float bright = brightScale * (0.58 + 0.48 * brightRand);

      float phase = hash12(cell.xy + 51.3 + layerSeed.xy);
      float period = mix(periodRange.x, periodRange.y, hash12(cell.xy + 61.3 + layerSeed.yx));
      float driftT = 0.6 + 0.9 * hash12(cell.xy + 71.3 + layerSeed);
      float t = mod(uTime * driftT + phase * period, period);
      float lifeEnv = smoothstep(0.0, 0.25, t / period) * (1.0 - smoothstep(0.75, 1.0, t / period));

      float twPhase = hash12(cell.xy + 81.3 + layerSeed.yx);
      float twinkle = 0.80 + 0.20 * sin(uTime * (1.1 + twPhase * 3.2) + twPhase * 60.0);

      float core = 1.0 - smoothstep(0.0, size, d);

      float glint = 0.0;
      if (allowCross && brightRand > 0.88 && sizeRand > 0.65) {
        vec2 p2 = delta.xy + vec2(delta.z * 0.35, -delta.z * 0.35);
        float spX = exp(-abs(p2.y) * 34.0) * exp(-abs(p2.x) * 4.5);
        float spY = exp(-abs(p2.x) * 34.0) * exp(-abs(p2.y) * 4.5);
        glint = (spX + spY) * 0.45 * (0.85 + 0.35 * uAudioResp);
      }

      float temp = hash12(cell.xy + 91.3 + layerSeed);
      vec3 starCol = temp < 0.35
        ? mix(vec3(0.72, 0.84, 1.0), vec3(0.95, 0.97, 1.0), temp / 0.35)
        : (temp < 0.78
            ? mix(vec3(0.95, 0.97, 1.0), vec3(1.0, 0.93, 0.78), (temp - 0.35) / 0.43)
            : mix(vec3(1.0, 0.93, 0.78), vec3(1.0, 0.78, 0.62), (temp - 0.78) / 0.22));

      return starCol * ((core + glint) * lifeEnv * twinkle * bright);
    }

    void main() {
      vec3 dir = normalize(vRay);
      float glowCap = min(uGlow, 1.42);
      vec3 themeMid = mix(uNebulaA, uNebulaB, 0.40);

      // 全屏底层略微压暗的主题色（与远景雾色同源，彻底消除任意视角/缝隙露出的纯黑底）
      vec3 lowerBackdrop = mix(uFogColor * 0.78, uBaseColor2 * 0.94, 0.48)
                         + themeMid * 0.068 * glowCap;

      // 按每像素视线方位角实时计算圆形地形盘外缘的精确地平线俯仰角（适配任意俯仰角/视距/超宽屏）
      vec2 camXZ = cameraPosition.xz;
      float camY = max(cameraPosition.y - 0.5, 0.5);
      float horizLen = length(dir.xz);
      vec2 uXZ = dir.xz / max(horizLen, 1e-5);
      float b = dot(camXZ, uXZ);
      float c = dot(camXZ, camXZ) - uHalfExtent * uHalfExtent;
      float disc = b * b - c;
      float eps = uHalfExtent * uHalfExtent * 0.06;
      float smoothDisc = 0.5 * (disc + sqrt(disc * disc + eps * eps));
      float tEdge = max(-b, 0.0) + sqrt(smoothDisc);
      float localHorizon = -camY / sqrt(camY * camY + tEdge * tEdge + 1e-4);

      // 低于曲率地平线下方直接输出连续主题暗底（跳过星云/极光/星空采样，零硬裁剪跳变）
      if (dir.y < localHorizon - 0.08) {
        vec3 col = acesSoft(lowerBackdrop * 1.12);
        col += (ignDither(gl_FragCoord.xy) - 0.5) / 255.0;
        gl_FragColor = vec4(col, 1.0);
        return;
      }

      float skyElev = max(0.0, dir.y - localHorizon);
      float horizonBlend = smoothstep(localHorizon - 0.06, localHorizon + 0.12, dir.y);

      // 倾斜银河坐标系（使用 CPU 预计算旋转）
      vec3 rDir = vec3(uGalRot.x * dir.x + uGalRot.y * dir.z, dir.y, -uGalRot.y * dir.x + uGalRot.x * dir.z);
      float galPlane = rDir.y * 0.82 - rDir.x * 0.44 + rDir.z * 0.36;
      float galBand = exp(-galPlane * galPlane * 7.5);

      float pulse = uAudioResp;
      vec2 baseUv = vec2(rDir.x * 2.2 + rDir.z * 1.35, rDir.y * 2.6 - rDir.z * 0.75);
      vec2 flow1 = vec2(uTime * 0.011 + pulse * 0.42, uTime * 0.007 + pulse * 0.28);
      vec2 flow2 = vec2(-uTime * 0.009 - pulse * 0.32, uTime * 0.013 - pulse * 0.36);

      float warp = snoise(baseUv * 0.95 + flow1);
      float nebMain = snoise(baseUv * 1.72 + vec2(warp * 0.42, -warp * 0.34) + flow2);
      float nebFine = snoise(baseUv * 3.15 - vec2(warp * 0.24, warp * 0.22) + flow1 * 1.25);
      float softVeil = smoothstep(0.10, 0.92, nebFine * 0.5 + 0.5) * smoothstep(-0.15, 0.78, nebMain + galBand * 0.42);

      float dustRift = smoothstep(0.05, 0.72, nebFine) * galBand;
      float nebField = nebMain * 0.66 + nebFine * 0.34;
      float nebDensity = smoothstep(-0.14, 0.98, nebField + galBand * 0.36) * smoothstep(localHorizon - 0.01, localHorizon + 0.22, dir.y);
      nebDensity *= (1.0 - dustRift * 0.28);

      vec3 deepVoid = uFogColor * 0.32 + themeMid * 0.018 * glowCap;
      vec3 horizonNight = mix(lowerBackdrop, uFogColor * 0.62 + themeMid * 0.082 * glowCap, 0.55);
      vec3 baseCol = mix(lowerBackdrop, mix(horizonNight, deepVoid, smoothstep(0.06, 0.46, skyElev)), horizonBlend);

      vec3 nebCol = mix(uNebulaA, uNebulaB, smoothstep(-0.30, 0.75, nebMain + 0.20));
      float ionKnot = smoothstep(0.35, 0.90, nebMain * 0.68 + nebFine * 0.45) * galBand;
      nebCol = mix(nebCol, mix(uNebulaB, uPeakColor, 0.35), ionKnot * 0.38);

      vec3 col = mix(baseCol, nebCol * glowCap * 0.58, nebDensity * (0.58 + uAudioResp * 0.12));
      col += mix(uNebulaB, uPeakColor, 0.22 * galBand) * softVeil * smoothstep(localHorizon + 0.01, localHorizon + 0.26, dir.y) * 0.14 * glowCap;

      // 北欧丝绸极光幕帘（柔和过渡，避免顶部出现硬边暗斑）
      float aurMaskY = smoothstep(localHorizon - 0.015, localHorizon + 0.085, dir.y) * (1.0 - smoothstep(localHorizon + 0.14, localHorizon + 0.38, dir.y));
      if (aurMaskY > 0.001) {
        vec2 hDir = normalize(rDir.xz + vec2(1e-5, 0.0));
        vec2 hRot = vec2(uAurRot.x * hDir.x - uAurRot.y * hDir.y, uAurRot.y * hDir.x + uAurRot.x * hDir.y);
        float ribbonA = snoise(hRot * 1.75 + vec2(0.0, dir.y * 1.35 - uTime * 0.02));
        float ribbonB = snoise(hDir * 3.10 + vec2(ribbonA * 0.38, dir.y * 1.85 + uTime * 0.015));
        float raysA = sin(dot(hRot, vec2(8.5, 5.5)) + ribbonA * 2.8 + uTime * 0.14);
        float raysB = sin(dot(hRot, vec2(-5.5, 8.5)) - ribbonB * 2.4 - uTime * 0.10);
        float rays = 0.66 + 0.34 * (raysA * 0.55 + raysB * 0.45);
        float curtain = smoothstep(-0.04, 0.92, (ribbonA * 0.58 + ribbonB * 0.42) * 0.5 + 0.5) * rays;
        float leDy = (dir.y - (localHorizon + 0.08)) / 0.058;
        float lowerEdge = exp(-leDy * leDy);
        float vertFade = pow(max(0.0, 1.0 - smoothstep(localHorizon + 0.07, localHorizon + 0.37, dir.y)), 1.45);
        vec3 aurCol = mix(uNebulaA * 1.10, mix(uNebulaB, uPeakColor, 0.25), smoothstep(localHorizon + 0.05, localHorizon + 0.28, dir.y));
        col += aurCol * (curtain * vertFade * 0.24 + lowerEdge * curtain * 0.15) * aurMaskY * glowCap * (1.0 + uAudioResp * 0.38 + uBassResp * 0.22);
      }

      // 3 层独立视差锐利星空 + 银河星尘
      if (dir.y > localHorizon - 0.01) {
        float starFade = smoothstep(localHorizon - 0.01, localHorizon + 0.07, dir.y);
        vec3 star = starLayer(dir, uStarRot0, 385.0, 1.18, 1.22, vec2(0.0, 1.0), vec2(2.5, 5.5), 0.994, true);
        star += starLayer(dir, uStarRot1, 420.0, 0.70, 0.84, vec2(5.0, 6.0), vec2(4.0, 9.0), 0.980, false);
        star += starLayer(dir, uStarRot2, 470.0, 0.36, 0.52, vec2(9.0, 10.0), vec2(7.0, 15.0), 0.960, false);
        if (galBand > 0.22) {
          star += starLayer(dir, uStarRot3, 580.0, 0.28, 0.38 * galBand, vec2(14.0, 19.0), vec2(9.0, 18.0), 0.950, false);
        }
        col += star * starFade;
      }

      // 地平线大气瑞利散射辉光（沿圆盘外缘无缝延展，衔接远景雾气）
      float hbDy = (dir.y - (localHorizon + 0.025)) / 0.072;
      float hBand = exp(-hbDy * hbDy) * smoothstep(localHorizon - 0.055, localHorizon + 0.012, dir.y);
      vec3 horizonGlowCol = mix(uNebulaA, uNebulaB, 0.45) * glowCap;
      col += horizonGlowCol * hBand * (0.20 + uBassResp * 0.16);

      col *= 1.0 - smoothstep(0.78, 1.0, dir.y) * 0.26;
      col = acesSoft(col * 1.12);
      col += (ignDither(gl_FragCoord.xy) - 0.5) / 255.0;

      gl_FragColor = vec4(col, 1.0);
    }
  `,
);

// ============================================================
// 3. MeteorShaderMaterial — 炽热等离子彗星流星（与壁纸主体色一致）
// ============================================================
const MeteorShaderMaterial = createShaderMaterial(
  {
    uTime: 0,
    uCoreColor: new se(0.35, 0.1, 0.9),
    uGlowColor: new se(0.65, 0.25, 1),
  },
  `
    varying float vTailT;
    varying vec3 vNormal;
    varying vec3 vWorldPos;
    void main() {
      vTailT = clamp(position.y / 11.5, 0.0, 1.0);
      mat3 instRot = mat3(instanceMatrix);
      vNormal = normalize(instRot * normal);
      vec4 wp = instanceMatrix * vec4(position, 1.0);
      vWorldPos = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `,
  `
    uniform float uTime;
    uniform vec3 uCoreColor;
    uniform vec3 uGlowColor;

    varying float vTailT;
    varying vec3 vNormal;
    varying vec3 vWorldPos;

    void main() {
      float t = vTailT;
      vec3 V = normalize(cameraPosition - vWorldPos);
      float viewEdge = pow(abs(dot(normalize(vNormal), V)), 0.72);
      float headCore = smoothstep(0.26, 0.0, t);
      float tailFade = pow(1.0 - t, 1.85);
      float shimmer = 0.88 + 0.12 * sin(t * 24.0 - uTime * 28.0);
      vec3 plasma = mix(uCoreColor * 1.45, uGlowColor * 1.55, smoothstep(0.68, 0.10, t));
      vec3 hotCore = mix(uGlowColor * 1.35, vec3(1.65, 1.68, 1.72), 0.78);
      vec3 col = mix(plasma, hotCore, headCore * 0.92);
      float alpha = tailFade * (0.38 + 0.62 * viewEdge) * shimmer;
      gl_FragColor = vec4(col * alpha, alpha);
    }
  `,
);

// ============================================================
// 4. SparkShaderMaterial — 撞击迸溅余烬火花（与壁纸主体色一致）
// ============================================================
const SparkShaderMaterial = createShaderMaterial(
  {
    uCoreColor: new se(0.35, 0.1, 0.9),
    uGlowColor: new se(0.65, 0.25, 1),
  },
  `
    varying vec3 vColor;
    varying vec3 vNormal;
    varying vec3 vWorldPos;
    void main() {
      #ifdef USE_INSTANCING_COLOR
        vColor = instanceColor;
      #else
        vColor = vec3(1.0);
      #endif
      vNormal = normalize(mat3(instanceMatrix) * normal);
      vec4 wp = instanceMatrix * vec4(position, 1.0);
      vWorldPos = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `,
  `
    uniform vec3 uCoreColor;
    uniform vec3 uGlowColor;
    varying vec3 vColor;
    varying vec3 vNormal;
    varying vec3 vWorldPos;

    void main() {
      float heat = clamp(vColor.r, 0.0, 1.0);
      vec3 V = normalize(cameraPosition - vWorldPos);
      float coreGlow = 0.5 + 0.5 * abs(dot(normalize(vNormal), V));
      vec3 col = mix(uCoreColor * 1.35, uGlowColor * 1.55, smoothstep(0.15, 0.65, heat));
      vec3 hotSpark = mix(uGlowColor * 1.40, vec3(1.55, 1.58, 1.62), 0.72);
      col = mix(col, hotSpark, smoothstep(0.62, 1.0, heat));
      float alpha = pow(heat, 0.75) * coreGlow;
      gl_FragColor = vec4(col * alpha, alpha);
    }
  `,
);

// ============================================================
// 5. ShockRingMaterial — 流星落点地面光环冲击波（与壁纸主体色一致）
// ============================================================
const ShockRingMaterial = createShaderMaterial(
  {
    uRippleColor: new se(0.5, 0.2, 1),
    uGlowColor: new se(0.65, 0.25, 1),
  },
  `
    varying vec2 vUv;
    varying float vLife;
    void main() {
      vUv = uv;
      #ifdef USE_INSTANCING_COLOR
        vLife = instanceColor.r;
      #else
        vLife = 1.0;
      #endif
      vec4 wp = instanceMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `,
  `
    uniform vec3 uRippleColor;
    uniform vec3 uGlowColor;
    varying vec2 vUv;
    varying float vLife;

    void main() {
      vec2 p = vUv * 2.0 - 1.0;
      float r = length(p);
      float oD = (r - 0.88) / 0.065;
      float iD = (r - 0.72) / 0.18;
      float outerRing = exp(-oD * oD);
      float innerHalo = exp(-iD * iD) * 0.45;
      float life = clamp(vLife, 0.0, 1.0);
      float env = pow(life, 1.35) * smoothstep(1.0, 0.88, life + 0.12);
      vec3 hotRing = mix(uGlowColor * 1.35, vec3(1.45, 1.48, 1.52), 0.65);
      vec3 col = mix(uRippleColor * 1.4, hotRing, outerRing * life);
      float alpha = (outerRing + innerHalo) * env * 0.85;
      gl_FragColor = vec4(col * alpha, alpha);
    }
  `,
);

export {
  createShaderMaterial,
  StaticPillarBakeMaterial,
  HeightfieldSimMaterial,
  MapShaderMaterial,
  FloorDiscMaterial,
  SkyShaderMaterial,
  MeteorShaderMaterial,
  SparkShaderMaterial,
  ShockRingMaterial,
};
