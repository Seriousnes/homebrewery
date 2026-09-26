// Theme asset pipeline. TypeScript port of legacy/vitePlugins/generateAssetsPlugin.js
// (V3 themes only), plus the scoped stylesheet the editor canvas uses (plan §5, §8.7, §10).
//
// URL layout (same as legacy, so theme CSS and snippet output keep working unchanged):
//   /themes/themes.json                     theme catalog (ThemeCatalog on the server loads it)
//   /themes/V3/<key>/style.css              compiled theme LESS (used for export)
//   /themes/V3/<key>/style.scoped.css       the same CSS scoped under .hb-canvas (editor canvas)
//   /themes/V3/<key>/dropdownPreview.png    theme picker images
//   /themes/V3/<key>/dropdownTexture.png
//   /assets/**                              themes/assets (images the theme CSS and snippets use)
//   /fonts/**                               themes/fonts  (theme CSS refers to ../../../fonts/…)
//
// Theme CSS uses absolute /assets/… URLs and relative ../../../fonts/… URLs, and snippet
// generators emit `${origin}/assets/…` into documents, so these paths are kept as they are.
//
// `vite build` writes everything into build.outDir (src/Homebrewery.Api/wwwroot).
// `vite` (dev) compiles into memory and serves the same URLs from middleware, recompiling
// when anything under themes/ changes.
//
// Legacy-renderer themes (themes/Legacy/*) are skipped: legacy brews are not supported (plan §1).
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import less from 'less';
import postcss, { type AtRule } from 'postcss';
import type { Connect, Logger, Plugin, ResolvedConfig } from 'vite';
import { scopeCss } from './scopeThemes.ts';

/** themes/V3/<key>/settings.json as stored in the repository. */
export interface ThemeSettings {
  name: string;
  renderer: string;
  baseTheme: string | false;
  baseSnippets: string | false;
}

/** One entry of /themes/themes.json. `false` from settings.json is normalised to null. */
export interface ThemeCatalogEntry {
  /** Theme id, e.g. "5ePHB". Same as the folder name. */
  key: string;
  name: string;
  renderer: 'V3';
  /** Key of the theme whose CSS loads before this one, or null for a root theme. */
  baseTheme: string | null;
  /** Key of the theme whose snippets are merged under this theme's snippets, or null. */
  baseSnippets: string | null;
  /** Folder name under themes/V3 (legacy field). */
  path: string;
  /** URL of the compiled, unscoped stylesheet. */
  style: string;
  /** URL of the stylesheet scoped under .hb-canvas. */
  scopedStyle: string;
  /** URL of the theme picker preview image, or null. */
  preview: string | null;
  /** URL of the theme picker texture image, or null. */
  texture: string | null;
  /** Whether themes/V3/<key>/snippets.js exists (snippet group id "V3_<key>"). */
  hasSnippets: boolean;
}

export interface ThemeCatalog {
  themes: ThemeCatalogEntry[];
}

export type ThemeOutput = { kind: 'content'; data: string } | { kind: 'file'; source: string };

export interface ThemeOutputs {
  /** Output path relative to the web root (no leading slash, forward slashes) → content. */
  files: Map<string, ThemeOutput>;
  catalog: ThemeCatalog;
  /** Legacy-renderer themes that were not built. */
  skippedLegacy: string[];
  /** url() references in compiled theme CSS that don't resolve to an emitted file. */
  unresolvedUrls: string[];
}

export interface GenerateThemeOutputsOptions {
  /** The repository's themes/ directory. */
  themesDir: string;
  /** Base path for theme LESS @import statements. Theme files import './themes/…', so this is
   * the repository root. Defaults to the parent of themesDir. */
  lessRoot?: string;
  /** Minify the compiled CSS (build only). */
  compress?: boolean;
}

const THEME_IMAGES = ['dropdownPreview.png', 'dropdownTexture.png'] as const;

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** Adds every file under `srcDir` to `files` as `<urlPrefix>/<relative path>`. */
async function addTree(
  files: Map<string, ThemeOutput>,
  srcDir: string,
  urlPrefix: string,
  skipExtensions: readonly string[],
): Promise<void> {
  const entries = await fs.readdir(srcDir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (skipExtensions.includes(path.extname(entry.name).toLowerCase())) continue;
    const source = path.join(entry.parentPath, entry.name);
    const rel = path.relative(srcDir, source).split(path.sep).join('/');
    files.set(`${urlPrefix}/${rel}`, { kind: 'file', source });
  }
}

