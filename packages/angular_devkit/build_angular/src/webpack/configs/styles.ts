/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import * as fs from 'fs';
import * as path from 'path';
import * as webpack from 'webpack';
import { ExtraEntryPoint } from '../../browser/schema';
import { BuildBrowserFeatures } from '../../utils/build-browser-features';
import { WebpackConfigOptions } from '../../utils/build-options';
import {
  AnyComponentStyleBudgetChecker,
  PostcssCliResources,
  RemoveHashPlugin,
  SuppressExtractedTextChunksWebpackPlugin,
} from '../plugins';
import { assetNameTemplateFactory, getOutputHashFormat, normalizeExtraEntryPoints } from '../utils/helpers';

function resolveGlobalStyles(
  styleEntrypoints: ExtraEntryPoint[],
  root: string,
  preserveSymlinks: boolean,
): { entryPoints: Record<string, string[]>; noInjectNames: string[]; paths: string[] } {
  const entryPoints: Record<string, string[]> = {};
  const noInjectNames: string[] = [];
  const paths: string[] = [];

  if (styleEntrypoints.length === 0) {
    return { entryPoints, noInjectNames, paths };
  }

  for (const style of normalizeExtraEntryPoints(styleEntrypoints, 'styles')) {
    let resolvedPath = path.resolve(root, style.input);
    if (!fs.existsSync(resolvedPath)) {
      try {
        resolvedPath = require.resolve(style.input, { paths: [root] });
      } catch {}
    }

    if (!preserveSymlinks) {
      resolvedPath = fs.realpathSync(resolvedPath);
    }

    // Add style entry points.
    if (entryPoints[style.bundleName]) {
      entryPoints[style.bundleName].push(resolvedPath);
    } else {
      entryPoints[style.bundleName] = [resolvedPath];
    }

    // Add non injected styles to the list.
    if (!style.inject) {
      noInjectNames.push(style.bundleName);
    }

    // Add global css paths.
    paths.push(resolvedPath);
  }

  return { entryPoints, noInjectNames, paths };
}

