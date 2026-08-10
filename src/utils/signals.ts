/*
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

import { TSESTree } from '@typescript-eslint/types';
import { ParserServices } from '@typescript-eslint/utils';
import { visitorKeys, getKeys } from '@typescript-eslint/visitor-keys';
import * as ts from 'typescript';

export type ClassLike = TSESTree.ClassDeclaration | TSESTree.ClassExpression;

export type SignalClassification = 'signal' | 'not-signal' | 'unknown';

type ConnectCallExpression = TSESTree.CallExpression & {
  callee: TSESTree.MemberExpression;
};

export type WalkAction = 'skip-children' | 'stop' | undefined;

/**
 * Iterative AST walk from `root`, visiting every node. The visitor may return
 * 'skip-children' to avoid descending into a node, or 'stop' to abort the
 * whole walk.
 */
export function walkFrom(
  root: TSESTree.Node,
  visit: (node: TSESTree.Node) => WalkAction
): void {
  const stack: TSESTree.Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const action = visit(node);
    if (action === 'stop') {
      return;
    }
    if (action === 'skip-children') {
      continue;
    }
    const keys = visitorKeys[node.type] ?? getKeys(node);
    for (const key of keys) {
      const child = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          if (isNode(item)) {
            stack.push(item);
          }
        }
      } else if (isNode(child)) {
        stack.push(child);
      }
    }
  }
}

function isNode(value: unknown): value is TSESTree.Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

/**
 * Checks if a call expression is a non-computed `<expr>.<name>(...)` call.
 */
function isMemberCallNamed(
  node: TSESTree.CallExpression,
  names: readonly string[]
): node is ConnectCallExpression {
  return (
    node.callee.type === 'MemberExpression' &&
    !node.callee.computed &&
    node.callee.property.type === 'Identifier' &&
    names.includes(node.callee.property.name)
  );
}

/**
 * Checks if a node represents `<expr>.connect(...)`.
 */
export function isConnectCall(
  node: TSESTree.CallExpression
): node is ConnectCallExpression {
  return isMemberCallNamed(node, ['connect']);
}

/**
 * Checks if a node represents `<expr>.disconnect(...)` or a call to one of
 * the additional cleanup method names.
 */
export function isDisconnectCall(
  node: TSESTree.CallExpression,
  extraMethodNames: readonly string[] = []
): boolean {
  return isMemberCallNamed(node, ['disconnect', ...extraMethodNames]);
}

/**
 * Checks if a node represents `<expr>.disposed.connect(...)` — disposal
 * cleanup wired through a `disposed`-style signal.
 */
export function isDisposedSignalWiring(node: TSESTree.CallExpression): boolean {
  if (!isConnectCall(node)) {
    return false;
  }
  const object = node.callee.object;
  return (
    object.type === 'MemberExpression' &&
    !object.computed &&
    object.property.type === 'Identifier' &&
    object.property.name === 'disposed'
  );
}

const SIGNAL_CLEANUP_STATICS = [
  'clearData',
  'disconnectAll',
  'disconnectReceiver',
  'disconnectSender',
  'disconnectBetween'
];

/**
 * Collects the names under which the Lumino `Signal` namespace is reachable in
 * this file. Always includes 'Signal' (ambient/global usage), plus local
 * aliases from `import { Signal as X } from '@lumino/signaling'` and the
 * qualified `ns.Signal` form of `import * as ns from '@lumino/signaling'`.
 */
export function collectSignalNamespaceLocalNames(
  program: TSESTree.Program
): Set<string> {
  const names = new Set(['Signal']);
  for (const statement of program.body) {
    if (
      statement.type === 'ImportDeclaration' &&
      statement.source.value === '@lumino/signaling'
    ) {
      for (const specifier of statement.specifiers) {
        if (
          specifier.type === 'ImportSpecifier' &&
          specifier.imported.type === 'Identifier' &&
          specifier.imported.name === 'Signal'
        ) {
          names.add(specifier.local.name);
        } else if (specifier.type === 'ImportNamespaceSpecifier') {
          names.add(`${specifier.local.name}.Signal`);
        }
      }
    }
  }
  return names;
}

