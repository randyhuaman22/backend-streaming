# freelist

A small, dependency-free CommonJS module for bounded FIFO reuse of JavaScript
values. Includes cache occupancy inspection, capacity changes, trimming,
clearing, and transfer of cached values back to the caller. Optional
lifecycle hooks add validation, reuse preparation, reset, and disposal.
Preallocation, batch operations, duplicate detection, and statistics are
also available.

```sh
npm install freelist
```

```js
var FreeList = require('freelist');
var pool = new FreeList('buffers', 32, function (size) {
    return Buffer.alloc(size);
});

var buffer = pool.alloc(1024); // Empty pool: calls the factory.
buffer.fill(0);                // Reset application state before reuse.
pool.free(buffer);             // true: retained for a later allocation.

var reused = pool.alloc(1024); // Returns the same buffer.
console.log(reused === buffer); // true
```

## API

### `new FreeList(name, max, [factory], [options])`

Creates an independent pool. No backing storage is preallocated.
The capacity range follows the [ECMAScript array length limit](https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-array-exotic-objects).

| Parameter | Contract |
| --- | --- |
| `name` | Descriptive metadata of any type; it does not identify a shared pool. |
| `max` | Number of values that may be cached: an integer from `0` to `4294967295`, the maximum JavaScript array length. |
| `factory` | Optional function called on a cache miss or during preallocation. Omitted or `null` means a function that returns `undefined`. |
| `options` | Optional object containing the hooks and boolean flags described below. Omitted or `null` preserves default behavior. |

`max` limits retained values, not the number of live values or factory calls.
With `max = 0`, every allocation calls the factory and every free returns `false`.

Construction throws `TypeError` when called without `new`, when `max` is not a
number, or when a supplied, non-null factory is not a function. Invalid numeric
capacities (including `NaN`, infinities, fractions, and out-of-range values) throw
`RangeError`. Invalid options and unknown option names throw `TypeError`. Inputs
are not coerced. Own option properties are copied when the pool is constructed;
inherited properties are ignored.

### `pool.alloc(...args)`

Removes and returns the oldest eligible cached value. By default, values are
returned unchanged: a cached 1024-byte buffer is returned even if the next call
requests 2048 bytes. Optional `validate` and `prepare` hooks can inspect allocation
arguments and reject or prepare cached values before reuse.

When the pool is empty, invokes `factory.apply(pool, args)` and returns its result.
The factory is a regular function call, not a `new` expression; wrap class
constructors in a factory function. Return values (including promises and
`undefined`) and thrown exceptions pass through unchanged. A factory failure
does not itself add a cached value; any side effects made by the factory remain.
Factories initialize fresh values; `validate` and `prepare` apply only to cache
hits. The pool does not await factory promises.

### `pool.free(value)`

Appends a value to the FIFO queue and returns `true` if space remains. A configured
`reset` hook runs before insertion. If the pool is full, the optional `dispose`
hook runs with reason `full`, then `free()` returns `false`. No cached value is
evicted. Every JavaScript value is accepted, including `null` and `undefined`.

By default, values are neither reset nor disposed, and duplicates are allowed.
Optional `detectDuplicates: true` rejects a value already in this pool before
either hook runs. This uses SameValueZero equality: object identity, `NaN` equals
`NaN`, and positive and negative zero compare equal. It does not track checked-out
values or their origin. After a successful free, the caller transfers the value
to the pool. Without a disposer, the caller handles cleanup of rejected values.

### Lifecycle hooks and duplicate detection

| Option | Invocation | Contract |
| --- | --- | --- |
| `reset` | `reset(value)` before caching a free value | Clear state for reuse. The return value is ignored. |
| `validate` | `validate(value, ...args)` for each cached allocation candidate | Return exactly `true` to accept or `false` to discard. |
| `prepare` | `prepare(value, ...args)` after successful validation, before removing the cached value | Initialize it for the new request. The return value is ignored. |
| `dispose` | `dispose(value, reason)` | Release a rejected or cleared value; reasons are `full`, `invalid`, and `clear`. |
| `detectDuplicates` | Boolean; default `false` | Reject a free if an equal value is already cached. |
| `statistics` | Boolean; default `false` | Enable the counters exposed by `getStats()`. |

All hooks run synchronously with the pool as `this`. A thenable return is rejected
with `TypeError`; asynchronous work started by a hook cannot be cancelled. A
non-boolean validation result also throws `TypeError`. A hook may read `size` and
`getStats()`, but calling a mutating method on the same pool from a hook throws.
Factory reentrancy remains supported. Direct mutation of pool fields bypasses
these guarantees and is unsupported.

