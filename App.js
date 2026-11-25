import React, { useEffect, useRef, useState, useCallback } from 'react';
import { View, Text, Pressable, StyleSheet, Alert, SafeAreaView, Modal, ScrollView, Platform, TextInput, NativeModules } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
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
      return geometry.coordinates.filter((line) =>
        line.length > 1 && line.every(([lon, lat]) =>
          Number.isFinite(lon) && Math.abs(lon) <= 180 &&
          Number.isFinite(lat) && Math.abs(lat) <= 90)
      );
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function planRoadRoute(points) {
  // The Routing API takes latitude first. The response uses GeoJSON order.
  const waypoints = points.map(([lon, lat]) => `${lat},${lon}`).join('|');
  const query = `waypoints=${encodeURIComponent(waypoints)}&mode=drive&format=geojson&apiKey=${encodeURIComponent(GEOAPIFY_TEST_KEY)}`;
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
    const steps = (feature.properties?.legs ?? []).flatMap((leg, index) =>
      (leg.steps ?? []).flatMap((step) => {
        const point = geometry.coordinates[index]?.[step.from_index];
        return point && step.instruction?.text ? [{ point, text: step.instruction.text }] : [];
      })
    );
    return { lines: geometry.coordinates.filter((line) => line.length > 1), steps };
  } finally {
    clearTimeout(timeout);
  }
}