/**
 * Dotted source name of an identifier or of a single-level `a.b` member
 * expression; null for anything deeper or computed.
 */
function qualifiedName(node: TSESTree.Node): string | null {
  if (node.type === 'Identifier') {
    return node.name;
  }
  if (
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.object.type === 'Identifier' &&
    node.property.type === 'Identifier'
  ) {
    return `${node.object.name}.${node.property.name}`;
  }
  return null;
}

/**
 * Checks if a node represents `Signal.clearData(...)` or one of the other
 * static disconnect helpers on the `Signal` namespace (under any local name).
 */
export function isSignalNamespaceCleanupCall(
  node: TSESTree.CallExpression,
  signalLocalNames: ReadonlySet<string>
): boolean {
  if (!isMemberCallNamed(node, SIGNAL_CLEANUP_STATICS)) {
    return false;
  }
  const name = qualifiedName(node.callee.object);
  return name !== null && signalLocalNames.has(name);
}

/**
 * Returns the innermost class enclosing `node`, or null if the node is not
 * inside a class body.
 */
export function getEnclosingClass(node: TSESTree.Node): ClassLike | null {
  let current = node.parent;
  while (current) {
    if (
      current.type === 'ClassDeclaration' ||
      current.type === 'ClassExpression'
    ) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

export type ThisBinding = 'instance' | 'constructor' | 'none';

/**
 * What does `this` denote at `node`?
 *
 * - `'instance'`: an instance of the enclosing class.
 * - `'constructor'`: the class object itself — `static` members and static
 *   blocks.
 * - `'none'`: neither, because `this` is rebound on the way up: a nested
 *   regular function, an object-literal method, or module scope. Whatever
 *   `this` is there, it is not decided by the enclosing class.
 *
 * Arrow functions are transparent. Regular functions are not, unless they are
 * the value of a class member — that is the method itself, not a nested one.
 */
export function getThisBinding(node: TSESTree.Node): ThisBinding {
  let current: TSESTree.Node | undefined = node.parent;
  while (current) {
    if (current.type === 'StaticBlock') {
      return 'constructor';
    }
    if (
      current.type === 'FunctionExpression' ||
      current.type === 'FunctionDeclaration' ||
      current.type === 'TSDeclareFunction'
    ) {
      const parent: TSESTree.Node | undefined = current.parent;
      const isClassMemberValue =
        (parent?.type === 'MethodDefinition' ||
          parent?.type === 'PropertyDefinition') &&
        parent.value === current;
      if (!isClassMemberValue) {
        return 'none';
      }
    }
    if (
      current.type === 'MethodDefinition' ||
      current.type === 'PropertyDefinition'
    ) {
      return current.static ? 'constructor' : 'instance';
    }
    if (
      current.type === 'ClassDeclaration' ||
      current.type === 'ClassExpression'
    ) {
      // Reached the class without crossing one of its members — a decorator or
      // a heritage expression, where `this` is not the instance.
      return 'none';
    }
    current = current.parent;
  }
  return 'none';
}

/**
 * Finds the class member named `name` in the class body, matching privacy
 * (`this.#name` vs `this.name`) and staticness. Names are compared without
 * the `#` prefix.
 */
export function resolveClassMember(
  classNode: ClassLike,
  name: string,
  opts: { isPrivate: boolean; isStatic: boolean }
): TSESTree.MethodDefinition | TSESTree.PropertyDefinition | null {
  for (const member of classNode.body.body) {
    if (
      member.type !== 'MethodDefinition' &&
      member.type !== 'PropertyDefinition'
    ) {
      continue;
    }
    if (member.static !== opts.isStatic || member.computed) {
      continue;
    }
    const key = member.key;
    if (opts.isPrivate) {
      if (key.type === 'PrivateIdentifier' && key.name === name) {
        return member;
      }
    } else if (
      (key.type === 'Identifier' && key.name === name) ||
      (key.type === 'Literal' && key.value === name)
    ) {
      return member;
    }
  }
  return null;
}

export interface UnboundThisMethodConnect {
  /** The `this.X` callback argument node. */
  arg: TSESTree.MemberExpression;
  /** Member name, without the `#` prefix. */
  name: string;
  isPrivate: boolean;
}

/**
 * Detects the "unbound method" connect shape: a single-argument
 * `signal.connect(this.X)` where `X` resolves in the enclosing class to a
 * regular method (or function-expression property) whose body actually uses
 * `this` — the case where the callback breaks at runtime without a thisArg.
 * Returns null for every other callback shape (arrow properties, methods not
 * using `this`, unresolved members, inline callbacks, free variables, ...).
 *
 * Shared by `require-signal-this-arg` (reports exactly this case) and
 * `prefer-signal-this-arg` (reports everything but this case), so the two
 * rules always partition cleanly.
 */
export function resolveUnboundThisMethodConnect(
  node: TSESTree.CallExpression
): UnboundThisMethodConnect | null {
  if (node.arguments.length !== 1) {
    return null;
  }
  const arg = node.arguments[0];
  if (
    arg.type !== 'MemberExpression' ||
    arg.object.type !== 'ThisExpression' ||
    arg.computed
  ) {
    return null;
  }
  const property = arg.property;
  if (property.type !== 'Identifier' && property.type !== 'PrivateIdentifier') {
    return null;
  }
  const isPrivate = property.type === 'PrivateIdentifier';
  const name = property.name;

  const enclosingClass = getEnclosingClass(node);
  if (!enclosingClass) {
    return null;
  }

  const thisBinding = getThisBinding(node);
  if (thisBinding === 'none') {
    // Inside a nested regular function `this` is not the enclosing class, so
    // `this.X` does not refer to a member of it and must not be resolved
    // against its body.
    return null;
  }

  const member = resolveClassMember(enclosingClass, name, {
    isPrivate,
    isStatic: thisBinding === 'constructor'
  });
  if (!member) {
    // Not found in this class (possibly inherited).
    return null;
  }

  let fn: TSESTree.FunctionExpression;
  if (member.type === 'PropertyDefinition') {
    if (!member.value || member.value.type !== 'FunctionExpression') {
      // Arrow-function properties are lexically bound and safe; other
      // values are not resolvable callbacks.
      return null;
    }
    fn = member.value;
  } else {
    if (member.kind !== 'method') {
      // Getters/setters are evaluated, not referenced.
      return null;
    }
    if (member.value.type !== 'FunctionExpression') {
      // Abstract or overload signature — no body to inspect.
      return null;
    }
    fn = member.value;
  }

  if (!methodUsesThis(fn)) {
    return null;
  }

  return { arg, name, isPrivate };
}

/**
 * Scans an entire class body for any evidence that signal connections are
 * cleaned up somewhere: `Signal.clearData(...)`-style static cleanup calls or
 * `.disconnect(...)` calls (or configured additional cleanup methods). Nested
 * classes are opaque — their cleanup does not count for the outer class.
 */
export function classHasCleanupEvidence(
  classNode: ClassLike,
  signalLocalNames: ReadonlySet<string>,
  extraMethodNames: readonly string[] = []
): boolean {
  let found = false;
  walkFrom(classNode.body, node => {
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      return 'skip-children';
    }
    if (node.type === 'CallExpression') {
      if (
        isSignalNamespaceCleanupCall(node, signalLocalNames) ||
        isDisconnectCall(node, extraMethodNames)
      ) {
        found = true;
        return 'stop';
      }
    }
    return undefined;
  });
  return found;
}

const RECEIVER_CLEANUP_STATICS = [
  'clearData',
  'disconnectReceiver',
  'disconnectAll'
];

/**
 * Scans a class body for cleanup calls that match connections **by
 * receiver**: `Signal.clearData(this)` / `Signal.disconnectReceiver(this)` /
 * `Signal.disconnectAll(this)` / `Signal.disconnectBetween(sender, this)`
 * (under any local `Signal` alias), or a two-argument
 * `.disconnect(callback, this)` call. A class using these relies on its
 * connections having been registered with `this` as the thisArg. Nested
 * classes are opaque.
 */
export function classUsesReceiverBasedCleanup(
  classNode: ClassLike,
  signalLocalNames: ReadonlySet<string>
): boolean {
  let found = false;
  walkFrom(classNode.body, node => {
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      return 'skip-children';
    }
    if (node.type === 'CallExpression') {
      const receiverIndex = isSignalNamespaceCleanupCall(node, signalLocalNames)
        ? isMemberCallNamed(node, RECEIVER_CLEANUP_STATICS)
          ? 0
          : isMemberCallNamed(node, ['disconnectBetween'])
            ? 1
            : -1
        : isDisconnectCall(node) && node.arguments.length === 2
          ? 1
          : -1;
      if (
        receiverIndex >= 0 &&
        node.arguments[receiverIndex]?.type === 'ThisExpression'
      ) {
        found = true;
        return 'stop';
      }
    }
    return undefined;
  });
  return found;
}

