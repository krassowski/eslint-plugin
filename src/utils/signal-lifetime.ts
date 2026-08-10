/*
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

import { TSESTree } from '@typescript-eslint/types';
import { ASTUtils, ParserServices, TSESLint } from '@typescript-eslint/utils';
import * as ts from 'typescript';
import {
  ClassLike,
  classExtendsLuminoWidget,
  isSignalNamespaceCleanupCall,
  typeExtendsLuminoWidget,
  walkFrom
} from './signals';

/**
 * A Lumino connection leaks if and only if the **sender outlives the
 * receiver**. Connections are stored in `WeakMap`s keyed by both sender and
 * receiver, so a sender+receiver island that becomes unreachable together is
 * collected whether or not a `thisArg` was passed.
 *
 * The helpers in this module therefore classify the *sender* rather than
 * looking for absent cleanup on the receiver. Everything defaults to
 * `'unknown'` — the rules only report senders that are positively proven to
 * outlive their receiver.
 */
export type SenderLifetime =
  /** The sender is the enclosing instance itself (or something it intrinsically owns). */
  | 'self'
  /** The enclosing class constructs, adopts, or disposes the sender. */
  | 'owned'
  /** A model/context in an MVC pair whose view is the enclosing class. */
  | 'long-lived-model'
  /** An injected application service from the configured allowlist. */
  | 'long-lived-service'
  /** Not provably anything — never reported. */
  | 'unknown';

/**
 * Application-lifetime service types. A connection to a signal owned by one of
 * these outlives any per-document or per-widget receiver.
 *
 * Deliberately short and curated. Notably absent: `DocumentRegistry.Context`
 * and `JupyterFrontEnd` — both are routinely *shorter*-lived than the objects
 * that hold them, and including them re-introduces false positives.
 */
export const DEFAULT_LONG_LIVED_TYPES: readonly string[] = [
  'CommandRegistry',
  'IDebugger',
  'IDocumentManager',
  'ILSPConnection',
  'ILabShell',
  'ILanguageServerManager',
  'IRenderMimeRegistry',
  'ISettingRegistry',
  'IShell',
  'IStateDB',
  'IThemeManager',
  'ServiceManager'
];

/**
 * JupyterLab's MVC convention: `Foo`/`FooModel` pairs where the model is
 * created by the document/context and the view is disposed independently
 * (notebook windowing, "New View for Notebook", output area recycling).
 */
const MODEL_SEGMENT = /^_?(model|sharedModel|context)$/;
const MODEL_TYPE_NAME = /(Model|Context)$|^ISharedDocument$/;

/** Properties a Lumino `Widget` intrinsically owns and disposes. */
const WIDGET_INTRINSICS = new Set(['title']);

/** Members that adopt a widget into a parent that will dispose it. */
const ADOPTION_METHODS = new Set([
  'addWidget',
  'insertWidget',
  'addItem',
  'insertItem'
]);

/** Method names that read as "construct a fresh object I now own". */
const FACTORY_METHOD = /^create([A-Z]|$)/;

export interface SenderChain {
  /** The expression owning the signal — `a.b` in `a.b.changed.connect(...)`. */
  sender: TSESTree.Expression;
  /** Sub-expressions from the root outward, ending with `sender`. */
  prefixes: TSESTree.Expression[];
  /** Base of the chain, or null when it is not a plain object path. */
  root: TSESTree.ThisExpression | TSESTree.Identifier | null;
  /** Property names from the root to the sender; null for computed access. */
  path: (string | null)[];
  /** True when a call appears in the chain — not a stable object path. */
  hasCall: boolean;
  /** The signal's own property name (`changed`), when statically known. */
  signalName: string | null;
}

/** Strips wrappers that do not change the runtime value of an expression. */
function unwrap(node: TSESTree.Node): TSESTree.Node {
  let current = node;
  for (;;) {
    switch (current.type) {
      case 'ChainExpression':
      case 'TSNonNullExpression':
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSTypeAssertion':
      case 'TSInstantiationExpression':
        current = current.expression;
        break;
      default:
        return current;
    }
  }
}

function propertyName(node: TSESTree.Node): string | null {
  if (node.type === 'Identifier' || node.type === 'PrivateIdentifier') {
    return node.name;
  }
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }
  return null;
}

