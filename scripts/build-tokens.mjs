// Generates public/tokens.css from design/tokens.json (the Miranda system).
// Every color/type/spacing/radius/shadow custom property the stylesheet uses
// comes from this file, so the design source of truth stays tokens.json.
// Font families are substituted with free Google Fonts equivalents here —
// swapping in a licensed original later is a one-line change in FONT_SUBS.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const tokens = JSON.parse(readFileSync(new URL("design/tokens.json", root), "utf8"));

// Commercial face -> free substitute (named in design/DESIGN.md; Canopee's
// display role moved to Abril Fatface per the v4 refinement — the didone
// fatface that carries masthead, banners, and headlines)
const FONT_SUBS = {
  "Editorial New": `"Source Serif 4", Georgia, serif`,
  "Canopee": `"Abril Fatface", "Playfair Display", Georgia, serif`,
  "Domaine Display": `"Playfair Display", Georgia, serif`,
  "Germgoth": `"Pirata One", "IM Fell English", Georgia, serif`,
};

const kebab = (s) => s.replace(/\s+/g, "-").toLowerCase();
const lines = [
  "/* GENERATED from design/tokens.json by scripts/build-tokens.mjs — do not edit by hand. */",
  ":root {",
];

for (const [name, t] of Object.entries(tokens.color)) {
  lines.push(`  --color-${name}: ${t.$value};`);
}
for (const [name, t] of Object.entries(tokens.font)) {
  const sub = FONT_SUBS[t.$value];
  if (!sub) throw new Error(`no free substitute mapped for font "${t.$value}"`);
  lines.push(`  --font-${kebab(name)}: ${sub}; /* substitutes ${t.$value} */`);
}
for (const [name, t] of Object.entries(tokens.spacing)) {
  lines.push(`  --sp-${name}: ${t.$value};`);
}
for (const [name, t] of Object.entries(tokens.radius)) {
  lines.push(`  --radius-${name}: ${t.$value};`);
}
for (const [name, t] of Object.entries(tokens.shadow)) {
  lines.push(`  --shadow-${name}: ${t.$value};`);
}
for (const [name, t] of Object.entries(tokens.surface)) {
  lines.push(`  --surface-${kebab(name)}: ${t.$value};`);
}
// Typography steps -> per-step font/size/weight/line-height custom properties.
for (const [name, t] of Object.entries(tokens.typography)) {
  const v = t.$value;
  const fam = FONT_SUBS[v.fontFamily];
  if (!fam) throw new Error(`typography step ${name}: unmapped family ${v.fontFamily}`);
  lines.push(`  --type-${name}: ${v.fontWeight} ${v.fontSize}/${v.lineHeight} ${fam};`);
}
lines.push("}", "");

writeFileSync(new URL("public/tokens.css", root), lines.join("\n"));
console.log(`tokens.css written: ${lines.length - 3} custom properties from ${fileURLToPath(new URL("design/tokens.json", root))}`);
