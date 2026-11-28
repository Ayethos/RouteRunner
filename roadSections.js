// Build junction-to-junction sections from routable OSM ways and their node IDs.
// Edges must already be filtered to the travel modes the app supports.
export function buildRoadSections(ways) {
  const neighbours = new Map();
  for (const way of ways) {
    for (let index = 1; index < way.nodes.length; index += 1) {
      const from = String(way.nodes[index - 1]);
      const to = String(way.nodes[index]);
      if (from === to) continue;
      if (!neighbours.has(from)) neighbours.set(from, new Set());
      if (!neighbours.has(to)) neighbours.set(to, new Set());
      neighbours.get(from).add(to);
      neighbours.get(to).add(from);
    }
  }

  const sections = [];
  const visited = new Set();
  const edgeKey = (from, to) => from < to ? `${from}:${to}` : `${to}:${from}`;
  const follow = (from, next) => {
    const nodes = [from];
    let previous = from;
    let current = next;
    while (!visited.has(edgeKey(previous, current))) {
      visited.add(edgeKey(previous, current));
      nodes.push(current);
      const connected = neighbours.get(current);
      if (connected.size !== 2) break;
      const other = [...connected].find((node) => node !== previous);
      previous = current;
      current = other;
    }
    if (nodes.length === 1) return;
    const first = nodes[0];
    const last = nodes.at(-1);
    const canonical = first < last || (first === last && nodes[1] < nodes.at(-2))
      ? nodes : [...nodes].reverse();
    // Parallel roads can share endpoints. Include the first interior node to distinguish them.
    const id = `junction-v1:${canonical[0]}:${canonical.at(-1)}:${canonical.length > 2 ? canonical[1] : '-'}`;
    sections.push({ id, nodes: canonical });
  };

  for (const [node, connected] of neighbours) {
    if (connected.size === 2) continue;
    for (const next of connected) follow(node, next);
  }

  // An isolated loop has no junction. Start it at its lowest node for a repeatable ID.
  for (const node of [...neighbours.keys()].sort()) {
    for (const next of [...neighbours.get(node)].sort()) follow(node, next);
  }
  return sections;
}
