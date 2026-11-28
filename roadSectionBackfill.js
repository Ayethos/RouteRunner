import { buildRoadSections } from './roadSections.js';

const EARTH_METERS_PER_DEGREE = 111_195;
const CELL_SIZE = 80;
const MAX_MATCH_DISTANCE = 14;
const AMBIGUITY_MARGIN = 3;
const SAMPLE_SPACING = 12;

const DRIVABLE = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified',
  'residential', 'living_street', 'motorway_link', 'trunk_link', 'primary_link',
  'secondary_link', 'tertiary_link',
]);

// Use a regional Overpass export with "out geom" so coordinates and node IDs
// stay paired. Shared node IDs, rather than crossing lines, define junctions.
export function readRoadNetwork(data) {
  const ways = [];
  const coordinates = new Map();
  for (const way of data.elements ?? []) {
    if (way.type !== 'way' || !DRIVABLE.has(way.tags?.highway) || !Array.isArray(way.nodes) ||
        way.nodes.length < 2 || way.nodes.length !== way.geometry?.length) continue;
    const access = way.tags.motor_vehicle ?? way.tags.vehicle ?? way.tags.access;
    if (access === 'private' || access === 'no' ||
        !way.geometry.every((point) => Number.isFinite(point?.lon) && Number.isFinite(point?.lat))) continue;
    ways.push({ nodes: way.nodes });
    way.nodes.forEach((node, index) => {
      const { lon, lat } = way.geometry[index];
      coordinates.set(String(node), [lon, lat]);
    });
  }
  return { ways, coordinates };
}

function localProjection(origin) {
  const lonScale = EARTH_METERS_PER_DEGREE * Math.cos(origin[1] * Math.PI / 180);
  return ([lon, lat]) => [
    (((lon - origin[0] + 540) % 360) - 180) * lonScale,
    (lat - origin[1]) * EARTH_METERS_PER_DEGREE,
  ];
}

function indexRoads(sections, coordinates, project) {
  const cells = new Map();
  const lengths = new Map();
  for (const section of sections) {
    let from = project(coordinates.get(section.nodes[0]));
    let offset = 0;
    for (const node of section.nodes.slice(1)) {
      const to = project(coordinates.get(node));
      const delta = [to[0] - from[0], to[1] - from[1]];
      const length = Math.hypot(...delta);
      if (length > 0) {
        const edge = { from, delta, length, offset, id: section.id };
        const keys = new Set();
        const samples = Math.ceil(length / (CELL_SIZE / 2));
        for (let sample = 0; sample <= samples; sample += 1) {
          const ratio = sample / samples;
          const x = Math.floor((from[0] + delta[0] * ratio) / CELL_SIZE);
          const y = Math.floor((from[1] + delta[1] * ratio) / CELL_SIZE);
          keys.add(`${x},${y}`);
        }
        for (const key of keys) {
          const edges = cells.get(key) ?? [];
          edges.push(edge);
          cells.set(key, edges);
        }
      }
      offset += length;
      from = to;
    }
    lengths.set(section.id, offset);
  }
  return { cells, lengths };
}

function matchSample(point, heading, cells) {
  const [x, y] = point.map((axis) => Math.floor(axis / CELL_SIZE));
  const candidates = new Map();
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (const edge of cells.get(`${x + dx},${y + dy}`) ?? []) {
        const [vx, vy] = edge.delta;
        const alignment = Math.abs((heading[0] * vx + heading[1] * vy) / edge.length);
        if (alignment < 0.8) continue;
        const along = ((point[0] - edge.from[0]) * vx + (point[1] - edge.from[1]) * vy) / edge.length;
        if (along < -3 || along > edge.length + 3) continue;
        const clamped = Math.max(0, Math.min(edge.length, along));
        const distance = Math.hypot(point[0] - edge.from[0] - vx * clamped / edge.length,
          point[1] - edge.from[1] - vy * clamped / edge.length);
        if (distance > MAX_MATCH_DISTANCE || distance >= (candidates.get(edge.id)?.distance ?? Infinity)) continue;
        candidates.set(edge.id, { id: edge.id, position: edge.offset + clamped, distance, alignment });
      }
    }
  }
  const [closest, second] = [...candidates.values()].sort((a, b) => a.distance - b.distance);
  if (!closest || (second && second.distance - closest.distance < AMBIGUITY_MARGIN)) return null;
  return closest;
}

function unionLength(intervals) {
  let total = 0;
  let end = 0;
  for (const [from, to] of intervals.sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, to - Math.max(from, end));
    end = Math.max(end, to);
  }
  return total;
}

// Preview-only. The caller retains all original lines, including unmatched ones.
export function previewRoadBackfill(lines, network) {
  const { ways, coordinates } = network;
  const origin = coordinates.values().next().value;
  if (!origin) throw new Error('No drivable road geometry in this extract');
  const project = localProjection(origin);
  const { cells, lengths } = indexRoads(buildRoadSections(ways), coordinates, project);
  const coverage = new Map();
  let unmatchedMeters = 0;
  for (const line of lines) {
    for (let index = 1; index < line.length; index += 1) {
      const from = project(line[index - 1]);
      const to = project(line[index]);
      const delta = [to[0] - from[0], to[1] - from[1]];
      const distance = Math.hypot(...delta);
      if (!distance) continue;
      const heading = delta.map((axis) => axis / distance);
      const slices = Math.ceil(distance / SAMPLE_SPACING);
      const traveled = distance / slices;
      for (let sample = 0; sample < slices; sample += 1) {
        const center = from.map((axis, dimension) => axis + heading[dimension] * traveled * (sample + 0.5));
        const match = matchSample(center, heading, cells);
        if (!match) {
          unmatchedMeters += traveled;
          continue;
        }
        const half = traveled * match.alignment / 2;
        const interval = [Math.max(0, match.position - half), Math.min(lengths.get(match.id), match.position + half)];
        const intervals = coverage.get(match.id) ?? [];
        intervals.push(interval);
        coverage.set(match.id, intervals);
      }
    }
  }
  return {
    sections: [...coverage.entries()].map(([id, intervals]) => ({
      id, coveredMeters: unionLength(intervals), sectionMeters: lengths.get(id),
    })),
    unmatchedMeters,
  };
}