/**
 * Splits the receiver of a `.connect()` call into the signal name and the
 * object path that owns it. Returns null when the receiver is not a
 * `<object>.<signal>` member expression (a bare `signal.connect(cb)` on a
 * local has no identifiable sender).
 */
export function buildSenderChain(
  signalExpr: TSESTree.Expression
): SenderChain | null {
  const signal = unwrap(signalExpr);
  if (signal.type !== 'MemberExpression') {
    return null;
  }
  // Computed access is fine — `connection.serverNotifications['window/logMessage']`
  // still identifies `connection.serverNotifications` as the sender. Only the
  // signal's own name is unknown.
  const signalName = signal.computed ? null : propertyName(signal.property);

  const prefixes: TSESTree.Expression[] = [];
  const path: (string | null)[] = [];
  let hasCall = false;
  let root: TSESTree.ThisExpression | TSESTree.Identifier | null = null;

  let current = unwrap(signal.object);
  for (;;) {
    prefixes.push(current as TSESTree.Expression);
    if (current.type === 'MemberExpression') {
      path.push(current.computed ? null : propertyName(current.property));
      current = unwrap(current.object);
      continue;
    }
    if (current.type === 'ThisExpression' || current.type === 'Identifier') {
      root = current;
    } else if (
      current.type === 'CallExpression' ||
      current.type === 'NewExpression'
    ) {
      hasCall = true;
    }
    break;
  }

  prefixes.reverse();
  path.reverse();
  return {
    sender: unwrap(signal.object) as TSESTree.Expression,
    prefixes,
    root,
    path,
    hasCall,
    signalName
  };
}

/** Whitespace/assertion-insensitive source text, for path comparisons. */
function normalizeText(
  sourceCode: Readonly<TSESLint.SourceCode>,
  node: TSESTree.Node
): string {
  return sourceCode
    .getText(node)
    .replace(/\s+/g, '')
    .replace(/!/g, '')
    .replace(/\?\./g, '.');
}

/**
 * Does this initializer expression read as "a fresh object this scope now
 * owns"? Covers `new X()`, factory calls, and the `??`/ternary/nested-assignment
 * wrappers JupyterLab writes them in — notably
 * `const output = (this._output = new OutputArea({...}))`.
 */
function isOwningInitializer(node: TSESTree.Node | null | undefined): boolean {
  if (!node) {
    return false;
  }
  const value = unwrap(node);
  switch (value.type) {
    case 'NewExpression':
      return true;
    case 'AwaitExpression':
      return isOwningInitializer(value.argument);
    case 'AssignmentExpression':
      return isOwningInitializer(value.right);
    case 'LogicalExpression':
      return (
        isOwningInitializer(value.left) || isOwningInitializer(value.right)
      );
    case 'ConditionalExpression':
      return (
        isOwningInitializer(value.consequent) ||
        isOwningInitializer(value.alternate)
      );
    case 'CallExpression': {
      const callee = unwrap(value.callee);
      if (callee.type === 'MemberExpression' && !callee.computed) {
        const name = propertyName(callee.property);
        return name !== null && FACTORY_METHOD.test(name);
      }
      return false;
    }
    default:
      return false;
  }
}

/**
 * Per-class facts about member fields, gathered in one pass over the class
 * body. Nested classes are opaque.
 */
/**
 * One expression the class tears down sender-side. The node is kept alongside
 * its text because names are not unique across scopes: `@jupyterlab/outputarea`
 * has an `output` that is an `IOutputModel` in one loop and an adopted `Widget`
 * in another method, and matching on text alone conflates them.
 */
export interface TeardownRecord {
  text: string;
  node: TSESTree.Node;
}

export interface ClassOwnershipFacts {
  /** Field names (without `#`) the class constructs, adopts, or disposes. */
  ownedFields: Set<string>;
  /**
   * Expressions the class tears down sender-side: `x.dispose()`,
   * `Signal.clearData(x)`, `Signal.disconnectSender(x)`, `parent.addWidget(x)`.
   */
  torndownSenders: TeardownRecord[];
  /** Getter name → the field it forwards to, for `get editor() { return this._editor; }`. */
  getterAliases: Map<string, string>;
}

