// Angular adapter. Routes come from Routes arrays (standalone provideRouter or NgModule
// RouterModule.forRoot/forChild), followed through component, loadComponent, children and lazy
// loadChildren. Guards declared on routes (canActivate, canMatch, ...) and role or permission
// lists in route data are kept on the route. Components are read with their templates.
import { existsSync, globSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import ts from 'typescript';
import { aliasCandidates, loadAliases } from '../aliases.js';
import { scanTemplate } from '../extractors/angular-template.js';
import { extractModule } from '../extractors/jsx.js';
import type { ApiCall, Guard, RouteNode } from '../types.js';
import type { Extraction, StackAdapter } from './index.js';

const CONFIG_CANDIDATES = [
  'src/app/app.routes.ts',
  'src/app/app-routing.module.ts',
  'src/app/app.routing.ts',
  'src/app/routes.ts',
  'src/app/app.config.ts',
  'src/app/app.module.ts',
  'src/main.ts',
];
const ROOT_CANDIDATES = ['src/app/app.component.ts', 'src/app/app.ts'];
const GUARD_HOOKS = ['canActivate', 'canMatch', 'canActivateChild', 'canLoad'];
/** Route data keys that name who may see a route, e.g. data: { roles: ['admin'] }. */
const ACCESS_DATA_KEY =
  /^(roles?|permissions?|claims?|scopes?|rights?|requiredRoles?|requiredPermissions?|allowedRoles?)$/i;
const HTTP_CLIENT_FIELD = /^(http|httpClient|client|api)$/;
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'request']);
const MAX_DEPTH = 12;

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
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function literal(node: ts.Expression | undefined): string | null {
  if (node === undefined) return null;
  const n = unwrap(node);
  return ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : null;
}

function property(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
      if (p.name.text === name) return p.initializer;
    }
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name;
  }
  return undefined;
}

function strings(node: ts.Expression | undefined): string[] {
  if (node === undefined) return [];
  const n = unwrap(node);
  const single = literal(n);
  if (single !== null) return [single];
  if (ts.isArrayLiteralExpression(n)) return n.elements.flatMap((e) => strings(e));
  return [];
}

/** One parsed TypeScript file, with where its imports point. */
interface Parsed {
  file: string;
  sf: ts.SourceFile;
  /** Local name -> { module file, exported name } for relative imports. */
  imports: Map<string, { file: string; name: string }>;
}

