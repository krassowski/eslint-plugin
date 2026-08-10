# `prefer-signal-this-arg`

Pass a `thisArg` when connecting to a Lumino signal whose sender is proven to outlive the connecting class.

:::info Requires type information

This rule proves that a sender outlives its receiver by resolving the sender's type. Without [type-aware linting](https://typescript-eslint.io/getting-started/typed-linting/) configured it reports nothing at all.

:::

## Why

The [JupyterLab signal patterns](https://jupyterlab.readthedocs.io/en/latest/developer/patterns.html#signals) recommend making connections with `.connect(this._onFoo, this)` wherever possible. The `thisArg` is stored as the connection's **receiver**, and both `signal.disconnect(callback, thisArg)` and `Signal.clearData(thisArg)` match connections by receiver. A connection registered without a `thisArg` has no receiver, so `Signal.clearData(this)` in a `dispose()` method silently fails to remove it — the connection outlives the object and leaks, even though the callback itself works fine at runtime.

That only matters when the **sender outlives the receiver**. A connection to an object the class owns and disposes is collected along with it whether or not a receiver was recorded. So the rule reports a missing `thisArg` only where the sender is provably longer-lived and the class's own cleanup strategy is receiver-based — the exact combination where the cleanup that exists cannot work.

This rule is the companion to [require-signal-this-arg](../require-signal-this-arg). The two rules partition the missing-`thisArg` cases:

- a bare class-method reference whose body uses `this` is a **runtime bug** (the method's `this` is unbound when the signal fires) — flagged by `require-signal-this-arg`;
- every other one-argument `.connect(callback)` where the sender outlives the receiver is a **cleanup concern only** — flagged by this rule.

No call is ever reported by both rules.

## Rule details

The rule reports a one-argument `signal.connect(callback)` call only when **all** of the following hold:

1. The call is inside a class, in a position where `this` is an instance of it. A `static` member (`this` is the class object) and a nested regular function (`this` is whatever the caller binds) are both skipped: passing that `this` would not register the instance that receiver-based cleanup clears.
2. The signal is not named `disposed` — that signal fires as its own sender is torn down, so the connection is cleaned up sender-side.
3. It is not the runtime-bug case owned by `require-signal-this-arg`.
4. The callback shape is one a `thisArg` could actually help: an inline arrow or function expression, a method or property reference, or a `.bind()` call. Opaque callbacks are skipped.
5. There is no matching one-argument `.disconnect(callback)` anywhere in the file — Lumino matches connections by the exact `(signal, slot, thisArg)` triple, so adding `, this` would silently break a teardown that currently works.
6. **The fix is viable**: the class already relies on receiver-based cleanup, shown either by a `Signal.clearData(this)` / `Signal.disconnectReceiver(this)` / `Signal.disconnectAll(this)` / `Signal.disconnectBetween(sender, this)` call or a two-argument `.disconnect(callback, this)` in the class body, or by the class extending a Lumino `Widget` (whose `dispose()` calls `Signal.clearData(this)`). Without one, adding a `thisArg` would change disconnect matching and buy nothing.
7. **The sender is proven long-lived**, by one of two arguments:
   - **an application-lifetime service** — the sender's type resolves to an entry in the allowlist (see [Options](#options)), with no Lumino `Widget` hop between that entry and the signal (`shell.currentWidget.title.changed` is a widget reached _through_ a service, not a long-lived sender);
   - **a model behind a view** — the receiver extends a Lumino `Widget` and some segment of the sender path is model-like by name (`model`, `sharedModel`, `context`) or by type (a name ending in `Model` or `Context`). JupyterLab routinely recycles views over a stable model: notebook windowing, "New View for Notebook", output-area reuse.

   Neither argument ever matches the enclosing instance itself: a class whose own type name is on the allowlist, or whose own name ends in `Model`, cannot outlive itself, so only the path hanging off `this` is judged.

Everything the rule cannot place — a sender it cannot type, one the class constructs and disposes itself, the class's own signals — is silence.

A **suggestion** (editor quick-fix, not an autofix) is offered to append `, this`. For a `.bind(this)` callback the suggestion drops the bind and passes `this` to `connect()` instead; a `.bind()` onto anything else keeps its bound receiver and only gains `, this`, since rewriting it would change which object the callback runs against. These are suggestions rather than fixes because they change how the connection is matched at disconnect time and should be reviewed alongside the class's teardown.

## Incorrect

```ts
class SettingsPanel extends Widget {
  constructor(registry: ISettingRegistry) {
    super();
    // ISettingRegistry outlives this widget, and the inherited
    // Widget.dispose() cleans up by receiver — which this connection has none
    // of, so it survives disposal.
    registry.pluginChanged.connect(() => this.update());
  }
}
```

```ts
class NotebookView extends Widget {
  constructor(model: INotebookModel) {
    super();
    this._model = model;
    // The model outlives the views built on it.
    this._model.contentChanged.connect(() => this.update());
  }

  private _model: INotebookModel;
}
```

```ts
class SourcesBody extends Widget {
  constructor(service: IDebugger) {
    super();
    // `.bind()` returns a fresh function every call, so no disconnect() can
    // ever match this connection — only a thisArg can remove it.
    service.model.currentFrameChanged.connect(this._onFrameChanged.bind(this));
  }

  private _onFrameChanged(): void {
    /* ... */
  }
}
```

## Correct

```ts
class SettingsPanel extends Widget {
  constructor(registry: ISettingRegistry) {
    super();
    registry.pluginChanged.connect(() => this.update(), this);
  }
}
```

```ts
// A matching bare disconnect is already a working teardown. Adding `, this`
// to the connect() here would stop the disconnect() from matching.
class TableOfContentsFactory {
  createNew(widget: W, context: IContext): void {
    const updateTitle = () => {
      this.setTitle(context.localPath);
    };
    context.pathChanged.connect(updateTitle);

    widget.disposed.connect(() => {
      context.pathChanged.disconnect(updateTitle);
    });
  }
}
```

```ts
// The sender is constructed and disposed here, so it dies with the receiver
// and the missing thisArg costs nothing.
class Host extends Widget {
  constructor() {
    super();
    this._editor = createEditor();
    this._editor.ready.connect(() => this.update());
  }

  dispose(): void {
    this._editor.dispose();
    super.dispose();
  }

  private _editor: IEditor;
}
```

```ts
// Disposal wiring on a `disposed` signal is cleaned up sender-side.
class NotebookWatcher {
  constructor(content: Widget) {
    content.disposed.connect(() => this.dispose());
  }

  dispose(): void {
    /* ... */
  }
}
```

## Known limitations

The rule is tuned for precision over recall — it reports only what it can prove and stays silent otherwise:

- **Only allowlisted service types count** as application-lifetime. A service that is long-lived in your application but absent from `longLivedTypes` is silent; add it to the option.
- **The model/view argument requires the receiver to extend a Lumino `Widget`.** Classes that behave like views without being widgets (document adapters, controllers) are not covered by it.
- Cleanup that happens in another file — an owner disconnecting on the receiver's behalf — is invisible, and a matching one-argument disconnect elsewhere in the _project_ (rather than the same file) will not be seen.

## Options

- `longLivedTypes` (`string[]`): type names treated as application-lifetime services. **Replaces** the built-in list when provided. The default is:

  `CommandRegistry`, `IDebugger`, `IDocumentManager`, `ILSPConnection`, `ILabShell`, `ILanguageServerManager`, `IRenderMimeRegistry`, `ISettingRegistry`, `IShell`, `IStateDB`, `IThemeManager`, `ServiceManager`

```json
{
  "jupyter/prefer-signal-this-arg": [
    "warn",
    { "longLivedTypes": ["ISettingRegistry", "IMyAppService"] }
  ]
}
```
