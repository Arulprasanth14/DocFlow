/**
 * DocFlow Frontend — Firebase Client SDK
 * Mandatory: Google Sign-In, Microsoft Sign-In, Email/Password via Firebase.
 *
 * Flow:
 *   1. User signs in via Firebase (email/password, Google, Microsoft).
 *   2. onAuthStateChanged in AuthProvider fires → sets Firebase user as source of truth.
 *   3. AuthProvider calls POST /users/me/sync to create/update backend profile.
 *   4. All API requests use Firebase ID tokens (auto-refreshed by Firebase SDK).
 */

import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  browserLocalPersistence,
  setPersistence,
  GoogleAuthProvider,
  OAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut as firebaseSignOut,
  onAuthStateChanged,
  fetchSignInMethodsForEmail,
  type User as FirebaseUser,
  type Auth,
} from 'firebase/auth';

// ── Config ─────────────────────────────────────────────────────────────────────

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

// Validate required config
const requiredKeys: (keyof typeof firebaseConfig)[] = [
  'apiKey',
  'authDomain',
  'projectId',
  'appId',
];

for (const key of requiredKeys) {
  if (!firebaseConfig[key] || firebaseConfig[key].startsWith('your-')) {
    console.error(
      `[Firebase] Missing env var VITE_FIREBASE_${key.replace(/([A-Z])/g, '_$1').toUpperCase()}. ` +
      'Add your Firebase project credentials to Frontend/.env'
    );
  }
}

// ── Initialize ─────────────────────────────────────────────────────────────────

let _app: FirebaseApp;
let _auth: Auth;
let _persistenceSet = false;

function getFirebaseApp(): FirebaseApp {
  if (!_app) {
    _app = initializeApp(firebaseConfig);
  }
  return _app;
}

/**
 * Returns the Firebase Auth instance.
 * Exported so AuthProvider, apiClient, and useIdleTimeout can import it.
 */
export function getFirebaseAuth(): Auth {
  if (!_auth) {
    _auth = getAuth(getFirebaseApp());
  }
  return _auth;
}

/**
 * Set browserLocalPersistence so Firebase sessions survive page reloads.
 * Called once by AuthProvider at startup.
 * Returns a promise so AuthProvider can await it before subscribing to
 * onAuthStateChanged.
 */
export async function initFirebasePersistence(): Promise<void> {
  if (_persistenceSet) return;
  _persistenceSet = true;
  const auth = getFirebaseAuth();
  await setPersistence(auth, browserLocalPersistence);
}

// ── Google Sign-In ─────────────────────────────────────────────────────────────

/**
 * Open Google OAuth popup.
 * After this resolves, onAuthStateChanged fires in AuthProvider automatically.
 * Returns the Firebase User (for immediate ID token if needed).
 */
export async function signInWithGoogle(): Promise<FirebaseUser> {
  const auth = getFirebaseAuth();
  const provider = new GoogleAuthProvider();
  provider.addScope('email');
  provider.addScope('profile');
  provider.setCustomParameters({ prompt: 'select_account' });
  const result = await signInWithPopup(auth, provider);
  return result.user;
}

// ── Microsoft Sign-In ──────────────────────────────────────────────────────────

/**
 * Open Microsoft OAuth popup.
 * Requires Microsoft provider enabled in Firebase Console → Authentication.
 */
export async function signInWithMicrosoft(): Promise<FirebaseUser> {
  const auth = getFirebaseAuth();
  const provider = new OAuthProvider('microsoft.com');
  provider.addScope('email');
  provider.addScope('profile');
  provider.setCustomParameters({
    prompt: 'select_account',
    tenant: 'common',
  });
  const result = await signInWithPopup(auth, provider);
  return result.user;
}

// ── Firebase Email/Password ────────────────────────────────────────────────────

/**
 * Sign in with email + password through Firebase client SDK.
 * Throws Firebase auth errors (auth/user-not-found, auth/wrong-password, etc.)
 * which the caller maps to user-friendly messages.
 */
export async function signInWithFirebaseEmail(
  email: string,
  password: string
): Promise<FirebaseUser> {
  const auth = getFirebaseAuth();
  const result = await signInWithEmailAndPassword(auth, email, password);
  return result.user;
}

/**
 * Checks if an email is registered.
 */
export async function checkEmailExists(email: string): Promise<boolean> {
  const auth = getFirebaseAuth();
  const methods = await fetchSignInMethodsForEmail(auth, email);
  return methods.length > 0;
}

/**
 * Register a new user in Firebase with email + password.
 * Returns the Firebase User — caller then calls POST /users/me/sync.
 */
export async function registerWithFirebaseEmail(
  email: string,
  password: string
): Promise<FirebaseUser> {
  const auth = getFirebaseAuth();
  const result = await createUserWithEmailAndPassword(auth, email, password);
  return result.user;
}

// ── Password Reset ────────────────────────────────────────────────────────────

export async function sendFirebasePasswordReset(email: string): Promise<void> {
  const auth = getFirebaseAuth();
  await sendPasswordResetEmail(auth, email);
}

// ── Sign Out ──────────────────────────────────────────────────────────────────

/**
 * Sign out from Firebase client-side.
 * This triggers onAuthStateChanged(null) in AuthProvider, which clears all
 * auth state and redirects to /login.
 */
export async function firebaseSignOutUser(): Promise<void> {
  const auth = getFirebaseAuth();
  await firebaseSignOut(auth);
}

// ── Auth State Observer ───────────────────────────────────────────────────────

export function onFirebaseAuthStateChanged(
  callback: (user: FirebaseUser | null) => void
): () => void {
  const auth = getFirebaseAuth();
  return onAuthStateChanged(auth, callback);
}

// ── Error Message Map ─────────────────────────────────────────────────────────

export function getFirebaseErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    'auth/invalid-email': 'Invalid email address',
    'auth/user-disabled': 'This account has been disabled',
    'auth/user-not-found': 'NO_ACCOUNT',        // sentinel — caller shows special UI
    'auth/invalid-credential': 'Incorrect email or password. Please try again.',
    'auth/wrong-password': 'Incorrect password. Please try again.',
    'auth/email-already-in-use': 'An account with this email already exists',
    'auth/weak-password': 'Password must be at least 6 characters',
    'auth/popup-closed-by-user': 'Sign-in popup was closed',
    'auth/cancelled-popup-request': 'Sign-in cancelled',
    'auth/popup-blocked': 'Pop-up was blocked by the browser. Please allow pop-ups for this site.',
    'auth/network-request-failed': 'Network error. Please check your connection.',
    'auth/too-many-requests': 'Too many attempts. Please try again later.',
    'auth/account-exists-with-different-credential':
      'An account already exists with a different sign-in method for this email.',
  };
  return messages[code] ?? '';
}
