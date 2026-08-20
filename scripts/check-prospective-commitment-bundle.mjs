import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { build } from "esbuild";

const sourcePath = "src/research/prospective-shadow-commitment.ts";
const bundlePath = ".github/scripts/prospective-shadow-commitment.mjs";
const banner = `// Generated validator bundle. Source: ${sourcePath}`;
const workspacePath = process.cwd();

const result = await build({
  absWorkingDir: workspacePath,
  entryPoints: [resolve(workspacePath, sourcePath)],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: banner },
  write: false,
});

if (result.outputFiles.length !== 1) {
  throw new Error(`Expected one generated validator bundle, received ${result.outputFiles.length}.`);
}

const [checkedIn, generated] = await Promise.all([
  readFile(bundlePath),
  Promise.resolve(result.outputFiles[0].contents),
]);

if (!checkedIn.equals(generated)) {
  throw new Error(
    `Checked-in ${bundlePath} does not match the TypeScript source. Run npm.cmd run build:prospective-commitment-bundle.`,
  );
}

console.log(`Checked-in ${bundlePath} matches the TypeScript source byte-for-byte.`);
