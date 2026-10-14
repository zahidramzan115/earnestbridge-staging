'use client';
import React, { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import Icon from '@/components/ui/AppIcon';

interface AuthUserRecord {
  id: string;
  email: string;
  created_at: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
}

interface CRMContactRecord {
  id: string;
  first_name: string;
  last_name: string;
  primary_email: string;
  phone: string | null;
  lead_status: string;
  crm_companies?: { id: string; company_name: string } | null;
}

interface CreateDealModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  // Optional: pre-populate from a CRM contact
  prefillContactId?: string;
  prefillContactName?: string;
  prefillContactEmail?: string;
  prefillContactPhone?: string;
  prefillCompanyName?: string;
  prefillCompanyId?: string;
}

const PROPERTY_TYPES = ['Multifamily', 'Office', 'Retail', 'Industrial', 'Mixed-Use', 'Land', 'Hotel/Hospitality', 'Self-Storage', 'Other'];
const COMPANY_TYPES = ['LLC', 'LP', 'Corporation', 'Partnership', 'Sole Proprietorship', 'Trust', 'Other'];

function formatWithCommas(value: string): string {
  const digits = value.replace(/[^0-9]/g, '');
  if (!digits) return '';
  return Number(digits).toLocaleString('en-US');
}

function parseNumber(formatted: string): number | null {
  const clean = formatted.replace(/,/g, '');
  const n = parseFloat(clean);
  return isNaN(n) ? null : n;
}

type ClientMode = 'crm_contact' | 'existing_portal' | 'new_offline';

interface FormState {
  clientMode: ClientMode;
  // CRM contact
  crmContactId: string;
  crmContactSearch: string;
  // Portal user
  selectedUserId: string;
  selectedUserEmail: string;
  // Contact info
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  // Deal
  companyName: string;
  companyType: string;
  propertyAddress: string;
  propertyType: string;
  depositAmount: string;
  purchasePrice: string;
  closingDate: string;
  adminNotes: string;
}

const INITIAL_FORM: FormState = {
  clientMode: 'crm_contact',
  crmContactId: '',
  crmContactSearch: '',
  selectedUserId: '',
  selectedUserEmail: '',
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  companyName: '',
  companyType: '',
  propertyAddress: '',
  propertyType: '',
  depositAmount: '',
  purchasePrice: '',
  closingDate: '',
  adminNotes: '',
};

