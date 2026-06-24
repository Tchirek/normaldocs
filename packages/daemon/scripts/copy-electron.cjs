const { copyFile, mkdir, rm } = require('node:fs/promises');
const path = require('node:path');

async function main() {
  const root = path.resolve(__dirname, '..');
  const source = path.join(root, 'electron');
  const target = path.join(root, 'dist', 'electron');
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await copyFile(path.join(source, 'main.cjs'), path.join(target, 'main.cjs'));
  await copyFile(path.join(source, 'preload.cjs'), path.join(target, 'preload.cjs'));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
