// Package the client into standalone executables for macOS / Linux / Windows.
// Usage: npm run build  (or: node build.mjs)
// Needs network on first run — @yao-pkg/pkg downloads a Node base per target.
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const targets = [
  'node18-macos-arm64',
  'node18-macos-x64',
  'node18-linux-x64',
  'node18-win-x64',
].join(',');

mkdirSync('dist', { recursive: true });
console.log('Building for:', targets);
execSync(`npx --yes @yao-pkg/pkg . --targets ${targets} --out-path dist`, { stdio: 'inherit' });
console.log('\n✓ Binaries in ./dist');
