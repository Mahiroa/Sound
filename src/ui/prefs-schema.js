// 模块: prefs-schema.js
// 用户偏好字段的唯一定义处（schema 驱动）
// 由 usePrefs.js 根据本 schema 自动生成: state 初始化 / localStorage 持久化 / 预设快照 / 导入 / WE 属性映射
// 新增偏好字段只需在此加一行，其余五套逻辑自动同步（V2-4 重构目标）
import { audioEngine } from "../audio/audio-engine.js";

// state 型偏好：持久化 + 导入导出 + WE user-props 映射
//   key: 偏好键名（同时作为 prefs 对象的字段名）
//   we: Wallpaper Engine 属性名（user props 的 key）；general 字段走 applyGeneralProperties（平铺结构）
//   general: 是否为 general props（general props 是平铺 {fps:30}，非 {value} 结构）
//   default: 默认值；null 表示运行时动态计算
export const PREFS_SCHEMA = [
  { key: "fps", we: "fps", general: true, default: 0 },
  { key: "theme", we: "theme", default: "random" },
  { key: "cameraDistance", we: "cameraDistance", default: 70 },
  { key: "cameraAngleX", we: "cameraAngleX", default: 0 },
  { key: "cameraAngleY", we: "cameraAngleY", default: 20 },
  { key: "autoRotateEnabled", we: "autoRotateEnabled", default: true },
  { key: "autoRotateSpeed", we: "autoRotateSpeed", default: 1 },
  { key: "idleWaveEnabled", we: "idleWaveEnabled", default: true },
  { key: "showPlayerController", we: "showPlayerController", default: false },
  { key: "showAlbumCover", we: "showAlbumCover", default: true },
  { key: "controllerSize", we: "controllerSize", default: null }, // 移动端动态默认
  { key: "controllerX", we: "controllerX", default: 2 },
  { key: "controllerY", we: "controllerY", default: 3 },
  { key: "audioIntensity", we: "audioIntensity", default: 1 },
  { key: "responseRange", we: "responseRange", default: 1 },
  { key: "gridSize", we: "gridSize", default: 96 },
  { key: "meteorClickEnabled", we: "meteorClickEnabled", default: true },
  { key: "peakColorEnabled", we: "peakColorEnabled", default: false },
  { key: "peakColorIntensity", we: "peakColorIntensity", default: 1 },
  { key: "lowPillarDim", we: "lowPillarDim", default: 0.35 },
  { key: "themeCycleInterval", we: "themeCycleInterval", default: 60 },
  { key: "clockEnabled", we: "clockEnabled", default: true },
  { key: "clockFont", we: "clockFont", default: "Impact" },
  { key: "clockSize", we: "clockSize", default: 120 },
  { key: "clockColor", we: "clockColor", default: "#ffffff" },
  { key: "clockOpacity", we: "clockOpacity", default: 0.7 },
  { key: "clockShowSeconds", we: "clockShowSeconds", default: true },
  { key: "clockDateStyle", we: "clockDateStyle", default: "iso" },
  { key: "clockGlassEnabled", we: "clockGlassEnabled", default: true },
  { key: "clockGlassStrength", we: "clockGlassStrength", default: 10 },
  { key: "clockShadowEnabled", we: "clockShadowEnabled", default: true },
  { key: "clockX", we: "clockX", default: 50 },
  { key: "clockY", we: "clockY", default: 17 },
  { key: "coverMix", we: "coverMix", default: 0 },
];

// 副作用型属性：只做 WE user-props 映射，不持久化（直接写入 audioEngine）
export const SIDE_EFFECT_PROPS = [
  { we: "idleWaveDebounce", apply: (v) => audioEngine.setIdleWaveDebounce(v) },
  { we: "idleWaveFadeDuration", apply: (v) => audioEngine.setIdleFadeOutDuration(v) },
  { we: "pulseEnabled", apply: (v) => { audioEngine.pulseTrigger.enabled = v; } },
  { we: "pulseSensitivity", apply: (v) => { audioEngine.pulseTrigger.sensitivity = v; } },
  { we: "pulseCooldown", apply: (v) => { audioEngine.pulseTrigger.cooldown = v; } },
  { we: "meteorEnabled", apply: (v) => { audioEngine.meteorTrigger.enabled = v; } },
  { we: "meteorSensitivity", apply: (v) => { audioEngine.meteorTrigger.sensitivity = v; } },
  { we: "meteorCooldown", apply: (v) => { audioEngine.meteorTrigger.cooldown = v; } },
];
