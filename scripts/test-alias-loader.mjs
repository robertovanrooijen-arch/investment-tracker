// Minimal Node.js ESM loader hook that resolves this project's "@/*"
// TypeScript path alias (tsconfig.json) to real file URLs, so `node --test`
// can run test files that import source modules using that alias — without
// pulling in a bundler-based test runner just to resolve one path mapping.
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
import { existsSync } from 'node:fs'

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..')
const CANDIDATE_SUFFIXES = ['', '.ts', '.tsx', '.js', '/index.ts', '/index.tsx']

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/')) {
    const base = resolvePath(ROOT, specifier.slice(2))
    for (const suffix of CANDIDATE_SUFFIXES) {
      const candidate = base + suffix
      if (existsSync(candidate)) {
        return nextResolve(pathToFileURL(candidate).href, context)
      }
    }
  }
  return nextResolve(specifier, context)
}
