// Extracts selectors, guards, links, API calls and feature flags from a React (JSX/TSX) module.
// Works on the syntax tree only: nothing is executed, and dynamic values become "*" patterns.
import ts from 'typescript';
import type { ApiCall, FlagUse, Guard, Link, ModuleInfo, Selector } from '../types.js';

/** Bump whenever extraction output changes, so cached map entries are re-parsed. */
export const EXTRACTOR_VERSION = 3;

const GUARD_CALL =
  /^(require|ensure|assert|check)[A-Z]\w*$|^(can|hasPermission|hasRole|isAllowed|authorize)$/;
const FLAG_CALL = /^(useFlag|useFeature|isEnabled|isFeatureEnabled|getFlag|flag)$/;
const FLAG_OBJECT = /^(flags|featureFlags|features)$/;
const HTTP_CLIENT = /^(axios|http|api|client|ky)$/;
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head']);
const LINK_ELEMENTS = new Set(['Link', 'NavLink', 'a']);
const TEXT_ELEMENTS = new Set([
  'button',
  'a',
  'Link',
  'NavLink',
  'h1',
  'h2',
  'h3',
  'legend',
  'th',
  'summary',
]);
const ROUTE_EXPORTS = new Set([
  'loader',
  'action',
  'clientLoader',
  'clientAction',
  'meta',
  'links',
  'headers',
  'ErrorBoundary',
  'HydrateFallback',
  'default',
]);

/** A string from a literal or template, with "*" for each dynamic part. */
function staticText(node: ts.Node | undefined): { value: string; pattern: boolean } | null {
  if (node === undefined) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { value: node.text, pattern: false };
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      value += `*${span.literal.text}`;
    }
    return { value, pattern: true };
  }
  if (ts.isJsxExpression(node)) return staticText(node.expression);
  if (ts.isParenthesizedExpression(node)) return staticText(node.expression);
  return null;
}

function tagName(node: ts.JsxOpeningLikeElement): string {
  return node.tagName.getText();
}

function attribute(node: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return node.attributes.properties.find(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name,
  );
}

/** The strings an expression can evaluate to: a literal, or both branches of a ternary. */
function textAlternatives(node: ts.Expression | undefined): string[] {
  if (node === undefined) return [];
  if (ts.isParenthesizedExpression(node)) return textAlternatives(node.expression);
  if (ts.isConditionalExpression(node)) {
    return [...textAlternatives(node.whenTrue), ...textAlternatives(node.whenFalse)];
  }
  const text = staticText(node);
  return text !== null && !text.pattern ? [text.value] : [];
}

/**
 * Visible static text of a JSX element's children, e.g. <button>Save</button> -> ["Save"].
 * A ternary between two strings gives both: {open ? 'Close' : 'Reopen'} -> ["Close", "Reopen"].
 */
function childTexts(element: ts.JsxElement): string[] {
  let variants: string[] = [''];
  for (const child of element.children) {
    let options: string[] = [];
    if (ts.isJsxText(child)) {
      const text = child.text.replace(/\s+/g, ' ').trim();
      if (text !== '') options = [text];
    } else if (ts.isJsxExpression(child)) {
      options = textAlternatives(child.expression);
    }
    if (options.length > 0) {
      variants = variants.flatMap((v) => options.map((o) => `${v} ${o}`.trim())).slice(0, 4);
    }
  }
  return variants.filter((v) => v !== '');
}

/** Name of the function a node sits in: a route export, a component, or "module". */
function enclosingFunction(node: ts.Node): string {
  let current: ts.Node = node.parent;
  while (!ts.isSourceFile(current)) {
    if (ts.isFunctionDeclaration(current)) {
      const isDefault = current.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
      return isDefault === true ? 'component' : (current.name?.text ?? 'function');
    }
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent) &&
      ts.isIdentifier(current.parent.name)
    ) {
      return current.parent.name.text;
    }
    current = current.parent;
  }
  return 'module';
}

function calleeName(call: ts.CallExpression): { object?: string; name: string } | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return { name: callee.text };
  if (ts.isPropertyAccessExpression(callee)) {
    const object = callee.expression;
    return {
      ...(ts.isIdentifier(object) ? { object: object.text } : {}),
      name: callee.name.text,
    };
  }
  return null;
}

