import chalk from 'chalk';
import { build, PluginBuild } from 'esbuild';
import fs from 'fs';
import glob from 'globby';
import mm from 'micromatch';
import path from 'path';
import { basename, dirname, join, normalizeSafe, resolve } from 'upath';
import { createDebugger } from './debug';
import { isDirectory } from './is';
import { createLogger, LogLevel } from './messages/logs';

export const getFileInfo = (
  target: string = '',
  {
    backupFilename = 'filename',
    extension = '.ts',
  }: { backupFilename?: string; extension?: string } = {},
) => {
  const isDir = isDirectory(target);
  const path = isDir ? join(target, backupFilename + extension) : target;
  const pathWithoutExtension = path.replace(/\.[^/.]+$/, '');
  const dir = dirname(path);
  const filename = basename(
    path,
    extension[0] !== '.' ? `.${extension}` : extension,
  );

  return {
    path,
    pathWithoutExtension,
    extension,
    isDirectory: isDir,
    dirname: dir,
    filename,
  };
};

const debug = createDebugger('orval:file-load');

const cache = new Map<string, { file?: any; error?: any }>();

export async function loadFile<File = unknown>(
  filePath?: string,
  options?: {
    root?: string;
    defaultFileName?: string;
    logLevel?: LogLevel;
    isDefault?: boolean;
    alias?: Record<string, string>;
  },
): Promise<{
  path: string;
  file?: File;
  error?: any;
  cached?: boolean;
}> {
  const {
    root = process.cwd(),
    isDefault = true,
    defaultFileName,
    logLevel,
    alias,
  } = options || {};
  const start = Date.now();

  let resolvedPath: string | undefined;
  let isTS = false;
  let isMjs = false;

  if (filePath) {
    // explicit path is always resolved from cwd
    resolvedPath = path.resolve(filePath);
    isTS = filePath.endsWith('.ts');
  } else if (defaultFileName) {
    // implicit file loaded from inline root (if present)
    // otherwise from cwd
    const jsFile = path.resolve(root, `${defaultFileName}.js`);
    if (fs.existsSync(jsFile)) {
      resolvedPath = jsFile;
    }

    if (!resolvedPath) {
      const mjsFile = path.resolve(root, `${defaultFileName}.mjs`);
      if (fs.existsSync(mjsFile)) {
        resolvedPath = mjsFile;
        isMjs = true;
      }
    }

    if (!resolvedPath) {
      const tsFile = path.resolve(root, `${defaultFileName}.ts`);
      if (fs.existsSync(tsFile)) {
        resolvedPath = tsFile;
        isTS = true;
      }
    }
  }

  if (!resolvedPath) {
    if (filePath) {
      createLogger(logLevel).error(chalk.red(`File not found => ${filePath}`));
    } else if (defaultFileName) {
      createLogger(logLevel).error(
        chalk.red(`File not found => ${defaultFileName}.{js,mjs,ts}`),
      );
    } else {
      createLogger(logLevel).error(chalk.red(`File not found`));
    }
    process.exit(1);
  }

  const normalizeResolvedPath = normalizeSafe(resolvedPath);
  const cachedData = cache.get(resolvedPath);

  if (cachedData) {
    return {
      path: normalizeResolvedPath,
      ...cachedData,
      cached: true,
    };
  }

  try {
    let file: File | undefined;

    if (!file && !isTS && !isMjs) {
      // 1. try to directly require the module (assuming commonjs)
      try {
        // clear cache in case of server restart
        delete require.cache[require.resolve(resolvedPath)];

        file = require(resolvedPath);

        debug(`cjs loaded in ${Date.now() - start}ms`);
      } catch (e) {
        const ignored = new RegExp(
          [
            `Cannot use import statement`,
            `Must use import to load ES Module`,
            // #1635, #2050 some Node 12.x versions don't have esm detection
            // so it throws normal syntax errors when encountering esm syntax
            `Unexpected token`,
            `Unexpected identifier`,
          ].join('|'),
        );
        if (!ignored.test(e.message)) {
          throw e;
        }
      }
    }

    if (!file) {
      // 2. if we reach here, the file is ts or using es import syntax, or
      // the user has type: "module" in their package.json (#917)
      // transpile es import syntax to require syntax using rollup.
      // lazy require rollup (it's actually in dependencies)
      const { code } = await bundleFile(
        resolvedPath,
        isMjs,
        root || dirname(normalizeResolvedPath),
        alias,
      );
      file = await loadFromBundledFile<File>(resolvedPath, code, isDefault);

      debug(`bundled file loaded in ${Date.now() - start}ms`);
    }

    cache.set(resolvedPath, { file });

    return {
      path: normalizeResolvedPath,
      file,
    };
  } catch (error: any) {
    cache.set(resolvedPath, { error });

    return {
      path: normalizeResolvedPath,
      error,
    };
  }
}

