import AccountGate from './AccountGate';
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { View, Text, Pressable, StyleSheet, Alert, SafeAreaView, Modal, ScrollView, Platform, TextInput, NativeModules, Image, useWindowDimensions } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import { useKeepAwake } from 'expo-keep-awake';
import * as TaskManager from 'expo-task-manager';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import Svg, { Path, Polyline } from 'react-native-svg';
import { captureRef, releaseCapture } from 'react-native-view-shot';
import AsyncStorage from '@react-native-async-storage/async-storage';
import MapLibreGL from '@maplibre/maplibre-react-native';

// ---- Design tokens -------------------------------------------------------
const PINK = '#FF2D95';
const ROAD_WHITE = '#FFFFFF';
const PANEL = 'rgba(20,20,22,0.92)';

const MAP_STYLES = {
  dark: 'https://tiles.openfreemap.org/styles/dark',
  light: 'https://tiles.openfreemap.org/styles/positron',
};
const MAP_THEME_KEY = 'map-theme:v1';
const SIMPLIFIED_MAP_KEY = 'simplified-map:v1';

function simplifyMapStyle(style) {
  if (style?.version !== 8 || !style.sources || !Array.isArray(style.layers)) {
    throw new Error('Invalid map style');
  }
  const hideLayers = new Set(['road_area_pier', 'road_pier', 'road_oneway', 'road_oneway_opposite']);
  const publicRoads = ['!', ['in', ['get', 'class'], ['literal', ['service', 'path', 'track']]]];
  return {
    ...style,
    layers: style.layers.filter((layer) =>
      !['building', 'poi'].includes(layer['source-layer']) && !hideLayers.has(layer.id))
      .map((layer) => !['transportation', 'transportation_name'].includes(layer['source-layer']) ? layer : {
        ...layer,
        filter: layer.filter ? ['all', layer.filter, publicRoads] : publicRoads,
      }),
  };
}

const TRAIL_KEY = 'trail:matched:v1';
const MATCH_INTERVAL_MS = 30_000;
const LIVE_SPEED_MAX_AGE_MS = 3000;

function liveSpeedSample(location, rideStart, now) {
  const { speed, accuracy } = location.coords;
  if (!Number.isFinite(speed) || speed < 0 || !(accuracy > 0 && accuracy <= 30) ||
      !Number.isFinite(location.timestamp) || location.timestamp < rideStart ||
      now - location.timestamp > LIVE_SPEED_MAX_AGE_MS) return null;
  return { speed, timestamp: location.timestamp };
}
const GEOAPIFY_TEST_KEY = process.env.EXPO_PUBLIC_GEOAPIFY_TEST_KEY?.trim();
const ROUTES_KEY = 'routes:v1';
const DISCOVERY_PERMISSION_KEY = 'discovery-permission:v1';
const QUICK_PLACES_KEY = 'quick-places:v1';
const RIDES_KEY = 'rides:v1';
const BACKGROUND_TASK = 'route-runner-ride-location';
const ACTIVE_RIDE_KEY = 'active-ride:v1';

let backgroundWrites = Promise.resolve();
TaskManager.defineTask(BACKGROUND_TASK, async ({ data, error }) => {
  if (error || !data?.locations?.length) return;
  const write = backgroundWrites.then(async () => {
    const raw = await AsyncStorage.getItem(ACTIVE_RIDE_KEY);
    if (!raw) return;
    const session = JSON.parse(raw);
    const locations = data.locations.filter((location) => location.timestamp >= session.startedAt);
    if (!locations.length) return;
    const key = `${ACTIVE_RIDE_KEY}:${session.startedAt}`;
    const saved = await AsyncStorage.getItem(key);
    const points = saved ? JSON.parse(saved) : [];
    await AsyncStorage.setItem(key, JSON.stringify([...points, ...locations]));
  });
  backgroundWrites = write.catch(() => {});
  await write;
});

// ---- Helpers -------------------------------------------------------------
const toRad = (d) => (d * Math.PI) / 180;
function distM(a, b) {
  const R = 6371000;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const fc = (lines) => ({
  type: 'FeatureCollection',
  features: lines
    .filter((l) => l.length > 1)
    .map((l) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: l } })),
});
function splitRecordedPath(points) {
  const lines = [];
  let previous;
  for (const point of points ?? []) {
    if (!previous || distM(previous, point) > 200) lines.push([]);
    lines[lines.length - 1].push(point);
    previous = point;
  }
  return lines.filter((line) => line.length > 1);
}

const fmtTime = (s) => {
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
};
const settings = NativeModules.SettingsManager?.settings;
const locale = settings?.AppleLocale ?? settings?.AppleLanguages?.[0] ??
  Intl.DateTimeFormat().resolvedOptions().locale;
const region = locale.split(/[-_@]/).slice(1).find((part) => /^[A-Z]{2}$/.test(part));
const useMiles = region === 'US' || region === 'GB';
const distanceUnit = useMiles ? 'mi' : 'km';
const speedUnit = useMiles ? 'mph' : 'km/h';
const formatDistance = (meters) => `${(meters / (useMiles ? 1609.344 : 1000)).toFixed(2)} ${distanceUnit}`;
function formatTurnDistance(meters) {
  const distance = Math.max(0, meters);
  if (useMiles && distance < 160.9344) return `${Math.round(distance / 9.144) * 10} yd`;
  if (!useMiles && distance < 1000) return `${Math.round(distance / 10) * 10} m`;
  return `${(distance / (useMiles ? 1609.344 : 1000)).toFixed(1)} ${distanceUnit}`;
}

function maneuverArrow(type) {
  if (type?.startsWith('DestinationReached')) return '⚑';
  if (type === 'Roundabout') return '⟳';
  if (type === 'TurnAroundLeft') return '↶';
  if (type === 'TurnAroundRight') return '↷';
  if (type === 'Left' || type === 'SharpLeft') return '↰';
  if (type === 'Right' || type === 'SharpRight') return '↱';
  if (type?.endsWith('Left')) return '↖';
  if (type?.endsWith('Right')) return '↗';
  return type === 'Straight' || type === 'StartAt' || type === 'Merge' ? '↑' : '•';
}

const formatSpeed = (metersPerSecond) => `${Math.max(0, Math.round((metersPerSecond || 0) * (useMiles ? 2.236936 : 3.6)))} ${speedUnit}`;
const averageSpeed = ({ meters, seconds }) => seconds > 0 ? meters / seconds : 0;

