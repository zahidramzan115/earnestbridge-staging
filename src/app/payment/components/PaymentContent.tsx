'use client';
import React, { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import AppLogo from '@/components/ui/AppLogo';
import Icon from '@/components/ui/AppIcon';
import HCaptcha, { type HCaptchaHandle } from './HCaptcha';
import type { CoinflowSession } from './CoinflowCheckout';
import { PAYMENT_TERMS_URL } from '@/lib/paymentTerms';

const CoinflowCheckout = dynamic(() => import('./CoinflowCheckout'), {
  ssr: false,
  loading: () => <p className="text-sm text-gray-500 py-8 text-center">Loading secure card form…</p>,
});

interface VerifiedInvoice {
  number: string;
  customerName: string | null;
  description: string | null;
  currency: string;
  totalCents: number;
  amountDueCents: number;
}

type Step = 'verify' | 'details' | 'pay' | 'result';
type ResultState = 'processing' | 'success' | 'declined';

const SITE_KEY = process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY ?? '';
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 2 * 60 * 1000;

const inputClass =
  'w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-eb-green-700 focus:border-eb-green-700';

function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

function Notice({ kind, children }: { kind: 'error' | 'success' | 'info'; children: React.ReactNode }) {
  const styles = {
    error: 'border-red-200 bg-red-50 text-red-700',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    info: 'border-amber-200 bg-amber-50 text-amber-800',
  }[kind];
  const icon = { error: 'ExclamationCircleIcon', success: 'CheckCircleIcon', info: 'InformationCircleIcon' }[kind];
  return (
    <div className={`rounded-lg border px-3 py-2.5 text-sm flex gap-2 ${styles}`}>
      <Icon name={icon} size={18} className="flex-shrink-0 mt-0.5" />
      <div>{children}</div>
    </div>
  );
}

export default function PaymentContent() {
  const [step, setStep] = useState<Step>('verify');

  // Step 1: verify
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [captchaToken, setCaptchaToken] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ text: string; paid?: boolean } | null>(null);
  const [verified, setVerified] = useState<{ checkoutId: string; invoice: VerifiedInvoice } | null>(null);
  const captchaRef = useRef<HCaptchaHandle>(null);

  // Step 2: payer details
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);

  // Step 3/4: payment
  const [session, setSession] = useState<CoinflowSession | null>(null);
  const [result, setResult] = useState<ResultState>('processing');
  const [resultInfo, setResultInfo] = useState<{ message?: string; last4?: string | null }>({});
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
  }, []);

  const canVerify = invoiceNumber.trim() !== '' && identifier.trim() !== '' && captchaToken !== '' && !submitting;
  const canContinue =
    firstName.trim() !== '' && lastName.trim() !== '' && email.trim() !== '' && phone.trim() !== '' && termsAccepted && !submitting;

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canVerify) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/payment/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoiceNumber: invoiceNumber.trim(), identifier: identifier.trim(), captchaToken }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.ok) {
        setVerified({ checkoutId: json.checkoutId, invoice: json.invoice });
        if (identifier.includes('@')) setEmail(identifier.trim());
        setStep('details');
      } else {
        setError({
          text: json.message || 'Unable to verify invoice. Please check your information and try again.',
          paid: json.code === 'already_paid',
        });
      }
    } catch {
      setError({ text: 'We are unable to verify invoices right now. Please try again in a few minutes.' });
    } finally {
      // hCaptcha tokens are single use.
      setCaptchaToken('');
      captchaRef.current?.reset();
      setSubmitting(false);
    }
  };

  const handleContinue = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!verified || !canContinue) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/payment/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          checkoutId: verified.checkoutId,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim(),
          phone: phone.trim(),
          termsAccepted,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.ok) {
        setSession(json as CoinflowSession);
        setStep('pay');
      } else if (json.code === 'expired' || json.code === 'balance_changed') {
        startOver(json.message);
      } else {
        setError({ text: json.message || 'We are unable to start the payment right now. Please try again.' });
      }
    } catch {
      setError({ text: 'We are unable to start the payment right now. Please try again.' });
    } finally {
      setSubmitting(false);
    }
  };

  const pollStatus = (checkoutId: string, startedAt: number) => {
    pollTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/payment/status?checkoutId=${encodeURIComponent(checkoutId)}`, { cache: 'no-store' });
        const json = await res.json();
        if (json.status === 'settled') {
          setResult('success');
          setResultInfo({ last4: json.cardLast4 });
          return;
        }
        if (json.status === 'declined' || json.status === 'failed') {
          setResult('declined');
          setResultInfo({ message: json.message });
          return;
        }
      } catch {
        // keep polling
      }
      if (Date.now() - startedAt < POLL_TIMEOUT_MS) pollStatus(checkoutId, startedAt);
    }, POLL_INTERVAL_MS);
  };

  const handlePaymentSuccess = (paymentId: string) => {
    if (!verified) return;
    setStep('result');
    setResult('processing');
    fetch('/api/payment/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkoutId: verified.checkoutId, paymentId }),
    }).catch(() => undefined);
    pollStatus(verified.checkoutId, Date.now());
  };

  const handleDeclined = (message: string) => {
    setError({ text: message });
  };

  function startOver(message?: string) {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    setStep('verify');
    setVerified(null);
    setSession(null);
    setTermsAccepted(false);
    setError(message ? { text: message } : null);
  }

  /** Back to the first screen with an empty form. */
  function payAnotherInvoice() {
    startOver();
    setInvoiceNumber('');
    setIdentifier('');
  }

  const invoice = verified?.invoice;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="bg-eb-green-900">
        <div className="max-w-xl mx-auto px-4 py-4 flex items-center gap-2.5">
          <AppLogo size={28} />
          <span className="font-display font-700 text-white text-lg">EarnestBridge</span>
        </div>
      </header>

      <main className="flex-1 w-full max-w-xl mx-auto px-4 py-8 sm:py-12">
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-5 sm:px-6 py-5 border-b border-gray-100">
            <h1 className="font-display text-xl sm:text-2xl font-700 text-gray-900">Pay an Invoice</h1>
            <p className="text-sm text-gray-500 mt-1">
              {step === 'verify' && 'Enter your invoice number to get started.'}
              {step === 'details' && 'Review your invoice and enter your details.'}
              {step === 'pay' && 'Enter your card details to complete payment.'}
              {step === 'result' && 'Payment status'}
            </p>
          </div>

          {/* ── Invoice summary (steps 2-4) ── */}
          {invoice && step !== 'verify' && (
            <div className="px-5 sm:px-6 pt-6">
              <dl className="rounded-xl border border-gray-200 divide-y divide-gray-100 text-sm">
                <div className="flex justify-between gap-4 px-4 py-3">
                  <dt className="text-gray-500">Invoice</dt>
                  <dd className="font-600 text-gray-900">{invoice.number}</dd>
                </div>
                {invoice.customerName && (
                  <div className="flex justify-between gap-4 px-4 py-3">
                    <dt className="text-gray-500">Customer</dt>
                    <dd className="text-gray-900 text-right">{invoice.customerName}</dd>
                  </div>
                )}
                {invoice.description && (
                  <div className="flex justify-between gap-4 px-4 py-3">
                    <dt className="text-gray-500">Description</dt>
                    <dd className="text-gray-900 text-right">{invoice.description}</dd>
                  </div>
                )}
                <div className="flex justify-between gap-4 px-4 py-3">
                  <dt className="text-gray-500">Invoice Total</dt>
                  <dd className="text-gray-900">{formatMoney(invoice.totalCents, invoice.currency)}</dd>
                </div>
                <div className="flex justify-between gap-4 px-4 py-3 bg-gray-50">
                  <dt className="font-600 text-gray-900">Amount Due</dt>
                  <dd className="font-700 text-gray-900">{formatMoney(invoice.amountDueCents, invoice.currency)}</dd>
                </div>
              </dl>
            </div>
          )}

          {/* ── Step 1: verify ── */}
          {step === 'verify' && (
            <form onSubmit={handleVerify} className="px-5 sm:px-6 py-6 space-y-5" noValidate>
              {error && <Notice kind={error.paid ? 'success' : 'error'}>{error.text}</Notice>}

              <div>
                <label htmlFor="invoiceNumber" className="block text-sm font-medium text-gray-700 mb-1">
                  Invoice Reference Number
                </label>
                <input
                  id="invoiceNumber"
                  type="text"
                  autoComplete="off"
                  maxLength={21}
                  value={invoiceNumber}
                  onChange={(e) => setInvoiceNumber(e.target.value)}
                  className={inputClass} 
                  required 
                />
                <p className="text-xs text-gray-500 mt-1">Shown on the invoice we emailed you. </p>
              </div>

              <div>
                <label htmlFor="identifier" className="block text-sm font-medium text-gray-700 mb-1">
                  Email Address or Customer Name
                </label>
                <input
                  id="identifier"
                  type="text"
                  autoComplete="email"
                  maxLength={254}
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  placeholder="The email the invoice was sent to"
                  className={inputClass}
                  required
                />
              </div>

              {SITE_KEY ? (
                <HCaptcha
                  ref={captchaRef}
                  siteKey={SITE_KEY}
                  onVerify={setCaptchaToken}
                  onExpire={() => setCaptchaToken('')}
                  onError={() => setCaptchaToken('')}
                />
              ) : (
                <p className="text-xs text-red-600">Verification is not configured (missing hCaptcha site key).</p>
              )}

              <button
                type="submit"
                disabled={!canVerify}
                className="w-full rounded-lg bg-eb-green-800 hover:bg-eb-green-900 text-white text-sm font-600 py-3 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? 'Verifying…' : 'Verify Invoice'}
              </button>
            </form>
          )}

          {/* ── Step 2: payer details + terms ── */}
          {step === 'details' && invoice && (
            <form onSubmit={handleContinue} className="px-5 sm:px-6 py-6 space-y-4" noValidate>
              {error && <Notice kind="error">{error.text}</Notice>}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="firstName" className="block text-sm font-medium text-gray-700 mb-1">First Name</label>
                  <input id="firstName" autoComplete="given-name" maxLength={100} value={firstName}
                    onChange={(e) => setFirstName(e.target.value)} className={inputClass} required />
                </div>
                <div>
                  <label htmlFor="lastName" className="block text-sm font-medium text-gray-700 mb-1">Last Name</label>
                  <input id="lastName" autoComplete="family-name" maxLength={100} value={lastName}
                    onChange={(e) => setLastName(e.target.value)} className={inputClass} required />
                </div>
              </div>
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">Email Address</label>
                <input id="email" type="email" autoComplete="email" maxLength={254} value={email}
                  onChange={(e) => setEmail(e.target.value)} className={inputClass} required />
              </div>
              <div>
                <label htmlFor="phone" className="block text-sm font-medium text-gray-700 mb-1">Phone Number</label>
                <input id="phone" type="tel" autoComplete="tel" maxLength={30} value={phone}
                  onChange={(e) => setPhone(e.target.value)} className={inputClass} required />
              </div>

              <label className="flex items-start gap-2.5 text-sm text-gray-700 pt-1">
                <input
                  type="checkbox"
                  checked={termsAccepted}
                  onChange={(e) => setTermsAccepted(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-eb-green-700 focus:ring-eb-green-700"
                />
                <span>
                  I agree to the EarnestBridge{' '}
                  <a href={PAYMENT_TERMS_URL} target="_blank" rel="noopener noreferrer" className="text-eb-green-700 underline">
                    Terms &amp; Conditions
                  </a>
                  .
                </span>
              </label>

              <button
                type="submit"
                disabled={!canContinue}
                className="w-full rounded-lg bg-eb-green-800 hover:bg-eb-green-900 text-white text-sm font-600 py-3 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? 'Preparing secure checkout…' : `Pay Now — ${formatMoney(invoice.amountDueCents, invoice.currency)}`}
              </button>
              <button
                type="button"
                onClick={() => startOver()}
                className="w-full rounded-lg border border-gray-300 text-sm font-600 text-gray-700 py-2.5 hover:bg-gray-50"
              >
                Pay a different invoice
              </button>
            </form>
          )}

          {/* ── Step 3: Coinflow card checkout ── */}
          {step === 'pay' && session && (
            <div className="px-5 sm:px-6 py-6 space-y-4">
              {error && <Notice kind="error">{error.text}</Notice>}
              <CoinflowCheckout session={session} onSuccess={handlePaymentSuccess} onDeclined={handleDeclined} />
              <p className="text-xs text-gray-500 text-center">
                Card details are processed securely by Coinflow and are never stored by EarnestBridge.
              </p>
            </div>
          )}

          {/* ── Step 4: result ── */}
          {step === 'result' && (
            <div className="px-5 sm:px-6 py-6 space-y-4">
              {result === 'processing' && (
                <Notice kind="info">
                  Your payment was approved and is being processed. Please do not pay again. We will email your receipt to {email} once it is complete.
                </Notice>
              )}
              {result === 'success' && (
                <Notice kind="success">
                  Payment successful{resultInfo.last4 ? ` (card ending ${resultInfo.last4})` : ''}. A receipt is being emailed to {email}. Thank you!
                </Notice>
              )}
              {result === 'declined' && (
                <>
                  <Notice kind="error">{resultInfo.message || 'Your payment could not be completed.'}</Notice>
                  <button
                    type="button"
                    onClick={() => startOver()}
                    className="w-full rounded-lg bg-eb-green-800 hover:bg-eb-green-900 text-white text-sm font-600 py-3"
                  >
                    Try again
                  </button>
                </>
              )}
              {result !== 'declined' && (
                <button
                  type="button"
                  onClick={payAnotherInvoice}
                  className="w-full rounded-lg border border-gray-300 text-sm font-600 text-gray-700 py-2.5 hover:bg-gray-50"
                >
                  Pay Another Invoice
                </button>
              )}
            </div>
          )}
        </div>

        <p className="text-center text-xs text-gray-400 mt-6">
          © {new Date().getFullYear()} EarnestBridge, LLC · Secure payment
        </p>
      </main>
    </div>
  );
}
