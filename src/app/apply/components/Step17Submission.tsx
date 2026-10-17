'use client';
import React from 'react';
import { ApplicationFormData } from './BorrowerApplicationForm';
import Icon from '@/components/ui/AppIcon';

interface Props {
  data: ApplicationFormData;
  onSubmit: () => void;
  onBack: () => void;
  isSubmitting: boolean;
  submitError: string;
}

const formatCurrency = (val: string) => {
  const n = parseFloat(val);
  if (isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
};

interface ReviewRowProps { label: string; value: string | undefined | null; }
function ReviewRow({ label, value }: ReviewRowProps) {
  return (
    <div className="flex justify-between items-start py-2 border-b border-gray-100 last:border-0">
      <span className="text-xs text-gray-500 flex-shrink-0 w-40">{label}</span>
      <span className="text-xs font-600 text-gray-900 text-right">{value || '—'}</span>
    </div>
  );
}

interface ReviewSectionProps { title: string; icon: string; children: React.ReactNode; }
function ReviewSection({ title, icon, children }: ReviewSectionProps) {
  return (
    <div className="rounded-xl border border-gray-200 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 bg-gray-50 border-b border-gray-200">
        <Icon name={icon as Parameters<typeof Icon>[0]['name']} size={15} className="text-eb-green-800" />
        <span className="text-xs font-700 font-display uppercase tracking-widest text-eb-green-800">{title}</span>
      </div>
      <div className="px-4 py-1">{children}</div>
    </div>
  );
}

export default function Step17Submission({ data, onSubmit, onBack, isSubmitting, submitError }: Props) {
  return (
    <div>
      <div className="px-6 py-5 border-b border-gray-100">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-eb-green-900/10 flex items-center justify-center">
            <Icon name="PaperAirplaneIcon" size={18} className="text-eb-green-800" />
          </div>
          <div>
            <h2 className="font-display font-700 text-gray-900 text-base">Review & Submit</h2>
            <p className="text-xs text-gray-500 mt-0.5">Step 1.6 — Review your application before submitting</p>
          </div>
        </div>
      </div>

      <div className="px-6 py-6 space-y-4">
        {/* Processing Notice */}
        <div className="p-4 rounded-xl bg-eb-green-900/5 border border-eb-green-900/20 flex gap-3">
          <Icon name="ClockIcon" size={18} className="text-eb-green-800 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-600 text-eb-green-900">Processing within 24 business hours</p>
            <p className="text-xs text-eb-green-700 mt-0.5">Once submitted, our team will review your application and reach out to schedule an introductory call.</p>
          </div>
        </div>

        {/* Review Sections */}
        <ReviewSection title="Contact Information" icon="UserIcon">
          <ReviewRow label="Full Name" value={`${data.firstName} ${data.lastName}`} />
          <ReviewRow label="Email" value={data.email} />
          <ReviewRow label="Phone" value={data.phone} />
          <ReviewRow label="Terms Agreed" value={data.agreedToTerms ? 'Yes' : 'No'} />
        </ReviewSection>

        <ReviewSection title="Deposit & Property" icon="BuildingOfficeIcon">
          <ReviewRow label="EMD Amount" value={formatCurrency(data.depositAmount)} />
          <ReviewRow label="Purchase Price" value={formatCurrency(data.purchasePrice)} />
          <ReviewRow label="Company" value={`${data.companyName}${data.companyType ? ` (${data.companyType})` : ''}`} />
          <ReviewRow label="Property Address" value={data.propertyAddress} />
          <ReviewRow label="Property Type" value={data.propertyType} />
          <ReviewRow label="Due Diligence Period" value={data.dueDiligenceDays ? `${data.dueDiligenceDays} Days` : '—'} />
        </ReviewSection>

        <ReviewSection title="Documents" icon="DocumentArrowUpIcon">
          <ReviewRow label="LOI (Required)" value={data.loiFileName || 'Not uploaded'} />
          <ReviewRow label="PSA (Optional)" value={data.psaFileName || 'Not uploaded'} />
        </ReviewSection>

        <ReviewSection title="Identity Verification" icon="ShieldCheckIcon">
          <ReviewRow label="Status" value={data.identityVerified ? 'Verified ✓' : 'Not verified'} />
        </ReviewSection>

        {submitError && (
          <div className="p-4 rounded-xl bg-red-50 border border-red-200 flex gap-3">
            <Icon name="ExclamationCircleIcon" size={18} className="text-red-600 flex-shrink-0" />
            <p className="text-sm text-red-700">{submitError}</p>
          </div>
        )}
      </div>

      <div className="px-6 py-4 bg-gray-50 border-t border-gray-100 flex justify-between items-center">
        <button type="button" onClick={onBack} disabled={isSubmitting} className="flex items-center gap-2 px-5 py-2.5 border border-gray-300 text-gray-700 text-sm font-600 rounded-lg hover:bg-gray-100 transition-colors disabled:opacity-50">
          <Icon name="ArrowLeftIcon" size={15} /> Back
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={isSubmitting}
          className="flex items-center gap-2 px-7 py-2.5 bg-eb-green-900 text-white text-sm font-700 rounded-lg hover:bg-eb-green-800 transition-colors disabled:opacity-60"
        >
          {isSubmitting ? (
            <><Icon name="ArrowPathIcon" size={15} className="animate-spin" /> Submitting...</>
          ) : (
            <><Icon name="PaperAirplaneIcon" size={15} /> Submit Application</>
          )}
        </button>
      </div>
    </div>
  );
}