const SENDER_CLEANUP_STATICS = new Set([
  'clearData',
  'disconnectAll',
  'disconnectSender'
]);

/**
 * Collects, for one class body, which fields it owns and which senders it
 * tears down. Both are *suppression* evidence: any hit means a connection to
 * that sender cannot outlive the receiver, so nothing is reported.
 */
export function collectClassOwnershipFacts(
  classNode: ClassLike,
  sourceCode: Readonly<TSESLint.SourceCode>,
  signalLocalNames: ReadonlySet<string>
): ClassOwnershipFacts {
  const ownedFields = new Set<string>();
  const torndownSenders: TeardownRecord[] = [];
  const getterAliases = new Map<string, string>();

  const noteOwnedTarget = (node: TSESTree.Node): void => {
    const target = unwrap(node);
    if (
      target.type === 'MemberExpression' &&
      target.object.type === 'ThisExpression' &&
      !target.computed
    ) {
      const name = propertyName(target.property);
      if (name !== null) {
        ownedFields.add(name);
      }
    }
  };

  for (const member of classNode.body.body) {
    if (
      member.type === 'PropertyDefinition' &&
      !member.static &&
      isOwningInitializer(member.value)
    ) {
      const name = propertyName(member.key);
      if (name !== null) {
        ownedFields.add(name);
      }
    }
    if (
      member.type === 'MethodDefinition' &&
      member.kind === 'get' &&
      member.value.body
    ) {
      const body = member.value.body.body;
      const name = propertyName(member.key);
      if (
        name !== null &&
        body.length === 1 &&
        body[0].type === 'ReturnStatement'
      ) {
        const returned = unwrap(body[0].argument ?? member.value);
        if (
          returned.type === 'MemberExpression' &&
          returned.object.type === 'ThisExpression' &&
          !returned.computed
        ) {
          const field = propertyName(returned.property);
          if (field !== null && field !== name) {
            getterAliases.set(name, field);
          }
        }
      }
    }
  }

  walkFrom(classNode.body, node => {
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      return 'skip-children';
    }
    if (
      node.type === 'AssignmentExpression' &&
      isOwningInitializer(node.right)
    ) {
      noteOwnedTarget(node.left);
      return undefined;
    }
    if (node.type !== 'CallExpression') {
      return undefined;
    }
    const callee = unwrap(node.callee);
    if (callee.type !== 'MemberExpression' || callee.computed) {
      return undefined;
    }
    const method = propertyName(callee.property);
    if (method === null) {
      return undefined;
    }

    // `x.dispose()` — the class tears the sender down itself.
    if (method === 'dispose' && node.arguments.length === 0) {
      noteOwnedTarget(callee.object);
      torndownSenders.push({
        text: normalizeText(sourceCode, callee.object),
        node: callee.object
      });
      return undefined;
    }

    // `this.addWidget(x)` / `layout.insertWidget(i, x)` — adopted by a parent
    // that will dispose it.
    if (ADOPTION_METHODS.has(method)) {
      for (const argument of node.arguments) {
        noteOwnedTarget(argument);
        torndownSenders.push({
          text: normalizeText(sourceCode, argument),
          node: argument
        });
      }
      return undefined;
    }

    // `Signal.clearData(x)` and friends, for any sender that is not `this`
    // (clearing by receiver says nothing about the sender's lifetime).
    if (
      isSignalNamespaceCleanupCall(node, signalLocalNames) &&
      SENDER_CLEANUP_STATICS.has(method)
    ) {
      const target = node.arguments[0];
      if (
        target &&
        target.type !== 'ThisExpression' &&
        target.type !== 'SpreadElement'
      ) {
        noteOwnedTarget(target);
        torndownSenders.push({
          text: normalizeText(sourceCode, target),
          node: target
        });
      }
    }
    return undefined;
  });

  return { ownedFields, torndownSenders, getterAliases };
}

/**
 * Does this class have somewhere to put a disconnect at all — a `dispose()`
 * method, an `isDisposed` member, or an `implements ...Disposable` clause?
 *
 * A class with no teardown protocol whatsoever is almost always a plugin-scope
 * singleton (`MermaidManager`, `ThemeManager`, `LayoutRestorer`): it is created
 * once in an `activate()` and lives as long as the services it connects to, so
 * the connection never leaks and there is no `dispose()` in which to write the
 * fix. It is indistinguishable, from inside the file, from a genuinely
 * short-lived class that forgot to implement disposal — so both stay silent.
 */
