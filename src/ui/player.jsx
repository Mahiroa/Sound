// 模块: player.jsx
// 高性能播放器 UI 与根组件：
//   - 移除 framer-motion，采用纯 CSS 合成器动画，瘦身包体与 V8 堆内存
//   - 独立 React.memo(ClockWidget / MediaPlayerCard)，播放态与主题轮换 RootApp 0 重渲染
//   - 进度条采用 transform: scaleX() 零回流更新，封面取消额外 filter: blur() 离屏 pass
import * as le from "react";
import * as Dt from "react/jsx-runtime";
import { useThree as tL, Canvas as QH } from "@react-three/fiber";
import { audioEngine } from "../audio/audio-engine.js";
import { themes } from "../theme/themes.js";
import {
  setUserPropsHandler,
  setGeneralPropsHandler,
  takePendingUserProps,
  takePendingGeneralProps,
} from "../integration.js";
import { TerrainScene } from "../scene/TerrainScene.jsx";
import { usePrefs } from "./usePrefs.js";

// WE 无 audio listener 注销 API，模块级标志防 StrictMode 双挂载重复注册
let audioListenerRegistered = false;

// VSync 对齐的帧率限制器：标签隐藏自动暂停，避免 setTimeout 抖动
const FpsLimiter = le.memo(function FpsLimiter({ fpsLimit: i }) {
  const { invalidate: e } = tL();
  le.useEffect(() => {
    let rafId = 0;
    if (i <= 0) {
      const tick = () => {
        e();
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    } else {
      const interval = 1000 / i;
      let last = performance.now();
      const tick = (now) => {
        const elapsed = now - last;
        if (elapsed >= interval - 1) {
          last = now - (elapsed % interval);
          e();
        }
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    }
    return () => cancelAnimationFrame(rafId);
  }, [i, e]);
  return null;
});

// 将 WE color 属性值 (如 "1 1 1") 转为 CSS 颜色; 已是 CSS 颜色则原样返回
const colorToCss = (rgb) => {
  const parts = String(rgb).trim().split(/\s+/).map(Number);
  if (parts.length >= 3 && parts.every((n) => !isNaN(n))) {
    return `rgb(${Math.round(parts[0] * 255)}, ${Math.round(parts[1] * 255)}, ${Math.round(parts[2] * 255)})`;
  }
  return rgb;
};

const pad2 = (n) => (n < 10 ? `0${n}` : String(n));

function formatClockSnapshot(dateStyle, showSeconds) {
  const d = new Date();
  const hh = pad2(d.getHours());
  const mm = pad2(d.getMinutes());
  const ss = showSeconds ? pad2(d.getSeconds()) : "";
  const dateText =
    dateStyle === "cn"
      ? `${d.getFullYear()}年${pad2(d.getMonth() + 1)}月${pad2(d.getDate())}日`
      : dateStyle === "short"
        ? `${pad2(d.getMonth() + 1)} · ${pad2(d.getDate())}`
        : `${d.getFullYear()}.${pad2(d.getMonth() + 1)}.${pad2(d.getDate())}`;
  return { hh, mm, ss, dateText };
}

function formatDuration(sec) {
  if (!sec || isNaN(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${pad2(s)}`;
}

// 时钟组件: 未开启秒数时仅在分钟变化时更新状态（重渲染从 60次/分 降至 1次/分）
const ClockWidget = le.memo(function ClockWidget({
  font = "Segoe UI",
  size = 28,
  color = "#ffffff",
  opacity = 0.9,
  showSeconds = false,
  dateStyle = "iso",
  glassEnabled = true,
  glassStrength = 12,
  shadowEnabled = true,
  x = 50,
  y = 18,
}) {
  const [snap, setSnap] = le.useState(() => formatClockSnapshot(dateStyle, showSeconds));

  le.useEffect(() => {
    const sync = () => {
      const next = formatClockSnapshot(dateStyle, showSeconds);
      setSnap((prev) =>
        prev.hh === next.hh &&
        prev.mm === next.mm &&
        prev.ss === next.ss &&
        prev.dateText === next.dateText
          ? prev
          : next,
      );
    };
    sync();
    const id = setInterval(sync, 1000);
    return () => clearInterval(id);
  }, [dateStyle, showSeconds]);

  const padY = Math.round(Math.max(8, size * 0.16));
  const padX = Math.round(Math.max(20, size * 0.50));

  return Dt.jsxs("div", {
    style: {
      position: "absolute",
      top: `${y}%`,
      left: `${x}%`,
      transform: `translate(-${x}%, -${y}%)`,
      zIndex: 40,
      textAlign: "center",
      whiteSpace: "nowrap",
      pointerEvents: "none",
      userSelect: "none",
      contain: "layout style paint",
      fontFamily: `${font}, -apple-system, BlinkMacSystemFont, sans-serif`,
      color,
      lineHeight: 1.15,
      background: glassEnabled
        ? "linear-gradient(155deg, rgba(10,14,26,0.34) 0%, rgba(4,6,14,0.22) 100%)"
        : "transparent",
      backdropFilter: glassEnabled
        ? `blur(${glassStrength}px) saturate(1.35)`
        : "none",
      WebkitBackdropFilter: glassEnabled
        ? `blur(${glassStrength}px) saturate(1.35)`
        : "none",
      borderRadius: glassEnabled ? "20px" : "0",
      padding: glassEnabled ? `${padY}px ${padX}px` : "0",
      border: glassEnabled ? "1px solid rgba(255,255,255,0.10)" : "none",
      boxShadow: glassEnabled
        ? shadowEnabled
          ? "0 14px 40px rgba(0,0,0,0.38), inset 0 1px 0 rgba(255,255,255,0.14), inset 0 -1px 0 rgba(255,255,255,0.03), 0 0 28px color-mix(in srgb, var(--sw-accent, #7c3aed) 14%, transparent)"
          : "inset 0 1px 0 rgba(255,255,255,0.14), inset 0 -1px 0 rgba(255,255,255,0.03)"
        : "none",
      overflow: "hidden",
    },
    children: [
      glassEnabled &&
        Dt.jsx("div", {
          style: {
            position: "absolute",
            top: 0,
            left: "16%",
            right: "16%",
            height: "1px",
            background:
              "linear-gradient(90deg, transparent, rgba(255,255,255,0.32), var(--sw-accent, #a78bfa), rgba(255,255,255,0.32), transparent)",
            opacity: 0.55,
          },
        }),
      Dt.jsxs("div", {
        style: { opacity },
        children: [
          Dt.jsxs("div", {
            style: {
              fontSize: `${size}px`,
              fontWeight: 300,
              letterSpacing: "0.06em",
              fontVariantNumeric: "tabular-nums",
              textShadow: shadowEnabled
                ? glassEnabled
                  ? "0 2px 14px rgba(0,0,0,0.45), 0 0 22px color-mix(in srgb, var(--sw-accent, #7c3aed) 24%, transparent)"
                  : "0 3px 18px rgba(0,0,0,0.68), 0 0 28px color-mix(in srgb, var(--sw-accent, #7c3aed) 30%, transparent)"
                : "none",
              display: "inline-flex",
              alignItems: "baseline",
              justifyContent: "center",
            },
            children: [
              Dt.jsx("span", { children: snap.hh }),
              Dt.jsx("span", { className: "sw-colon", children: ":" }),
              Dt.jsx("span", { children: snap.mm }),
              showSeconds &&
                Dt.jsx("span", {
                  style: {
                    fontSize: `${Math.round(size * 0.52)}px`,
                    opacity: 0.62,
                    marginLeft: "0.18em",
                    fontWeight: 350,
                    letterSpacing: "0.04em",
                  },
                  children: snap.ss,
                }),
            ],
          }),
          Dt.jsx("div", {
            style: {
              width: `${Math.max(46, Math.round(size * 1.45))}px`,
              height: "1px",
              margin: `${Math.max(5, Math.round(size * 0.12))}px auto ${Math.max(4, Math.round(size * 0.1))}px`,
              background:
                "linear-gradient(90deg, transparent, color-mix(in srgb, var(--sw-accent, #a78bfa) 68%, rgba(255,255,255,0.5)), transparent)",
              opacity: 0.55,
            },
          }),
          Dt.jsx("div", {
            style: {
              fontSize: `${Math.max(11, Math.round(size * 0.28))}px`,
              opacity: 0.72,
              fontWeight: 400,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              textShadow: shadowEnabled ? "0 1px 10px rgba(0,0,0,0.55)" : "none",
            },
            children: snap.dateText,
          }),
        ],
      }),
    ],
  });
});

const CARD_SIZES = {
  small: {
    width: 304,
    cover: 74,
    padding: 14,
    gap: 12,
    title: 14,
    artist: 11.5,
    progressHeight: 4,
    timeText: 9.5,
  },
  medium: {
    width: 364,
    cover: 90,
    padding: 16,
    gap: 14,
    title: 15.5,
    artist: 12.5,
    progressHeight: 4.5,
    timeText: 10,
  },
  large: {
    width: 424,
    cover: 108,
    padding: 18,
    gap: 18,
    title: 17.5,
    artist: 13.5,
    progressHeight: 5,
    timeText: 11,
  },
};

// 独立媒体播放卡片：完全隔离媒体进度与显隐状态，杜绝播放态触发 RootApp / Canvas 重渲染
const MediaPlayerCard = le.memo(function MediaPlayerCard({
  showPlayerController,
  showAlbumCover,
  controllerSize,
  controllerX,
  controllerY,
  onCoverColorChange,
}) {
  const initMedia = window.__mediaState || {
    title: "",
    artist: "",
    thumbnail: "",
    primaryColor: "",
    isPlaying: false,
    position: 0,
    duration: 0,
  };
  const [media, setMedia] = le.useState(() => ({
    title: initMedia.title || "",
    artist: initMedia.artist || "",
    thumbnail: initMedia.thumbnail || "",
    primaryColor: initMedia.primaryColor || "",
    isPlaying: Boolean(initMedia.isPlaying),
    position: initMedia.position || 0,
    duration: initMedia.duration || 0,
  }));

  const [audioIdle, setAudioIdle] = le.useState(true);
  const [delayedPlaying, setDelayedPlaying] = le.useState(false);
  const [displaySec, setDisplaySec] = le.useState(() => Math.floor(initMedia.position || 0));

  const idleDeadlineRef = le.useRef(Infinity);
  const posAnchorRef = le.useRef({ position: initMedia.position || 0, time: performance.now() });
  const barFillRef = le.useRef(null);
  const barDotRef = le.useRef(null);
  const lastPrimaryColorRef = le.useRef(initMedia.primaryColor || "");

  // 订阅 WE 媒体状态（仅曲目变化时同步 coverColor 给 RootApp）
  le.useEffect(() => {
    if (lastPrimaryColorRef.current) {
      onCoverColorChange(lastPrimaryColorRef.current);
    }
    if (!window.__mediaState) return;
    const onUpdate = (st) => {
      const pc = st.primaryColor || "";
      if (pc !== lastPrimaryColorRef.current) {
        lastPrimaryColorRef.current = pc;
        onCoverColorChange(pc);
      }
      posAnchorRef.current = { position: st.position || 0, time: performance.now() };
      setDisplaySec(Math.floor(st.position || 0));
      setMedia((prev) =>
        prev.title === (st.title || "") &&
        prev.artist === (st.artist || "") &&
        prev.thumbnail === (st.thumbnail || "") &&
        prev.primaryColor === pc &&
        prev.isPlaying === Boolean(st.isPlaying) &&
        prev.position === (st.position || 0) &&
        prev.duration === (st.duration || 0)
          ? prev
          : {
              title: st.title || "",
              artist: st.artist || "",
              thumbnail: st.thumbnail || "",
              primaryColor: pc,
              isPlaying: Boolean(st.isPlaying),
              position: st.position || 0,
              duration: st.duration || 0,
            },
      );
    };
    window.__mediaState._callbacks.push(onUpdate);
    return () => {
      const idx = window.__mediaState._callbacks.indexOf(onUpdate);
      if (idx > -1) window.__mediaState._callbacks.splice(idx, 1);
    };
  }, [onCoverColorChange]);

  const hasMedia = Boolean(media.title || media.artist || media.thumbnail);

  // 仅在启用卡片且存在媒体且未处于明确播放态时轮询音频活跃度
  le.useEffect(() => {
    if (!showPlayerController || !hasMedia) {
      setAudioIdle(true);
      return;
    }
    if (media.isPlaying) {
      setAudioIdle(false);
      idleDeadlineRef.current = Infinity;
      return;
    }
    const id = setInterval(() => {
      const now = performance.now();
      if (audioEngine.smoothedData.energy > 0.05) {
        setAudioIdle(false);
        idleDeadlineRef.current = Infinity;
      } else if (idleDeadlineRef.current === Infinity) {
        idleDeadlineRef.current = now + 3000;
      } else if (now >= idleDeadlineRef.current) {
        setAudioIdle(true);
      }
    }, 300);
    return () => clearInterval(id);
  }, [showPlayerController, hasMedia, media.isPlaying]);

  le.useEffect(() => {
    if (media.isPlaying && hasMedia) {
      const id = setTimeout(() => setDelayedPlaying(true), 1000);
      return () => clearTimeout(id);
    }
    setDelayedPlaying(false);
  }, [media.isPlaying, hasMedia]);

  const visible = showPlayerController && (delayedPlaying || (!audioIdle && hasMedia));

  // 进度条直接通过 transform: scaleX() 更新（零浏览器回流），整数秒文本仅每秒最多更新 1 次
  le.useEffect(() => {
    const applyRatio = (pos) => {
      const ratio = media.duration > 0 ? Math.min(1, Math.max(0, pos / media.duration)) : 0;
      if (barFillRef.current) {
        barFillRef.current.style.transform = `scaleX(${ratio})`;
      }
      if (barDotRef.current) {
        barDotRef.current.style.left = `${ratio * 100}%`;
      }
    };
    applyRatio(posAnchorRef.current.position);
    if (!media.isPlaying || media.duration <= 0 || !showPlayerController) return;
    const tick = () => {
      const cur = Math.min(
        posAnchorRef.current.position + (performance.now() - posAnchorRef.current.time) / 1000,
        media.duration,
      );
      applyRatio(cur);
      const wholeSec = Math.floor(cur);
      setDisplaySec((prev) => (prev === wholeSec ? prev : wholeSec));
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [media.isPlaying, media.duration, media.position, showPlayerController]);

  if (!showPlayerController) return null;

  const wt = CARD_SIZES[controllerSize] || CARD_SIZES.large;
  const cardAccent = media.primaryColor ? colorToCss(media.primaryColor) : "var(--sw-accent, #7c3aed)";
  const initialRatio =
    media.duration > 0 ? Math.min(1, Math.max(0, displaySec / media.duration)) : 0;

  return Dt.jsx("div", {
    className: "absolute z-50 select-none",
    style: {
      top: `${controllerY}vh`,
      right: `${controllerX}vw`,
      opacity: visible ? 1 : 0,
      visibility: visible ? "visible" : "hidden",
      transform: visible ? "scale(1) translateY(0px)" : "scale(0.92) translateY(-8px)",
      transformOrigin: "top right",
      pointerEvents: visible ? "auto" : "none",
      contain: "layout style paint",
      transition: visible
        ? "opacity 600ms cubic-bezier(0.4, 0, 0.2, 1), transform 600ms cubic-bezier(0.4, 0, 0.2, 1), visibility 0ms linear 0ms"
        : "opacity 600ms cubic-bezier(0.4, 0, 0.2, 1), transform 600ms cubic-bezier(0.4, 0, 0.2, 1), visibility 0ms linear 600ms",
    },
    children: Dt.jsxs("div", {
      className: "relative overflow-hidden",
      style: {
        background: "linear-gradient(145deg, rgba(10,14,26,0.56) 0%, rgba(4,6,14,0.44) 100%)",
        backdropFilter: visible ? "blur(26px) saturate(1.45)" : "none",
        WebkitBackdropFilter: visible ? "blur(26px) saturate(1.45)" : "none",
        border: "1px solid rgba(255,255,255,0.10)",
        borderRadius: "20px",
        boxShadow:
          "0 18px 50px rgba(0,0,0,0.54), inset 0 1px 0 rgba(255,255,255,0.14), 0 0 32px color-mix(in srgb, var(--sw-accent, #7c3aed) 14%, transparent)",
        width: `${wt.width}px`,
      },
      children: [
        Dt.jsx("div", {
          className: "pointer-events-none",
          style: {
            position: "absolute",
            top: 0,
            left: "12%",
            right: "12%",
            height: "1px",
            background:
              "linear-gradient(90deg, transparent, rgba(255,255,255,0.28), color-mix(in srgb, var(--sw-accent, #a78bfa) 70%, transparent), rgba(255,255,255,0.28), transparent)",
          },
        }),
        Dt.jsx("div", {
          className: "pointer-events-none",
          style: {
            position: "absolute",
            inset: 0,
            background: `radial-gradient(circle at 18% 50%, color-mix(in srgb, ${cardAccent} 18%, transparent), transparent 64%)`,
          },
        }),
        Dt.jsxs("div", {
          className: "relative",
          style: {
            display: "flex",
            gap: `${wt.gap}px`,
            padding: `${wt.padding}px`,
            alignItems: "center",
          },
          children: [
            showAlbumCover && media.thumbnail
              ? Dt.jsxs(
                  "div",
                  {
                    className: "flex-shrink-0 relative sw-cover-enter",
                    children: [
                      Dt.jsx("img", {
                        src: media.thumbnail,
                        alt: "",
                        className: "block rounded-[13px] object-cover relative",
                        style: {
                          width: `${wt.cover}px`,
                          height: `${wt.cover}px`,
                          // 使用零滤镜 box-shadow 替代原 filter: blur(6px) 额外离屏模糊 pass
                          boxShadow:
                            "0 8px 24px rgba(0,0,0,0.52), 0 0 0 1px rgba(255,255,255,0.10), 0 0 18px color-mix(in srgb, var(--sw-accent, #7c3aed) 30%, transparent)",
                        },
                      }),
                      Dt.jsx("div", {
                        className: "absolute inset-0 rounded-[13px] pointer-events-none",
                        style: {
                          background:
                            "linear-gradient(145deg, rgba(255,255,255,0.12) 0%, transparent 46%, rgba(0,0,0,0.28) 100%)",
                        },
                      }),
                    ],
                  },
                  media.thumbnail,
                )
              : Dt.jsx("div", {
                  className: "flex-shrink-0",
                  style: {
                    width: `${wt.cover}px`,
                    height: `${wt.cover}px`,
                  },
                }),
            Dt.jsxs("div", {
              className: "flex-1 min-w-0 flex flex-col justify-center",
              style: { gap: media.duration > 0 ? "10px" : "0" },
              children: [
                Dt.jsxs("div", {
                  children: [
                    Dt.jsx(
                      "div",
                      {
                        className: "truncate leading-snug sw-text-enter",
                        style: {
                          fontSize: `${wt.title}px`,
                          color: "rgba(255,255,255,0.94)",
                          letterSpacing: "0.015em",
                          fontWeight: 500,
                          textShadow: "0 1px 8px rgba(0,0,0,0.35)",
                          animationDelay: "0.14s",
                        },
                        title: media.title,
                        children: media.title || "--",
                      },
                      `t:${media.title || "empty"}`,
                    ),
                    Dt.jsx(
                      "div",
                      {
                        className: "truncate leading-snug sw-text-enter",
                        style: {
                          fontSize: `${wt.artist}px`,
                          color: "rgba(255,255,255,0.56)",
                          marginTop: "3px",
                          letterSpacing: "0.015em",
                          animationDelay: "0.22s",
                        },
                        title: media.artist,
                        children: media.artist || "--",
                      },
                      `a:${media.artist || "empty"}`,
                    ),
                  ],
                }),
                media.duration > 0 &&
                  Dt.jsxs("div", {
                    style: {
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                    },
                    children: [
                      media.isPlaying &&
                        Dt.jsxs("div", {
                          style: {
                            display: "flex",
                            alignItems: "flex-end",
                            gap: "2px",
                            height: "10px",
                            flexShrink: 0,
                          },
                          children: [
                            Dt.jsx("span", {
                              className: "sw-eq-bar",
                              style: {
                                backgroundColor: "var(--sw-accent, #7c3aed)",
                                animationDelay: "0s",
                              },
                            }),
                            Dt.jsx("span", {
                              className: "sw-eq-bar",
                              style: {
                                backgroundColor: "var(--sw-peak, #f59e0b)",
                                animationDelay: "0.24s",
                              },
                            }),
                            Dt.jsx("span", {
                              className: "sw-eq-bar",
                              style: {
                                backgroundColor: "var(--sw-accent, #7c3aed)",
                                animationDelay: "0.48s",
                              },
                            }),
                          ],
                        }),
                      Dt.jsxs("div", {
                        style: {
                          flex: 1,
                          height: `${wt.progressHeight}px`,
                          backgroundColor: "rgba(255,255,255,0.08)",
                          borderRadius: "999px",
                          overflow: "visible",
                          position: "relative",
                          boxShadow: "inset 0 1px 2px rgba(0,0,0,0.35)",
                        },
                        children: [
                          Dt.jsx("div", {
                            ref: barFillRef,
                            style: {
                              position: "absolute",
                              inset: 0,
                              borderRadius: "999px",
                              transformOrigin: "left center",
                              transform: `scaleX(${initialRatio})`,
                              background:
                                "linear-gradient(90deg, color-mix(in srgb, var(--sw-accent, #7c3aed) 80%, transparent), var(--sw-accent, #7c3aed), var(--sw-peak, #f59e0b))",
                              boxShadow:
                                "0 0 10px color-mix(in srgb, var(--sw-accent, #7c3aed) 35%, transparent)",
                              transition: "transform 250ms linear",
                            },
                          }),
                          Dt.jsx("div", {
                            ref: barDotRef,
                            style: {
                              position: "absolute",
                              left: `${initialRatio * 100}%`,
                              top: "50%",
                              transform: "translate(-50%, -50%)",
                              width: `${Math.max(6, wt.progressHeight + 2)}px`,
                              height: `${Math.max(6, wt.progressHeight + 2)}px`,
                              borderRadius: "999px",
                              backgroundColor: "#ffffff",
                              boxShadow:
                                "0 0 8px var(--sw-accent, #7c3aed), 0 0 14px color-mix(in srgb, var(--sw-peak, #f59e0b) 45%, transparent)",
                              transition: "left 250ms linear",
                            },
                          }),
                        ],
                      }),
                      Dt.jsxs("div", {
                        style: {
                          flexShrink: 0,
                          fontFamily:
                            "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                          color: "rgba(255,255,255,0.48)",
                          fontVariantNumeric: "tabular-nums",
                          fontSize: `${wt.timeText}px`,
                          minWidth: "52px",
                          textAlign: "right",
                          lineHeight: 1,
                          letterSpacing: "0.03em",
                        },
                        children: [formatDuration(displaySec), "/", formatDuration(media.duration)],
                      }),
                    ],
                  }),
              ],
            }),
          ],
        }),
      ],
    }),
  });
});

function RootApp() {
  const { prefs, applyUserProps, applyGeneralProps } = usePrefs();
  const {
    fps,
    theme,
    cameraDistance,
    cameraAngleX,
    cameraAngleY,
    autoRotateEnabled,
    autoRotateSpeed,
    idleWaveEnabled,
    showPlayerController,
    showAlbumCover,
    controllerSize,
    controllerX,
    controllerY,
    audioIntensity,
    responseRange,
    outOfRangeIntensity,
    centerBoost,
    randomSpikeIntensity,
    waveFlowIntensity,
    gridSize,
    meteorClickEnabled,
    peakColorEnabled,
    peakColorIntensity,
    lowPillarDim,
    themeCycleInterval,
    clockEnabled,
    clockFont,
    clockSize,
    clockColor,
    clockOpacity,
    clockShowSeconds,
    clockDateStyle,
    clockGlassEnabled,
    clockGlassStrength,
    clockShadowEnabled,
    clockX,
    clockY,
    coverMix,
  } = prefs;

  const sceneRef = le.useRef(null);
  const rootRef = le.useRef(null);
  const [coverColor, setCoverColor] = le.useState("");

  // 初始主题 CSS 变量（后续平滑变化由 TerrainScene 在 useFrame 内直接写入 rootRef，0 重渲染）
  const initTheme = themes[theme] || themes.nocturnal;
  const initBg = `#${initTheme.uBaseColor1.getHexString()}`;
  const initAccent = `#${initTheme.uRippleColor.getHexString()}`;
  const initPeak = `#${initTheme.uPeakColor.getHexString()}`;

  le.useEffect(() => {
    const win = window;
    if (win.wallpaperRegisterAudioListener && !audioListenerRegistered) {
      win.wallpaperRegisterAudioListener((data) => {
        audioEngine.setWallpaperAudioData(data);
      });
      audioListenerRegistered = true;
    }
    setUserPropsHandler(applyUserProps);
    setGeneralPropsHandler(applyGeneralProps);
    const pup = takePendingUserProps();
    const pgp = takePendingGeneralProps();
    if (pup) applyUserProps(pup);
    if (pgp) applyGeneralProps(pgp);
    if (win.wallpaperReady) win.wallpaperReady();
    return () => {
      setUserPropsHandler(null);
      setGeneralPropsHandler(null);
    };
  }, [applyUserProps, applyGeneralProps]);

  const onCanvasClick = le.useCallback(
    (ev) => {
      if (meteorClickEnabled && sceneRef.current) {
        sceneRef.current.triggerMeteorAt(ev.clientX, ev.clientY);
      }
    },
    [meteorClickEnabled],
  );

  const handleCoverColorChange = le.useCallback((col) => {
    setCoverColor((prev) => (prev === col ? prev : col));
  }, []);

  const clockCssColor = le.useMemo(() => colorToCss(clockColor), [clockColor]);

  return Dt.jsxs("div", {
    ref: rootRef,
    className: "w-screen h-screen overflow-hidden relative",
    style: {
      backgroundColor: initBg,
      "--sw-accent": initAccent,
      "--sw-peak": initPeak,
    },
    onClick: onCanvasClick,
    children: [
      Dt.jsx("div", {
        className: "absolute inset-0 z-0",
        children: Dt.jsxs(QH, {
          camera: { position: [35, 25, 35], fov: 45 },
          frameloop: "demand",
          dpr: [1, 1.25],
          gl: {
            antialias: true,
            powerPreference: "high-performance",
            alpha: false,
            stencil: false,
          },
          children: [
            Dt.jsx(FpsLimiter, { fpsLimit: fps }),
            Dt.jsx(TerrainScene, {
              ref: sceneRef,
              theme,
              themeCycleInterval,
              rootContainerRef: rootRef,
              audioIntensity,
              responseRange,
              outOfRangeIntensity,
              centerBoost,
              randomSpikeIntensity,
              waveFlowIntensity,
              gridSize,
              idleWaveEnabled,
              cameraDistance,
              cameraAngleX,
              cameraAngleY,
              autoRotateEnabled,
              autoRotateSpeed,
              peakColorEnabled,
              peakColorIntensity,
              lowPillarDim,
              coverColor,
              coverMix,
            }),
          ],
        }),
      }),
      clockEnabled &&
        Dt.jsx(ClockWidget, {
          font: clockFont,
          size: clockSize,
          color: clockCssColor,
          opacity: clockOpacity,
          showSeconds: clockShowSeconds,
          dateStyle: clockDateStyle,
          glassEnabled: clockGlassEnabled,
          glassStrength: clockGlassStrength,
          shadowEnabled: clockShadowEnabled,
          x: clockX,
          y: clockY,
        }),
      Dt.jsx(MediaPlayerCard, {
        showPlayerController,
        showAlbumCover,
        controllerSize,
        controllerX,
        controllerY,
        onCoverColorChange: handleCoverColorChange,
      }),
    ],
  });
}

export { RootApp, FpsLimiter, ClockWidget, MediaPlayerCard };