```text
factory(args) --------------------------------------> caller
                                                       |
                                                free / reset
                                                       |
                                                       v
dispose <--- invalid / clear --- cache --- validate / prepare ---> caller
   ^
   +------------------ free when full -----------------------------+
```

```js
var FreeList = require('freelist');
var buffers = new FreeList('validated-buffers', 16, function (size) {
    return Buffer.alloc(size);
}, {
    validate: function (buffer, size) {
        return buffer.length >= size;
    },
    reset: function (buffer) {
        buffer.fill(0);
    },
    detectDuplicates: true,
    statistics: true
});

buffers.preallocate(4, 1024);
var pair = buffers.allocMany(2, 512);
buffers.freeMany(pair);
console.log(buffers.getStats().size); // 4
```

Failure and ownership rules are explicit:

| Failure | State and ownership |
| --- | --- |
| Duplicate free | Throws before reset/disposal; the cached value remains owned by the pool. |
| Reset throws | No insertion; the caller retains the value, including any mutations already made by reset. |
| Validation or preparation throws | The candidate remains at the head of the cache; hook mutations are not rolled back. |
| Validation returns `false` | The candidate is removed and optionally disposed; allocation continues to the next candidate. |
| Disposer throws for `full` | The supplied value was not cached; the exception propagates. |
| Disposer throws for `invalid` | The rejected candidate has already been removed; the exception propagates and allocation stops. |
| Disposer throws during `clear()` | The cache is already empty; remaining disposals are attempted before a `DisposalError` is thrown. |

`FreeList.DisposalError` extends `Error`. Its `removed` field is the total number
of removed values; `failures` contains `{ index, value, error }` for each failed
callback, in FIFO order. Hook exceptions can occur after partial resource cleanup;
retry policy belongs to the disposer implementation.

### Cache management

| Member | Result | Effect |
| --- | --- | --- |
| `pool.size` | Number | Read-only count of cached values; excludes checked-out values. |
| `pool.clear()` | Number removed | Empties the cache and invokes a configured disposer for each value. |
| `pool.drain()` | Array of removed values | Empties the cache and returns its values in FIFO order. |
| `pool.trim(size)` | Array of removed values | Keeps at most `size` entries, retaining the oldest ones. Capacity stays unchanged. |
| `pool.resize(max)` | Array of removed values | Changes capacity and evicts excess entries, retaining the oldest ones. |

`trim()` and `resize()` use the constructor's numeric range and error types.
Invalid arguments leave both capacity and contents unchanged. Trimming above
the current occupancy has no effect. Growing capacity creates no values and
preallocates no storage. Resizing to zero empties the cache and disables caching
until capacity is increased.

Returned arrays are independent of the pool's internal array; their elements
are the original values, not clones. Removed entries appear in their original
FIFO order. Every management operation preserves the internal array's identity,
does not invoke the factory, and leaves checked-out values untouched. `clear()`,
`drain()`, and `trim()` leave capacity unchanged.

```js
var FreeList = require('freelist');
var cache = new FreeList('numbers', 3, Number);
cache.free(10);
cache.free(20);
cache.free(30);

console.log(cache.size);       // 3
console.log(cache.resize(2));  // [30]
console.log(cache.drain());    // [10, 20]
console.log(cache.size);       // 0
```

`drain()`, `trim()`, and `resize()` transfer removed values to the caller without
invoking the disposer. `clear()` invokes the disposer when one is configured;
otherwise it only removes references. Removing references does not guarantee
immediate garbage collection.

### Preallocation and batches

| Method | Result |
| --- | --- |
| `preallocate(size, ...args)` | Number of newly created values accepted into the cache while filling toward target occupancy `size`. |
| `allocMany(count, ...args)` | Array of `count` allocations, each receiving the same arguments. |
| `freeMany(values)` | Boolean result for each free, processed in input order from an array snapshot. |

Counts use the constructor's non-negative integer range. A preallocation target
greater than current capacity throws `RangeError` before creating anything.
Preallocation below current occupancy does nothing. Each new value passes through
`free()`, including reset, duplicate detection, and overflow disposal. Factory
attempts are limited to the initial occupancy deficit, so a reentrant factory
that consumes cached values cannot make preallocation loop indefinitely. Its
return value counts successful insertions, not net occupancy growth.

Input validation completes before any batch operation starts. Runtime failures
stop a batch; earlier successes are not rolled back. `FreeList.BatchError` extends
`Error` and contains `operation`, the zero-based failing `index`, `cause`, and
`partial`:

