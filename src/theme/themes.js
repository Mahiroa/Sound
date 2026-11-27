// 模块: themes.js
// 20 套同色系邻近三色主题定义 + 轮换过渡（线性插值 Color）
// 每套主题均采用色轮邻近和谐三色：外环深辅色（uCool）→ 中环/内环主色（uMid / uWarm）→ 配套峰值强调色（uPeak），同步驱动地形、底盘、星云与极光
import { Color as se, MathUtils as e_ } from "three";

/**
 * 主题轮询顺序（20 主题全覆盖，含默认主题 nocturnal）
 * `cycle` 模式（用户自选）按此列表随机切换（非顺序），见 player.jsx
 */
const themeCycleOrder = [
  "nocturnal",
  "ocean-deep",
  "arctic-aurora",
  "cyber-forest",
  "golden-hour",
  "ember-fire",
  "crimson-sunset",
  "coral-mirage",
  "neon-tokyo",
  "minimal-monochrome",
  "teal-depth",
  "lavender-dream",
  "cherry-blossom",
  "copper-forge",
  "mint-fresh",
  "celadon",
  "amber",
  "aurora-green",
  "scarlet",
  "slate-blue",
];

/**
 * 线性插值两个主题 — 返回独立 Color 实例
 * @param {Theme} from - 起始主题
 * @param {Theme} to - 目标主题
 * @param {number} t - 0..1 插值系数
 * @returns {Theme} 插值结果
 */
function lerpTheme(from, to, t) {
  const clamped = Math.max(0, Math.min(1, t));
  return {
    name: clamped < 0.5 ? from.name : to.name,
    id: clamped < 0.5 ? from.id : to.id,
    uBaseColor1: new se().lerpColors(from.uBaseColor1, to.uBaseColor1, clamped),
    uBaseColor2: new se().lerpColors(from.uBaseColor2, to.uBaseColor2, clamped),
    uCoolCore: new se().lerpColors(from.uCoolCore, to.uCoolCore, clamped),
    uCoolEdge: new se().lerpColors(from.uCoolEdge, to.uCoolEdge, clamped),
    uWarmCore: new se().lerpColors(from.uWarmCore, to.uWarmCore, clamped),
    uWarmEdge: new se().lerpColors(from.uWarmEdge, to.uWarmEdge, clamped),
    uMidCore: new se().lerpColors(from.uMidCore, to.uMidCore, clamped),
    uMidEdge: new se().lerpColors(from.uMidEdge, to.uMidEdge, clamped),
    uRippleColor: new se().lerpColors(from.uRippleColor, to.uRippleColor, clamped),
    uPeakColor: new se().lerpColors(from.uPeakColor, to.uPeakColor, clamped),
    uGlowIntensity: e_.lerp(from.uGlowIntensity, to.uGlowIntensity, clamped),
  };
}

/**
 * 主题集合 — 每个主题包含:
 *   uBaseColor1/2  背景/雾色
 *   uWarmCore/Edge 暖色核/边缘（内圈，暖度高时主导）
 *   uMidCore/Edge  中间色核/边缘（中环，三色环带的中段）
 *   uCoolCore/Edge 冷色核/边缘（外圈，暖度低时主导）
 *   uRippleColor   波纹颜色
 *   uPeakColor     峰值/高柱强调色
 *   uGlowIntensity 整体发光强度倍率
 */
