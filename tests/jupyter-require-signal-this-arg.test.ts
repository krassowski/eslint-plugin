/*
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

import { RuleTester } from '@typescript-eslint/rule-tester';
import * as path from 'path';
import requireSignalThisArg from '../src/rules/require-signal-this-arg';

const nonTypeAwareTester = new RuleTester({
  languageOptions: {
    parser: require('@typescript-eslint/parser'),
    parserOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
      tsconfigRootDir: path.resolve(__dirname, '..')
    }
  }
});

const ruleTester = new RuleTester({
  languageOptions: {
    parser: require('@typescript-eslint/parser'),
    parserOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
      projectService: {
        allowDefaultProject: ['tests/*.ts'],
        defaultProject: 'tsconfig.json'
      },
      tsconfigRootDir: path.resolve(__dirname, '..')
    }
  }
});

nonTypeAwareTester.run(
  'require-signal-this-arg (non-type-aware)',
  requireSignalThisArg,
  {
    valid: [
      {
        // Method does not use \`this\` — safe without a thisArg
        code: `
        class Watcher {
          wire(model: any): void {
            model.changed.connect(this._onChanged);
          }
          private _onChanged(): void {
            console.log('changed');
          }
        }
      `
      },
      {
        // thisArg already passed
        code: `
        class Watcher {
          wire(model: any): void {
            model.changed.connect(this._onChanged, this);
          }
          private _onChanged(): void {
            this.refresh();
          }
          refresh(): void {}
        }
      `
      },
      {
        // Callback is a free variable, not a class-method reference
        code: `
        class Watcher {
          wire(model: any, handler: () => void): void {
            model.changed.connect(handler);
          }
        }
      `
      },
      {
        // Method not found in the class (possibly inherited) — skip
        code: `
        class Watcher extends Base {
          wire(model: any): void {
            model.changed.connect(this._onInherited);
          }
        }
      `
      },
      {
        // Arrow-function class property is lexically bound
        code: `
        class Watcher {
          wire(model: any): void {
            model.changed.connect(this._onChanged);
          }
          private _onChanged = (): void => {
            this.refresh();
          };
          refresh(): void {}
        }
      `
      },
      {
        // Getter — evaluated, not referenced; out of scope
        code: `
        class Watcher {
          wire(model: any): void {
            model.changed.connect(this.handler);
          }
          get handler(): () => void {
            return () => this.refresh();
          }
          refresh(): void {}
        }
      `
      },
      {
        // \`this\` only inside a nested regular function — opaque boundary
        code: `
        class Watcher {
          wire(model: any): void {
            model.changed.connect(this._onChanged);
          }
          private _onChanged(): void {
            function inner(this: unknown): void {
              console.log(this);
            }
            inner.call(null);
          }
        }
      `
      },
      {
        // Already explicitly bound — not a bare member expression
        code: `
        class Watcher {
          wire(model: any): void {
            model.changed.connect(this._onChanged.bind(this));
          }
          private _onChanged(): void {
            this.refresh();
          }
          refresh(): void {}
        }
      `
      },
      {
        // Unknown receiver type and no signal-like name — skip
        code: `
        class Watcher {
          wire(node: any): void {
            node.connect(this._onEvent);
          }
          private _onEvent(): void {
            this.refresh();
          }
          refresh(): void {}
        }
      `
      },
      {
        // Inside a nested regular function `this` is not the enclosing class,
        // so `this._onChanged` does not refer to the member below and must not
        // be resolved against it.
        code: `
        class Watcher {
          wire(model: any): void {
            function inner(this: { _onChanged(): void }): void {
              model.changed.connect(this._onChanged);
            }
            inner.call({ _onChanged: () => {} });
          }
          private _onChanged(): void {
            this.refresh();
          }
          refresh(): void {}
        }
      `
      }
    ],
    invalid: [
      {
        // Regular method using \`this\`, connected without thisArg
        code: `
        class Watcher {
          wire(model: any): void {
            model.changed.connect(this._onChanged);
          }
          private _onChanged(): void {
            this.refresh();
          }
          refresh(): void {}
        }
      `,
        errors: [
          {
            messageId: 'missingThisArg',
            data: { name: '_onChanged' },
            suggestions: [
              {
                messageId: 'addThisArg',
                output: `
        class Watcher {
          wire(model: any): void {
            model.changed.connect(this._onChanged, this);
          }
          private _onChanged(): void {
            this.refresh();
          }
          refresh(): void {}
        }
      `
              }
            ]
          }
        ]
      },
      {
        // Private method using \`this\`
        code: `
        class Watcher {
          wire(model: any): void {
            model.changed.connect(this.#onChanged);
          }
          #onChanged(): void {
            this.refresh();
          }
          refresh(): void {}
        }
      `,
        errors: [
          {
            messageId: 'missingThisArg',
            data: { name: '#onChanged' },
            suggestions: [
              {
                messageId: 'addThisArg',
                output: `
        class Watcher {
          wire(model: any): void {
            model.changed.connect(this.#onChanged, this);
          }
          #onChanged(): void {
            this.refresh();
          }
          refresh(): void {}
        }
      `
              }
            ]
          }
        ]
      },
      {
        // \`this\` used only inside nested control flow
        code: `
        class Watcher {
          wire(model: any): void {
            model.changed.connect(this._onChanged);
          }
          private _onChanged(sender: unknown, args: string[]): void {
            for (const arg of args) {
              if (arg) {
                this.refresh();
              }
            }
          }
          refresh(): void {}
        }
      `,
        errors: [
          {
            messageId: 'missingThisArg',
            data: { name: '_onChanged' },
            suggestions: [
              {
                messageId: 'addThisArg',
                output: `
        class Watcher {
          wire(model: any): void {
            model.changed.connect(this._onChanged, this);
          }
          private _onChanged(sender: unknown, args: string[]): void {
            for (const arg of args) {
              if (arg) {
                this.refresh();
              }
            }
          }
          refresh(): void {}
        }
      `
              }
            ]
          }
        ]
      },
      {
        // \`this\` used only inside nested arrows — arrows are transparent
        code: `
        class Watcher {
          wire(model: any): void {
            model.changed.connect(this._onChanged);
          }
          private _onChanged(): void {
            setTimeout(() => {
              queueMicrotask(() => this.refresh());
            }, 0);
          }
          refresh(): void {}
        }
      `,
        errors: [
          {
            messageId: 'missingThisArg',
            data: { name: '_onChanged' },
            suggestions: [
              {
                messageId: 'addThisArg',
                output: `
        class Watcher {
          wire(model: any): void {
            model.changed.connect(this._onChanged, this);
          }
          private _onChanged(): void {
            setTimeout(() => {
              queueMicrotask(() => this.refresh());
            }, 0);
          }
          refresh(): void {}
        }
      `
              }
            ]
          }
        ]
      },
      {
        // Static context resolves against static members
        code: `
        class Watcher {
          static wire(model: any): void {
            model.changed.connect(this._onChanged);
          }
          private static _onChanged(): void {
            this.refresh();
          }
          static refresh(): void {}
        }
      `,
        errors: [
          {
            messageId: 'missingThisArg',
            data: { name: '_onChanged' },
            suggestions: [
              {
                messageId: 'addThisArg',
                output: `
        class Watcher {
          static wire(model: any): void {
            model.changed.connect(this._onChanged, this);
          }
          private static _onChanged(): void {
            this.refresh();
          }
          static refresh(): void {}
        }
      `
              }
            ]
          }
        ]
      },
      {
        // Function-expression class property behaves like a method
        code: `
        class Watcher {
          wire(model: any): void {
            model.changed.connect(this._onChanged);
          }
          private _onChanged = function (this: Watcher): void {
            this.refresh();
          };
          refresh(): void {}
        }
      `,
        errors: [
          {
            messageId: 'missingThisArg',
            data: { name: '_onChanged' },
            suggestions: [
              {
                messageId: 'addThisArg',
                output: `
        class Watcher {
          wire(model: any): void {
            model.changed.connect(this._onChanged, this);
          }
          private _onChanged = function (this: Watcher): void {
            this.refresh();
          };
          refresh(): void {}
        }
      `
              }
            ]
          }
        ]
      }
    ]
  }
);

ruleTester.run('require-signal-this-arg', requireSignalThisArg, {
  valid: [
    {
      // Receiver type resolves to a non-signal — do not flag
      filename: 'tests/type-aware-fixture.ts',
      code: `
        import { NotASignal } from './fixtures/not-a-signal';
        class Wiring {
          wire(node: NotASignal): void {
            node.connect(this._onEvent);
          }
          private _onEvent(): void {
            this.refresh();
          }
          refresh(): void {}
        }
      `
    }
  ],
  invalid: [
    {
      // Receiver typed as ISignal — flagged even without a signal-like name
      filename: 'tests/type-aware-fixture.ts',
      code: `
        import { ISignal } from '@lumino/signaling';
        interface IModel {
          updates: ISignal<IModel, void>;
        }
        class Watcher {
          wire(model: IModel): void {
            model.updates.connect(this._onUpdate);
          }
          private _onUpdate(): void {
            this.refresh();
          }
          refresh(): void {}
        }
      `,
      errors: [
        {
          messageId: 'missingThisArg',
          data: { name: '_onUpdate' },
          suggestions: [
            {
              messageId: 'addThisArg',
              output: `
        import { ISignal } from '@lumino/signaling';
        interface IModel {
          updates: ISignal<IModel, void>;
        }
        class Watcher {
          wire(model: IModel): void {
            model.updates.connect(this._onUpdate, this);
          }
          private _onUpdate(): void {
            this.refresh();
          }
          refresh(): void {}
        }
      `
            }
          ]
        }
      ]
    }
  ]
});