export function classHasDisposalProtocol(classNode: ClassLike): boolean {
  for (const clause of classNode.implements ?? []) {
    const expression = clause.expression;
    const name =
      expression.type === 'Identifier'
        ? expression.name
        : expression.type === 'MemberExpression' && !expression.computed
          ? propertyName(expression.property)
          : null;
    if (name && /Disposable$/.test(name)) {
      return true;
    }
  }
  for (const member of classNode.body.body) {
    if (
      (member.type === 'MethodDefinition' ||
        member.type === 'PropertyDefinition') &&
      !member.static
    ) {
      const name = propertyName(member.key);
      if (name === 'dispose' || name === 'isDisposed') {
        return true;
      }
    }
  }
  return false;
}

export interface LifetimeContext {
  classNode: ClassLike;
  facts: ClassOwnershipFacts;
  sourceCode: Readonly<TSESLint.SourceCode>;
  scope: TSESLint.Scope.Scope;
  checker: ts.TypeChecker | null;
  services: ParserServices | null;
  longLivedTypes: ReadonlySet<string>;
}

/** Resolves the symbol name of an expression's static type, if available. */
function typeNameOf(
  node: TSESTree.Node,
  context: LifetimeContext
): string | null {
  const { checker, services } = context;
  if (!checker || !services || !services.esTreeNodeToTSNodeMap) {
    return null;
  }
  try {
    const tsNode = services.esTreeNodeToTSNodeMap.get(node);
    if (!tsNode) {
      return null;
    }
    let type = checker.getTypeAtLocation(tsNode);
    if (type.isUnion()) {
      const candidates = type.types.filter(
        t => !(t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined))
      );
      if (candidates.length !== 1) {
        return null;
      }
      type = candidates[0];
    }
    let symbol = type.aliasSymbol ?? type.getSymbol();
    if (!symbol) {
      return null;
    }
    if (symbol.flags & ts.SymbolFlags.Alias) {
      try {
        symbol = checker.getAliasedSymbol(symbol);
      } catch {
        // Keep the un-aliased symbol.
      }
    }
    return symbol.getName();
  } catch {
    return null;
  }
}

function isWidgetTyped(node: TSESTree.Node, context: LifetimeContext): boolean {
  const { checker, services } = context;
  if (!checker || !services || !services.esTreeNodeToTSNodeMap) {
    return false;
  }
  try {
    const tsNode = services.esTreeNodeToTSNodeMap.get(node);
    if (!tsNode) {
      return false;
    }
    return typeExtendsLuminoWidget(checker.getTypeAtLocation(tsNode), checker);
  } catch {
    return false;
  }
}

/** Resolves a `this.<field>` name through single-expression getters. */
function resolveFieldName(name: string, facts: ClassOwnershipFacts): string {
  const seen = new Set<string>();
  let current = name;
  while (facts.getterAliases.has(current) && !seen.has(current)) {
    seen.add(current);
    current = facts.getterAliases.get(current)!;
  }
  return current;
}

/**
 * Index of the deepest prefix in the chain that the enclosing scope provably
 * owns — constructs, adopts, or disposes — or -1 when nothing in the chain is
 * owned.
 *
 * Ownership is a property of one object in the path, not of the whole path.
 * `const input = (this._input = new InputArea(...))` makes the class the owner
 * of `input`, but `input.model` is a cell model owned by the *notebook* model
 * and outlives every view built on it. Recording the depth is what lets
 * `analyzeSender` tell those two apart.
 */
function ownedPrefixDepth(
  chain: SenderChain,
  context: LifetimeContext
): number {
  let depth = -1;
  const root = chain.root;
  if (root?.type === 'ThisExpression') {
    const first = chain.path[0];
    if (
      first !== null &&
      first !== undefined &&
      context.facts.ownedFields.has(resolveFieldName(first, context.facts))
    ) {
      // prefixes[0] is `this`; prefixes[1] is `this.<first>`.
      depth = 1;
    }
  } else if (
    root?.type === 'Identifier' &&
    identifierIsOwned(root, context, new Set())
  ) {
    depth = 0;
  }
  for (let i = 0; i < chain.prefixes.length; i++) {
    if (isTornDown(chain.prefixes[i], context)) {
      depth = Math.max(depth, i);
    }
  }
  return depth;
}

