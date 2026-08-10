/*
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

import { TSESTree } from '@typescript-eslint/types';
import { ESLintUtils, ParserServices } from '@typescript-eslint/utils';
import * as ts from 'typescript';
import { createRule } from '../utils/create-rule';
import {
  classHasCleanupEvidence,
  classifySignalReceiver,
  collectSignalNamespaceLocalNames,
  getEnclosingClass,
  getThisBinding,
  isConnectCall
} from '../utils/signals';
import {
  ClassOwnershipFacts,
  DEFAULT_LONG_LIVED_TYPES,
  analyzeSender,
  buildSenderChain,
  classHasDisposalProtocol,
  collectClassOwnershipFacts,
  isSelfTerminatingSignal
} from '../utils/signal-lifetime';

const requireSignalCleanup = createRule({
  name: 'require-signal-cleanup',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require a cleanup path for Lumino signal connections whose sender outlives the connecting class',
      url: 'https://eslint-plugin.readthedocs.io/en/latest/rules/require-signal-cleanup/'
    },
    messages: {
      serviceOutlivesReceiver:
        'This connection to "{{ sender }}" is never removed, and "{{ typeName }}" is an application-lifetime service, so it will outlive this class and keep every instance alive. Disconnect it during teardown, or call Signal.clearData(this).'
    },
    schema: [
      {
        type: 'object',
        properties: {
          additionalCleanupMethods: {
            type: 'array',
            items: {
              type: 'string'
            },
            default: [],
            description:
              'Additional method names (besides "disconnect") that count as cleanup evidence when called anywhere in the class'
          },
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
      additionalCleanupMethods: [] as string[],
      longLivedTypes: undefined as string[] | undefined
    }
  ],

  create(context, [options]) {
    const additionalCleanupMethods: string[] =
      options.additionalCleanupMethods || [];
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
    const cleanupEvidenceCache = new Map<TSESTree.Node, boolean>();
    const ownershipCache = new Map<TSESTree.Node, ClassOwnershipFacts>();

    return {
      Program(node: TSESTree.Program): void {
        program = node;
        signalLocalNames = collectSignalNamespaceLocalNames(node);
        cleanupEvidenceCache.clear();
        ownershipCache.clear();
      },

      CallExpression(node: TSESTree.CallExpression): void {
        if (!isConnectCall(node) || !program) {
          return;
        }
        if (node.arguments.length < 2) {
          // No thisArg — see require-signal-this-arg / prefer-signal-this-arg.
          return;
        }
        if (node.arguments[1].type !== 'ThisExpression') {
          // Receiver is some other object; its lifetime is not traceable here.
          return;
        }
        if (getThisBinding(node) !== 'instance') {
          // In a `static` member `this` is the class object, and in a nested
          // regular function it is whatever the caller binds. Neither is an
          // instance whose lifetime this rule reasons about, and neither is
          // removed by a `Signal.clearData(this)` in `dispose()`.
          return;
        }

        const enclosingClass = getEnclosingClass(node);
        if (!enclosingClass) {
          return;
        }
        if (enclosingClass.superClass) {
          // The base class may clean up in an inherited dispose() that is
          // invisible from here — Lumino's Widget.dispose() calls
          // Signal.clearData(this), which removes exactly this connection.
          return;
        }
        if (!classHasDisposalProtocol(enclosingClass)) {
          // No dispose(), no isDisposed, no `implements IDisposable`: almost
          // always a plugin-scope singleton whose lifetime matches the
          // services it connects to, and with nowhere to put a disconnect.
          return;
        }

        const chain = buildSenderChain(node.callee.object);
        if (isSelfTerminatingSignal(chain)) {
          // `x.disposed.connect(cb, this)` fires as its sender is torn down
          // and is cleaned up sender-side. It is the pattern this rule
          // recommends, so it must never be flagged.
          return;
        }

        let hasEvidence = cleanupEvidenceCache.get(enclosingClass);
        if (hasEvidence === undefined) {
          hasEvidence = classHasCleanupEvidence(
            enclosingClass,
            signalLocalNames,
            additionalCleanupMethods
          );
          cleanupEvidenceCache.set(enclosingClass, hasEvidence);
        }
        if (hasEvidence) {
          return;
        }

        const classification = classifySignalReceiver(
          node.callee.object,
          checker,
          services
        );
        if (classification === 'not-signal') {
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

        // Only positively proven long-lived senders are reported. `self`,
        // `owned` and `unknown` all stay silent: absence of cleanup is not
        // evidence of a leak when the sender dies with the receiver.
        //
        // `long-lived-model` cannot occur here: it is gated on the receiver
        // extending Lumino's Widget, and every such class is already skipped
        // above by the `superClass` check.
        if (analysis.lifetime === 'long-lived-service') {
          context.report({
            node,
            messageId: 'serviceOutlivesReceiver',
            data: {
              sender: analysis.senderText,
              typeName: analysis.typeName ?? 'service'
            }
          });
        }
      }
    };
  }
});

export = requireSignalCleanup;
