// React Router (framework mode) adapter: reads app/routes.ts.
// Supports route(), index(), layout() and prefix() from @react-router/dev/routes.
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import ts from 'typescript';
import type { RouteNode } from '../types.js';
import type { StackAdapter } from './index.js';

const CANDIDATES = ['app/routes.ts', 'app/routes.tsx', 'src/routes.ts', 'routes.ts'];

function joinPath(base: string, segment: string): string {
  const joined = posix.join(base, segment);
  const clean = joined.replace(/\/+$/, '');
  return clean.startsWith('/') ? clean || '/' : `/${clean}`;
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isSatisfiesExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function literal(node: ts.Expression | undefined): string | null {
  return node !== undefined &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

export const reactRouterAdapter: StackAdapter = {
  name: 'react-router',

  findRoutes(workspace) {
    const config = CANDIDATES.find((c) => existsSync(join(workspace, c)));
    if (config === undefined) {
      return {
        routes: [],
        routeConfig: null,
        warnings: [`no route config found (looked for ${CANDIDATES.join(', ')})`],
      };
    }
    const appDir = posix.dirname(config);
    const sf = ts.createSourceFile(
      config,
      readFileSync(join(workspace, config), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const warnings: string[] = [];
    const routes: RouteNode[] = [];

    const exported = sf.statements.find(ts.isExportAssignment);
    const root = exported === undefined ? undefined : unwrap(exported.expression);
    if (root === undefined || !ts.isArrayLiteralExpression(root)) {
      return {
        routes,
        routeConfig: config,
        warnings: [`${config}: default export is not an array literal`],
      };
    }

    const fileOf = (relative: string) => posix.normalize(posix.join(appDir, relative));

    const add = (
      kind: RouteNode['kind'],
      file: string,
      path: string,
      parent: string | undefined,
    ): RouteNode => {
      let id = kind === 'index' ? `${file}#index` : file;
      // The same module can back several routes; keep ids unique.
      for (let n = 2; routes.some((r) => r.id === id); n++) id = `${file}#${String(n)}`;
      const node: RouteNode = {
        id,
        path,
        file,
        kind,
        children: [],
        ...(parent === undefined ? {} : { parent }),
      };
      if (!existsSync(join(workspace, file)))
        warnings.push(`${config}: route module ${file} does not exist`);
      routes.push(node);
      if (parent !== undefined) routes.find((r) => r.id === parent)?.children.push(id);
      return node;
    };

    const walk = (
      elements: ts.NodeArray<ts.Expression>,
      basePath: string,
      parent: string | undefined,
    ): void => {
      for (const raw of elements) {
        const element = ts.isSpreadElement(raw) ? unwrap(raw.expression) : unwrap(raw);
        if (!ts.isCallExpression(element) || !ts.isIdentifier(element.expression)) {
          warnings.push(`${config}: skipped an entry that is not a route helper call`);
          continue;
        }
        const helper = element.expression.text;
        const args = element.arguments;
        const childArray = args.find((a): a is ts.ArrayLiteralExpression =>
          ts.isArrayLiteralExpression(a),
        );

        if (helper === 'route') {
          const segment = literal(args[0]);
          const file = literal(args[1]);
          if (segment === null || file === null) {
            warnings.push(`${config}: route() with non-literal arguments skipped`);
            continue;
          }
          const node = add('route', fileOf(file), joinPath(basePath, segment), parent);
          if (childArray !== undefined) walk(childArray.elements, node.path, node.id);
        } else if (helper === 'index') {
          const file = literal(args[0]);
          if (file === null) continue;
          add('index', fileOf(file), basePath, parent);
        } else if (helper === 'layout') {
          const file = literal(args[0]);
          if (file === null) continue;
          const node = add('layout', fileOf(file), basePath, parent);
          if (childArray !== undefined) walk(childArray.elements, basePath, node.id);
        } else if (helper === 'prefix') {
          const segment = literal(args[0]);
          if (segment === null || childArray === undefined) continue;
          walk(childArray.elements, joinPath(basePath, segment), parent);
        } else {
          warnings.push(`${config}: unknown route helper ${helper}() skipped`);
        }
      }
    };
    walk(root.elements, '/', undefined);

    // root.tsx wraps every route in framework mode.
    const rootFile = posix.join(appDir, 'root.tsx');
    return {
      routes,
      routeConfig: config,
      rootModule: existsSync(join(workspace, rootFile)) ? rootFile : null,
      warnings,
    };
  },
};
