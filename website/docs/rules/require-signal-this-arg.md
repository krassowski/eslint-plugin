# `require-signal-this-arg`

Require a `thisArg` when connecting a class method that references `this` to a Lumino signal.

## Why

Lumino's `ISignal.connect(callback, thisArg)` invokes the callback with `thisArg` as its receiver. When a class method is passed as a bare function reference, `signal.connect(this._onChanged)`, nothing binds `this` inside the callback to the instance, so any `this.` access in the method body throws or reads the wrong object when the signal fires.

A matching `thisArg` also matters for cleanup: `signal.disconnect(callback, thisArg)` and `Signal.clearData(thisArg)` only remove connections whose receiver matches. See the [JupyterLab signal patterns](https://jupyterlab.readthedocs.io/en/latest/developer/patterns.html#signals) for the recommended `.connect(this._onFoo, this)` idiom.

## Rule details

The rule reports `signal.connect(this.method)` calls - exactly one argument, where the argument is a reference to a member of the enclosing class, when the referenced method's body actually uses `this`. Usage inside nested arrow functions counts as arrows inherit `this` lexically; usage only inside nested regular `function`s does not.

A **suggestion** (editor quick-fix, not an autofix) is offered to append `, this` as the second argument. It is not an autofix because inserting a `thisArg` changes runtime behavior and should be reviewed.

The rule skips:

- arrow-function class properties — they capture `this` lexically and need no `thisArg`
- methods that never reference `this`
- getters and setters — `this.x` evaluates the accessor rather than referencing a function
- members not found in the enclosing class (possibly inherited) — skipped conservatively
- calls that already pass a second argument
- calls inside a nested regular function, where `this` is not the enclosing class at all, so `this.method` does not refer to the member of the same name

This rule only reports the shapes that break at runtime. Callbacks that work without a `thisArg` but leave the connection unclearable by the class's receiver-based cleanup are covered by the companion rule [prefer-signal-this-arg](../prefer-signal-this-arg); no call is reported by both rules.

If the reported callback is also torn down by a matching one-argument `signal.disconnect(this._onChanged)`, update that call to `disconnect(this._onChanged, this)` as well — Lumino matches connections on the exact `(signal, slot, thisArg)` triple.

When type information is available, receivers whose type does not resolve to Lumino's `ISignal`/`Signal` are ignored.

## Incorrect

```ts
class NotebookWatcher {
  constructor(model: IModel) {
    // this._onChanged uses `this` internally — it will not be bound
    // to this instance when the signal fires.
    model.changed.connect(this._onChanged);
  }

  private _onChanged(): void {
    this.update();
  }
}
```

## Correct

```ts
class NotebookWatcher {
  constructor(model: IModel) {
    model.changed.connect(this._onChanged, this);
  }

  private _onChanged(): void {
    this.update();
  }
}
```

```ts
// Arrow-function property: `this` is captured lexically, so there is no
// runtime bug. Passing the thisArg anyway lets Signal.clearData(this) remove
// the connection (see prefer-signal-this-arg).
class NotebookWatcher {
  constructor(model: IModel) {
    model.changed.connect(this._onChanged, this);
  }

  private _onChanged = (): void => {
    this.update();
  };
}
```

```ts
// Wrapping in an arrow also binds `this` lexically — again, the thisArg is
// what makes the connection removable by Signal.clearData(this).
class NotebookWatcher {
  constructor(model: IModel) {
    model.changed.connect((sender, args) => {
      this.handleChange(sender, args);
    }, this);
  }
}
```

## Options

This rule has no options.
