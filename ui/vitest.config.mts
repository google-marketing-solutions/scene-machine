/**
 * Vitest harness for bare `npx vitest run` (no @angular/build:unit-test).
 *
 * The Angular plugin below gives JIT TestBed specs what the CLI builder
 * normally provides, using only packages already in package.json:
 *
 *  - External resources: components use `templateUrl`/`styleUrl(s)`, which
 *    the JIT compiler cannot resolve ("Component ... is not resolved").
 *    A custom CompilerHost inlines the sibling .html as `template:` and
 *    replaces styles with `styles: []` before the file is parsed.
 *
 *  - Initializer APIs: signal-based `input()`/`input.required()`/`model()`/
 *    `output()`/`viewChild()` members are invisible to the bare JIT
 *    compiler (NG0950 "Input is required but no value is available yet").
 *    Source files are emitted through a shared ts.Program with
 *    `angularJitApplicationTransform(program)` from @angular/compiler-cli
 *    (the same transform the Angular CLI and jest-preset-angular use for
 *    JIT unit tests). Note: in Angular 21 this transform REQUIRES a
 *    ts.Program — there is no program-less form — hence the single shared
 *    program over all src TS files instead of plain ts.transpileModule.
 */
import {existsSync, readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {angularJitApplicationTransform} from '@angular/compiler-cli';
import ts from 'typescript';
import {defineConfig, type Plugin} from 'vitest/config';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(projectRoot, 'src');

function inlineResources(source: string, fileName: string): string {
  if (!source.includes('templateUrl') && !source.includes('styleUrl')) {
    return source;
  }
  const dir = dirname(fileName);
  let out = source.replace(
    /templateUrl\s*:\s*(['"`])(.*?)\1/g,
    (match, _quote: string, url: string) => {
      const templatePath = resolve(dir, url);
      if (!existsSync(templatePath)) {
        return match;
      }
      return `template: ${JSON.stringify(readFileSync(templatePath, 'utf8'))}`;
    },
  );
  out = out.replace(/styleUrls\s*:\s*\[[\s\S]*?\]/g, 'styles: []');
  out = out.replace(/styleUrl\s*:\s*(['"`])(.*?)\1/g, 'styles: []');
  return out;
}

function isProjectTsFile(fileName: string): boolean {
  return (
    fileName.startsWith(`${srcRoot}/`) &&
    fileName.endsWith('.ts') &&
    !fileName.endsWith('.d.ts')
  );
}

function angularJitPlugin(): Plugin {
  let program: ts.Program | undefined;
  let jitTransform: ts.TransformerFactory<ts.SourceFile> | undefined;

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    types: [],
    experimentalDecorators: true,
    skipLibCheck: true,
    isolatedModules: true,
    sourceMap: true,
    inlineSources: true,
  };

  function getProgram(): ts.Program {
    if (!program) {
      const rootNames = ts.sys.readDirectory(
        srcRoot,
        ['.ts'],
        /* excludes */ undefined,
        /* includes */ ['**/*.ts'],
      );
      const host = ts.createCompilerHost(compilerOptions, true);
      const defaultGetSourceFile = host.getSourceFile.bind(host);
      host.getSourceFile = (fileName, languageVersionOrOptions, ...rest) => {
        if (isProjectTsFile(fileName)) {
          const text = host.readFile(fileName);
          if (text === undefined) {
            return undefined;
          }
          return ts.createSourceFile(
            fileName,
            inlineResources(text, fileName),
            languageVersionOrOptions,
            true,
          );
        }
        return defaultGetSourceFile(fileName, languageVersionOrOptions, ...rest);
      };
      program = ts.createProgram(rootNames, compilerOptions, host);
      jitTransform = angularJitApplicationTransform(program);
    }
    return program;
  }

  return {
    name: 'angular-jit-test-harness',
    enforce: 'pre',
    transform(code, id) {
      const [fileName] = id.split('?');
      if (!isProjectTsFile(fileName) || fileName.includes('/node_modules/')) {
        return null;
      }
      const prog = getProgram();
      const sourceFile = prog.getSourceFile(fileName);
      if (!sourceFile) {
        // File unknown to the program (should not happen for src files):
        // fall back to resource inlining only and let esbuild compile it.
        return {code: inlineResources(code, fileName), map: null};
      }
      let emitted: string | undefined;
      let map: string | undefined;
      prog.emit(
        sourceFile,
        (outName, text) => {
          if (outName.endsWith('.map')) {
            map = text;
          } else {
            emitted = text;
          }
        },
        undefined,
        false,
        {before: [jitTransform!]},
      );
      if (emitted === undefined) {
        return null;
      }
      return {code: emitted, map: map ? JSON.parse(map) : null};
    },
  };
}

export default defineConfig({
  plugins: [angularJitPlugin()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['src/test-setup.ts'],
    include: ['src/**/*.spec.ts'],
  },
});
