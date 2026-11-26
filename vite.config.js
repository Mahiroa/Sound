import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

// WE 壁纸要求: 产物为普通 script（非 module）时用 plugin-legacy;
// 当前目标: es2017 + module script（WE 的 CEF 支持, 已本地验证）
export default defineConfig({
  plugins: [tailwindcss()],
  base: "./",
  build: {
    target: "es2017",
    outDir: "dist",
    emptyOutDir: false,
    // 单 chunk 1.25MB 为 WE 本地加载场景的正常形态（three+react+framer-motion），
    // 提高告警阈值避免噪音（拆分对 file:// 加载无缓存收益）
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      // 源码模板改名 index.template.html: 避免 WE 编辑器误把 web/ 下的
      // index.html 当壁纸入口加载 (引用 /src/main.jsx 会 404 卡死)
      input: "index.template.html",
      output: {
        // 产物名稳定（无 hash）: assets/index.js + assets/index.css
        // 避免 git 历史被 hash churn 污染; deploy:we 覆盖同名即可
        // 注意: 自定义 output 命名会覆盖 assetsDir, 需自带 assets/ 前缀
        entryFileNames: "assets/index.js",
        assetFileNames: "assets/index.[ext]",
      },
    },
  },
});