/** The `this`/identifier at the base of an expression, if it has one. */
function expressionRoot(
  node: TSESTree.Node
): TSESTree.ThisExpression | TSESTree.Identifier | null {
  let current = unwrap(node);
  while (current.type === 'MemberExpression') {
    current = unwrap(current.object);
  }
  return current.type === 'ThisExpression' || current.type === 'Identifier'
    ? current
    : null;
}

/**
 * Measure D: does the class tear this exact expression down? Texts must match
 * *and*, for identifier-rooted expressions, both roots must resolve to the same
 * variable — the same name in two methods is routinely two different objects.
 */
function isTornDown(
  expression: TSESTree.Expression,
  context: LifetimeContext
): boolean {
  const text = normalizeText(context.sourceCode, expression);
  const root = expressionRoot(expression);
  for (const record of context.facts.torndownSenders) {
    if (record.text !== text) {
      continue;
    }
    const recordRoot = expressionRoot(record.node);
    if (
      root?.type === 'ThisExpression' &&
      recordRoot?.type === 'ThisExpression'
    ) {
      // Fields are class-scoped: same text, same object.
      return true;
    }
    if (root?.type !== 'Identifier' || recordRoot?.type !== 'Identifier') {
      continue;
    }
    const a = ASTUtils.findVariable(context.sourceCode.getScope(root), root);
    const b = ASTUtils.findVariable(
      context.sourceCode.getScope(recordRoot),
      recordRoot
    );
    if (a !== null && a === b) {
      return true;
    }
  }
  return false;
}

function identifierIsOwned(
  identifier: TSESTree.Identifier,
  context: LifetimeContext,
  seen: Set<string>
): boolean {
  if (seen.has(identifier.name)) {
    return false;
  }
  seen.add(identifier.name);

  const variable = ASTUtils.findVariable(context.scope, identifier);
  if (!variable || variable.defs.length === 0) {
    return false;
  }
  for (const def of variable.defs) {
    if (def.type !== TSESLint.Scope.DefinitionType.Variable) {
      // Parameters, imports and class names carry no ownership evidence.
      continue;
    }
    const init = def.node.init;
    if (isOwningInitializer(init)) {
      return true;
    }
    if (!init) {
      continue;
    }
    // `const input = this._input;` / `const cell = other.child;` — follow the
    // alias one step so ownership of the underlying field is still seen.
    const aliasChain = buildAliasChain(init);
    if (!aliasChain) {
      continue;
    }
    if (aliasChain.root?.type === 'ThisExpression') {
      const first = aliasChain.path[0];
      if (
        first &&
        context.facts.ownedFields.has(resolveFieldName(first, context.facts))
      ) {
        return true;
      }
    } else if (
      aliasChain.root?.type === 'Identifier' &&
      identifierIsOwned(aliasChain.root, context, seen)
    ) {
      return true;
    }
  }
  return false;
}

/** Like `buildSenderChain`, but for a whole expression rather than a signal. */
function buildAliasChain(
  expression: TSESTree.Node
): Pick<SenderChain, 'root' | 'path'> | null {
  const path: (string | null)[] = [];
  let current = unwrap(expression);
  for (;;) {
    if (current.type === 'MemberExpression') {
      path.push(current.computed ? null : propertyName(current.property));
      current = unwrap(current.object);
      continue;
    }
    if (current.type === 'ThisExpression' || current.type === 'Identifier') {
      path.reverse();
      return { root: current, path };
    }
    return null;
  }
}

/** The property name that produced `prefixes[index]`, if statically known. */
function segmentNameAt(chain: SenderChain, index: number): string | null {
  if (index === 0) {
    return chain.root?.type === 'Identifier' ? chain.root.name : null;
  }
  return chain.path[index - 1];
}

/**
 * Does this link in the chain read as a model, shared model, or context —
 * either by JupyterLab's naming convention or by its declared type?
 */
