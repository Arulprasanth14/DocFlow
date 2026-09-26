/**
 * DocFlow Frontend — Idle Session Manager
 * Enforces a 24-hour idle timeout on active sessions.
 * Throttles tracking to max once per minute. Cross-tab syncs via storage event.
 */

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getFirebaseAuth, firebaseSignOutUser } from '@/lib/auth/firebase';

const IDLE_KEY = 'docflow_last_active';
const IDLE_LIMIT_MS = 24 * 60 * 60 * 1000; // 24 hours
const THROTTLE_MS = 60_000; // update at most once/min

// Simple throttle helper
function throttle(func: () => void, limit: number) {
  let inThrottle: boolean;
  return function () {
    if (!inThrottle) {
      func();
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

export function useIdleTimeout(isAuthenticated: boolean) {
  const navigate = useNavigate();

  useEffect(() => {
    if (!isAuthenticated) return;

    // 1. Check on load + every 60s (Done FIRST before overwriting timestamp)
    function check() {
      const last = parseInt(localStorage.getItem(IDLE_KEY) ?? '0', 10);
      if (last && Date.now() - last > IDLE_LIMIT_MS) {
        // Expired!
        localStorage.removeItem(IDLE_KEY);
        firebaseSignOutUser(); // triggers onAuthStateChanged -> clears state
        navigate('/login', { state: { idleExpired: true } });
      }
    }
    check();
    const interval = setInterval(check, 60_000);

    // 2. Update timestamp on user activity (throttled)
    const touch = throttle(() => {
      localStorage.setItem(IDLE_KEY, String(Date.now()));
    }, THROTTLE_MS);
    
    // Initialize touch AFTER checking for old timeout
    touch();

    const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
    events.forEach((e) => window.addEventListener(e, touch, { passive: true }));

    // 3. Cross-tab sync via storage event
    const onStorage = (e: StorageEvent) => {
      if (e.key === IDLE_KEY) {
        if (!e.newValue) {
          // Cleared in another tab = explicit logout
          check();
        } else {
          // Keep our local interval alive, but no immediate action needed
        }
      }
    };
    window.addEventListener('storage', onStorage);

    // 4. Clear on explicit logout (listens to custom event just in case)
    const onLogout = () => localStorage.removeItem(IDLE_KEY);
    window.addEventListener('auth:logout', onLogout);

    return () => {
      events.forEach((e) => window.removeEventListener(e, touch));
      clearInterval(interval);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('auth:logout', onLogout);
    };
  }, [isAuthenticated, navigate]);
}
