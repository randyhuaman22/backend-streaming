'use strict';

// Array#push cannot grow an array beyond this length. No storage is preallocated.
var MAX_CAPACITY = 0xFFFFFFFF;

function noop() {}

function validateCapacity(value, name) {
    if (typeof value !== 'number') {
        throw new TypeError(name + ' must be a number');
    }
    if (value < 0 || value > MAX_CAPACITY || Math.floor(value) !== value) {
        throw new RangeError(name + ' must be an integer between 0 and 4294967295');
    }
}

function normalizeOptions(options) {
    var settings = Object.create(null);
    var hooks = ['prepare', 'reset', 'validate', 'dispose'];
    var flags = ['detectDuplicates', 'statistics'];
    var allowed = hooks.concat(flags);
    var i;
    var name;
    var value;

    if (options == null) {
        return settings;
    }
    if (typeof options !== 'object' || Array.isArray(options)) {
        throw new TypeError('options must be an object');
    }
    Object.keys(options).forEach(function (key) {
        if (allowed.indexOf(key) === -1) {
            throw new TypeError('unknown option: ' + key);
        }
    });
    for (i = 0; i < hooks.length; i += 1) {
        name = hooks[i];
        value = Object.prototype.hasOwnProperty.call(options, name) ? options[name] : undefined;
        if (value != null && typeof value !== 'function') {
            throw new TypeError(name + ' must be a function');
        }
        settings[name] = value;
    }
    for (i = 0; i < flags.length; i += 1) {
        name = flags[i];
        value = Object.prototype.hasOwnProperty.call(options, name) ? options[name] : undefined;
        if (value !== undefined && typeof value !== 'boolean') {
            throw new TypeError(name + ' must be a boolean');
        }
        settings[name] = value === true;
    }
    return settings;
}

function newCounters(size) {
    return {
        hits: 0,
        misses: 0,
        created: 0,
        retained: 0,
        rejected: 0,
        invalid: 0,
        disposed: 0,
        highWaterMark: size
    };
}

function count(pool, name) {
    if (pool._state.counters) {
        pool._state.counters[name] += 1;
    }
}

function assertMutable(pool) {
    if (pool._state.inHook) {
        throw new Error('pool mutation is not allowed inside lifecycle hooks');
    }
}

function invokeHook(pool, name, args) {
    var result;
    pool._state.inHook = true;
    try {
        result = pool._state.options[name].apply(pool, args);
        if (result != null && typeof result.then === 'function') {
            // Observe a rejected promise before reporting unsupported async use.
            // The hook has already run; its asynchronous work cannot be undone.
            try {
                result.then(noop, noop);
            } catch (ignored) {
                // Non-compliant thenables still receive the synchronous error.
            }
            throw new TypeError(name + ' must return synchronously');
        }
        return result;
    } finally {
        pool._state.inHook = false;
    }
}

function disposeValue(pool, value, reason) {
    if (pool._state.options.dispose) {
        invokeHook(pool, 'dispose', [value, reason]);
        count(pool, 'disposed');
    }
}

function createValue(pool, args) {
    var value = pool.constructor.apply(pool, args);
    count(pool, 'created');
    return value;
}

function containsValue(list, value) {
    var i;
    for (i = 0; i < list.length; i += 1) {
        // SameValueZero: NaN matches NaN, and +0 matches -0.
        if (list[i] === value || (list[i] !== list[i] && value !== value)) {
            return true;
        }
    }
    return false;
}

/**
 * An operation stopped after partial progress; cause is the original exception.
 * partial holds allocations for allocMany, free results for freeMany, or a
 * successful insertion count for preallocate. index is the failed iteration.
 * @constructor
 * @extends Error
 */
function BatchError(operation, index, partial, cause) {
    this.name = 'BatchError';
    this.message = operation + ' failed at index ' + index;
    this.operation = operation;
    this.index = index;
    this.partial = partial;
    this.cause = cause;
    if (Error.captureStackTrace) {
        Error.captureStackTrace(this, BatchError);
    }
}
BatchError.prototype = Object.create(Error.prototype);
BatchError.prototype.constructor = BatchError;

/**
 * clear() attempted all disposals; failures hold { index, value, error } entries.
 * removed is the total number detached before any disposal callbacks ran.
 * @constructor
 * @extends Error
 */
function DisposalError(removed, failures) {
    this.name = 'DisposalError';
    this.message = failures.length + ' disposal callback(s) failed';
    this.removed = removed;
    this.failures = failures;
    if (Error.captureStackTrace) {
        Error.captureStackTrace(this, DisposalError);
    }
}
DisposalError.prototype = Object.create(Error.prototype);
DisposalError.prototype.constructor = DisposalError;

