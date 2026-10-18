'use client';
import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { Toaster } from 'sonner';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

import AppLogo from '@/components/ui/AppLogo';
import Icon from '@/components/ui/AppIcon';
import { useAuth } from '@/contexts/AuthContext';

type AuthMode = 'login' | 'signup';

interface LoginFormData {
  email: string;
  password: string;
  rememberMe: boolean;
}

interface SignupFormData {
  fullName: string;
  email: string;
  phone: string;
  company: string;
  password: string;
  confirmPassword: string;
  agreeTerms: boolean;
}

const SAFE_REDIRECT_STATIC_PATHS = ['/dashboard-home', '/deals', '/documents', '/profile'];
const SAFE_REDIRECT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// redirectTo is browser-controlled. Returns a validated borrower portal path or null.
// The value is expected to be already single-decoded by URLSearchParams; no further decoding is done.
function getSafePortalRedirect(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 200) return null;
  // control characters (incl. whitespace controls, DEL) and backslashes
  if (/[\u0000-\u001F\u007F]/.test(raw)) return null;
  if (raw.includes('\\')) return null;
  // must start with exactly one "/"
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  // no scheme / absolute URL markers, no query strings, hashes or encoded chars
  if (raw.includes('://') || raw.includes(':') || raw.includes('?') || raw.includes('#') || raw.includes('%')) return null;
  const lower = raw.toLowerCase();
  if (lower.startsWith('http:') || lower.startsWith('https:') || lower.startsWith('javascript:') || lower.startsWith('data:')) return null;

  if (SAFE_REDIRECT_STATIC_PATHS.includes(raw)) return raw;

  const dealMatch = /^\/deals\/([^/]+)$/.exec(raw);
  if (dealMatch && SAFE_REDIRECT_UUID_RE.test(dealMatch[1])) return raw;

  return null;
}