/**
 * Type-aware check: does this class (transitively) extend Lumino's `Widget`
 * (any class declared in `@lumino/widgets`)? Those base classes call
 * `Signal.clearData(this)` from `dispose()`, so subclasses rely on
 * receiver-based cleanup. Returns false when type information is
 * unavailable or resolution fails.
 */
export function classExtendsLuminoWidget(
  classNode: ClassLike,
  checker: ts.TypeChecker | null,
  services: ParserServices | null
): boolean {
  if (
    !classNode.superClass ||
    !checker ||
    !services ||
    !services.esTreeNodeToTSNodeMap
  ) {
    return false;
  }
  try {
    const tsNode = services.esTreeNodeToTSNodeMap.get(classNode);
    if (!tsNode) {
      return false;
    }
    return typeExtendsLuminoWidget(checker.getTypeAtLocation(tsNode), checker);
  } catch {
    // Fall through: treat resolution failures as "not a Widget".
    return false;
  }
}

/**
 * Type-aware check: does `type` (transitively) extend a class declared in
 * `@lumino/widgets`? Used both for "does the receiver class inherit
 * `Widget.dispose()`'s `Signal.clearData(this)`" and for rejecting widget-typed
 * hops when walking a sender expression (a widget reached through a long-lived
 * service is not itself long-lived).
 */
