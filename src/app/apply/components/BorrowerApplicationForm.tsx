'use client';
import React, { useState, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '../../../lib/supabase/client';
import { useAuth } from '../../../contexts/AuthContext';
import Icon from '@/components/ui/AppIcon';
import Step12ContactInfo from './Step12ContactInfo';
import Step13DepositDetails from './Step13DepositDetails';
import Step14PSAUpload from './Step14PSAUpload';
import Step16IdentityVerification from './Step16IdentityVerification';
import Step17Submission from './Step17Submission';

export interface ApplicationFormData {
  // Step 1.2
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  agreedToTerms: boolean;
  // Step 1.3
  depositAmount: string;
  companyName: string;
  companyType: string;
  propertyAddress: string;
  propertyType: string;
  purchasePrice: string;
  dueDiligenceDays: string;
  // Step 1.4
  loiFile: File | null;
  loiFileName: string;
  loiFileUrl: string;
  psaFile: File | null;
  psaFileName: string;
  psaFileUrl: string;
  // Step 1.5 (was 1.6)
  identityMethod: 'questions' | 'text_code' | 'id_selfie' | '';
  identityVerified: boolean;
}

const INITIAL_DATA: ApplicationFormData = {
  firstName: '', lastName: '', email: '', phone: '', agreedToTerms: false,
  depositAmount: '', companyName: '', companyType: '', propertyAddress: '',
  propertyType: '', purchasePrice: '', dueDiligenceDays: '',
  loiFile: null, loiFileName: '', loiFileUrl: '',
  psaFile: null, psaFileName: '', psaFileUrl: '',
  identityMethod: '', identityVerified: false,
};

const STEPS = [
  { id: 1, label: 'Contact Info' },
  { id: 2, label: 'Deposit & Property' },
  { id: 3, label: 'Document Upload' },
  { id: 4, label: 'Identity Verification' },
  { id: 5, label: 'Review & Submit' },
];

export default function BorrowerApplicationForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading: authLoading } = useAuth();
  const [currentStep, setCurrentStep] = useState(1);
  const [formData, setFormData] = useState<ApplicationFormData>(INITIAL_DATA);
  const [applicationId, setApplicationId] = useState<string | null>(null);
  const applicationIdRef = React.useRef<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loadingDraft, setLoadingDraft] = useState(false);

  // Load existing draft if ?draft=<id> is in the URL
  useEffect(() => {
    const draftId = searchParams?.get('draft');
    if (!draftId) return;

    const loadDraft = async () => {
      setLoadingDraft(true);
      try {
        const supabase = createClient();
        const { data, error } = await supabase
          .from('borrower_applications')
          .select('*')
          .eq('id', draftId)
          .single();

        if (error || !data) return;

        setApplicationId(data.id);
        applicationIdRef.current = data.id;
        setFormData({
          firstName: data.first_name || '',
          lastName: data.last_name || '',
          email: data.email || '',
          phone: data.phone || '',
          agreedToTerms: data.agreed_to_terms || false,
          depositAmount: data.deposit_amount ? String(data.deposit_amount) : '',
          companyName: data.company_name || '',
          companyType: data.company_type || '',
          propertyAddress: data.property_address || '',
          propertyType: data.property_type || '',
          purchasePrice: data.purchase_price ? String(data.purchase_price) : '',
          dueDiligenceDays: data.due_diligence_days ? String(data.due_diligence_days) : '',
          loiFile: null,
          loiFileName: data.loi_file_name || '',
          loiFileUrl: data.loi_file_url || '',
          psaFile: null,
          psaFileName: data.psa_file_name || '',
          psaFileUrl: data.psa_file_url || '',
          identityMethod: data.identity_method || '',
          identityVerified: data.identity_verified || false,
        });

        // Determine which step to resume at based on filled data
        if (data.identity_method) setCurrentStep(4);
        else if (data.loi_file_url || data.psa_file_url) setCurrentStep(3);
        else if (data.property_address) setCurrentStep(2);
        else if (data.first_name) setCurrentStep(2);
        else setCurrentStep(1);
      } finally {
        setLoadingDraft(false);
      }
    };

    loadDraft();
  }, [searchParams]);

  const updateFormData = (updates: Partial<ApplicationFormData>) => {
    setFormData(prev => ({ ...prev, ...updates }));
  };

  const goNext = () => setCurrentStep(s => Math.min(s + 1, 5));
  const goBack = () => setCurrentStep(s => Math.max(s - 1, 1));

  const buildPayload = (data: ApplicationFormData) => ({
    user_id: user?.id,
    first_name: data.firstName,
    last_name: data.lastName,
    email: data.email,
    phone: data.phone,
    agreed_to_terms: data.agreedToTerms,
    deposit_amount: data.depositAmount ? parseFloat(data.depositAmount) : null,
    company_name: data.companyName || null,
    company_type: data.companyType || null,
    property_address: data.propertyAddress || null,
    property_type: data.propertyType || null,
    purchase_price: data.purchasePrice ? parseFloat(data.purchasePrice) : null,
    due_diligence_days: data.dueDiligenceDays ? parseInt(data.dueDiligenceDays, 10) : null,
    loi_file_url: data.loiFileUrl || null,
    loi_file_name: data.loiFileName || null,
    psa_file_url: data.psaFileUrl || null,
    psa_file_name: data.psaFileName || null,
    identity_method: data.identityMethod || null,
    identity_verified: data.identityVerified,
    app_status: 'draft' as const,
  });

  const saveProgress = async (data: ApplicationFormData, stepReached: number) => {
    const supabase = createClient();
    let currentUser = user;
    if (!currentUser) {
      const { data: { user: liveUser } } = await supabase.auth.getUser();
      currentUser = liveUser;
    }
    if (!currentUser) return;

    const payload = { ...buildPayload(data), user_id: currentUser.id };

    if (applicationIdRef.current) {
      await supabase.from('borrower_applications').update(payload).eq('id', applicationIdRef.current);
    } else {
      const { data: inserted } = await supabase
        .from('borrower_applications')
        .insert(payload)
        .select('id')
        .single();
      if (inserted?.id) {
        applicationIdRef.current = inserted.id;
        setApplicationId(inserted.id);
      }
    }
  };

  const handleSaveAsDraft = async () => {
    setIsSavingDraft(true);
    setDraftSaved(false);
    try {
      await saveProgress(formData, currentStep);
      setDraftSaved(true);
      setTimeout(() => setDraftSaved(false), 3000);
    } catch {
      // silent fail
    } finally {
      setIsSavingDraft(false);
    }
  };

  const handleStepComplete = async (updates: Partial<ApplicationFormData>) => {
    const merged = { ...formData, ...updates };
    setFormData(merged);
    await saveProgress(merged, currentStep);
    goNext();
  };

  const handleFinalSubmit = async () => {
    setIsSubmitting(true);
    setSubmitError('');
    try {
      const supabase = createClient();

      // Use getUser() for live server-side verification (not getSession which reads stale local storage)
      let currentUser = user;
      if (!currentUser) {
        const { data: { user: liveUser }, error: userError } = await supabase.auth.getUser();
        if (userError || !liveUser) throw new Error('Not authenticated. Please sign in and try again.');
        currentUser = liveUser;
      }

      // Save progress first to ensure we have an applicationId
      if (!applicationIdRef.current) {
        await saveProgress(formData, 5);
      }

      const finalAppId = applicationIdRef.current;
      if (!finalAppId) throw new Error('Failed to create application record. Please try again.');

      const { error } = await supabase
        .from('borrower_applications')
        .update({ app_status: 'submitted', submitted_at: new Date().toISOString() })
        .eq('id', finalAppId)
        .eq('user_id', currentUser.id);

      if (error) throw new Error(error.message);

      // ── AUTO-LINK to existing CRM Contact (idempotent) ──────────────
      // If this portal user already has an approved CRM Contact, link the
      // new deal to it automatically. Runs server-side; failure is non-fatal.
      try {
        await fetch('/api/admin/link-deal-crm-contact', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ applicationId: finalAppId }),
        });
      } catch {
        // CRM linkage failure must never block deal submission
      }

      // Save LOI file via server-side API (bypasses RLS)
      if (formData.loiFile && finalAppId && currentUser) {
        try {
          const loiFormData = new FormData();
          loiFormData.append('file', formData.loiFile);
          loiFormData.append('applicationId', finalAppId);
          loiFormData.append('userId', currentUser.id);
          loiFormData.append('documentName', formData.loiFileName || formData.loiFile.name.replace(/\.[^.]+$/, ''));
          loiFormData.append('documentType', 'loi');
          loiFormData.append('category', 'legal');
          const loiRes = await fetch('/api/upload-document', { method: 'PUT', body: loiFormData });
          const loiJson = await loiRes.json();
          if (loiJson.fileUrl) {
            await supabase.from('borrower_applications').update({ loi_file_url: loiJson.fileUrl }).eq('id', finalAppId);
          }
        } catch {
          // LOI document save failure should not block submission
        }
      }

      // Save PSA file via server-side API (bypasses RLS)
      if (formData.psaFile && finalAppId && currentUser) {
        try {
          const psaFormData = new FormData();
          psaFormData.append('file', formData.psaFile);
          psaFormData.append('applicationId', finalAppId);
          psaFormData.append('userId', currentUser.id);
          psaFormData.append('documentName', formData.psaFileName || formData.psaFile.name.replace(/\.[^.]+$/, ''));
          psaFormData.append('documentType', 'psa');
          psaFormData.append('category', 'legal');
          const psaRes = await fetch('/api/upload-document', { method: 'PUT', body: psaFormData });
          const psaJson = await psaRes.json();
          if (psaJson.fileUrl) {
            await supabase.from('borrower_applications').update({ psa_file_url: psaJson.fileUrl }).eq('id', finalAppId);
          }
        } catch {
          // PSA document save failure should not block submission
        }
      }

      // Send application submission confirmation email via edge function
      try {
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
        const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
        if (supabaseUrl && supabaseAnonKey) {
          const edgeFnUrl = `${supabaseUrl}/functions/v1/send-borrower-emails`;
          const edgeHeaders = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${supabaseAnonKey}`,
          };
          const ddParsed = formData.dueDiligenceDays ? parseInt(formData.dueDiligenceDays, 10) : null;
          const dueDiligenceDays = ddParsed !== null && Number.isInteger(ddParsed) && ddParsed >= 1 && ddParsed <= 999 ? ddParsed : null;
          const borrowerPayload = {
            emailType: 'application_submitted',
            borrower: {
              firstName: formData.firstName,
              lastName: formData.lastName,
              email: formData.email,
            },
            application: {
              propertyAddress: formData.propertyAddress,
              depositAmount: formData.depositAmount,
              purchasePrice: formData.purchasePrice,
              dueDiligenceDays,
            },
          };
          const adminPayload = {
            emailType: 'admin_new_application',
            borrower: {
              firstName: formData.firstName,
              lastName: formData.lastName,
              email: formData.email,
              phone: formData.phone,
              companyName: formData.companyName,
            },
            application: {
              propertyAddress: formData.propertyAddress,
              propertyType: formData.propertyType,
              depositAmount: formData.depositAmount,
              purchasePrice: formData.purchasePrice,
              dueDiligenceDays,
            },
          };
          await Promise.allSettled([
            fetch(edgeFnUrl, { method: 'POST', headers: edgeHeaders, body: JSON.stringify(borrowerPayload) }),
            fetch(edgeFnUrl, { method: 'POST', headers: edgeHeaders, body: JSON.stringify(adminPayload) }),
          ]);
        }
      } catch {
        // Email failure should not block submission success
      }

      setSubmitted(true);
    } catch (err: any) {
      setSubmitError(err.message || 'Submission failed. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (loadingDraft) {
    return (
      <div className="max-w-3xl mx-auto py-20 flex flex-col items-center gap-4">
        <div className="w-10 h-10 border-2 border-eb-green-900 border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-gray-500">Loading your draft application…</p>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="max-w-2xl mx-auto py-16 text-center">
        <div className="w-20 h-20 rounded-full bg-eb-green-900/10 flex items-center justify-center mx-auto mb-6">
          <Icon name="CheckCircleIcon" size={48} className="text-eb-green-700" />
        </div>
        <h2 className="font-display text-2xl font-700 text-gray-900 mb-3">Application Submitted!</h2>
        <p className="text-gray-500 mb-2">Your EMD financing application has been received.</p>
        <p className="text-gray-500 mb-8">Our team will review it and respond within <span className="font-600 text-eb-green-800">24 business hours</span>.</p>
        <div className="flex gap-3 justify-center">
          <button
            onClick={() => router.push('/application-status')}
            className="px-6 py-2.5 bg-eb-green-900 text-white text-sm font-600 rounded-lg hover:bg-eb-green-800 transition-colors"
          >
            View Application Status
          </button>
          <button
            onClick={() => router.push('/dashboard-home')}
            className="px-6 py-2.5 border border-gray-300 text-gray-700 text-sm font-600 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Go to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center justify-between gap-2 mb-1">
          <span className="text-xs font-display font-600 uppercase tracking-widest text-eb-gold-600 border border-eb-gold-400/30 bg-eb-gold-400/10 px-2.5 py-0.5 rounded-full">
            EMD Financing Application
          </span>
          {/* Save as Draft button */}
          <button
            onClick={handleSaveAsDraft}
            disabled={isSavingDraft}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-600 rounded-lg border transition-all ${
              draftSaved
                ? 'bg-emerald-50 border-emerald-300 text-emerald-700' :'bg-white border-gray-200 text-gray-600 hover:border-eb-green-900/40 hover:text-eb-green-900'
            } disabled:opacity-60`}
          >
            {isSavingDraft ? (
              <>
                <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
                Saving…
              </>
            ) : draftSaved ? (
              <>
                <Icon name="CheckIcon" size={12} />
                Draft Saved
              </>
            ) : (
              <>
                <Icon name="BookmarkIcon" size={12} />
                Save as Draft
              </>
            )}
          </button>
        </div>
        <h1 className="font-display text-2xl font-700 text-gray-900 mt-2">
          {applicationId ? 'Resume Application' : 'New Application'}
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          {applicationId
            ? 'Your progress has been saved. Complete all steps to submit.'
            : 'Complete all steps to submit your EMD financing request.'}
        </p>
      </div>

      {/* Step Progress */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-display font-600 text-gray-700">
            Step {currentStep} of {STEPS.length} — {STEPS[currentStep - 1]?.label}
          </span>
          <span className="text-sm font-display font-700 text-eb-green-900 tabular-nums">
            {Math.round(((currentStep - 1) / (STEPS.length - 1)) * 100)}%
          </span>
        </div>
        <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-eb-green-900 rounded-full transition-all duration-300"
            style={{ width: `${Math.round(((currentStep - 1) / (STEPS.length - 1)) * 100)}%` }}
          />
        </div>
      </div>

      {/* Step Content */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        {currentStep === 1 && (
          <Step12ContactInfo
            data={formData}
            onComplete={handleStepComplete}
          />
        )}
        {currentStep === 2 && (
          <Step13DepositDetails
            data={formData}
            onComplete={handleStepComplete}
            onBack={goBack}
          />
        )}
        {currentStep === 3 && (
          <Step14PSAUpload
            data={formData}
            onComplete={handleStepComplete}
            onBack={goBack}
          />
        )}
        {currentStep === 4 && (
          <Step16IdentityVerification
            data={formData}
            onComplete={handleStepComplete}
            onBack={goBack}
          />
        )}
        {currentStep === 5 && (
          <Step17Submission
            data={formData}
            onSubmit={handleFinalSubmit}
            onBack={goBack}
            isSubmitting={isSubmitting}
            submitError={submitError}
          />
        )}
      </div>
    </div>
  );
}
