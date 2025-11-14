import fg from 'fast-glob';
import fs from 'fs';
import crypto from 'crypto';
import path from 'path';

interface FileEntry {
  path: string;
  size: number;
  loc: number;
  hash: string;
}

interface SkippedFileEntry {
  path: string;
  skipped: true;
  reason: string;
}

interface ExportSummary {
  appName: string;
  generatedAt: string;
  sup001_plannerEnabled: boolean;
  sup002_executorEnabled: boolean;
  sup003_monitorEnabled: boolean;
  sup060_safeExperimentsEnabled: boolean;
  totals: {
    files: number;
    sizeBytes: number;
    loc: number;
    todo: number;
    fixme: number;
  };
  quality: {
    clevernessIndex: number;
    hasTypes: boolean;
    hasDocs: boolean;
    hasApi: boolean;
    testsCount: number;
  };
  files: Array<FileEntry | SkippedFileEntry>;
}

const INCLUDE_PATTERNS = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  '.replit',
  'replit.nix',
  'tsconfig*.json',
  'vite.config.*',
  'next.config.*',
  'astro.config.*',
  'webpack.config.*',
  'src/**',
  'server/**',
  'app/**',
  'api/**',
  'routes/**',
  'lib/**',
  'functions/**',
  'prisma/**',
  'db/**',
  'supabase/**',
  'scripts/**',
  'schema.*',
  'drizzle.config.*',
  'prisma/schema.prisma',
  'database.sql',
  'migrations/**',
  'README.md',
  'docs/**/*.md',
  'public/robots.txt',
  'shared/**',
];

const EXCLUDE_PATTERNS = [
  'node_modules/**',
  '.git/**',
  '.next/**',
  '.vercel/**',
  '.turbo/**',
  'dist/**',
  'build/**',
  'coverage/**',
  '.cache/**',
  'tmp/**',
  '.env*',
  '**/*.key',
  '**/*.pem',
  '**/*.p12',
  '**/*.pfx',
  '**/credentials*',
  '**/secrets*',
  '**/*secret*',
  '**/*password*',
  '**/*token*',
  '**/*.png',
  '**/*.jpg',
  '**/*.jpeg',
  '**/*.gif',
  '**/*.svg',
  '**/*.webp',
  '**/*.ico',
  '**/*.woff*',
  '**/*.ttf',
  '**/*.pdf',
  '**/*.mp4',
  '**/*.zip',
];

let cachedSummary: ExportSummary | null = null;
let whitelistedPaths: Set<string> | null = null;

function computeHash(content: Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function countLines(content: string): number {
  return content.split('\n').length;
}

function countPattern(content: string, pattern: RegExp): number {
  const matches = content.match(pattern);
  return matches ? matches.length : 0;
}

function isTextFile(filepath: string): boolean {
  const textExtensions = [
    '.js', '.ts', '.jsx', '.tsx', '.json', '.md', '.txt', '.css', '.scss',
    '.html', '.yml', '.yaml', '.xml', '.sql', '.prisma', '.lock', '.config',
    '.env', '.gitignore', '.eslintrc', '.prettierrc', '.mjs', '.cjs',
  ];
  
  const ext = path.extname(filepath).toLowerCase();
  if (textExtensions.includes(ext)) return true;
  
  const basenames = ['package.json', '.replit', 'replit.nix', 'Dockerfile', 'README'];
  const basename = path.basename(filepath);
  return basenames.some(b => basename.startsWith(b));
}

async function scanFiles(): Promise<ExportSummary> {
  const files = await fg(INCLUDE_PATTERNS, {
    ignore: EXCLUDE_PATTERNS,
    dot: false,
    absolute: false,
  });

  const fileEntries: Array<FileEntry | SkippedFileEntry> = [];
  let totalSizeBytes = 0;
  let totalLoc = 0;
  let totalTodo = 0;
  let totalFixme = 0;
  let hasTypes = false;
  let hasDocs = false;
  let hasApi = false;
  let testsCount = 0;

  for (const filepath of files) {
    try {
      if (!isTextFile(filepath)) {
        fileEntries.push({
          path: filepath,
          skipped: true,
          reason: 'Binary or non-text file',
        });
        continue;
      }

      const buffer = fs.readFileSync(filepath);
      const content = buffer.toString('utf-8');
      const size = buffer.length;
      const loc = countLines(content);
      const hash = computeHash(buffer);

      fileEntries.push({
        path: filepath,
        size,
        loc,
        hash,
      });

      totalSizeBytes += size;
      totalLoc += loc;
      totalTodo += countPattern(content, /todo/gi);
      totalFixme += countPattern(content, /fixme/gi);

      if (/\.(ts|tsx)$/i.test(filepath)) hasTypes = true;
      if (/README\.md|docs\//i.test(filepath)) hasDocs = true;
      if (/^(api|server|routes)\//i.test(filepath)) hasApi = true;
      if (/\.test\.|__tests__/i.test(filepath)) testsCount++;

    } catch (err) {
      fileEntries.push({
        path: filepath,
        skipped: true,
        reason: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  const clevernessIndex = Math.round(
    Math.log10(totalLoc + 10) * 10
    + testsCount * 5
    + (hasTypes ? 8 : 0)
    + (hasDocs ? 4 : 0)
    + (hasApi ? 6 : 0)
    - Math.min(totalTodo + totalFixme, 50)
  );

  const appName = 'Wyshbone Supervisor Suite';

  return {
    appName,
    generatedAt: new Date().toISOString(),
    sup001_plannerEnabled: true,
    sup002_executorEnabled: true,
    sup003_monitorEnabled: true,
    sup060_safeExperimentsEnabled: false,
    totals: {
      files: fileEntries.filter(f => !('skipped' in f)).length,
      sizeBytes: totalSizeBytes,
      loc: totalLoc,
      todo: totalTodo,
      fixme: totalFixme,
    },
    quality: {
      clevernessIndex,
      hasTypes,
      hasDocs,
      hasApi,
      testsCount,
    },
    files: fileEntries,
  };
}

export async function getSummary(): Promise<ExportSummary> {
  if (!cachedSummary) {
    cachedSummary = await scanFiles();
    whitelistedPaths = new Set(
      cachedSummary.files
        .filter(f => !('skipped' in f))
        .map(f => f.path)
    );
  }
  return cachedSummary;
}

export async function getFileContent(requestedPath: string): Promise<{ path: string; content: string }> {
  if (!whitelistedPaths) {
    await getSummary();
  }

  const normalizedPath = path.normalize(requestedPath).replace(/^\/+/, '');

  if (!whitelistedPaths!.has(normalizedPath)) {
    throw new Error('FILE_NOT_WHITELISTED');
  }

  if (!fs.existsSync(normalizedPath)) {
    throw new Error('FILE_NOT_FOUND');
  }

  const content = fs.readFileSync(normalizedPath, 'utf-8');

  return {
    path: normalizedPath,
    content,
  };
}

export function invalidateCache(): void {
  cachedSummary = null;
  whitelistedPaths = null;
}
