# `require-signal-cleanup`

Require a cleanup path for a `signal.connect(callback, this)` whose sender is a proven application-lifetime service.

:::info Requires type information

This rule proves that a sender outlives its receiver by resolving the sender's type. Without [type-aware linting](https://typescript-eslint.io/getting-started/typed-linting/) configured it reports nothing at all.

:::

## Why

Lumino's `ISignal.connect(callback, thisArg)` subscribes forever: the connection is only removed by a matching `.disconnect()`, by `Signal.clearData(thisArg)`, or when the process ends. There is no automatic cleanup.

But a missing disconnect is only a bug when the **sender outlives the receiver**. If a class connects to a signal on an object it owns and disposes, the whole connection graph is collected together and nothing leaks — no teardown is needed. The leak happens in the other direction: a short-lived object connects to a long-lived one, is discarded, and the long-lived sender's connection table keeps it alive forever while its callback keeps firing on a logically dead instance.

So the rule does not ask "is there cleanup here?". It asks "is this sender provably longer-lived than the receiver?", and stays quiet whenever it cannot prove one.

## Rule details

The rule inspects `signal.connect(callback, this)` calls — two arguments, with `this` as the receiver, inside a class — and reports one only when **all** of the following hold:

1. **`this` is an instance of the enclosing class.** In a `static` member `this` is the class object, and inside a nested regular function it is whatever the caller binds; neither is an instance whose lifetime this rule reasons about, and neither is removed by a `Signal.clearData(this)` in `dispose()`.
2. The class has **no `extends` clause**. A base class such as Lumino's `Widget` already calls `Signal.clearData(this)` from its inherited `dispose()`, and that cleanup is invisible from the subclass body.
3. The class has a **disposal protocol**: it `implements` something ending in `Disposable`, or declares a non-static `dispose` or `isDisposed` member. Without one it is almost always a plugin-scope singleton whose lifetime already matches the services it connects to — and there is nowhere to put a disconnect anyway.
4. The signal is not named `disposed`. That signal fires as its own sender is torn down, so the connection dies with it; flagging it would contradict the fix the rule recommends.
5. The class shows **no cleanup evidence anywhere in its body** (see below).
6. The sender's type resolves to an entry in the **long-lived service allowlist** (see [Options](#options)), and no hop between that entry and the signal is a Lumino `Widget` — `shell.currentWidget.title.changed` is a widget reached through a service, not an application-lifetime sender. The enclosing instance itself never counts: a class whose own type name is on the allowlist cannot outlive itself, so `this._sub.changed.connect(...)` inside it is judged on `this._sub` alone.

Any of these counts as cleanup evidence and silences the whole class:

- a call to `Signal.clearData(...)`, `Signal.disconnectReceiver(...)`, `Signal.disconnectAll(...)`, `Signal.disconnectSender(...)`, or `Signal.disconnectBetween(...)` (reached through a renamed import of `Signal` from `@lumino/signaling`, or through a namespace import as `ns.Signal.clearData(...)`)
- any `.disconnect(...)` call — covers `dispose()` teardown as well as disconnect-before-reconnect idioms
- a call to any method listed in `additionalCleanupMethods`

Single-argument `.connect(callback)` calls are not this rule's domain; see [require-signal-this-arg](../require-signal-this-arg) and [prefer-signal-this-arg](../prefer-signal-this-arg).

## Incorrect

```ts
class SettingsWatcher implements IDisposable {
  constructor(registry: ISettingRegistry) {
    // ISettingRegistry lives for the whole application session. Nothing in
    // this class ever removes the connection, so every SettingsWatcher ever
    // created stays reachable from the registry.
    registry.pluginChanged.connect(this._onChanged, this);
  }

  readonly isDisposed = false;

  dispose(): void {
    // ...but no disconnect and no clearData.
  }

  private _onChanged(): void {
    /* ... */
  }
}
```

## Correct

```ts
// Receiver-based cleanup removes every connection made with `this`
class SettingsWatcher implements IDisposable {
  constructor(registry: ISettingRegistry) {
    registry.pluginChanged.connect(this._onChanged, this);
  }

  dispose(): void {
    Signal.clearData(this);
  }

  private _onChanged(): void {
    /* ... */
  }
}
```

```ts
// An explicit matching disconnect
class SettingsWatcher implements IDisposable {
  constructor(private _registry: ISettingRegistry) {
    _registry.pluginChanged.connect(this._onChanged, this);
  }

  dispose(): void {
    this._registry.pluginChanged.disconnect(this._onChanged, this);
  }

  private _onChanged(): void {
    /* ... */
  }
}
```

```ts
// Inherited cleanup: Widget.dispose() calls Signal.clearData(this)
class SettingsPanel extends Widget {
  constructor(registry: ISettingRegistry) {
    super();
    registry.pluginChanged.connect(this._onChanged, this);
  }

  private _onChanged(): void {
    /* ... */
  }
}
```

```ts
// The sender is owned and disposed here, so it dies with the receiver
class Host implements IDisposable {
  constructor() {
    this._editor = createEditor();
    this._editor.ready.connect(this._onReady, this);
  }

  dispose(): void {
    this._editor.dispose();
  }

  private _onReady(): void {
    /* ... */
  }

  private _editor: IEditor;
}
```

## Known limitations

The rule deliberately trades recall for precision — it is designed to report only connections it can prove leak, and to stay silent everywhere else:

- **Every subclass is skipped**, including ones whose base class does not clean up.
- **Classes without a disposal protocol are skipped**, so a genuinely leaking class that simply has no `dispose()` is missed.
- **Only allowlisted service types are reported.** A sender that is long-lived in your application but absent from `longLivedTypes` is silent; add it to the option.
- Any single piece of cleanup evidence silences the entire class, so a class that disconnects one signal but leaks another is not reported.
- Cleanup performed by another class, or in another file, is invisible; conversely a class that cleans up correctly but whose `dispose()` is never called by its owner is not reported.

## Options

- `longLivedTypes` (`string[]`): type names treated as application-lifetime services. **Replaces** the built-in list when provided. The default is:

  `CommandRegistry`, `IDebugger`, `IDocumentManager`, `ILSPConnection`, `ILabShell`, `ILanguageServerManager`, `IRenderMimeRegistry`, `ISettingRegistry`, `IShell`, `IStateDB`, `IThemeManager`, `ServiceManager`

- `additionalCleanupMethods` (`string[]`, default `[]`): additional method names (besides `disconnect`) that count as cleanup evidence when called anywhere in the class. Use this to whitelist project-specific teardown idioms.

```json
{
  "jupyter/require-signal-cleanup": [
    "warn",
    {
      "longLivedTypes": ["ISettingRegistry", "IMyAppService"],
      "additionalCleanupMethods": ["_stopObserving"]
    }
  ]
}
```
