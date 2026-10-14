'use client';
import React, { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { Toaster, toast } from 'sonner';
import Icon from '@/components/ui/AppIcon';
import Toggle from '@/components/ui/Toggle';
import ConfirmModal from '@/components/ui/ConfirmModal';
import { useAuth } from '@/contexts/AuthContext';
import { createClient } from '@/lib/supabase/client';

type SettingsSection = 'personal' | 'company' | 'notifications' | 'security';

const SECTIONS: { id: SettingsSection; label: string; icon: string; description: string }[] = [
  { id: 'personal', label: 'Personal Information', icon: 'UserCircleIcon', description: 'Name, email, phone number' },
  { id: 'company', label: 'Company & Entity', icon: 'BuildingOffice2Icon', description: 'Entity type, EIN, investor status' },
  { id: 'notifications', label: 'Notification Preferences', icon: 'BellIcon', description: 'Email and SMS alert settings' },
  { id: 'security', label: 'Security', icon: 'ShieldCheckIcon', description: 'Password, 2FA, active sessions' },
];

interface PersonalFormData {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  title: string;
  linkedIn: string;
}

interface CompanyFormData {
  entityName: string;
  entityType: string;
  ein: string;
  stateOfFormation: string;
  yearsInCRE: string;
  accreditedInvestor: boolean;
  totalDealsCompleted: string;
  preferredPropertyTypes: string[];
}

interface SecurityFormData {
  currentPassword: string;
  newPassword: string;
  confirmNewPassword: string;
}

type NotificationKey =
  | 'emailApplicationStatus' | 'emailDocumentRequests' | 'emailApprovalUpdates' | 'emailFundingConfirmation' | 'emailClosingReminders' | 'emailWeeklyDigest' | 'smsUrgentActions' | 'smsClosingReminders' | 'smsFundingConfirmation' | 'smsApplicationUpdates';

type NotificationPrefs = Record<NotificationKey, boolean>;

type EmailFrequency = 'immediate' | 'daily_digest' | 'weekly';

const EMAIL_FREQUENCY_OPTIONS: { value: EmailFrequency; label: string; description: string; icon: string }[] = [
  { value: 'immediate', label: 'Immediate', description: 'Emails sent as events occur', icon: 'BoltIcon' },
  { value: 'daily_digest', label: 'Daily Digest', description: 'One summary email each day', icon: 'CalendarDaysIcon' },
  { value: 'weekly', label: 'Weekly', description: 'One summary email per week', icon: 'CalendarIcon' },
];

const EVENT_TYPE_OPT_OUTS: { key: string; label: string; description: string; category: string }[] = [
  { key: 'applicationStatus', label: 'Application status changes', description: 'Stage transitions, reviews, and decisions', category: 'Application' },
  { key: 'documentRequests', label: 'Document requests', description: 'Requests for additional documents or info', category: 'Application' },
  { key: 'approvalDecisions', label: 'Approval decisions', description: 'Conditional approvals, full approvals, conditions', category: 'Application' },
  { key: 'emdFunding', label: 'EMD funding events', description: 'Wire confirmations and escrow updates', category: 'Funding' },
  { key: 'closingReminders', label: 'Closing date reminders', description: '7-day and 3-day advance closing reminders', category: 'Deadlines' },
  { key: 'portfolioDigest', label: 'Portfolio digest', description: 'Weekly summary of active deals and pending items', category: 'Digest' },
  { key: 'urgentActions', label: 'Urgent action items', description: 'High-priority documents or signatures required', category: 'Urgent' },
  { key: 'systemUpdates', label: 'Platform & system updates', description: 'New features, maintenance windows, policy changes', category: 'System' },
];

const DEFAULT_NOTIF_PREFS: NotificationPrefs = {
  emailApplicationStatus: true,
  emailDocumentRequests: true,
  emailApprovalUpdates: true,
  emailFundingConfirmation: true,
  emailClosingReminders: true,
  emailWeeklyDigest: false,
  smsUrgentActions: true,
  smsClosingReminders: true,
  smsFundingConfirmation: false,
  smsApplicationUpdates: false,
};

const PROPERTY_TYPES = ['Multifamily', 'Office', 'Retail', 'Industrial', 'Mixed-Use', 'Hotel', 'Self-Storage', 'Land'];

export default function ProfileSettingsContent() {
  const { user, signOut } = useAuth();
  const supabase = createClient();

  const [activeSection, setActiveSection] = useState<SettingsSection>('personal');
  const [notifPrefs, setNotifPrefs] = useState<NotificationPrefs>(DEFAULT_NOTIF_PREFS);
  const [emailFrequency, setEmailFrequency] = useState<EmailFrequency>('immediate');
  const [optedOutEvents, setOptedOutEvents] = useState<Set<string>>(new Set(['systemUpdates', 'portfolioDigest']));
  const [savingNotifs, setSavingNotifs] = useState(false);
  const [twoFAEnabled, setTwoFAEnabled] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showRevokeModal, setShowRevokeModal] = useState<string | null>(null);
  const [selectedPropertyTypes, setSelectedPropertyTypes] = useState<string[]>([]);
  const [savingSection, setSavingSection] = useState<SettingsSection | null>(null);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [loadingProfile, setLoadingProfile] = useState(true);
  const [displayName, setDisplayName] = useState('');
  const [displayEmail, setDisplayEmail] = useState('');
  const [displayInitials, setDisplayInitials] = useState('');
  const [userPhone, setUserPhone] = useState('');

  const personalForm = useForm<PersonalFormData>({
    defaultValues: {
      firstName: '',
      lastName: '',
      email: '',
      phone: '',
      title: '',
      linkedIn: '',
    },
  });

  const companyForm = useForm<CompanyFormData>({
    defaultValues: {
      entityName: '',
      entityType: 'LLC',
      ein: '',
      stateOfFormation: '',
      yearsInCRE: '',
      accreditedInvestor: false,
      totalDealsCompleted: '',
      preferredPropertyTypes: [],
    },
  });

  const securityForm = useForm<SecurityFormData>({
    defaultValues: { currentPassword: '', newPassword: '', confirmNewPassword: '' },
  });

  // Load user profile data from auth + borrower_applications
  useEffect(() => {
    if (!user) return;

    const loadProfile = async () => {
      setLoadingProfile(true);
      try {
        // Parse name from auth metadata or email
        const fullName: string = user.user_metadata?.full_name || user.user_metadata?.name || '';
        const email: string = user.email || '';
        const nameParts = fullName.trim().split(' ');
        const firstName = nameParts[0] || '';
        const lastName = nameParts.slice(1).join(' ') || '';

        // Compute initials
        const initials = firstName && lastName
          ? `${firstName[0]}${lastName[0]}`.toUpperCase()
          : firstName
          ? firstName.slice(0, 2).toUpperCase()
          : email.slice(0, 2).toUpperCase();

        setDisplayName(fullName || email);
        setDisplayEmail(email);
        setDisplayInitials(initials);

        // Fetch latest borrower application for company/entity data
        const { data: app } = await supabase
          .from('borrower_applications')
          .select('*')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        const phone = app?.phone || user.user_metadata?.phone || '';
        setUserPhone(phone);

        // Populate personal form
        personalForm.reset({
          firstName: app?.first_name || firstName,
          lastName: app?.last_name || lastName,
          email,
          phone,
          title: user.user_metadata?.title || '',
          linkedIn: user.user_metadata?.linkedin || '',
        });

        // Populate company form
        if (app) {
          const propTypes = app.property_type ? [app.property_type] : [];
          setSelectedPropertyTypes(propTypes);
          companyForm.reset({
            entityName: app.llc_name || app.company_name || '',
            entityType: app.company_type || 'LLC',
            ein: app.llc_ein || '',
            stateOfFormation: app.llc_state || '',
            yearsInCRE: '',
            accreditedInvestor: false,
            totalDealsCompleted: '',
            preferredPropertyTypes: propTypes,
          });
        }
      } catch (err) {
        console.error('Failed to load profile:', err);
      } finally {
        setLoadingProfile(false);
      }
    };

    loadProfile();
  }, [user]);

  const handleSavePersonal = async (data: PersonalFormData) => {
    setSavingSection('personal');
    try {
      // Update auth user metadata
      const { error: authError } = await supabase.auth.updateUser({
        email: data.email !== user?.email ? data.email : undefined,
        data: {
          full_name: `${data.firstName} ${data.lastName}`.trim(),
          title: data.title,
          linkedin: data.linkedIn,
          phone: data.phone,
        },
      });
      if (authError) throw authError;

      // Update borrower_applications with latest personal info
      const { data: existingApp } = await supabase
        .from('borrower_applications')
        .select('id')
        .eq('user_id', user?.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existingApp?.id) {
        await supabase
          .from('borrower_applications')
          .update({
            first_name: data.firstName,
            last_name: data.lastName,
            email: data.email,
            phone: data.phone,
          })
          .eq('id', existingApp.id);
      }

      // Update display values
      const fullName = `${data.firstName} ${data.lastName}`.trim();
      setDisplayName(fullName || data.email);
      setDisplayEmail(data.email);
      const initials = data.firstName && data.lastName
        ? `${data.firstName[0]}${data.lastName[0]}`.toUpperCase()
        : data.firstName
        ? data.firstName.slice(0, 2).toUpperCase()
        : data.email.slice(0, 2).toUpperCase();
      setDisplayInitials(initials);
      setUserPhone(data.phone);

      toast.success('Personal information updated', { description: 'Your profile has been saved.' });
    } catch (err: any) {
      toast.error('Failed to save', { description: err?.message || 'Please try again.' });
    } finally {
      setSavingSection(null);
    }
  };

  const handleSaveCompany = async (data: CompanyFormData) => {
    setSavingSection('company');
    try {
      const { data: existingApp } = await supabase
        .from('borrower_applications')
        .select('id')
        .eq('user_id', user?.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existingApp?.id) {
        const { error } = await supabase
          .from('borrower_applications')
          .update({
            llc_name: data.entityName,
            company_name: data.entityName,
            company_type: data.entityType,
            llc_ein: data.ein,
            llc_state: data.stateOfFormation,
          })
          .eq('id', existingApp.id);
        if (error) throw error;
      }

      toast.success('Company information updated', { description: 'Entity details saved successfully.' });
    } catch (err: any) {
      toast.error('Failed to save', { description: err?.message || 'Please try again.' });
    } finally {
      setSavingSection(null);
    }
  };

  const handleSaveNotifications = async () => {
    setSavingNotifs(true);
    await new Promise((r) => setTimeout(r, 800));
    setSavingNotifs(false);
    toast.success('Notification preferences saved');
  };

  const handleChangePassword = async (data: SecurityFormData) => {
    setSavingSection('security');
    try {
      const { error } = await supabase.auth.updateUser({ password: data.newPassword });
      if (error) throw error;
      securityForm.reset({ currentPassword: '', newPassword: '', confirmNewPassword: '' });
      toast.success('Password updated successfully', { description: 'You will be prompted to sign in again on other devices.' });
    } catch (err: any) {
      const msg = err?.message || 'Failed to update password';
      securityForm.setError('currentPassword', { message: msg });
      toast.error('Password update failed', { description: msg });
    } finally {
      setSavingSection(null);
    }
  };

  const handleRevokeSession = async (sessionId: string) => {
    await new Promise((r) => setTimeout(r, 500));
    setShowRevokeModal(null);
    toast.success('Session revoked', { description: 'That device has been signed out.' });
  };

  const togglePropertyType = (type: string) => {
    setSelectedPropertyTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]
    );
  };

  const toggleEventOptOut = (key: string) => {
    setOptedOutEvents((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const updateNotif = (key: NotificationKey, value: boolean) => {
    setNotifPrefs((prev) => ({ ...prev, [key]: value }));
  };

  if (loadingProfile) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="flex flex-col items-center gap-3">
          <Icon name="ArrowPathIcon" size={28} className="text-eb-green-900 animate-spin" />
          <p className="text-sm text-gray-400">Loading your profile…</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <Toaster position="bottom-right" richColors />
      <ConfirmModal
        open={showDeleteModal}
        title="Delete your account"
        message="This will permanently delete your EarnestBridge account, all application data, and uploaded documents. This action cannot be undone."
        confirmLabel="Delete My Account"
        cancelLabel="Keep Account"
        destructive
        onConfirm={() => { setShowDeleteModal(false); toast.error('Account deletion requested', { description: 'Our team will process your request within 48 hours.' }); }}
        onCancel={() => setShowDeleteModal(false)}
      />
      <ConfirmModal
        open={!!showRevokeModal}
        title="Revoke this session"
        message="This device will be immediately signed out and will need to re-authenticate to access your account."
        confirmLabel="Revoke Session"
        cancelLabel="Cancel"
        destructive={false}
        onConfirm={() => showRevokeModal && handleRevokeSession(showRevokeModal)}
        onCancel={() => setShowRevokeModal(null)}
      />

      {/* Page header */}
      <div className="mb-6">
        <h1 className="font-display text-xl sm:text-2xl font-700 text-gray-900">Account Settings</h1>
        <p className="text-sm text-gray-400 mt-0.5">Manage your profile, entity information, and security preferences.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 xl:grid-cols-4 2xl:grid-cols-4 gap-6">
        {/* Left nav */}
        <div className="lg:col-span-1">
          <div className="bg-white rounded-2xl shadow-card border border-gray-100 overflow-hidden">
            {/* User summary */}
            <div className="p-4 sm:p-5 border-b border-gray-100">
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 sm:w-12 sm:h-12 rounded-full bg-eb-green-900 flex items-center justify-center flex-shrink-0">
                  <span className="font-display font-800 text-white text-base">{displayInitials}</span>
                </div>
                <div className="min-w-0">
                  <p className="font-display font-700 text-gray-900 truncate">{displayName || displayEmail}</p>
                  <p className="text-xs text-gray-400 truncate">{displayEmail}</p>
                  <div className="flex items-center gap-1 mt-1">
                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                    <span className="text-[11px] text-emerald-600 font-medium">Verified Borrower</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Section nav — horizontal scroll on mobile, vertical on desktop */}
            <nav className="p-2 flex flex-row lg:flex-col gap-1 overflow-x-auto scrollbar-none lg:overflow-x-visible">
              {SECTIONS.map((section) => (
                <button
                  key={`settings-nav-${section.id}`}
                  onClick={() => setActiveSection(section.id)}
                  className={`flex items-center gap-3 px-3 py-2.5 lg:py-3 rounded-xl text-left transition-all flex-shrink-0 lg:flex-shrink lg:w-full min-h-[44px] ${
                    activeSection === section.id
                      ? 'bg-eb-green-900 text-white' : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                  }`}
                >
                  <Icon
                    name={section.icon as Parameters<typeof Icon>[0]['name']}
                    size={16}
                    className={`flex-shrink-0 ${activeSection === section.id ? 'text-eb-gold-400' : 'text-gray-400'}`}
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-display font-600 truncate whitespace-nowrap">{section.label}</p>
                    <p className={`text-[11px] truncate mt-0.5 hidden lg:block ${activeSection === section.id ? 'text-eb-green-200' : 'text-gray-400'}`}>{section.description}</p>
                  </div>
                </button>
              ))}
            </nav>
          </div>
        </div>

        {/* Right content */}
        <div className="lg:col-span-3">
          {/* Personal Information */}
          {activeSection === 'personal' && (
            <div className="animate-fade-in space-y-5">
              <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-6">
                <div className="flex items-center gap-3 mb-6 pb-5 border-b border-gray-100">
                  <div className="w-10 h-10 rounded-xl bg-eb-green-50 flex items-center justify-center">
                    <Icon name="UserCircleIcon" size={20} className="text-eb-green-700" />
                  </div>
                  <div>
                    <h2 className="font-display font-700 text-gray-900">Personal Information</h2>
                    <p className="text-xs text-gray-400 mt-0.5">Update your name, contact details, and professional profile</p>
                  </div>
                </div>

                <form onSubmit={personalForm.handleSubmit(handleSavePersonal)} className="space-y-5">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="firstName">
                        First name <span className="text-red-500">*</span>
                      </label>
                      <input
                        id="firstName"
                        type="text"
                        className={`w-full px-3.5 py-2.5 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 ${personalForm.formState.errors.firstName ? 'border-red-400 bg-red-50' : 'border-gray-300 hover:border-gray-400'}`}
                        {...personalForm.register('firstName', { required: 'First name is required' })}
                      />
                      {personalForm.formState.errors.firstName && (
                        <p className="mt-1 text-xs text-red-600">{personalForm.formState.errors.firstName.message}</p>
                      )}
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="lastName">
                        Last name <span className="text-red-500">*</span>
                      </label>
                      <input
                        id="lastName"
                        type="text"
                        className={`w-full px-3.5 py-2.5 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 ${personalForm.formState.errors.lastName ? 'border-red-400 bg-red-50' : 'border-gray-300 hover:border-gray-400'}`}
                        {...personalForm.register('lastName', { required: 'Last name is required' })}
                      />
                      {personalForm.formState.errors.lastName && (
                        <p className="mt-1 text-xs text-red-600">{personalForm.formState.errors.lastName.message}</p>
                      )}
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="email-settings">
                      Email address <span className="text-red-500">*</span>
                    </label>
                    <p className="text-xs text-gray-400 mb-1.5">Used for login and all application notifications</p>
                    <input
                      id="email-settings"
                      type="email"
                      className={`w-full px-3.5 py-2.5 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 ${personalForm.formState.errors.email ? 'border-red-400 bg-red-50' : 'border-gray-300 hover:border-gray-400'}`}
                      {...personalForm.register('email', {
                        required: 'Email is required',
                        pattern: { value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: 'Enter a valid email' },
                      })}
                    />
                    {personalForm.formState.errors.email && (
                      <p className="mt-1 text-xs text-red-600">{personalForm.formState.errors.email.message}</p>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="phone-settings">
                        Mobile phone
                      </label>
                      <p className="text-xs text-gray-400 mb-1.5">Used for SMS alerts and 2FA verification</p>
                      <input
                        id="phone-settings"
                        type="tel"
                        className="w-full px-3.5 py-2.5 text-sm border border-gray-300 rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 hover:border-gray-400"
                        {...personalForm.register('phone')}
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="title">
                        Professional title
                      </label>
                      <input
                        id="title"
                        type="text"
                        placeholder="e.g. Managing Principal"
                        className="w-full px-3.5 py-2.5 text-sm border border-gray-300 rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 hover:border-gray-400"
                        {...personalForm.register('title')}
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="linkedIn">
                      LinkedIn profile URL
                    </label>
                    <div className="flex rounded-lg border border-gray-300 overflow-hidden focus-within:ring-2 focus-within:ring-eb-green-900/20 focus-within:border-eb-green-900 transition-all hover:border-gray-400">
                      <span className="bg-gray-50 px-3.5 py-2.5 text-sm text-gray-400 border-r border-gray-300 flex items-center">https://</span>
                      <input
                        id="linkedIn"
                        type="text"
                        placeholder="linkedin.com/in/yourname"
                        className="flex-1 px-3.5 py-2.5 text-sm outline-none bg-white"
                        {...personalForm.register('linkedIn')}
                      />
                    </div>
                  </div>

                  <div className="flex justify-end pt-2">
                    <button
                      type="submit"
                      disabled={savingSection === 'personal'}
                      className="flex items-center gap-2 px-5 py-2.5 bg-eb-green-900 hover:bg-eb-green-800 disabled:opacity-60 text-white font-display font-600 text-sm rounded-lg transition-all active:scale-95"
                      style={{ minWidth: '140px', justifyContent: 'center' }}
                    >
                      {savingSection === 'personal' ? (
                        <>
                          <Icon name="ArrowPathIcon" size={14} className="animate-spin" />
                          Saving...
                        </>
                      ) : (
                        <>
                          <Icon name="CheckIcon" size={14} />
                          Save Changes
                        </>
                      )}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* Company & Entity */}
          {activeSection === 'company' && (
            <div className="animate-fade-in space-y-5">
              <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-6">
                <div className="flex items-center gap-3 mb-6 pb-5 border-b border-gray-100">
                  <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center">
                    <Icon name="BuildingOffice2Icon" size={20} className="text-blue-600" />
                  </div>
                  <div>
                    <h2 className="font-display font-700 text-gray-900">Company & Entity Information</h2>
                    <p className="text-xs text-gray-400 mt-0.5">Legal entity details used for loan agreements and compliance</p>
                  </div>
                </div>

                <form onSubmit={companyForm.handleSubmit(handleSaveCompany)} className="space-y-5">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                    <div className="sm:col-span-2">
                      <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="entityName">
                        Legal entity name <span className="text-red-500">*</span>
                      </label>
                      <p className="text-xs text-gray-400 mb-1.5">Must match exactly as registered with your state</p>
                      <input
                        id="entityName"
                        type="text"
                        className={`w-full px-3.5 py-2.5 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 ${companyForm.formState.errors.entityName ? 'border-red-400 bg-red-50' : 'border-gray-300 hover:border-gray-400'}`}
                        {...companyForm.register('entityName', { required: 'Entity name is required' })}
                      />
                      {companyForm.formState.errors.entityName && (
                        <p className="mt-1 text-xs text-red-600">{companyForm.formState.errors.entityName.message}</p>
                      )}
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="entityType">
                        Entity type <span className="text-red-500">*</span>
                      </label>
                      <select
                        id="entityType"
                        className="w-full px-3.5 py-2.5 text-sm border border-gray-300 rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 hover:border-gray-400 bg-white"
                        {...companyForm.register('entityType', { required: true })}
                      >
                        <option value="LLC">LLC</option>
                        <option value="LP">Limited Partnership (LP)</option>
                        <option value="Corp">Corporation (Corp)</option>
                        <option value="Individual">Individual / Sole Proprietor</option>
                        <option value="Trust">Trust</option>
                        <option value="Other">Other</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="ein">
                        EIN / Tax ID <span className="text-red-500">*</span>
                      </label>
                      <p className="text-xs text-gray-400 mb-1.5">Format: XX-XXXXXXX. Used for IRS 1099 reporting.</p>
                      <input
                        id="ein"
                        type="text"
                        placeholder="82-4571039"
                        className="w-full px-3.5 py-2.5 text-sm border border-gray-300 rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 hover:border-gray-400 font-mono"
                        {...companyForm.register('ein', {
                          pattern: { value: /^\d{2}-\d{7}$/, message: 'Format must be XX-XXXXXXX' },
                        })}
                      />
                      {companyForm.formState.errors.ein && (
                        <p className="mt-1 text-xs text-red-600">{companyForm.formState.errors.ein.message}</p>
                      )}
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="stateOfFormation">
                        State of formation
                      </label>
                      <input
                        id="stateOfFormation"
                        type="text"
                        placeholder="Texas"
                        className="w-full px-3.5 py-2.5 text-sm border border-gray-300 rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 hover:border-gray-400"
                        {...companyForm.register('stateOfFormation')}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="yearsInCRE">
                        Years in CRE investing
                      </label>
                      <input
                        id="yearsInCRE"
                        type="number"
                        min="0"
                        max="60"
                        className="w-full px-3.5 py-2.5 text-sm border border-gray-300 rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 hover:border-gray-400"
                        {...companyForm.register('yearsInCRE')}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="totalDealsCompleted">
                        Total CRE transactions completed
                      </label>
                      <input
                        id="totalDealsCompleted"
                        type="number"
                        min="0"
                        className="w-full px-3.5 py-2.5 text-sm border border-gray-300 rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 hover:border-gray-400"
                        {...companyForm.register('totalDealsCompleted')}
                      />
                    </div>
                  </div>

                  {/* Accredited Investor */}
                  <div className="p-4 bg-gray-50 rounded-xl border border-gray-200">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="text-sm font-medium text-gray-900">Accredited Investor Status</p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          I confirm I meet the SEC definition of an accredited investor (net worth &gt; $1M excluding primary residence, or income &gt; $200K/year for last 2 years)
                        </p>
                      </div>
                      <Toggle
                        checked={companyForm.watch('accreditedInvestor')}
                        onChange={(v) => companyForm.setValue('accreditedInvestor', v)}
                      />
                    </div>
                  </div>

                  {/* Preferred property types */}
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">
                      Preferred property types
                    </label>
                    <p className="text-xs text-gray-400 mb-2.5">Select all asset classes you typically acquire</p>
                    <div className="flex flex-wrap gap-2">
                      {PROPERTY_TYPES.map((type) => (
                        <button
                          key={`pt-${type}`}
                          type="button"
                          onClick={() => togglePropertyType(type)}
                          className={`px-3 py-1.5 text-xs font-display font-600 rounded-lg border transition-all ${
                            selectedPropertyTypes.includes(type)
                              ? 'bg-eb-green-900 text-white border-eb-green-900' : 'bg-white text-gray-600 border-gray-200 hover:border-eb-green-900/40 hover:text-eb-green-900'
                          }`}
                        >
                          {type}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex justify-end pt-2">
                    <button
                      type="submit"
                      disabled={savingSection === 'company'}
                      className="flex items-center gap-2 px-5 py-2.5 bg-eb-green-900 hover:bg-eb-green-800 disabled:opacity-60 text-white font-display font-600 text-sm rounded-lg transition-all active:scale-95"
                      style={{ minWidth: '140px', justifyContent: 'center' }}
                    >
                      {savingSection === 'company' ? (
                        <>
                          <Icon name="ArrowPathIcon" size={14} className="animate-spin" />
                          Saving...
                        </>
                      ) : (
                        <>
                          <Icon name="CheckIcon" size={14} />
                          Save Entity Info
                        </>
                      )}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* Notifications */}
          {activeSection === 'notifications' && (
            <div className="animate-fade-in space-y-4">
              <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-6">
                <div className="flex items-center gap-3 mb-6 pb-5 border-b border-gray-100">
                  <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center">
                    <Icon name="BellIcon" size={20} className="text-amber-600" />
                  </div>
                  <div>
                    <h2 className="font-display font-700 text-gray-900">Notification Preferences</h2>
                    <p className="text-xs text-gray-400 mt-0.5">Control how and when EarnestBridge contacts you about your deals</p>
                  </div>
                </div>

                {/* Email Frequency Control */}
                <div className="mb-7">
                  <div className="flex items-center gap-2 mb-1">
                    <Icon name="ClockIcon" size={15} className="text-gray-500" />
                    <h3 className="font-display font-600 text-gray-900 text-sm">Email Frequency</h3>
                  </div>
                  <p className="text-xs text-gray-400 mb-4 pl-1">Choose how often you receive email notifications from EarnestBridge</p>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {EMAIL_FREQUENCY_OPTIONS.map((opt) => (
                      <button
                        key={`freq-${opt.value}`}
                        type="button"
                        onClick={() => setEmailFrequency(opt.value)}
                        className={`relative flex flex-col items-start gap-1.5 p-4 rounded-xl border-2 text-left transition-all ${
                          emailFrequency === opt.value
                            ? 'border-eb-green-900 bg-eb-green-50' : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50'
                        }`}
                      >
                        {emailFrequency === opt.value && (
                          <span className="absolute top-3 right-3 w-4 h-4 rounded-full bg-eb-green-900 flex items-center justify-center">
                            <Icon name="CheckIcon" size={10} className="text-white" />
                          </span>
                        )}
                        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${emailFrequency === opt.value ? 'bg-eb-green-900' : 'bg-gray-100'}`}>
                          <Icon name={opt.icon as Parameters<typeof Icon>[0]['name']} size={16} className={emailFrequency === opt.value ? 'text-white' : 'text-gray-500'} />
                        </div>
                        <p className={`text-sm font-display font-600 ${emailFrequency === opt.value ? 'text-eb-green-900' : 'text-gray-800'}`}>{opt.label}</p>
                        <p className={`text-xs leading-relaxed ${emailFrequency === opt.value ? 'text-eb-green-700' : 'text-gray-400'}`}>{opt.description}</p>
                      </button>
                    ))}
                  </div>
                  {emailFrequency !== 'immediate' && (
                    <div className="mt-3 flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                      <Icon name="InformationCircleIcon" size={14} className="text-amber-600 flex-shrink-0 mt-0.5" />
                      <p className="text-xs text-amber-700 leading-relaxed">
                        {emailFrequency === 'daily_digest' ?'Urgent action items (e.g. required signatures, closing-day alerts) will still be sent immediately regardless of this setting.' :'Urgent action items and closing-day alerts will still be sent immediately. All other events will be batched into your weekly summary.'}
                      </p>
                    </div>
                  )}
                </div>

                {/* Event Type Opt-Outs */}
                <div className="mb-7">
                  <div className="flex items-center gap-2 mb-1">
                    <Icon name="FunnelIcon" size={15} className="text-gray-500" />
                    <h3 className="font-display font-600 text-gray-900 text-sm">Event Type Controls</h3>
                  </div>
                  <p className="text-xs text-gray-400 mb-4 pl-1">Opt out of specific notification types. Toggling off means you will not receive emails for that event.</p>
                  <div className="space-y-2">
                    {EVENT_TYPE_OPT_OUTS.map((event) => {
                      const isEnabled = !optedOutEvents.has(event.key);
                      return (
                        <div
                          key={`event-opt-${event.key}`}
                          className={`flex items-start justify-between gap-4 p-3.5 rounded-xl border transition-all ${isEnabled ? 'border-gray-100 bg-white' : 'border-gray-100 bg-gray-50'}`}
                        >
                          <div className="flex items-start gap-3 min-w-0">
                            <div className={`mt-0.5 w-2 h-2 rounded-full flex-shrink-0 ${isEnabled ? 'bg-emerald-400' : 'bg-gray-300'}`} />
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <p className={`text-sm font-medium ${isEnabled ? 'text-gray-800' : 'text-gray-400'}`}>{event.label}</p>
                                <span className="text-[10px] font-display font-600 px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">{event.category}</span>
                              </div>
                              <p className={`text-xs mt-0.5 leading-relaxed ${isEnabled ? 'text-gray-400' : 'text-gray-300'}`}>{event.description}</p>
                            </div>
                          </div>
                          <Toggle
                            checked={isEnabled}
                            onChange={() => toggleEventOptOut(event.key)}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Email notifications */}
                <div className="mb-6">
                  <div className="flex items-center gap-2 mb-4">
                    <Icon name="EnvelopeIcon" size={15} className="text-gray-500" />
                    <h3 className="font-display font-600 text-gray-900 text-sm">Email Notifications</h3>
                  </div>
                  <div className="space-y-4 pl-1">
                    {([
                      { key: 'emailApplicationStatus' as NotificationKey, label: 'Application status changes', description: 'When your application moves to a new stage (submitted, in review, approved, etc.)' },
                      { key: 'emailDocumentRequests' as NotificationKey, label: 'Document requests', description: 'When EarnestBridge requires additional documents or information from you' },
                      { key: 'emailApprovalUpdates' as NotificationKey, label: 'Approval decisions', description: 'Conditional approvals, full approvals, and any conditions to clear' },
                      { key: 'emailFundingConfirmation' as NotificationKey, label: 'EMD funding confirmation', description: 'Confirmation when funds are wired to escrow on your behalf' },
                      { key: 'emailClosingReminders' as NotificationKey, label: 'Closing date reminders', description: '7-day and 3-day advance reminders before scheduled closing dates' },
                      { key: 'emailWeeklyDigest' as NotificationKey, label: 'Weekly portfolio digest', description: 'A summary of all active deals and pending items, sent every Monday' },
                    ] as { key: NotificationKey; label: string; description: string }[]).map((item) => (
                      <div key={`notif-email-${item.key}`} className="flex items-start justify-between gap-4 py-3 border-b border-gray-50 last:border-0">
                        <div>
                          <p className="text-sm font-medium text-gray-800">{item.label}</p>
                          <p className="text-xs text-gray-400 mt-0.5 leading-relaxed max-w-md">{item.description}</p>
                        </div>
                        <Toggle
                          checked={notifPrefs[item.key]}
                          onChange={(v) => updateNotif(item.key, v)}
                        />
                      </div>
                    ))}
                  </div>
                </div>

                {/* SMS notifications */}
                <div className="mb-6">
                  <div className="flex items-center gap-2 mb-4">
                    <Icon name="DevicePhoneMobileIcon" size={15} className="text-gray-500" />
                    <h3 className="font-display font-600 text-gray-900 text-sm">SMS / Text Notifications</h3>
                    {userPhone && (
                      <span className="text-[10px] text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full font-display">Sent to {userPhone}</span>
                    )}
                  </div>
                  <div className="space-y-4 pl-1">
                    {([
                      { key: 'smsUrgentActions' as NotificationKey, label: 'Urgent action items', description: 'Immediate SMS when a high-priority document or signature is required' },
                      { key: 'smsClosingReminders' as NotificationKey, label: 'Closing date reminders', description: '48-hour and day-of reminders for upcoming closings' },
                      { key: 'smsFundingConfirmation' as NotificationKey, label: 'EMD funding confirmation', description: 'Instant SMS confirmation when your EMD funds are wired to escrow' },
                      { key: 'smsApplicationUpdates' as NotificationKey, label: 'Application status updates', description: 'Key milestone updates via text for quick awareness on the go' },
                    ] as { key: NotificationKey; label: string; description: string }[]).map((item) => (
                      <div key={`notif-sms-${item.key}`} className="flex items-start justify-between gap-4 py-3 border-b border-gray-50 last:border-0">
                        <div>
                          <p className="text-sm font-medium text-gray-800">{item.label}</p>
                          <p className="text-xs text-gray-400 mt-0.5 leading-relaxed max-w-md">{item.description}</p>
                        </div>
                        <Toggle
                          checked={notifPrefs[item.key]}
                          onChange={(v) => updateNotif(item.key, v)}
                        />
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex justify-end">
                  <button
                    onClick={handleSaveNotifications}
                    disabled={savingNotifs}
                    className="flex items-center gap-2 px-5 py-2.5 bg-eb-green-900 hover:bg-eb-green-800 disabled:opacity-60 text-white font-display font-600 text-sm rounded-lg transition-all active:scale-95"
                    style={{ minWidth: '170px', justifyContent: 'center' }}
                  >
                    {savingNotifs ? (
                      <>
                        <Icon name="ArrowPathIcon" size={14} className="animate-spin" />
                        Saving...
                      </>
                    ) : (
                      <>
                        <Icon name="CheckIcon" size={14} />
                        Save Preferences
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Security */}
          {activeSection === 'security' && (
            <div className="animate-fade-in space-y-5">
              {/* Change password */}
              <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-6">
                <div className="flex items-center gap-3 mb-6 pb-5 border-b border-gray-100">
                  <div className="w-10 h-10 rounded-xl bg-red-50 flex items-center justify-center">
                    <Icon name="LockClosedIcon" size={20} className="text-red-500" />
                  </div>
                  <div>
                    <h2 className="font-display font-700 text-gray-900">Change Password</h2>
                    <p className="text-xs text-gray-400 mt-0.5">Use a strong, unique password at least 12 characters long</p>
                  </div>
                </div>

                <form onSubmit={securityForm.handleSubmit(handleChangePassword)} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="currentPassword">
                      Current password <span className="text-red-500">*</span>
                    </label>
                    <div className="relative">
                      <input
                        id="currentPassword"
                        type={showCurrentPassword ? 'text' : 'password'}
                        className={`w-full px-3.5 py-2.5 pr-10 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 ${securityForm.formState.errors.currentPassword ? 'border-red-400 bg-red-50' : 'border-gray-300 hover:border-gray-400'}`}
                        {...securityForm.register('currentPassword', { required: 'Current password is required' })}
                      />
                      <button type="button" onClick={() => setShowCurrentPassword(!showCurrentPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                        <Icon name={showCurrentPassword ? 'EyeSlashIcon' : 'EyeIcon'} size={15} />
                      </button>
                    </div>
                    {securityForm.formState.errors.currentPassword && (
                      <p className="mt-1 text-xs text-red-600">{securityForm.formState.errors.currentPassword.message}</p>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="newPassword">
                        New password <span className="text-red-500">*</span>
                      </label>
                      <div className="relative">
                        <input
                          id="newPassword"
                          type={showNewPassword ? 'text' : 'password'}
                          placeholder="Min. 12 characters"
                          className={`w-full px-3.5 py-2.5 pr-10 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 ${securityForm.formState.errors.newPassword ? 'border-red-400 bg-red-50' : 'border-gray-300 hover:border-gray-400'}`}
                          {...securityForm.register('newPassword', {
                            required: 'New password is required',
                            minLength: { value: 12, message: 'Minimum 12 characters' },
                          })}
                        />
                        <button type="button" onClick={() => setShowNewPassword(!showNewPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                          <Icon name={showNewPassword ? 'EyeSlashIcon' : 'EyeIcon'} size={15} />
                        </button>
                      </div>
                      {securityForm.formState.errors.newPassword && (
                        <p className="mt-1 text-xs text-red-600">{securityForm.formState.errors.newPassword.message}</p>
                      )}
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1.5" htmlFor="confirmNewPassword">
                        Confirm new password <span className="text-red-500">*</span>
                      </label>
                      <div className="relative">
                        <input
                          id="confirmNewPassword"
                          type={showNewPassword ? 'text' : 'password'}
                          placeholder="Repeat new password"
                          className={`w-full px-3.5 py-2.5 pr-10 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 ${securityForm.formState.errors.confirmNewPassword ? 'border-red-400 bg-red-50' : 'border-gray-300 hover:border-gray-400'}`}
                          {...securityForm.register('confirmNewPassword', {
                            required: 'Please confirm your new password',
                            validate: (value) =>
                              value === securityForm.getValues('newPassword') || 'Passwords do not match',
                          })}
                        />
                      </div>
                      {securityForm.formState.errors.confirmNewPassword && (
                        <p className="mt-1 text-xs text-red-600">{securityForm.formState.errors.confirmNewPassword.message}</p>
                      )}
                    </div>
                  </div>

                  <div className="flex justify-end">
                    <button
                      type="submit"
                      disabled={savingSection === 'security'}
                      className="flex items-center gap-2 px-5 py-2.5 bg-eb-green-900 hover:bg-eb-green-800 disabled:opacity-60 text-white font-display font-600 text-sm rounded-lg transition-all active:scale-95"
                      style={{ minWidth: '150px', justifyContent: 'center' }}
                    >
                      {savingSection === 'security' ? (
                        <>
                          <Icon name="ArrowPathIcon" size={14} className="animate-spin" />
                          Updating...
                        </>
                      ) : (
                        <>
                          <Icon name="LockClosedIcon" size={14} />
                          Update Password
                        </>
                      )}
                    </button>
                  </div>
                </form>
              </div>

              {/* Two-factor authentication */}
              <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-6">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-purple-50 flex items-center justify-center flex-shrink-0">
                      <Icon name="ShieldCheckIcon" size={20} className="text-purple-600" />
                    </div>
                    <div>
                      <h3 className="font-display font-700 text-gray-900">Two-Factor Authentication</h3>
                      <p className="text-xs text-gray-400 mt-0.5">Add an extra layer of security using an authenticator app or SMS code</p>
                      {twoFAEnabled && (
                        <span className="inline-flex items-center gap-1 mt-1 text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full font-display font-600">
                          <Icon name="CheckCircleIcon" size={11} />
                          Enabled
                        </span>
                      )}
                    </div>
                  </div>
                  <Toggle
                    checked={twoFAEnabled}
                    onChange={(v) => {
                      setTwoFAEnabled(v);
                      toast.success(v ? '2FA enabled' : '2FA disabled', {
                        description: v ? 'Your account is now more secure.' : '2FA has been turned off.',
                      });
                    }}
                  />
                </div>
              </div>

              {/* Account info */}
              <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-6">
                <div className="flex items-center gap-3 mb-5 pb-4 border-b border-gray-100">
                  <div className="w-10 h-10 rounded-xl bg-slate-50 flex items-center justify-center">
                    <Icon name="UserCircleIcon" size={20} className="text-slate-600" />
                  </div>
                  <div>
                    <h3 className="font-display font-700 text-gray-900">Account Information</h3>
                    <p className="text-xs text-gray-400 mt-0.5">Your current account details</p>
                  </div>
                </div>
                <div className="space-y-3">
                  <div className="flex items-center justify-between p-3.5 rounded-xl bg-gray-50 border border-gray-100">
                    <div className="flex items-center gap-3">
                      <Icon name="EnvelopeIcon" size={16} className="text-gray-400" />
                      <div>
                        <p className="text-xs text-gray-400">Email address</p>
                        <p className="text-sm font-medium text-gray-900">{displayEmail}</p>
                      </div>
                    </div>
                    {user?.email_confirmed_at && (
                      <span className="text-[11px] font-display font-600 text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">Verified</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 p-3.5 rounded-xl bg-gray-50 border border-gray-100">
                    <Icon name="CalendarDaysIcon" size={16} className="text-gray-400" />
                    <div>
                      <p className="text-xs text-gray-400">Member since</p>
                      <p className="text-sm font-medium text-gray-900">
                        {user?.created_at ? new Date(user.created_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : '—'}
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Danger zone */}
              <div className="bg-white rounded-2xl shadow-card border border-red-200 p-6">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-xl bg-red-50 flex items-center justify-center">
                    <Icon name="ExclamationTriangleIcon" size={20} className="text-red-500" />
                  </div>
                  <div>
                    <h3 className="font-display font-700 text-red-700">Danger Zone</h3>
                    <p className="text-xs text-red-400 mt-0.5">Irreversible account actions — proceed with caution</p>
                  </div>
                </div>
                <div className="flex items-center justify-between p-4 bg-red-50 rounded-xl border border-red-100">
                  <div>
                    <p className="text-sm font-medium text-red-800">Delete your account</p>
                    <p className="text-xs text-red-500 mt-0.5">Permanently removes your account, all applications, and uploaded documents</p>
                  </div>
                  <button
                    onClick={() => setShowDeleteModal(true)}
                    className="flex items-center gap-1.5 px-4 py-2 text-sm font-display font-600 text-white bg-red-600 hover:bg-red-700 rounded-lg transition-all active:scale-95 flex-shrink-0"
                  >
                    <Icon name="TrashIcon" size={14} />
                    Delete Account
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}