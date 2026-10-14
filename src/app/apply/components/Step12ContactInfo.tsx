'use client';
import React from 'react';
import { useForm } from 'react-hook-form';
import { ApplicationFormData } from './BorrowerApplicationForm';
import Icon from '@/components/ui/AppIcon';

interface Props {
  data: ApplicationFormData;
  onComplete: (updates: Partial<ApplicationFormData>) => void;
}

type FormValues = Pick<ApplicationFormData, 'firstName' | 'lastName' | 'email' | 'phone' | 'agreedToTerms'>;

export default function Step12ContactInfo({ data, onComplete }: Props) {
  const { register, handleSubmit, formState: { errors } } = useForm<FormValues>({
    defaultValues: {
      firstName: data.firstName,
      lastName: data.lastName,
      email: data.email,
      phone: data.phone,
      agreedToTerms: data.agreedToTerms,
    },
  });

  const onSubmit = (values: FormValues) => {
    onComplete(values);
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <div className="px-6 py-5 border-b border-gray-100">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-eb-green-900/10 flex items-center justify-center">
            <Icon name="UserIcon" size={18} className="text-eb-green-800" />
          </div>
          <div>
            <h2 className="font-display font-700 text-gray-900 text-base">Contact Information</h2>
            <p className="text-xs text-gray-500 mt-0.5">Step 1.2 — Tell us about yourself</p>
          </div>
        </div>
      </div>

      <div className="px-6 py-6 space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">First Name <span className="text-red-500">*</span></label>
            <input
              type="text"
              placeholder="Marcus"
              className={`w-full px-3.5 py-2.5 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 ${errors.firstName ? 'border-red-400 bg-red-50' : 'border-gray-300 hover:border-gray-400'}`}
              {...register('firstName', { required: 'First name is required' })}
            />
            {errors.firstName && <p className="mt-1 text-xs text-red-600 flex items-center gap-1"><Icon name="ExclamationCircleIcon" size={12} />{errors.firstName.message}</p>}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Last Name <span className="text-red-500">*</span></label>
            <input
              type="text"
              placeholder="Reid"
              className={`w-full px-3.5 py-2.5 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 ${errors.lastName ? 'border-red-400 bg-red-50' : 'border-gray-300 hover:border-gray-400'}`}
              {...register('lastName', { required: 'Last name is required' })}
            />
            {errors.lastName && <p className="mt-1 text-xs text-red-600 flex items-center gap-1"><Icon name="ExclamationCircleIcon" size={12} />{errors.lastName.message}</p>}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Email Address <span className="text-red-500">*</span></label>
          <input
            type="email"
            placeholder="you@company.com"
            className={`w-full px-3.5 py-2.5 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 ${errors.email ? 'border-red-400 bg-red-50' : 'border-gray-300 hover:border-gray-400'}`}
            {...register('email', {
              required: 'Email is required',
              pattern: { value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: 'Enter a valid email' },
            })}
          />
          {errors.email && <p className="mt-1 text-xs text-red-600 flex items-center gap-1"><Icon name="ExclamationCircleIcon" size={12} />{errors.email.message}</p>}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1.5">Phone Number <span className="text-red-500">*</span></label>
          <input
            type="tel"
            placeholder="+1 (555) 000-0000"
            className={`w-full px-3.5 py-2.5 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 ${errors.phone ? 'border-red-400 bg-red-50' : 'border-gray-300 hover:border-gray-400'}`}
            {...register('phone', { required: 'Phone number is required' })}
          />
          {errors.phone && <p className="mt-1 text-xs text-red-600 flex items-center gap-1"><Icon name="ExclamationCircleIcon" size={12} />{errors.phone.message}</p>}
        </div>

        <div className={`flex items-start gap-3 p-4 rounded-xl border ${errors.agreedToTerms ? 'border-red-300 bg-red-50' : 'border-gray-200 bg-gray-50'}`}>
          <input
            id="terms"
            type="checkbox"
            className="mt-0.5 w-4 h-4 rounded border-gray-300 accent-eb-green-900 cursor-pointer flex-shrink-0"
            {...register('agreedToTerms', { required: 'You must agree to the Terms & Conditions' })}
          />
          <label htmlFor="terms" className="text-sm text-gray-700 cursor-pointer leading-relaxed">
            I agree to the{' '}
            <a href="https://earnestbridge.com/terms" target="_blank" rel="noopener noreferrer" className="text-eb-green-800 underline hover:text-eb-green-900">
              Terms & Conditions
            </a>{' '}
            and{' '}
            <a href="https://earnestbridge.com/privacy-policy" target="_blank" rel="noopener noreferrer" className="text-eb-green-800 underline hover:text-eb-green-900">
              Privacy Policy
            </a>{' '}
            of EarnestBridge.
          </label>
        </div>
        {errors.agreedToTerms && <p className="text-xs text-red-600 flex items-center gap-1"><Icon name="ExclamationCircleIcon" size={12} />{errors.agreedToTerms.message}</p>}
      </div>

      <div className="px-6 py-4 bg-gray-50 border-t border-gray-100 flex justify-end">
        <button
          type="submit"
          className="flex items-center gap-2 px-6 py-2.5 bg-eb-green-900 text-white text-sm font-600 rounded-lg hover:bg-eb-green-800 transition-colors"
        >
          Continue
          <Icon name="ArrowRightIcon" size={15} />
        </button>
      </div>
    </form>
  );
}
