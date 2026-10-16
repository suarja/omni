import { isBuiltin } from 'node:module';

export function assertCleanSnapshot(status) {
  if (status.split('\n').some((line) => line && !line.startsWith('?? '))) {
    throw new Error('Release packaging requires a clean tracked snapshot. Commit the approved slice first.');
  }
}

export function assertSafeDestination(path, exists) {
  if (exists) throw new Error(`Release destination already exists: ${path}. Choose a new directory.`);
}

export function inspectRuntimeImports(source) {
  const imports = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((match) => match[1]);
  return [...new Set(imports.filter((name) => name !== 'electron' && !name.startsWith('.') && !isBuiltin(name)))];
}