const CSS_URL = /url\(\s*(['"]?)([^'")]+?)\1\s*\)/g;

/**
 * url() references in `css` (served at `cssPath`) that don't resolve to a key in `files`.
 * An @font-face `src` list counts as resolved when any of its sources does: browsers load the
 * first supported format, and upstream lists .ttf fallbacks that were never committed.
 */
function findUnresolvedUrls(css: string, cssPath: string, files: Map<string, ThemeOutput>): string[] {
  const missing = new Set<string>();
  postcss.parse(css).walkDecls((decl) => {
    const refs = [...decl.value.matchAll(CSS_URL)]
      .map((match) => match[2]?.trim() ?? '')
      .filter((ref) => ref !== '' && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)); // data:, https:, //cdn, #id
    const unresolved = refs.filter((ref) => {
      const resolved = decodeURIComponent(new URL(ref, `http://theme.invalid/${cssPath}`).pathname).slice(1);
      return !files.has(resolved);
    });
    const parent = decl.parent;
    const isFontSrc = decl.prop === 'src' && parent?.type === 'atrule' && (parent as AtRule).name === 'font-face';
    if (isFontSrc && unresolved.length < refs.length) return;
    for (const ref of unresolved) missing.add(ref);
  });
  return [...missing];
}

async function compileLess(file: string, lessRoot: string, compress: boolean): Promise<string> {
  const source = await fs.readFile(file, 'utf8');
  // `filename` lets LESS report the right file in errors; `paths` resolves the
  // repository-root-relative imports ('./themes/assets/assets.less'). url()s are not rewritten,
  // matching legacy output.
  const output = await less.render(source, { filename: file, paths: [lessRoot], compress });
  return output.css;
}

/** Compiles every V3 theme and lists every file the theme pipeline emits. */
export async function generateThemeOutputs(options: GenerateThemeOutputsOptions): Promise<ThemeOutputs> {
  const themesDir = path.resolve(options.themesDir);
  const lessRoot = path.resolve(options.lessRoot ?? path.dirname(themesDir));
  const compress = options.compress ?? false;

  const files = new Map<string, ThemeOutput>();
  await addTree(files, path.join(themesDir, 'assets'), 'assets', ['.less']);
  await addTree(files, path.join(themesDir, 'fonts'), 'fonts', ['.less', '.js']);

  const v3Dir = path.join(themesDir, 'V3');
  const keys = (await fs.readdir(v3Dir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const catalog: ThemeCatalog = { themes: [] };
  const stylesheets: { cssPath: string; css: string }[] = [];

  for (const key of keys) {
    const dir = path.join(v3Dir, key);
    const settingsFile = path.join(dir, 'settings.json');
    const lessFile = path.join(dir, 'style.less');
    if (!(await exists(settingsFile)) || !(await exists(lessFile))) continue;

    const settings = JSON.parse(await fs.readFile(settingsFile, 'utf8')) as ThemeSettings;
    if (settings.renderer !== 'V3') continue;

    const base = `themes/V3/${key}`;
    const css = await compileLess(lessFile, lessRoot, compress);
    files.set(`${base}/style.css`, { kind: 'content', data: css });
    files.set(`${base}/style.scoped.css`, { kind: 'content', data: scopeCss(css, { from: lessFile }) });
    stylesheets.push({ cssPath: `${base}/style.css`, css });

    const images: Partial<Record<(typeof THEME_IMAGES)[number], string>> = {};
    for (const image of THEME_IMAGES) {
      const source = path.join(dir, image);
      if (await exists(source)) {
        files.set(`${base}/${image}`, { kind: 'file', source });
        images[image] = `/${base}/${image}`;
      }
    }

    catalog.themes.push({
      key,
      name: settings.name,
      renderer: 'V3',
      baseTheme: settings.baseTheme || null,
      baseSnippets: settings.baseSnippets || null,
      path: key,
      style: `/${base}/style.css`,
      scopedStyle: `/${base}/style.scoped.css`,
      preview: images['dropdownPreview.png'] ?? null,
      texture: images['dropdownTexture.png'] ?? null,
      hasSnippets: await exists(path.join(dir, 'snippets.js')),
    });
  }

  files.set('themes/themes.json', { kind: 'content', data: `${JSON.stringify(catalog, null, 2)}\n` });

  const legacyDir = path.join(themesDir, 'Legacy');
  const skippedLegacy = (await exists(legacyDir))
    ? (await fs.readdir(legacyDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
    : [];

  const unresolvedUrls = stylesheets.flatMap(({ cssPath, css }) =>
    findUnresolvedUrls(css, cssPath, files).map((ref) => `/${cssPath}: ${ref}`),
  );

  return { files, catalog, skippedLegacy, unresolvedUrls };
}

/** Writes `outputs` under `outDir`, creating directories as needed. */
export async function writeThemeOutputs(outputs: ThemeOutputs, outDir: string): Promise<void> {
  const queue = [...outputs.files];
  const worker = async (): Promise<void> => {
    for (let item = queue.pop(); item; item = queue.pop()) {
      const [rel, output] = item;
      const dest = path.join(outDir, ...rel.split('/'));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      if (output.kind === 'content') await fs.writeFile(dest, output.data);
      else await fs.copyFile(output.source, dest);
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
}

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** URL prefixes the theme pipeline owns. */
export const THEME_URL_PREFIXES = ['/themes/', '/assets/', '/fonts/'] as const;

async function serveThemeFile(
  outputs: Promise<ThemeOutputs>,
  req: Connect.IncomingMessage,
  res: ServerResponse,
  next: Connect.NextFunction,
): Promise<void> {
  if ((req.method !== 'GET' && req.method !== 'HEAD') || !req.url) return next();

  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return next();
  }
  if (!THEME_URL_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return next();

  let resolved: ThemeOutputs;
  try {
    resolved = await outputs;
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(`Theme build failed:\n${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  // Only files the pipeline emits are served, so there is no path traversal to guard against.
  const output = resolved.files.get(pathname.slice(1));
  if (!output) return next();

  res.setHeader('Content-Type', CONTENT_TYPES[path.extname(pathname).toLowerCase()] ?? 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-cache');

  if (output.kind === 'content') {
    const body = Buffer.from(output.data, 'utf8');
    res.setHeader('Content-Length', body.length);
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }

  const { size } = await fs.stat(output.source);
  res.setHeader('Content-Length', size);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    createReadStream(output.source).on('error', reject).on('end', resolve).pipe(res);
  });
}

function report(outputs: ThemeOutputs, logger: Logger): void {
  const keys = outputs.catalog.themes.map((theme) => theme.key).join(', ');
  logger.info(`[themes] ${outputs.catalog.themes.length} V3 themes (${keys}), ${outputs.files.size} files`, {
    timestamp: true,
  });
  if (outputs.skippedLegacy.length > 0) {
    logger.info(`[themes] skipped Legacy-renderer themes (not supported): ${outputs.skippedLegacy.join(', ')}`, {
      timestamp: true,
    });
  }
  for (const ref of outputs.unresolvedUrls) {
    logger.warn(`[themes] url() does not resolve to an emitted file: ${ref}`, { timestamp: true });
  }
}

export interface GenerateAssetsPluginOptions {
  /** The repository's themes/ directory. */
  themesDir: string;
  /** Base path for theme LESS imports. Defaults to the parent of themesDir (repository root). */
  lessRoot?: string;
}

export function generateAssetsPlugin(options: GenerateAssetsPluginOptions): Plugin {
  const themesDir = path.resolve(options.themesDir);
  const lessRoot = path.resolve(options.lessRoot ?? path.dirname(themesDir));
  let config: ResolvedConfig | undefined;
  let buildOutputs: ThemeOutputs | undefined;

  return {
    name: 'homebrewery:theme-assets',
    // Unit tests don't need compiled themes.
    apply: (_config, env) => env.mode !== 'test' && !process.env.VITEST,

    configResolved(resolved) {
      config = resolved;
    },

    async buildStart() {
      if (config?.command !== 'build') return;
      buildOutputs = await generateThemeOutputs({ themesDir, lessRoot, compress: true });
    },

    async writeBundle() {
      if (!config || !buildOutputs) return;
      const outDir = path.resolve(config.root, config.build.outDir);
      await writeThemeOutputs(buildOutputs, outDir);
      report(buildOutputs, config.logger);
    },

    configureServer(server) {
      const { logger } = server.config;
      const generate = (): Promise<ThemeOutputs> => generateThemeOutputs({ themesDir, lessRoot, compress: false });
      const logError = (error: unknown): void => {
        logger.error(`[themes] ${error instanceof Error ? error.message : String(error)}`, { timestamp: true });
      };

      let current = generate();
      void current.then((outputs) => report(outputs, logger), logError);

      // Recompile when theme LESS, settings, fonts or assets change. Theme JS (snippets) is
      // part of the module graph, so Vite hot-reloads it by itself.
      server.watcher.add(themesDir);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onChange = (file: string): void => {
        const rel = path.relative(themesDir, file);
        if (rel.startsWith('..') || path.isAbsolute(rel) || /\.[cm]?[jt]s$/.test(file)) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          const pending = generate();
          void pending.then((outputs) => {
            current = pending;
            report(outputs, logger);
            server.ws.send({ type: 'full-reload' });
          }, logError);
        }, 150);
      };
      server.watcher.on('change', onChange);
      server.watcher.on('add', onChange);
      server.watcher.on('unlink', onChange);

      // Registered directly (not in a returned post hook) so it runs before Vite's own
      // middlewares and the SPA fallback.
      server.middlewares.use((req, res, next) => {
        serveThemeFile(current, req, res, next).catch(next);
      });
    },
  };
}