// ---- App -----------------------------------------------------------------
export default function App() {
  const cameraRef = useRef(null);
  const trailRef = useRef([]); // array of line segments
  const lastPtRef = useRef(null);
  const pendingSamples = useRef([]);
  const matchQueue = useRef(Promise.resolve());
  const [matchingFailed, setMatchingFailed] = useState(false);
  const [trailLoaded, setTrailLoaded] = useState(false);

  const [trail, setTrail] = useState([]);
  const [routes, setRoutes] = useState([]);
  const [rides, setRides] = useState([]);
  const [libraryView, setLibraryView] = useState(null);
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
  const [navPoint, setNavPoint] = useState(null);

  useEffect(() => {
    if (!navigation || navigation.arrived) return;
    let previousPoint;
    const timer = setInterval(() => {
      const point = currentPoint.current;
      if (!point || point === previousPoint) return;
      previousPoint = point;
      setNavPoint(point);
      setNavigation((state) => {
        if (!state || state.arrived) return state;
        const step = state.steps[state.index];
        if (distM(point, step.point) > 35) return state;
        return state.index + 1 < state.steps.length
          ? { ...state, index: state.index + 1 }
          : { ...state, arrived: true };
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [navigation?.arrived, navigation?.lines]);
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
          trailRef.current = JSON.parse(t);
          setTrail([...trailRef.current]);
        }
        const r = await AsyncStorage.getItem(ROUTES_KEY);
        if (r) setRoutes(JSON.parse(r));
      } catch (e) {}
      setTrailLoaded(true);
    })();
  }, []);

  const flushSamples = useCallback((keepLast = false) => {
    const samples = pendingSamples.current;
    pendingSamples.current = keepLast ? samples.slice(-1) : [];
    if (!GEOAPIFY_TEST_KEY || samples.length < 2) return;

    matchQueue.current = matchQueue.current.then(async () => {
      try {
        const matched = await matchRoads(samples);
        if (!matched.length) return;
        const next = [...trailRef.current, ...matched];
        await AsyncStorage.setItem(TRAIL_KEY, JSON.stringify(next));
        trailRef.current = next;
        setTrail(next);
        setMatchingFailed(false);
      } catch {
        setMatchingFailed(true);
      }
    });
  }, []);

  const onLocation = useCallback(
    (loc) => {
      if (!ridingRef.current || loc.timestamp < rideStartedAt.current ||
          loc.timestamp <= lastRecordedTime.current) return;
      const { longitude, latitude, accuracy } = loc.coords;
      if (!(accuracy > 0 && accuracy <= 30)) return;
      const gap = loc.timestamp - lastRecordedTime.current;
      lastRecordedTime.current = loc.timestamp;
      if (gap > 30_000) {
        lastPtRef.current = null;
        flushSamples();
      }
      const pt = [longitude, latitude];
      const prev = lastPtRef.current;
      if (GEOAPIFY_TEST_KEY) {
        const seconds = Math.floor(loc.timestamp / 1000);
        if (pendingSamples.current.length && seconds - pendingSamples.current[0].seconds >= 30) {
          flushSamples(true);
        }
        const previousSample = pendingSamples.current.at(-1);
        if (!previousSample ||
            (seconds - previousSample.seconds >= 2 && distM(previousSample.point, pt) >= 10)) {
          pendingSamples.current.push({ point: pt, seconds });
        }
      }

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
    if (!riding || !GEOAPIFY_TEST_KEY) return;
    const timer = setInterval(() => {
      if (ridingRef.current) flushSamples(true);
    }, MATCH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [riding, flushSamples]);

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
    backgroundRideRef.current = backgroundEnabled;
    setScreenLockRecording(backgroundEnabled);
    setSelectedRide(null);
    lastRecordedTime.current = 0;
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
    const summary = {
      ...statsRef.current,
      startedAt: rideStartedAt.current,
      date,
      seconds: Math.floor((date - rideStartedAt.current) / 1000),
      line: rideLineRef.current,
    };
    try {
      const raw = await AsyncStorage.getItem(RIDES_KEY);
      const all = raw ? JSON.parse(raw) : [];
      const next = [summary, ...all.filter((ride) => ride.startedAt !== summary.startedAt)];
      await AsyncStorage.setItem(RIDES_KEY, JSON.stringify(next));
      setRides(next);
      await AsyncStorage.multiRemove([ACTIVE_RIDE_KEY, `${ACTIVE_RIDE_KEY}:${rideStartedAt.current}`]).catch(() => {});
      Alert.alert(
        'Ride saved',
        `Time ${fmtTime(summary.seconds)}\nDistance ${formatDistance(summary.meters)}\nAverage speed ${formatSpeed(averageSpeed(summary))}\nTop speed ${formatSpeed(summary.top)}`
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
      const { lines, steps } = await planRoadRoute([here, ...remaining]);
      if (!lines.length || !steps.length) {
        Alert.alert('Directions unavailable', 'No turn instructions were returned for this route.');
        return;
      }
      const end = lines.at(-1).at(-1);
      if (distM(steps.at(-1).point, end) > 10) steps.push({ point: end, text: 'Continue to your destination' });
      setSelectedRide(null);
      setRoutePreview(null);
      setLibraryView(null);
      setNavPoint(here);
      setNavigation({ lines, steps, index: steps.length > 1 && distM(here, steps[0].point) <= 35 ? 1 : 0 });
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
        <MapLibreGL.UserLocation visible androidRenderMode="normal" />

        {/* Unlocked roads: white trail that grows as you ride */}
        <MapLibreGL.ShapeSource id="trail" shape={fc(trail)}>
          <MapLibreGL.LineLayer
            id="trail-glow"
            style={{
              lineColor: ROAD_WHITE,
              lineOpacity: 0.25,
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

        {/* Saved routes: neon pink */}
        <MapLibreGL.ShapeSource id="routes" shape={fc(routes.flatMap((route) => route.lines ?? [route.line]))}>
          <MapLibreGL.LineLayer id="routes-glow" style={pinkLayerStyle.glow} />
          <MapLibreGL.LineLayer id="routes-core" style={pinkLayerStyle.core} />
        </MapLibreGL.ShapeSource>

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
            <MapLibreGL.LineLayer id="address-preview-core" style={pinkLayerStyle.core} />
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
          <View style={{ flex: 1 }} />
          <RoundBtn label="Saved routes" onPress={() => setLibraryView('routes')} />
        </View>

        {selectedRide && (
          <View style={styles.banner}>
            <Text style={[styles.bannerText, { color: '#69DBF5' }]}>
              {new Date(selectedRide.date).toLocaleDateString()} · Recorded GPS path
            </Text>
            <Pressable accessibilityRole="button" style={styles.retryButton} onPress={() => setSelectedRide(null)}>
              <Text style={styles.retryText}>Hide ride</Text>
            </Pressable>
          </View>
        )}

        {navigation && (
          <View style={styles.banner}>
            <Text style={styles.rowTitle}>{navigation.arrived ? 'Destination reached' : navigation.steps[navigation.index].text}</Text>
            {!navigation.arrived && navPoint && (
              <Text style={styles.rowDetail}>{formatDistance(distM(navPoint, navigation.steps[navigation.index].point))} to maneuver</Text>
            )}
            <Pressable accessibilityRole="button" style={styles.retryButton} onPress={() => setNavigation(null)}>
              <Text style={styles.retryText}>End directions</Text>
            </Pressable>
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
          <Text style={styles.hint}>
            Road unlocking sends ride GPS points to Geoapify.
          </Text>
        )}

        {routePreview && !navigation && (
          <View style={styles.startDirections}>
            <Pill label={savingRoute ? 'Loading…' : 'Start directions'} primary disabled={savingRoute}
              onPress={() => startDirections(routePreview)} />
          </View>
        )}
        {/* Bottom controls */}
        <View style={styles.bottomRow} pointerEvents="box-none">
          {routePreview && !navigation ? (
            <>
              <Pill label="Edit" disabled={savingRoute} onPress={openPlanner} />
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
              <RoundBtn label="Route" onPress={openPlanner} />
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
            <PlaceSearch near={origin?.point ?? searchNear} title="To" placeholder="Search address or place" selected={destination}
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
      <Modal visible={libraryView !== null} animationType="slide" onRequestClose={() => setLibraryView(null)}>
        <SafeAreaView style={styles.root}>
          <View style={styles.libraryHeader}>
            <Text style={styles.libraryTitle}>{libraryView === 'routes' ? 'Saved routes' : 'Ride history'}</Text>
            <RoundBtn label="Close" onPress={() => setLibraryView(null)} />
          </View>
          <ScrollView contentContainerStyle={styles.libraryList}>
            {libraryView === 'routes' ? (
              routes.length ? routes.map((route) => (
                <View key={route.id} style={styles.libraryRow}>
                  <Text style={styles.rowTitle}>{route.name}</Text>
                  <Pressable accessibilityRole="button" disabled={savingRoute} style={styles.placeResult}
                    onPress={() => { setSelectedRide(null); setNavigation(null); showOnMap(route.lines ?? [route.line]); }}>
                    <Text style={styles.rowDetail}>Show on map</Text>
                  </Pressable>
                  <Pressable accessibilityRole="button" disabled={savingRoute} style={styles.placeResult} onPress={() => startDirections(route)}>
                    <Text style={styles.retryText}>{savingRoute ? 'Working…' : 'Start directions'}</Text>
                  </Pressable>
                  <Pressable accessibilityRole="button" disabled={savingRoute} style={styles.placeResult} onPress={() => deleteRoute(route)}>
                    <Text style={styles.rowDetail}>Delete route</Text>
                  </Pressable>
                </View>
              )) : <Text style={styles.rowDetail}>No saved routes yet. Use Route on the map to plan one.</Text>
            ) : (
              rides.length ? [...rides].sort((a, b) => b.date - a.date).map((ride, index) => (
                <Pressable accessibilityRole="button" key={`${ride.date}-${index}`} style={styles.libraryRow} onPress={() => openRide(ride)}>
                  <Text style={styles.rowTitle}>{new Date(ride.date).toLocaleString()}</Text>
                  <Text style={styles.rowDetail}>
                    {`${formatDistance(ride.meters)} · ${fmtTime(ride.seconds)}\nAvg ${formatSpeed(averageSpeed(ride))} · Top ${formatSpeed(ride.top)}`}
                  </Text>
                  <Text style={styles.rowDetail}>View recorded path</Text>
                </Pressable>
              )) : <Text style={styles.rowDetail}>No rides yet. Start a ride from the map.</Text>
            )}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </View>
  );
}

async function searchPlaces(query, near, signal) {
  const bias = near ? `&bias=${encodeURIComponent(`proximity:${near.join(',')}`)}` : '';
  const params = `text=${encodeURIComponent(query)}&format=json&limit=5${bias}&apiKey=${encodeURIComponent(GEOAPIFY_TEST_KEY)}`;
  const response = await fetch(`https://api.geoapify.com/v1/geocode/autocomplete?${params}`, { signal });
  if (!response.ok) throw new Error('Place search failed');
  const result = await response.json();
  return (result.results ?? [])
    .filter(({ formatted, lon, lat }) => formatted && Number.isFinite(lon) && Number.isFinite(lat))
    .map(({ formatted, lon, lat }) => ({ label: formatted, point: [lon, lat] }));
}

function PlaceSearch({ near, title, placeholder, selected, onSelect, onEdit, disabled }) {
  const [query, setQuery] = useState(selected?.label ?? '');
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
        const places = await searchPlaces(query.trim(), near, controller.signal);
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
  }, [query, selected, disabled, near]);

  return (
    <View style={styles.libraryRow}>
      <Text style={styles.rowTitle}>{title}</Text>
      <TextInput accessibilityLabel={title} style={styles.placeInput} value={query}
        placeholder={placeholder} placeholderTextColor="#aaa" editable={!disabled}
        autoCorrect={false} onChangeText={(value) => {
          if (selected) onSelect(null);
          onEdit?.(value);
          setQuery(value);
          setResults([]);
          setStatus('');
        }} />
      {status ? <Text style={styles.rowDetail}>{status}</Text> : null}
      {results.map((place, index) => (
        <Pressable accessibilityRole="button" key={`${place.label}-${index}`}
          style={styles.placeResult} onPress={() => onSelect(place)}>
          <Text style={styles.rowDetail}>{place.label}</Text>
        </Pressable>
      ))}
    </View>
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
  startDirections: { alignSelf: 'center', marginBottom: 8 },
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
  libraryList: { padding: 16, gap: 10 },
  libraryRow: { padding: 16, borderRadius: 14, backgroundColor: PANEL, gap: 5 },
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
