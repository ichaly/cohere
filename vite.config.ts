import { copyFileSync, existsSync } from "node:fs";
import { builtinModules } from "node:module";
import tailwindcss from "@tailwindcss/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const obsidianExternals = [
  "obsidian",
  "electron",
  "@codemirror/autocomplete",
  "@codemirror/collab",
  "@codemirror/commands",
  "@codemirror/language",
  "@codemirror/lint",
  "@codemirror/search",
  "@codemirror/state",
  "@codemirror/view",
  "@lezer/common",
  "@lezer/highlight",
  "@lezer/lr",
];

export default defineConfig({
  plugins: [
    vue(),
    tailwindcss(),
    {
      name: "copy-obsidian-plugin-bundle",
      closeBundle() {
        if (existsSync("dist/main.js")) {
          copyFileSync("dist/main.js", "main.js");
        }
        if (existsSync("dist/main.css")) {
          copyFileSync("dist/main.css", "styles.css");
        }
      },
    },
  ],
  build: {
    lib: {
      entry: "src/main.ts",
      formats: ["cjs"],
    },
    minify: false,
    outDir: "dist",
    rollupOptions: {
      external: [...obsidianExternals, ...builtinModules],
      output: {
        assetFileNames: "main.css",
        entryFileNames: "main.js",
        exports: "default",
      },
    },
    sourcemap: "inline",
    target: "es2018",
  },
});
