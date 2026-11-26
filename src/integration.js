// 模块: integration.js
// Wallpaper Engine 属性/通用属性监听 + 缓存
// 平移: 原 assets/integration.js → ES module
// 注: player.js 通过 setter/消费函数读写状态（避免 Rollup 对 import 绑定的赋值限制）
"use strict";

let pendingUserProps = null;
let pendingGeneralProps = null;
let userPropsHandler = null;
let generalPropsHandler = null;

export function setUserPropsHandler(fn) {
  userPropsHandler = fn;
}

export function setGeneralPropsHandler(fn) {
  generalPropsHandler = fn;
}

// 取出待应用属性并清空（一次性消费）
export function takePendingUserProps() {
  const p = pendingUserProps;
  pendingUserProps = null;
  return p;
}

export function takePendingGeneralProps() {
  const p = pendingGeneralProps;
  pendingGeneralProps = null;
  return p;
}

// Wallpaper Engine 在壁纸加载时调用此监听器
// 若 player.js 尚未挂载（未设置 userPropsHandler），缓存属性待挂载后一次性应用
window.wallpaperPropertyListener = {
  applyUserProperties: (props) => {
    if (userPropsHandler) {
      userPropsHandler(props);
    } else {
      pendingUserProps = { ...(pendingUserProps || {}), ...props };
    }
  },
  applyGeneralProperties: (props) => {
    if (generalPropsHandler) {
      generalPropsHandler(props);
    } else {
      pendingGeneralProps = { ...(pendingGeneralProps || {}), ...props };
    }
  },
};