export const angularAdapter: StackAdapter = {
  name: 'angular',

  findRoutes(workspace) {
    const warnings: string[] = [];
    const routes: RouteNode[] = [];
    const cache = new Map<string, Parsed | null>();

    const aliases = loadAliases(workspace);
    const resolveFile = (from: string, specifier: string): string | null => {
      const bases = specifier.startsWith('.')
        ? [posix.normalize(posix.join(posix.dirname(from), specifier))]
        : aliasCandidates(aliases, specifier);
      for (const base of bases) {
        for (const candidate of [`${base}.ts`, `${base}/index.ts`, base]) {
          if (candidate.endsWith('.ts') && existsSync(join(workspace, candidate))) return candidate;
        }
      }
      return null;
    };

    const parse = (file: string): Parsed | null => {
      if (cache.has(file)) return cache.get(file) ?? null;
      let parsed: Parsed | null = null;
      if (existsSync(join(workspace, file))) {
        const sf = ts.createSourceFile(
          file,
          readFileSync(join(workspace, file), 'utf8'),
          ts.ScriptTarget.Latest,
          true,
        );
        const imports = new Map<string, { file: string; name: string }>();
        for (const statement of sf.statements) {
          if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
            continue;
          const target = resolveFile(file, statement.moduleSpecifier.text);
          const bindings = statement.importClause?.namedBindings;
          if (target === null || bindings === undefined || !ts.isNamedImports(bindings)) continue;
          for (const element of bindings.elements) {
            imports.set(element.name.text, {
              file: target,
              name: (element.propertyName ?? element.name).text,
            });
          }
        }
        parsed = { file, sf, imports };
      }
      cache.set(file, parsed);
      return parsed;
    };

    /** The array a name refers to: a variable in this file or one it imports. */
    const arrayNamed = (
      file: string,
      name: string,
      depth = 0,
    ): { file: string; array: ts.ArrayLiteralExpression } | null => {
      const parsed = parse(file);
      if (parsed === null || depth > MAX_DEPTH) return null;
      for (const statement of parsed.sf.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.name.text === name &&
            declaration.initializer !== undefined
          ) {
            const value = unwrap(declaration.initializer);
            if (ts.isArrayLiteralExpression(value)) return { file, array: value };
            if (ts.isIdentifier(value)) return arrayNamed(file, value.text, depth + 1);
          }
        }
      }
      if (name === 'default') {
        const exported = parsed.sf.statements.find(ts.isExportAssignment);
        const value = exported === undefined ? undefined : unwrap(exported.expression);
        if (value !== undefined && ts.isArrayLiteralExpression(value))
          return { file, array: value };
        if (value !== undefined && ts.isIdentifier(value))
          return arrayNamed(file, value.text, depth + 1);
      }
      const imported = parsed.imports.get(name);
      return imported === undefined ? null : arrayNamed(imported.file, imported.name, depth + 1);
    };

    /** The routes a file registers: forRoot/forChild/provideRouter arguments, or a Routes variable. */
    const routesIn = (file: string): { file: string; array: ts.ArrayLiteralExpression } | null => {
      const parsed = parse(file);
      if (parsed === null) return null;
      const fromArgument = (arg: ts.Expression | undefined) => {
        if (arg === undefined) return null;
        const value = unwrap(arg);
        if (ts.isArrayLiteralExpression(value)) return { file, array: value };
        if (ts.isIdentifier(value)) return arrayNamed(file, value.text);
        return null;
      };
      const registered = (
        node: ts.Node,
      ): { file: string; array: ts.ArrayLiteralExpression } | null => {
        if (ts.isCallExpression(node)) {
          const callee = node.expression;
          const name = ts.isIdentifier(callee)
            ? callee.text
            : ts.isPropertyAccessExpression(callee)
              ? callee.name.text
              : '';
          if (name === 'provideRouter' || name === 'forRoot' || name === 'forChild') {
            const result = fromArgument(node.arguments[0]);
            if (result !== null) return result;
          }
        }
        return ts.forEachChild(node, (child) => registered(child) ?? undefined) ?? null;
      };
      const found = registered(parsed.sf);
      if (found !== null) return found;
      // No registration call here: a variable typed Routes (or Route[]), preferring an export.
      const typed: { file: string; array: ts.ArrayLiteralExpression; exported: boolean }[] = [];
      for (const statement of parsed.sf.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        const exported =
          statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
        for (const declaration of statement.declarationList.declarations) {
          const type = declaration.type?.getText(parsed.sf).replace(/\s/g, '');
          const value =
            declaration.initializer === undefined ? undefined : unwrap(declaration.initializer);
          if (
            (type === 'Routes' || type === 'Route[]') &&
            value !== undefined &&
            ts.isArrayLiteralExpression(value)
          ) {
            typed.push({ file, array: value, exported });
          }
        }
      }
      const pick = typed.find((t) => t.exported) ?? typed[0];
      return pick === undefined ? null : { file: pick.file, array: pick.array };
    };

    /** The file and export an import() call loads: import('./x').then(m => m.Y). */
    const dynamicImport = (
      file: string,
      node: ts.Expression,
    ): { file: string; name: string } | null => {
      let body: ts.Node = unwrap(node);
      if (ts.isArrowFunction(body) || ts.isFunctionExpression(body)) {
        body = ts.isBlock(body.body)
          ? (body.body.statements.find(ts.isReturnStatement)?.expression ?? body.body)
          : body.body;
      }
      let name = 'default';
      if (
        ts.isCallExpression(body) &&
        ts.isPropertyAccessExpression(body.expression) &&
        body.expression.name.text === 'then'
      ) {
        const callback = body.arguments[0];
        if (callback !== undefined && ts.isArrowFunction(callback)) {
          const result = ts.isBlock(callback.body) ? undefined : unwrap(callback.body);
          if (result !== undefined && ts.isPropertyAccessExpression(result))
            name = result.name.text;
        }
        body = body.expression.expression;
      }
      if (
        ts.isCallExpression(body) &&
        body.expression.kind === ts.SyntaxKind.ImportKeyword &&
        body.arguments[0] !== undefined
      ) {
        const specifier = literal(body.arguments[0]);
        const target = specifier === null ? null : resolveFile(file, specifier);
        return target === null ? null : { file: target, name };
      }
      return null;
    };

    /** The file a component reference points to: an import, or a class in this file. */
    const componentFile = (file: string, node: ts.Expression): string | null => {
      const value = unwrap(node);
      if (!ts.isIdentifier(value)) return null;
      const parsed = parse(file);
      const imported = parsed?.imports.get(value.text);
      if (imported !== undefined) return imported.file;
      const local = parsed?.sf.statements.some(
        (s) => ts.isClassDeclaration(s) && s.name?.text === value.text,
      );
      if (local === true) return file;
      warnings.push(`${file}: could not find the file for component ${value.text}`);
      return null;
    };

    const routeGuards = (route: ts.ObjectLiteralExpression, sf: ts.SourceFile): Guard[] => {
      const line = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const guards: Guard[] = [];
      for (const hook of GUARD_HOOKS) {
        const value = property(route, hook);
        if (value === undefined) continue;
        const list = unwrap(value);
        const entries = ts.isArrayLiteralExpression(list) ? list.elements : [list];
        for (const entry of entries) {
          const e = unwrap(entry);
          if (ts.isIdentifier(e)) {
            guards.push({ call: e.text, args: [], in: hook, line: line(e) });
          } else if (ts.isCallExpression(e)) {
            const callee = unwrap(e.expression);
            const name = ts.isIdentifier(callee)
              ? callee.text
              : ts.isPropertyAccessExpression(callee)
                ? callee.name.text
                : callee.getText(sf);
            guards.push({
              call: name,
              args: e.arguments.flatMap((a) => strings(a)),
              in: hook,
              line: line(e),
            });
          } else {
            guards.push({ call: e.getText(sf).slice(0, 60), args: [], in: hook, line: line(e) });
          }
        }
      }
      const data = property(route, 'data');
      if (data !== undefined && ts.isObjectLiteralExpression(unwrap(data))) {
        for (const p of (unwrap(data) as ts.ObjectLiteralExpression).properties) {
          if (
            ts.isPropertyAssignment(p) &&
            (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
            ACCESS_DATA_KEY.test(p.name.text)
          ) {
            const args = strings(p.initializer);
            if (args.length > 0) {
              guards.push({ call: `data.${p.name.text}`, args, in: 'route-data', line: line(p) });
            }
          }
        }
      }
      return guards;
    };

    const add = (
      kind: RouteNode['kind'],
      file: string,
      path: string,
      parent: string | undefined,
      guards: Guard[],
    ): RouteNode => {
      let id = kind === 'index' ? `${file}#index` : file;
      for (let n = 2; routes.some((r) => r.id === id); n++) id = `${file}#${String(n)}`;
      const node: RouteNode = {
        id,
        path,
        file,
        kind,
        children: [],
        ...(parent === undefined ? {} : { parent }),
        ...(guards.length > 0 ? { guards } : {}),
      };
      routes.push(node);
      if (parent !== undefined) routes.find((r) => r.id === parent)?.children.push(id);
      return node;
    };

    const walk = (
      file: string,
      array: ts.ArrayLiteralExpression,
      basePath: string,
      parent: string | undefined,
      inherited: Guard[],
      depth: number,
      seen: Set<string>,
    ): void => {
      if (depth > MAX_DEPTH) {
        warnings.push(`${file}: routes nested deeper than ${String(MAX_DEPTH)} levels; stopped`);
        return;
      }
      const sf = parse(file)?.sf;
      if (sf === undefined) return;
      for (const raw of array.elements) {
        if (ts.isSpreadElement(raw)) {
          const spread = unwrap(raw.expression);
          const target = ts.isIdentifier(spread) ? arrayNamed(file, spread.text) : null;
          if (target === null) warnings.push(`${file}: skipped a spread it could not resolve`);
          else walk(target.file, target.array, basePath, parent, inherited, depth + 1, seen);
          continue;
        }
        const element = unwrap(raw);
        if (!ts.isObjectLiteralExpression(element)) {
          if (ts.isIdentifier(element)) {
            warnings.push(`${file}: route "${element.text}" is a variable; skipped`);
          }
          continue;
        }
        const segment = literal(property(element, 'path')) ?? '';
        const path = joinPath(basePath, segment);
        const guards = [...inherited, ...routeGuards(element, sf)];

        let module: string | null = null;
        const component = property(element, 'component');
        if (component !== undefined) module = componentFile(file, component);
        const loadComponent = property(element, 'loadComponent');
        if (loadComponent !== undefined) {
          const target = dynamicImport(file, loadComponent);
          if (target === null) warnings.push(`${file}: loadComponent for "${path}" not resolved`);
          else module = target.file;
        }

        const children = property(element, 'children');
        const childArray =
          children !== undefined && ts.isArrayLiteralExpression(unwrap(children))
            ? (unwrap(children) as ts.ArrayLiteralExpression)
            : null;
        let lazy: { file: string; array: ts.ArrayLiteralExpression } | null = null;
        const loadChildren = property(element, 'loadChildren');
        if (loadChildren !== undefined) {
          const literalChildren = literal(loadChildren);
          const target = literalChildren === null ? dynamicImport(file, loadChildren) : null;
          if (literalChildren !== null) {
            warnings.push(`${file}: string loadChildren "${literalChildren}" is not supported`);
          } else if (target === null) {
            warnings.push(`${file}: loadChildren for "${path}" not resolved`);
          } else {
            const key = `${target.file}#${target.name}`;
            if (!seen.has(key)) {
              seen.add(key);
              // Either a Routes export, or an NgModule that calls RouterModule.forChild.
              lazy = arrayNamed(target.file, target.name) ?? routesIn(target.file);
              if (lazy === null) warnings.push(`${target.file}: no routes found for "${path}"`);
            }
          }
        }

        if (module === null) {
          if (property(element, 'redirectTo') !== undefined && childArray === null && lazy === null)
            continue;
          // A grouping route: no component, so its guards apply to its children.
          if (childArray !== null) walk(file, childArray, path, parent, guards, depth + 1, seen);
          if (lazy !== null) walk(lazy.file, lazy.array, path, parent, guards, depth + 1, seen);
          continue;
        }
        if (!existsSync(join(workspace, module))) {
          warnings.push(`${file}: component module ${module} does not exist`);
        }
        const hasChildren = childArray !== null || lazy !== null;
        const kind: RouteNode['kind'] = hasChildren ? 'layout' : segment === '' ? 'index' : 'route';
        // A component-less group's guards (inherited) gate this route too.
        const node = add(kind, module, path, parent, guards);
        // Guards on a component route also gate its children, which the query walks via parent.
        if (childArray !== null) walk(file, childArray, path, node.id, [], depth + 1, seen);
        if (lazy !== null) walk(lazy.file, lazy.array, path, node.id, [], depth + 1, seen);
      }
    };

    let entry: { file: string; array: ts.ArrayLiteralExpression } | null = null;
    let config: string | null = null;
    for (const candidate of CONFIG_CANDIDATES) {
      entry = routesIn(candidate);
      if (entry !== null) {
        config = candidate;
        break;
      }
    }
    if (entry === null) {
      // Look for the registration call anywhere under src/.
      const files = globSync('src/**/*.ts', { cwd: workspace })
        .map((f) => f.replaceAll('\\', '/'))
        .filter((f) => !f.endsWith('.spec.ts') && !f.split('/').includes('node_modules'))
        .slice(0, 2000);
      for (const file of files) {
        const text = readFileSync(join(workspace, file), 'utf8');
        if (!/provideRouter\(|RouterModule\.forRoot\(/.test(text)) continue;
        entry = routesIn(file);
        if (entry !== null) {
          config = file;
          break;
        }
      }
    }
    if (entry === null || config === null) {
      return {
        routes,
        routeConfig: null,
        warnings: [
          `no Angular routes found (looked for provideRouter or RouterModule.forRoot, and ${CONFIG_CANDIDATES.join(', ')})`,
        ],
      };
    }
    walk(entry.file, entry.array, '/', undefined, [], 0, new Set());

    const root = ROOT_CANDIDATES.find((c) => existsSync(join(workspace, c))) ?? null;
    return { routes, routeConfig: entry.file, rootModule: root, warnings };
  },

  extract(file, source, readAsset): Extraction {
    const base = extractModule(file, source);
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const line = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const assets: string[] = [];
    const exports = new Set(base.exports);
    const api: ApiCall[] = [...base.api];
    const selectors = [...base.selectors];
    const links = [...base.links];
    const guards = [...base.guards];

    const visit = (node: ts.Node) => {
      // this.http.get('/api/x'), with HttpClient injected as a field or constructor parameter.
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const target = node.expression.expression;
        const field =
          ts.isPropertyAccessExpression(target) &&
          target.expression.kind === ts.SyntaxKind.ThisKeyword
            ? target.name.text
            : null;
        const first = node.arguments[0];
        if (field !== null && HTTP_CLIENT_FIELD.test(field) && HTTP_METHODS.has(method) && first) {
          const url =
            ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)
              ? { value: first.text, pattern: false }
              : ts.isTemplateExpression(first)
                ? {
                    value:
                      first.head.text +
                      first.templateSpans.map((s) => `*${s.literal.text}`).join(''),
                    pattern: true,
                  }
                : { value: '*', pattern: true };
          api.push({
            kind: 'http-client',
            method: method === 'request' ? 'REQUEST' : method.toUpperCase(),
            url: url.value,
            pattern: url.pattern,
            line: line(node),
          });
        }
      }
      // @Component({ template | templateUrl }), @Injectable, @NgModule ...
      if (ts.isDecorator(node) && ts.isCallExpression(node.expression)) {
        const callee = node.expression.expression;
        const name = ts.isIdentifier(callee) ? callee.text : null;
        if (
          name === 'Component' ||
          name === 'Injectable' ||
          name === 'NgModule' ||
          name === 'Directive'
        ) {
          exports.add(name.toLowerCase());
        }
        const options = node.expression.arguments[0];
        if (
          name === 'Component' &&
          options !== undefined &&
          ts.isObjectLiteralExpression(options)
        ) {
          const inline = property(options, 'template');
          const url = literal(property(options, 'templateUrl'));
          let findings: ReturnType<typeof scanTemplate> | null = null;
          if (inline !== undefined) {
            const text =
              ts.isStringLiteral(inline) || ts.isNoSubstitutionTemplateLiteral(inline)
                ? inline.text
                : ts.isTemplateExpression(inline)
                  ? inline.getText(sf).slice(1, -1)
                  : null;
            if (text !== null) findings = scanTemplate(text, line(inline));
          } else if (url !== null) {
            const asset = posix.normalize(posix.join(posix.dirname(file), url));
            const html = readAsset(asset);
            if (html !== null) {
              assets.push(asset);
              findings = scanTemplate(html, 1);
              // Template lines refer to the HTML file.
              for (const s of findings.selectors) s.source = asset;
            }
          }
          if (findings !== null) {
            selectors.push(...findings.selectors);
            links.push(...findings.links);
            guards.push(...findings.guards);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);

    return {
      ...base,
      exports: [...exports].sort(),
      selectors,
      links,
      guards,
      api,
      ...(assets.length > 0 ? { assets } : {}),
    };
  },
};
