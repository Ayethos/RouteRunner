import React, { useEffect, useRef, useState, useCallback } from 'react';
import { View, Text, Pressable, StyleSheet, Alert, SafeAreaView } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import MapLibreGL from '@maplibre/maplibre-react-native';

// ---- Design tokens -------------------------------------------------------
const PINK = '#FF2D95';
const ROAD_WHITE = '#FFFFFF';
const PANEL = 'rgba(20,20,22,0.92)';

// Grayscale base map. Swap for a vector style (MapTiler/Mapbox) before launch.
const MAP_STYLE = {
  version: 8,
  sources: {
    base: {
      type: 'raster',
      tiles: ['https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors © CARTO',
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#161616' } },
    { id: 'base', type: 'raster', source: 'base', paint: { 'raster-saturation': -1 } },
  ],
};

const TRAIL_KEY = 'trail:matched:v1';
const MATCH_INTERVAL_MS = 30_000;
const MATCH_URL = process.env.EXPO_PUBLIC_OSRM_URL?.replace(/\/+$/, '');
const ROUTES_KEY = 'routes:v1';
const RIDES_KEY = 'rides:v1';

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
const fmtTime = (s) => {
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
};
const kmh = (ms) => Math.max(0, Math.round((ms || 0) * 3.6));

async function matchRoads(samples) {
  const coordinates = samples.map(({ point }) => point.join(',')).join(';');
  const timestamps = samples.map(({ seconds }) => seconds).join(';');
  const radiuses = samples.map(({ accuracy }) => accuracy).join(';');
  const query = `geometries=geojson&overview=full&timestamps=${timestamps}&radiuses=${radiuses}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${MATCH_URL}/match/v1/driving/${coordinates}?${query}`, {
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('Road matching request failed');
    const result = await response.json();
    if (result.code !== 'Ok') return [];
    return (result.matchings ?? [])
      .filter(({ confidence, geometry }) =>
        confidence >= 0.7 && geometry?.type === 'LineString' && geometry.coordinates.length > 1)
      .map(({ geometry }) => geometry.coordinates);
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
  const [follow, setFollow] = useState(true);
  const [permission, setPermission] = useState(null);

  // ride state
  const [riding, setRiding] = useState(false);
  const ridingRef = useRef(false);
  const [stats, setStats] = useState({ seconds: 0, meters: 0, speed: 0, top: 0 });
  const statsRef = useRef({ seconds: 0, meters: 0, speed: 0, top: 0 });
  const rideLineRef = useRef([]);

  // route drawing
  const [drawing, setDrawing] = useState(false);
  const [draft, setDraft] = useState([]);

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
    if (!MATCH_URL || samples.length < 2) return;

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
      const { longitude, latitude, accuracy } = loc.coords;
      const pt = [longitude, latitude];
      const prev = lastPtRef.current;
      if (ridingRef.current && MATCH_URL && accuracy > 0 && accuracy <= 30) {
        const seconds = Math.floor(loc.timestamp / 1000);
        const previousSample = pendingSamples.current.at(-1);
        if (!previousSample ||
            (seconds - previousSample.seconds >= 2 && distM(previousSample.point, pt) >= 10)) {
          pendingSamples.current.push({ point: pt, seconds, accuracy: Math.max(5, Math.round(accuracy)) });
        }
      }

      if (!prev || distM(prev, pt) >= 10) {
        if (ridingRef.current) {
          if (prev) statsRef.current.meters += distM(prev, pt);
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
    []
  );

  // location watcher
  useEffect(() => {
    if (!trailLoaded) return;
    let sub;
    let active = true;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (!active) return;
      setPermission(status);
      if (status !== 'granted') return;
      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 5, timeInterval: 1000 },
        onLocation
      );
      if (!active) sub.remove();
    })();
    return () => {
      active = false;
      sub?.remove();
    };
  }, [onLocation, trailLoaded]);

  // ride timer
  useEffect(() => {
    if (!riding) return;
    const id = setInterval(() => {
      statsRef.current.seconds += 1;
      setStats({ ...statsRef.current });
    }, 1000);
    return () => clearInterval(id);
  }, [riding]);

  useEffect(() => {
    if (!riding || !MATCH_URL) return;
    const timer = setInterval(() => {
      if (ridingRef.current) flushSamples(true);
    }, MATCH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [riding, flushSamples]);

  const startRide = () => {
    statsRef.current = { seconds: 0, meters: 0, speed: 0, top: 0 };
    rideLineRef.current = [];
    setStats({ ...statsRef.current });
    ridingRef.current = true;
    setRiding(true);
    setFollow(true);
  };

  const endRide = async () => {
    ridingRef.current = false;
    setRiding(false);
    flushSamples();
    const s = statsRef.current;
    const summary = { date: Date.now(), ...s, line: rideLineRef.current };
    try {
      const raw = await AsyncStorage.getItem(RIDES_KEY);
      const all = raw ? JSON.parse(raw) : [];
      all.push(summary);
      await AsyncStorage.setItem(RIDES_KEY, JSON.stringify(all));
    } catch (e) {}
    Alert.alert(
      'Ride complete',
      `Time ${fmtTime(s.seconds)}\nDistance ${(s.meters / 1000).toFixed(2)} km\nTop speed ${kmh(s.top)} km/h`
    );
  };

  const onMapPress = (e) => {
    if (!drawing) return;
    setDraft((d) => [...d, e.geometry.coordinates]);
  };

  const saveRoute = async () => {
    if (draft.length < 2) return;
    const next = [...routes, { id: String(Date.now()), name: `Route ${routes.length + 1}`, line: draft }];
    setRoutes(next);
    setDraft([]);
    setDrawing(false);
    AsyncStorage.setItem(ROUTES_KEY, JSON.stringify(next)).catch(() => {});
  };

  const soon = (name) => Alert.alert(name, 'Coming in a later phase.');

  const pinkLayerStyle = {
    glow: { lineColor: PINK, lineWidth: 10, lineBlur: 8, lineOpacity: 0.7, lineCap: 'round', lineJoin: 'round' },
    core: { lineColor: '#FF6FB8', lineWidth: 3.5, lineCap: 'round', lineJoin: 'round' },
  };

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <MapLibreGL.MapView
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
          defaultSettings={{ zoomLevel: 14 }}
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
        <MapLibreGL.ShapeSource id="routes" shape={fc(routes.map((r) => r.line))}>
          <MapLibreGL.LineLayer id="routes-glow" style={pinkLayerStyle.glow} />
          <MapLibreGL.LineLayer id="routes-core" style={pinkLayerStyle.core} />
        </MapLibreGL.ShapeSource>

        {/* Route being drawn */}
        <MapLibreGL.ShapeSource id="draft" shape={fc([draft])}>
          <MapLibreGL.LineLayer id="draft-glow" style={pinkLayerStyle.glow} />
          <MapLibreGL.LineLayer id="draft-core" style={pinkLayerStyle.core} />
        </MapLibreGL.ShapeSource>
      </MapLibreGL.MapView>

      {/* Top row */}
      <SafeAreaView pointerEvents="box-none" style={StyleSheet.absoluteFill}>
        <View style={styles.topRow} pointerEvents="box-none">
          <RoundBtn label="Profile" onPress={() => soon('Profile')} />
          <View style={{ flex: 1 }} />
          <RoundBtn label="Friends" onPress={() => soon('Friends')} />
        </View>

        {permission === 'denied' && (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>Location is off. Turn it on in Settings to see yourself and unlock roads.</Text>
          </View>
        )}

        {permission === 'granted' && (!MATCH_URL || matchingFailed) && (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>
              {MATCH_URL ? 'Road matching is temporarily unavailable.' : 'Road matching is unavailable in this build.'}
            </Text>
          </View>
        )}

        {riding && (
          <View style={styles.statsBar}>
            <Stat label="Time" value={fmtTime(stats.seconds)} />
            <Stat label="Distance" value={`${(stats.meters / 1000).toFixed(2)} km`} />
            <Stat label="Speed" value={`${kmh(stats.speed)}`} />
            <Stat label="Top" value={`${kmh(stats.top)}`} />
          </View>
        )}

        <View style={{ flex: 1 }} pointerEvents="none" />

        {/* Bottom controls */}
        <View style={styles.bottomRow} pointerEvents="box-none">
          {drawing ? (
            <>
              <Pill label="Cancel" onPress={() => { setDrawing(false); setDraft([]); }} />
              <Pill label="Undo" onPress={() => setDraft((d) => d.slice(0, -1))} />
              <Pill label="Save route" primary onPress={saveRoute} />
            </>
          ) : (
            <>
              <RoundBtn label="Route" onPress={() => { setDrawing(true); setFollow(false); }} />
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
          <Text style={styles.hint}>Tap the map to add points to your route</Text>
        )}
      </SafeAreaView>
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
function Pill({ label, onPress, primary }) {
  return (
    <Pressable onPress={onPress} style={[styles.pill, primary && styles.pillPrimary]}>
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
  statValue: { color: '#fff', fontSize: 20, fontWeight: '700' },
  statLabel: { color: '#9a9aa0', fontSize: 12, marginTop: 2 },
  banner: { margin: 16, padding: 12, borderRadius: 12, backgroundColor: PANEL },
  bannerText: { color: '#fff', fontSize: 14 },
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
