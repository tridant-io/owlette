'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { useTheme } from 'next-themes';

/**
 * Cloudflare Turnstile widget.
 *
 * Rendered explicitly, not via the `cf-turnstile` auto-scan class, so each
 * instance owns a widget id it can reset. Tokens are single-use — a rejected
 * submit leaves the page mounted, so a stale token must be cleared or the
 * retry fails `timeout-or-duplicate`.
 *
 * Inert without `NEXT_PUBLIC_TURNSTILE_SITE_KEY`: renders nothing, reports an
 * empty token, which the server treats as unconfigured outside production —
 * `next dev` works with no Turnstile credentials.
 *
 * CSP: `strict-dynamic` permits the programmatic loader, but the iframe needs
 * `frame-src https://challenges.cloudflare.com` — see proxy.ts.
 */

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/**
 * Whether a sitekey is baked into this build (a `NEXT_PUBLIC_*` compile-time
 * constant). Forms gate "token required" on it — otherwise a sitekey-less
 * build renders no widget, mints no token, and disables submit forever.
 */
export const TURNSTILE_ENABLED = Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY);

interface TurnstileApi {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      action?: string;
      theme?: 'light' | 'dark' | 'auto';
      size?: 'normal' | 'flexible' | 'compact';
      callback?: (token: string) => void;
      'expired-callback'?: () => void;
      'error-callback'?: () => void;
    }
  ) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let scriptPromise: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => {
      // Allow a later mount to retry rather than caching the failure forever.
      scriptPromise = null;
      reject(new Error('failed to load turnstile'));
    };
    document.head.appendChild(script);
  });

  return scriptPromise;
}

export interface TurnstileHandle {
  /** Clear the consumed token and request a fresh one. */
  reset: () => void;
}

interface TurnstileWidgetProps {
  /** Stable per-surface action, asserted server-side against siteverify. */
  action: 'register' | 'forgot-password';
  /** Receives the token, or '' when cleared/expired/errored. */
  onToken: (token: string) => void;
  className?: string;
}

export const TurnstileWidget = forwardRef<TurnstileHandle, TurnstileWidgetProps>(
  function TurnstileWidget({ action, onToken, className }, ref) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const widgetIdRef = useRef<string | null>(null);
    // Latest callback without re-rendering the widget. Synced in an effect —
    // mutating a ref during render is unsafe under concurrent React.
    const onTokenRef = useRef(onToken);
    useEffect(() => {
      onTokenRef.current = onToken;
    }, [onToken]);

    const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
    // never 'auto': that follows the os, and the app's choice can disagree with it.
    // a change re-renders the widget, since turnstile can't re-theme a live one
    const { resolvedTheme } = useTheme();
    const theme = resolvedTheme === 'light' ? 'light' : 'dark';

    useImperativeHandle(
      ref,
      () => ({
        reset: () => {
          if (widgetIdRef.current && window.turnstile) {
            window.turnstile.reset(widgetIdRef.current);
            onTokenRef.current('');
          }
        },
      }),
      []
    );

    const emit = useCallback((token: string) => onTokenRef.current(token), []);

    useEffect(() => {
      if (!siteKey) return;

      let cancelled = false;

      loadTurnstileScript()
        .then(() => {
          if (cancelled || !containerRef.current || !window.turnstile) return;
          // Guard against React 19 StrictMode double-invoking the effect.
          if (widgetIdRef.current) return;

          widgetIdRef.current = window.turnstile.render(containerRef.current, {
            sitekey: siteKey,
            action,
            theme,
            // Span the container so the widget lines up with the form inputs.
            size: 'flexible',
            callback: emit,
            'expired-callback': () => emit(''),
            'error-callback': () => emit(''),
          });
        })
        .catch(() => {
          if (!cancelled) emit('');
        });

      return () => {
        cancelled = true;
        if (widgetIdRef.current && window.turnstile) {
          window.turnstile.remove(widgetIdRef.current);
          widgetIdRef.current = null;
        }
      };
    }, [siteKey, action, theme, emit]);

    if (!siteKey) return null;

    return <div ref={containerRef} className={className} data-testid="turnstile-widget" />;
  }
);