async function bundleFile(
  fileName: string,
  mjs = false,
  workspace: string,
  alias?: Record<string, string>,
): Promise<{ code: string; dependencies: string[] }> {
  const result = await build({
    absWorkingDir: process.cwd(),
    entryPoints: [fileName],
    outfile: 'out.js',
    write: false,
    platform: 'node',
    bundle: true,
    format: mjs ? 'esm' : 'cjs',
    sourcemap: 'inline',
    metafile: true,
    target: 'es6',
    minifyWhitespace: true,
    plugins: [
      ...(alias
        ? [
            {
              name: 'aliasing',
              setup(build: PluginBuild) {
                build.onResolve(
                  { filter: /^[\w@][^:]/ },
                  async ({ path: id, importer, kind }) => {
                    const matchKeys = Object.keys(alias);
                    const match = matchKeys.find(
                      (key) => id.startsWith(key) || mm.isMatch(id, matchKeys),
                    );

                    if (match) {
                      const find = mm.scan(match);
                      const replacement = mm.scan(alias[match]);
                      const aliased = `${id.replace(
                        find.base,
                        resolve(workspace, replacement.base),
                      )}.ts`;

                      return {
                        path: aliased,
                      };
                    }
                  },
                );
              },
            },
          ]
        : []),
      {
        name: 'externalize-deps',
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            const id = args.path;
            if (id[0] !== '.' && !path.isAbsolute(id)) {
              return {
                external: true,
              };
            }
          });
        },
      },
      {
        name: 'replace-import-meta',
        setup(build) {
          build.onLoad({ filter: /\.[jt]s$/ }, async (args) => {
            const contents = await fs.promises.readFile(args.path, 'utf8');
            return {
              loader: args.path.endsWith('.ts') ? 'ts' : 'js',
              contents: contents
                .replace(
                  /\bimport\.meta\.url\b/g,
                  JSON.stringify(`file://${args.path}`),
                )
                .replace(
                  /\b__dirname\b/g,
                  JSON.stringify(path.dirname(args.path)),
                )
                .replace(/\b__filename\b/g, JSON.stringify(args.path)),
            };
          });
        },
      },
    ],
  });
  const { text } = result.outputFiles[0];
  return {
    code: text,
    dependencies: result.metafile ? Object.keys(result.metafile.inputs) : [],
  };
}

interface NodeModuleWithCompile extends NodeModule {
  _compile(code: string, filename: string): any;
}

async function loadFromBundledFile<File = unknown>(
  fileName: string,
  bundledCode: string,
  isDefault: boolean,
): Promise<File> {
  const extension = path.extname(fileName);
  const defaultLoader = require.extensions[extension]!;
  require.extensions[extension] = (module: NodeModule, filename: string) => {
    if (filename === fileName) {
      (module as NodeModuleWithCompile)._compile(bundledCode, filename);
    } else {
      defaultLoader(module, filename);
    }
  };
  // clear cache in case of server restart
  delete require.cache[require.resolve(fileName)];
  const raw = require(fileName);
  const file = isDefault && raw.__esModule ? raw.default : raw;
  require.extensions[extension] = defaultLoader;
  return file;
}

export async function removeFiles(patterns: string[], dir: string) {
  const files = await glob(patterns, {
    cwd: dir,
    absolute: true,
  });
  await Promise.all(files.map((file) => fs.promises.unlink(file)));
}