function prefixIsModelLike(
  chain: SenderChain,
  index: number,
  context: LifetimeContext
): boolean {
  const segment = segmentNameAt(chain, index);
  if (segment && MODEL_SEGMENT.test(segment)) {
    return true;
  }
  const typeName = typeNameOf(chain.prefixes[index], context);
  return typeName !== null && MODEL_TYPE_NAME.test(typeName);
}

/**
 * B1 — MVC dominance. JupyterLab's invariant is that models outlive views: a
 * widget is disposed by windowing, by "New View for Notebook", or by output
 * recycling while its model stays owned by the document. Only applies inside a
 * Lumino `Widget` subclass, and only to links in the chain that are *deeper*
 * than anything the class owns — owning the view says nothing about the model
 * hanging off it.
 */
function isLongLivedModel(
  chain: SenderChain,
  ownedDepth: number,
  context: LifetimeContext
): boolean {
  if (
    !classExtendsLuminoWidget(
      context.classNode,
      context.checker,
      context.services
    )
  ) {
    return false;
  }
  // As in `isLongLivedService`, a `this` root is the enclosing instance and is
  // never the long-lived counterpart: a class that is itself named `...Model`
  // says nothing about the lifetime of the field hanging off it.
  const start = Math.max(
    ownedDepth + 1,
    chain.root?.type === 'ThisExpression' ? 1 : 0
  );
  for (let i = start; i < chain.prefixes.length; i++) {
    if (prefixIsModelLike(chain, i, context)) {
      return true;
    }
  }
  return false;
}

/**
 * B2 — injected application service. Walks the sender path from the root
 * outward and admits it when some prefix has an allowlisted service type, as
 * long as no hop past that prefix is itself a widget (a widget reached through
 * a service is not long-lived — `shell.currentWidget` is the canonical case).
 *
 * Requires type information; without it the answer is always "no".
 */
function isLongLivedService(
  chain: SenderChain,
  context: LifetimeContext
): string | null {
  if (!context.checker) {
    return null;
  }
  // `prefixes[0]` is the root of the path. When that root is `this` it is the
  // enclosing instance, which cannot outlive itself — skip it, so a class whose
  // own type name is allowlisted (`CommandRegistry`, `ServiceManager`, or a
  // configured entry) is not matched against itself.
  const start = chain.root?.type === 'ThisExpression' ? 1 : 0;
  for (let i = start; i < chain.prefixes.length; i++) {
    const name = typeNameOf(chain.prefixes[i], context);
    if (!name || !context.longLivedTypes.has(name)) {
      continue;
    }
    let blocked = false;
    for (let j = i + 1; j < chain.prefixes.length; j++) {
      if (isWidgetTyped(chain.prefixes[j], context)) {
        blocked = true;
        break;
      }
    }
    if (!blocked) {
      return name;
    }
  }
  return null;
}

export interface SenderAnalysis {
  lifetime: SenderLifetime;
  /** Source text of the sender, for the diagnostic message. */
  senderText: string;
  /** Allowlisted service type name, when `lifetime` is `long-lived-service`. */
  typeName: string | null;
}

/**
 * Classifies the sender of a `.connect()` call. Everything that cannot be
 * proven long-lived comes back as `'unknown'`, `'self'`, or `'owned'` — all of
 * which the rules treat as silence.
 */
export function analyzeSender(
  signalExpr: TSESTree.Expression,
  context: LifetimeContext
): SenderAnalysis {
  const chain = buildSenderChain(signalExpr);
  const senderText = chain
    ? context.sourceCode.getText(chain.sender)
    : context.sourceCode.getText(signalExpr);

  if (!chain || chain.hasCall || !chain.root) {
    // A call in the path, or a bare `signal.connect(cb)` on a local: the
    // sender object is not identifiable, so nothing can be proven.
    return { lifetime: 'unknown', senderText, typeName: null };
  }

  if (chain.root.type === 'ThisExpression') {
    const first = chain.path[0];
    if (first === undefined) {
      // `this.somethingChanged` — the class's own signal. `Signal.clearData(this)`
      // on the sender side already removes every connection to it.
      return { lifetime: 'self', senderText, typeName: null };
    }
    if (first !== null && WIDGET_INTRINSICS.has(first)) {
      return { lifetime: 'self', senderText, typeName: null };
    }
  }

  const ownedDepth = ownedPrefixDepth(chain, context);
  if (ownedDepth >= 0) {
    if (ownedDepth === chain.prefixes.length - 1) {
      // The sender itself is constructed, adopted, or disposed here: it dies
      // with the receiver, so the connection is collected either way.
      return { lifetime: 'owned', senderText, typeName: null };
    }
    if (prefixIsModelLike(chain, ownedDepth, context)) {
      // The owned link is itself a model, so everything hanging off it
      // (`this._model.sharedModel`, `this._model.cells`) is owned too.
      return { lifetime: 'owned', senderText, typeName: null };
    }
    // Otherwise the class owns a *view* and the sender lives deeper — fall
    // through: `input.model` is not owned just because `input` is.
  }

  const serviceName = isLongLivedService(chain, context);
  if (serviceName) {
    return {
      lifetime: 'long-lived-service',
      senderText,
      typeName: serviceName
    };
  }

  if (isLongLivedModel(chain, ownedDepth, context)) {
    return { lifetime: 'long-lived-model', senderText, typeName: null };
  }

  return { lifetime: 'unknown', senderText, typeName: null };
}

