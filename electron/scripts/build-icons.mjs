import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import sharp from "sharp";
import png2icons from "png2icons";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../..");
const buildDir = resolve(__dirname, "../build");

// Read the canonical SVG and resolve currentColor → amber-500
const svgPath = resolve(root, "client/src/assets/roubo-logo.svg");
let svgSource;
try {
  svgSource = readFileSync(svgPath, "utf8");
} catch {
  throw new Error(`Source SVG not found at ${svgPath}. Run this script from the repo root.`);
}
const svgColored = svgSource.replace(/currentColor/g, "#f59e0b");

// Generate a 1024×1024 PNG from the SVG (transparent background)
const png1024 = await sharp(Buffer.from(svgColored)).resize(1024, 1024).png().toBuffer();

// macOS .icns (all sizes packed from the 1024px master)
const icns = png2icons.createICNS(png1024, png2icons.BICUBIC, 0);
if (!icns) throw new Error("Failed to generate .icns");
writeFileSync(resolve(buildDir, "icon.icns"), icns);
console.log("✓ icon.icns");

// Windows .ico
const ico = png2icons.createICO(png1024, png2icons.BICUBIC, 0, false);
if (!ico) throw new Error("Failed to generate .ico");
writeFileSync(resolve(buildDir, "icon.ico"), ico);
console.log("✓ icon.ico");

// Linux / fallback 512px PNG
const png512 = await sharp(Buffer.from(svgColored)).resize(512, 512).png().toBuffer();
writeFileSync(resolve(buildDir, "icon.png"), png512);
console.log("✓ icon.png");