/**
 * Create a bounded, first-in-first-out pool of reusable values.
 *
 * The limit applies to cached values, not to allocations or checked-out values.
 * Allocation invokes the factory when no eligible cached value remains;
 * preallocate() also invokes it explicitly. The factory receives the pool as
 * `this` and the supplied arguments. It is not invoked with `new`.
 *
 * @constructor
 * @param {*} name Descriptive metadata; not used to identify or share pools.
 * @param {number} max Integer cache capacity from 0 through 4294967295.
 * @param {Function|null} [factory] Produces a value on a cache miss. Defaults
 *   to a function returning undefined when omitted or null.
 * @param {Object} [options] Synchronous lifecycle hooks (prepare, reset,
 *   validate, dispose) and opt-in detectDuplicates/statistics flags.
 * @throws {TypeError} If called without new, max is not a number, or a supplied
 *   factory is not a function, or options are invalid.
 * @throws {RangeError} If max is not an integer within the supported range.
 */
function FreeList(name, max, factory, options) {
    if (!(this instanceof FreeList)) {
        throw new TypeError('FreeList must be called with new');
    }
    validateCapacity(max, 'max');
    if (factory != null && typeof factory !== 'function') {
        throw new TypeError('factory must be a function');
    }
    options = normalizeOptions(options);

    this.name = name;
    this.max = max;

    // Historical public fields: preserve their names and the array's identity.
    // In particular, instance.constructor is the factory, not the FreeList class.
    this.constructor = factory == null ? noop : factory;
    this.list = [];
    Object.defineProperty(this, '_state', {
        value: {
            options: options,
            inHook: false,
            counters: options.statistics ? newCounters(0) : null
        }
    });
}

/**
 * Take the oldest eligible cached value, or call the factory on a cache miss.
 *
 * With hooks disabled, cached values are returned unchanged. With hooks enabled,
 * validate/prepare receive (value, ...args) before a cached value is removed.
 * Thrown validation/preparation keeps the candidate cached; false validation
 * removes it before optional disposal.
 * Factory results and exceptions pass through unchanged; prepare is for hits.
 *
 * @param {...*} args Arguments forwarded to validation/preparation on a cache
 *   hit, or to the factory on a miss.
 * @returns {*} A cached value or the factory's result.
 */
FreeList.prototype.alloc = function () {
    var options = this._state.options;
    var value;
    var args;
    var valid;
    assertMutable(this);
    while (this.list.length > 0) {
        value = this.list[0];
        if (options.validate || options.prepare) {
            args = [value].concat(Array.prototype.slice.call(arguments));
            if (options.validate) {
                valid = invokeHook(this, 'validate', args);
                if (typeof valid !== 'boolean') {
                    throw new TypeError('validate must return a boolean');
                }
                if (!valid) {
                    this.list.shift();
                    count(this, 'invalid');
                    disposeValue(this, value, 'invalid');
                    continue;
                }
            }
            if (options.prepare) {
                invokeHook(this, 'prepare', args);
            }
        }
        count(this, 'hits');
        return this.list.shift();
    }
    count(this, 'misses');
    return createValue(this, arguments);
};

/**
 * Cache a value if capacity remains, applying an optional reset hook first.
 * Full-cache rejection invokes the optional disposer with reason 'full'.
 * Duplicate detection is optional and throws before reset or disposal.
 *
 * @param {*} value Value to make available for reuse, including undefined.
 * @returns {boolean} True if retained; false if the cache was already full.
 */
FreeList.prototype.free = function (value) {
    var options = this._state.options;
    var counters = this._state.counters;
    assertMutable(this);
    if (options.detectDuplicates && containsValue(this.list, value)) {
        count(this, 'rejected');
        throw new Error('value is already cached');
    }
    if (this.list.length >= this.max) {
        count(this, 'rejected');
        disposeValue(this, value, 'full');
        return false;
    }
    if (options.reset) {
        invokeHook(this, 'reset', [value]);
    }
    this.list.push(value);
    count(this, 'retained');
    if (counters && this.list.length > counters.highWaterMark) {
        counters.highWaterMark = this.list.length;
    }
    return true;
};

/**
 * Number of currently cached values, excluding checked-out values.
 * @name FreeList#size
 * @type {number}
 * @readonly
 */
Object.defineProperty(FreeList.prototype, 'size', {
    get: function () {
        return this.list.length;
    }
});

/**
 * Remove all cached references and invoke the optional disposer on every value.
 * The cache array's identity and the configured capacity are preserved.
 *
 * @returns {number} Number of removed values.
 * @throws {DisposalError} If any disposals fail, after attempting all of them.
 */
FreeList.prototype.clear = function () {
    var removed = this.list.length;
    var values;
    var failures = [];
    var i;
    assertMutable(this);
    if (this._state.options.dispose) {
        values = this.drain();
        for (i = 0; i < values.length; i += 1) {
            try {
                disposeValue(this, values[i], 'clear');
            } catch (error) {
                failures.push({ index: i, value: values[i], error: error });
            }
        }
        if (failures.length > 0) {
            throw new DisposalError(removed, failures);
        }
        return removed;
    }
    this.list.length = 0;
    return removed;
};

/**
 * Transfer all cached values to the caller in FIFO order, emptying the cache.
 * The caller may reuse or dispose of the returned values.
 *
 * @returns {Array} Removed values in allocation order.
 */
