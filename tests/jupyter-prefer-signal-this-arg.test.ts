/*
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

import { RuleTester } from '@typescript-eslint/rule-tester';
import * as path from 'path';
import preferSignalThisArg from '../src/rules/prefer-signal-this-arg';

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

/** Declarations shared by the type-aware cases. */
const PRELUDE = `
        import { ISignal } from '@lumino/signaling';
        import { Widget } from '@lumino/widgets';
        interface ISettingRegistry {
          readonly pluginChanged: ISignal<ISettingRegistry, string>;
        }
        interface IThemeManager {
          readonly themeChanged: ISignal<IThemeManager, void>;
        }
        interface IShell {
          readonly currentChanged: ISignal<IShell, void>;
          readonly currentWidget: Widget;
        }
        interface INotebookModel {
          readonly contentChanged: ISignal<INotebookModel, void>;
        }
        interface IEditor {
          readonly model: INotebookModel;
          readonly ready: ISignal<IEditor, void>;
          dispose(): void;
        }
        declare const Signal: {
          clearData(obj: unknown): void;
        };
`;

// Neither of this rule's two sender-lifetime proofs works without a type
// checker: the service allowlist is type-gated, and the model/view rule is
// gated on the receiver extending Lumino's Widget. A syntax-only run is silent.
nonTypeAwareTester.run(
  'prefer-signal-this-arg (no type information)',
  preferSignalThisArg,
  {
    valid: [
      {
        code: `
        class Watcher {
          wire(model: any): void {
            model.changed.connect(() => this._onChanged());
          }
          dispose(): void {
            Signal.clearData(this);
          }
          private _onChanged(): void {}
        }
      `
      },
      {
        code: `
        class Watcher {
          wire(model: any): void {
            model.changed.connect(this._onChanged.bind(this));
          }
          dispose(): void {
            Signal.clearData(this);
          }
          private _onChanged(): void {}
        }
      `
      }
    ],
    invalid: []
  }
);

