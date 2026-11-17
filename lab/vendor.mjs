// Re-bundle the blog's storage layer into vendor/. Reads the blog repo, writes only here.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from './util.mjs';
const blog = join(ROOT, '../blog');
execFileSync(join(blog, 'node_modules/.bin/esbuild'), [join(blog, 'src/lib/storage/postgres.ts'), '--bundle', '--platform=node', '--format=esm', '--external:pg', '--outfile=vendor/blog-storage.mjs'], { cwd: ROOT, stdio: 'inherit' });
