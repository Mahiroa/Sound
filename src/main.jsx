// 模块: main.jsx
// 应用入口：挂载 React 根节点
// 平移: 原 assets/main.js → ES module
import * as le from "react";
import * as Dt from "react/jsx-runtime";
import { createRoot as ZO } from "react-dom/client";
import { RootApp } from "./ui/player.jsx";
import "./index.css";

ZO(document.getElementById("root")).render(
  Dt.jsx(le.StrictMode, { children: Dt.jsx(RootApp, {}) }),
);