ruleTester.run('prefer-signal-this-arg', preferSignalThisArg, {
  valid: [
    {
      // A thisArg is already passed.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        class Watcher {
          wire(registry: ISettingRegistry): void {
            registry.pluginChanged.connect(this._onChanged, this);
          }
          dispose(): void {
            Signal.clearData(this);
          }
          private _onChanged(): void {}
        }
      `
    },
    {
      // Nothing in this class matches connections by receiver and it is not a
      // Widget, so adding `, this` would not make the connection removable.
      // Whatever the lifetimes are, a thisArg is not the fix.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        class Watcher {
          wire(registry: ISettingRegistry): void {
            registry.pluginChanged.connect(() => this._onChanged());
          }
          private _onChanged(): void {}
        }
      `
    },
    {
      // A paired one-argument disconnect() already removes this connection.
      // Lumino matches on the exact (signal, slot, thisArg) triple, so adding
      // `, this` here would silently break the existing teardown.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        class Watcher extends Widget {
          wire(registry: ISettingRegistry): void {
            this._registry = registry;
            registry.pluginChanged.connect(this._onChanged);
          }
          unwire(): void {
            this._registry.pluginChanged.disconnect(this._onChanged);
          }
          private _onChanged(): void {}
          private _registry!: ISettingRegistry;
        }
      `
    },
    {
      // The sender is a widget reached through a service; widgets are not
      // application-lifetime.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        class Watcher extends Widget {
          wire(shell: IShell): void {
            shell.currentWidget.title.changed.connect(() => this._onChanged());
          }
          private _onChanged(): void {}
        }
      `
    },
    {
      // The class's own signal: Signal.clearData(this) on the sender side
      // already removes every connection to it.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        class Watcher extends Widget {
          wire(): void {
            this.stateChanged.connect(() => this._onChanged());
          }
          readonly stateChanged!: ISignal<Watcher, void>;
          private _onChanged(): void {}
        }
      `
    },
    {
      // A sender the class constructs and disposes dies with the receiver.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        declare function createEditor(): IEditor;
        class Host extends Widget {
          constructor() {
            super();
            this._editor = createEditor();
            this._editor.ready.connect(() => this._onReady());
          }
          dispose(): void {
            this._editor.dispose();
            super.dispose();
          }
          private _onReady(): void {}
          private _editor: IEditor;
        }
      `
    },
    {
      // `disposed` fires as the sender is torn down; cleaned up sender-side.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        interface IDisposableService {
          readonly disposed: ISignal<IDisposableService, void>;
        }
        class Watcher extends Widget {
          wire(registry: ISettingRegistry & IDisposableService): void {
            registry.disposed.connect(() => this._onDisposed());
          }
          private _onDisposed(): void {}
        }
      `
    },
    {
      // A bare method reference that uses `this` is a runtime bug, not just a
      // cleanup concern — require-signal-this-arg owns that case.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        class Watcher extends Widget {
          wire(registry: ISettingRegistry): void {
            registry.pluginChanged.connect(this._onChanged);
          }
          private _onChanged(): void {
            this.update();
          }
        }
      `
    },
    {
      // No enclosing class: there is no `this` to pass.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        function activate(registry: ISettingRegistry): void {
          registry.pluginChanged.connect(() => console.log('changed'));
        }
      `
    },
    {
      // The receiver is not a signal at all.
      filename: 'tests/type-aware-fixture.ts',
      code: `
        import { NotASignal } from './fixtures/not-a-signal';
        class Wiring {
          constructor(node: NotASignal) {
            node.connect(() => this._onEvent());
          }
          dispose(): void {
            (Signal as any).clearData(this);
          }
          private _onEvent(): void {}
        }
        declare const Signal: unknown;
      `
    },
    {
      // longLivedTypes replaces the built-in list.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        class Watcher extends Widget {
          wire(registry: ISettingRegistry): void {
            registry.pluginChanged.connect(() => this._onChanged());
          }
          private _onChanged(): void {}
        }
      `,
      options: [{ longLivedTypes: ['IMyOwnService'] }]
    },
    {
      // `this` in a static member is the class object; passing it would not
      // register the instance that Signal.clearData(this) clears.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        class Watcher extends Widget {
          static wire(registry: ISettingRegistry): void {
            registry.pluginChanged.connect(() => Watcher._onChanged());
          }
          private static _onChanged(): void {}
        }
      `
    },
    {
      // Inside a nested regular function `this` is not the instance either.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        class Watcher extends Widget {
          wire(registry: ISettingRegistry): void {
            function inner(): void {
              registry.pluginChanged.connect(() => console.log('changed'));
            }
            inner();
          }
        }
      `
    },
    {
      // The enclosing class's own type is on the allowlist; it cannot outlive
      // itself.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        class OwnService extends Widget {
          constructor(shell: IShell) {
            super();
            this._shell = shell;
            this._shell.currentChanged.connect(() => this.update());
          }
          private _shell: IShell;
        }
      `,
      options: [{ longLivedTypes: ['OwnService'] }]
    },
    {
      // The same for the model/view argument: a class that is itself named
      // `...Model` says nothing about the lifetime of its own fields.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        class OutlineModel extends Widget {
          constructor(editor: IEditor) {
            super();
            this._editor = editor;
            this._editor.ready.connect(() => this.update());
          }
          private _editor: IEditor;
        }
      `
    }
  ],
  invalid: [
    {
      // An allowlisted application-lifetime service, connected from a Widget
      // whose inherited dispose() calls Signal.clearData(this) — cleanup that
      // only works if a thisArg is passed.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        class Watcher extends Widget {
          wire(registry: ISettingRegistry): void {
            registry.pluginChanged.connect(() => this._onChanged());
          }
          private _onChanged(): void {}
        }
      `,
      errors: [
        {
          messageId: 'preferThisArg',
          suggestions: [
            {
              messageId: 'addThisArg',
              output: `${PRELUDE}
        class Watcher extends Widget {
          wire(registry: ISettingRegistry): void {
            registry.pluginChanged.connect(() => this._onChanged(), this);
          }
          private _onChanged(): void {}
        }
      `
            }
          ]
        }
      ]
    },
    {
      // Explicit Signal.clearData(this) is receiver-based cleanup too — no
      // need for the class to be a Widget.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        class Watcher {
          wire(themes: IThemeManager): void {
            themes.themeChanged.connect(() => this._onThemeChanged());
          }
          dispose(): void {
            Signal.clearData(this);
          }
          private _onThemeChanged(): void {}
        }
      `,
      errors: [{ messageId: 'preferThisArg', suggestions: 1 }]
    },
    {
      // A model outlives the views built on it (JupyterLab recycles views over
      // a stable model), so a Widget connecting to one needs a thisArg.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        class View extends Widget {
          constructor(model: INotebookModel) {
            super();
            this._model = model;
            this._model.contentChanged.connect(() => this._onChanged());
          }
          private _onChanged(): void {}
          private _model: INotebookModel;
        }
      `,
      errors: [{ messageId: 'preferThisArg', suggestions: 1 }]
    },
    {
      // Owning a *view* does not own the model hanging off it.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        declare function createEditor(): IEditor;
        class Host extends Widget {
          constructor() {
            super();
            this._editor = createEditor();
            this._editor.model.contentChanged.connect(() => this._onChanged());
          }
          dispose(): void {
            this._editor.dispose();
            super.dispose();
          }
          private _onChanged(): void {}
          private _editor: IEditor;
        }
      `,
      errors: [{ messageId: 'preferThisArg', suggestions: 1 }]
    },
    {
      // `.bind()` produces a fresh function on every call, so no disconnect()
      // can ever match it. The suggestion drops the bind and passes `this`.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        class Watcher extends Widget {
          wire(registry: ISettingRegistry): void {
            registry.pluginChanged.connect(this._onChanged.bind(this));
          }
          private _onChanged(): void {}
        }
      `,
      errors: [
        {
          messageId: 'boundCallback',
          suggestions: [
            {
              messageId: 'unbindAndAddThisArg',
              output: `${PRELUDE}
        class Watcher extends Widget {
          wire(registry: ISettingRegistry): void {
            registry.pluginChanged.connect(this._onChanged, this);
          }
          private _onChanged(): void {}
        }
      `
            }
          ]
        }
      ]
    },
    {
      // A method reference that does not use `this` is outside
      // require-signal-this-arg's domain, but still unremovable without a
      // receiver.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        class Watcher extends Widget {
          wire(registry: ISettingRegistry): void {
            registry.pluginChanged.connect(this._onChanged);
          }
          private _onChanged(): void {
            console.log('changed');
          }
        }
      `,
      errors: [{ messageId: 'preferThisArg', suggestions: 1 }]
    },
    {
      // A custom longLivedTypes entry is honoured.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        interface IMyOwnService {
          readonly changed: ISignal<IMyOwnService, void>;
        }
        class Watcher extends Widget {
          wire(service: IMyOwnService): void {
            service.changed.connect(() => this._onChanged());
          }
          private _onChanged(): void {}
        }
      `,
      options: [{ longLivedTypes: ['IMyOwnService'] }],
      errors: [{ messageId: 'preferThisArg', suggestions: 1 }]
    },
    {
      // `.bind()` onto something other than `this` cannot be rewritten into
      // `(method, this)` without moving the callback's receiver, so it is
      // reported as an ordinary missing thisArg — appending `, this` leaves
      // the bound receiver alone and makes the connection removable.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        declare const helper: { onChanged(): void };
        class Watcher extends Widget {
          wire(registry: ISettingRegistry): void {
            registry.pluginChanged.connect(helper.onChanged.bind(helper));
          }
        }
      `,
      errors: [
        {
          messageId: 'preferThisArg',
          suggestions: [
            {
              messageId: 'addThisArg',
              output: `${PRELUDE}
        declare const helper: { onChanged(): void };
        class Watcher extends Widget {
          wire(registry: ISettingRegistry): void {
            registry.pluginChanged.connect(helper.onChanged.bind(helper), this);
          }
        }
      `
            }
          ]
        }
      ]
    }
  ]
});