async function matchRoads(samples) {
  const waypoints = samples.map(({ point, seconds }) => ({
    location: point,
    timestamp: new Date(seconds * 1000).toISOString(),
  }));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const url = `https://api.geoapify.com/v1/mapmatching?apiKey=${encodeURIComponent(GEOAPIFY_TEST_KEY)}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'drive', waypoints }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('Road matching request failed');
    const result = await response.json();
    return (result.features ?? []).flatMap(({ geometry, properties }) => {
      const matched = (properties?.waypoints ?? []).filter(({ match_type, match_distance }) =>
        match_type === 'matched' && Number.isFinite(match_distance) && match_distance <= 35
      );
      if (matched.length < 2 || geometry?.type !== 'MultiLineString') return [];
      const roads = (properties.legs ?? []).flatMap((leg, index) =>
        (leg.steps ?? []).flatMap((step) => {
          const id = step.osm_way_id;
          const line = geometry.coordinates[index]?.slice(step.from_index, step.to_index + 1);
          return id && line?.length > 1 ? [{ id: String(id), line }] : [];
        })
      );
      const lines = geometry.coordinates.filter((line) =>
        line.length > 1 && line.every(([lon, lat]) =>
          Number.isFinite(lon) && Math.abs(lon) <= 180 &&
          Number.isFinite(lat) && Math.abs(lat) <= 90)
      );
      return [{ lines, roads }];
    });
  } finally {
    clearTimeout(timeout);
  }
}

function routeOffsets(lines) {
  let meters = 0;
  return lines.map((line) => line.map((point, index) => {
    if (index) meters += distM(line[index - 1], point);
    return meters;
  }));
}

function remainingRouteLines(lines, offsets, progress) {
  return lines.flatMap((line, leg) => {
    const legOffsets = offsets[leg];
    if (progress >= legOffsets.at(-1)) return [];
    if (progress <= legOffsets[0]) return [line];
    const next = legOffsets.findIndex((meters) => meters > progress);
    const [lon, lat] = line[next - 1];
    const [nextLon, nextLat] = line[next];
    const share = (progress - legOffsets[next - 1]) / (legOffsets[next] - legOffsets[next - 1]);
    const deltaLon = ((nextLon - lon + 540) % 360) - 180;
    const start = [((lon + deltaLon * share + 540) % 360) - 180, lat + (nextLat - lat) * share];
    return [[start, ...line.slice(next)]];
  });
}

function locateOnRoute(point, lines, offsets, previous) {
  const lonScale = 111_195 * Math.cos(toRad(point[1]));
  const project = ([lon, lat]) => [
    (((lon - point[0] + 540) % 360) - 180) * lonScale,
    (lat - point[1]) * 111_195,
  ];
  let nearest = { distance: Infinity, meters: previous };
  for (const [lineIndex, line] of lines.entries()) {
    let [ax, ay] = project(line[0]);
    for (let index = 1; index < line.length; index += 1) {
      const vertex = line[index];
      const [bx, by] = project(vertex);
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSquared = dx * dx + dy * dy;
      const ratio = lengthSquared ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared)) : 0;
      const distance = Math.hypot(ax + ratio * dx, ay + ratio * dy);
      const [start, end] = [offsets[lineIndex][index - 1], offsets[lineIndex][index]];
      const meters = start + ratio * (end - start);
      if (distance < nearest.distance - 5 ||
          (distance <= nearest.distance + 5 && Math.abs(meters - previous) < Math.abs(nearest.meters - previous))) {
        nearest = { distance, meters };
      }
      [ax, ay] = [bx, by];
    }
  }
  return nearest;
}

async function planRoadRoute(points, includeSurfaces = false, throughStops = false) {
  // The Routing API takes latitude first. The response uses GeoJSON order.
  const waypoints = points.map(([lon, lat]) => `${lat},${lon}`).join('|');
  const query = `waypoints=${encodeURIComponent(waypoints)}&mode=drive&traffic=approximated&format=geojson&details=instruction_details${includeSurfaces ? ',route_details' : ''}${throughStops && points.length > 2 ? '&intermediate_waypoint_mode=through_stop' : ''}&apiKey=${encodeURIComponent(GEOAPIFY_TEST_KEY)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`https://api.geoapify.com/v1/routing?${query}`, {
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('Route request failed');
    const result = await response.json();
    const feature = result.features?.[0];
    const geometry = feature?.geometry;
    if (geometry?.type !== 'MultiLineString') return { lines: [], steps: [] };
    const offsets = routeOffsets(geometry.coordinates);
    const steps = (feature.properties?.legs ?? []).flatMap((leg, index) =>
      (leg.steps ?? []).flatMap((step) => {
        const point = geometry.coordinates[index]?.[step.from_index];
        return point && step.instruction?.text ? [{ point, text: step.instruction.text, type: step.instruction.type, meters: offsets[index][step.from_index] }] : [];
      })
    );
    const unsealed = (feature.properties?.legs ?? []).flatMap((leg) => leg.steps ?? [])
      .reduce((meters, step) => (
        ['compacted', 'dirt', 'gravel', 'path', 'impassable'].includes(step.surface) ? meters + (step.distance ?? 0) : meters
      ), 0);
    return { lines: geometry.coordinates.filter((line) => line.length > 1), steps, seconds: feature.properties?.time, unsealed, legs: feature.properties?.legs ?? [] };
  } finally {
    clearTimeout(timeout);
  }
}

function routeTiming(offsets, legs) {
  if (legs?.length !== offsets.length) return [];
  return offsets.flatMap((points, index) => {
    const leg = legs[index];
    const from = points[0];
    const to = points.at(-1);
    const steps = (leg.steps ?? []).map((step) => ({
      from: points[step.from_index], to: points[step.to_index], seconds: step.time,
    }));
    const complete = steps.length > 0 && steps[0].from === from && steps.at(-1).to === to &&
      steps.every((step, position) => Number.isFinite(step.from) && Number.isFinite(step.to) &&
        step.to >= step.from && Number.isFinite(step.seconds) && step.seconds >= 0 &&
        (!position || step.from === steps[position - 1].to));
    if (complete && steps.some((step) => step.seconds > 0)) return steps;
    return [{ from, to, seconds: leg.time }];
  });
}

function remainingTravelSeconds({ timing, seconds, totalMeters, progress }) {
  if (!(seconds > 0) || !(totalMeters > 0)) return null;
  const scheduled = timing?.reduce((sum, segment) => sum + segment.seconds, 0);
  if (!(scheduled > 0) || timing.some((segment) => !Number.isFinite(segment.seconds) || segment.seconds < 0)) {
    return seconds * (1 - progress / totalMeters);
  }
  const remaining = timing.reduce((sum, { from, to, seconds: duration }) => {
    if (progress >= to) return sum;
    if (progress <= from) return sum + duration;
    return sum + duration * (to - progress) / (to - from);
  }, 0);
  return remaining * seconds / scheduled;
}

async function buildDirections(here, remaining, plannedRoute, throughStops = false) {
  const { lines, steps: instructions, seconds, legs } = plannedRoute ?? await planRoadRoute([here, ...remaining], false, throughStops);
  const steps = [...instructions];
  if (!lines.length || !steps.length) return null;
  const offsets = routeOffsets(lines);
  const totalMeters = offsets.at(-1).at(-1);
  const end = lines.at(-1).at(-1);
  if (totalMeters - steps.at(-1).meters > 10) {
    steps.push({ point: end, meters: totalMeters, type: 'DestinationReached', text: 'Continue to your destination' });
  }
  return {
    lines, steps, remaining, offsets, totalMeters, seconds, timing: routeTiming(offsets, legs), progress: 0, throughStops,
    index: steps.length > 1 && distM(here, steps[0].point) <= 35 ? 1 : 0,
  };
}

function offsetPoint([lon, lat], bearing, meters) {
  const arc = meters / 6_371_000;
  const latitude = toRad(lat);
  const angle = toRad(bearing);
  const targetLat = Math.asin(Math.sin(latitude) * Math.cos(arc) +
    Math.cos(latitude) * Math.sin(arc) * Math.cos(angle));
  const targetLon = toRad(lon) + Math.atan2(Math.sin(angle) * Math.sin(arc) * Math.cos(latitude),
    Math.cos(arc) - Math.sin(latitude) * Math.sin(targetLat));
  return [((targetLon * 180 / Math.PI + 540) % 360) - 180, targetLat * 180 / Math.PI];
}

function trailCells(lines) {
  const cells = new Set();
  for (const line of lines) {
    for (let index = 1; index < line.length; index += 1) {
      const [lon, lat] = line[index - 1];
      const [nextLon, nextLat] = line[index];
      const deltaLon = ((nextLon - lon + 540) % 360) - 180;
      const samples = Math.max(1, Math.ceil(distM(line[index - 1], line[index]) / 65));
      for (let sample = 0; sample <= samples; sample += 1) {
        const ratio = sample / samples;
        const longitude = ((lon + deltaLon * ratio + 540) % 360) - 180;
        cells.add(`${Math.floor(longitude * 1000)},${Math.floor((lat + (nextLat - lat) * ratio) * 1000)}`);
      }
    }
  }
  return cells;
}

const LOOP_MODES = [
  { minutes: 30, color: '#54FF91' },
  { minutes: 60, color: '#4BD9FF' },
  { minutes: 90, color: '#FF526B' },
];

const MAIN_ROAD_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary']);

function loopBacktracking({ lines, legs, steps }) {
  const seen = new Set();
  const pointKey = (point) => point.map((coordinate) => coordinate.toFixed(5)).join(',');
  let repeated = 0;
  let distance = 0;
  let previousEdge;
  let reverses = steps.some(({ type }) => type === 'TurnAroundLeft' || type === 'TurnAroundRight');

  for (const [legIndex, line] of lines.entries()) {
    const roadSteps = legs?.[legIndex]?.steps ?? [];
    let legStep = 0;
    for (let index = 1; index < line.length; index += 1) {
      const from = pointKey(line[index - 1]);
      const to = pointKey(line[index]);
      if (from === to) continue;
      const key = from < to ? `${from}|${to}` : `${to}|${from}`;
      const meters = distM(line[index - 1], line[index]);
      while (legStep + 1 < roadSteps.length && roadSteps[legStep + 1].from_index <= index - 1) legStep += 1;
      const mainRoad = MAIN_ROAD_CLASSES.has(roadSteps[legStep]?.road_class);
      if (previousEdge?.from === to && previousEdge.to === from && meters >= 5) reverses = true;
      if (seen.has(key)) repeated += meters * (mainRoad ? 0.25 : 1);
      seen.add(key);
      distance += meters;
      previousEdge = { from, to };
    }
  }
  return { reverses, repeatRatio: distance ? repeated / distance : 1 };
}

async function findExploreLoop(here, minutes, preferSealed, unlocked) {
  const radius = minutes * 190;
  const evaluate = async (heading, scale, spread) => {
    const reach = radius * scale;
    const waypoints = [here, offsetPoint(here, heading, reach), offsetPoint(here, heading + spread, reach), here];
    const route = await planRoadRoute(waypoints, true, true);
    if (!route.lines.length || !route.steps.length || !(route.seconds > 0)) return null;
    const { reverses, repeatRatio } = loopBacktracking(route);
    if (reverses || repeatRatio > 0.35) return null;
    const cells = trailCells(route.lines);
    if (cells.size < 4) return null;
    const novel = [...cells].filter((cell) => !unlocked.has(cell)).length / cells.size;
    const minutesOff = Math.abs(route.seconds / 60 - minutes) / minutes;
    const sealedPenalty = preferSealed ? Math.min(2, route.unsealed / 1000) : 0;
    const meters = routeOffsets(route.lines).at(-1).at(-1);
    return { route, waypoints, novel, cells, minutesOff, sealedPenalty, meters, repeatRatio };
  };
  const collect = async (headings, scales, spreads) => {
    const attempts = await Promise.allSettled(headings.map((heading, index) => evaluate(heading, scales[index], spreads[index])));
    return attempts.flatMap((attempt) => attempt.status === 'fulfilled' && attempt.value ? [attempt.value] : []);
  };
  const first = await collect([0, 90, 180, 270], [0.85, 1.25, 0.85, 1.25], [65, 65, 65, 65]);
  if (first.length) return first;
  const alternatives = await collect([45, 135, 225, 315], [0.68, 0.95, 0.68, 0.95], [80, 100, 80, 100]);
  if (alternatives.length || minutes !== 90) return alternatives;
  return collect([20, 110, 200, 290], [0.48, 0.55, 0.48, 0.55], [125, 135, 125, 135]);
}

async function findExploreOverview(here, preferSealed, unlockedLines) {
  const unlocked = trailCells(unlockedLines);
  const options = [];
  for (const mode of LOOP_MODES) {
    const candidates = await findExploreLoop(here, mode.minutes, preferSealed, unlocked);
    const nearTarget = candidates.filter(({ minutesOff }) => minutesOff <= 0.3);
    const eligible = nearTarget.length ? nearTarget : candidates;
    const distinct = eligible.filter(({ cells }) => !options.some((option) => {
      const overlap = [...cells].filter((cell) => option.cells.has(cell)).length;
      return overlap / Math.max(cells.size, option.cells.size) > 0.9;
    }));
    const pool = distinct.length ? distinct : eligible;
    const score = ({ novel, minutesOff, sealedPenalty, repeatRatio }) =>
      novel * 2 - minutesOff * 1.5 - sealedPenalty - repeatRatio * 5;
    const best = pool.sort((a, b) => score(b) - score(a))[0];
    if (best) options.push({ ...mode, ...best });
  }
  return options;
}

const exploreShade = {
  type: 'FeatureCollection',
  features: [-180, -90, 0, 90].map((west) => ({
    type: 'Feature', properties: {},
    geometry: { type: 'Polygon', coordinates: [[[west, -85], [west + 90, -85], [west + 90, 85], [west, 85], [west, -85]]] },
  })),
};

// ---- App -----------------------------------------------------------------
export default function App() {
  const backupActions = useRef(null);
  return <AccountGate backupActions={backupActions}>{(openAccount) => (
    <RouteRunner openAccount={openAccount} backupActions={backupActions} />
  )}</AccountGate>;
}

function RouteRunner({ openAccount, backupActions }) {
  const cameraRef = useRef(null);
  const startupCameraPending = useRef(true);
  const [startupLocation, setStartupLocation] = useState(null);
  const [hasLiveLocation, setHasLiveLocation] = useState(false);
  const [locatingStartup, setLocatingStartup] = useState(true);
  const knownRoads = useRef(new Set());
  const rideUnlocks = useRef(new Map());
  const rideMatchingFailed = useRef(false);
  const trailRef = useRef([]); // array of line segments
  const lastPtRef = useRef(null);
  const pendingSamples = useRef([]);
  const discoveryRevision = useRef(0);
  const discoveryAllowed = useRef(false);
  const discoveryPrompted = useRef(false);
  const [discoveryChoice, setDiscoveryChoice] = useState(undefined);
  const matchQueue = useRef(Promise.resolve());
  const offlineBatches = useRef([]);
  const appliedRideBatches = useRef(new Set());
  const unstoredBatches = useRef(new Map());
  const retryMatchingAt = useRef(0);
  const matchingActive = useRef(false);
  const [pendingMatches, setPendingMatches] = useState(0);
  const [matchingFailed, setMatchingFailed] = useState(false);
  const [trailLoaded, setTrailLoaded] = useState(false);

  const [trail, setTrail] = useState([]);
  const [routes, setRoutes] = useState([]);
  const [rides, setRides] = useState([]);
  const rideWrites = useRef(Promise.resolve());
  const [libraryView, setLibraryView] = useState(null);
  const [simplifiedMap, setSimplifiedMap] = useState(null);
  const [mapTheme, setMapTheme] = useState(null);
  const [savingMapTheme, setSavingMapTheme] = useState(false);
  const [simplifiedStyles, setSimplifiedStyles] = useState({});
  const theme = mapTheme ?? 'dark';
  const lightMap = theme === 'light';
  const simplifiedStyle = simplifiedStyles[theme];
  const [simplifiedStyleFailed, setSimplifiedStyleFailed] = useState(false);
  const [styleAttempt, setStyleAttempt] = useState(0);
  const [rideMenu, setRideMenu] = useState(null);
  const [recapRide, setRecapRide] = useState(null);
  const [shareRide, setShareRide] = useState(null);
  const [explore, setExplore] = useState(false);
  const [exploreLoops, setExploreLoops] = useState([]);
  const [findingLoops, setFindingLoops] = useState(false);
  const [preferSealed, setPreferSealed] = useState(true);
  const [selectedRide, setSelectedRide] = useState(null);
  const [follow, setFollow] = useState(true);
  const [permission, setPermission] = useState(null);
  const [locationFailed, setLocationFailed] = useState(false);
  const [mapFailed, setMapFailed] = useState(false);
  const [mapAttempt, setMapAttempt] = useState(0);

  // ride state
  const [riding, setRiding] = useState(false);
  const latestSpeed = useRef(null);
  const [liveSpeed, setLiveSpeed] = useState(null);
  const ridingRef = useRef(false);
  const rideStartedAt = useRef(0);
  const finishingRideRef = useRef(false);
  const backgroundRideRef = useRef(false);
  const lastRecordedTime = useRef(0);
  const [screenLockRecording, setScreenLockRecording] = useState(false);
  const [stats, setStats] = useState({ seconds: 0, meters: 0, speed: 0, top: 0 });
  const statsRef = useRef({ seconds: 0, meters: 0, speed: 0, top: 0 });
  const rideLineRef = useRef([]);

  // route drawing
  const [drawing, setDrawing] = useState(false);
  const [draft, setDraft] = useState([]);
  const [addressPlanner, setAddressPlanner] = useState(false);
  const [origin, setOrigin] = useState(null);
  const [originReset, setOriginReset] = useState(0);
  const [originNeedsSelection, setOriginNeedsSelection] = useState(false);
  const [destination, setDestination] = useState(null);
  const [routePreview, setRoutePreview] = useState(null);
  const [quickPlaces, setQuickPlaces] = useState({});
  const [editingShortcut, setEditingShortcut] = useState(null);
  const shortcutWrite = useRef(false);
  const [savingShortcut, setSavingShortcut] = useState(false);
  const currentPoint = useRef(null);
  const [searchNear, setSearchNear] = useState(null);
  const [navigation, setNavigation] = useState(null);
  const { height: windowHeight } = useWindowDimensions();
  const navigating = Boolean(navigation && !navigation.arrived);
  const navigationInset = navigating && follow ? [Math.round(windowHeight * 0.30), 0, 0, 0] : 0;
  const navigationFix = useRef(null);
  const [rerouteStatus, setRerouteStatus] = useState(null);

  const activeLines = navigation?.lines;
  const arrived = navigation?.arrived;
  const remainingStops = navigation?.remaining;
  const throughStops = navigation?.throughStops;
  const activeOffsets = navigation?.offsets;
  useEffect(() => {
    if (!activeLines || arrived) return;
    let active = true;
    let previousFix;
    let offRouteFixes = 0;
    let lastRequest = 0;
    let rerouting = false;
    let remaining = remainingStops;
    let progress = 0;
    const timer = setInterval(async () => {
      const fix = navigationFix.current;
      if (!fix || fix === previousFix || Date.now() - fix.timestamp > 10_000) return;
      if (previousFix && fix.timestamp - previousFix.timestamp > 10_000) offRouteFixes = 0;
      previousFix = fix;
      const { point, accuracy } = fix;
      if (remaining.length > 1 && distM(point, remaining[0]) <= 35) {
        remaining = remaining.slice(1);
      }

      const fixOnRoute = locateOnRoute(point, activeLines, activeOffsets, progress);
      const offRoute = fixOnRoute.distance > Math.max(55, accuracy * 2);
      offRouteFixes = offRoute ? offRouteFixes + 1 : 0;
      if (offRouteFixes >= 3 && !rerouting && Date.now() - lastRequest >= 15_000) {
        lastRequest = Date.now();
        rerouting = true;
        setRerouteStatus('Finding a new route…');
        try {
          const updated = await buildDirections(point, remaining, undefined, throughStops);
          if (!active) return;
          if (!offRouteFixes) {
            setRerouteStatus(null);
            return;
          }
          if (!updated) throw new Error('No replacement route');
          setNavigation((state) => state?.lines === activeLines ? updated : state);
          setRerouteStatus(null);
        } catch {
          if (active) setRerouteStatus('Could not reroute. Retrying if you stay off route.');
        } finally {
          rerouting = false;
        }
        return;
      }
      if (offRoute || rerouting) return;
      setRerouteStatus(null);
      if (fixOnRoute.meters >= progress || progress - fixOnRoute.meters >= 9) {
        progress = fixOnRoute.meters;
      }
      const nextProgress = progress;
      setNavigation((state) => {
        if (!state || state.lines !== activeLines || state.arrived) return state;
        let index = state.index;
        while (index > 0 && nextProgress < state.steps[index - 1].meters - 20) index -= 1;
        while (index < state.steps.length - 1 && nextProgress >= state.steps[index].meters + 8) index += 1;
        const reached = nextProgress >= state.totalMeters - 25 && distM(point, state.lines.at(-1).at(-1)) <= 30;
        return { ...state, progress: nextProgress, index, arrived: reached };
      });
    }, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [activeLines, activeOffsets, arrived, remainingStops, throughStops]);
  const [savingRoute, setSavingRoute] = useState(false);
  const savingRouteRef = useRef(false);

  useEffect(() => {
    AsyncStorage.getItem(RIDES_KEY).then((saved) => {
      if (saved) setRides(JSON.parse(saved));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    AsyncStorage.getItem(QUICK_PLACES_KEY).then((raw) => {
      if (raw) setQuickPlaces(JSON.parse(raw));
    }).catch(() => {});
  }, []);

  // load saved data
  useEffect(() => {
    (async () => {
      try {
        const t = await AsyncStorage.getItem(TRAIL_KEY);
        if (t) {
          const trailData = JSON.parse(t);
          trailRef.current = Array.isArray(trailData) ? trailData : trailData.lines;
          knownRoads.current = new Set(trailData.roadIds ?? []);
          offlineBatches.current = trailData.pending ?? [];
          setPendingMatches(offlineBatches.current.length);
          setTrail([...trailRef.current]);
        }
        const r = await AsyncStorage.getItem(ROUTES_KEY);
        if (r) setRoutes(JSON.parse(r));
      } catch (e) {}
      setTrailLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (!trailLoaded) return;
    backupActions.current = {
      read: async () => {
        await matchQueue.current;
        return { lines: trailRef.current, roadIds: [...knownRoads.current] };
      },
      restore: async (backup) => {
        const write = matchQueue.current.then(async () => {
          const lines = [...new Map([...trailRef.current, ...backup.lines].map((line) => {
            const forward = JSON.stringify(line);
            const reverse = JSON.stringify([...line].reverse());
            return [forward < reverse ? forward : reverse, line];
          })).values()];
          const roadIds = [...new Set([...knownRoads.current, ...backup.road_ids])];
          await AsyncStorage.setItem(TRAIL_KEY, JSON.stringify({ lines, roadIds, pending: offlineBatches.current }));
          knownRoads.current = new Set(roadIds);
          trailRef.current = lines;
          setTrail(lines);
        });
        matchQueue.current = write.catch(() => {});
        await write;
      },
    };
    return () => { backupActions.current = null; };
  }, [trailLoaded, backupActions]);

  const updateRides = useCallback((change) => {
    const write = rideWrites.current.then(async () => {
      const raw = await AsyncStorage.getItem(RIDES_KEY);
      const next = change(raw ? JSON.parse(raw) : []);
      await AsyncStorage.setItem(RIDES_KEY, JSON.stringify(next));
      setRides(next);
    });
    rideWrites.current = write.catch(() => {});
    return write;
  }, []);

  const saveDiscoveryChoice = useCallback(async (allowed) => {
    discoveryRevision.current += 1;
    discoveryAllowed.current = allowed;
    if (!allowed) {
      pendingSamples.current = [];
      setMatchingFailed(false);
    }
    setDiscoveryChoice(allowed);
    try {
      await AsyncStorage.setItem(DISCOVERY_PERMISSION_KEY, allowed ? 'allow' : 'deny');
    } catch {
      if (allowed) {
        discoveryAllowed.current = false;
        pendingSamples.current = [];
        setDiscoveryChoice(false);
      }
      Alert.alert('Could not save your choice', 'You can try again in Privacy.');
    }
  }, []);

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(DISCOVERY_PERMISSION_KEY).then((saved) => {
      if (!active) return;
      const choice = saved === 'allow' ? true : saved === 'deny' ? false : null;
      discoveryAllowed.current = choice === true;
      setDiscoveryChoice(choice);
    }).catch(() => { if (active) setDiscoveryChoice(null); });
    return () => { active = false; };
  }, []);

  const askDiscoveryPermission = useCallback(() => {
    Alert.alert('Turn on road discovery?',
      'RouteRunner sends GPS points to Geoapify to identify the roads you travel and unlock them on your map. This can happen while the map is open, even before you start a ride.',
      [
        { text: 'Not now', style: 'cancel', onPress: () => { void saveDiscoveryChoice(false); } },
        { text: 'Allow road discovery', onPress: () => { void saveDiscoveryChoice(true); } },
      ],
      { cancelable: false });
  }, [saveDiscoveryChoice]);

  useEffect(() => {
    if (!GEOAPIFY_TEST_KEY || permission !== 'granted' || discoveryChoice !== null || discoveryPrompted.current) return;
    discoveryPrompted.current = true;
    askDiscoveryPermission();
  }, [askDiscoveryPermission, discoveryChoice, permission]);

  const processMatches = useCallback(async () => {
    if (!discoveryAllowed.current || !GEOAPIFY_TEST_KEY || matchingActive.current || Date.now() < retryMatchingAt.current) return;
    await matchQueue.current;
    if (!discoveryAllowed.current || matchingActive.current || !offlineBatches.current.length || Date.now() < retryMatchingAt.current) return;
    matchingActive.current = true;
    const revision = discoveryRevision.current;
    try {
      const batch = offlineBatches.current[0];
      const matched = batch.matched ?? await matchRoads(batch.samples);
      const write = matchQueue.current.then(async () => {
        if (!discoveryAllowed.current || revision !== discoveryRevision.current) return;
        const fresh = batch.fresh ? new Map(batch.fresh) : new Map();
        if (!batch.matched) {
          for (const { roads } of matched) {
            for (const { id, line } of roads) {
              if (knownRoads.current.has(id)) continue;
              const segments = fresh.get(id) ?? [];
              segments.push(line);
              fresh.set(id, segments);
            }
          }
          const lines = [...trailRef.current, ...matched.flatMap((entry) => entry.lines)];
          const roadIds = [...knownRoads.current, ...fresh.keys()];
          const pending = [{ ...batch, matched: [], fresh: [...fresh] }, ...offlineBatches.current.slice(1)];
          await AsyncStorage.setItem(TRAIL_KEY, JSON.stringify({ lines, roadIds, pending }));
          trailRef.current = lines;
          knownRoads.current = new Set(roadIds);
          offlineBatches.current = pending;
          setTrail(lines);
        }

        const rideId = batch.samples[0].rideId;
        const pending = offlineBatches.current.slice(1);
        if (rideId != null) {
          if (rideId === rideStartedAt.current) {
            for (const [id, segments] of fresh) rideUnlocks.current.set(id, segments);
            appliedRideBatches.current.add(batch.id);
          }
          await updateRides((rides) => rides.map((ride) => {
            if (ride.startedAt !== rideId) return ride;
            const applied = ride.appliedMatchBatches ?? [];
            const alreadyApplied = applied.includes(batch.id);
            return {
              ...ride,
              unlockCount: (ride.unlockCount ?? 0) + (alreadyApplied ? 0 : fresh.size),
              unlockLines: alreadyApplied ? ride.unlockLines : [...(ride.unlockLines ?? []), ...[...fresh.values()].flat()],
              appliedMatchBatches: alreadyApplied ? applied : [...applied, batch.id],
              unlocksIncomplete: pending.some(({ samples }) => samples[0].rideId === rideId),
            };
          }));
        }

        await AsyncStorage.setItem(TRAIL_KEY, JSON.stringify({
          lines: trailRef.current, roadIds: [...knownRoads.current], pending,
        }));
        offlineBatches.current = pending;
        setPendingMatches(pending.length);
        setMatchingFailed(false);
      });
      matchQueue.current = write.catch(() => {});
      await write;
    } catch {
      retryMatchingAt.current = Date.now() + 30_000;
      setMatchingFailed(true);
    } finally {
      matchingActive.current = false;
    }
  }, [updateRides]);

  const flushSamples = useCallback((keepLast = false) => {
    const samples = pendingSamples.current;
    pendingSamples.current = keepLast ? samples.slice(-1) : [];
    if (!discoveryAllowed.current || !GEOAPIFY_TEST_KEY) return;
    if (samples.length >= 2) {
      const id = `${samples[0].rideId ?? 'free'}:${samples[0].seconds}:${samples.at(-1).seconds}`;
      unstoredBatches.current.set(id, { id, samples });
    }
    if (!unstoredBatches.current.size) return;
    const write = matchQueue.current.then(async () => {
      const staged = [...unstoredBatches.current.values()];
      if (!staged.length) return;
      const existing = new Set(offlineBatches.current.map((batch) => batch.id));
      const pending = [...offlineBatches.current, ...staged.filter((batch) => !existing.has(batch.id))];
      await AsyncStorage.setItem(TRAIL_KEY, JSON.stringify({
        lines: trailRef.current, roadIds: [...knownRoads.current], pending,
      }));
      offlineBatches.current = pending;
      for (const { id } of staged) unstoredBatches.current.delete(id);
      setPendingMatches(pending.length);
    });
    matchQueue.current = write.catch(() => {
      if (samples[0]?.rideId != null && samples[0].rideId === rideStartedAt.current) rideMatchingFailed.current = true;
      setMatchingFailed(true);
    });
    void matchQueue.current.then(processMatches);
  }, [processMatches]);

  const onLocation = useCallback(
    (loc) => {
      const { longitude, latitude, accuracy } = loc.coords;
      if (!(accuracy > 0 && accuracy <= 30)) return;
      const pt = [longitude, latitude];
      const recording = ridingRef.current && loc.timestamp >= rideStartedAt.current;
      if (GEOAPIFY_TEST_KEY && discoveryAllowed.current) {
        const seconds = Math.floor(loc.timestamp / 1000);
        const rideId = recording ? rideStartedAt.current : null;
        const last = pendingSamples.current.at(-1);
        if (last && (last.rideId !== rideId || seconds - last.seconds > 30)) flushSamples();
        if (pendingSamples.current.length && seconds - pendingSamples.current[0].seconds >= 30) {
          flushSamples(true);
        }
        const previous = pendingSamples.current.at(-1);
        if (!previous || (seconds - previous.seconds >= 2 && distM(previous.point, pt) >= 10)) {
          pendingSamples.current.push({ point: pt, seconds, rideId });
        }
      }

      if (!recording || loc.timestamp <= lastRecordedTime.current) return;
      const gap = loc.timestamp - lastRecordedTime.current;
      lastRecordedTime.current = loc.timestamp;
      if (gap > 30_000) lastPtRef.current = null;
      const prev = lastPtRef.current;

      if (!prev || distM(prev, pt) >= 10) {
        if (ridingRef.current) {
          if (prev && distM(prev, pt) <= 200) statsRef.current.meters += distM(prev, pt);
          rideLineRef.current.push(pt);
        }
        lastPtRef.current = pt;
      }

      if (ridingRef.current) {
        const sp = loc.coords.speed > 0 ? loc.coords.speed : 0;
        statsRef.current.speed = sp;
        statsRef.current.top = Math.max(statsRef.current.top, sp);
      }
    },
    [flushSamples]
  );

  useEffect(() => {
    const timeout = setTimeout(() => setLocatingStartup(false), 5000);
    return () => clearTimeout(timeout);
  }, []);

  // location watcher
  useEffect(() => {
    if (!trailLoaded) return;
    let sub;
    let active = true;
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (!active) return;
        setPermission(status);
        if (status !== 'granted') {
          setLocatingStartup(false);
          return;
        }
        Location.getLastKnownPositionAsync({ maxAge: 86_400_000, requiredAccuracy: 1000 })
          .then((cached) => {
            if (!active || !cached || !startupCameraPending.current) return;
            const centerCoordinate = [cached.coords.longitude, cached.coords.latitude];
            setStartupLocation(centerCoordinate);
            cameraRef.current?.setCamera({ centerCoordinate, zoomLevel: 13, animationDuration: 0 });
            setLocatingStartup(false);
          }).catch(() => {});
        sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 0, timeInterval: 500 },
          (location) => {
            if (!active) return;
            const firstFix = currentPoint.current === null;
            currentPoint.current = [location.coords.longitude, location.coords.latitude];
            if (firstFix) {
              if (startupCameraPending.current) {
                cameraRef.current?.setCamera({
                  centerCoordinate: currentPoint.current, zoomLevel: 15, animationDuration: 0,
                });
              }
              startupCameraPending.current = false;
              setHasLiveLocation(true);
              setLocatingStartup(false);
            }
            const { accuracy } = location.coords;
            if (accuracy > 0 && accuracy <= 35) {
              navigationFix.current = { point: currentPoint.current, accuracy, timestamp: location.timestamp };
              setSearchNear((near) => near ?? currentPoint.current);
            }
            if (ridingRef.current) {
              const reading = liveSpeedSample(location, rideStartedAt.current, Date.now());
              if (reading && reading.timestamp > (latestSpeed.current?.timestamp ?? 0)) {
                latestSpeed.current = reading;
                setLiveSpeed(reading.speed);
              }
            }
            if (!backgroundRideRef.current) onLocation(location);
          }
        );
        if (!active) sub.remove();
      } catch {
        if (active) {
          setLocationFailed(true);
          setLocatingStartup(false);
        }
      }
    })();
    return () => {
      active = false;
      sub?.remove();
    };
  }, [onLocation, trailLoaded]);

  const drainBackground = useCallback(async () => {
    const startedAt = rideStartedAt.current;
    await backgroundWrites;
    const raw = await AsyncStorage.getItem(`${ACTIVE_RIDE_KEY}:${startedAt}`);
    if (!raw || startedAt !== rideStartedAt.current || !ridingRef.current) return;
    JSON.parse(raw).sort((a, b) => a.timestamp - b.timestamp).forEach(onLocation);
  }, [onLocation]);

  useEffect(() => {
    if (!trailLoaded || Platform.OS !== 'ios') return;
    (async () => {
      const raw = await AsyncStorage.getItem(ACTIVE_RIDE_KEY);
      if (!raw || ridingRef.current || finishingRideRef.current) return;
      const { startedAt } = JSON.parse(raw);
      const active = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_TASK);
      if (ridingRef.current || finishingRideRef.current) return;
      rideStartedAt.current = startedAt;
      backgroundRideRef.current = active;
      ridingRef.current = true;
      setScreenLockRecording(active);
      setRiding(true);
      await drainBackground();
    })().catch(() => {});
  }, [trailLoaded, drainBackground]);

  // ride timer
  useEffect(() => {
    if (!riding) return;
    const id = setInterval(async () => {
      if (latestSpeed.current && Date.now() - latestSpeed.current.timestamp > LIVE_SPEED_MAX_AGE_MS) setLiveSpeed(null);
      if (backgroundRideRef.current) await drainBackground().catch(() => {});
      if (!ridingRef.current) return;
      statsRef.current.seconds = Math.floor((Date.now() - rideStartedAt.current) / 1000);
      setStats({ ...statsRef.current });
    }, 1000);
    return () => clearInterval(id);
  }, [riding, drainBackground]);

  useEffect(() => {
    if (!trailLoaded || !GEOAPIFY_TEST_KEY) return;
    const timer = setInterval(() => {
      flushSamples(true);
      void processMatches();
    }, MATCH_INTERVAL_MS);
    void processMatches();
    const retry = setInterval(() => { void processMatches(); }, 3000);
    return () => { clearInterval(timer); clearInterval(retry); };
  }, [trailLoaded, flushSamples, processMatches]);

  const startRide = async () => {
    if (ridingRef.current || finishingRideRef.current) return;
    if (locationFailed) {
      Alert.alert('GPS unavailable', 'Check that Location Services are enabled, then reopen RouteRunner.');
      return;
    }
    if (permission !== 'granted') {
      Alert.alert('Location needed', 'Allow location access to start recording a ride.');
      return;
    }
    finishingRideRef.current = true;
    let backgroundEnabled = false;
    let startedAt = Date.now();
    if (Platform.OS === 'ios') {
      try {
        const { granted } = await Location.requestBackgroundPermissionsAsync();
        startedAt = Date.now();
        if (granted) {
          await AsyncStorage.setItem(ACTIVE_RIDE_KEY, JSON.stringify({ startedAt }));
          await Location.startLocationUpdatesAsync(BACKGROUND_TASK, {
            accuracy: Location.Accuracy.BestForNavigation,
            distanceInterval: 5,
            activityType: Location.ActivityType.AutomotiveNavigation,
            pausesUpdatesAutomatically: false,
            showsBackgroundLocationIndicator: true,
          });
          backgroundEnabled = true;
        }
      } catch {
        await AsyncStorage.removeItem(ACTIVE_RIDE_KEY).catch(() => {});
      }
    }
    flushSamples();
    backgroundRideRef.current = backgroundEnabled;
    setScreenLockRecording(backgroundEnabled);
    setSelectedRide(null);
    lastRecordedTime.current = 0;
    latestSpeed.current = null;
    setLiveSpeed(null);
    rideUnlocks.current = new Map();
    appliedRideBatches.current = new Set();
    rideMatchingFailed.current = false;
    rideStartedAt.current = startedAt;
    statsRef.current = { seconds: 0, meters: 0, speed: 0, top: 0 };
    rideLineRef.current = [];
    lastPtRef.current = null;
    setStats({ ...statsRef.current });
    ridingRef.current = true;
    setRiding(true);
    setFollow(true);
    finishingRideRef.current = false;
  };

  const endRide = async () => {
    if (!ridingRef.current || finishingRideRef.current) return;
    finishingRideRef.current = true;
    try {
      if (backgroundRideRef.current && await Location.hasStartedLocationUpdatesAsync(BACKGROUND_TASK)) {
        await Location.stopLocationUpdatesAsync(BACKGROUND_TASK);
      }
      await drainBackground();
    } catch {
      finishingRideRef.current = false;
      Alert.alert('Could not finish ride', 'Try ending the ride again.');
      return;
    }
    backgroundRideRef.current = false;
    setScreenLockRecording(false);
    ridingRef.current = false;
    setRiding(false);
    flushSamples();
    const date = Date.now();
    await matchQueue.current;
    const summary = {
      ...statsRef.current,
      startedAt: rideStartedAt.current,
      date,
      seconds: Math.floor((date - rideStartedAt.current) / 1000),
      line: rideLineRef.current,
      unlockCount: GEOAPIFY_TEST_KEY && (discoveryAllowed.current || rideUnlocks.current.size || offlineBatches.current.some(({ samples }) => samples[0].rideId === rideStartedAt.current)) ? rideUnlocks.current.size : null,
      unlockLines: [...rideUnlocks.current.values()].flat(),
      appliedMatchBatches: [...appliedRideBatches.current],
      unlocksIncomplete: rideMatchingFailed.current || offlineBatches.current.some(({ samples }) => samples[0].rideId === rideStartedAt.current),
    };
    try {
      await updateRides((all) => [summary, ...all.filter((ride) => ride.startedAt !== summary.startedAt)]);
      await AsyncStorage.multiRemove([ACTIVE_RIDE_KEY, `${ACTIVE_RIDE_KEY}:${rideStartedAt.current}`]).catch(() => {});
      Alert.alert(
        'Ride saved',
        `Time ${fmtTime(summary.seconds)}\nDistance ${formatDistance(summary.meters)}\nAverage speed ${formatSpeed(averageSpeed(summary))}\nTop speed ${formatSpeed(summary.top)}${summary.unlockCount === null ? "" : `\nNew road sections: ${summary.unlockCount}${summary.unlocksIncomplete ? " (partial)" : ""}`}`
      );
    } catch {
      Alert.alert('Ride could not be saved', 'There was a problem writing to device storage.');
    } finally {
      finishingRideRef.current = false;
    }
  };

  const onMapPress = (event) => {
    if (!drawing || savingRouteRef.current) return;
    const point = event.geometry.coordinates;
    setDraft((points) => points.length < 12 ? [...points, point] : points);
  };

  const previewAddressRoute = async (place = destination, fromCurrent = false) => {
    if (savingRouteRef.current || !place || (!fromCurrent && originNeedsSelection)) return;
    if (!GEOAPIFY_TEST_KEY) {
      Alert.alert('Route planning unavailable', 'This build needs a Geoapify key.');
      return;
    }
    const start = (fromCurrent ? null : origin?.point) ?? currentPoint.current;
    if (!start) {
      Alert.alert('Current location unavailable', 'Wait for a GPS fix or search for a starting point.');
      return;
    }
    savingRouteRef.current = true;
    setSavingRoute(true);
    try {
      const { lines } = await planRoadRoute([start, place.point]);
      if (!lines.length) {
        Alert.alert('No driving route found', 'Try a different start or destination.');
        return;
      }
      if (fromCurrent) {
        setOrigin(null);
        setOriginNeedsSelection(false);
        setOriginReset((value) => value + 1);
        setDestination(place);
      }
      setRoutePreview({ name: place.label, lines, waypoints: [start, place.point] });
      setNavigation(null);
      setSelectedRide(null);
      setAddressPlanner(false);
      showOnMap(lines);
    } catch {
      Alert.alert('Could not find route', 'Try again when your connection is available.');
    } finally {
      savingRouteRef.current = false;
      setSavingRoute(false);
    }
  };

  const saveShortcut = async (place) => {
    if (!editingShortcut || shortcutWrite.current) return;
    shortcutWrite.current = true;
    setSavingShortcut(true);
    try {
      const next = { ...quickPlaces };
      if (place) next[editingShortcut] = place;
      else delete next[editingShortcut];
      await AsyncStorage.setItem(QUICK_PLACES_KEY, JSON.stringify(next));
      setQuickPlaces(next);
      setEditingShortcut(null);
    } catch {
      Alert.alert('Could not update shortcut', 'Try again.');
    } finally {
      shortcutWrite.current = false;
      setSavingShortcut(false);
    }
  };

  const saveAddressRoute = async () => {
    if (!routePreview || routePreview.id || savingRouteRef.current) return;
    savingRouteRef.current = true;
    setSavingRoute(true);
    try {
      const next = [...routes, { id: String(Date.now()), ...routePreview }];
      await AsyncStorage.setItem(ROUTES_KEY, JSON.stringify(next));
      setRoutes(next);
      setRoutePreview(null);
    } catch {
      Alert.alert('Could not save route', 'Try saving again.');
    } finally {
      savingRouteRef.current = false;
      setSavingRoute(false);
    }
  };

  const saveRoute = async () => {
    if (draft.length < 2 || savingRouteRef.current) return;
    if (!GEOAPIFY_TEST_KEY) {
      Alert.alert('Route planning unavailable', 'This build needs a Geoapify key.');
      return;
    }
    savingRouteRef.current = true;
    setSavingRoute(true);
    try {
      const { lines } = await planRoadRoute(draft);
      if (!lines.length) {
        Alert.alert('No driving route found', 'Move a waypoint closer to a road and try again.');
        return;
      }
      const next = [...routes, { id: String(Date.now()), name: `Route ${routes.length + 1}`, lines, waypoints: draft }];
      await AsyncStorage.setItem(ROUTES_KEY, JSON.stringify(next));
      setRoutes(next);
      setDraft([]);
      setDrawing(false);
    } catch {
      Alert.alert('Could not save route', 'Your waypoints are still on the map. Try again.');
    } finally {
      savingRouteRef.current = false;
      setSavingRoute(false);
    }
  };

  const showOnMap = (lines) => {
    const points = lines.flat();
    if (!points.length) return;
    const bounds = points.reduce((box, [lon, lat]) => ({
      west: Math.min(box.west, lon),
      south: Math.min(box.south, lat),
      east: Math.max(box.east, lon),
      north: Math.max(box.north, lat),
    }), { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity });
    startupCameraPending.current = false;
    setFollow(false);
    setLibraryView(null);
    requestAnimationFrame(() => {
      cameraRef.current?.fitBounds([bounds.east, bounds.north], [bounds.west, bounds.south], 70, 450);
    });
  };

  const openPlanner = () => {
    setSearchNear(currentPoint.current);
    setAddressPlanner(true);
  };

  const generateLoops = async (sealed = preferSealed) => {
    if (savingRouteRef.current) return;
    const here = currentPoint.current;
    if (!here || !GEOAPIFY_TEST_KEY) {
      Alert.alert('Loop planner unavailable', here ? 'This build needs a Geoapify key.' : 'Wait for a GPS fix and try again.');
      return;
    }
    savingRouteRef.current = true;
    setFindingLoops(true);
    setRoutePreview(null);
    setSelectedRide(null);
    setDrawing(false);
    setDraft([]);
    try {
      const options = await findExploreOverview(here, sealed, trailRef.current);
      setExploreLoops(options);
      if (options.length) showOnMap(options.flatMap(({ route }) => route.lines));
      else Alert.alert('No loops found', 'Try again from a different starting location.');
    } catch {
      Alert.alert('Could not plan loops', 'Check your connection and try again.');
    } finally {
      savingRouteRef.current = false;
      setFindingLoops(false);
    }
  };

  const previewLoop = ({ minutes, color, route, waypoints }) => {
    setRoutePreview({
      name: `Explore loop · ${minutes} min target`,
      lines: route.lines,
      seconds: route.seconds,
      waypoints: route.lines.length === waypoints.length - 1
        ? [waypoints[0], ...route.lines.map((line) => line.at(-1))] : waypoints,
      loop: true,
      color,
      plannedRoute: route,
    });
    showOnMap(route.lines);
  };

  const startDirections = async (route) => {
    if (savingRouteRef.current) return;
    const here = currentPoint.current;
    if (!here || !GEOAPIFY_TEST_KEY) {
      Alert.alert('Directions unavailable', here ? 'This build needs a Geoapify key.' : 'Wait for a GPS fix and try again.');
      return;
    }
    const lastPoint = (route.lines ?? [route.line]).at(-1)?.at(-1);
    const remaining = route.waypoints?.slice(1) ?? (lastPoint ? [lastPoint] : []);
    if (!remaining.length) return;
    savingRouteRef.current = true;
    setSavingRoute(true);
    try {
      const planned = route.loop && route.waypoints && distM(here, route.waypoints[0]) <= 50 ? route.plannedRoute : undefined;
      const directions = await buildDirections(here, remaining, planned, Boolean(route.loop));
      if (!directions) {
        Alert.alert('Directions unavailable', 'No turn instructions were returned for this route.');
        return;
      }
      setSelectedRide(null);
      setRoutePreview(null);
      setLibraryView(null);
      setRerouteStatus(null);
      setNavigation(directions);
      setFollow(true);
      if (!ridingRef.current && !finishingRideRef.current) await startRide();
    } catch {
      Alert.alert('Could not start directions', 'Check your connection and try again.');
    } finally {
      savingRouteRef.current = false;
      setSavingRoute(false);
    }
  };

  const deleteRoute = (route) => {
    Alert.alert('Delete saved route?', route.name, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        if (savingRouteRef.current) return;
        savingRouteRef.current = true;
        setSavingRoute(true);
        try {
          const next = routes.filter(({ id }) => id !== route.id);
          await AsyncStorage.setItem(ROUTES_KEY, JSON.stringify(next));
          setRoutes(next);
          setRoutePreview((preview) => preview?.id === route.id ? null : preview);
        } catch {
          Alert.alert('Could not delete route', 'Try again.');
        } finally {
          savingRouteRef.current = false;
          setSavingRoute(false);
        }
      } },
    ]);
  };

  const renameRide = async (ride, title) => {
    await updateRides((all) => all.map((item) =>
      rideKey(item) === rideKey(ride) ? { ...item, title } : item));
  };

  const rememberRidePhoto = async (ride, sourceUri) => {
    const photoFile = `ride-memory-${rideKey(ride)}-${Date.now()}.jpg`;
    const uri = ridePhotoUri(photoFile);
    if (!uri) throw new Error('Photo storage unavailable');
    let previous;
    try {
      await FileSystem.copyAsync({ from: sourceUri, to: uri });
      await updateRides((all) => {
        const item = all.find((entry) => rideKey(entry) === rideKey(ride));
        if (!item) throw new Error('Ride no longer exists');
        previous = ridePhotoUri(item.photoFile);
        return all.map((entry) => entry === item ? { ...entry, photoFile } : entry);
      });
    } catch (error) {
      await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      throw error;
    }
    if (previous && previous !== uri) await FileSystem.deleteAsync(previous, { idempotent: true }).catch(() => {});
    return uri;
  };

  const deleteRide = (ride) => {
    const isSameRide = (item) => item && (ride.startedAt != null
      ? item.startedAt === ride.startedAt : item.startedAt == null && item.date === ride.date);
    Alert.alert('Delete this ride?', 'The ride will be removed from History. Unlocked roads stay on your map.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete ride', style: 'destructive', onPress: async () => {
        try {
          let photo;
          await updateRides((all) => {
            photo = ridePhotoUri(all.find(isSameRide)?.photoFile);
            return all.filter((item) => !isSameRide(item));
          });
          if (photo) await FileSystem.deleteAsync(photo, { idempotent: true }).catch(() => {});
          setSelectedRide((selected) => isSameRide(selected) ? null : selected);
        } catch {
          Alert.alert('Could not delete ride', 'Try again.');
        }
      } },
    ]);
  };

  const pinRide = async (ride) => {
    setRideMenu(null);
    try {
      await updateRides((all) => all.map((item) =>
        rideKey(item) === rideKey(ride) ? { ...item, pinned: !item.pinned } : item));
    } catch {
      Alert.alert('Could not update pin', 'Try again.');
    }
  };

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(SIMPLIFIED_MAP_KEY).then((value) => {
      if (active) setSimplifiedMap(value !== 'off');
    }).catch(() => { if (active) setSimplifiedMap(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(MAP_THEME_KEY).then((value) => {
      if (active) setMapTheme(value === 'light' ? 'light' : 'dark');
    }).catch(() => { if (active) setMapTheme('dark'); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!mapTheme || !simplifiedMap || simplifiedStyle) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let active = true;
    setSimplifiedStyleFailed(false);
    fetch(MAP_STYLES[mapTheme], { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error('Map style unavailable');
      const style = simplifyMapStyle(await response.json());
      if (active) setSimplifiedStyles((current) => ({ ...current, [mapTheme]: style }));
    }).catch(() => { if (active) setSimplifiedStyleFailed(true); })
      .finally(() => clearTimeout(timeout));
    return () => {
      active = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [mapTheme, simplifiedMap, simplifiedStyle, styleAttempt]);

  const toggleLightMap = async () => {
    if (!mapTheme || savingMapTheme) return;
    const next = lightMap ? 'dark' : 'light';
    setSavingMapTheme(true);
    try {
      await AsyncStorage.setItem(MAP_THEME_KEY, next);
      setMapTheme(next);
    } catch {
      Alert.alert('Could not save map appearance', 'Try again.');
    } finally {
      setSavingMapTheme(false);
    }
  };

  const toggleSimplifiedMap = async () => {
    const next = !simplifiedMap;
    setSimplifiedMap(next);
    try {
      await AsyncStorage.setItem(SIMPLIFIED_MAP_KEY, next ? 'on' : 'off');
    } catch {
      setSimplifiedMap(!next);
      Alert.alert('Could not save map preference', 'Try again.');
    }
  };

  const closeLibrary = () => {
    if (shareRide) setShareRide(null);
    else if (rideMenu) setRideMenu(null);
    else if (recapRide) setRecapRide(null);
    else if (libraryView === 'privacy') setLibraryView('settings');
    else if (libraryView !== 'menu') setLibraryView('menu');
    else setLibraryView(null);
  };

  const openRide = (ride) => {
    const lines = splitRecordedPath(ride.line);
    if (!lines.length) {
      Alert.alert('No recorded path', 'This ride has too few connected GPS points to show on the map.');
      return;
    }
    setRecapRide(null);
    setSelectedRide({ ...ride, lines });
    showOnMap(lines);
  };

  const pinkLayerStyle = {
    glow: { lineColor: PINK, lineWidth: 10, lineBlur: 8, lineOpacity: 0.7, lineCap: 'round', lineJoin: 'round' },
    core: { lineColor: '#FF6FB8', lineWidth: 3.5, lineCap: 'round', lineJoin: 'round' },
  };

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      {navigating && <KeepDirectionsAwake />}
      <MapLibreGL.MapView
        key={mapAttempt}
        contentInset={navigationInset}
        onDidFailLoadingMap={() => setMapFailed(true)}
        onDidFinishLoadingMap={() => setMapFailed(false)}
        style={StyleSheet.absoluteFill}
        mapStyle={simplifiedMap && simplifiedStyle ? simplifiedStyle : MAP_STYLES[theme]}
        logoEnabled={false}
        attributionPosition={{ bottom: 8, left: 8 }}
        compassEnabled={false}
        rotateEnabled={false}
        onPress={onMapPress}
        onRegionWillChange={(f) => {
          if (f?.properties?.isUserInteraction) {
            startupCameraPending.current = false;
            setLocatingStartup(false);
            setFollow(false);
          }
        }}
      >
        <MapLibreGL.Camera
          ref={cameraRef}
          followUserLocation={follow && hasLiveLocation}
          followUserMode={navigating ? "course" : "normal"}
          heading={navigating ? undefined : 0}
          followHeading={navigating ? undefined : 0}
          followZoomLevel={15}
          defaultSettings={{ centerCoordinate: startupLocation ?? [0, 0], zoomLevel: startupLocation ? 13 : 0 }}
        />
        <MapLibreGL.UserLocation visible renderMode="native" showsUserHeadingIndicator androidRenderMode="compass" />

        {/* Unlocked roads: white trail that grows as you ride */}
        <MapLibreGL.ShapeSource id="explore-shade" shape={exploreShade}>
          <MapLibreGL.FillLayer id="explore-dim" style={{ fillColor: '#0b0b0d', fillOpacity: explore ? 0.48 : 0 }} />
        </MapLibreGL.ShapeSource>
        <MapLibreGL.ShapeSource id="trail" shape={fc(trail)}>
          <MapLibreGL.LineLayer id="trail-light-outline"
            style={{
              lineColor: '#535764', lineOpacity: lightMap ? 0.85 : 0,
              lineCap: 'round', lineJoin: 'round',
              lineWidth: ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 13],
            }} />
          <MapLibreGL.LineLayer
            id="trail-glow"
            style={{
              lineColor: ROAD_WHITE,
              lineOpacity: lightMap ? 0 : explore ? 0.5 : 0.25,
              lineBlur: 6,
              lineCap: 'round',
              lineJoin: 'round',
              lineWidth: ['interpolate', ['linear'], ['zoom'], 10, 5, 16, 22],
            }}
          />
          <MapLibreGL.LineLayer
            id="trail-core"
            style={{
              lineColor: ROAD_WHITE,
              lineCap: 'round',
              lineJoin: 'round',
              lineWidth: ['interpolate', ['linear'], ['zoom'], 10, 2, 16, 9],
            }}
          />
        </MapLibreGL.ShapeSource>

        {explore && !routePreview && !navigation && [...exploreLoops].reverse().map(({ minutes, color, route }) => (
          <MapLibreGL.ShapeSource key={minutes} id={`explore-loop-${minutes}`} shape={fc(route.lines)}>
            <MapLibreGL.LineLayer id={`explore-loop-line-${minutes}`}
              style={{ ...pinkLayerStyle.core, lineColor: color, lineWidth: minutes === 90 ? 8 : minutes === 60 ? 6 : 4 }} />
          </MapLibreGL.ShapeSource>
        ))}

        {selectedRide && (
          <MapLibreGL.ShapeSource id="recorded-ride" shape={fc(selectedRide.lines)}>
            <MapLibreGL.LineLayer id="recorded-ride-line" style={{
              lineColor: '#69DBF5', lineWidth: 4, lineCap: 'round', lineJoin: 'round',
            }} />
          </MapLibreGL.ShapeSource>
        )}

        {navigation && !navigation.arrived && (
          <MapLibreGL.ShapeSource id="navigation-route"
            shape={fc(remainingRouteLines(navigation.lines, navigation.offsets, navigation.progress))}>
            <MapLibreGL.LineLayer id="navigation-core" style={{ ...pinkLayerStyle.core, lineWidth: 6 }} />
          </MapLibreGL.ShapeSource>
        )}
        {routePreview && !navigation && (
          <MapLibreGL.ShapeSource id="address-preview" shape={fc(routePreview.lines)}>
            <MapLibreGL.LineLayer id="address-preview-core" style={{ ...pinkLayerStyle.core, lineColor: routePreview.color ?? pinkLayerStyle.core.lineColor }} />
          </MapLibreGL.ShapeSource>
        )}

        {selectedRide?.unlockLines?.length > 0 && (
          <MapLibreGL.ShapeSource id="ride-unlocks" shape={fc(selectedRide.unlockLines)}>
            <MapLibreGL.LineLayer id="ride-unlocks-line" style={{ lineColor: '#77F2AE', lineWidth: 5, lineCap: 'round' }} />
          </MapLibreGL.ShapeSource>
        )}

        {/* Route being drawn */}
        <MapLibreGL.ShapeSource id="draft" shape={fc([draft])}>
          <MapLibreGL.LineLayer id="draft-core" style={{ ...pinkLayerStyle.core, lineDasharray: [2, 2] }} />
        </MapLibreGL.ShapeSource>
        <MapLibreGL.ShapeSource
          id="draft-waypoints"
          shape={{
            type: 'FeatureCollection',
            features: draft.map((point) => ({
              type: 'Feature',
              properties: {},
              geometry: { type: 'Point', coordinates: point },
            })),
          }}
        >
          <MapLibreGL.CircleLayer id="draft-pins" style={{ circleColor: PINK, circleRadius: 5, circleStrokeColor: '#fff', circleStrokeWidth: 1.5 }} />
        </MapLibreGL.ShapeSource>
      </MapLibreGL.MapView>

      {/* Top row */}
      <SafeAreaView pointerEvents="box-none" style={StyleSheet.absoluteFill}>
        {navigation ? (
          <NavigationPanel navigation={navigation} rerouteStatus={rerouteStatus} onEnd={() => setNavigation(null)} />
        ) : (
          <View style={styles.topRow} pointerEvents="box-none">
            <Pressable accessibilityRole="button" accessibilityLabel="Open side menu" style={styles.round}
              onPress={() => setLibraryView('menu')}>
              <Text style={styles.menuIcon}>☰</Text>
            </Pressable>
            <View style={{ flex: 1 }} />
            <RoundBtn label="Explore" active={explore} onPress={() => {
              if (findingLoops) return;
              if (explore && routePreview?.loop) setRoutePreview(null);
              setExplore(!explore);
              if (!explore && !navigation && !routePreview) {
                if (exploreLoops.length) showOnMap(exploreLoops.flatMap(({ route }) => route.lines));
                else if (currentPoint.current && GEOAPIFY_TEST_KEY) generateLoops();
              }
            }} />
          </View>
        )}

        {explore && !navigation && !routePreview && (
          <View style={styles.explorePanel}>
            <Text style={styles.rowTitle}>Explore loops</Text>
            <Text style={styles.rowDetail}>{knownRoads.current.size} road sections unlocked</Text>
            <View style={styles.exploreCards}>
              {LOOP_MODES.map(({ minutes, color }) => {
                const option = exploreLoops.find((loop) => loop.minutes === minutes);
                return (
                  <Pressable key={minutes} accessibilityRole="button"
                    accessibilityLabel={`${minutes} minute target${option ? `, ${Math.round(option.route.seconds / 60)} minutes estimated` : ''}`}
                    disabled={!option || findingLoops} onPress={() => previewLoop(option)}
                    style={[styles.exploreCard, { borderColor: color }]}>
                    <Text style={[styles.exploreDuration, { color }]}>{minutes} min</Text>
                    <Text style={styles.exploreMetric}>{findingLoops ? 'Finding…' : option ? `~${Math.round(option.route.seconds / 60)} min` : 'Unavailable'}</Text>
                    {option && !findingLoops && (
                      <Text style={styles.exploreMetric}>{formatDistance(option.meters)} · {Math.round(option.novel * 100)}% new*</Text>
                    )}
                  </Pressable>
                );
              })}
            </View>
            {exploreLoops.length > 0 && <Text style={styles.exploreMetric}>*Estimated from your unlocked map.</Text>}
            <View style={styles.exploreActions}>
              <Pressable accessibilityRole="switch" accessibilityState={{ checked: preferSealed }} disabled={findingLoops}
                onPress={() => { setPreferSealed(!preferSealed); if (exploreLoops.length) generateLoops(!preferSealed); }}>
                <Text style={styles.retryText}>Prefer sealed {preferSealed ? '✓' : '○'}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" disabled={findingLoops} onPress={() => generateLoops()}>
                <Text style={styles.retryText}>{exploreLoops.length ? 'Refresh loops' : 'Find loops'}</Text>
              </Pressable>
            </View>
          </View>
        )}
        {selectedRide && (
          <View style={styles.banner}>
            <Text style={[styles.bannerText, { color: '#69DBF5' }]}>
              {new Date(selectedRide.date).toLocaleDateString()} · Recorded GPS path
            </Text>
            {selectedRide.unlockCount != null && <Text style={styles.rowDetail}>{selectedRide.unlockCount} new road sections{selectedRide.unlocksIncomplete ? ' (partial)' : ''} · Green on map</Text>}
            <Pressable accessibilityRole="button" style={styles.retryButton} onPress={() => setSelectedRide(null)}>
              <Text style={styles.retryText}>Hide ride</Text>
            </Pressable>
          </View>
        )}

        {locatingStartup && !mapFailed && (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>Finding your location…</Text>
          </View>
        )}
        {mapFailed && (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>Map could not load. Check your connection and try again.</Text>
            <Pressable accessibilityRole="button" style={styles.retryButton} onPress={() => {
              setMapFailed(false);
              setMapAttempt((attempt) => attempt + 1);
            }}>
              <Text style={styles.retryText}>Reload map</Text>
            </Pressable>
          </View>
        )}

        {pendingMatches > 0 && discoveryChoice === true && (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>{matchingFailed ? 'Saved discoveries waiting to retry' : 'Matching saved discoveries…'}</Text>
          </View>
        )}
        {locationFailed && (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>GPS unavailable. Check Location Services and reopen the app.</Text>
          </View>
        )}

        {permission === 'denied' && (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>Location is off. Turn it on in Settings to see yourself and unlock roads.</Text>
          </View>
        )}

        {permission === 'granted' && (!GEOAPIFY_TEST_KEY || matchingFailed) && (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>
              {GEOAPIFY_TEST_KEY ? 'Road matching is temporarily unavailable.' : 'Road matching is unavailable in this build.'}
            </Text>
          </View>
        )}

        {riding && !screenLockRecording && (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>Keep RouteRunner open to record this ride.</Text>
          </View>
        )}
        {riding && (
          <View style={styles.statsBar}>
            <Stat label="Time" value={fmtTime(stats.seconds)} />
            <Stat label="Distance" value={formatDistance(stats.meters)} />
            <Stat label="Average" value={formatSpeed(averageSpeed(stats))} />
            <Stat label="Top" value={formatSpeed(stats.top)} />
          </View>
        )}

        <View style={{ flex: 1 }} pointerEvents="none" />

        {routePreview && !navigation && (
          <View style={styles.startDirections}>
            {routePreview.id && !routePreview.loop && (
              <Text style={styles.loopEstimate} numberOfLines={2}>{routePreview.name}</Text>
            )}
            {routePreview.loop && <Text style={styles.loopEstimate}>{Math.round(routePreview.seconds / 60)} min estimated loop</Text>}
            <Pill label={savingRoute ? 'Loading…' : riding ? 'Start directions' : 'Start directions & ride'} primary disabled={savingRoute}
              onPress={() => startDirections(routePreview)} />
          </View>
        )}
        {!drawing && !routePreview && !navigation && (
          <Pressable accessibilityRole="button" accessibilityLabel="Search for a destination"
            style={styles.mapSearch} onPress={openPlanner}>
            <Text style={styles.mapSearchText}>⌕   Where to?</Text>
          </Pressable>
        )}
        {riding && (drawing || (routePreview && !navigation)) && (
          <View style={styles.speedometerStandalone} pointerEvents="none">
            <RideSpeedometer speed={liveSpeed} />
          </View>
        )}
        {/* Bottom controls */}
        <View style={styles.bottomRow} pointerEvents="box-none">
          {routePreview && !navigation ? (
            <>
              {!routePreview.id && <Pill label={routePreview.loop ? "All loops" : "Edit"} disabled={savingRoute} onPress={routePreview.loop ? () => { setRoutePreview(null); showOnMap(exploreLoops.flatMap(({ route }) => route.lines)); } : openPlanner} />}
              <Pill label="Close" disabled={savingRoute} onPress={() => setRoutePreview(null)} />
              {!routePreview.id && <Pill label="Save route" primary disabled={savingRoute} onPress={saveAddressRoute} />}
            </>
          ) : drawing ? (
            <>
              <Pill label="Cancel" disabled={savingRoute} onPress={() => { setDrawing(false); setDraft([]); }} />
              <Pill label="Undo" disabled={savingRoute || !draft.length} onPress={() => setDraft((d) => d.slice(0, -1))} />
              <Pill label={savingRoute ? "Finding roads…" : "Save route"} primary disabled={savingRoute || draft.length < 2} onPress={saveRoute} />
            </>
          ) : riding ? (
            <>
              <View style={styles.speedometerSideLeft}>
                <RoundBtn label="End ride" onPress={endRide} />
              </View>
              <RideSpeedometer speed={liveSpeed} />
              <View style={styles.speedometerSideRight}>
                <RoundBtn label="Locate" active={follow} onPress={() => setFollow(true)} />
              </View>
            </>
          ) : (
            <>
              <Pill label="Start ride" primary onPress={startRide} />
              <RoundBtn
                label="Locate"
                active={follow}
                onPress={() => setFollow(true)}
              />
            </>
          )}
        </View>
        {drawing && (
          <Text style={styles.hint}>{draft.length ? `${draft.length}/12 waypoints` : 'Tap the map to add at least two waypoints'}</Text>
        )}
      </SafeAreaView>
      <Modal visible={addressPlanner} animationType="slide" onRequestClose={() => {
        if (!savingRoute && !savingShortcut) { setEditingShortcut(null); setAddressPlanner(false); }
      }}>
        <SafeAreaView style={styles.root}>
          <View style={styles.libraryHeader}>
            <Text style={styles.libraryTitle}>Plan a route</Text>
            <Pill label={editingShortcut ? "Back" : "Close"} disabled={savingRoute || savingShortcut} onPress={() => {
              if (editingShortcut) setEditingShortcut(null);
              else setAddressPlanner(false);
            }} />
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.libraryList}>
            {editingShortcut ? (
              <>
                <PlaceSearch key={editingShortcut} autoFocus nearbyFirst near={searchNear}
                  title={`Set ${editingShortcut}`} placeholder="Search address or place"
                  selected={null} disabled={savingShortcut} onSelect={saveShortcut} />
                {quickPlaces[editingShortcut] && <Pill label={`Remove ${editingShortcut}`}
                  disabled={savingShortcut} onPress={() => saveShortcut(null)} />}
              </>
            ) : (
              <>
                <View style={styles.quickPlaces}>
                  {['Home', 'Work'].map((label) => {
                    const place = quickPlaces[label];
                    return (
                      <View key={label} style={[styles.libraryRow, styles.quickPlace]}>
                        <Pressable accessibilityRole="button" disabled={savingRoute}
                          onPress={() => place ? previewAddressRoute(place, true) : setEditingShortcut(label)}>
                          <Text style={styles.rowTitle}>{place ? label : `Set ${label}`}</Text>
                          {place && <Text numberOfLines={1} style={styles.rowDetail}>{place.label}</Text>}
                        </Pressable>
                        {place && <Pressable accessibilityRole="button" accessibilityLabel={`Change ${label}`}
                          disabled={savingRoute} onPress={() => setEditingShortcut(label)} style={styles.retryButton}>
                          <Text style={styles.retryText}>Change</Text>
                        </Pressable>}
                      </View>
                    );
                  })}
                </View>
            <PlaceSearch key={originReset} near={searchNear} title="From" placeholder="Current location" selected={origin}
              onSelect={(place) => { setOrigin(place); setOriginNeedsSelection(false); }}
              onEdit={(value) => setOriginNeedsSelection(Boolean(value.trim()))} disabled={savingRoute} />
            {(origin || originNeedsSelection) && <Pill label="Use current location" disabled={savingRoute} onPress={() => { setOrigin(null); setOriginNeedsSelection(false); setOriginReset((value) => value + 1); }} />}
            <PlaceSearch autoFocus nearbyFirst near={origin?.point ?? searchNear} title="To" placeholder="Search address or place" selected={destination}
              onSelect={setDestination} disabled={savingRoute} />
            <Pill label={savingRoute ? "Finding roads…" : "Show route"} primary
              disabled={!destination || originNeedsSelection || savingRoute} onPress={() => previewAddressRoute()} />
            <Pill label="Pick points on map" disabled={savingRoute} onPress={() => {
              setAddressPlanner(false);
              setRoutePreview(null);
              setDrawing(true);
              setFollow(false);
            }} />
              </>
            )}
          </ScrollView>
        </SafeAreaView>
      </Modal>
      <Modal visible={libraryView !== null} transparent animationType="fade" onRequestClose={closeLibrary}>
        {libraryView === 'menu' ? (
          <View style={styles.drawerBackdrop}>
            <Pressable accessibilityRole="button" accessibilityLabel="Close side menu"
              style={StyleSheet.absoluteFill} onPress={() => setLibraryView(null)} />
            <SafeAreaView style={styles.drawer}>
              <View style={styles.libraryHeader}>
                <Text style={styles.libraryTitle}>RouteRunner</Text>
              </View>
              <View style={styles.libraryList}>
                {[['rides', 'Ride history'], ['routes', 'Saved routes'], ['settings', 'Settings'], ['account', 'Account']].map(([page, label]) => (
                  <Pressable key={page} accessibilityRole="button" style={styles.drawerItem}
                    onPress={() => {
                      if (page === 'account') {
                        setLibraryView(null);
                        openAccount();
                      } else {
                        setLibraryView(page);
                      }
                    }}>
                    <Text style={styles.rowTitle}>{label}</Text>
                    <Text style={styles.rowDetail}>›</Text>
                  </Pressable>
                ))}
                <Pill label="Close menu" onPress={() => setLibraryView(null)} />
              </View>
            </SafeAreaView>
          </View>
        ) : (
        <SafeAreaView style={styles.root}>
          <View style={styles.libraryHeader}>
            <Text style={styles.libraryTitle}>{shareRide ? 'Share ride' : rideMenu ? rideTitle(rideMenu) : recapRide ? 'Ride recap' : libraryView === 'privacy' ? 'Privacy' : libraryView === 'settings' ? 'Settings' : libraryView === 'routes' ? 'Saved routes' : 'Ride history'}</Text>
            <RoundBtn label="Back" onPress={closeLibrary} />
          </View>
          {shareRide ? (
            <RideShare ride={rides.find((ride) => rideKey(ride) === rideKey(shareRide)) ?? shareRide}
              onPhoto={(uri) => rememberRidePhoto(shareRide, uri)} />
          ) : rideMenu ? (
            <View style={styles.libraryList}>
              <Pill label={rideMenu.pinned ? 'Unpin ride' : 'Pin ride'} onPress={() => pinRide(rideMenu)} />
              <Pill label="Share ride" onPress={() => { setShareRide(rideMenu); setRideMenu(null); }} />
              <Pill label="Delete ride" onPress={() => { deleteRide(rideMenu); setRideMenu(null); }} />
            </View>
          ) : recapRide ? (
            <RideRecap ride={rides.find((ride) => rideKey(ride) === rideKey(recapRide)) ?? recapRide} onReplay={() => openRide(recapRide)} onShare={() => setShareRide(recapRide)} onRename={renameRide} />
          ) : (
          <ScrollView contentContainerStyle={styles.libraryList}>
            {libraryView === 'settings' ? (
              <>
                <Pressable accessibilityRole="switch" accessibilityState={{ checked: lightMap, disabled: !mapTheme || savingMapTheme }}
                  disabled={!mapTheme || savingMapTheme} style={styles.libraryRow} onPress={toggleLightMap}>
                  <Text style={styles.rowTitle}>Light map · {lightMap ? 'On' : 'Off'}</Text>
                  <Text style={styles.rowDetail}>Use a white and light-grey basemap.</Text>
                </Pressable>
                <Pressable accessibilityRole="switch" accessibilityState={{ checked: simplifiedMap === true }}
                  disabled={simplifiedMap === null} style={styles.libraryRow} onPress={toggleSimplifiedMap}>
                  <Text style={styles.rowTitle}>Simplified map · {simplifiedMap ? 'On' : 'Off'}</Text>
                  <Text style={styles.rowDetail}>Keep streets and road names. Hide car park lanes, paths and building outlines.</Text>
                </Pressable>
                {simplifiedMap && !simplifiedStyle && (
                  simplifiedStyleFailed
                    ? <Pill label="Retry loading simplified map" onPress={() => setStyleAttempt((value) => value + 1)} />
                    : <Text style={styles.rowDetail}>Loading simplified map…</Text>
                )}
                <Pill label="Privacy" onPress={() => setLibraryView('privacy')} />
              </>
            ) : libraryView === 'privacy' ? (
              <View style={styles.libraryRow}>
                <Text style={styles.rowTitle}>Road discovery</Text>
                <Text style={styles.rowDetail}>When enabled, GPS points are sent to Geoapify to match the roads you travel. Unmatched points may be stored on this device for retry. Turning discovery off pauses those retries. RouteRunner stores unlocked roads and ride history on this device. If you choose Cloud backup in Account, your unlocked road shapes and IDs are also stored in Supabase for restore.</Text>
                <Text style={styles.rowDetail}>Destination searches and directions also use Geoapify to look up places and calculate routes when you request them.</Text>
                {GEOAPIFY_TEST_KEY && (
                  <Pill label={discoveryChoice ? 'Turn off road discovery' : 'Allow road discovery'}
                    disabled={discoveryChoice === undefined}
                    onPress={() => discoveryChoice ? saveDiscoveryChoice(false) : askDiscoveryPermission()} />
                )}
              </View>
            ) : libraryView === 'routes' ? (
              routes.length ? routes.map((route) => {
                const [address, ...locality] = route.name.split(',').map((part) => part.trim());
                const showRoute = () => {
                  const lines = route.lines ?? [route.line];
                  setSelectedRide(null);
                  setNavigation(null);
                  setExplore(false);
                  setRoutePreview({ ...route, lines });
                  showOnMap(lines);
                };
                return (
                  <Pressable key={route.id} accessibilityRole="button" accessibilityLabel={route.name}
                    accessibilityHint="Opens the route on the map. Press and hold for delete."
                    accessibilityActions={[{ name: 'delete', label: 'Delete saved route' }]}
                    onAccessibilityAction={(event) => { if (event.nativeEvent.actionName === 'delete') deleteRoute(route); }}
                    disabled={savingRoute} onPress={showRoute} onLongPress={() => deleteRoute(route)}
                    style={({ pressed }) => [styles.savedRouteCard, pressed && styles.savedRoutePressed]}>
                    <View style={styles.savedRouteLabels}>
                      <Text style={styles.savedRouteAddress}>{address || route.name}</Text>
                      {locality.length > 0 && <Text style={styles.rowDetail}>{locality.join(', ')}</Text>}
                    </View>
                    <Text style={styles.savedRouteChevron} accessible={false}>›</Text>
                  </Pressable>
                );
              }) : <Text style={styles.rowDetail}>No saved routes yet. Use Where to? on the map to plan one.</Text>
            ) : (
              <RideHistory rides={rides} onOpen={setRecapRide} onMenu={setRideMenu} />
            )}
          </ScrollView>
          )}
        </SafeAreaView>
        )}
      </Modal>
    </View>
  );
}

