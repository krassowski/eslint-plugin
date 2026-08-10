/*
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

import { TSESTree } from '@typescript-eslint/types';
import { ESLintUtils, ParserServices } from '@typescript-eslint/utils';
import * as ts from 'typescript';
import { createRule } from '../utils/create-rule';
import {
  classExtendsLuminoWidget,
  classUsesReceiverBasedCleanup,
  classifySignalReceiver,
  collectSignalNamespaceLocalNames,
  getEnclosingClass,
  getThisBinding,
  isConnectCall,
  resolveUnboundThisMethodConnect
} from '../utils/signals';
import {
  ClassOwnershipFacts,
  DEFAULT_LONG_LIVED_TYPES,
  analyzeSender,
  buildSenderChain,
  classifyCallbackShape,
  collectClassOwnershipFacts,
  hasMatchingDisconnect,
  isSelfTerminatingSignal
} from '../utils/signal-lifetime';

const preferSignalThisArg = createRule({
  name: 'prefer-signal-this-arg',
  meta: {
    type: 'problem',
    hasSuggestions: true,
    docs: {
      description:
        'Pass a thisArg when connecting to a Lumino signal whose sender outlives the connecting class',
      url: 'https://eslint-plugin.readthedocs.io/en/latest/rules/prefer-signal-this-arg/'
    },
    messages: {
      preferThisArg:
        'This connection to "{{ sender }}" has no receiver, so the receiver-based cleanup this class relies on (Signal.clearData(this)) cannot remove it — and {{ reason }}. Pass "this" as the second argument to connect().',
      boundCallback:
        'A ".bind()" callback is a fresh function on every call, so this connection to "{{ sender }}" cannot be removed by any disconnect() — and {{ reason }}. Connect the method directly and pass "this" as the second argument.',
      addThisArg: 'Add "this" as the second argument',
      unbindAndAddThisArg: 'Drop ".bind(this)" and pass "this" to connect()'
    },
    schema: [
      {
        type: 'object',
        properties: {
          longLivedTypes: {
            type: 'array',
            items: {
              type: 'string'
            },
            description:
              'Type names treated as application-lifetime services. Replaces the built-in list when provided.'
          }
        },
        additionalProperties: false
      }
    ]
  },
  defaultOptions: [
    {
      longLivedTypes: undefined as string[] | undefined
    }
  ],

  create(context, [options]) {
    const longLivedTypes = new Set(
      options.longLivedTypes ?? DEFAULT_LONG_LIVED_TYPES
    );

    let services: ParserServices | null = null;
    let checker: ts.TypeChecker | null = null;

    try {
      services = ESLintUtils.getParserServices(context, true);
      checker = services.program ? services.program.getTypeChecker() : null;
    } catch {
      services = null;
    }

    const sourceCode = context.sourceCode;
    let program: TSESTree.Program | null = null;
    let signalLocalNames: ReadonlySet<string> = new Set(['Signal']);
    const receiverCleanupCache = new Map<TSESTree.Node, boolean>();
    const ownershipCache = new Map<TSESTree.Node, ClassOwnershipFacts>();

    return {
      Program(node: TSESTree.Program): void {
        program = node;
        signalLocalNames = collectSignalNamespaceLocalNames(node);
        receiverCleanupCache.clear();
        ownershipCache.clear();
      },

      CallExpression(node: TSESTree.CallExpression): void {
        if (!isConnectCall(node) || node.arguments.length !== 1 || !program) {
          return;
        }

        const enclosingClass = getEnclosingClass(node);
        if (!enclosingClass) {
          // No `this` to pass; module scope and plugin activate() functions
          // are app-lifetime connections anyway.
          return;
        }
        if (getThisBinding(node) !== 'instance') {
          // `this` here is the class object (`static` member) or whatever the
          // caller binds (nested regular function). Passing it would not
          // register the instance that receiver-based cleanup clears, so `,
          // this` is not the fix.
          return;
        }

        const chain = buildSenderChain(node.callee.object);
        if (isSelfTerminatingSignal(chain)) {
          // `x.disposed.connect(() => ...)` is cleaned up sender-side.
          return;
        }

        if (resolveUnboundThisMethodConnect(node)) {
          // A bare method reference that uses `this` is a runtime bug, not
          // just a cleanup concern — reported at error level by
          // require-signal-this-arg instead.
          return;
        }

        const callback = node.arguments[0];
        const shape = classifyCallbackShape(callback);
        if (shape === 'opaque') {
          return;
        }
        if (hasMatchingDisconnect(program, callback, sourceCode, 1)) {
          // Lumino matches connections by the exact (signal, slot, thisArg)
          // triple, so a paired one-argument disconnect(callback) is a working
          // teardown that adding `, this` here would silently break.
          return;
        }

        let cleanupIsViable = receiverCleanupCache.get(enclosingClass);
        if (cleanupIsViable === undefined) {
          cleanupIsViable =
            classUsesReceiverBasedCleanup(enclosingClass, signalLocalNames) ||
            classExtendsLuminoWidget(enclosingClass, checker, services);
          receiverCleanupCache.set(enclosingClass, cleanupIsViable);
        }
        if (!cleanupIsViable) {
          // Nothing in this class matches connections by receiver, so adding a
          // thisArg would not make the connection removable. Whatever the
          // lifetimes are, `, this` is not the fix.
          return;
        }

        if (
          classifySignalReceiver(node.callee.object, checker, services) ===
          'not-signal'
        ) {
          return;
        }

        let facts = ownershipCache.get(enclosingClass);
        if (!facts) {
          facts = collectClassOwnershipFacts(
            enclosingClass,
            sourceCode,
            signalLocalNames
          );
          ownershipCache.set(enclosingClass, facts);
        }

        const analysis = analyzeSender(node.callee.object, {
          classNode: enclosingClass,
          facts,
          sourceCode,
          scope: sourceCode.getScope(node),
          checker,
          services,
          longLivedTypes
        });

        // Only report when the sender is positively proven to outlive the
        // receiver. A sender the class owns, or one whose lifetime cannot be
        // established, is silence — a missing thisArg is harmless there.
        let reason: string;
        if (analysis.lifetime === 'long-lived-service') {
          reason = `"${analysis.typeName}" is an application-lifetime service that will outlive this class`;
        } else if (analysis.lifetime === 'long-lived-model') {
          reason = 'a model outlives the views built on it';
        } else {
          return;
        }

        // A `.bind(this)` can be rewritten into `(method, this)`. A `.bind()`
        // onto anything else cannot — that would move the callback's receiver
        // — so it is reported as an ordinary missing thisArg: appending
        // `, this` is behaviour-preserving there (Lumino invokes the slot with
        // `call(thisArg, ...)`, which an already-bound function ignores) and
        // still makes the connection removable by receiver.
        const bindTarget =
          shape === 'bound' ? getUnbindReplacement(callback, sourceCode) : null;

        context.report({
          node: callback,
          messageId: bindTarget ? 'boundCallback' : 'preferThisArg',
          data: { sender: analysis.senderText, reason },
          suggest: bindTarget
            ? [
                {
                  messageId: 'unbindAndAddThisArg',
                  fix: fixer => fixer.replaceText(callback, bindTarget)
                }
              ]
            : [
                {
                  messageId: 'addThisArg',
                  fix: fixer => fixer.insertTextAfter(callback, ', this')
                }
              ]
        });
      }
    };
  }
});

/**
 * Turns `this._onFoo.bind(this)` into the text `this._onFoo, this`, so the
 * suggestion rewrites `connect(fn.bind(this))` into `connect(fn, this)`.
 * Returns null when `.bind()` is passed anything other than `this` — the
 * receiver would change and the edit would not be behaviour-preserving.
 */
function getUnbindReplacement(
  callback: TSESTree.CallExpressionArgument,
  sourceCode: { getText(node: TSESTree.Node): string }
): string | null {
  if (
    callback.type !== 'CallExpression' ||
    callback.callee.type !== 'MemberExpression' ||
    callback.arguments.length !== 1 ||
    callback.arguments[0].type !== 'ThisExpression'
  ) {
    return null;
  }
  return `${sourceCode.getText(callback.callee.object)}, this`;
}

export = preferSignalThisArg;
