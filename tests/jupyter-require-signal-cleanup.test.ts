/*
 * Copyright (c) Jupyter Development Team.
 * Distributed under the terms of the Modified BSD License.
 */

import { RuleTester } from '@typescript-eslint/rule-tester';
import * as path from 'path';
import requireSignalCleanup from '../src/rules/require-signal-cleanup';

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
        interface IDisposable {
          readonly isDisposed: boolean;
          dispose(): void;
        }
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
        declare const Signal: {
          clearData(obj: unknown): void;
        };
`;

// Without type information the rule cannot establish that any sender is
// long-lived, so it reports nothing at all. These cases pin that contract down:
// a syntax-only run must be silent rather than guess.
nonTypeAwareTester.run(
  'require-signal-cleanup (no type information)',
  requireSignalCleanup,
  {
    valid: [
      {
        // The old absence-based shape. Untyped `model` could be anything, so
        // "no cleanup here" is not evidence of a leak.
        code: `
        class Watcher {
          constructor(model: any) {
            model.changed.connect(this._onChanged, this);
          }
          dispose(): void {}
          private _onChanged(): void {}
        }
      `
      },
      {
        // Even a name that looks like a service proves nothing without a type.
        code: `
        class Watcher {
          constructor(settingRegistry: any) {
            settingRegistry.pluginChanged.connect(this._onChanged, this);
          }
          dispose(): void {}
          private _onChanged(): void {}
        }
      `
      }
    ],
    invalid: []
  }
);

ruleTester.run('require-signal-cleanup', requireSignalCleanup, {
  valid: [
    {
      // Sender is an allowlisted service, but the class calls
      // Signal.clearData(this) — every connection with `this` as receiver goes.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        class Watcher implements IDisposable {
          constructor(registry: ISettingRegistry) {
            registry.pluginChanged.connect(this._onChanged, this);
          }
          readonly isDisposed = false;
          dispose(): void {
            Signal.clearData(this);
          }
          private _onChanged(): void {}
        }
      `
    },
    {
      // An explicit matching .disconnect() elsewhere in the class.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        class Watcher implements IDisposable {
          constructor(registry: ISettingRegistry) {
            this._registry = registry;
            registry.pluginChanged.connect(this._onChanged, this);
          }
          readonly isDisposed = false;
          dispose(): void {
            this._registry.pluginChanged.disconnect(this._onChanged, this);
          }
          private _onChanged(): void {}
          private _registry: ISettingRegistry;
        }
      `
    },
    {
      // No disposal protocol: no dispose(), no isDisposed, no
      // `implements IDisposable`. Almost always a plugin-scope singleton whose
      // lifetime already matches the service, and with nowhere to put a
      // disconnect. Silent by design.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        class ThemeWatcher {
          constructor(themes: IThemeManager) {
            themes.themeChanged.connect(this._onThemeChanged, this);
          }
          private _onThemeChanged(): void {}
        }
      `
    },
    {
      // Subclass: a base class such as Lumino's Widget already calls
      // Signal.clearData(this) from its inherited dispose().
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        declare class Base {
          dispose(): void;
        }
        class Panel extends Base {
          constructor(registry: ISettingRegistry) {
            super();
            registry.pluginChanged.connect(this._onChanged, this);
          }
          private _onChanged(): void {}
        }
      `
    },
    {
      // The sender is a widget reached *through* a service. Widgets are not
      // application-lifetime, so the allowlist walk rejects the hop.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        class Watcher implements IDisposable {
          constructor(shell: IShell) {
            shell.currentWidget.title.changed.connect(this._onChanged, this);
          }
          readonly isDisposed = false;
          dispose(): void {}
          private _onChanged(): void {}
        }
      `
    },
    {
      // A model is not on the service allowlist, and the receiver is not a
      // Widget, so nothing proves the model outlives it.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        class Watcher implements IDisposable {
          constructor(model: INotebookModel) {
            model.contentChanged.connect(this._onChanged, this);
          }
          readonly isDisposed = false;
          dispose(): void {}
          private _onChanged(): void {}
        }
      `
    },
    {
      // `disposed` fires as the sender is torn down; the connection dies with
      // it. Flagging this would contradict the fix the rule recommends.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        interface IDisposableService {
          readonly disposed: ISignal<IDisposableService, void>;
        }
        class Watcher implements IDisposable {
          constructor(registry: ISettingRegistry & IDisposableService) {
            registry.disposed.connect(this._onDisposed, this);
          }
          readonly isDisposed = false;
          dispose(): void {}
          private _onDisposed(): void {}
        }
      `
    },
    {
      // Single-argument connect() — see prefer-signal-this-arg.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        class Watcher implements IDisposable {
          constructor(registry: ISettingRegistry) {
            registry.pluginChanged.connect(() => this._onChanged());
          }
          readonly isDisposed = false;
          dispose(): void {}
          private _onChanged(): void {}
        }
      `
    },
    {
      // Receiver is some other object; its lifetime is not traceable here.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        class Coordinator implements IDisposable {
          wire(registry: ISettingRegistry, handler: any): void {
            registry.pluginChanged.connect(handler.onChanged, handler);
          }
          readonly isDisposed = false;
          dispose(): void {}
        }
      `
    },
    {
      // No enclosing class — an app-lifetime connection with nothing to leak.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        function activate(registry: ISettingRegistry): void {
          registry.pluginChanged.connect(onChanged);
        }
        function onChanged(): void {}
      `
    },
    {
      // The receiver's type is not a signal at all.
      filename: 'tests/type-aware-fixture.ts',
      code: `
        import { NotASignal } from './fixtures/not-a-signal';
        class Wiring {
          constructor(node: NotASignal) {
            node.connect(this._onEvent, this);
          }
          readonly isDisposed = false;
          dispose(): void {}
          private _onEvent(): void {}
        }
      `
    },
    {
      // additionalCleanupMethods: a project-specific teardown idiom.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        class Watcher implements IDisposable {
          constructor(registry: ISettingRegistry) {
            registry.pluginChanged.connect(this._onChanged, this);
          }
          readonly isDisposed = false;
          dispose(): void {
            this._teardown();
          }
          private _teardown(): void {}
          private _onChanged(): void {}
        }
      `,
      options: [{ additionalCleanupMethods: ['_teardown'] }]
    },
    {
      // longLivedTypes replaces the built-in list, so ISettingRegistry is no
      // longer treated as application-lifetime.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        class Watcher implements IDisposable {
          constructor(registry: ISettingRegistry) {
            registry.pluginChanged.connect(this._onChanged, this);
          }
          readonly isDisposed = false;
          dispose(): void {}
          private _onChanged(): void {}
        }
      `,
      options: [{ longLivedTypes: ['IMyOwnService'] }]
    },
    {
      // `this` in a static member is the class object, not an instance. The
      // connection is made once rather than per instance, and an instance
      // dispose() is not where it would be undone.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        class Watcher implements IDisposable {
          static wire(registry: ISettingRegistry): void {
            registry.pluginChanged.connect(Watcher._onChanged, this);
          }
          readonly isDisposed = false;
          dispose(): void {}
          private static _onChanged(): void {}
        }
      `
    },
    {
      // Inside a nested regular function `this` is whatever the caller binds,
      // not the enclosing instance.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        class Watcher implements IDisposable {
          wire(registry: ISettingRegistry): void {
            function inner(this: unknown): void {
              registry.pluginChanged.connect(() => {}, this);
            }
            inner();
          }
          readonly isDisposed = false;
          dispose(): void {}
        }
      `
    },
    {
      // The enclosing class's own type is on the allowlist. `this` cannot
      // outlive itself, so a connection to one of its own fields proves
      // nothing about lifetimes.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        class ServiceManager implements IDisposable {
          constructor(shell: IShell) {
            this._shell = shell;
            this._shell.currentChanged.connect(this._onChanged, this);
          }
          readonly isDisposed = false;
          dispose(): void {}
          private _onChanged(): void {}
          private _shell: IShell;
        }
      `,
      options: [{ longLivedTypes: ['ServiceManager'] }]
    },
    {
      // Cleanup reached through a namespace import of `@lumino/signaling`.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        import * as signaling from '@lumino/signaling';
        class Watcher implements IDisposable {
          constructor(registry: ISettingRegistry) {
            registry.pluginChanged.connect(this._onChanged, this);
          }
          readonly isDisposed = false;
          dispose(): void {
            signaling.Signal.clearData(this);
          }
          private _onChanged(): void {}
        }
      `
    }
  ],
  invalid: [
    {
      // The core case: an allowlisted application-lifetime service, a class
      // that clearly has a teardown point, and no cleanup in it.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        class Watcher implements IDisposable {
          constructor(registry: ISettingRegistry) {
            registry.pluginChanged.connect(this._onChanged, this);
          }
          readonly isDisposed = false;
          dispose(): void {}
          private _onChanged(): void {}
        }
      `,
      errors: [
        {
          messageId: 'serviceOutlivesReceiver',
          data: { sender: 'registry', typeName: 'ISettingRegistry' }
        }
      ]
    },
    {
      // A dispose() member alone (no `implements IDisposable`) is enough of a
      // teardown point.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        class Watcher {
          constructor(themes: IThemeManager) {
            themes.themeChanged.connect(this._onThemeChanged, this);
          }
          dispose(): void {}
          private _onThemeChanged(): void {}
        }
      `,
      errors: [{ messageId: 'serviceOutlivesReceiver' }]
    },
    {
      // The service is reached through a field rather than a parameter.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        class Watcher implements IDisposable {
          constructor(registry: ISettingRegistry) {
            this._registry = registry;
            this._registry.pluginChanged.connect(this._onChanged, this);
          }
          readonly isDisposed = false;
          dispose(): void {}
          private _onChanged(): void {}
          private _registry: ISettingRegistry;
        }
      `,
      errors: [{ messageId: 'serviceOutlivesReceiver' }]
    },
    {
      // connect() inside an arrow inside a method still belongs to the class.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        class Watcher implements IDisposable {
          start(registry: ISettingRegistry): void {
            requestAnimationFrame(() => {
              registry.pluginChanged.connect(this._onChanged, this);
            });
          }
          readonly isDisposed = false;
          dispose(): void {}
          private _onChanged(): void {}
        }
      `,
      errors: [{ messageId: 'serviceOutlivesReceiver' }]
    },
    {
      // A custom longLivedTypes entry is honoured.
      filename: 'tests/type-aware-fixture.ts',
      code: `${PRELUDE}
        interface IMyOwnService {
          readonly changed: ISignal<IMyOwnService, void>;
        }
        class Watcher implements IDisposable {
          constructor(service: IMyOwnService) {
            service.changed.connect(this._onChanged, this);
          }
          readonly isDisposed = false;
          dispose(): void {}
          private _onChanged(): void {}
        }
      `,
      options: [{ longLivedTypes: ['IMyOwnService'] }],
      errors: [
        {
          messageId: 'serviceOutlivesReceiver',
          data: { sender: 'service', typeName: 'IMyOwnService' }
        }
      ]
    }
  ]
});
