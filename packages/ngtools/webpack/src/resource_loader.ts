/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import * as vm from 'vm';
import { Compilation, NormalModule } from 'webpack';
import { RawSource } from 'webpack-sources';
import { normalizePath } from './ivy/paths';
import { isWebpackFiveOrHigher } from './webpack-version';

const NodeTemplatePlugin = require('webpack/lib/node/NodeTemplatePlugin');
const NodeTargetPlugin = require('webpack/lib/node/NodeTargetPlugin');
const LibraryTemplatePlugin = require('webpack/lib/LibraryTemplatePlugin');
const SingleEntryPlugin = require('webpack/lib/SingleEntryPlugin');

interface CompilationOutput {
  content: string;
  map?: string;
  success: boolean;
}

export class WebpackResourceLoader {
  private _parentCompilation?: Compilation;
  private _fileDependencies = new Map<string, Set<string>>();
  private _reverseDependencies = new Map<string, Set<string>>();

  private cache = new Map<string, CompilationOutput>();
  private modifiedResources = new Set<string>();
  private outputPathCounter = 1;

  update(
    parentCompilation: Compilation,
    changedFiles?: Iterable<string>,
  ) {
    this._parentCompilation = parentCompilation;

    // Update resource cache and modified resources
    this.modifiedResources.clear();
    if (changedFiles) {
      for (const changedFile of changedFiles) {
        for (const affectedResource of this.getAffectedResources(changedFile)) {
          this.cache.delete(normalizePath(affectedResource));
          this.modifiedResources.add(affectedResource);
        }
      }
    } else {
      this.cache.clear();
    }
  }

  getModifiedResourceFiles() {
    return this.modifiedResources;
  }

  getResourceDependencies(filePath: string) {
    return this._fileDependencies.get(filePath) || [];
  }

  getAffectedResources(file: string) {
    return this._reverseDependencies.get(file) || [];
  }

  setAffectedResources(file: string, resources: Iterable<string>) {
    this._reverseDependencies.set(file, new Set(resources));
  }

  private async _compile(
    filePath?: string,
    data?: string,
    mimeType?: string,
  ): Promise<CompilationOutput> {
    if (!this._parentCompilation) {
      throw new Error('WebpackResourceLoader cannot be used without parentCompilation');
    }

    // Simple sanity check.
    if (filePath?.match(/\.[jt]s$/)) {
      return Promise.reject(
        `Cannot use a JavaScript or TypeScript file (${filePath}) in a component's styleUrls or templateUrl.`,
      );
    }

    // Create a special URL for reading the resource from memory
    const angularScheme = 'angular-resource://';

    const outputFilePath = filePath || `angular-resource-output-${this.outputPathCounter++}.css`;
    const outputOptions = { filename: outputFilePath };
    const context = this._parentCompilation.compiler.context;
    const childCompiler = this._parentCompilation.createChildCompiler(
      'angular-compiler:resource',
      outputOptions,
      [
        new NodeTemplatePlugin(outputOptions),
        new NodeTargetPlugin(),
        new SingleEntryPlugin(context, data ? angularScheme : filePath, 'resource'),
        new LibraryTemplatePlugin('resource', 'var'),
      ],
    );

    childCompiler.hooks.thisCompilation.tap(
      'angular-compiler',
      (compilation, { normalModuleFactory }) => {
        // If no data is provided, the resource will be read from the filesystem
        if (data !== undefined) {
          normalModuleFactory.hooks.resolveForScheme
            .for('angular-resource')
            .tap('angular-compiler', (resourceData) => {
              if (filePath) {
                resourceData.path = filePath;
                resourceData.resource = filePath;
              }

              if (mimeType) {
                resourceData.data.mimetype = mimeType;
              }

              return true;
            });
          NormalModule.getCompilationHooks(compilation)
            .readResourceForScheme.for('angular-resource')
            .tap('angular-compiler', () => data);
        }

        compilation.hooks.additionalAssets.tap('angular-compiler', () => {
          const asset = compilation.assets[outputFilePath];
          if (!asset) {
            return;
          }

          try {
            const output = this._evaluate(outputFilePath, asset.source().toString());

            if (typeof output === 'string') {
              // `webpack-sources` package has incomplete typings
              // tslint:disable-next-line: no-any
              compilation.assets[outputFilePath] = new RawSource(output) as any;
            }
          } catch (error) {
            // Use compilation errors, as otherwise webpack will choke
            compilation.errors.push(error);
          }
        });
      },
    );

    let finalContent: string | undefined;
    let finalMap: string | undefined;
    if (isWebpackFiveOrHigher()) {
      childCompiler.hooks.compilation.tap('angular-compiler', (childCompilation) => {
        // tslint:disable-next-line: no-any
        (childCompilation.hooks as any).processAssets.tap(
          { name: 'angular-compiler', stage: 5000 },
          () => {
            finalContent = childCompilation.assets[outputFilePath]?.source().toString();
            finalMap = childCompilation.assets[outputFilePath + '.map']?.source().toString();

            delete childCompilation.assets[outputFilePath];
            delete childCompilation.assets[outputFilePath + '.map'];
          },
        );
      });
    } else {
      childCompiler.hooks.afterCompile.tap('angular-compiler', (childCompilation) => {
        finalContent = childCompilation.assets[outputFilePath]?.source().toString();
        finalMap = childCompilation.assets[outputFilePath + '.map']?.source().toString();

        delete childCompilation.assets[outputFilePath];
        delete childCompilation.assets[outputFilePath + '.map'];
      });
    }

    return new Promise<CompilationOutput>((resolve, reject) => {
      childCompiler.runAsChild((error, _, childCompilation) => {
        if (error) {
          reject(error);

          return;
        } else if (!childCompilation) {
          reject(new Error('Unknown child compilation error'));

          return;
        }

        // Save the dependencies for this resource.
        if (filePath) {
          this._fileDependencies.set(filePath, new Set(childCompilation.fileDependencies));
          for (const file of childCompilation.fileDependencies) {
            const resolvedFile = normalizePath(file);
            const entry = this._reverseDependencies.get(resolvedFile);
            if (entry) {
              entry.add(filePath);
            } else {
              this._reverseDependencies.set(resolvedFile, new Set([filePath]));
            }
          }
        }

        resolve({
          content: finalContent ?? '',
          map: finalMap,
          success: childCompilation.errors?.length === 0,
        });
      });
    });
  }

  private _evaluate(filename: string, source: string): string | null {
    // Evaluate code
    const context: { resource?: string | { default?: string } } = {};

    try {
      vm.runInNewContext(source, context, { filename });
    } catch {
      // Error are propagated through the child compilation.
      return null;
    }

    if (typeof context.resource === 'string') {
      return context.resource;
    } else if (typeof context.resource?.default === 'string') {
      return context.resource.default;
    }

    throw new Error(`The loader "${filename}" didn't return a string.`);
  }

  async get(filePath: string): Promise<string> {
    const normalizedFile = normalizePath(filePath);
    let compilationResult = this.cache.get(normalizedFile);

    if (compilationResult === undefined) {
      // cache miss so compile resource
      compilationResult = await this._compile(filePath);

      // Only cache if compilation was successful
      if (compilationResult.success) {
        this.cache.set(normalizedFile, compilationResult);
      }
    }

    return compilationResult.content;
  }

  async process(data: string, mimeType: string): Promise<string> {
    if (data.trim().length === 0) {
      return '';
    }

    const compilationResult = await this._compile(undefined, data, mimeType);

    return compilationResult.content;
  }
}
