import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { Resvg } from "@resvg/resvg-js";

const rootDir = process.cwd();
const sourceDir = resolve(rootDir, "apps/desktop/assets/icons/source");
const generatedDir = resolve(rootDir, "apps/desktop/assets/icons/generated");
const ACTIVE_TRAY_FRAME_COUNT = 12;

function ensureCommand(command) {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
  } catch {
    throw new Error(`缺少系统命令：${command}`);
  }
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function renderSvgToPng(svgPath, size, outputPath) {
  const svg = readFileSync(svgPath, "utf8");
  renderSvgStringToPng(svg, size, outputPath);
}

function renderSvgStringToPng(svg, size, outputPath) {
  const renderer = new Resvg(svg, {
    fitTo: {
      mode: "width",
      value: size,
    },
    background: "rgba(0,0,0,0)",
  });
  const png = renderer.render().asPng();
  writeFileSync(outputPath, png);
}

function resizePng(inputPath, size, outputPath) {
  execFileSync("sips", ["-z", String(size), String(size), inputPath, "--out", outputPath], {
    stdio: "ignore",
  });
}

function buildIcnsFromMaster(masterPngPath) {
  const tempDir = mkdtempSync(join(tmpdir(), "local-ai-gateway-iconset-"));
  const iconsetDir = join(tempDir, "app-icon.iconset");
  ensureDir(iconsetDir);
  const sizes = [
    ["icon_16x16.png", 16],
    ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32],
    ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128],
    ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256],
    ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512],
    ["icon_512x512@2x.png", 1024],
  ];
  try {
    for (const [fileName, size] of sizes) {
      resizePng(masterPngPath, size, join(iconsetDir, fileName));
    }
    execFileSync(
      "iconutil",
      ["-c", "icns", iconsetDir, "-o", join(generatedDir, "app-icon.icns")],
      {
        stdio: "ignore",
      },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function buildTrayIcons() {
  const staticVariants = [
    ["tray-idle-light.svg", "tray-idle-light"],
    ["tray-idle-dark.svg", "tray-idle-dark"],
    ["tray-error-light.svg", "tray-error-light"],
    ["tray-error-dark.svg", "tray-error-dark"],
  ];
  for (const [inputName, outputBase] of staticVariants) {
    const svgPath = join(sourceDir, inputName);
    const hiResPath = join(generatedDir, `${outputBase}@2x.png`);
    renderSvgToPng(svgPath, 36, hiResPath);
    resizePng(hiResPath, 18, join(generatedDir, `${outputBase}.png`));
  }

  const activeVariants = [
    ["tray-active-light.svg", "tray-active-light"],
    ["tray-active-dark.svg", "tray-active-dark"],
  ];
  for (const [inputName, outputBase] of activeVariants) {
    const svgTemplate = readFileSync(join(sourceDir, inputName), "utf8");
    for (let frameIndex = 0; frameIndex < ACTIVE_TRAY_FRAME_COUNT; frameIndex += 1) {
      const angle = (360 / ACTIVE_TRAY_FRAME_COUNT) * frameIndex;
      const sparkOpacity = frameIndex % 3 === 0 ? "1" : frameIndex % 3 === 1 ? "0.92" : "0.8";
      const svg = svgTemplate
        .replaceAll("__ANGLE__", angle.toFixed(2))
        .replaceAll("__SPARK_OPACITY__", sparkOpacity);
      const hiResPath = join(generatedDir, `${outputBase}-${frameIndex}@2x.png`);
      renderSvgStringToPng(svg, 36, hiResPath);
      resizePng(hiResPath, 18, join(generatedDir, `${outputBase}-${frameIndex}.png`));
    }
  }
}

function main() {
  ensureCommand("sips");
  ensureCommand("iconutil");
  ensureDir(generatedDir);
  rmSync(join(generatedDir, "app-icon.iconset"), { recursive: true, force: true });

  const appIconSvgPath = join(sourceDir, "app-icon.svg");
  if (!existsSync(appIconSvgPath)) {
    throw new Error(`缺少主图标 SVG：${appIconSvgPath}`);
  }

  const appIconPngPath = join(generatedDir, "app-icon.png");
  renderSvgToPng(appIconSvgPath, 1024, appIconPngPath);
  buildIcnsFromMaster(appIconPngPath);
  buildTrayIcons();

  console.log(`[generate:icons] 已生成图标资源：${generatedDir}`);
}

main();