export type CallbackShape = 'bound' | 'inline' | 'referenced' | 'opaque';

/**
 * How a connected callback can be removed later.
 *
 * - `bound`: `fn.bind(this)` allocates a fresh function, so no
 *   `disconnect(callback, ...)` can ever match it by identity.
 * - `inline`: an arrow or function expression — same problem, unless the
 *   connection carries a `thisArg` that receiver-side cleanup can match.
 * - `referenced`: a stable identifier or member expression, removable by a
 *   matching `disconnect()`.
 */
export function classifyCallbackShape(
  callback: TSESTree.CallExpressionArgument
): CallbackShape {
  const value = unwrap(callback);
  if (
    value.type === 'CallExpression' &&
    value.callee.type === 'MemberExpression' &&
    !value.callee.computed &&
    propertyName(value.callee.property) === 'bind'
  ) {
    return 'bound';
  }
  if (
    value.type === 'ArrowFunctionExpression' ||
    value.type === 'FunctionExpression'
  ) {
    return 'inline';
  }
  if (value.type === 'Identifier' || value.type === 'MemberExpression') {
    return 'referenced';
  }
  return 'opaque';
}

/**
 * Measure C: is there a `.disconnect()` anywhere in the file that removes this
 * callback?
 *
 * Searches the whole `Program` — including nested arrow functions, returned
 * `DisposableDelegate` bodies and helper closures — and matches on the
 * normalized text of the callback expression rather than on the sender chain.
 * `@jupyterlab/lsp`'s `registerProvider` connects
 * `registration.provider.sessionsChanged` and disconnects
 * `provider.sessionsChanged` with the same `registration.onSessionsChanged`
 * callback; comparing senders misses it, comparing callbacks does not.
 *
 * `arity` is the argument count the disconnect must have to match the connect:
 * Lumino matches on the exact `(signal, slot, thisArg)` triple, so a
 * one-argument `connect(cb)` is only undone by a one-argument
 * `disconnect(cb)`.
 */
export function hasMatchingDisconnect(
  program: TSESTree.Program,
  callback: TSESTree.CallExpressionArgument,
  sourceCode: Readonly<TSESLint.SourceCode>,
  arity: 1 | 2
): boolean {
  if (classifyCallbackShape(callback) !== 'referenced') {
    // Inline and bound callbacks have no stable identity to disconnect by.
    return false;
  }
  const wanted = normalizeText(sourceCode, callback);
  let found = false;
  walkFrom(program, node => {
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'MemberExpression' &&
      !node.callee.computed &&
      propertyName(node.callee.property) === 'disconnect' &&
      node.arguments.length === arity &&
      normalizeText(sourceCode, node.arguments[0]) === wanted
    ) {
      found = true;
      return 'stop';
    }
    return undefined;
  });
  return found;
}

/**
 * Measure E: `disposed`-style wiring is cleaned up sender-side — the signal
 * fires exactly as its sender is torn down, and Lumino's own
 * `Widget.dispose()` clears the connection immediately afterwards. This is the
 * pattern the docs recommend, so neither rule may flag it.
 */
export function isSelfTerminatingSignal(chain: SenderChain | null): boolean {
  return chain?.signalName === 'disposed';
}
