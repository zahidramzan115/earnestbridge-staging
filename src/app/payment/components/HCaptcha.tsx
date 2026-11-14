'use client';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

// Minimal hCaptcha widget (explicit render). Site key: NEXT_PUBLIC_HCAPTCHA_SITE_KEY.

declare global {
  interface Window {
    hcaptcha?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      reset: (id?: string) => void;
    };
    __ebHcaptchaLoaded?: () => void;
  }
}

const SCRIPT_ID = 'hcaptcha-script';
const SCRIPT_SRC = 'https://js.hcaptcha.com/1/api.js?render=explicit&onload=__ebHcaptchaLoaded';

let loadPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.hcaptcha) return Promise.resolve();
  if (loadPromise) return loadPromise;
  loadPromise = new Promise<void>((resolve, reject) => {
    window.__ebHcaptchaLoaded = () => resolve();
    if (!document.getElementById(SCRIPT_ID)) {
      const s = document.createElement('script');
      s.id = SCRIPT_ID;
      s.src = SCRIPT_SRC;
      s.async = true;
      s.defer = true;
      s.onerror = () => {
        loadPromise = null;
        reject(new Error('Failed to load hCaptcha'));
      };
      document.head.appendChild(s);
    }
  });
  return loadPromise;
}

export interface HCaptchaHandle {
  reset: () => void;
}

interface Props {
  siteKey: string;
  onVerify: (token: string) => void;
  onExpire: () => void;
  onError?: () => void;
}

const HCaptcha = forwardRef<HCaptchaHandle, Props>(function HCaptcha({ siteKey, onVerify, onExpire, onError }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const callbacks = useRef({ onVerify, onExpire, onError });
  callbacks.current = { onVerify, onExpire, onError };

  useImperativeHandle(ref, () => ({
    reset: () => {
      if (window.hcaptcha && widgetIdRef.current !== null) window.hcaptcha.reset(widgetIdRef.current);
    },
  }));

  useEffect(() => {
    let cancelled = false;
    loadScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.hcaptcha || widgetIdRef.current !== null) return;
        widgetIdRef.current = window.hcaptcha.render(containerRef.current, {
          sitekey: siteKey,
          callback: (token: string) => callbacks.current.onVerify(token),
          'expired-callback': () => callbacks.current.onExpire(),
          'error-callback': () => callbacks.current.onError?.(),
        });
      })
      .catch(() => callbacks.current.onError?.());
    return () => {
      cancelled = true;
    };
  }, [siteKey]);

  return <div ref={containerRef} />;
});

export default HCaptcha;