| Operation | `partial` | Ownership on failure |
| --- | --- | --- |
| `allocMany` | Array of successful allocations | The caller owns these values and can release them explicitly. |
| `freeMany` | Array of prior boolean results | Each successful `true` transferred ownership; unprocessed inputs remain caller-owned. |
| `preallocate` | Number of successful insertions | Inserted values remain cached. `created` says whether the failing iteration produced a value; when true, `value` exposes it and `cached` reports its current membership. |

For `freeMany`, a `false` result has already invoked the disposer when configured.
Do not dispose that value a second time solely because the result is `false`.
For a preallocation failure with `created: true, cached: false`, the caller can
recover the exposed value; a failing hook may already have modified or partially
disposed it.

### Statistics

`getStats()` returns `null` when disabled, otherwise an independent snapshot:

| Field | Meaning |
| --- | --- |
| `hits` | Successful allocations from the cache, after validation/preparation. |
| `misses` | Allocation attempts that reach the factory, including factory failures. |
| `created` | Successful factory returns from allocation or preallocation; not a count of distinct identities. |
| `retained` | Successful insertions by `free()` or preallocation. |
| `rejected` | Full-cache frees and detected duplicate-free attempts. |
| `invalid` | Cached candidates removed after validation returned `false`. |
| `disposed` | Successfully completed disposer calls. |
| `highWaterMark` | Highest observed cache occupancy since construction or reset. |
| `size`, `capacity` | Current occupancy and capacity at snapshot time. |

`resetStats()` clears counters and initializes the high-water mark to current
occupancy, returning the new snapshot. It returns `null` when statistics are
disabled. Counters describe synchronous operations; a returned factory promise
counts as a factory return before it settles. Counters use JavaScript numbers
and are exact through `Number.MAX_SAFE_INTEGER`.

### Compatibility fields and exports

Both imports return the same constructor:

```js
var FreeList = require('freelist');
var LegacyFreeList = require('freelist').FreeList;
```

The historical public fields remain available:

| Field | Contents |
| --- | --- |
| `pool.name` | The supplied metadata. |
| `pool.max` | The cache capacity. |
| `pool.constructor` | The factory function, **not** the `FreeList` class. |
| `pool.list` | The actual array of cached values, in allocation order. |

Use `resize()` to change capacity. Treat `max`, `constructor`, and `list` as
inspection-only fields. Direct mutation bypasses the constructor's validation and can invalidate the documented capacity
and FIFO guarantees. The array's identity is preserved across allocations and
frees.

Existing FIFO order, callback context, optional factory behavior, and both export
forms are preserved. **Compatibility change:** invalid constructor inputs now
fail immediately rather than being coerced, silently misconfiguring the pool,
or failing later during allocation.

## Cost and lifetime

Let `n` be the number of cached values. Cache hits use `Array.prototype.shift()`
and may require O(n) element movement. Appending has amortized O(1) cost under the
usual dynamic-array model. Cache misses add the factory's execution cost. These
are algorithmic estimates, not JavaScript engine latency guarantees. The pool
holds O(n) references in addition to the memory retained by the values themselves.

Reading `size` takes O(1) time and space. Under the same array model, `drain()`
takes O(n) time and O(n) additional space for its result; `trim()` and `resize()`
take O(k + 1) time and additional space for `k` removed values. `clear()` requires
at most O(n) reference removal and no result array. These bounds exclude garbage
collection and memory retained by the values themselves.

Duplicate detection adds O(n) work to each free when enabled. Hooks add their own
cost; allocation can examine up to `n` invalid candidates, with O(n^2) worst-case
array shifting across those removals. Statistics snapshots have O(1) size. Batch
cost is the sum of the individual operation costs, with O(count) result storage.
Preallocation performs at most the initial deficit's number of factory/free
attempts. Clearing with a disposer adds O(n) callback invocations and may retain
O(n) failure records. No timing guarantees are implied by these bounds.

The array-based implementation preserves the public `list` interface and FIFO
behavior. Cached objects remain strongly referenced until allocated, removed by
application code, or the pool itself becomes unreachable. This module provides
no asynchronous scheduling or ownership tracking for checked-out values.

## Development

Run the regression suite with Node.js 20 or newer using the built-in
[Node.js test runner](https://nodejs.org/api/test.html); no dependencies are needed:

```sh
npm test
```

Tests cover both exports, FIFO reuse, bounded capacity, callback context and
arguments, all value types, exception propagation, independent pools, constructor
validation, all cache-management operations, lifecycle and batch failure paths,
duplicate detection, statistics, and 60000 deterministic operations against
bounded FIFO and lifecycle models.

## License

MIT. See [LICENSE](LICENSE) for the full text.
