import fs from 'fs/promises';
import path from 'path';

export const LAYOUT_GENERATED_IGNORE_LINES = [
  '# Generated Layout QA reports can be recreated.',
  'runs/',
  '*runs/',
  'manual-qa-*/',
  'visual-prototypes/',
];

async function exists(filePath: string) {
  return fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

export async function ensureLayoutGitignore(layoutDir: string) {
  await fs.mkdir(layoutDir, {recursive: true});
  const gitignorePath = path.join(layoutDir, '.gitignore');
  const existing = (await exists(gitignorePath))
    ? await fs.readFile(gitignorePath, 'utf8')
    : '';
  const existingLines = new Set(
    existing
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
  );
  const missing = LAYOUT_GENERATED_IGNORE_LINES.filter(
    line => !existingLines.has(line)
  );

  if (existing && missing.length === 0) {
    return gitignorePath;
  }

  const next = [
    existing.trimEnd(),
    ...(existing ? [''] : []),
    ...missing,
    '',
  ]
    .filter((line, index) => line || index > 0)
    .join('\n');

  await fs.writeFile(gitignorePath, next);
  return gitignorePath;
}

export function nearestLayoutDir(filePath: string) {
  const resolved = path.resolve(filePath);
  const parts = resolved.split(path.sep);
  const layoutIndex = parts.lastIndexOf('.layout');
  if (layoutIndex === -1) return '';
  return parts.slice(0, layoutIndex + 1).join(path.sep) || path.sep;
}