FreeList.prototype.drain = function () {
    assertMutable(this);
    return this.list.splice(0);
};

/**
 * Retain at most size cached values, preserving the oldest entries.
 * Does not change the configured capacity or dispose of removed values.
 * Validation completes before the cache is modified.
 *
 * @param {number} size Non-negative integer, at most 4294967295.
 * @returns {Array} Removed newest entries, in their original FIFO order.
 * @throws {TypeError} If size is not a number.
 * @throws {RangeError} If size is not an integer within the supported range.
 */
FreeList.prototype.trim = function (size) {
    assertMutable(this);
    validateCapacity(size, 'size');
    return this.list.splice(size);
};

/**
 * Change capacity, retaining the oldest values when shrinking the cache.
 * Increasing capacity does not create values or preallocate storage.
 * Validation completes before the capacity or cache is modified.
 *
 * @param {number} max New capacity, with the constructor's numeric constraints.
 * @returns {Array} Evicted values in their original FIFO order.
 * @throws {TypeError} If max is not a number.
 * @throws {RangeError} If max is not an integer within the supported range.
 */
FreeList.prototype.resize = function (max) {
    assertMutable(this);
    validateCapacity(max, 'max');
    this.max = max;
    return this.list.splice(max);
};

/**
 * Warm the cache toward a target occupancy using the factory and free().
 * Factory attempts are bounded by the initial deficit, even with reentrancy.
 * @param {number} size Target occupancy, between zero and current capacity.
 * @param {...*} args Arguments forwarded to each factory invocation.
 * @returns {number} Number of newly created values accepted into the cache.
 * @throws {BatchError} Contains the cause and partial insertion count. If a
 *   value was created, value/cached identify it and its current cache membership.
 */
FreeList.prototype.preallocate = function (size) {
    var args = Array.prototype.slice.call(arguments, 1);
    var budget;
    var added = 0;
    var i;
    var value;
    var created;
    var failure;
    assertMutable(this);
    validateCapacity(size, 'size');
    if (size > this.max) {
        throw new RangeError('size must not exceed the current capacity');
    }
    budget = Math.max(0, size - this.list.length);
    for (i = 0; i < budget && this.list.length < size; i += 1) {
        created = false;
        try {
            value = createValue(this, args);
            created = true;
            if (this.free(value)) {
                added += 1;
            }
        } catch (error) {
            failure = new BatchError('preallocate', i, added, error);
            failure.created = created;
            if (created) {
                failure.value = value;
                failure.cached = containsValue(this.list, value);
            }
            throw failure;
        }
    }
    return added;
};

/**
 * Allocate count values in order, forwarding the same arguments to each alloc.
 * @param {number} count Non-negative integer, at most 4294967295.
 * @param {...*} args Arguments forwarded to each allocation.
 * @returns {Array} Allocated values.
 * @throws {BatchError} Includes partial allocations, their ownership, and cause.
 */
FreeList.prototype.allocMany = function (count) {
    var args = Array.prototype.slice.call(arguments, 1);
    var values = [];
    var i;
    assertMutable(this);
    validateCapacity(count, 'count');
    for (i = 0; i < count; i += 1) {
        try {
            values.push(this.alloc.apply(this, args));
        } catch (error) {
            throw new BatchError('allocMany', i, values, error);
        }
    }
    return values;
};

/**
 * Free an array snapshot in order. Each result is the corresponding free result.
 * @param {Array} values Values to return to this pool.
 * @returns {Array} Booleans identifying values retained by the cache.
 * @throws {BatchError} Includes prior boolean results and the failed index/cause.
 */
FreeList.prototype.freeMany = function (values) {
    var results = [];
    var i;
    assertMutable(this);
    if (!Array.isArray(values)) {
        throw new TypeError('values must be an array');
    }
    values = values.slice();
    for (i = 0; i < values.length; i += 1) {
        try {
            results.push(this.free(values[i]));
        } catch (error) {
            throw new BatchError('freeMany', i, results, error);
        }
    }
    return results;
};

/** @returns {Object|null} An independent statistics snapshot, or null if disabled. */
FreeList.prototype.getStats = function () {
    var counters = this._state.counters;
    var snapshot;
    if (!counters) {
        return null;
    }
    snapshot = {};
    Object.keys(counters).forEach(function (key) {
        snapshot[key] = counters[key];
    });
    snapshot.size = this.list.length;
    snapshot.capacity = this.max;
    return snapshot;
};

/** Reset counters, retaining current occupancy as the initial high-water mark. */
FreeList.prototype.resetStats = function () {
    assertMutable(this);
    if (this._state.counters) {
        this._state.counters = newCounters(this.list.length);
    }
    return this.getStats();
};

// Support both require('freelist') and require('freelist').FreeList.
FreeList.FreeList = FreeList;
FreeList.BatchError = BatchError;
FreeList.DisposalError = DisposalError;

module.exports = FreeList;