function searchName(text) {
  return text.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '');
}

async function searchPlaces(query, near, signal, nearbyFirst) {
  const name = searchName(query);
  const chain = ['mcdonald', 'mcdonalds', 'maccas'].includes(name) ? "McDonald's"
    : name === 'kfc' || name === 'kentuckyfriedchicken' ? 'KFC' : null;
  const lookup = chain ?? query.replace(/’/g, "'");
  const isChainName = (value) => {
    const normalized = searchName(value);
    return chain === 'KFC'
      ? normalized === 'kentuckyfriedchicken' || /^kfc(?:\b|$)/i.test(value.trim())
      : normalized === 'mcdonalds' || /^mcdonald['’]s\b/i.test(value.trim());
  };
  const bias = near ? `&bias=${encodeURIComponent(`proximity:${near.join(',')}`)}` : '';
  const key = encodeURIComponent(GEOAPIFY_TEST_KEY);
  const fetchPlaces = async (filter = '') => {
    const params = `text=${encodeURIComponent(lookup)}&format=json&limit=8${bias}&apiKey=${key}`;
    const response = await fetch(`https://api.geoapify.com/v1/geocode/autocomplete?${params}${filter}`, { signal });
    if (!response.ok) throw new Error('Place search failed');
    const result = await response.json();
    return (result.results ?? []).flatMap(({ formatted, lon, lat, name: placeName, result_type }) => {
      if (!formatted || !Number.isFinite(lon) || !Number.isFinite(lat)) return [];
      const namedBusiness = result_type === 'amenity' && placeName;
      if (chain && (!namedBusiness || !isChainName(placeName))) return [];
      return [{ label: formatted, point: [lon, lat], businessName: namedBusiness || null }];
    });
  };

  if (near && (nearbyFirst || chain)) {
    const radius = nearbyFirst ? 15000 : 50000;
    const circle = encodeURIComponent(`circle:${near.join(',')},${radius}`);
    const localFilter = `&filter=${circle}`;
    const queries = [fetchPlaces(localFilter)];
    if (!/^\d+[a-z]?\s/i.test(query)) {
      const categories = chain ? 'catering' : 'catering,commercial';
      const url = `https://api.geoapify.com/v2/places?categories=${categories}&name=${encodeURIComponent(lookup)}&limit=8${bias}${localFilter}&apiKey=${key}`;
      queries.push((async () => {
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error('Business search failed');
        const data = await response.json();
        return (data.features ?? []).flatMap(({ properties, geometry }) => {
          const point = geometry?.coordinates;
          if (!properties?.name || !Array.isArray(point) ||
              !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return [];
          if (chain && !isChainName(properties.name)) return [];
          const address = properties.address_line2 || properties.formatted;
          const label = address && !address.startsWith(properties.name)
            ? `${properties.name}, ${address}` : address || properties.name;
          return [{ label, point, businessName: properties.name }];
        });
      })());
    }
    const responses = await Promise.allSettled(queries);
    if (signal?.aborted) return [];
    if (responses.every(({ status }) => status === 'rejected')) throw responses[0].reason;
    const [addresses, businesses = []] = responses.map((result) => result.status === 'fulfilled' ? result.value : []);
    const rank = ({ businessName }) => {
      if (!businessName) return 0;
      return (chain ? isChainName(businessName) : searchName(businessName) === name) ? 2 : 1;
    };
    const nearby = [...businesses, ...addresses].sort((a, b) =>
      rank(b) - rank(a) || distM(near, a.point) - distM(near, b.point));
    const seen = new Set();
    const results = nearby.filter(({ point, businessName }) => {
      const id = `${point[0].toFixed(4)},${point[1].toFixed(4)}:${searchName(businessName ?? '')}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (results.length || chain) return results.slice(0, 8);
  }
  return fetchPlaces();
}

function PlaceSearch({ near, nearbyFirst = false, autoFocus = false, title, placeholder, selected, onSelect, onEdit, disabled }) {
  const [query, setQuery] = useState(selected?.label ?? '');
  const [searchFarther, setSearchFarther] = useState(false);
  const [results, setResults] = useState([]);
  const [status, setStatus] = useState('');
  useEffect(() => {
    if (selected) {
      setQuery(selected.label);
      setResults([]);
      setStatus('');
      return;
    }
    if (query.trim().length < 3 || disabled) return;
    if (!GEOAPIFY_TEST_KEY) {
      setStatus('Place search needs a Geoapify key.');
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setStatus('Searching…');
      try {
        const places = await searchPlaces(query.trim(), near, controller.signal, nearbyFirst && !searchFarther);
        if (controller.signal.aborted) return;
        setResults(places);
        setStatus(places.length ? '' : 'No places found.');
      } catch {
        if (!controller.signal.aborted) setStatus('Search failed. Try editing the address.');
      }
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, selected, disabled, near, nearbyFirst, searchFarther]);

  return (
    <View style={styles.libraryRow}>
      <Text style={styles.rowTitle}>{title}</Text>
      <TextInput accessibilityLabel={title} style={styles.placeInput} value={query}
        placeholder={placeholder} placeholderTextColor="#aaa" editable={!disabled}
        autoFocus={autoFocus} autoCorrect={false} onChangeText={(value) => {
          if (selected) onSelect(null);
          onEdit?.(value);
          setQuery(value);
          setResults([]);
          setStatus('');
        }} />
      {status ? <Text style={styles.rowDetail}>{status}</Text> : null}
      {near && nearbyFirst && !selected && query.trim().length >= 3 && (
        <Pressable accessibilityRole="button" style={styles.placeResult} disabled={disabled}
          onPress={() => { setResults([]); setSearchFarther((farther) => !farther); }}>
          <Text style={styles.retryText}>{searchFarther ? 'Search nearby' : 'Search farther'}</Text>
        </Pressable>
      )}
      {results.map((place, index) => (
        <Pressable accessibilityRole="button" key={`${place.label}-${index}`}
          style={styles.placeResult} onPress={() => onSelect(place)}>
          <Text style={styles.rowDetail}>{place.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function KeepDirectionsAwake() {
  useKeepAwake('route-runner-directions', { suppressDeactivateWarnings: true });
  return null;
}

function NavigationPanel({ navigation, rerouteStatus, onEnd }) {
  const step = navigation.steps[navigation.index];
  const remaining = Math.max(0, navigation.totalMeters - navigation.progress);
  const travelSeconds = remainingTravelSeconds(navigation);
  const eta = travelSeconds != null
    ? new Date(Date.now() + travelSeconds * 1000)
      .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null;
  const status = navigation.arrived ? 'Destination reached' : rerouteStatus;
  const distance = formatTurnDistance(step.meters - navigation.progress);
  return (
    <View style={styles.navigationPanel}>
      <View style={styles.navigationMain} accessible accessibilityLabel={status || `${distance}, ${step.text}`}>
        <Text style={styles.maneuverArrow}>
          {navigation.arrived ? '⚑' : rerouteStatus ? '↻' : maneuverArrow(step.type)}
        </Text>
        <View style={styles.maneuverDetails}>
          {status ? <Text style={styles.maneuverStatus}>{status}</Text> : (
            <>
              <Text style={styles.maneuverDistance}>{distance}</Text>
              <Text style={styles.maneuverInstruction} numberOfLines={3}>{step.text}</Text>
            </>
          )}
        </View>
      </View>
      <View style={styles.navigationFooter}>
        {!navigation.arrived && (
          <Text style={styles.navigationRemaining}>
            {formatTurnDistance(remaining)} left{eta ? ` · Est. arrival ${eta}` : ''}
          </Text>
        )}
        <Pressable accessibilityRole="button" accessibilityLabel="End directions"
          style={styles.endDirections} onPress={onEnd}>
          <Text style={styles.endDirectionsText}>End</Text>
        </Pressable>
      </View>
    </View>
  );
}

const rideKey = (ride) => ride.startedAt != null ? `started-${ride.startedAt}` : `saved-${ride.date}`;

function ridePhotoUri(file) {
  if (typeof file !== 'string' || !/^ride-memory-(?:started|saved)-\d+-\d+\.jpg$/.test(file) || !FileSystem.documentDirectory) return null;
  return FileSystem.documentDirectory + file;
}

function rideTitle(ride) {
  if (ride.title?.trim()) return ride.title.trim();
  const hour = new Date(ride.startedAt ?? ride.date).getHours();
  return `${hour < 5 || hour >= 20 ? 'Night' : hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening'} ride`;
}

function rideSections(rides) {
  const sections = new Map();
  for (const ride of [...rides].sort((a, b) => b.date - a.date)) {
    const month = ride.pinned ? 'Pinned rides' : new Date(ride.date).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    if (!sections.has(month)) sections.set(month, []);
    sections.get(month).push(ride);
  }
  return [...sections].sort(([a], [b]) => Number(b === 'Pinned rides') - Number(a === 'Pinned rides'));
}

function rideArtwork(ride) {
  const lines = splitRecordedPath(ride.line);
  if (!lines.length) return [];
  const [origin, latitude] = lines[0][0];
  const projected = lines.map((line) => line.map(([lon, lat]) => [
    (((lon - origin + 540) % 360) - 180) * Math.cos(toRad(latitude)), latitude - lat,
  ]));
  const bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  for (const line of projected) {
    for (const [x, y] of line) {
      bounds.left = Math.min(bounds.left, x);
      bounds.top = Math.min(bounds.top, y);
      bounds.right = Math.max(bounds.right, x);
      bounds.bottom = Math.max(bounds.bottom, y);
    }
  }
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const scale = Math.min(272 / Math.max(width, 1e-9), 196 / Math.max(height, 1e-9));
  return projected.map((line) => line.map(([x, y]) =>
    `${160 + (x - bounds.left - width / 2) * scale},${122 + (y - bounds.top - height / 2) * scale}`).join(' '));
}

function RideLine({ paths, thumbnail = false, withPhoto = false, height = '66%' }) {
  return (
    <Svg width={thumbnail ? 78 : '100%'} height={thumbnail ? 68 : height} viewBox="0 0 320 244">
      {paths.map((points, index) => (
        <React.Fragment key={index}>
          <Polyline points={points} fill="none" stroke={withPhoto ? '#141416' : '#fff'}
            strokeWidth={thumbnail ? 14 : 9} strokeLinejoin="round" strokeLinecap="round" />
          <Polyline points={points} fill="none" stroke="#FF2D95"
            strokeWidth={thumbnail ? 9 : 5} strokeLinejoin="round" strokeLinecap="round" />
        </React.Fragment>
      ))}
    </Svg>
  );
}

function RideRecap({ ride, onReplay, onShare, onRename }) {
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const photo = ridePhotoUri(ride.photoFile);
  const saveTitle = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onRename(ride, draftTitle.trim());
      setEditing(false);
    } catch {
      Alert.alert('Could not save title', 'Try again.');
    } finally {
      setSaving(false);
    }
  };
  const paths = React.useMemo(() => rideArtwork(ride), [ride]);
  const hasDistance = Number.isFinite(ride.meters);
  const hasDuration = Number.isFinite(ride.seconds);
  const top = Number.isFinite(ride.top) ? formatSpeed(ride.top) : 'Unavailable';
  const average = hasDistance && hasDuration && ride.seconds > 0 ? formatSpeed(averageSpeed(ride)) : 'Unavailable';
  const metrics = [
    ['Distance', hasDistance ? formatDistance(ride.meters) : 'Unavailable'],
    ['Duration', hasDuration ? fmtTime(ride.seconds) : 'Unavailable'],
    ['Average speed', average],
    ['Top speed', top],
  ];

  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.recap}>
      <View style={styles.recapHero}>
        <View style={styles.recapHeroHeader}>
          <Text accessibilityRole="header" style={styles.recapTitle}>{rideTitle(ride)}</Text>
          <Text style={styles.rowDetail}>
            {new Date(ride.startedAt ?? ride.date).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
          </Text>
        </View>
        {paths.length > 0 ? (
          <View style={styles.recapTrace}><RideLine paths={paths} height="100%" /></View>
        ) : <Text style={styles.rowDetail}>No connected GPS path was saved for this ride.</Text>}
      </View>
      <View style={styles.recapMetrics}>
        {metrics.map(([label, value]) => (
          <View key={label} style={styles.recapStat}>
            <Text style={styles.recapStatLabel}>{label}</Text>
            <Text style={styles.recapStatValue} adjustsFontSizeToFit numberOfLines={1}>{value}</Text>
          </View>
        ))}
      </View>
      {ride.unlockCount != null && (
        <View style={styles.recapUnlock}>
          <Text style={styles.recapUnlockValue}>{ride.unlockCount > 0 ? '+' : ''}{ride.unlockCount}</Text>
          <View style={styles.recapUnlockLabel}>
            <Text style={styles.rowTitle}>New roads unlocked</Text>
            {ride.unlocksIncomplete && <Text style={styles.rowDetail}>Partial matching results</Text>}
          </View>
        </View>
      )}
      {editing ? (
        <View style={styles.libraryRow}>
          <Text style={styles.rowTitle}>Ride title</Text>
          <TextInput value={draftTitle} autoFocus editable={!saving} maxLength={60} onChangeText={setDraftTitle}
            accessibilityLabel="Ride title" placeholder="Leave blank to use the default title"
            placeholderTextColor="#aaa" style={styles.placeInput} />
          <Pill label={saving ? 'Saving…' : 'Save title'} primary disabled={saving} onPress={saveTitle} />
          <Pill label="Cancel" disabled={saving} onPress={() => setEditing(false)} />
        </View>
      ) : <Pill label="Customise" onPress={() => { setDraftTitle(ride.title ?? ''); setEditing(true); }} />}
      {paths.length > 0 && <Pill label="Replay on map" primary onPress={onReplay} />}
      <Pill label="Share ride" onPress={onShare} />
      {photo && <Image source={{ uri: photo }} accessibilityLabel="Photo from this ride" style={styles.rideMemoryPhoto} resizeMode="cover" />}
    </ScrollView>
  );
}

function RideHistory({ rides, onOpen, onMenu }) {
  if (!rides.length) return <Text style={styles.rowDetail}>No rides yet. Start a ride from the map.</Text>;
  return (
    <>
      <Text style={styles.rowDetail}>Tap to view a ride. Press and hold for ride options.</Text>
      {rideSections(rides).map(([heading, entries]) => (
        <View key={heading} style={styles.historySection}>
          <Text accessibilityRole="header" style={styles.historyHeading}>{heading}</Text>
          {entries.map((ride) => (
            <Pressable key={rideKey(ride)} accessibilityRole="button"
              accessibilityHint="Opens the ride. Use ride options to pin, delete or share."
              accessibilityActions={[{ name: 'options', label: 'Ride options' }]}
              onAccessibilityAction={(event) => { if (event.nativeEvent.actionName === 'options') onMenu(ride); }}
              onPress={() => onOpen(ride)} onLongPress={() => onMenu(ride)}
              style={({ pressed }) => [styles.historyCard, pressed && { opacity: 0.75 }]}>
              <View style={styles.historyCardContent}>
                <Text style={styles.rowTitle}>{rideTitle(ride)}</Text>
                <Text style={styles.rowDetail}>{new Date(ride.date).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</Text>
                <Text style={styles.historyMetrics}>{formatDistance(ride.meters)}  ·  {fmtTime(ride.seconds)}</Text>
                {ride.unlockCount != null && <Text style={styles.rowDetail}>{ride.unlockCount} new road sections{ride.unlocksIncomplete ? ' (partial)' : ''}</Text>}
              </View>
              <RideLine thumbnail paths={rideArtwork(ride)} />
            </Pressable>
          ))}
        </View>
      ))}
    </>
  );
}

function RideShare({ ride, onPhoto }) {
  const { width } = useWindowDimensions();
  const [photo, setPhoto] = useState(() => ridePhotoUri(ride.photoFile));
  const [photoReady, setPhotoReady] = useState(() => !ridePhotoUri(ride.photoFile));
  const [busy, setBusy] = useState(false);
  const canvas = useRef(null);
  const working = useRef(false);
  const paths = React.useMemo(() => rideArtwork(ride), [ride]);
  const size = Math.min(width - 32, 360);

  const takePhoto = async () => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    try {
      const { granted } = await ImagePicker.requestCameraPermissionsAsync();
      if (!granted) {
        Alert.alert('Camera access needed', 'Allow camera access in Settings to take a background photo.');
        return;
      }
      const result = await ImagePicker.launchCameraAsync({ quality: 0.85, allowsEditing: false });
      if (!result.canceled && result.assets[0]?.uri) {
        setPhotoReady(false);
        const snapshot = result.assets[0].uri;
        try {
          setPhoto(await onPhoto(snapshot));
        } catch {
          setPhoto(snapshot);
          Alert.alert('Photo could not be saved to the recap', 'You can still use it for this share card.');
        }
      }
    } catch {
      Alert.alert('Could not open camera', 'Try again, or share with a transparent background.');
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  const share = async () => {
    if (working.current || !photoReady) return;
    working.current = true;
    setBusy(true);
    let uri;
    try {
      if (!(await Sharing.isAvailableAsync())) {
        Alert.alert('Sharing unavailable', 'This device does not support the share sheet.');
        return;
      }
      uri = await captureRef(canvas.current, { format: 'png', useRenderInContext: true });
      await Sharing.shareAsync(uri, { mimeType: 'image/png', UTI: 'public.png', dialogTitle: 'Share ride' });
    } catch {
      Alert.alert('Could not share ride', 'Try again.');
    } finally {
      if (uri) releaseCapture(uri);
      working.current = false;
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.libraryList}>
      <Text style={styles.rowDetail}>{photo ? 'Photo background' : 'Transparent background'}{!photoReady && ' · Loading photo…'}</Text>
      <View style={styles.sharePreview}>
        <View ref={canvas} collapsable={false} style={[styles.shareCanvas, { width: size, height: size }]}>
          {photo && (
            <Image key={photo} source={{ uri: photo }} style={StyleSheet.absoluteFill} resizeMode="cover"
              onLoad={() => setPhotoReady(true)} onError={() => {
                setPhoto(null);
                setPhotoReady(true);
                Alert.alert('Photo could not load', 'Take another photo or share the transparent image.');
              }} />
          )}
          <RideLine paths={paths} withPhoto={Boolean(photo)} />
          <View style={styles.shareStats}>
            <Text style={styles.shareMetric}>{formatDistance(ride.meters)}  ·  {fmtTime(ride.seconds)}</Text>
            <Text style={styles.shareSpeed}>Avg {formatSpeed(averageSpeed(ride))}  ·  Top {formatSpeed(ride.top)}</Text>
          </View>
        </View>
      </View>
      <Pill label="Take background photo" disabled={busy} onPress={takePhoto} />
      {photo && <Pill label="Use transparent background" disabled={busy} onPress={() => { setPhoto(null); setPhotoReady(true); }} />}
      <Pill label="Share PNG" primary disabled={busy || !photoReady} onPress={share} />
    </ScrollView>
  );
}

function RoundBtn({ label, onPress, active }) {
  return (
    <Pressable onPress={onPress} style={[styles.round, active && { borderColor: PINK }]}>
      <Text style={styles.roundText}>{label}</Text>
    </Pressable>
  );
}
function Pill({ label, onPress, primary, disabled = false }) {
  return (
    <Pressable disabled={disabled} onPress={onPress} style={[styles.pill, primary && styles.pillPrimary, disabled && { opacity: 0.5 }]}>
      <Text style={[styles.pillText, primary && { color: '#fff' }]}>{label}</Text>
    </Pressable>
  );
}
function speedometerReading(metersPerSecond) {
  const speed = Math.max(0, (Number.isFinite(metersPerSecond) ? metersPerSecond : 0) * (useMiles ? 2.236936 : 3.6));
  const dialMax = useMiles ? 90 : 140;
  return { speed: Math.round(speed), fill: Math.min(1, speed / dialMax) };
}

const SPEEDOMETER_SIZE = 120;

function speedometerArc(fill) {
  const center = SPEEDOMETER_SIZE / 2;
  const radius = 49;
  const angle = 135 * Math.PI / 180;
  const sweep = Math.PI * 1.5 * fill;
  const point = (radians) => `${center + radius * Math.cos(radians)} ${center + radius * Math.sin(radians)}`;
  return `M ${point(angle)} A ${radius} ${radius} 0 ${sweep > Math.PI ? 1 : 0} 1 ${point(angle + sweep)}`;
}

function RideSpeedometer({ speed: metersPerSecond }) {
  const { speed, fill } = speedometerReading(metersPerSecond);
  const hasSpeed = metersPerSecond != null;
  return (
    <View style={styles.speedometer} accessible accessibilityLabel={hasSpeed ? `Current speed ${speed} ${useMiles ? 'miles per hour' : 'kilometres per hour'}` : 'Waiting for GPS speed'}>
      <View pointerEvents="none" style={styles.speedometerDial} accessible={false}>
        <Svg width={SPEEDOMETER_SIZE} height={SPEEDOMETER_SIZE} viewBox={`0 0 ${SPEEDOMETER_SIZE} ${SPEEDOMETER_SIZE}`}>
          <Path d={speedometerArc(1)} stroke="#49414c" strokeWidth={7} fill="none" strokeLinecap="round" />
          {fill > 0 && <Path d={speedometerArc(fill)} stroke={PINK} strokeWidth={7} fill="none" strokeLinecap="round" />}
        </Svg>
      </View>
      <Text style={styles.speedometerValue} numberOfLines={1} adjustsFontSizeToFit>{hasSpeed ? speed : '–'}</Text>
      <Text style={styles.speedometerUnit}>{speedUnit}</Text>
    </View>
  );
}

function Stat({ label, value }) {
  return (
    <View style={{ alignItems: 'center', flex: 1 }}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#161616' },
  topRow: { flexDirection: 'row', paddingHorizontal: 16, paddingTop: 8 },
  explorePanel: { marginHorizontal: 12, marginTop: 8, borderRadius: 16, padding: 12, gap: 8, backgroundColor: PANEL },
  exploreCards: { flexDirection: 'row', gap: 6 },
  exploreCard: { flex: 1, minWidth: 0, padding: 8, borderRadius: 10, borderWidth: 1, gap: 3, backgroundColor: '#19191d' },
  exploreDuration: { fontSize: 16, fontWeight: '800' },
  exploreMetric: { color: '#d2d2d8', fontSize: 12 },
  exploreActions: { flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, paddingVertical: 5 },
  loopEstimate: { color: "#fff", textAlign: "center", marginBottom: 6, backgroundColor: PANEL },
  startDirections: { alignSelf: 'center', marginBottom: 8 },
  mapSearch: { marginHorizontal: 16, marginBottom: 10, padding: 15, borderRadius: 16, backgroundColor: PANEL, borderWidth: 1, borderColor: '#555' },
  mapSearchText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  speedometer: { width: SPEEDOMETER_SIZE, height: SPEEDOMETER_SIZE, borderRadius: SPEEDOMETER_SIZE / 2, backgroundColor: '#17141b', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18, flexShrink: 0 },
  speedometerDial: { position: 'absolute', top: 0, left: 0, width: SPEEDOMETER_SIZE, height: SPEEDOMETER_SIZE },
  speedometerValue: { color: '#fff', fontSize: 41, fontWeight: '800', lineHeight: 47, fontVariant: ['tabular-nums'] },
  speedometerUnit: { color: '#e2c3d5', fontSize: 13, fontWeight: '700' },
  speedometerStandalone: { alignSelf: 'center', marginBottom: 8 },
  speedometerSideLeft: { flex: 1, alignItems: 'flex-start' },
  speedometerSideRight: { flex: 1, alignItems: 'flex-end' },
  bottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  round: {
    minWidth: 62,
    height: 52,
    paddingHorizontal: 12,
    borderRadius: 26,
    backgroundColor: PANEL,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#333',
  },
  roundText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  pill: {
    height: 56,
    paddingHorizontal: 26,
    borderRadius: 28,
    backgroundColor: PANEL,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#333',
  },
  pillPrimary: { backgroundColor: PINK, borderColor: PINK },
  pillText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  statsBar: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginTop: 10,
    paddingVertical: 12,
    borderRadius: 16,
    backgroundColor: PANEL,
  },
  statValue: { color: '#fff', fontSize: 14, fontWeight: '700' },
  statLabel: { color: '#9a9aa0', fontSize: 12, marginTop: 2 },
  banner: { margin: 16, padding: 12, borderRadius: 12, backgroundColor: PANEL },
  bannerText: { color: '#fff', fontSize: 14 },
  retryButton: { alignSelf: 'flex-start', paddingVertical: 10 },
  retryText: { color: '#FF80BE', fontWeight: '700' },
  libraryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
  },
  libraryTitle: { color: '#fff', fontSize: 25, fontWeight: '700' },
  rideMemoryPhoto: { width: '100%', aspectRatio: 4 / 3, borderRadius: 18, backgroundColor: '#222227' },
  recap: { padding: 16, gap: 14 },
  recapHero: { padding: 16, borderRadius: 20, borderWidth: 1, borderColor: '#4f2640', backgroundColor: '#20131e', gap: 8 },
  recapHeroHeader: { gap: 4 },
  recapTitle: { color: '#fff', fontWeight: '800', fontSize: 30 },
  recapTrace: { height: 160, justifyContent: 'center' },
  recapMetrics: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 9 },
  recapStat: { width: '48.5%', borderRadius: 15, backgroundColor: '#222227', padding: 14, gap: 5 },
  recapStatLabel: { color: '#b9b9c0', fontSize: 13, fontWeight: '700' },
  recapStatValue: { color: '#fff', fontSize: 27, fontWeight: '800', fontVariant: ['tabular-nums'] },
  recapUnlock: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderRadius: 15, backgroundColor: '#142c23' },
  recapUnlockValue: { color: '#77F2AE', fontWeight: '800', fontSize: 32 },
  recapUnlockLabel: { flex: 1, gap: 4 },
  historySection: { gap: 9, marginTop: 8 },
  historyHeading: { color: '#e6e6ea', fontSize: 16, fontWeight: '800', marginTop: 4 },
  historyCard: { padding: 14, flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 16, backgroundColor: '#222227' },
  historyCardContent: { flex: 1, gap: 4 },
  historyMetrics: { color: '#fff', fontWeight: '700', fontSize: 15 },
  sharePreview: { alignSelf: 'center', backgroundColor: '#484850', borderRadius: 16, overflow: 'hidden' },
  shareCanvas: { overflow: 'hidden', backgroundColor: 'transparent', justifyContent: 'space-between' },
  shareStats: { alignItems: 'center', gap: 4, paddingBottom: 14 },
  shareMetric: { color: '#fff', fontSize: 25, fontWeight: '800', backgroundColor: '#141416', paddingHorizontal: 8 },
  shareSpeed: { color: '#fff', fontSize: 14, fontWeight: '700', backgroundColor: '#141416', paddingHorizontal: 8 },
  quickPlaces: { flexDirection: 'row', gap: 8 },
  quickPlace: { flex: 1, minWidth: 0 },
  menuIcon: { color: '#fff', fontSize: 23, lineHeight: 29 },
  drawerBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.62)' },
  drawer: { flex: 1, width: '78%', maxWidth: 340, backgroundColor: '#19191d', borderRightWidth: 1, borderColor: '#35353d' },
  drawerItem: { minHeight: 54, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#25252b', borderRadius: 12 },
  libraryList: { padding: 16, gap: 10 },
  savedRouteCard: { minHeight: 76, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: '#222227', borderRadius: 16, borderWidth: 1, borderColor: '#3d3a43' },
  savedRoutePressed: { backgroundColor: '#392231', borderColor: '#FF2D95', transform: [{ scale: 0.985 }] },
  savedRouteLabels: { flex: 1, gap: 4 },
  savedRouteAddress: { color: '#fff', fontSize: 19, fontWeight: '700' },
  savedRouteChevron: { color: '#FF80BE', fontSize: 29, fontWeight: '600' },
  libraryRow: { padding: 16, borderRadius: 14, backgroundColor: PANEL, gap: 5 },
  navigationPanel: { margin: 12, paddingHorizontal: 16, paddingTop: 12, backgroundColor: '#141416', borderRadius: 20 },
  navigationMain: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  maneuverArrow: { color: '#fff', fontSize: 62, lineHeight: 72, fontWeight: '700', minWidth: 66, textAlign: 'center' },
  maneuverDetails: { flex: 1 },
  maneuverDistance: { color: '#fff', fontSize: 44, fontWeight: '800', fontVariant: ['tabular-nums'] },
  maneuverInstruction: { color: '#f4f4f6', fontSize: 19, fontWeight: '600' },
  maneuverStatus: { color: '#fff', fontSize: 23, fontWeight: '700' },
  navigationFooter: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  navigationRemaining: { color: '#d2d2d8', fontSize: 15, flex: 1 },
  endDirections: { minWidth: 50, minHeight: 48, justifyContent: 'center', alignItems: 'center', marginLeft: 'auto' },
  endDirectionsText: { color: '#FF80BE', fontSize: 16, fontWeight: '700' },
  rowTitle: { color: '#fff', fontSize: 17, fontWeight: '600' },
  placeInput: { color: '#fff', fontSize: 16, paddingVertical: 10 },
  placeResult: { paddingVertical: 12, borderTopWidth: StyleSheet.hairlineWidth, borderColor: '#52525a' },
  rowDetail: { color: '#b9b9c0', fontSize: 14 },
  hint: {
    position: 'absolute',
    bottom: 96,
    alignSelf: 'center',
    color: '#fff',
    backgroundColor: PANEL,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 14,
    overflow: 'hidden',
  },
});