const themes = {
  nocturnal: {
    // 配套三色：深靛蓝 · 霁紫 · 兰花紫红
    name: "霁紫",
    id: "nocturnal",
    uBaseColor1: new se(0.005, 0.008, 0.026),
    uBaseColor2: new se(0.015, 0.022, 0.068),
    uCoolCore: new se(0.16, 0.22, 0.94),
    uCoolEdge: new se(0.06, 0.08, 0.46),
    uWarmCore: new se(0.64, 0.2, 0.98),
    uWarmEdge: new se(0.4, 0.08, 0.7),
    uMidCore: new se(0.44, 0.16, 0.96),
    uMidEdge: new se(0.22, 0.06, 0.6),
    uRippleColor: new se(0.52, 0.28, 1),
    uPeakColor: new se(0.96, 0.24, 0.88),
    uGlowIntensity: 1.05,
  },
  "ocean-deep": {
    // 配套三色：深海靛蓝 · 沧海蔚蓝 · 清透天青
    name: "沧蓝",
    id: "ocean-deep",
    uBaseColor1: new se(0.003, 0.008, 0.028),
    uBaseColor2: new se(0.008, 0.018, 0.062),
    uCoolCore: new se(0.1, 0.18, 0.88),
    uCoolEdge: new se(0.03, 0.06, 0.42),
    uWarmCore: new se(0.06, 0.58, 1),
    uWarmEdge: new se(0.02, 0.32, 0.72),
    uMidCore: new se(0.02, 0.36, 0.98),
    uMidEdge: new se(0.01, 0.16, 0.58),
    uRippleColor: new se(0.08, 0.62, 1),
    uPeakColor: new se(0.1, 0.86, 1),
    uGlowIntensity: 1.1,
  },
  "arctic-aurora": {
    // 配套三色：极地钴蓝 · 冰晶天蓝 · 冰薄荷青
    name: "冰蓝",
    id: "arctic-aurora",
    uBaseColor1: new se(0.003, 0.014, 0.024),
    uBaseColor2: new se(0.01, 0.028, 0.056),
    uCoolCore: new se(0.06, 0.42, 0.94),
    uCoolEdge: new se(0.02, 0.18, 0.5),
    uWarmCore: new se(0.14, 0.86, 0.96),
    uWarmEdge: new se(0.04, 0.52, 0.66),
    uMidCore: new se(0.04, 0.68, 0.96),
    uMidEdge: new se(0.01, 0.36, 0.62),
    uRippleColor: new se(0.14, 0.86, 0.94),
    uPeakColor: new se(0.18, 0.98, 0.72),
    uGlowIntensity: 1.22,
  },
  "cyber-forest": {
    // 配套三色：幽林深青 · 翡翠碧绿 · 青柠嫩绿
    name: "碧翠",
    id: "cyber-forest",
    uBaseColor1: new se(0.003, 0.018, 0.009),
    uBaseColor2: new se(0.01, 0.044, 0.024),
    uCoolCore: new se(0, 0.56, 0.56),
    uCoolEdge: new se(0, 0.24, 0.26),
    uWarmCore: new se(0.22, 0.94, 0.26),
    uWarmEdge: new se(0.08, 0.56, 0.14),
    uMidCore: new se(0.04, 0.82, 0.36),
    uMidEdge: new se(0.01, 0.44, 0.2),
    uRippleColor: new se(0.18, 0.92, 0.42),
    uPeakColor: new se(0.62, 0.98, 0.14),
    uGlowIntensity: 1.25,
  },
  "golden-hour": {
    // 配套三色：古铜琥珀 · 璀璨流金 · 炽暖日落橙
    name: "流金",
    id: "golden-hour",
    uBaseColor1: new se(0.02, 0.013, 0.004),
    uBaseColor2: new se(0.048, 0.032, 0.01),
    uCoolCore: new se(0.74, 0.38, 0.04),
    uCoolEdge: new se(0.4, 0.18, 0.02),
    uWarmCore: new se(1, 0.8, 0.16),
    uWarmEdge: new se(0.8, 0.56, 0.08),
    uMidCore: new se(0.94, 0.64, 0.06),
    uMidEdge: new se(0.62, 0.36, 0.02),
    uRippleColor: new se(1, 0.72, 0.16),
    uPeakColor: new se(1, 0.34, 0.02),
    uGlowIntensity: 1.2,
  },
  "ember-fire": {
    // 配套三色：暗炭深红 · 烈焰橘橙 · 熔芯暖金
    name: "余烬",
    id: "ember-fire",
    uBaseColor1: new se(0.022, 0.007, 0.002),
    uBaseColor2: new se(0.052, 0.016, 0.005),
    uCoolCore: new se(0.84, 0.14, 0.04),
    uCoolEdge: new se(0.44, 0.05, 0.01),
    uWarmCore: new se(1, 0.6, 0.06),
    uWarmEdge: new se(0.78, 0.36, 0.02),
    uMidCore: new se(0.98, 0.4, 0.02),
    uMidEdge: new se(0.64, 0.18, 0.01),
    uRippleColor: new se(1, 0.52, 0.08),
    uPeakColor: new se(1, 0.84, 0.14),
    uGlowIntensity: 1.4,
  },
  "crimson-sunset": {
    // 配套三色：深酒暗红 · 炽烈赤红 · 晚霞焰橙
    name: "赤焰",
    id: "crimson-sunset",
    uBaseColor1: new se(0.024, 0.003, 0.006),
    uBaseColor2: new se(0.054, 0.01, 0.014),
    uCoolCore: new se(0.68, 0.05, 0.16),
    uCoolEdge: new se(0.36, 0.02, 0.08),
    uWarmCore: new se(1, 0.24, 0.08),
    uWarmEdge: new se(0.76, 0.1, 0.03),
    uMidCore: new se(0.96, 0.1, 0.1),
    uMidEdge: new se(0.62, 0.03, 0.04),
    uRippleColor: new se(1, 0.22, 0.14),
    uPeakColor: new se(1, 0.52, 0.06),
    uGlowIntensity: 1.38,
  },
  "coral-mirage": {
    // 配套三色：深玫霞红 · 珊瑚霞粉 · 暖蜜桃橙
    name: "霞粉",
    id: "coral-mirage",
    uBaseColor1: new se(0.02, 0.006, 0.011),
    uBaseColor2: new se(0.046, 0.015, 0.024),
    uCoolCore: new se(0.84, 0.16, 0.32),
    uCoolEdge: new se(0.48, 0.06, 0.16),
    uWarmCore: new se(1, 0.5, 0.38),
    uWarmEdge: new se(0.8, 0.28, 0.22),
    uMidCore: new se(1, 0.34, 0.36),
    uMidEdge: new se(0.72, 0.16, 0.2),
    uRippleColor: new se(1, 0.44, 0.42),
    uPeakColor: new se(1, 0.68, 0.24),
    uGlowIntensity: 1.28,
  },
  "neon-tokyo": {
    // 配套三色：电光蓝紫 · 幻紫罗兰 · 霓虹玫红
    name: "幻紫",
    id: "neon-tokyo",
    uBaseColor1: new se(0.012, 0.003, 0.026),
    uBaseColor2: new se(0.032, 0.009, 0.066),
    uCoolCore: new se(0.34, 0.08, 0.96),
    uCoolEdge: new se(0.16, 0.03, 0.52),
    uWarmCore: new se(0.94, 0.14, 0.72),
    uWarmEdge: new se(0.64, 0.05, 0.48),
    uMidCore: new se(0.72, 0.1, 0.92),
    uMidEdge: new se(0.44, 0.04, 0.58),
    uRippleColor: new se(0.86, 0.18, 0.88),
    uPeakColor: new se(1, 0.22, 0.48),
    uGlowIntensity: 1.48,
  },
  "minimal-monochrome": {
    // 配套三色：松烟冷灰 · 淡墨银灰 · 宣纸暖白
    name: "水墨",
    id: "minimal-monochrome",
    uBaseColor1: new se(0.012, 0.013, 0.016),
    uBaseColor2: new se(0.038, 0.04, 0.045),
    uCoolCore: new se(0.42, 0.48, 0.54),
    uCoolEdge: new se(0.18, 0.22, 0.26),
    uWarmCore: new se(0.9, 0.89, 0.86),
    uWarmEdge: new se(0.58, 0.57, 0.54),
    uMidCore: new se(0.7, 0.71, 0.72),
    uMidEdge: new se(0.38, 0.39, 0.4),
    uRippleColor: new se(0.88, 0.9, 0.92),
    uPeakColor: new se(1, 0.96, 0.88),
    uGlowIntensity: 0.82,
  },
  "teal-depth": {
    // 配套三色：深海蓝青 · 幽青绿 · 清亮浅碧青
    name: "幽青",
    id: "teal-depth",
    uBaseColor1: new se(0.002, 0.016, 0.022),
    uBaseColor2: new se(0.008, 0.038, 0.048),
    uCoolCore: new se(0, 0.34, 0.62),
    uCoolEdge: new se(0, 0.14, 0.3),
    uWarmCore: new se(0.08, 0.78, 0.66),
    uWarmEdge: new se(0.03, 0.44, 0.4),
    uMidCore: new se(0, 0.58, 0.56),
    uMidEdge: new se(0, 0.28, 0.3),
    uRippleColor: new se(0.1, 0.78, 0.72),
    uPeakColor: new se(0.18, 0.96, 0.86),
    uGlowIntensity: 1.2,
  },
  "lavender-dream": {
    // 配套三色：星辰蓝紫 · 薰衣草紫 · 柔光丁香粉紫
    name: "薰衣草",
    id: "lavender-dream",
    uBaseColor1: new se(0.011, 0.008, 0.024),
    uBaseColor2: new se(0.028, 0.02, 0.056),
    uCoolCore: new se(0.36, 0.38, 0.9),
    uCoolEdge: new se(0.16, 0.18, 0.5),
    uWarmCore: new se(0.78, 0.48, 0.96),
    uWarmEdge: new se(0.5, 0.28, 0.7),
    uMidCore: new se(0.6, 0.4, 0.94),
    uMidEdge: new se(0.34, 0.2, 0.62),
    uRippleColor: new se(0.66, 0.48, 0.98),
    uPeakColor: new se(0.96, 0.52, 0.86),
    uGlowIntensity: 1.12,
  },
  "cherry-blossom": {
    // 配套三色：夜樱玫红 · 樱花粉 · 柔紫樱粉
    name: "樱",
    id: "cherry-blossom",
    uBaseColor1: new se(0.018, 0.005, 0.014),
    uBaseColor2: new se(0.042, 0.013, 0.028),
    uCoolCore: new se(0.84, 0.26, 0.48),
    uCoolEdge: new se(0.48, 0.12, 0.26),
    uWarmCore: new se(1, 0.68, 0.76),
    uWarmEdge: new se(0.82, 0.42, 0.52),
    uMidCore: new se(0.98, 0.5, 0.64),
    uMidEdge: new se(0.68, 0.26, 0.4),
    uRippleColor: new se(1, 0.6, 0.72),
    uPeakColor: new se(1, 0.56, 0.88),
    uGlowIntensity: 1.15,
  },
  "copper-forge": {
    // 配套三色：暗锈红铜 · 锻打红铜 · 炉火琥珀金
    name: "锻铜",
    id: "copper-forge",
    uBaseColor1: new se(0.02, 0.009, 0.004),
    uBaseColor2: new se(0.046, 0.022, 0.01),
    uCoolCore: new se(0.68, 0.2, 0.08),
    uCoolEdge: new se(0.36, 0.09, 0.03),
    uWarmCore: new se(0.98, 0.6, 0.22),
    uWarmEdge: new se(0.72, 0.38, 0.12),
    uMidCore: new se(0.88, 0.42, 0.14),
    uMidEdge: new se(0.56, 0.22, 0.06),
    uRippleColor: new se(0.94, 0.54, 0.2),
    uPeakColor: new se(1, 0.78, 0.24),
    uGlowIntensity: 1.28,
  },
  "mint-fresh": {
    // 配套三色：冰爽海青 · 清新薄荷绿 · 嫩芽薄荷绿
    name: "薄荷",
    id: "mint-fresh",
    uBaseColor1: new se(0.003, 0.018, 0.018),
    uBaseColor2: new se(0.01, 0.042, 0.04),
    uCoolCore: new se(0.1, 0.68, 0.84),
    uCoolEdge: new se(0.04, 0.34, 0.46),
    uWarmCore: new se(0.36, 0.96, 0.64),
    uWarmEdge: new se(0.16, 0.62, 0.4),
    uMidCore: new se(0.2, 0.88, 0.68),
    uMidEdge: new se(0.08, 0.5, 0.38),
    uRippleColor: new se(0.3, 0.94, 0.74),
    uPeakColor: new se(0.58, 1, 0.48),
    uGlowIntensity: 1.18,
  },
  celadon: {
    // 配套三色：雨过天青 · 温润青瓷 · 冰裂釉青
    name: "青瓷",
    id: "celadon",
    uBaseColor1: new se(0.005, 0.018, 0.017),
    uBaseColor2: new se(0.015, 0.042, 0.038),
    uCoolCore: new se(0.14, 0.48, 0.62),
    uCoolEdge: new se(0.05, 0.22, 0.32),
    uWarmCore: new se(0.44, 0.84, 0.64),
    uWarmEdge: new se(0.24, 0.54, 0.4),
    uMidCore: new se(0.26, 0.72, 0.58),
    uMidEdge: new se(0.12, 0.4, 0.32),
    uRippleColor: new se(0.4, 0.84, 0.7),
    uPeakColor: new se(0.36, 0.92, 0.86),
    uGlowIntensity: 1.12,
  },
  amber: {
    // 配套三色：深赤琥珀 · 透亮琥珀橙 · 暖蜜金黄
    name: "琥珀",
    id: "amber",
    uBaseColor1: new se(0.02, 0.01, 0.003),
    uBaseColor2: new se(0.048, 0.024, 0.007),
    uCoolCore: new se(0.76, 0.24, 0.02),
    uCoolEdge: new se(0.42, 0.1, 0.01),
    uWarmCore: new se(1, 0.68, 0.1),
    uWarmEdge: new se(0.78, 0.44, 0.04),
    uMidCore: new se(0.96, 0.5, 0.04),
    uMidEdge: new se(0.64, 0.26, 0.01),
    uRippleColor: new se(1, 0.64, 0.12),
    uPeakColor: new se(1, 0.88, 0.24),
    uGlowIntensity: 1.32,
  },
  "aurora-green": {
    // 配套三色：极夜青蓝 · 极光翠绿 · 荧光极光嫩绿
    name: "极光绿",
    id: "aurora-green",
    uBaseColor1: new se(0.004, 0.018, 0.015),
    uBaseColor2: new se(0.012, 0.042, 0.032),
    uCoolCore: new se(0, 0.54, 0.72),
    uCoolEdge: new se(0, 0.24, 0.36),
    uWarmCore: new se(0.18, 0.98, 0.56),
    uWarmEdge: new se(0.08, 0.62, 0.34),
    uMidCore: new se(0.04, 0.92, 0.5),
    uMidEdge: new se(0.01, 0.5, 0.26),
    uRippleColor: new se(0.22, 0.98, 0.62),
    uPeakColor: new se(0.52, 1, 0.32),
    uGlowIntensity: 1.35,
  },
  scarlet: {
    // 配套三色：深宝石红 · 炽烈绯红 · 炽亮橘金
    name: "绯红",
    id: "scarlet",
    uBaseColor1: new se(0.026, 0.004, 0.005),
    uBaseColor2: new se(0.058, 0.01, 0.012),
    uCoolCore: new se(0.78, 0.06, 0.12),
    uCoolEdge: new se(0.42, 0.02, 0.05),
    uWarmCore: new se(1, 0.34, 0.1),
    uWarmEdge: new se(0.78, 0.16, 0.04),
    uMidCore: new se(0.98, 0.16, 0.1),
    uMidEdge: new se(0.66, 0.06, 0.04),
    uRippleColor: new se(1, 0.28, 0.14),
    uPeakColor: new se(1, 0.64, 0.1),
    uGlowIntensity: 1.4,
  },
  "slate-blue": {
    // 配套三色：深石板蓝 · 雾霭灰蓝 · 柔光冰紫蓝
    name: "灰蓝",
    id: "slate-blue",
    uBaseColor1: new se(0.01, 0.015, 0.028),
    uBaseColor2: new se(0.03, 0.042, 0.072),
    uCoolCore: new se(0.16, 0.32, 0.58),
    uCoolEdge: new se(0.07, 0.15, 0.3),
    uWarmCore: new se(0.48, 0.6, 0.88),
    uWarmEdge: new se(0.26, 0.35, 0.58),
    uMidCore: new se(0.3, 0.46, 0.74),
    uMidEdge: new se(0.15, 0.25, 0.44),
    uRippleColor: new se(0.48, 0.62, 0.9),
    uPeakColor: new se(0.64, 0.66, 0.98),
    uGlowIntensity: 1.06,
  },
};

export { themeCycleOrder, lerpTheme, themes };
