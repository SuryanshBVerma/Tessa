// Reads an Angular component template (inline or templateUrl) for selectors, links and the
// permission checks that decide what is shown. A small tolerant scanner, not Angular's compiler:
// nothing is executed, bindings are parsed as TypeScript expressions, and dynamic parts become "*".
import ts from 'typescript';
import type { Guard, Link, Selector } from '../types.js';

/** Calls that look like permission checks, on any object: auth.can('x'), perms.hasRole('admin'). */
export const TEMPLATE_GUARD_CALL =
  /^(can|cannot|hasPermission|hasAnyPermission|hasRole|hasAnyRole|isAllowed|isGranted|authorize|(require|check)[A-Z]\w*)$/;
/** Custom structural directives that gate content on a permission: *appHasRole, *ifPermission. */
const GUARD_DIRECTIVE = /(role|permission|perm|can|allow|grant|auth)/i;

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);
const TEXT_ELEMENTS = new Set([
  'button',
  'a',
  'h1',
  'h2',
  'h3',
  'legend',
  'th',
  'summary',
  'option',
  'mat-option',
]);
const LABEL_ELEMENTS = new Set(['label', 'mat-label']);
/** Icon fonts render a ligature name ("add", "delete") that is not part of the accessible text. */
const ICON_ELEMENTS = new Set(['mat-icon', 'i', 'svg', 'fa-icon']);

interface Attribute {
  name: string;
  value: string | null;
  offset: number;
}

interface OpenElement {
  tag: string;
  offset: number;
  text: string;
}

export interface TemplateFindings {
  selectors: Selector[];
  links: Link[];
  guards: Guard[];
}

function parseExpression(text: string): ts.Expression | null {
  // Angular-only syntax TypeScript cannot read: "; else tpl", "as x", "let x".
  const cleaned = text.split(';')[0]?.trim() ?? '';
  if (cleaned === '') return null;
  const sf = ts.createSourceFile('t.ts', `(${cleaned});`, ts.ScriptTarget.Latest, true);
  const statement = sf.statements[0];
  if (statement === undefined || !ts.isExpressionStatement(statement)) return null;
  let expression = statement.expression;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  return expression;
}

/** The text a binding produces: literals as they are, anything dynamic as "*". */
function expressionText(node: ts.Expression): { value: string; pattern: boolean } | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { value: node.text, pattern: false };
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) value += `*${span.literal.text}`;
    return { value, pattern: true };
  }
  if (ts.isParenthesizedExpression(node)) return expressionText(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = expressionText(node.left) ?? { value: '*', pattern: true };
    const right = expressionText(node.right) ?? { value: '*', pattern: true };
    const value = `${left.value}${right.value}`.replace(/\*+/g, '*');
    return value === '*' ? null : { value, pattern: left.pattern || right.pattern };
  }
  return null;
}

/** routerLink targets: "/a", "'/a'", "['/tickets', id]" -> "/tickets/*". */
function linkTarget(raw: string, bound: boolean): { value: string; pattern: boolean } | null {
  if (!bound) return { value: raw.trim(), pattern: false };
  const expression = parseExpression(raw);
  if (expression === null) return null;
  if (ts.isArrayLiteralExpression(expression)) {
    let pattern = false;
    const parts = expression.elements.map((element) => {
      const text = expressionText(element);
      if (text === null) {
        pattern = true;
        return '*';
      }
      pattern ||= text.pattern;
      return text.value.replace(/^\/+|\/+$/g, '');
    });
    const first = expression.elements[0];
    const absolute =
      first !== undefined &&
      (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) &&
      first.text.startsWith('/');
    return { value: `${absolute ? '/' : ''}${parts.filter(Boolean).join('/')}`, pattern };
  }
  return expressionText(expression);
}

/** String literals anywhere in an expression, e.g. the roles in hasAnyRole(['a', 'b']). */
function stringArgs(nodes: readonly ts.Node[]): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) found.push(node.text);
    ts.forEachChild(node, visit);
  };
  nodes.forEach(visit);
  return found;
}

/** Permission-check calls in a binding or control-flow condition. */
function guardCalls(raw: string): { call: string; args: string[] }[] {
  const expression = parseExpression(raw);
  if (expression === null) return [];
  const calls: { call: string; args: string[] }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      if (name !== null && TEMPLATE_GUARD_CALL.test(name)) {
        calls.push({ call: name, args: stringArgs(node.arguments) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(expression);
  return calls;
}

/** Visible static text, without interpolations, control flow or entities. */
function visibleText(text: string): string | null {
  // Text built from data or translation pipes is not a stable selector.
  if (text.includes('{{')) return null;
  const clean = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return clean === '' ? null : clean;
}

function parseAttributes(source: string, start: number, end: number): Attribute[] {
  const attributes: Attribute[] = [];
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  pattern.lastIndex = start;
  const region = source.slice(0, end);
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(region)) !== null && match.index < end) {
    attributes.push({
      name: match[1] ?? '',
      value: match[2] ?? match[3] ?? match[4] ?? null,
      offset: match.index,
    });
  }
  return attributes;
}

/** Finds the end of a start tag, skipping quoted attribute values that may contain ">". */
function tagEnd(source: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < source.length; i++) {
    const c = source[i];
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    }
  }
  return -1;
}

