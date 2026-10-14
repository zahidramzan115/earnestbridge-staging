'use client';
import React, { useState } from 'react';
import { ApplicationFormData } from './BorrowerApplicationForm';
import Icon from '@/components/ui/AppIcon';

interface Props {
  data: ApplicationFormData;
  onComplete: (updates: Partial<ApplicationFormData>) => void;
  onBack: () => void;
}

export default function Step16IdentityVerification({ data, onComplete, onBack }: Props) {
  // Text code state
  const [textCode, setTextCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [codeVerified, setCodeVerified] = useState(false);

  // ID + Selfie state
  const [idFile, setIdFile] = useState<File | null>(null);
  const [selfieFile, setSelfieFile] = useState<File | null>(null);
  const [idSelfieVerified, setIdSelfieVerified] = useState(false);

  const [error, setError] = useState('');
  const [codeError, setCodeError] = useState('');
  const [loading, setLoading] = useState<'code' | 'id' | null>(null);

  const bothVerified = codeVerified && idSelfieVerified;

  const sendCode = async () => {
    setLoading('code');
    setCodeError('');
    await new Promise(r => setTimeout(r, 800));
    setLoading(null);
    setCodeSent(true);
  };

  const verifyCode = async () => {
    if (textCode.length < 4) {
      setCodeError('Please enter the verification code.');
      return;
    }
    setCodeError('');
    setLoading('code');
    await new Promise(r => setTimeout(r, 1000));
    setLoading(null);
    setCodeVerified(true);
  };

  const verifyIdSelfie = async () => {
    if (!idFile || !selfieFile) {
      setError('Please upload both your ID and a selfie.');
      return;
    }
    setError('');
    setLoading('id');
    await new Promise(r => setTimeout(r, 1200));
    setLoading(null);
    setIdSelfieVerified(true);
  };

  const handleContinue = () => {
    if (!codeVerified || !idSelfieVerified) {
      const missing: string[] = [];
      if (!codeVerified) missing.push('text code verification');
      if (!idSelfieVerified) missing.push('ID + selfie verification');
      setError(`Please complete: ${missing.join(' and ')}.`);
      return;
    }
    setError('');
    onComplete({ identityMethod: 'text_code', identityVerified: true });
  };

  return (
    <div>
      <div className="px-6 py-5 border-b border-gray-100">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-eb-green-900/10 flex items-center justify-center">
            <Icon name="ShieldCheckIcon" size={18} className="text-eb-green-800" />
          </div>
          <div>
            <h2 className="font-display font-700 text-gray-900 text-base">Identity Verification</h2>
            <p className="text-xs text-gray-500 mt-0.5">Step 1.5 — Both steps below are required to proceed</p>
          </div>
        </div>
      </div>

      <div className="px-6 py-6 space-y-6">
        {/* Progress indicators */}
        <div className="flex gap-3">
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-600 border ${codeVerified ? 'bg-green-50 border-green-200 text-green-700' : 'bg-gray-50 border-gray-200 text-gray-500'}`}>
            {codeVerified
              ? <Icon name="CheckCircleIcon" size={13} className="text-green-600" />
              : <Icon name="DevicePhoneMobileIcon" size={13} />}
            Text Code
          </div>
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-600 border ${idSelfieVerified ? 'bg-green-50 border-green-200 text-green-700' : 'bg-gray-50 border-gray-200 text-gray-500'}`}>
            {idSelfieVerified
              ? <Icon name="CheckCircleIcon" size={13} className="text-green-600" />
              : <Icon name="IdentificationIcon" size={13} />}
            ID + Selfie
          </div>
        </div>

        {/* Step 1: Text Code */}
        <div className={`rounded-xl border-2 p-5 transition-all ${codeVerified ? 'border-green-200 bg-green-50/40' : 'border-gray-200'}`}>
          <div className="flex items-center gap-2 mb-3">
            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-700 ${codeVerified ? 'bg-green-500 text-white' : 'bg-eb-green-900 text-white'}`}>
              {codeVerified ? <Icon name="CheckIcon" size={12} /> : '1'}
            </div>
            <h3 className="text-sm font-700 font-display text-gray-900">Text Code Verification</h3>
            <span className="ml-auto text-xs text-red-500 font-600">Required</span>
          </div>

          {codeVerified ? (
            <div className="flex items-center gap-2 text-sm text-green-700">
              <Icon name="CheckCircleIcon" size={16} className="text-green-600" />
              Verification code confirmed successfully.
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-gray-600">
                We will send a 6-digit code to <span className="font-600 text-gray-900">{data.phone || 'your phone'}</span>
              </p>
              {!codeSent ? (
                <button
                  type="button"
                  onClick={sendCode}
                  disabled={loading === 'code'}
                  className="w-full py-2.5 border-2 border-eb-green-900 text-eb-green-900 text-sm font-600 rounded-lg hover:bg-eb-green-900/5 transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
                >
                  {loading === 'code'
                    ? <><Icon name="ArrowPathIcon" size={15} className="animate-spin" /> Sending...</>
                    : <><Icon name="DevicePhoneMobileIcon" size={15} /> Send Verification Code</>}
                </button>
              ) : (
                <div className="space-y-3">
                  <div className="p-3 rounded-lg bg-green-50 border border-green-200 flex items-center gap-2">
                    <Icon name="CheckCircleIcon" size={16} className="text-green-600" />
                    <p className="text-sm text-green-700">Code sent! Check your messages.</p>
                  </div>
                  <input
                    type="text"
                    placeholder="Enter 6-digit code"
                    maxLength={6}
                    className={`w-full px-3.5 py-2.5 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 text-center tracking-widest text-lg font-700 ${codeError ? 'border-red-400 bg-red-50' : 'border-gray-300'}`}
                    value={textCode}
                    onChange={e => { setTextCode(e.target.value.replace(/\D/g, '')); setCodeError(''); }}
                  />
                  {codeError && (
                    <p className="text-xs text-red-600 flex items-center gap-1">
                      <Icon name="ExclamationCircleIcon" size={12} /> {codeError}
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={verifyCode}
                    disabled={loading === 'code' || textCode.length < 4}
                    className="w-full py-2.5 bg-eb-green-900 text-white text-sm font-600 rounded-lg hover:bg-eb-green-800 transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
                  >
                    {loading === 'code'
                      ? <><Icon name="ArrowPathIcon" size={15} className="animate-spin" /> Verifying...</>
                      : 'Verify Code'}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Step 2: ID + Selfie */}
        <div className={`rounded-xl border-2 p-5 transition-all ${idSelfieVerified ? 'border-green-200 bg-green-50/40' : 'border-gray-200'}`}>
          <div className="flex items-center gap-2 mb-3">
            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-700 ${idSelfieVerified ? 'bg-green-500 text-white' : 'bg-eb-green-900 text-white'}`}>
              {idSelfieVerified ? <Icon name="CheckIcon" size={12} /> : '2'}
            </div>
            <h3 className="text-sm font-700 font-display text-gray-900">ID + Selfie Upload</h3>
            <span className="ml-auto text-xs text-red-500 font-600">Required</span>
          </div>

          {idSelfieVerified ? (
            <div className="flex items-center gap-2 text-sm text-green-700">
              <Icon name="CheckCircleIcon" size={16} className="text-green-600" />
              ID and selfie submitted successfully.
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {[
                  { label: 'Government-Issued ID', key: 'id' as const, hint: "Driver's license, passport, or state ID", file: idFile, setFile: setIdFile },
                  { label: 'Selfie Photo', key: 'selfie' as const, hint: 'Clear photo of your face', file: selfieFile, setFile: setSelfieFile },
                ].map(item => (
                  <div key={item.key}>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">{item.label} <span className="text-red-500">*</span></label>
                    <label className={`flex flex-col items-center justify-center gap-2 p-5 border-2 border-dashed rounded-xl cursor-pointer transition-all
                      ${item.file ? 'border-eb-green-600 bg-eb-green-900/5' : 'border-gray-300 hover:border-eb-green-600 hover:bg-gray-50'}`}>
                      <input
                        type="file"
                        accept="image/*,.pdf"
                        className="hidden"
                        onChange={e => { const f = e.target.files?.[0]; if (f) { item.setFile(f); setError(''); } }}
                      />
                      {item.file ? (
                        <>
                          <Icon name="CheckCircleIcon" size={22} className="text-eb-green-700" />
                          <span className="text-xs font-600 text-eb-green-800 text-center truncate max-w-full">{item.file.name}</span>
                        </>
                      ) : (
                        <>
                          <Icon name="PhotoIcon" size={22} className="text-gray-400" />
                          <span className="text-xs text-gray-500 text-center">{item.hint}</span>
                        </>
                      )}
                    </label>
                  </div>
                ))}
              </div>
              {error && (
                <p className="text-xs text-red-600 flex items-center gap-1">
                  <Icon name="ExclamationCircleIcon" size={12} /> {error}
                </p>
              )}
              <button
                type="button"
                onClick={verifyIdSelfie}
                disabled={loading === 'id' || !idFile || !selfieFile}
                className="w-full py-2.5 bg-eb-green-900 text-white text-sm font-600 rounded-lg hover:bg-eb-green-800 transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
              >
                {loading === 'id'
                  ? <><Icon name="ArrowPathIcon" size={15} className="animate-spin" /> Submitting...</>
                  : 'Submit for Verification'}
              </button>
            </div>
          )}
        </div>

        {/* All verified banner */}
        {bothVerified && (
          <div className="flex flex-col items-center py-4 gap-3">
            <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center">
              <Icon name="ShieldCheckIcon" size={30} className="text-green-600" />
            </div>
            <div className="text-center">
              <p className="font-display font-700 text-gray-900">Identity Verified</p>
              <p className="text-sm text-gray-500 mt-0.5">Both verification steps are complete. You may proceed.</p>
            </div>
          </div>
        )}

        {error && !codeError && (
          <p className="text-xs text-red-600 flex items-center gap-1">
            <Icon name="ExclamationCircleIcon" size={12} /> {error}
          </p>
        )}
      </div>

      <div className="px-6 py-4 bg-gray-50 border-t border-gray-100 flex justify-between">
        <button type="button" onClick={onBack} className="flex items-center gap-2 px-5 py-2.5 border border-gray-300 text-gray-700 text-sm font-600 rounded-lg hover:bg-gray-100 transition-colors">
          <Icon name="ArrowLeftIcon" size={15} /> Back
        </button>
        <button
          type="button"
          onClick={handleContinue}
          disabled={!bothVerified}
          className="flex items-center gap-2 px-6 py-2.5 bg-eb-green-900 text-white text-sm font-600 rounded-lg hover:bg-eb-green-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Continue <Icon name="ArrowRightIcon" size={15} />
        </button>
      </div>
    </div>
  );
}
