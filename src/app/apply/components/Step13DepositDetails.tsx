'use client';
import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { ApplicationFormData } from './BorrowerApplicationForm';
import Icon from '@/components/ui/AppIcon';

interface Props {
  data: ApplicationFormData;
  onComplete: (updates: Partial<ApplicationFormData>) => void;
  onBack: () => void;
}

type FormValues = Pick<ApplicationFormData, 'companyName' | 'companyType' | 'propertyAddress' | 'propertyType' | 'dueDiligenceDays'>;

const PROPERTY_TYPES = ['Multifamily', 'Office', 'Retail', 'Industrial', 'Mixed-Use', 'Land', 'Hotel/Hospitality', 'Self-Storage', 'Other'];
const COMPANY_TYPES = ['LLC', 'LP', 'Corporation', 'Partnership', 'Sole Proprietorship', 'Trust', 'Other'];

function formatWithCommas(value: string): string {
  const digits = value.replace(/[^0-9]/g, '');
  if (!digits) return '';
  return Number(digits).toLocaleString('en-US');
}

function parseNumber(formatted: string): string {
  return formatted.replace(/,/g, '');
}

export default function Step13DepositDetails({ data, onComplete, onBack }: Props) {
  const [depositDisplay, setDepositDisplay] = useState<string>(
    data.depositAmount ? Number(data.depositAmount).toLocaleString('en-US') : ''
  );
  const [purchaseDisplay, setPurchaseDisplay] = useState<string>(
    data.purchasePrice ? Number(data.purchasePrice).toLocaleString('en-US') : ''
  );
  const [depositError, setDepositError] = useState('');
  const [purchaseError, setPurchaseError] = useState('');

  const { register, handleSubmit, formState: { errors } } = useForm<FormValues>({
    defaultValues: {
      companyName: data.companyName,
      companyType: data.companyType,
      propertyAddress: data.propertyAddress,
      propertyType: data.propertyType,
      dueDiligenceDays: data.dueDiligenceDays,
    },
  });

  const onSubmit = (values: FormValues) => {
    let valid = true;
    if (!depositDisplay) { setDepositError('Deposit amount is required'); valid = false; } else { setDepositError(''); }
    if (!purchaseDisplay) { setPurchaseError('Purchase price is required'); valid = false; } else { setPurchaseError(''); }
    if (!valid) return;

    onComplete({
      ...values,
      depositAmount: parseNumber(depositDisplay) as unknown as number,
      purchasePrice: parseNumber(purchaseDisplay) as unknown as number,
    });
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <div className="px-6 py-5 border-b border-gray-100">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-eb-green-900/10 flex items-center justify-center">
            <Icon name="BuildingOfficeIcon" size={18} className="text-eb-green-800" />
          </div>
          <div>
            <h2 className="font-display font-700 text-gray-900 text-base">Deposit, Company & Property Details</h2>
            <p className="text-xs text-gray-500 mt-0.5">Step 1.3 — Tell us about your deal</p>
          </div>
        </div>
      </div>

      <div className="px-6 py-6 space-y-6">
        {/* Deposit Section */}
        <div>
          <h3 className="text-xs font-700 font-display uppercase tracking-widest text-eb-green-800 mb-3">Deposit Information</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">EMD Amount ($) <span className="text-red-500">*</span></label>
              <input
                type="text"
                inputMode="numeric"
                placeholder="250,000"
                value={depositDisplay}
                onChange={e => {
                  setDepositDisplay(formatWithCommas(e.target.value));
                  setDepositError('');
                }}
                className={`w-full px-3.5 py-2.5 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 ${depositError ? 'border-red-400 bg-red-50' : 'border-gray-300 hover:border-gray-400'}`}
              />
              {depositError && <p className="mt-1 text-xs text-red-600 flex items-center gap-1"><Icon name="ExclamationCircleIcon" size={12} />{depositError}</p>}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Purchase Price ($) <span className="text-red-500">*</span></label>
              <input
                type="text"
                inputMode="numeric"
                placeholder="5,000,000"
                value={purchaseDisplay}
                onChange={e => {
                  setPurchaseDisplay(formatWithCommas(e.target.value));
                  setPurchaseError('');
                }}
                className={`w-full px-3.5 py-2.5 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 ${purchaseError ? 'border-red-400 bg-red-50' : 'border-gray-300 hover:border-gray-400'}`}
              />
              {purchaseError && <p className="mt-1 text-xs text-red-600 flex items-center gap-1"><Icon name="ExclamationCircleIcon" size={12} />{purchaseError}</p>}
            </div>
          </div>
        </div>

        {/* Company Section */}
        <div>
          <h3 className="text-xs font-700 font-display uppercase tracking-widest text-eb-green-800 mb-3">Company Information</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Company Name <span className="text-red-500">*</span></label>
              <input
                type="text"
                placeholder="Reid Capital Group"
                className={`w-full px-3.5 py-2.5 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 ${errors.companyName ? 'border-red-400 bg-red-50' : 'border-gray-300 hover:border-gray-400'}`}
                {...register('companyName', { required: 'Company name is required' })}
              />
              {errors.companyName && <p className="mt-1 text-xs text-red-600 flex items-center gap-1"><Icon name="ExclamationCircleIcon" size={12} />{errors.companyName.message}</p>}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Company Type <span className="text-red-500">*</span></label>
              <select
                className={`w-full px-3.5 py-2.5 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 bg-white ${errors.companyType ? 'border-red-400 bg-red-50' : 'border-gray-300 hover:border-gray-400'}`}
                {...register('companyType', { required: 'Company type is required' })}
              >
                <option value="">Select type...</option>
                {COMPANY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              {errors.companyType && <p className="mt-1 text-xs text-red-600 flex items-center gap-1"><Icon name="ExclamationCircleIcon" size={12} />{errors.companyType.message}</p>}
            </div>
          </div>
        </div>

        {/* Property Section */}
        <div>
          <h3 className="text-xs font-700 font-display uppercase tracking-widest text-eb-green-800 mb-3">Property Information</h3>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Property Address <span className="text-red-500">*</span></label>
              <input
                type="text"
                placeholder="123 Main St, Atlanta, GA 30301"
                className={`w-full px-3.5 py-2.5 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 ${errors.propertyAddress ? 'border-red-400 bg-red-50' : 'border-gray-300 hover:border-gray-400'}`}
                {...register('propertyAddress', { required: 'Property address is required' })}
              />
              {errors.propertyAddress && <p className="mt-1 text-xs text-red-600 flex items-center gap-1"><Icon name="ExclamationCircleIcon" size={12} />{errors.propertyAddress.message}</p>}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Property Type <span className="text-red-500">*</span></label>
                <select
                  className={`w-full px-3.5 py-2.5 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 bg-white ${errors.propertyType ? 'border-red-400 bg-red-50' : 'border-gray-300 hover:border-gray-400'}`}
                  {...register('propertyType', { required: 'Property type is required' })}
                >
                  <option value="">Select type...</option>
                  {PROPERTY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
                {errors.propertyType && <p className="mt-1 text-xs text-red-600 flex items-center gap-1"><Icon name="ExclamationCircleIcon" size={12} />{errors.propertyType.message}</p>}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  How many days is your due diligence period? <span className="text-red-500">*</span>
                  <span
                    className="inline-flex align-middle ml-1.5 text-gray-400 hover:text-eb-green-800 cursor-help"
                    title="We only support refundable deposits during due diligence period."
                    aria-label="We only support refundable deposits during due diligence period."
                    tabIndex={0}
                    role="img"
                  >
                    <Icon name="InformationCircleIcon" size={15} />
                  </span>
                </label>
                <input
                  type="number"
                  min={1}
                  max={999}
                  step={1}
                  inputMode="numeric"
                  placeholder="e.g. 30"
                  title="We only support refundable deposits during due diligence period."
                  className={`w-full sm:w-40 px-3.5 py-2.5 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 ${errors.dueDiligenceDays ? 'border-red-400 bg-red-50' : 'border-gray-300 hover:border-gray-400'}`}
                  {...register('dueDiligenceDays', {
                    validate: (value) => {
                      const v = String(value ?? '').trim();
                      if (!/^\d+$/.test(v)) return 'Enter a due diligence period between 1 and 999 days.';
                      const n = parseInt(v, 10);
                      return (n >= 1 && n <= 999) || 'Enter a due diligence period between 1 and 999 days.';
                    },
                  })}
                />
                <p className="mt-1 text-xs text-gray-500">Calendar days</p>
                {errors.dueDiligenceDays && <p className="mt-1 text-xs text-red-600 flex items-center gap-1"><Icon name="ExclamationCircleIcon" size={12} />{errors.dueDiligenceDays.message}</p>}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="px-6 py-4 bg-gray-50 border-t border-gray-100 flex justify-between">
        <button type="button" onClick={onBack} className="flex items-center gap-2 px-5 py-2.5 border border-gray-300 text-gray-700 text-sm font-600 rounded-lg hover:bg-gray-100 transition-colors">
          <Icon name="ArrowLeftIcon" size={15} /> Back
        </button>
        <button type="submit" className="flex items-center gap-2 px-6 py-2.5 bg-eb-green-900 text-white text-sm font-600 rounded-lg hover:bg-eb-green-800 transition-colors">
          Continue <Icon name="ArrowRightIcon" size={15} />
        </button>
      </div>
    </form>
  );
}
