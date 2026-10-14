'use client';
import React, { useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Toaster } from 'sonner';
import AppLogo from '@/components/ui/AppLogo';
import Icon from '@/components/ui/AppIcon';
import { createClient } from '@/lib/supabase/client';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Please enter a valid email address.');
      return;
    }

    setIsLoading(true);
    try {
      const supabase = createClient();
      const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || window.location.origin;
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${siteUrl}/reset-password`,
      });
      if (resetError) throw resetError;
      setSent(true);
      toast.success('Reset link sent!', { description: `Check your inbox at ${email}.` });
    } catch (err: any) {
      const msg = err?.message || 'Could not send reset email. Please try again.';
      setError(msg);
      toast.error('Failed to send reset link', { description: msg });
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
                  Account Recovery
                </span>
              </div>
              <h1 className="font-display text-white text-3xl xl:text-4xl font-800 leading-tight mb-4">
                Regain access to<br />your account —<br />
                <span className="text-eb-gold-400">securely and quickly.</span>
              </h1>
              <p className="text-eb-green-200 text-base leading-relaxed max-w-sm">
                Enter your registered email address and we'll send you a secure link to reset your password.
              </p>
              <div className="mt-8 space-y-3">
                {[
                  { icon: 'EnvelopeIcon', text: 'Reset link sent to your inbox' },
                  { icon: 'ShieldCheckIcon', text: 'Link expires in 60 minutes' },
                  { icon: 'LockClosedIcon', text: 'Secure password reset flow' },
                ].map((item, i) => (
                  <div key={`fp-${i}`} className="flex items-center gap-3">
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

            {/* Back link */}
            <Link
              href="/login"
              className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-eb-green-900 transition-colors mb-8"
            >
              <Icon name="ArrowLeftIcon" size={14} />
              Back to sign in
            </Link>

            {!sent ? (
              <form onSubmit={handleSubmit} className="space-y-5">
                <div>
                  <h2 className="font-display text-2xl font-700 text-gray-900">Forgot your password?</h2>
                  <p className="text-sm text-gray-500 mt-1">
                    Enter your email and we'll send you a reset link.
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="forgot-email">
                    Email address
                  </label>
                  <input
                    id="forgot-email"
                    type="email"
                    autoComplete="email"
                    placeholder="you@company.com"
                    value={email}
                    onChange={(e) => { setEmail(e.target.value); setError(''); }}
                    className={`w-full px-3.5 py-2.5 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 ${
                      error ? 'border-red-400 bg-red-50' : 'border-gray-300 bg-white hover:border-gray-400'
                    }`}
                  />
                  {error && (
                    <p className="mt-1.5 text-xs text-red-600 flex items-center gap-1">
                      <Icon name="ExclamationCircleIcon" size={12} />
                      {error}
                    </p>
                  )}
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
                      <span>Sending reset link...</span>
                    </>
                  ) : (
                    'Send Reset Link'
                  )}
                </button>

                <p className="text-center text-xs text-gray-400">
                  Remember your password?{' '}
                  <Link href="/login" className="text-eb-green-700 hover:text-eb-green-900 font-medium transition-colors">
                    Sign in
                  </Link>
                </p>
              </form>
            ) : (
              /* Success state */
              <div className="space-y-5 animate-fade-in">
                <div className="flex flex-col items-center text-center py-4">
                  <div className="w-16 h-16 rounded-full bg-eb-green-100 flex items-center justify-center mb-4">
                    <Icon name="EnvelopeIcon" size={28} className="text-eb-green-700" />
                  </div>
                  <h2 className="font-display text-2xl font-700 text-gray-900 mb-2">Check your inbox</h2>
                  <p className="text-sm text-gray-500 max-w-xs">
                    We've sent a password reset link to{' '}
                    <span className="font-medium text-gray-700">{email}</span>.
                    The link expires in 60 minutes.
                  </p>
                </div>

                <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                  <div className="flex items-start gap-3">
                    <Icon name="InformationCircleIcon" size={16} className="text-amber-600 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-700">
                      If you don't see the email, check your spam or junk folder. The sender will be <span className="font-medium">no-reply@earnestbridge.com</span>.
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => { setSent(false); setEmail(''); }}
                  className="w-full py-2.5 border border-gray-300 hover:border-gray-400 text-gray-700 font-display font-600 text-sm rounded-lg transition-all duration-150 active:scale-[0.98]"
                >
                  Try a different email
                </button>

                <p className="text-center text-xs text-gray-400">
                  <Link href="/login" className="text-eb-green-700 hover:text-eb-green-900 font-medium transition-colors">
                    Back to sign in
                  </Link>
                </p>
              </div>
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