export function extractModule(
  file: string,
  source: string,
): Omit<ModuleInfo, 'imports'> & {
  importSpecifiers: string[];
} {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') || file.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const line = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  const selectors: Selector[] = [];
  const guards: Guard[] = [];
  const links: Link[] = [];
  const api: ApiCall[] = [];
  const flags: FlagUse[] = [];
  const exportsFound = new Set<string>();
  const importSpecifiers: string[] = [];

  const addSelector = (
    kind: Selector['kind'],
    text: { value: string; pattern: boolean } | null,
    element: string,
    node: ts.Node,
  ) => {
    if (text !== null && text.value.trim() !== '') {
      selectors.push({
        kind,
        value: text.value.trim(),
        pattern: text.pattern,
        element,
        line: line(node),
      });
    }
  };

  const visitOpening = (node: ts.JsxOpeningLikeElement, parent: ts.Node) => {
    const tag = tagName(node);
    addSelector('testid', staticText(attribute(node, 'data-testid')?.initializer), tag, node);
    addSelector('role', staticText(attribute(node, 'role')?.initializer), tag, node);
    addSelector('aria-label', staticText(attribute(node, 'aria-label')?.initializer), tag, node);
    addSelector('placeholder', staticText(attribute(node, 'placeholder')?.initializer), tag, node);

    if (ts.isJsxOpeningElement(node) && ts.isJsxElement(parent)) {
      for (const text of childTexts(parent)) {
        if (tag === 'label') addSelector('label', { value: text, pattern: false }, tag, node);
        else if (TEXT_ELEMENTS.has(tag))
          addSelector('text', { value: text, pattern: false }, tag, node);
      }
    }

    if (LINK_ELEMENTS.has(tag)) {
      const to = staticText(attribute(node, tag === 'a' ? 'href' : 'to')?.initializer);
      if (to !== null && to.value.startsWith('/')) {
        links.push({ kind: 'link', to: to.value, pattern: to.pattern, line: line(node) });
      }
    }
    if (tag === 'Form' || tag === 'form' || tag === 'fetcher.Form') {
      const action = staticText(attribute(node, 'action')?.initializer);
      const method =
        staticText(attribute(node, 'method')?.initializer)?.value.toUpperCase() ?? 'GET';
      if (action !== null && action.value.startsWith('/')) {
        links.push({
          kind: 'form',
          to: action.value,
          pattern: action.pattern,
          method,
          line: line(node),
        });
      }
      api.push({
        kind: 'form',
        method,
        url: action?.value ?? '(this route)',
        pattern: action?.pattern ?? false,
        line: line(node),
      });
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      importSpecifiers.push(node.moduleSpecifier.text);
    }
    if (ts.isExportAssignment(node)) exportsFound.add('default');
    if (
      (ts.isFunctionDeclaration(node) || ts.isVariableStatement(node)) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      if (node.modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword))
        exportsFound.add('default');
      const names = ts.isFunctionDeclaration(node)
        ? [node.name?.text]
        : node.declarationList.declarations.map((d) =>
            ts.isIdentifier(d.name) ? d.name.text : undefined,
          );
      for (const name of names)
        if (name !== undefined && ROUTE_EXPORTS.has(name)) exportsFound.add(name);
    }

    if (ts.isJsxElement(node)) visitOpening(node.openingElement, node);
    if (ts.isJsxSelfClosingElement(node)) visitOpening(node, node);

    if (ts.isCallExpression(node)) {
      const callee = calleeName(node);
      if (callee !== null) {
        const literalArgs = node.arguments
          .map((a) => staticText(a))
          .filter((a): a is { value: string; pattern: boolean } => a !== null);
        if (callee.object === undefined && GUARD_CALL.test(callee.name)) {
          guards.push({
            call: callee.name,
            args: literalArgs.map((a) => a.value),
            in: enclosingFunction(node),
            line: line(node),
          });
        }
        if (callee.object === undefined && callee.name === 'redirect') {
          const to = literalArgs[0];
          if (to !== undefined && to.value.startsWith('/')) {
            links.push({ kind: 'redirect', to: to.value, pattern: to.pattern, line: line(node) });
          }
        }
        if (
          callee.object === undefined &&
          callee.name === 'fetch' &&
          literalArgs[0] !== undefined
        ) {
          api.push({
            kind: 'fetch',
            url: literalArgs[0].value,
            pattern: literalArgs[0].pattern,
            line: line(node),
          });
        }
        if (
          callee.object !== undefined &&
          HTTP_CLIENT.test(callee.object) &&
          HTTP_METHODS.has(callee.name) &&
          literalArgs[0] !== undefined
        ) {
          api.push({
            kind: 'http-client',
            method: callee.name.toUpperCase(),
            url: literalArgs[0].value,
            pattern: literalArgs[0].pattern,
            line: line(node),
          });
        }
        if (FLAG_CALL.test(callee.name) && literalArgs[0] !== undefined) {
          flags.push({ name: literalArgs[0].value, line: line(node) });
        }
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      FLAG_OBJECT.test(node.expression.text)
    ) {
      flags.push({ name: node.name.text, line: line(node) });
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      FLAG_OBJECT.test(node.expression.text)
    ) {
      const key = staticText(node.argumentExpression);
      if (key !== null) flags.push({ name: key.value, line: line(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  const unique = <T>(items: T[], key: (t: T) => string) => {
    const seen = new Set<string>();
    return items.filter((item) => {
      const k = key(item);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  return {
    file,
    importSpecifiers,
    exports: [...exportsFound].sort(),
    selectors: unique(selectors, (s) => `${s.kind}|${s.value}|${String(s.line)}`),
    guards,
    links: unique(links, (l) => `${l.kind}|${l.to}|${String(l.line)}`),
    api,
    flags: unique(flags, (f) => `${f.name}|${String(f.line)}`),
  };
}