export default function CreateDealModal({
  open,
  onClose,
  onCreated,
  prefillContactId,
  prefillContactName,
  prefillContactEmail,
  prefillContactPhone,
  prefillCompanyName,
  prefillCompanyId,
}: CreateDealModalProps) {
  const supabase = createClient();
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  // CRM contact search
  const [crmContacts, setCrmContacts] = useState<CRMContactRecord[]>([]);
  const [showCrmDropdown, setShowCrmDropdown] = useState(false);
  const [loadingCrm, setLoadingCrm] = useState(false);

  // Portal user search
  const [authUsers, setAuthUsers] = useState<AuthUserRecord[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [userSearch, setUserSearch] = useState('');
  const [showUserDropdown, setShowUserDropdown] = useState(false);

  const fetchUsers = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const res = await fetch('/api/admin/list-users');
      const data = await res.json();
      setAuthUsers(data.users || []);
    } catch {
      setAuthUsers([]);
    } finally {
      setLoadingUsers(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;

    // If prefilled from a CRM contact, start in crm_contact mode
    if (prefillContactId) {
      const nameParts = (prefillContactName || '').split(' ');
      const fn = nameParts[0];
      const ln = nameParts.slice(1).join(' ');
      setForm({
        ...INITIAL_FORM,
        clientMode: 'crm_contact',
        crmContactId: prefillContactId,
        crmContactSearch: prefillContactName || '',
        firstName: fn || '',
        lastName: ln || '',
        email: prefillContactEmail || '',
        phone: prefillContactPhone || '',
        companyName: prefillCompanyName || '',
      });
    } else {
      setForm(INITIAL_FORM);
      fetchUsers();
    }
    setErrors({});
    setSubmitError('');
    setUserSearch('');
    setCrmContacts([]);
  }, [open, prefillContactId, prefillContactName, prefillContactEmail, prefillContactPhone, prefillCompanyName, fetchUsers]);

  const set = (field: keyof FormState, value: string) => {
    setForm(prev => ({ ...prev, [field]: value }));
    setErrors(prev => ({ ...prev, [field]: undefined }));
  };

  // ── CRM Contact Search ────────────────────────────────────────────────────

  const searchCrmContacts = useCallback(async (q: string) => {
    if (q.length < 2) { setCrmContacts([]); return; }
    setLoadingCrm(true);
    const { data } = await supabase
      .from('crm_contacts')
      .select('id, first_name, last_name, primary_email, phone, lead_status, crm_companies(id, company_name)')
      .eq('is_merged', false)
      .or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,primary_email.ilike.%${q}%`)
      .limit(10);
    setCrmContacts((data as CRMContactRecord[]) || []);
    setLoadingCrm(false);
  }, [supabase]);

  const handleSelectCrmContact = (c: CRMContactRecord) => {
    setForm(prev => ({
      ...prev,
      crmContactId: c.id,
      crmContactSearch: `${c.first_name} ${c.last_name} — ${c.primary_email}`,
      firstName: c.first_name,
      lastName: c.last_name,
      email: c.primary_email,
      phone: c.phone || prev.phone,
      companyName: (c.crm_companies as any)?.company_name || prev.companyName,
    }));
    setCrmContacts([]);
    setShowCrmDropdown(false);
    setErrors(prev => ({ ...prev, crmContactId: undefined }));
  };

  // ── Portal User Search ────────────────────────────────────────────────────

  const filteredUsers = authUsers.filter(u => {
    const q = userSearch.toLowerCase();
    const fullName = `${u.first_name || ''} ${u.last_name || ''}`.toLowerCase();
    return u.email.toLowerCase().includes(q) || fullName.includes(q);
  });

  const handleSelectUser = (user: AuthUserRecord) => {
    const displayName = user.first_name && user.last_name
      ? `${user.first_name} ${user.last_name} — ${user.email}`
      : user.email;
    setForm(prev => ({
      ...prev,
      selectedUserId: user.id,
      selectedUserEmail: user.email,
      email: user.email,
      firstName: user.first_name || prev.firstName,
      lastName: user.last_name || prev.lastName,
      phone: user.phone || prev.phone,
    }));
    setUserSearch(displayName);
    setShowUserDropdown(false);
    setErrors(prev => ({ ...prev, selectedUserId: undefined }));
  };

  // ── Validation ────────────────────────────────────────────────────────────

  const validate = (): boolean => {
    const newErrors: Partial<Record<keyof FormState, string>> = {};

    if (form.clientMode === 'crm_contact' && !form.crmContactId) {
      newErrors.crmContactId = 'Please select a CRM contact';
    }
    if (form.clientMode === 'existing_portal' && !form.selectedUserId) {
      newErrors.selectedUserId = 'Please select a portal user';
    }
    if (!form.firstName.trim()) newErrors.firstName = 'First name is required';
    if (!form.lastName.trim()) newErrors.lastName = 'Last name is required';
    if (!form.email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      newErrors.email = 'Valid email is required';
    }
    if (!form.phone.trim()) newErrors.phone = 'Phone is required';
    if (!form.propertyAddress.trim()) newErrors.propertyAddress = 'Property address is required';
    if (!form.propertyType) newErrors.propertyType = 'Property type is required';
    if (!form.depositAmount) newErrors.depositAmount = 'EMD amount is required';
    if (!form.purchasePrice) newErrors.purchasePrice = 'Purchase price is required';
    if (!form.closingDate) newErrors.closingDate = 'Closing date is required';

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  // ── Submit ────────────────────────────────────────────────────────────────

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    setSubmitting(true);
    setSubmitError('');

    try {
      const payload: Record<string, unknown> = {
        user_id: form.clientMode === 'existing_portal' ? form.selectedUserId : null,
        first_name: form.firstName.trim(),
        last_name: form.lastName.trim(),
        email: form.email.trim(),
        client_email: form.email.trim(),
        phone: form.phone.trim(),
        company_name: form.companyName.trim() || null,
        company_type: form.companyType || null,
        property_address: form.propertyAddress.trim(),
        property_type: form.propertyType,
        deposit_amount: parseNumber(form.depositAmount),
        purchase_price: parseNumber(form.purchasePrice),
        closing_date: form.closingDate,
        app_status: 'submitted',
        agreed_to_terms: true,
        identity_verified: false,
        admin_created: true,
        admin_notes: form.adminNotes.trim() || null,
        submitted_at: new Date().toISOString(),
        crm_company_id: prefillCompanyId || null,
      };

      // If CRM contact mode, set primary_contact_id
      if (form.clientMode === 'crm_contact' && form.crmContactId) {
        payload.primary_contact_id = form.crmContactId;
      }

      const { data: newDeal, error } = await supabase
        .from('borrower_applications')
        .insert(payload)
        .select('id')
        .single();

      if (error) throw error;

      // Associate CRM contact with the deal
      if (form.crmContactId && newDeal) {
        await supabase.from('crm_deal_contacts').insert({
          deal_id: newDeal.id,
          contact_id: form.crmContactId,
          role: 'primary',
        }).onConflict('deal_id,contact_id').ignore();

        // Log activity on the CRM contact
        await supabase.from('crm_activities').insert({
          contact_id: form.crmContactId,
          deal_id: newDeal.id,
          event_type: 'deal_created',
          title: `Deal created: ${form.propertyAddress.trim()}`,
          detail: `Admin created a new deal for this contact. EMD: $${form.depositAmount}`,
          actor: 'Admin',
        });

        // Suggest lead status update to "Deal Submitted" if currently New Lead/Contacted/Qualified
        const { data: contactData } = await supabase
          .from('crm_contacts')
          .select('lead_status')
          .eq('id', form.crmContactId)
          .single();

        if (contactData && ['New Lead', 'Contacted', 'Qualified'].includes(contactData.lead_status)) {
          await supabase.from('crm_contacts').update({
            lead_status: 'Deal Submitted',
            updated_at: new Date().toISOString(),
          }).eq('id', form.crmContactId);

          await supabase.from('crm_activities').insert({
            contact_id: form.crmContactId,
            event_type: 'status_changed',
            title: `Status changed: ${contactData.lead_status} → Deal Submitted`,
            detail: 'Automatically updated when first deal was created.',
            actor: 'System',
          });
        }
      }

      onCreated();
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to create deal';
      setSubmitError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-2xl bg-white rounded-2xl shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-eb-green-100 flex items-center justify-center">
              <Icon name="PlusCircleIcon" size={18} className="text-eb-green-900" />
            </div>
            <div>
              <h2 className="font-display font-700 text-gray-900 text-base">Create Deal</h2>
              <p className="text-xs text-gray-500">
                {prefillContactName ? `For ${prefillContactName}` : 'Admin-created deal — no portal account required'}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-all">
            <Icon name="XMarkIcon" size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col flex-1 overflow-hidden">
          <div className="overflow-y-auto flex-1 px-6 py-5 space-y-6">

            {/* ── Client Mode ── */}
            {!prefillContactId && (
              <section>
                <h3 className="text-xs font-700 font-display uppercase tracking-widest text-eb-green-800 mb-3">Client</h3>
                <div className="flex gap-2 mb-4">
                  {([
                    { mode: 'crm_contact' as ClientMode, label: 'CRM Contact' },
                    { mode: 'existing_portal' as ClientMode, label: 'Portal User' },
                    { mode: 'new_offline' as ClientMode, label: 'New / Offline' },
                  ]).map(({ mode, label }) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => {
                        set('clientMode', mode);
                        setUserSearch('');
                        setForm(prev => ({ ...prev, clientMode: mode, selectedUserId: '', selectedUserEmail: '', crmContactId: '', crmContactSearch: '' }));
                        if (mode === 'existing_portal') fetchUsers();
                      }}
                      className={`flex-1 py-2 text-sm font-display font-600 rounded-lg border transition-all ${
                        form.clientMode === mode
                          ? 'bg-eb-green-900 text-white border-eb-green-900' :'bg-white text-gray-600 border-gray-200 hover:border-eb-green-900/40'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {/* CRM Contact search */}
                {form.clientMode === 'crm_contact' && (
                  <div className="relative">
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">
                      Search CRM Contact <span className="text-red-500">*</span>
                    </label>
                    <div className="relative">
                      <Icon name="MagnifyingGlassIcon" size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                      <input
                        type="text"
                        placeholder="Name or email…"
                        value={form.crmContactSearch}
                        onChange={e => {
                          set('crmContactSearch', e.target.value);
                          setForm(prev => ({ ...prev, crmContactId: '' }));
                          setShowCrmDropdown(true);
                          searchCrmContacts(e.target.value);
                        }}
                        onFocus={() => setShowCrmDropdown(true)}
                        className={`w-full pl-8 pr-3 py-2.5 text-sm border rounded-lg outline-none focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 transition-all ${
                          errors.crmContactId ? 'border-red-400 bg-red-50' : 'border-gray-300'
                        }`}
                      />
                      {form.crmContactId && (
                        <div className="absolute right-3 top-1/2 -translate-y-1/2">
                          <Icon name="CheckCircleIcon" size={16} className="text-emerald-500" />
                        </div>
                      )}
                    </div>
                    {errors.crmContactId && (
                      <p className="mt-1 text-xs text-red-600 flex items-center gap-1">
                        <Icon name="ExclamationCircleIcon" size={12} />{errors.crmContactId}
                      </p>
                    )}
                    {showCrmDropdown && crmContacts.length > 0 && (
                      <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg max-h-48 overflow-y-auto">
                        {crmContacts.map(c => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => handleSelectCrmContact(c)}
                            className="w-full text-left px-4 py-2.5 text-sm hover:bg-eb-green-50 transition-colors flex items-center gap-2"
                          >
                            <div className="w-7 h-7 rounded-full bg-eb-green-100 flex items-center justify-center flex-shrink-0">
                              <span className="text-[10px] font-700 text-eb-green-800">
                                {c.first_name?.[0]?.toUpperCase()}{c.last_name?.[0]?.toUpperCase()}
                              </span>
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="font-500 text-gray-800 truncate">{c.first_name} {c.last_name}</p>
                              <p className="text-[10px] text-gray-400 truncate">{c.primary_email}</p>
                              {(c.crm_companies as any)?.company_name && (
                                <p className="text-[10px] text-gray-400">{(c.crm_companies as any).company_name}</p>
                              )}
                            </div>
                            <span className="text-[10px] text-gray-400 flex-shrink-0">{c.lead_status}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    <p className="mt-1.5 text-xs text-gray-400">
                      No portal account required. Deal will be linked to the CRM contact.
                    </p>
                  </div>
                )}

                {/* Portal user search */}
                {form.clientMode === 'existing_portal' && (
                  <div className="relative">
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">
                      Select Portal User <span className="text-red-500">*</span>
                    </label>
                    <div className="relative">
                      <Icon name="MagnifyingGlassIcon" size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                      <input
                        type="text"
                        placeholder={loadingUsers ? 'Loading…' : 'Search by email…'}
                        value={userSearch}
                        onChange={e => {
                          setUserSearch(e.target.value);
                          setShowUserDropdown(true);
                          if (!e.target.value) setForm(prev => ({ ...prev, selectedUserId: '', selectedUserEmail: '' }));
                        }}
                        onFocus={() => setShowUserDropdown(true)}
                        className={`w-full pl-8 pr-3 py-2.5 text-sm border rounded-lg outline-none focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 transition-all ${
                          errors.selectedUserId ? 'border-red-400 bg-red-50' : 'border-gray-300'
                        }`}
                      />
                      {form.selectedUserId && <div className="absolute right-3 top-1/2 -translate-y-1/2"><Icon name="CheckCircleIcon" size={16} className="text-emerald-500" /></div>}
                    </div>
                    {errors.selectedUserId && <p className="mt-1 text-xs text-red-600 flex items-center gap-1"><Icon name="ExclamationCircleIcon" size={12} />{errors.selectedUserId}</p>}
                    {showUserDropdown && userSearch && filteredUsers.length > 0 && (
                      <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg max-h-48 overflow-y-auto">
                        {filteredUsers.slice(0, 20).map(user => (
                          <button key={user.id} type="button" onClick={() => handleSelectUser(user)}
                            className="w-full text-left px-4 py-2.5 text-sm hover:bg-eb-green-50 transition-colors flex items-center gap-2">
                            <div className="w-7 h-7 rounded-full bg-eb-green-100 flex items-center justify-center flex-shrink-0">
                              <span className="text-[10px] font-700 text-eb-green-800">{(user.first_name || user.email)[0].toUpperCase()}</span>
                            </div>
                            <div className="min-w-0 flex-1">
                              {(user.first_name || user.last_name) && <p className="font-500 text-gray-800 truncate">{user.first_name} {user.last_name}</p>}
                              <p className="text-[10px] text-gray-400 truncate">{user.email}</p>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {form.clientMode === 'new_offline' && (
                  <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 flex items-start gap-2">
                    <Icon name="InformationCircleIcon" size={15} className="text-amber-600 mt-0.5 flex-shrink-0" />
                    <p className="text-xs text-amber-700">
                      Deal will be created without a portal account or CRM contact. The client can be linked later.
                    </p>
                  </div>
                )}
              </section>
            )}

            {/* Pre-filled contact banner */}
            {prefillContactId && (
              <div className="p-3 rounded-xl bg-eb-green-50 border border-eb-green-200 flex items-center gap-2">
                <Icon name="UserCircleIcon" size={16} className="text-eb-green-600 flex-shrink-0" />
                <div>
                  <p className="text-sm font-600 text-eb-green-800">Creating deal for: {prefillContactName}</p>
                  <p className="text-xs text-eb-green-600">CRM contact will be automatically linked. No portal account required.</p>
                </div>
              </div>
            )}

            {/* ── Contact Info ── */}
            <section>
              <h3 className="text-xs font-700 font-display uppercase tracking-widest text-eb-green-800 mb-3">Contact Information</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">First Name <span className="text-red-500">*</span></label>
                  <input type="text" placeholder="John" value={form.firstName} onChange={e => set('firstName', e.target.value)}
                    className={`w-full px-3.5 py-2.5 text-sm border rounded-lg outline-none focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 transition-all ${errors.firstName ? 'border-red-400 bg-red-50' : 'border-gray-300'}`} />
                  {errors.firstName && <p className="mt-1 text-xs text-red-600 flex items-center gap-1"><Icon name="ExclamationCircleIcon" size={12} />{errors.firstName}</p>}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Last Name <span className="text-red-500">*</span></label>
                  <input type="text" placeholder="Smith" value={form.lastName} onChange={e => set('lastName', e.target.value)}
                    className={`w-full px-3.5 py-2.5 text-sm border rounded-lg outline-none focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 transition-all ${errors.lastName ? 'border-red-400 bg-red-50' : 'border-gray-300'}`} />
                  {errors.lastName && <p className="mt-1 text-xs text-red-600 flex items-center gap-1"><Icon name="ExclamationCircleIcon" size={12} />{errors.lastName}</p>}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Email <span className="text-red-500">*</span></label>
                  <input type="email" placeholder="client@company.com" value={form.email} onChange={e => set('email', e.target.value)}
                    readOnly={form.clientMode === 'existing_portal' && !!form.selectedUserId}
                    className={`w-full px-3.5 py-2.5 text-sm border rounded-lg outline-none focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 transition-all ${errors.email ? 'border-red-400 bg-red-50' : 'border-gray-300'} ${form.clientMode === 'existing_portal' && form.selectedUserId ? 'bg-gray-50 text-gray-500' : ''}`} />
                  {errors.email && <p className="mt-1 text-xs text-red-600 flex items-center gap-1"><Icon name="ExclamationCircleIcon" size={12} />{errors.email}</p>}
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Phone <span className="text-red-500">*</span></label>
                  <input type="tel" placeholder="+1 (555) 000-0000" value={form.phone} onChange={e => set('phone', e.target.value)}
                    className={`w-full px-3.5 py-2.5 text-sm border rounded-lg outline-none focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 transition-all ${errors.phone ? 'border-red-400 bg-red-50' : 'border-gray-300'}`} />
                  {errors.phone && <p className="mt-1 text-xs text-red-600 flex items-center gap-1"><Icon name="ExclamationCircleIcon" size={12} />{errors.phone}</p>}
                </div>
              </div>
            </section>

            {/* ── Deal Details ── */}
            <section>
              <h3 className="text-xs font-700 font-display uppercase tracking-widest text-eb-green-800 mb-3">Deal Details</h3>
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">EMD Amount ($) <span className="text-red-500">*</span></label>
                    <input type="text" inputMode="numeric" placeholder="250,000" value={form.depositAmount} onChange={e => set('depositAmount', formatWithCommas(e.target.value))}
                      className={`w-full px-3.5 py-2.5 text-sm border rounded-lg outline-none focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 transition-all ${errors.depositAmount ? 'border-red-400 bg-red-50' : 'border-gray-300'}`} />
                    {errors.depositAmount && <p className="mt-1 text-xs text-red-600 flex items-center gap-1"><Icon name="ExclamationCircleIcon" size={12} />{errors.depositAmount}</p>}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">Purchase Price ($) <span className="text-red-500">*</span></label>
                    <input type="text" inputMode="numeric" placeholder="5,000,000" value={form.purchasePrice} onChange={e => set('purchasePrice', formatWithCommas(e.target.value))}
                      className={`w-full px-3.5 py-2.5 text-sm border rounded-lg outline-none focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 transition-all ${errors.purchasePrice ? 'border-red-400 bg-red-50' : 'border-gray-300'}`} />
                    {errors.purchasePrice && <p className="mt-1 text-xs text-red-600 flex items-center gap-1"><Icon name="ExclamationCircleIcon" size={12} />{errors.purchasePrice}</p>}
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Property Address <span className="text-red-500">*</span></label>
                  <input type="text" placeholder="123 Main St, Atlanta, GA 30301" value={form.propertyAddress} onChange={e => set('propertyAddress', e.target.value)}
                    className={`w-full px-3.5 py-2.5 text-sm border rounded-lg outline-none focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 transition-all ${errors.propertyAddress ? 'border-red-400 bg-red-50' : 'border-gray-300'}`} />
                  {errors.propertyAddress && <p className="mt-1 text-xs text-red-600 flex items-center gap-1"><Icon name="ExclamationCircleIcon" size={12} />{errors.propertyAddress}</p>}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">Property Type <span className="text-red-500">*</span></label>
                    <select value={form.propertyType} onChange={e => set('propertyType', e.target.value)}
                      className={`w-full px-3.5 py-2.5 text-sm border rounded-lg outline-none focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 bg-white transition-all ${errors.propertyType ? 'border-red-400 bg-red-50' : 'border-gray-300'}`}>
                      <option value="">Select type…</option>
                      {PROPERTY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                    {errors.propertyType && <p className="mt-1 text-xs text-red-600 flex items-center gap-1"><Icon name="ExclamationCircleIcon" size={12} />{errors.propertyType}</p>}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1.5">Target Closing Date <span className="text-red-500">*</span></label>
                    <input type="date" value={form.closingDate} onChange={e => set('closingDate', e.target.value)}
                      className={`w-full px-3.5 py-2.5 text-sm border rounded-lg outline-none focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 transition-all ${errors.closingDate ? 'border-red-400 bg-red-50' : 'border-gray-300'}`} />
                    {errors.closingDate && <p className="mt-1 text-xs text-red-600 flex items-center gap-1"><Icon name="ExclamationCircleIcon" size={12} />{errors.closingDate}</p>}
                  </div>
                </div>
              </div>
            </section>

            {/* ── Company ── */}
            <section>
              <h3 className="text-xs font-700 font-display uppercase tracking-widest text-gray-400 mb-3">Company <span className="normal-case font-400 text-gray-400">(optional)</span></h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Company Name</label>
                  <input type="text" placeholder="Reid Capital Group" value={form.companyName} onChange={e => set('companyName', e.target.value)}
                    className="w-full px-3.5 py-2.5 text-sm border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 transition-all" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Company Type</label>
                  <select value={form.companyType} onChange={e => set('companyType', e.target.value)}
                    className="w-full px-3.5 py-2.5 text-sm border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 bg-white transition-all">
                    <option value="">Select type…</option>
                    {COMPANY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              </div>
            </section>

            {/* ── Admin Notes ── */}
            <section>
              <h3 className="text-xs font-700 font-display uppercase tracking-widest text-gray-400 mb-3">Admin Notes <span className="normal-case font-400 text-gray-400">(optional)</span></h3>
              <textarea rows={3} placeholder="Internal notes about this deal…" value={form.adminNotes} onChange={e => set('adminNotes', e.target.value)}
                className="w-full px-3.5 py-2.5 text-sm border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-eb-green-900/20 focus:border-eb-green-900 transition-all resize-none" />
            </section>

            {submitError && (
              <div className="p-3 rounded-xl bg-red-50 border border-red-200 flex items-start gap-2">
                <Icon name="ExclamationCircleIcon" size={15} className="text-red-500 mt-0.5 flex-shrink-0" />
                <p className="text-xs text-red-700">{submitError}</p>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-gray-100 bg-gray-50/50 flex items-center justify-between gap-3 rounded-b-2xl">
            <div className="flex items-center gap-1.5 text-xs text-gray-400">
              <Icon name="ShieldCheckIcon" size={13} />
              <span>No portal account required</span>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={onClose} disabled={submitting}
                className="px-4 py-2 text-sm font-600 text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-100 transition-all disabled:opacity-50">
                Cancel
              </button>
              <button type="submit" disabled={submitting}
                className="flex items-center gap-2 px-5 py-2 bg-eb-green-900 text-white text-sm font-600 rounded-lg hover:bg-eb-green-800 transition-all disabled:opacity-60">
                {submitting ? (
                  <><svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>Creating…</>
                ) : (
                  <><Icon name="PlusIcon" size={14} />Create Deal</>
                )}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
