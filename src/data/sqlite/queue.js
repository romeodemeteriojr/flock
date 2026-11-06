// A tiny async mutex. node:sqlite is one synchronous connection, but the data
// interface is async, so without this the statements of two requests could
// interleave inside somebody else's transaction. Every top-level repository
// call and every whole transaction runs through one queue, one at a time.

export function createQueue() {
  let tail = Promise.resolve();
  let depth = 0;
  return {
    /**
     * Run fn after everything queued before it has finished.
     * @template T
     * @param {() => T | Promise<T>} fn
     * @returns {Promise<T>}
     */
    run(fn) {
      depth++;
      const result = tail.then(() => fn());
      const settled = result.then(() => { depth--; }, () => { depth--; });
      tail = settled;
      return result;
    },
    /** Number of queued or running jobs (for tests and diagnostics). */
    get size() { return depth; },
  };
}
