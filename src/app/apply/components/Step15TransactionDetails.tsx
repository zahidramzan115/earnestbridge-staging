'use client';
import React from 'react';
import { useForm } from 'react-hook-form';
import { ApplicationFormData } from './BorrowerApplicationForm';
import Icon from '@/components/ui/AppIcon';

interface Props {
  data: ApplicationFormData;
  onComplete: (updates: Partial<ApplicationFormData>) => void;
  onBack: () => void;
}

type FormValues = Pick<ApplicationFormData,
  'transactionDescription' | 'llcName' | 'llcState' | 'llcEin' | 'attorneyName' | 'attorneyEmail' | 'attorneyPhone' | 'attorneyFirm'
>;

const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'];

export default function Step15TransactionDetails({ data, onComplete, onBack }: Props) {
  const { register, handleSubmit, formState: { errors } } = useForm<FormValues>({
    defaultValues: {
      transactionDescription: data.transactionDescription,
      llcName: data.llcName,
      llcState: data.llcState,
      llcEin: data.llcEin,
      attorneyName: data.attorneyName,
      attorneyEmail: data.attorneyEmail,
      attorneyPhone: data.attorneyPhone,
      attorneyFirm: data.attorneyFirm,
    },
  });

  const onSubmit = (values: FormValues) => onComplete(values);

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <div className="px-6 py-5 border-b border-gray-100">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-eb-green-900/10 flex items-center justify-center">
            <Icon name="DocumentTextIcon" size={18} className="text-eb-green-800" />
          </div>
          <div>
            <h2 className="font-display font-700 text-gray-900 text-base">Transaction, LLC & Attorney Details</h2>
            <p className="text-xs text-gray-500 mt-0.5">Step 1.5 — Provide deal structure and legal contacts</p>
          </div>
        </div>
      </div>

      <div className="px-6 py-6 space-y-6">
        {/* Transaction */}
        <div>
          <h3 className="text-xs font-700 font-display uppercase tracking-widest text-eb-green-800 mb-3">Transaction Overview</h3>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Transaction Description <span className="text-red-500">*</span></label>
            <textarea
              rows={3}
              placeholder="Briefly describe the transaction — property type, deal strategy, timeline, and any relevant context..."
              className={`w-full px-3.5 py-2.5 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 resize-none ${errors.transactionDescription ? 'border-red-400 bg-red-50' : 'border-gray-300 hover:border-gray-400'}`}
              {...register('transactionDescription', { required: 'Transaction description is required' })}
            />
            {errors.transactionDescription && <p className="mt-1 text-xs text-red-600 flex items-center gap-1"><Icon name="ExclamationCircleIcon" size={12} />{errors.transactionDescription.message}</p>}
          </div>
        </div>

        {/* LLC */}
        <div>
          <h3 className="text-xs font-700 font-display uppercase tracking-widest text-eb-green-800 mb-3">LLC Information</h3>
          <p className="text-xs text-gray-500 mb-3">If an LLC has already been formed for this transaction, provide the details below. Leave blank if not yet formed.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">LLC Name</label>
              <input
                type="text"
                placeholder="Reid Capital Holdings LLC"
                className="w-full px-3.5 py-2.5 text-sm border border-gray-300 rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 hover:border-gray-400"
                {...register('llcName')}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">State of Formation</label>
              <select
                className="w-full px-3.5 py-2.5 text-sm border border-gray-300 rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 bg-white hover:border-gray-400"
                {...register('llcState')}
              >
                <option value="">Select state...</option>
                {US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1.5">EIN (if available)</label>
              <input
                type="text"
                placeholder="XX-XXXXXXX"
                className="w-full px-3.5 py-2.5 text-sm border border-gray-300 rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 hover:border-gray-400"
                {...register('llcEin')}
              />
            </div>
          </div>
        </div>

        {/* Attorney */}
        <div>
          <h3 className="text-xs font-700 font-display uppercase tracking-widest text-eb-green-800 mb-3">Attorney Contact</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Attorney Name <span className="text-red-500">*</span></label>
              <input
                type="text"
                placeholder="Jane Smith, Esq."
                className={`w-full px-3.5 py-2.5 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 ${errors.attorneyName ? 'border-red-400 bg-red-50' : 'border-gray-300 hover:border-gray-400'}`}
                {...register('attorneyName', { required: 'Attorney name is required' })}
              />
              {errors.attorneyName && <p className="mt-1 text-xs text-red-600 flex items-center gap-1"><Icon name="ExclamationCircleIcon" size={12} />{errors.attorneyName.message}</p>}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Law Firm <span className="text-red-500">*</span></label>
              <input
                type="text"
                placeholder="Smith & Associates"
                className={`w-full px-3.5 py-2.5 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 ${errors.attorneyFirm ? 'border-red-400 bg-red-50' : 'border-gray-300 hover:border-gray-400'}`}
                {...register('attorneyFirm', { required: 'Law firm is required' })}
              />
              {errors.attorneyFirm && <p className="mt-1 text-xs text-red-600 flex items-center gap-1"><Icon name="ExclamationCircleIcon" size={12} />{errors.attorneyFirm.message}</p>}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Attorney Email <span className="text-red-500">*</span></label>
              <input
                type="email"
                placeholder="jsmith@smithlaw.com"
                className={`w-full px-3.5 py-2.5 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 ${errors.attorneyEmail ? 'border-red-400 bg-red-50' : 'border-gray-300 hover:border-gray-400'}`}
                {...register('attorneyEmail', {
                  required: 'Attorney email is required',
                  pattern: { value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: 'Enter a valid email' },
                })}
              />
              {errors.attorneyEmail && <p className="mt-1 text-xs text-red-600 flex items-center gap-1"><Icon name="ExclamationCircleIcon" size={12} />{errors.attorneyEmail.message}</p>}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1.5">Attorney Phone <span className="text-red-500">*</span></label>
              <input
                type="tel"
                placeholder="+1 (555) 000-0000"
                className={`w-full px-3.5 py-2.5 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 ${errors.attorneyPhone ? 'border-red-400 bg-red-50' : 'border-gray-300 hover:border-gray-400'}`}
                {...register('attorneyPhone', { required: 'Attorney phone is required' })}
              />
              {errors.attorneyPhone && <p className="mt-1 text-xs text-red-600 flex items-center gap-1"><Icon name="ExclamationCircleIcon" size={12} />{errors.attorneyPhone.message}</p>}
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
