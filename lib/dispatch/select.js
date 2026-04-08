// Conclave dispatch selector.
//
// Picks a connected node to run a job on. Trivial v1 policy:
//   1. Filter by required runtime.
//   2. Filter by required labels (every label in spec.labels must be present
//      on the node — node may have additional labels).
//   3. Filter out nodes with no free capacity (running >= capacity).
//   4. Pick the least-loaded (smallest running count); break ties by smallest
//      load ratio (running / capacity), then by nodeId for determinism.
//
// Returns the chosen nodeId or null if nothing is eligible. The caller decides
// whether to reject the job, queue it, or fall back to a local runtime.

/**
 * @param {object} spec
 * @param {string} spec.runtime
 * @param {string[]} [spec.labels]
 * @param {Array<{nodeId,runtimes:string[],labels:string[],capacity:number,running:number}>} live
 * @returns {string|null}
 */
export function selectNode(spec, live) {
  const required = spec.labels || [];
  const candidates = (live || []).filter((n) => {
    if (!n.runtimes.includes(spec.runtime)) return false;
    for (const lbl of required) if (!n.labels.includes(lbl)) return false;
    if (n.running >= n.capacity) return false;
    return true;
  });

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.running !== b.running) return a.running - b.running;
    const ra = a.running / Math.max(1, a.capacity);
    const rb = b.running / Math.max(1, b.capacity);
    if (ra !== rb) return ra - rb;
    return a.nodeId < b.nodeId ? -1 : 1;
  });

  return candidates[0].nodeId;
}