// tslint:disable-next-line: no-big-function
export function getStylesConfig(wco: WebpackConfigOptions): webpack.Configuration {
  const MiniCssExtractPlugin = require('mini-css-extract-plugin');
  const postcssImports = require('postcss-import');
  const postcssPresetEnv: typeof import('postcss-preset-env') = require('postcss-preset-env');

  const { root, buildOptions } = wco;
  const extraPlugins: { apply(compiler: webpack.Compiler): void }[] = [];

  extraPlugins.push(new AnyComponentStyleBudgetChecker(buildOptions.budgets));

  const cssSourceMap = buildOptions.sourceMap.styles;

  // Determine hashing format.
  const hashFormat = getOutputHashFormat(buildOptions.outputHashing as string);

  // use includePaths from appConfig
  const includePaths = buildOptions.stylePreprocessorOptions?.includePaths?.map(p => path.resolve(root, p)) ?? [];

  // Process global styles.
  const { entryPoints, noInjectNames, paths: globalStylePaths } = resolveGlobalStyles(
    buildOptions.styles,
    root,
    !!buildOptions.preserveSymlinks,
  );
  if (noInjectNames.length > 0) {
    // Add plugin to remove hashes from lazy styles.
    extraPlugins.push(new RemoveHashPlugin({ chunkNames: noInjectNames, hashFormat }));
  }

  let sassImplementation: {} | undefined;
  try {
    // tslint:disable-next-line:no-implicit-dependencies
    sassImplementation = require('node-sass');
    wco.logger.warn(
      `'node-sass' usage is deprecated and will be removed in a future major version. ` +
        `To opt-out of the deprecated behaviour and start using 'sass' uninstall 'node-sass'.`,
    );
  } catch {
    sassImplementation = require('sass');
  }

  const assetNameTemplate = assetNameTemplateFactory(hashFormat);

  const extraPostcssPlugins: import('postcss').Plugin[] = [];

  // Attempt to setup Tailwind CSS
  // A configuration file can exist in the project or workspace root
  const tailwindConfigFile = 'tailwind.config.js';
  let tailwindConfigPath;
  for (const basePath of [wco.projectRoot, wco.root]) {
    const fullPath = path.join(basePath, tailwindConfigFile);
    if (fs.existsSync(fullPath)) {
      tailwindConfigPath = fullPath;
      break;
    }
  }
  // Only load Tailwind CSS plugin if configuration file was found.
  // This acts as a guard to ensure the project actually wants to use Tailwind CSS.
  // The package may be unknowningly present due to a third-party transitive package dependency.
  if (tailwindConfigPath) {
    let tailwindPackagePath;
    try {
      tailwindPackagePath = require.resolve('tailwindcss', { paths: [wco.root] });
    } catch {
      const relativeTailwindConfigPath = path.relative(wco.root, tailwindConfigPath);
      wco.logger.warn(
        `Tailwind CSS configuration file found (${relativeTailwindConfigPath})` +
          ` but the 'tailwindcss' package is not installed.` +
          ` To enable Tailwind CSS, please install the 'tailwindcss' package.`,
      );
    }
    if (tailwindPackagePath) {
      extraPostcssPlugins.push(require(tailwindPackagePath)({ config: tailwindConfigPath }));
    }
  }

  const { supportedBrowsers } = new BuildBrowserFeatures(wco.projectRoot);
  const postcssOptionsCreator = (inlineSourcemaps: boolean, extracted: boolean | undefined) => {
    return (loader: webpack.loader.LoaderContext) => ({
      map: inlineSourcemaps
        ? {
            inline: true,
            annotation: false,
          }
        : undefined,
      plugins: [
        postcssImports({
          resolve: (url: string) => url.startsWith('~') ? url.substr(1) : url,
          load: (filename: string) => {
            return new Promise<string>((resolve, reject) => {
              loader.fs.readFile(filename, (err: Error, data: Buffer) => {
                if (err) {
                  reject(err);

                  return;
                }

                const content = data.toString();
                resolve(content);
              });
            });
          },
        }),
        PostcssCliResources({
          baseHref: buildOptions.baseHref,
          deployUrl: buildOptions.deployUrl,
          resourcesOutputPath: buildOptions.resourcesOutputPath,
          loader,
          filename: assetNameTemplate,
          emitFile: buildOptions.platform !== 'server',
          extracted,
        }),
        ...extraPostcssPlugins,
        postcssPresetEnv({
          // tslint:disable-next-line: no-any
          browsers: supportedBrowsers as any, // Typings only allow a string
          autoprefixer: true,
          stage: 3,
        }),
      ],
    });
  };

  // load component css as raw strings
  const componentsSourceMap = !!(
    cssSourceMap
    // Never use component css sourcemap when style optimizations are on.
    // It will just increase bundle size without offering good debug experience.
    && !buildOptions.optimization.styles.minify
    // Inline all sourcemap types except hidden ones, which are the same as no sourcemaps
    // for component css.
    && !buildOptions.sourceMap.hidden
  );

  if (buildOptions.extractCss) {
    // extract global css from js files into own css file.
    extraPlugins.push(
      new MiniCssExtractPlugin({ filename: `[name]${hashFormat.extract}.css` }),
    );

    if (!buildOptions.hmr) {
      // don't remove `.js` files for `.css` when we are using HMR these contain HMR accept codes.
      // suppress empty .js files in css only entry points.
      extraPlugins.push(new SuppressExtractedTextChunksWebpackPlugin());
    }
  }

  // Rule for all supported style types
  const styleRule: webpack.RuleSetRule = {
    test: /\.(?:css|scss|sass|less|styl)$/,
    rules: [
      // Setup processing rules for global and component styles
      {
        oneOf: [
          // Component styles are all styles except defined global styles
          {
            exclude: globalStylePaths,
            use: [
              { loader: require.resolve('raw-loader') },
              {
                loader: require.resolve('postcss-loader'),
                options: {
                  implementation: require('postcss'),
                  postcssOptions: postcssOptionsCreator(componentsSourceMap, false),
                },
              },
            ],
          },
          // Global styles are only defined global styles
          {
            include: globalStylePaths,
            use: [
              buildOptions.extractCss
                ? {
                    loader: MiniCssExtractPlugin.loader,
                  }
                : require.resolve('style-loader'),
              {
                loader: require.resolve('css-loader'),
                options: {
                  url: false,
                  sourceMap: !!cssSourceMap,
                },
              },
              {
                loader: require.resolve('postcss-loader'),
                options: {
                  implementation: require('postcss'),
                  postcssOptions: postcssOptionsCreator(false, buildOptions.extractCss),
                  sourceMap: !!cssSourceMap,
                },
              },
            ],
          },
        ],
      },
      // Setup preprocessor rules for all styles
      {
        oneOf: [
          // No preprocessing required for CSS
          { test: /\.css$/, use: [] },
          {
            test: /\.scss$|\.sass$/,
            use: [
              {
                loader: require.resolve('resolve-url-loader'),
                options: {
                  sourceMap: cssSourceMap,
                },
              },
              {
                loader: require.resolve('sass-loader'),
                options: {
                  implementation: sassImplementation,
                  sourceMap: true,
                  sassOptions: {
                    // bootstrap-sass requires a minimum precision of 8
                    precision: 8,
                    includePaths,
                    // Use expanded as otherwise sass will remove comments that are needed for autoprefixer
                    // Ex: /* autoprefixer grid: autoplace */
                    // tslint:disable-next-line: max-line-length
                    // See: https://github.com/webpack-contrib/sass-loader/blob/45ad0be17264ceada5f0b4fb87e9357abe85c4ff/src/getSassOptions.js#L68-L70
                    outputStyle: 'expanded',
                  },
                },
              },
            ],
          },
          {
            test: /\.less$/,
            use: [
              {
                loader: require.resolve('less-loader'),
                options: {
                  implementation: require('less'),
                  sourceMap: cssSourceMap,
                  lessOptions: {
                    javascriptEnabled: true,
                    paths: includePaths,
                  },
                },
              },
            ],
          },
          {
            test: /\.styl$/,
            use: [
              {
                loader: require.resolve('stylus-loader'),
                options: {
                  sourceMap: cssSourceMap,
                  stylusOptions: {
                    compress: false,
                    sourceMap: { comment: false },
                    paths: includePaths,
                  },
                },
              },
            ],
          },
        ],
      },
    ],
  };

  return {
    entry: entryPoints,
    module: {
      rules: [styleRule],
    },
    plugins: extraPlugins,
  };
}
