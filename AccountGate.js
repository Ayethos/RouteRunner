import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, KeyboardAvoidingView, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

const AUTH_URL = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim().replace(/\/+$/, '');
const AUTH_KEY = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
const configured = Boolean(AUTH_URL?.startsWith('https://') && AUTH_KEY?.startsWith('sb_publishable_'));
const GUEST_KEY = 'welcome-guest:v1';
const SESSION_KEY = 'routerunner.refresh.v1';
const secureOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

async function authRequest(path, payload, token) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${AUTH_URL}/auth/v1/${path}`, {
      method: 'POST',
      headers: { apikey: AUTH_KEY, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = new Error('Account request failed');
      error.status = response.status;
      error.code = (await response.json().catch(() => ({}))).error_code;
      throw error;
    }
    return response.status === 204 ? null : response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function errorMessage(error) {
  if (error.code === 'email_not_confirmed') return 'Confirm your email, then sign in again.';
  if (error.code === 'invalid_credentials') return 'That email or password didn’t match.';
  if (error.code === 'weak_password') return 'Choose a stronger password and try again.';
  if (error.status === 429) return 'Too many attempts. Wait a moment and try again.';
  return 'Account service unavailable. Check your connection or continue as a guest.';
}

export default function AccountGate({ children }) {
  const [ready, setReady] = useState(false);
  const [guest, setGuest] = useState(false);
  const [session, setSession] = useState(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [mode, setMode] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const writing = useRef(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const entered = await AsyncStorage.getItem(GUEST_KEY).catch(() => null);
      if (mounted) setGuest(entered === 'yes');
      if (!configured) return;
      const refresh = await SecureStore.getItemAsync(SESSION_KEY, secureOptions);
      if (!refresh) return;
      try {
        const restored = await authRequest('token?grant_type=refresh_token', { refresh_token: refresh });
        await SecureStore.setItemAsync(SESSION_KEY, restored.refresh_token, secureOptions);
        if (mounted) setSession(restored);
      } catch (error) {
        if (error.status === 400 || error.status === 401 || error.status === 403) {
          await SecureStore.deleteItemAsync(SESSION_KEY, secureOptions).catch(() => {});
        }
        if (mounted) setMessage('Could not restore your sign-in. You can sign in again or continue as a guest.');
      }
    })().catch(() => {}).finally(() => { if (mounted) setReady(true); });
    return () => { mounted = false; };
  }, []);

  const enterAsGuest = async () => {
    if (writing.current) return;
    setGuest(true);
    setAccountOpen(false);
    setPassword('');
    setMode(null);
    await AsyncStorage.setItem(GUEST_KEY, 'yes').catch(() => {});
  };

  const submit = async () => {
    if (writing.current || !configured) return;
    const address = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || password.length < (mode === 'create' ? 8 : 1)) {
      setMessage(mode === 'create' ? 'Enter a valid email and a password of at least 8 characters.' : 'Enter your email and password.');
      return;
    }
    writing.current = true;
    setBusy(true);
    setMessage('');
    try {
      const result = await authRequest(mode === 'create' ? 'signup' : 'token?grant_type=password', { email: address, password });
      setPassword('');
      if (!result?.refresh_token) {
        if (mode !== 'create') throw new Error('No active session');
        setMode('signIn');
        setMessage('If registration succeeded, check your email to confirm your account, then sign in.');
        return;
      }
      await SecureStore.setItemAsync(SESSION_KEY, result.refresh_token, secureOptions);
      setSession(result);
      setAccountOpen(false);
      setMode(null);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      writing.current = false;
      setBusy(false);
    }
  };

  const signOut = async () => {
    if (writing.current) return;
    writing.current = true;
    setBusy(true);
    try {
      await SecureStore.deleteItemAsync(SESSION_KEY, secureOptions);
      if (session?.access_token) await authRequest('logout?scope=local', {}, session.access_token).catch(() => {});
      setSession(null);
      await enterGuestAfterSignOut();
    } catch {
      Alert.alert('Could not sign out', 'Try again.');
    } finally {
      writing.current = false;
      setBusy(false);
    }
  };

  const enterGuestAfterSignOut = async () => {
    setGuest(true);
    setMode(null);
    setAccountOpen(false);
    setMessage('');
    await AsyncStorage.setItem(GUEST_KEY, 'yes').catch(() => {});
  };

  const openAccount = () => { setMode(null); setMessage(''); setAccountOpen(true); };
  const selectMode = (next) => { setMode(next); setMessage(''); setPassword(''); };
  const welcome = (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView style={styles.grow} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
          <Image source={require('./icon.png')} style={styles.icon} />
          <Text accessibilityRole="header" style={styles.title}>{session ? 'Your account' : 'Welcome to RouteRunner'}</Text>
          {session ? (
            <>
              <Text style={styles.detail}>{session.user?.email ?? 'Signed in'}</Text>
              <Text style={styles.detail}>Cloud backup and social features are coming in future updates.</Text>
              <Action label={busy ? 'Signing out…' : 'Sign out'} disabled={busy} onPress={signOut} />
            </>
          ) : (
            <>
              <Text style={styles.detail}>Create a free account to be ready for cloud backups and future social features, including friends, messaging and shared routes with other riders.</Text>
              {!configured && <Text style={styles.detail}>Accounts are unavailable in this build. You can still explore as a guest.</Text>}
              {mode ? (
                <>
                  <TextInput accessibilityLabel="Email" placeholder="Email" value={email} onChangeText={setEmail}
                    editable={!busy} style={styles.input} placeholderTextColor="#a0a0a8" keyboardType="email-address"
                    autoCapitalize="none" autoCorrect={false} autoComplete="email" />
                  <TextInput accessibilityLabel="Password" placeholder="Password" value={password} onChangeText={setPassword}
                    editable={!busy} style={styles.input} placeholderTextColor="#a0a0a8" secureTextEntry
                    autoComplete={mode === 'create' ? 'new-password' : 'current-password'} />
                  <Action primary disabled={busy} label={busy ? 'Please wait…' : mode === 'create' ? 'Create free account' : 'Sign in'} onPress={submit} />
                  <Action label={mode === 'create' ? 'Already have an account? Sign in' : 'Create a free account'}
                    disabled={busy} onPress={() => selectMode(mode === 'create' ? 'signIn' : 'create')} />
                </>
              ) : (
                <>
                  <Action primary disabled={!configured} label="Create free account" onPress={() => selectMode('create')} />
                  <Action disabled={!configured} label="Sign in" onPress={() => selectMode('signIn')} />
                </>
              )}
              {message ? <Text accessibilityLiveRegion="polite" style={styles.message}>{message}</Text> : null}
              <View style={styles.guest}>
                <Text style={styles.detail}>Guests can navigate, explore and record rides. Social features will require an account when they launch. Your discovered roads stay on this phone and can be lost if you lose it or delete the app’s data. Cloud backup is not available yet.</Text>
                <Action disabled={busy} label="Continue as guest" onPress={enterAsGuest} />
              </View>
            </>
          )}
          {accountOpen && <Action disabled={busy} label="Back to map" onPress={() => { setPassword(''); setAccountOpen(false); }} />}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
  if (!ready) return <SafeAreaView style={styles.loading}><ActivityIndicator color="#FF2D95" accessibilityLabel="Loading RouteRunner" /></SafeAreaView>;
  if (!guest && !session) return welcome;
  return (
    <>
      {children(openAccount)}
      {accountOpen && <View style={styles.accountOverlay} accessibilityViewIsModal>{welcome}</View>}
    </>
  );
}

function Action({ label, onPress, primary, disabled }) {
  return (
    <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress}
      style={[styles.action, primary && styles.primary, disabled && styles.disabled]}>
      <Text style={[styles.actionText, primary && styles.primaryText]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  accountOverlay: { ...StyleSheet.absoluteFillObject, zIndex: 30 },
  screen: { flex: 1, backgroundColor: '#111114' },
  loading: { flex: 1, justifyContent: 'center', backgroundColor: '#111114' },
  grow: { flex: 1 },
  content: { flexGrow: 1, justifyContent: 'center', padding: 24, gap: 14 },
  icon: { width: 76, height: 76, borderRadius: 18, marginBottom: 6 },
  title: { color: '#fff', fontSize: 35, fontWeight: '800' },
  detail: { color: '#d4d4dc', fontSize: 16, lineHeight: 23 },
  action: { minHeight: 52, borderWidth: 1, borderColor: '#4d4d57', borderRadius: 14, justifyContent: 'center', alignItems: 'center', padding: 10 },
  primary: { backgroundColor: '#FF2D95', borderColor: '#FF2D95' },
  disabled: { opacity: 0.5 },
  actionText: { color: '#fff', fontWeight: '800', fontSize: 16, textAlign: 'center' },
  primaryText: { color: '#111114' },
  guest: { gap: 12, borderTopWidth: 1, borderColor: '#44444c', paddingTop: 16, marginTop: 4 },
  message: { color: '#ff9bc8', fontSize: 15, lineHeight: 21 },
  input: { minHeight: 50, borderRadius: 12, borderWidth: 1, borderColor: '#4d4d57', padding: 12, color: '#fff', fontSize: 16 },
});