export function typeExtendsLuminoWidget(
  type: ts.Type,
  checker: ts.TypeChecker
): boolean {
  const seen = new Set<ts.Type>();
  const queue: ts.Type[] = [type];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    if (current.isUnion() || current.isIntersection()) {
      queue.push(...current.types);
      continue;
    }
    const symbol = current.getSymbol();
    if (symbol && isDeclaredInLuminoPackage(symbol, 'widgets')) {
      return true;
    }
    const objectFlags = (current as ts.ObjectType).objectFlags ?? 0;
    if (objectFlags & ts.ObjectFlags.Reference) {
      // `class StaticNotebook extends WindowedList<NotebookViewModel>` gives a
      // type *reference*, which is not `isClassOrInterface()`. Descend into
      // the generic target so the base chain stays walkable.
      const target = (current as ts.TypeReference).target;
      if (target && target !== current) {
        queue.push(target);
      }
    }
    if (current.isClassOrInterface()) {
      try {
        queue.push(...checker.getBaseTypes(current));
      } catch {
        // Unresolvable base list — stop descending this branch.
      }
    }
  }
  return false;
}

/**
 * Checks whether a function body references `this` in its own binding.
 * Descends into arrow functions (lexically transparent) but not into nested
 * regular functions, static blocks, or nested classes (own `this` binding).
 */
