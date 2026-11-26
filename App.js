import React, { useEffect, useRef, useState, useCallback } from 'react';
import { View, Text, Pressable, StyleSheet, Alert, SafeAreaView, Modal, ScrollView, Platform, TextInput, NativeModules, Image, useWindowDimensions } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as ImagePicker from 'expo-image-picker';
import * as Sharing from 'expo-sharing';
import Svg, { Polyline } from 'react-native-svg';
import { captureRef, releaseCapture } from 'react-native-view-shot';
import AsyncStorage from '@react-native-async-storage/async-storage';
import MapLibreGL from '@maplibre/maplibre-react-native';

// ---- Design tokens -------------------------------------------------------
const PINK = '#FF2D95';
const ROAD_WHITE = '#FFFFFF';
const PANEL = 'rgba(20,20,22,0.92)';

const MAP_STYLE = 'https://tiles.openfreemap.org/styles/dark';

const TRAIL_KEY = 'trail:matched:v1';
const MATCH_INTERVAL_MS = 30_000;
const GEOAPIFY_TEST_KEY = process.env.EXPO_PUBLIC_GEOAPIFY_TEST_KEY?.trim();
const ROUTES_KEY = 'routes:v1';
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

async function planRoadRoute(points, includeSurfaces = false) {
  // The Routing API takes latitude first. The response uses GeoJSON order.
  const waypoints = points.map(([lon, lat]) => `${lat},${lon}`).join('|');
  const query = `waypoints=${encodeURIComponent(waypoints)}&mode=drive&format=geojson&details=instruction_details${includeSurfaces ? ',route_details' : ''}&apiKey=${encodeURIComponent(GEOAPIFY_TEST_KEY)}`;
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
    return { lines: geometry.coordinates.filter((line) => line.length > 1), steps, seconds: feature.properties?.time, unsealed };
  } finally {
    clearTimeout(timeout);
  }
}

