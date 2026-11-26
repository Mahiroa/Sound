// deploy:we — 将构建产物部署到 Wallpaper Engine 项目目录
// 用法:
//   npm run deploy:we
//   npm run deploy:we -- "D:/SteamLibrary/steamapps/common/wallpaper_engine/projects/myprojects/SonicTopography"
//   或设置环境变量 WE_PROJECT_DIR
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(__dirname, "..");
const distDir = join(projectDir, "dist");
const templateDir = join(projectDir, "wallpaper");

const DEFAULT_WE_ROOT =
  "C:/Program Files (x86)/Steam/steamapps/common/wallpaper_engine/projects/myprojects/Sound";

const customTarget = process.argv[2] || process.env.WE_PROJECT_DIR;
const targetDir = resolve(customTarget || DEFAULT_WE_ROOT);

if (!existsSync(join(distDir, "index.template.html"))) {
  console.error("[deploy:we] 未找到 dist/index.template.html，请先运行 npm run build");
  process.exit(1);
}

if (!existsSync(targetDir)) {
  if (customTarget) {
    mkdirSync(targetDir, { recursive: true });
    console.log(`[deploy:we] 已创建目标目录: ${targetDir}`);
  } else {
    console.error(`[deploy:we] 默认 WE 项目目录不存在: ${targetDir}`);
    console.error('[deploy:we] 请传入目标路径，例如: npm run deploy:we -- "D:/path/to/myprojects/SonicTopography"');
    process.exit(1);
  }
}

// 1. 覆盖 assets/（稳定文件名: assets/index.js + assets/index.css）
cpSync(join(distDir, "assets"), join(targetDir, "assets"), {
  recursive: true,
  force: true,
});

// 2. 覆盖 index.html（dist/index.template.html -> <target>/index.html）
cpSync(join(distDir, "index.template.html"), join(targetDir, "index.html"), {
  force: true,
});

// 3. 首次部署时复制模板元数据与预览图（绝不覆盖目标目录中已有的文件）
for (const file of ["project.json", "preview.jpg"]) {
  const srcFile = join(templateDir, file);
  const dstFile = join(targetDir, file);
  if (existsSync(srcFile) && !existsSync(dstFile)) {
    cpSync(srcFile, dstFile);
    console.log(`[deploy:we] 已初始化 ${file}`);
  }
}

console.log(`[deploy:we] 部署完成 -> ${targetDir}`);
console.log("  - index.html");
console.log("  - assets/index.{js,css}");