export function methodUsesThis(fn: TSESTree.FunctionExpression): boolean {
  let found = false;
  walkFrom(fn.body, node => {
    if (
      node.type === 'FunctionExpression' ||
      node.type === 'FunctionDeclaration' ||
      node.type === 'TSDeclareFunction' ||
      node.type === 'StaticBlock' ||
      node.type === 'ClassDeclaration' ||
      node.type === 'ClassExpression'
    ) {
      return 'skip-children';
    }
    if (node.type === 'ThisExpression') {
      found = true;
      return 'stop';
    }
    return undefined;
  });
  return found;
}

/**
 * Syntactic hint that an expression is likely a Lumino signal, based on
 * conventional signal naming (`stateChanged`, `disposed`, `somethingSignal`).
 */
export function looksLikeSignalByName(
  objectNode: TSESTree.Expression
): boolean {
  let name: string | null = null;
  if (objectNode.type === 'Identifier') {
    name = objectNode.name;
  } else if (
    objectNode.type === 'MemberExpression' &&
    !objectNode.computed &&
    objectNode.property.type === 'Identifier'
  ) {
    name = objectNode.property.name;
  }
  return name !== null && /(signal|changed|disposed)$/i.test(name);
}

/**
 * Classifies the static type of a `.connect()` receiver expression:
 * - 'signal': resolves to Lumino `ISignal`/`Signal` (by symbol name or a
 *   declaration living in `@lumino/signaling`)
 * - 'not-signal': resolves to some other concrete type
 * - 'unknown': no type information, `any`/`unknown`, or resolution failure
 */
export function classifySignalReceiver(
  objectNode: TSESTree.Expression,
  checker: ts.TypeChecker | null,
  services: ParserServices | null
): SignalClassification {
  if (!checker || !services || !services.esTreeNodeToTSNodeMap) {
    return 'unknown';
  }
  try {
    const tsNode = services.esTreeNodeToTSNodeMap.get(objectNode);
    if (!tsNode) {
      return 'unknown';
    }
    return classifyTsType(checker.getTypeAtLocation(tsNode), checker);
  } catch {
    return 'unknown';
  }
}

function classifyTsType(
  type: ts.Type,
  checker: ts.TypeChecker
): SignalClassification {
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
    return 'unknown';
  }
  if (type.isUnion()) {
    const results = type.types
      .filter(t => !(t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)))
      .map(t => classifyTsType(t, checker));
    if (results.includes('signal')) {
      return 'signal';
    }
    if (results.length > 0 && results.every(r => r === 'not-signal')) {
      return 'not-signal';
    }
    return 'unknown';
  }
  const rawSymbol = type.aliasSymbol ?? type.getSymbol();
  if (!rawSymbol) {
    return 'unknown';
  }
  // Follow import/re-export aliases so we classify the original declaration.
  let symbol = rawSymbol;
  if (rawSymbol.flags & ts.SymbolFlags.Alias) {
    try {
      symbol = checker.getAliasedSymbol(rawSymbol);
    } catch {
      symbol = rawSymbol;
    }
  }
  const name = symbol.getName();
  if (name === 'ISignal' || name === 'Signal') {
    // Unrelated libraries also export types named Signal; require either a
    // @lumino/signaling declaration or the Lumino signal surface
    // (connect + disconnect members) before classifying as a signal.
    if (
      isDeclaredInLuminoPackage(symbol, 'signaling') ||
      (type.getProperty('connect') !== undefined &&
        type.getProperty('disconnect') !== undefined)
    ) {
      return 'signal';
    }
    return 'not-signal';
  }
  if (isDeclaredInLuminoPackage(symbol, 'signaling')) {
    return 'signal';
  }
  return 'not-signal';
}

function isDeclaredInLuminoPackage(
  symbol: ts.Symbol,
  packageName: string
): boolean {
  for (const declaration of symbol.getDeclarations() ?? []) {
    const fileName = declaration.getSourceFile().fileName;
    if (
      fileName.includes(`lumino/${packageName}`) ||
      fileName.includes(`lumino\\${packageName}`)
    ) {
      return true;
    }
  }
  return false;
}