async function buildDirections(here, remaining, plannedRoute) {
  const { lines, steps: instructions, seconds } = plannedRoute ?? await planRoadRoute([here, ...remaining]);
  const steps = [...instructions];
  if (!lines.length || !steps.length) return null;
  const offsets = routeOffsets(lines);
  const totalMeters = offsets.at(-1).at(-1);
  const end = lines.at(-1).at(-1);
  if (totalMeters - steps.at(-1).meters > 10) {
    steps.push({ point: end, meters: totalMeters, type: 'DestinationReached', text: 'Continue to your destination' });
  }
  return {
    lines, steps, remaining, offsets, totalMeters, seconds, progress: 0,
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

async function findExploreLoop(here, minutes, preferSealed, unlocked) {
  const radius = minutes * 190;
  const candidates = await Promise.allSettled([0, 90, 180, 270].map(async (heading, index) => {
    const reach = radius * (index % 2 ? 1.25 : 0.85);
    const waypoints = [here, offsetPoint(here, heading, reach), offsetPoint(here, heading + 65, reach), here];
    const route = await planRoadRoute(waypoints, preferSealed);
    if (!route.lines.length || !route.steps.length || !(route.seconds > 0)) return null;
    const cells = trailCells(route.lines);
    if (cells.size < 4) return null;
    const novel = [...cells].filter((cell) => !unlocked.has(cell)).length / cells.size;
    const minutesOff = Math.abs(route.seconds / 60 - minutes) / minutes;
    const sealedPenalty = preferSealed ? Math.min(2, route.unsealed / 1000) : 0;
    const meters = routeOffsets(route.lines).at(-1).at(-1);
    return { route, waypoints, novel, cells, minutesOff, sealedPenalty, meters };
  }));
  return candidates.flatMap((candidate) => candidate.status === 'fulfilled' && candidate.value ? [candidate.value] : []);
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
    const score = ({ novel, minutesOff, sealedPenalty }) => novel * 2 - minutesOff - sealedPenalty;
    const best = nearTarget.length
      ? pool.sort((a, b) => score(b) - score(a))[0]
      : pool.sort((a, b) => a.minutesOff - b.minutesOff || score(b) - score(a))[0];
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
  const cameraRef = useRef(null);
  const knownRoads = useRef(new Set());
  const rideUnlocks = useRef(new Map());
  const rideMatchingFailed = useRef(false);
  const trailRef = useRef([]); // array of line segments
  const lastPtRef = useRef(null);
  const pendingSamples = useRef([]);
  const matchQueue = useRef(Promise.resolve());
  const [matchingFailed, setMatchingFailed] = useState(false);
  const [trailLoaded, setTrailLoaded] = useState(false);

  const [trail, setTrail] = useState([]);
  const [routes, setRoutes] = useState([]);
  const [rides, setRides] = useState([]);
  const rideWrites = useRef(Promise.resolve());
  const [libraryView, setLibraryView] = useState(null);
  const [rideMenu, setRideMenu] = useState(null);
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
  const currentPoint = useRef(null);
  const [searchNear, setSearchNear] = useState(null);
  const [navigation, setNavigation] = useState(null);
  const navigationFix = useRef(null);
  const [rerouteStatus, setRerouteStatus] = useState(null);

  const activeLines = navigation?.lines;
  const arrived = navigation?.arrived;
  const remainingStops = navigation?.remaining;
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
          const updated = await buildDirections(point, remaining);
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
      setNavigation((state) => {
        if (!state || state.lines !== activeLines || state.arrived) return state;
        progress = Math.max(progress, fixOnRoute.meters);
        let index = state.index;
        while (index < state.steps.length - 1 && progress >= state.steps[index].meters + 8) index += 1;
        const reached = progress >= state.totalMeters - 25 && distM(point, state.lines.at(-1).at(-1)) <= 30;
        return { ...state, progress, index, arrived: reached };
      });
    }, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [activeLines, activeOffsets, arrived, remainingStops]);
  const [savingRoute, setSavingRoute] = useState(false);
  const savingRouteRef = useRef(false);

  useEffect(() => {
    AsyncStorage.getItem(RIDES_KEY).then((saved) => {
      if (saved) setRides(JSON.parse(saved));
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
          setTrail([...trailRef.current]);
        }
        const r = await AsyncStorage.getItem(ROUTES_KEY);
        if (r) setRoutes(JSON.parse(r));
      } catch (e) {}
      setTrailLoaded(true);
    })();
  }, []);

  const updateRides = (change) => {
    const write = rideWrites.current.then(async () => {
      const raw = await AsyncStorage.getItem(RIDES_KEY);
      const next = change(raw ? JSON.parse(raw) : []);
      await AsyncStorage.setItem(RIDES_KEY, JSON.stringify(next));
      setRides(next);
    });
    rideWrites.current = write.catch(() => {});
    return write;
  };

  const flushSamples = useCallback((keepLast = false) => {
    const samples = pendingSamples.current;
    pendingSamples.current = keepLast ? samples.slice(-1) : [];
    if (!GEOAPIFY_TEST_KEY || samples.length < 2) return;

    const rideId = samples[0].rideId;
    matchQueue.current = matchQueue.current.then(async () => {
      try {
        const matched = await matchRoads(samples);
        if (!matched.length) return;
        const next = [...trailRef.current, ...matched.flatMap(({ lines }) => lines)];
        const fresh = new Map();
        for (const { roads } of matched) {
          for (const { id, line } of roads) {
            if (!knownRoads.current.has(id)) {
              const segments = fresh.get(id) ?? [];
              segments.push(line);
              fresh.set(id, segments);
            }
          }
        }
        const roadIds = [...knownRoads.current, ...fresh.keys()];
        await AsyncStorage.setItem(TRAIL_KEY, JSON.stringify({ lines: next, roadIds }));
        for (const [id, segments] of fresh) {
          knownRoads.current.add(id);
          if (rideId != null && rideId === rideStartedAt.current) rideUnlocks.current.set(id, segments);
        }
        trailRef.current = next;
        setTrail(next);
        setMatchingFailed(false);
      } catch {
        if (rideId != null && rideId === rideStartedAt.current) rideMatchingFailed.current = true;
        setMatchingFailed(true);
      }
    });
  }, []);

  const onLocation = useCallback(
    (loc) => {
      const { longitude, latitude, accuracy } = loc.coords;
      if (!(accuracy > 0 && accuracy <= 30)) return;
      const pt = [longitude, latitude];
      const recording = ridingRef.current && loc.timestamp >= rideStartedAt.current;
      if (GEOAPIFY_TEST_KEY) {
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
        if (status !== 'granted') return;
        sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 5, timeInterval: 1000 },
          (location) => {
            currentPoint.current = [location.coords.longitude, location.coords.latitude];
            const { accuracy } = location.coords;
            if (accuracy > 0 && accuracy <= 35) {
              navigationFix.current = { point: currentPoint.current, accuracy, timestamp: location.timestamp };
              setSearchNear((near) => near ?? currentPoint.current);
            }
            if (!backgroundRideRef.current) onLocation(location);
          }
        );
        if (!active) sub.remove();
      } catch {
        if (active) setLocationFailed(true);
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
    }, MATCH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [trailLoaded, flushSamples]);

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
    rideUnlocks.current = new Map();
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
      unlockCount: GEOAPIFY_TEST_KEY ? rideUnlocks.current.size : null,
      unlockLines: [...rideUnlocks.current.values()].flat(),
      unlocksIncomplete: rideMatchingFailed.current,
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

  const previewAddressRoute = async () => {
    if (savingRouteRef.current || !destination || originNeedsSelection) return;
    if (!GEOAPIFY_TEST_KEY) {
      Alert.alert('Route planning unavailable', 'This build needs a Geoapify key.');
      return;
    }
    const start = origin?.point ?? currentPoint.current;
    if (!start) {
      Alert.alert('Current location unavailable', 'Wait for a GPS fix or search for a starting point.');
      return;
    }
    savingRouteRef.current = true;
    setSavingRoute(true);
    try {
      const { lines } = await planRoadRoute([start, destination.point]);
      if (!lines.length) {
        Alert.alert('No driving route found', 'Try a different start or destination.');
        return;
      }
      setRoutePreview({ name: destination.label, lines, waypoints: [start, destination.point] });
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

  const saveAddressRoute = async () => {
    if (!routePreview || savingRouteRef.current) return;
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
      const directions = await buildDirections(here, remaining, planned);
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
        } catch {
          Alert.alert('Could not delete route', 'Try again.');
        } finally {
          savingRouteRef.current = false;
          setSavingRoute(false);
        }
      } },
    ]);
  };

  const deleteRide = (ride) => {
    const isSameRide = (item) => item && (ride.startedAt != null
      ? item.startedAt === ride.startedAt : item.startedAt == null && item.date === ride.date);
    Alert.alert('Delete this ride?', 'The ride will be removed from History. Unlocked roads stay on your map.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete ride', style: 'destructive', onPress: async () => {
        try {
          await updateRides((all) => all.filter((item) => !isSameRide(item)));
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

  const closeLibrary = () => {
    if (shareRide) setShareRide(null);
    else if (rideMenu) setRideMenu(null);
    else setLibraryView(null);
  };

  const openRide = (ride) => {
    const lines = splitRecordedPath(ride.line);
    if (!lines.length) {
      Alert.alert('No recorded path', 'This ride has too few connected GPS points to show on the map.');
      return;
    }
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
      <MapLibreGL.MapView
        key={mapAttempt}
        onDidFailLoadingMap={() => setMapFailed(true)}
        onDidFinishLoadingMap={() => setMapFailed(false)}
        style={StyleSheet.absoluteFill}
        mapStyle={MAP_STYLE}
        logoEnabled={false}
        attributionPosition={{ bottom: 8, left: 8 }}
        compassEnabled={false}
        onPress={onMapPress}
        onRegionWillChange={(f) => {
          if (f?.properties?.isUserInteraction) setFollow(false);
        }}
      >
        <MapLibreGL.Camera
          ref={cameraRef}
          followUserLocation={follow}
          followUserMode="normal"
          followZoomLevel={15}
          defaultSettings={{ centerCoordinate: [0, 20], zoomLevel: 2 }}
        />
        <MapLibreGL.UserLocation visible renderMode="native" showsUserHeadingIndicator androidRenderMode="compass" />

        {/* Unlocked roads: white trail that grows as you ride */}
        <MapLibreGL.ShapeSource id="explore-shade" shape={exploreShade}>
          <MapLibreGL.FillLayer id="explore-dim" style={{ fillColor: '#0b0b0d', fillOpacity: explore ? 0.48 : 0 }} />
        </MapLibreGL.ShapeSource>
        <MapLibreGL.ShapeSource id="trail" shape={fc(trail)}>
          <MapLibreGL.LineLayer
            id="trail-glow"
            style={{
              lineColor: ROAD_WHITE,
              lineOpacity: explore ? 0.5 : 0.25,
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

        {/* Saved routes: neon pink */}
        {!explore && <MapLibreGL.ShapeSource id="routes" shape={fc(routes.flatMap((route) => route.lines ?? [route.line]))}>
          <MapLibreGL.LineLayer id="routes-glow" style={pinkLayerStyle.glow} />
          <MapLibreGL.LineLayer id="routes-core" style={pinkLayerStyle.core} />
        </MapLibreGL.ShapeSource>}

        {selectedRide && (
          <MapLibreGL.ShapeSource id="recorded-ride" shape={fc(selectedRide.lines)}>
            <MapLibreGL.LineLayer id="recorded-ride-line" style={{
              lineColor: '#69DBF5', lineWidth: 4, lineCap: 'round', lineJoin: 'round',
            }} />
          </MapLibreGL.ShapeSource>
        )}

        {navigation && (
          <MapLibreGL.ShapeSource id="navigation-route" shape={fc(navigation.lines)}>
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
        <View style={styles.topRow} pointerEvents="box-none">
          <RoundBtn label="History" onPress={() => setLibraryView('rides')} />
          <RoundBtn label="Explore" active={explore} onPress={() => {
            if (findingLoops) return;
            if (explore && routePreview?.loop) setRoutePreview(null);
            setExplore(!explore);
            if (!explore && !navigation && !routePreview) {
              if (exploreLoops.length) showOnMap(exploreLoops.flatMap(({ route }) => route.lines));
              else if (currentPoint.current && GEOAPIFY_TEST_KEY) generateLoops();
            }
          }} />
          <View style={{ flex: 1 }} />
          <RoundBtn label="Saved routes" onPress={() => setLibraryView('routes')} />
        </View>

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

        {navigation && (
          <NavigationPanel navigation={navigation} rerouteStatus={rerouteStatus} onEnd={() => setNavigation(null)} />
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
            <Stat label="Speed" value={formatSpeed(stats.speed)} />
            <Stat label="Average" value={formatSpeed(averageSpeed(stats))} />
            <Stat label="Top" value={formatSpeed(stats.top)} />
          </View>
        )}

        <View style={{ flex: 1 }} pointerEvents="none" />

        {GEOAPIFY_TEST_KEY && !drawing && (
          <Text style={styles.discoveryNotice}>
            Road discovery sends GPS points to Geoapify.
          </Text>
        )}

        {routePreview && !navigation && (
          <View style={styles.startDirections}>
            {routePreview.loop && <Text style={styles.loopEstimate}>{Math.round(routePreview.seconds / 60)} min estimated loop</Text>}
            <Pill label={savingRoute ? 'Loading…' : 'Start directions'} primary disabled={savingRoute}
              onPress={() => startDirections(routePreview)} />
          </View>
        )}
        {!drawing && !routePreview && !navigation && (
          <Pressable accessibilityRole="button" accessibilityLabel="Search for a destination"
            style={styles.mapSearch} onPress={openPlanner}>
            <Text style={styles.mapSearchText}>⌕   Where to?</Text>
          </Pressable>
        )}
        {/* Bottom controls */}
        <View style={styles.bottomRow} pointerEvents="box-none">
          {routePreview && !navigation ? (
            <>
              <Pill label={routePreview.loop ? "All loops" : "Edit"} disabled={savingRoute} onPress={routePreview.loop ? () => { setRoutePreview(null); showOnMap(exploreLoops.flatMap(({ route }) => route.lines)); } : openPlanner} />
              <Pill label="Close" disabled={savingRoute} onPress={() => setRoutePreview(null)} />
              <Pill label="Save route" primary disabled={savingRoute} onPress={saveAddressRoute} />
            </>
          ) : drawing ? (
            <>
              <Pill label="Cancel" disabled={savingRoute} onPress={() => { setDrawing(false); setDraft([]); }} />
              <Pill label="Undo" disabled={savingRoute || !draft.length} onPress={() => setDraft((d) => d.slice(0, -1))} />
              <Pill label={savingRoute ? "Finding roads…" : "Save route"} primary disabled={savingRoute || draft.length < 2} onPress={saveRoute} />
            </>
          ) : (
            <>
              <Pill label={riding ? 'End ride' : 'Start ride'} primary onPress={riding ? endRide : startRide} />
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
        if (!savingRoute) setAddressPlanner(false);
      }}>
        <SafeAreaView style={styles.root}>
          <View style={styles.libraryHeader}>
            <Text style={styles.libraryTitle}>Plan a route</Text>
            <Pill label="Close" disabled={savingRoute} onPress={() => setAddressPlanner(false)} />
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.libraryList}>
            <PlaceSearch key={originReset} near={searchNear} title="From" placeholder="Current location" selected={origin}
              onSelect={(place) => { setOrigin(place); setOriginNeedsSelection(false); }}
              onEdit={(value) => setOriginNeedsSelection(Boolean(value.trim()))} disabled={savingRoute} />
            {(origin || originNeedsSelection) && <Pill label="Use current location" disabled={savingRoute} onPress={() => { setOrigin(null); setOriginNeedsSelection(false); setOriginReset((value) => value + 1); }} />}
            <PlaceSearch autoFocus nearbyFirst near={origin?.point ?? searchNear} title="To" placeholder="Search address or place" selected={destination}
              onSelect={setDestination} disabled={savingRoute} />
            <Pill label={savingRoute ? "Finding roads…" : "Show route"} primary
              disabled={!destination || originNeedsSelection || savingRoute} onPress={previewAddressRoute} />
            <Pill label="Pick points on map" disabled={savingRoute} onPress={() => {
              setAddressPlanner(false);
              setRoutePreview(null);
              setDrawing(true);
              setFollow(false);
            }} />
          </ScrollView>
        </SafeAreaView>
      </Modal>
      <Modal visible={libraryView !== null} animationType="slide" onRequestClose={closeLibrary}>
        <SafeAreaView style={styles.root}>
          <View style={styles.libraryHeader}>
            <Text style={styles.libraryTitle}>{shareRide ? 'Share ride' : rideMenu ? rideTitle(rideMenu) : libraryView === 'routes' ? 'Saved routes' : 'Ride history'}</Text>
            <RoundBtn label={shareRide || rideMenu ? "Back" : "Close"} onPress={closeLibrary} />
          </View>
          {shareRide ? <RideShare ride={shareRide} /> : rideMenu ? (
            <View style={styles.libraryList}>
              <Pill label={rideMenu.pinned ? 'Unpin ride' : 'Pin ride'} onPress={() => pinRide(rideMenu)} />
              <Pill label="Share ride" onPress={() => { setShareRide(rideMenu); setRideMenu(null); }} />
              <Pill label="Delete ride" onPress={() => { deleteRide(rideMenu); setRideMenu(null); }} />
            </View>
          ) : (
          <ScrollView contentContainerStyle={styles.libraryList}>
            {libraryView === 'routes' ? (
              routes.length ? routes.map((route) => (
                <View key={route.id} style={styles.libraryRow}>
                  <Text style={styles.rowTitle}>{route.name}</Text>
                  <Pressable accessibilityRole="button" disabled={savingRoute} style={styles.placeResult}
                    onPress={() => { setSelectedRide(null); setNavigation(null); setExplore(false); showOnMap(route.lines ?? [route.line]); }}>
                    <Text style={styles.rowDetail}>Show on map</Text>
                  </Pressable>
                  <Pressable accessibilityRole="button" disabled={savingRoute} style={styles.placeResult} onPress={() => startDirections(route)}>
                    <Text style={styles.retryText}>{savingRoute ? 'Working…' : 'Start directions'}</Text>
                  </Pressable>
                  <Pressable accessibilityRole="button" disabled={savingRoute} style={styles.placeResult} onPress={() => deleteRoute(route)}>
                    <Text style={styles.rowDetail}>Delete route</Text>
                  </Pressable>
                </View>
              )) : <Text style={styles.rowDetail}>No saved routes yet. Use Where to? on the map to plan one.</Text>
            ) : (
              <RideHistory rides={rides} onOpen={openRide} onMenu={setRideMenu} />
            )}
          </ScrollView>
          )}
        </SafeAreaView>
      </Modal>
    </View>
  );
}

async function searchPlaces(query, near, signal, nearbyFirst) {
  const bias = near ? `&bias=${encodeURIComponent(`proximity:${near.join(',')}`)}` : '';
  const params = `text=${encodeURIComponent(query)}&format=json&limit=8${bias}&apiKey=${encodeURIComponent(GEOAPIFY_TEST_KEY)}`;
  const fetchPlaces = async (filter = '') => {
    const response = await fetch(`https://api.geoapify.com/v1/geocode/autocomplete?${params}${filter}`, { signal });
    if (!response.ok) throw new Error('Place search failed');
    const result = await response.json();
    return (result.results ?? [])
      .filter(({ formatted, lon, lat }) => formatted && Number.isFinite(lon) && Number.isFinite(lat))
      .map(({ formatted, lon, lat }) => ({ label: formatted, point: [lon, lat] }));
  };

  if (near && nearbyFirst) {
    const circle = encodeURIComponent(`circle:${near.join(',')},15000`);
    const localFilter = `&filter=${circle}`;
    const queries = [fetchPlaces(localFilter)];
    if (!/^\d+[a-z]?\s/i.test(query)) {
      const name = encodeURIComponent(query.replace(/’/g, "'"));
      const url = `https://api.geoapify.com/v2/places?categories=catering,commercial&name=${name}&limit=8${bias}${localFilter}&apiKey=${encodeURIComponent(GEOAPIFY_TEST_KEY)}`;
      queries.push((async () => {
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error('Business search failed');
        const data = await response.json();
        return (data.features ?? []).flatMap(({ properties, geometry }) => {
          const point = geometry?.coordinates;
          if (!properties?.name || !Array.isArray(point) ||
              !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return [];
          const address = properties.address_line2 || properties.formatted;
          const label = address && !address.startsWith(properties.name)
            ? `${properties.name}, ${address}` : address || properties.name;
          return [{ label, point }];
        });
      })());
    }
    const responses = await Promise.allSettled(queries);
    if (signal?.aborted) return [];
    const [addresses, businesses = []] = responses.map((result) => result.status === 'fulfilled' ? result.value : []);
    const nearby = [...businesses, ...addresses];
    const unique = new Set();
    const results = nearby.filter(({ point }) => {
      const key = point.map((value) => value.toFixed(4)).join(',');
      if (unique.has(key)) return false;
      unique.add(key);
      return true;
    });
    if (results.length) return results.sort((a, b) => distM(near, a.point) - distM(near, b.point)).slice(0, 8);
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

function NavigationPanel({ navigation, rerouteStatus, onEnd }) {
  const step = navigation.steps[navigation.index];
  const remaining = Math.max(0, navigation.totalMeters - navigation.progress);
  const eta = navigation.seconds > 0 && navigation.totalMeters > 0
    ? new Date(Date.now() + navigation.seconds * remaining / navigation.totalMeters * 1000)
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
            {formatTurnDistance(remaining)} left{eta ? ` · ETA ${eta}` : ''}
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

function rideTitle(ride) {
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

function RideLine({ paths, thumbnail = false, withPhoto = false }) {
  return (
    <Svg width={thumbnail ? 78 : '100%'} height={thumbnail ? 68 : '66%'} viewBox="0 0 320 244">
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

function RideShare({ ride }) {
  const { width } = useWindowDimensions();
  const [photo, setPhoto] = useState(null);
  const [photoReady, setPhotoReady] = useState(true);
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
        setPhoto(result.assets[0].uri);
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
      {photo && <Pill label="Remove photo" disabled={busy} onPress={() => { setPhoto(null); setPhotoReady(true); }} />}
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
  discoveryNotice: { color: "#d2d2d8", backgroundColor: PANEL, alignSelf: "center", padding: 6, borderRadius: 8, marginBottom: 6, fontSize: 11 },
  mapSearch: { marginHorizontal: 16, marginBottom: 10, padding: 15, borderRadius: 16, backgroundColor: PANEL, borderWidth: 1, borderColor: '#555' },
  mapSearchText: { color: '#fff', fontSize: 18, fontWeight: '700' },
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
  libraryList: { padding: 16, gap: 10 },
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
