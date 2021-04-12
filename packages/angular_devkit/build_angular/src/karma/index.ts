/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import { BuilderContext, BuilderOutput, createBuilder } from '@angular-devkit/architect';
import { getSystemPath, join, normalize } from '@angular-devkit/core';
import { Config, ConfigOptions } from 'karma';
import { dirname, resolve } from 'path';
import { Observable, from } from 'rxjs';
import { defaultIfEmpty, switchMap } from 'rxjs/operators';
import * as webpack from 'webpack';
import { Schema as BrowserBuilderOptions } from '../browser/schema';
import { ExecutionTransformer } from '../transforms';
import { assertCompatibleAngularVersion } from '../utils/version';
import { generateBrowserWebpackConfigFromContext } from '../utils/webpack-browser-config';
import {
  getCommonConfig,
  getNonAotConfig,
  getStylesConfig,
  getTestConfig,
  getWorkerConfig,
} from '../webpack/configs';
import { SingleTestTransformLoader } from '../webpack/plugins/single-test-transform';
import { findTests } from './find-tests';
import { Schema as KarmaBuilderOptions } from './schema';

export type KarmaConfigOptions = ConfigOptions & {
  buildWebpack?: unknown;
  configFile?: string;
};

async function initialize(
  options: KarmaBuilderOptions,
  context: BuilderContext,
  webpackConfigurationTransformer?: ExecutionTransformer<webpack.Configuration>,
): Promise<[typeof import('karma'), webpack.Configuration]> {
  const { config } = await generateBrowserWebpackConfigFromContext(
    // only two properties are missing:
    // * `outputPath` which is fixed for tests
    // * `budgets` which might be incorrect due to extra dev libs
    { ...((options as unknown) as BrowserBuilderOptions), outputPath: '', budgets: undefined },
    context,
    wco => [
      getCommonConfig(wco),
      getStylesConfig(wco),
      getNonAotConfig(wco),
      getTestConfig(wco),
      getWorkerConfig(wco),
    ],
  );

  const karma = await import('karma');

  return [
    karma,
    webpackConfigurationTransformer ? await webpackConfigurationTransformer(config) : config,
  ];
}

export function execute(
  options: KarmaBuilderOptions,
  context: BuilderContext,
  transforms: {
    webpackConfiguration?: ExecutionTransformer<webpack.Configuration>;
    // The karma options transform cannot be async without a refactor of the builder implementation
    karmaOptions?: (options: KarmaConfigOptions) => KarmaConfigOptions;
  } = {},
): Observable<BuilderOutput> {
  // Check Angular version.
  assertCompatibleAngularVersion(context.workspaceRoot, context.logger);

  return from(initialize(options, context, transforms.webpackConfiguration)).pipe(
    switchMap(async ([karma, webpackConfig]) => {
      const karmaOptions: KarmaConfigOptions = {};

      if (options.watch !== undefined) {
        karmaOptions.singleRun = !options.watch;
      }

      // Convert browsers from a string to an array
      if (options.browsers) {
        karmaOptions.browsers = options.browsers.split(',');
      }

      if (options.reporters) {
        // Split along commas to make it more natural, and remove empty strings.
        const reporters = options.reporters
          .reduce<string[]>((acc, curr) => acc.concat(curr.split(',')), [])
          .filter(x => !!x);

        if (reporters.length > 0) {
          karmaOptions.reporters = reporters;
        }
      }

      // prepend special webpack loader that will transform test.ts
      if (options.include && options.include.length > 0) {
        const mainFilePath = getSystemPath(
          join(normalize(context.workspaceRoot), options.main),
        );
        const files = findTests(options.include, dirname(mainFilePath), context.workspaceRoot);
        // early exit, no reason to start karma
        if (!files.length) {
          throw new Error(
            `Specified patterns: "${options.include.join(', ')}" did not match any spec files.`,
          );
        }

        // Get the rules and ensure the Webpack configuration is setup properly
        const rules = webpackConfig.module?.rules || [];
        if (!webpackConfig.module) {
          webpackConfig.module = { rules };
        } else if (!webpackConfig.module.rules) {
          webpackConfig.module.rules = rules;
        }

        rules.unshift({
          test: mainFilePath,
          use: {
            // cannot be a simple path as it differs between environments
            loader: SingleTestTransformLoader,
            options: {
              files,
              logger: context.logger,
            },
          },
        });
      }

      karmaOptions.buildWebpack = {
        options,
        webpackConfig,
        logger: context.logger,
      };

      const config = await karma.config.parseConfig(
        resolve(context.workspaceRoot, options.karmaConfig),
        transforms.karmaOptions ? transforms.karmaOptions(karmaOptions) : karmaOptions,
        { promiseConfig: true, throwErrors: true },
      );

      return [karma, config] as [typeof karma, KarmaConfigOptions];
    }),
    switchMap(([karma, karmaConfig]) => new Observable<BuilderOutput>(subscriber => {
      // Pass onto Karma to emit BuildEvents.
      karmaConfig.buildWebpack ??= {};
      if (typeof karmaConfig.buildWebpack === 'object') {
        // tslint:disable-next-line: no-any
        (karmaConfig.buildWebpack as any).failureCb ??= () => subscriber.next({ success: false });
        // tslint:disable-next-line: no-any
        (karmaConfig.buildWebpack as any).successCb ??= () => subscriber.next({ success: true });
      }

      // Complete the observable once the Karma server returns.
      const karmaServer = new karma.Server(
        karmaConfig as Config,
        exitCode => {
          subscriber.next({ success: exitCode === 0 });
          subscriber.complete();
        },
      );

      const karmaStart = karmaServer.start();

      // Cleanup, signal Karma to exit.
      return () => karmaStart.then(() => karmaServer.stop());
    })),
    defaultIfEmpty({ success: false }),
  );
}

export { KarmaBuilderOptions };
export default createBuilder<Record<string, string> & KarmaBuilderOptions>(execute);
