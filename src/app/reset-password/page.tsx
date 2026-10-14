'use client';
import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Toaster } from 'sonner';
import AppLogo from '@/components/ui/AppLogo';
import Icon from '@/components/ui/AppIcon';
import { createClient } from '@/lib/supabase/client';

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [errors, setErrors] = useState<{ password?: string; confirmPassword?: string; general?: string }>({});
  const [sessionReady, setSessionReady] = useState(false);
  const [sessionError, setSessionError] = useState('');

  useEffect(() => {
    const supabase = createClient();
    let settled = false;

    const settle = (ready: boolean, errMsg?: string) => {
      if (settled) return;
      settled = true;
      if (ready) {
        setSessionReady(true);
      } else {
        setSessionError(errMsg || 'This reset link is invalid or has expired. Please request a new one.');
      }
    };

    // Listen for auth state changes — PASSWORD_RECOVERY fires when Supabase
    // processes the #access_token hash from the reset email link.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') {
        settle(true);
      } else if (event === 'SIGNED_IN' && session) {
        // Already signed in with a valid session (e.g. page refresh after recovery)
        settle(true);
      }
    });

    // Also check if there's already an active session (e.g. user refreshed the page
    // after the hash was already consumed and a session was established).
    supabase.auth.getSession().then(({ data, error }) => {
      if (!settled) {
        if (!error && data.session) {
          settle(true);
        } else {
          // Give the onAuthStateChange listener time to fire from the hash fragment
          setTimeout(() => {
            if (!settled) {
              settle(false);
            }
          }, 3000);
        }
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const validate = () => {
    const newErrors: typeof errors = {};
    if (!password) {
      newErrors.password = 'Password is required.';
    } else if (password.length < 8) {
      newErrors.password = 'Password must be at least 8 characters.';
    }
    if (!confirmPassword) {
      newErrors.confirmPassword = 'Please confirm your new password.';
    } else if (password !== confirmPassword) {
      newErrors.confirmPassword = 'Passwords do not match.';
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    setIsLoading(true);
    setErrors({});
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      setIsSuccess(true);
      toast.success('Password updated!', { description: 'You can now sign in with your new password.' });
      // Sign out so the user is prompted to log in fresh with the new password
      await supabase.auth.signOut();
      setTimeout(() => router.push('/login'), 2500);
    } catch (err: any) {
      const msg = err?.message || 'Could not update password. Please try again.';
      setErrors({ general: msg });
      toast.error('Password reset failed', { description: msg });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      <Toaster position="bottom-right" richColors />
      <div className="min-h-screen flex">
        {/* Left brand panel */}
        <div className="hidden lg:flex flex-col w-[45%] xl:w-[42%] bg-eb-green-900 relative overflow-hidden">
          <div className="absolute inset-0 opacity-5">
            <div className="absolute top-0 left-0 w-96 h-96 border border-white rounded-full -translate-x-1/2 -translate-y-1/2" />
            <div className="absolute top-0 left-0 w-64 h-64 border border-white rounded-full -translate-x-1/4 -translate-y-1/4" />
            <div className="absolute bottom-0 right-0 w-80 h-80 border border-white rounded-full translate-x-1/3 translate-y-1/3" />
            <div className="absolute bottom-1/3 left-1/4 w-48 h-48 border border-white rounded-full" />
          </div>
          <div className="relative z-10 flex flex-col h-full p-10 xl:p-12">
            <div className="flex items-center gap-3">
              <AppLogo size={36} />
              <span className="font-display text-white font-700 text-xl tracking-tight">EarnestBridge</span>
            </div>
            <div className="flex-1 flex flex-col justify-center">
              <div className="mb-2">
                <span className="inline-block text-eb-gold-400 text-xs font-display font-600 uppercase tracking-widest border border-eb-gold-500/30 bg-eb-gold-500/10 px-3 py-1 rounded-full mb-4">
                  Password Reset
                </span>
              </div>
              <h1 className="font-display text-white text-3xl xl:text-4xl font-800 leading-tight mb-4">
                Set a new password<br />for your account —<br />
                <span className="text-eb-gold-400">stay secure.</span>
              </h1>
              <p className="text-eb-green-200 text-base leading-relaxed max-w-sm">
                Choose a strong password to protect your EarnestBridge borrower portal account.
              </p>
              <div className="mt-8 space-y-3">
                {[
                  { icon: 'LockClosedIcon', text: 'Use at least 8 characters' },
                  { icon: 'ShieldCheckIcon', text: 'Mix letters, numbers & symbols' },
                  { icon: 'KeyIcon', text: 'Never share your password' },
                ].map((item, i) => (
                  <div key={`rp-${i}`} className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center flex-shrink-0">
                      <Icon name={item.icon as Parameters<typeof Icon>[0]['name']} size={15} className="text-eb-gold-400" />
                    </div>
                    <span className="text-eb-green-100 text-sm">{item.text}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-auto pt-8 border-t border-eb-green-800">
              <p className="text-eb-green-400 text-xs">
                © 2026 EarnestBridge, LLC. All rights reserved.
              </p>
            </div>
          </div>
        </div>

        {/* Right form panel */}
        <div className="flex-1 flex flex-col justify-center bg-white min-h-screen">
          <div className="w-full max-w-md mx-auto px-5 sm:px-8 py-8 sm:py-10">
            {/* Mobile logo */}
            <div className="flex items-center gap-2 mb-8 lg:hidden">
              <AppLogo size={28} />
              <span className="font-display font-700 text-eb-green-900 text-lg">EarnestBridge</span>
            </div>

            {/* Session error state */}
            {sessionError && (
              <div className="space-y-5">
                <div className="flex flex-col items-center text-center py-4">
                  <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center mb-4">
                    <Icon name="ExclamationCircleIcon" size={28} className="text-red-600" />
                  </div>
                  <h2 className="font-display text-2xl font-700 text-gray-900 mb-2">Link expired</h2>
                  <p className="text-sm text-gray-500 max-w-xs">{sessionError}</p>
                </div>
                <Link
                  href="/forgot-password"
                  className="w-full py-2.5 bg-eb-green-900 hover:bg-eb-green-800 text-white font-display font-600 text-sm rounded-lg transition-all duration-150 active:scale-[0.98] flex items-center justify-center gap-2"
                  style={{ minHeight: '42px' }}
                >
                  Request a new reset link
                </Link>
                <p className="text-center text-xs text-gray-400">
                  <Link href="/login" className="text-eb-green-700 hover:text-eb-green-900 font-medium transition-colors">
                    Back to sign in
                  </Link>
                </p>
              </div>
            )}

            {/* Loading session */}
            {!sessionError && !sessionReady && (
              <div className="flex flex-col items-center justify-center py-16 gap-4">
                <div className="w-8 h-8 border-2 border-eb-green-900 border-t-transparent rounded-full animate-spin" />
                <p className="text-sm text-gray-500">Verifying reset link…</p>
              </div>
            )}

            {/* Success state */}
            {sessionReady && isSuccess && (
              <div className="space-y-5 animate-fade-in">
                <div className="flex flex-col items-center text-center py-4">
                  <div className="w-16 h-16 rounded-full bg-eb-green-100 flex items-center justify-center mb-4">
                    <Icon name="CheckCircleIcon" size={28} className="text-eb-green-700" />
                  </div>
                  <h2 className="font-display text-2xl font-700 text-gray-900 mb-2">Password updated!</h2>
                  <p className="text-sm text-gray-500 max-w-xs">
                    Your password has been reset successfully. Redirecting you to sign in…
                  </p>
                </div>
                <Link
                  href="/login"
                  className="w-full py-2.5 bg-eb-green-900 hover:bg-eb-green-800 text-white font-display font-600 text-sm rounded-lg transition-all duration-150 active:scale-[0.98] flex items-center justify-center gap-2"
                  style={{ minHeight: '42px' }}
                >
                  Go to Sign In
                </Link>
              </div>
            )}

            {/* Reset form */}
            {sessionReady && !isSuccess && !sessionError && (
              <form onSubmit={handleSubmit} className="space-y-5 animate-fade-in">
                <div>
                  <h2 className="font-display text-2xl font-700 text-gray-900">Set new password</h2>
                  <p className="text-sm text-gray-500 mt-1">Choose a strong password for your account.</p>
                </div>

                {errors.general && (
                  <div className="rounded-xl border border-red-200 bg-red-50 p-4">
                    <div className="flex items-start gap-3">
                      <Icon name="ExclamationCircleIcon" size={16} className="text-red-600 flex-shrink-0 mt-0.5" />
                      <p className="text-xs text-red-700">{errors.general}</p>
                    </div>
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="new-password">
                    New password
                  </label>
                  <div className="relative">
                    <input
                      id="new-password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      placeholder="Min. 8 characters"
                      value={password}
                      onChange={(e) => { setPassword(e.target.value); setErrors((prev) => ({ ...prev, password: undefined })); }}
                      className={`w-full px-3.5 py-2.5 pr-10 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 ${
                        errors.password ? 'border-red-400 bg-red-50' : 'border-gray-300 bg-white hover:border-gray-400'
                      }`}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
                    >
                      <Icon name={showPassword ? 'EyeSlashIcon' : 'EyeIcon'} size={16} />
                    </button>
                  </div>
                  {errors.password && (
                    <p className="mt-1.5 text-xs text-red-600 flex items-center gap-1">
                      <Icon name="ExclamationCircleIcon" size={12} />
                      {errors.password}
                    </p>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="confirm-new-password">
                    Confirm new password
                  </label>
                  <div className="relative">
                    <input
                      id="confirm-new-password"
                      type={showConfirmPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      placeholder="Repeat new password"
                      value={confirmPassword}
                      onChange={(e) => { setConfirmPassword(e.target.value); setErrors((prev) => ({ ...prev, confirmPassword: undefined })); }}
                      className={`w-full px-3.5 py-2.5 pr-10 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 ${
                        errors.confirmPassword ? 'border-red-400 bg-red-50' : 'border-gray-300 bg-white hover:border-gray-400'
                      }`}
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
                    >
                      <Icon name={showConfirmPassword ? 'EyeSlashIcon' : 'EyeIcon'} size={16} />
                    </button>
                  </div>
                  {errors.confirmPassword && (
                    <p className="mt-1.5 text-xs text-red-600 flex items-center gap-1">
                      <Icon name="ExclamationCircleIcon" size={12} />
                      {errors.confirmPassword}
                    </p>
                  )}
                </div>

                {/* Password strength hint */}
                <div className="rounded-xl border border-gray-100 bg-gray-50 p-3">
                  <p className="text-xs text-gray-500 font-display font-600 mb-2">Password tips</p>
                  <ul className="space-y-1">
                    {[
                      { label: 'At least 8 characters', met: password.length >= 8 },
                      { label: 'Contains a number', met: /\d/.test(password) },
                      { label: 'Contains a special character', met: /[^a-zA-Z0-9]/.test(password) },
                    ].map((tip, i) => (
                      <li key={`tip-${i}`} className="flex items-center gap-2 text-xs">
                        <Icon
                          name={tip.met ? 'CheckCircleIcon' : 'XCircleIcon'}
                          size={13}
                          className={tip.met ? 'text-eb-green-600' : 'text-gray-300'}
                        />
                        <span className={tip.met ? 'text-eb-green-700' : 'text-gray-400'}>{tip.label}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full py-2.5 bg-eb-green-900 hover:bg-eb-green-800 disabled:opacity-60 text-white font-display font-600 text-sm rounded-lg transition-all duration-150 active:scale-[0.98] flex items-center justify-center gap-2"
                  style={{ minHeight: '42px' }}
                >
                  {isLoading ? (
                    <>
                      <Icon name="ArrowPathIcon" size={16} className="animate-spin" />
                      <span>Updating password...</span>
                    </>
                  ) : (
                    'Update Password'
                  )}
                </button>

                <p className="text-center text-xs text-gray-400">
                  <Link href="/login" className="text-eb-green-700 hover:text-eb-green-900 font-medium transition-colors">
                    Back to sign in
                  </Link>
                </p>
              </form>
            )}

            <p className="mt-8 text-center text-xs text-gray-400">
              Secured by 256-bit SSL encryption.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