export function scanTemplate(source: string, firstLine = 1): TemplateFindings {
  const selectors: Selector[] = [];
  const links: Link[] = [];
  const guards: Guard[] = [];
  const lineAt = (offset: number) =>
    firstLine + (source.slice(0, offset).match(/\n/g)?.length ?? 0);

  const addSelector = (
    kind: Selector['kind'],
    text: { value: string; pattern: boolean } | null,
    element: string,
    offset: number,
  ) => {
    if (text === null || text.value.trim() === '' || text.value.trim() === '*') return;
    selectors.push({
      kind,
      value: text.value.trim(),
      pattern: text.pattern,
      element,
      line: lineAt(offset),
    });
  };
  const addGuards = (raw: string, offset: number) => {
    for (const g of guardCalls(raw)) {
      guards.push({ call: g.call, args: g.args, in: 'template', line: lineAt(offset) });
    }
  };

  const stack: OpenElement[] = [];
  const closeElement = (element: OpenElement) => {
    const text = visibleText(element.text);
    if (text === null) return;
    if (LABEL_ELEMENTS.has(element.tag)) {
      addSelector('label', { value: text, pattern: false }, element.tag, element.offset);
    } else if (TEXT_ELEMENTS.has(element.tag)) {
      addSelector('text', { value: text, pattern: false }, element.tag, element.offset);
    }
  };
  const addText = (text: string, offset: number) => {
    // Control flow: @if (cond) {, } @else if (cond) {, @for (...) {, @switch, and closing braces.
    const control = /@(if|else if)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = control.exec(text)) !== null) {
      let depth = 1;
      let i = m.index + m[0].length;
      for (; i < text.length && depth > 0; i++) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')') depth--;
      }
      addGuards(text.slice(m.index + m[0].length, i - 1), offset + m.index);
    }
    const plain = text
      .replace(
        /@(if|else if|for|switch|case|defer|placeholder|loading|empty)\s*(\([^{]*\))?\s*\{/g,
        ' ',
      )
      .replace(/@(else|default|empty)\s*\{/g, ' ')
      .replace(/[{}]/g, (c, i: number, all: string) =>
        all[i - 1] === c || all[i + 1] === c ? c : ' ',
      );
    if (stack.some((element) => ICON_ELEMENTS.has(element.tag))) return;
    for (const element of stack) element.text += plain;
  };

  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      addText(source.slice(i), i);
      break;
    }
    if (lt > i) addText(source.slice(i, lt), i);
    if (source.startsWith('<!--', lt)) {
      const close = source.indexOf('-->', lt + 4);
      i = close === -1 ? source.length : close + 3;
      continue;
    }
    if (source[lt + 1] === '/') {
      const close = source.indexOf('>', lt);
      const tag = source
        .slice(lt + 2, close === -1 ? undefined : close)
        .trim()
        .toLowerCase();
      // Pop to the matching element; tolerate unclosed children.
      const at = stack.map((e) => e.tag).lastIndexOf(tag);
      if (at !== -1) {
        for (const element of stack.splice(at).reverse()) closeElement(element);
      }
      i = close === -1 ? source.length : close + 1;
      continue;
    }
    const nameMatch = /^<([a-zA-Z][\w:.-]*)/.exec(source.slice(lt, lt + 80));
    if (nameMatch === null) {
      addText('<', lt);
      i = lt + 1;
      continue;
    }
    const tag = (nameMatch[1] ?? '').toLowerCase();
    const end = tagEnd(source, lt + nameMatch[0].length);
    if (end === -1) break;
    const attributes = parseAttributes(source, lt + nameMatch[0].length, end);
    const selfClosing = source[end - 1] === '/';

    for (const attr of attributes) {
      const name = attr.name;
      const value = attr.value;
      if (value === null) continue;
      const bound = name.startsWith('[') && name.endsWith(']');
      const plainName = bound ? name.slice(1, -1).replace(/^attr\./, '') : name;
      const read = () =>
        bound
          ? (() => {
              const expression = parseExpression(value);
              return expression === null ? null : expressionText(expression);
            })()
          : { value, pattern: false };

      if (plainName === 'data-testid') addSelector('testid', read(), tag, attr.offset);
      else if (plainName === 'role') addSelector('role', read(), tag, attr.offset);
      else if (plainName === 'aria-label') addSelector('aria-label', read(), tag, attr.offset);
      else if (plainName === 'placeholder') addSelector('placeholder', read(), tag, attr.offset);
      else if (plainName === 'routerLink' || plainName === 'routerlink') {
        const to = linkTarget(value, bound);
        if (to !== null && to.value.startsWith('/')) {
          links.push({
            kind: 'link',
            to: to.value,
            pattern: to.pattern,
            line: lineAt(attr.offset),
          });
        }
      } else if (plainName === 'href' && tag === 'a' && !bound && value.startsWith('/')) {
        links.push({ kind: 'link', to: value, pattern: false, line: lineAt(attr.offset) });
      }

      if (name === '*ngIf' || bound) {
        addGuards(value, attr.offset);
      } else if (name.startsWith('*') && GUARD_DIRECTIVE.test(name)) {
        // A custom structural directive such as *appHasRole="'admin'".
        const expression = parseExpression(value);
        guards.push({
          call: name.slice(1),
          args: expression === null ? [] : stringArgs([expression]),
          in: 'template',
          line: lineAt(attr.offset),
        });
      }
    }

    if (!selfClosing && !VOID_ELEMENTS.has(tag)) {
      stack.push({ tag, offset: lt, text: '' });
    }
    i = end + 1;
  }
  for (const element of stack.reverse()) closeElement(element);

  return { selectors, links, guards };
}