export default function AuthForm() {
  const [mode, setMode] = useState<AuthMode>('login');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);
  const [resendingVerification, setResendingVerification] = useState(false);
  const { signIn, signUp } = useAuth();
  const router = useRouter();

  const loginForm = useForm<LoginFormData>({
    defaultValues: { email: '', password: '', rememberMe: false },
  });

  const signupForm = useForm<SignupFormData>({
    defaultValues: { fullName: '', email: '', phone: '', company: '', password: '', confirmPassword: '', agreeTerms: false },
  });

  const handleLogin = async (data: LoginFormData) => {
    setIsLoading(true);
    setUnverifiedEmail(null);
    try {
      const result = await signIn(data.email, data.password);
      toast.success('Welcome back!', { description: 'Redirecting to your dashboard...' });
      // Redirect admins to admin panel, borrowers to dashboard
      // Trust ONLY app_metadata.role — user_metadata is user-editable and must not grant Admin routing
      const role = result?.user?.app_metadata?.role;
      let redirectPath = '/dashboard-home';
      if (role === 'admin') {
        redirectPath = '/admin';
      } else {
        const rawRedirect = new URLSearchParams(window.location.search).get('redirectTo');
        redirectPath = getSafePortalRedirect(rawRedirect) ?? '/dashboard-home';
      }
      setTimeout(() => router.push(redirectPath), 600);
    } catch (err: any) {
      const msg = err?.message || 'Invalid email or password';
      // Match both Supabase native and our custom unverified-email error messages
      const isUnverified =
        msg.toLowerCase().includes('verify your email') ||
        msg.toLowerCase().includes('email not confirmed') ||
        msg.toLowerCase().includes('email_not_confirmed');
      if (isUnverified) {
        setUnverifiedEmail(data.email);
        toast.warning('Email not verified', { description: 'Check your inbox for the confirmation link.' });
      } else {
        loginForm.setError('email', { message: msg });
        toast.error('Sign in failed', { description: msg });
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleSignup = async (data: SignupFormData) => {
    setIsLoading(true);
    try {
      await signUp(data.email, data.password, {
        fullName: data.fullName,
        phone: data.phone,
        company: data.company,
      });
      toast.success('Account created!', { description: 'Check your email to verify your address, then sign in.' });
      setMode('login');
    } catch (err: any) {
      const msg = err?.message || 'Could not create account';
      signupForm.setError('email', { message: msg });
      toast.error('Sign up failed', { description: msg });
    } finally {
      setIsLoading(false);
    }
  };

  const handleResendVerification = async () => {
    if (!unverifiedEmail) return;
    setResendingVerification(true);
    try {
      const { createClient } = await import('@/lib/supabase/client');
      const supabase = createClient();
      const { error } = await supabase.auth.resend({
        type: 'signup',
        email: unverifiedEmail,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (error) throw error;
      toast.success('Verification email sent!', { description: `A new confirmation link has been sent to ${unverifiedEmail}.` });
    } catch (err: any) {
      toast.error('Could not resend email', { description: err?.message || 'Please try again.' });
    } finally {
      setResendingVerification(false);
    }
  };

    return (
    <>
      <Toaster position="bottom-right" richColors />
      <div className="min-h-screen flex">
        {/* Left brand panel */}
        <div className="hidden lg:flex flex-col w-[45%] xl:w-[42%] bg-eb-green-900 relative overflow-hidden">
          {/* Geometric background pattern */}
          <div className="absolute inset-0 opacity-5">
            <div className="absolute top-0 left-0 w-96 h-96 border border-white rounded-full -translate-x-1/2 -translate-y-1/2" />
            <div className="absolute top-0 left-0 w-64 h-64 border border-white rounded-full -translate-x-1/4 -translate-y-1/4" />
            <div className="absolute bottom-0 right-0 w-80 h-80 border border-white rounded-full translate-x-1/3 translate-y-1/3" />
            <div className="absolute bottom-1/3 left-1/4 w-48 h-48 border border-white rounded-full" />
          </div>

          <div className="relative z-10 flex flex-col h-full p-10 xl:p-12">
            {/* Logo */}
            <div className="flex items-center gap-3">
              <AppLogo size={36} />
              <span className="font-display text-white font-700 text-xl tracking-tight">EarnestBridge</span>
            </div>

            {/* Hero content */}
            <div className="flex-1 flex flex-col justify-center">
              <div className="mb-2">
                <span className="inline-block text-eb-gold-400 text-xs font-display font-600 uppercase tracking-widest border border-eb-gold-500/30 bg-eb-gold-500/10 px-3 py-1 rounded-full mb-4">
                  EMD Financing Platform
                </span>
              </div>
              <h1 className="font-display text-white text-3xl xl:text-4xl font-800 leading-tight mb-4">
                Fund your earnest<br />money deposits —<br />
                <span className="text-eb-gold-400">close with confidence.</span>
              </h1>
              <p className="text-eb-green-200 text-base leading-relaxed max-w-sm">
                EarnestBridge provides institutional-grade EMD financing for commercial real estate acquisitions. Track every deal from application to closing.
              </p>

              {/* Value props */}
              <div className="mt-8 space-y-3">
                {[
                  { icon: 'BoltIcon', text: 'Funding decisions in 24–48 hours' },
                  { icon: 'ShieldCheckIcon', text: 'Manage multiple deals at once' },
                  { icon: 'DocumentCheckIcon', text: 'Streamlined document portal' },
                  { icon: 'CalendarDaysIcon', text: 'Real-time closing timeline tracking' },
                ].map((item, i) => (
                  <div key={`vp-${i}`} className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center flex-shrink-0">
                      <Icon name={item.icon as Parameters<typeof Icon>[0]['name']} size={15} className="text-eb-gold-400" />
                    </div>
                    <span className="text-eb-green-100 text-sm">{item.text}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Footer */}
            <div className="mt-auto pt-8 border-t border-eb-green-800">
              <p className="text-eb-green-400 text-xs">
                © 2026 EarnestBridge, LLC. All rights reserved.
                <br />
                <a href="https://earnestbridge.com" className="hover:text-eb-green-200 transition-colors underline-offset-2 hover:underline" target="_blank" rel="noopener noreferrer">earnestbridge.com</a>
              </p>
            </div>
          </div>
        </div>

        {/* Right form panel */}
        <div className="flex-1 flex flex-col bg-white min-h-screen">
          {/* Mobile green header - only visible on mobile */}
          <div className="lg:hidden bg-eb-green-900 px-5 py-4 flex items-center gap-2.5">
            <AppLogo size={28} />
            <span className="font-display font-700 text-white text-lg">EarnestBridge</span>
          </div>

          <div className="flex-1 flex flex-col justify-center">
          <div className="w-full max-w-md mx-auto px-5 sm:px-8 py-8 sm:py-10">
            {/* Mobile logo - hidden, replaced by green header above */}
            <div className="hidden">
              <AppLogo size={28} />
              <span className="font-display font-700 text-eb-green-900 text-lg">EarnestBridge</span>
            </div>

            {/* Mode toggle */}
            <div className="flex bg-eb-green-900/10 rounded-xl p-1 mb-8">
              {(['login', 'signup'] as AuthMode[]).map((m) => (
                <button
                  key={`mode-${m}`}
                  onClick={() => setMode(m)}
                  className={`flex-1 py-2.5 text-sm font-display font-600 rounded-lg transition-all duration-200 ${
                    mode === m
                      ? 'bg-gradient-to-r from-eb-green-900 to-emerald-600 text-white shadow-card'
                      : 'text-eb-green-900/60 hover:text-eb-green-900'
                  }`}
                >
                  {m === 'login' ? 'Sign In' : 'Create Account'}
                </button>
              ))}
            </div>

            {/* Login Form */}
            {mode === 'login' && (
              <form onSubmit={loginForm.handleSubmit(handleLogin)} className="space-y-5 animate-fade-in">
                <div>
                  <h2 className="font-display text-2xl font-700 text-gray-900">Welcome back</h2>
                  <p className="text-sm text-gray-500 mt-1">Sign in to your borrower portal</p>
                </div>

                {/* Unverified email banner */}
                {unverifiedEmail && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                    <div className="flex items-start gap-3">
                      <Icon name="EnvelopeIcon" size={18} className="text-amber-600 flex-shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-display font-600 text-amber-800">Email not verified</p>
                        <p className="text-xs text-amber-700 mt-0.5">
                          Please check your inbox at <span className="font-medium">{unverifiedEmail}</span> and click the confirmation link before signing in.
                        </p>
                        <button
                          type="button"
                          onClick={handleResendVerification}
                          disabled={resendingVerification}
                          className="mt-2 text-xs font-display font-600 text-amber-800 underline underline-offset-2 hover:text-amber-900 disabled:opacity-60 flex items-center gap-1"
                        >
                          {resendingVerification ? (
                            <>
                              <Icon name="ArrowPathIcon" size={12} className="animate-spin" />
                              Sending…
                            </>
                          ) : (
                            'Resend verification email'
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="login-email">
                    Email address
                  </label>
                  <input
                    id="login-email"
                    type="email"
                    autoComplete="email"
                    placeholder="you@company.com"
                    className={`w-full px-3.5 py-2.5 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 ${
                      loginForm.formState.errors.email ? 'border-red-400 bg-red-50' : 'border-gray-300 bg-white hover:border-gray-400'
                    }`}
                    {...loginForm.register('email', {
                      required: 'Email is required',
                      pattern: { value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: 'Enter a valid email address' },
                    })}
                  />
                  {loginForm.formState.errors.email && (
                    <p className="mt-1.5 text-xs text-red-600 flex items-center gap-1">
                      <Icon name="ExclamationCircleIcon" size={12} />
                      {loginForm.formState.errors.email.message}
                    </p>
                  )}
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="block text-sm font-medium text-gray-700" htmlFor="login-password">
                      Password
                    </label>
                    <Link href="/forgot-password" className="text-xs text-eb-green-700 hover:text-eb-green-900 font-medium transition-colors">
                      Forgot password?
                    </Link>
                  </div>
                  <div className="relative">
                    <input
                      id="login-password"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      placeholder="••••••••••••"
                      className={`w-full px-3.5 py-2.5 pr-10 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 ${
                        loginForm.formState.errors.password ? 'border-red-400 bg-red-50' : 'border-gray-300 bg-white hover:border-gray-400'
                      }`}
                      {...loginForm.register('password', {
                        required: 'Password is required',
                        minLength: { value: 8, message: 'Password must be at least 8 characters' },
                      })}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
                    >
                      <Icon name={showPassword ? 'EyeSlashIcon' : 'EyeIcon'} size={16} />
                    </button>
                  </div>
                  {loginForm.formState.errors.password && (
                    <p className="mt-1.5 text-xs text-red-600 flex items-center gap-1">
                      <Icon name="ExclamationCircleIcon" size={12} />
                      {loginForm.formState.errors.password.message}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <input
                    id="remember-me"
                    type="checkbox"
                    className="w-4 h-4 rounded border-gray-300 text-eb-green-900 focus:ring-eb-green-900/20 accent-eb-green-900 cursor-pointer"
                    {...loginForm.register('rememberMe')}
                  />
                  <label htmlFor="remember-me" className="text-sm text-gray-600 cursor-pointer select-none">
                    Keep me signed in for 30 days
                  </label>
                </div>

                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full py-2.5 bg-gradient-to-r from-eb-green-900 to-emerald-600 hover:from-eb-green-800 hover:to-emerald-500 disabled:opacity-60 text-white font-display font-600 text-sm rounded-lg transition-all duration-150 active:scale-[0.98] flex items-center justify-center gap-2"
                  style={{ minHeight: '42px' }}
                >
                  {isLoading ? (
                    <>
                      <Icon name="ArrowPathIcon" size={16} className="animate-spin" />
                      <span>Signing in...</span>
                    </>
                  ) : (
                    'Sign In to Portal'
                  )}
                </button>
              </form>
            )}

            {/* Signup Form */}
            {mode === 'signup' && (
              <form onSubmit={signupForm.handleSubmit(handleSignup)} className="space-y-4 animate-fade-in">
                <div>
                  <h2 className="font-display text-2xl font-700 text-gray-900">Create your account</h2>
                  <p className="text-sm text-gray-500 mt-1">Start your first EMD financing application</p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="full-name">
                      Full name <span className="text-red-500">*</span>
                    </label>
                    <input
                      id="full-name"
                      type="text"
                      autoComplete="name"
                      placeholder="Marcus Reid"
                      className={`w-full px-3.5 py-2.5 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 ${
                        signupForm.formState.errors.fullName ? 'border-red-400 bg-red-50' : 'border-gray-300 hover:border-gray-400'
                      }`}
                      {...signupForm.register('fullName', { required: 'Full name is required' })}
                    />
                    {signupForm.formState.errors.fullName && (
                      <p className="mt-1 text-xs text-red-600">{signupForm.formState.errors.fullName.message}</p>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="phone">
                      Phone number
                    </label>
                    <input
                      id="phone"
                      type="tel"
                      autoComplete="tel"
                      placeholder="+1 (512) 555-0192"
                      className="w-full px-3.5 py-2.5 text-sm border border-gray-300 rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 hover:border-gray-400"
                      {...signupForm.register('phone')}
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="company">
                    Company / Entity name <span className="text-red-500">*</span>
                  </label>
                  <p className="text-xs text-gray-400 mb-1.5">LLC, LP, Corporation, or your name if investing individually</p>
                  <input
                    id="company"
                    type="text"
                    placeholder="Reid Capital Group LLC"
                    className={`w-full px-3.5 py-2.5 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 ${
                      signupForm.formState.errors.company ? 'border-red-400 bg-red-50' : 'border-gray-300 hover:border-gray-400'
                    }`}
                    {...signupForm.register('company', { required: 'Company or entity name is required' })}
                  />
                  {signupForm.formState.errors.company && (
                    <p className="mt-1 text-xs text-red-600">{signupForm.formState.errors.company.message}</p>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="signup-email">
                    Email address <span className="text-red-500">*</span>
                  </label>
                  <input
                    id="signup-email"
                    type="email"
                    autoComplete="email"
                    placeholder="you@company.com"
                    className={`w-full px-3.5 py-2.5 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 ${
                      signupForm.formState.errors.email ? 'border-red-400 bg-red-50' : 'border-gray-300 hover:border-gray-400'
                    }`}
                    {...signupForm.register('email', {
                      required: 'Email is required',
                      pattern: { value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: 'Enter a valid email address' },
                    })}
                  />
                  {signupForm.formState.errors.email && (
                    <p className="mt-1 text-xs text-red-600">{signupForm.formState.errors.email.message}</p>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="signup-password">
                      Password <span className="text-red-500">*</span>
                    </label>
                    <div className="relative">
                      <input
                        id="signup-password"
                        type={showPassword ? 'text' : 'password'}
                        placeholder="Min. 8 characters"
                        className={`w-full px-3.5 py-2.5 pr-10 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 ${
                          signupForm.formState.errors.password ? 'border-red-400 bg-red-50' : 'border-gray-300 hover:border-gray-400'
                        }`}
                        {...signupForm.register('password', {
                          required: 'Password is required',
                          minLength: { value: 8, message: 'Min. 8 characters' },
                        })}
                      />
                      <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                        <Icon name={showPassword ? 'EyeSlashIcon' : 'EyeIcon'} size={15} />
                      </button>
                    </div>
                    {signupForm.formState.errors.password && (
                      <p className="mt-1 text-xs text-red-600">{signupForm.formState.errors.password.message}</p>
                    )}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="confirm-password">
                      Confirm password <span className="text-red-500">*</span>
                    </label>
                    <div className="relative">
                      <input
                        id="confirm-password"
                        type={showConfirmPassword ? 'text' : 'password'}
                        placeholder="Repeat password"
                        className={`w-full px-3.5 py-2.5 pr-10 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 ${
                          signupForm.formState.errors.confirmPassword ? 'border-red-400 bg-red-50' : 'border-gray-300 hover:border-gray-400'
                        }`}
                        {...signupForm.register('confirmPassword', {
                          required: 'Please confirm your password',
                          validate: (value) =>
                            value === signupForm.getValues('password') || 'Passwords do not match',
                        })}
                      />
                      <button type="button" onClick={() => setShowConfirmPassword(!showConfirmPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                        <Icon name={showConfirmPassword ? 'EyeSlashIcon' : 'EyeIcon'} size={15} />
                      </button>
                    </div>
                    {signupForm.formState.errors.confirmPassword && (
                      <p className="mt-1 text-xs text-red-600">{signupForm.formState.errors.confirmPassword.message}</p>
                    )}
                  </div>
                </div>

                <div>
                  <div className={`flex items-start gap-2 p-3 rounded-xl border ${signupForm.formState.errors.agreeTerms ? 'border-red-300 bg-red-50' : 'border-gray-100 bg-gray-50'}`}>
                    <input
                      id="agree-terms"
                      type="checkbox"
                      className="w-4 h-4 mt-0.5 rounded border-gray-300 accent-eb-green-900 cursor-pointer"
                      {...signupForm.register('agreeTerms', { required: 'You must agree to the terms to continue' })}
                    />
                    <label htmlFor="agree-terms" className="text-sm text-gray-600 cursor-pointer">
                      I agree to EarnestBridge{' '}
                      <a href="https://earnestbridge.com/terms" target="_blank" rel="noopener noreferrer" className="text-eb-green-700 hover:underline font-medium">Terms of Service</a>
                      {' '}and{' '}
                      <a href="https://earnestbridge.com/privacy" target="_blank" rel="noopener noreferrer" className="text-eb-green-700 hover:underline font-medium">Privacy Policy</a>
                    </label>
                  </div>
                  {signupForm.formState.errors.agreeTerms && (
                    <p className="mt-1.5 text-xs text-red-600 flex items-center gap-1">
                      <Icon name="ExclamationCircleIcon" size={12} />
                      {signupForm.formState.errors.agreeTerms.message}
                    </p>
                  )}
                </div>

                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full py-2.5 bg-gradient-to-r from-eb-green-900 to-emerald-600 hover:from-eb-green-800 hover:to-emerald-500 disabled:opacity-60 text-white font-display font-600 text-sm rounded-lg transition-all duration-150 active:scale-[0.98] flex items-center justify-center gap-2"
                  style={{ minHeight: '42px' }}
                >
                  {isLoading ? (
                    <>
                      <Icon name="ArrowPathIcon" size={16} className="animate-spin" />
                      <span>Creating account...</span>
                    </>
                  ) : (
                    'Create Borrower Account'
                  )}
                </button>
              </form>
            )}

            <p className="mt-6 text-center text-xs text-gray-400">
              Secured by 256-bit SSL encryption.{' '}
              <a href="https://earnestbridge.com" target="_blank" rel="noopener noreferrer" className="text-eb-green-700 hover:underline">
                earnestbridge.com
              </a>
            </p>
          </div>
          </div>
        </div>
      </div>
    </>
  );
}
