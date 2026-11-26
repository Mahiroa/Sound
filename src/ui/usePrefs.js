// 模块: usePrefs.js
// 偏好状态 hook — 批量合并 WE 属性更新，避免启动期几十次连续 setState 重渲染
import { useState, useCallback, useEffect } from "react";
import { PREFS_SCHEMA, SIDE_EFFECT_PROPS } from "./prefs-schema.js";

const STORAGE_KEY = "soundwall.prefs";

function loadPersisted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function usePrefs() {
  const [prefs, setPrefs] = useState(() => {
    const persisted = loadPersisted();
    const init = {};
    for (const { key, default: d } of PREFS_SCHEMA) {
      init[key] = persisted[key] !== undefined ? persisted[key] : d;
    }
    if (init.controllerSize == null) {
      init.controllerSize =
        window.innerHeight > window.innerWidth ? "medium" : "large";
    }
    return init;
  });

  const set = useCallback((key, value) => {
    setPrefs((s) => (s[key] === value ? s : { ...s, [key]: value }));
  }, []);

  useEffect(() => {
    const id = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
      } catch {
        /* 隐私模式 / 配额超限静默失败 */
      }
    }, 300);
    return () => clearTimeout(id);
  }, [prefs]);

  // 单次批量合并 WE user props（启动时 40+ 属性合并为 1 次 state 更新）
  const applyUserProps = useCallback((props) => {
    let patch = null;
    for (const { key, we, general } of PREFS_SCHEMA) {
      if (general || we == null) continue;
      const p = props[we];
      if (p === undefined || p === null) continue;
      const v = p.value;
      if (key === "theme") {
        if (v) {
          if (!patch) patch = {};
          patch[key] = v;
        }
      } else if (v !== undefined) {
        if (!patch) patch = {};
        patch[key] = v;
      }
    }
    if (patch) {
      setPrefs((prev) => {
        let changed = false;
        for (const k in patch) {
          if (prev[k] !== patch[k]) {
            changed = true;
            break;
          }
        }
        return changed ? { ...prev, ...patch } : prev;
      });
    }
    for (const { we, apply } of SIDE_EFFECT_PROPS) {
      const p = props[we];
      if (p !== undefined && p !== null && p.value !== undefined) apply(p.value);
    }
  }, []);

  const applyGeneralProps = useCallback((props) => {
    if (props.fps !== undefined) {
      setPrefs((prev) => (prev.fps === props.fps ? prev : { ...prev, fps: props.fps }));
    }
  }, []);

  return { prefs, set, applyUserProps, applyGeneralProps };
}
