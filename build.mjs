import { mkdirSync, copyFileSync } from "node:fs";
mkdirSync("dist/server", {recursive: true});
copyFileSync("worker/index.js", "dist/server/index.js");
