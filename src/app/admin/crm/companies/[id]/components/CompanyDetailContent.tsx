'use client';
import React, { useEffect, useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import Icon from '@/components/ui/AppIcon';
import Link from 'next/link';

interface Company {
  id: string;
  company_name: string;
  website: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  company_type: string | null;
  notes: string | null;
  assigned_owner: string;
  created_at: string;
}

interface Contact {
  id: string;
  first_name: string;
  last_name: string;
  primary_email: string;
  phone: string | null;
  lead_status: string;
  portal_link_status: string;
}

interface Deal {
  id: string;
  first_name: string;
  last_name: string;
  property_address: string | null;
  property_type: string | null;
  purchase_price: number | null;
  deposit_amount: number | null;
  due_diligence_days?: number | null;
  app_status: string;
  created_at: string;
}

const STATUS_COLORS: Record<string, string> = {
  'New Lead':       'bg-blue-100 text-blue-700',
  'Contacted':      'bg-purple-100 text-purple-700',
  'Qualified':      'bg-amber-100 text-amber-700',
  'Deal Submitted': 'bg-orange-100 text-orange-700',
  'Client':         'bg-emerald-100 text-emerald-700',
  'Nurture':        'bg-teal-100 text-teal-700',
  'Lost':           'bg-red-100 text-red-700',
  'Not Qualified':  'bg-gray-100 text-gray-600',
};

const DEAL_STATUS_COLORS: Record<string, string> = {
  application:  'bg-gray-100 text-gray-600',
  under_review: 'bg-amber-100 text-amber-700',
  approved:     'bg-green-100 text-green-700',
  in_progress:  'bg-blue-100 text-blue-700',
  funded:       'bg-emerald-100 text-emerald-700',
  closed:       'bg-gray-200 text-gray-700',
  rejected:     'bg-red-100 text-red-700',
};

function formatCurrency(v: number | null) {
  if (!v) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v);
}

function formatDate(d: string | null) {
  if (!d) return '—';
  const dt = new Date(d);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`;
}

export default function CompanyDetailContent({ companyId }: { companyId: string }) {
  const supabase = createClient();
  const [company, setCompany] = useState<Company | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState<Partial<Company>>({});
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<'contacts' | 'deals'>('contacts');

  const load = useCallback(async () => {
    setLoading(true);
    const [coResult, ctsResult, dealsResult] = await Promise.all([
      supabase.from('crm_companies').select('*').eq('id', companyId).single(),
      supabase.from('crm_contacts')
        .select('id, first_name, last_name, primary_email, phone, lead_status, portal_link_status')
        .eq('company_id', companyId).eq('is_merged', false).is('purged_at', null).order('created_at', { ascending: false }),
      // Deals: either directly linked to company OR via a contact that belongs to this company
      supabase.from('borrower_applications')
        .select('id, first_name, last_name, property_address, property_type, purchase_price, deposit_amount, due_diligence_days, app_status, created_at')
        .eq('crm_company_id', companyId)
        .is('purged_at', null)
        .order('created_at', { ascending: false }),
    ]);

    const co = coResult.data;
    const cts = ctsResult.data;
    const directDeals = dealsResult.data || [];

    if (co) { setCompany(co as Company); setEditForm(co as Company); }
    setContacts((cts as Contact[]) || []);

    // Also fetch deals via contact associations (avoid duplicates)
    if (cts && cts.length > 0) {
      const contactIds = cts.map((c: Contact) => c.id);
      const { data: contactDeals } = await supabase
        .from('crm_deal_contacts')
        .select('deal_id, borrower_applications(id, first_name, last_name, property_address, property_type, purchase_price, deposit_amount, due_diligence_days, app_status, created_at)')
        .in('contact_id', contactIds);

      const contactDealList: Deal[] = [];
      const seenIds = new Set(directDeals.map((d: Deal) => d.id));

      (contactDeals || []).forEach((dc: any) => {
        if (dc.borrower_applications && !seenIds.has(dc.borrower_applications.id)) {
          seenIds.add(dc.borrower_applications.id);
          contactDealList.push(dc.borrower_applications as Deal);
        }
      });

      setDeals([...directDeals as Deal[], ...contactDealList]);
    } else {
      setDeals(directDeals as Deal[]);
    }

    setLoading(false);
  }, [companyId, supabase]);

  useEffect(() => { load(); }, [load]);

  const handleSave = async () => {
    if (!company) return;
    setSaving(true);
    await supabase.from('crm_companies').update({ ...editForm, updated_at: new Date().toISOString() }).eq('id', company.id);
    await load();
    setEditing(false);
    setSaving(false);
  };

  if (loading) return <div className="flex items-center justify-center h-64"><div className="w-7 h-7 border-2 border-eb-green-700 border-t-transparent rounded-full animate-spin" /></div>;
  if (!company) return <div className="p-6 text-gray-500">Company not found</div>;

  return (
    <div className="p-6 space-y-5 max-w-screen-xl mx-auto">
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <Link href="/admin/crm" className="hover:text-gray-600">CRM</Link>
        <span>/</span>
        <Link href="/admin/crm/companies" className="hover:text-gray-600">Companies</Link>
        <span>/</span>
        <span className="text-gray-700 font-500">{company.company_name}</span>
      </div>

      {/* Header */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-xl bg-gray-100 flex items-center justify-center flex-shrink-0">
              <Icon name="BuildingOfficeIcon" size={22} className="text-gray-500" />
            </div>
            <div>
              <h1 className="text-xl font-700 text-gray-900 font-display">{company.company_name}</h1>
              {company.company_type && <p className="text-sm text-gray-500">{company.company_type}</p>}
              <div className="flex flex-wrap gap-3 mt-2 text-sm text-gray-500">
                {company.website && (
                  <a href={company.website} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 hover:text-eb-green-700">
                    <Icon name="GlobeAltIcon" size={13} className="text-gray-400" />
                    {company.website}
                  </a>
                )}
                {company.phone && (
                  <span className="flex items-center gap-1">
                    <Icon name="PhoneIcon" size={13} className="text-gray-400" />
                    {company.phone}
                  </span>
                )}
                {(company.city || company.state) && (
                  <span className="flex items-center gap-1">
                    <Icon name="MapPinIcon" size={13} className="text-gray-400" />
                    {[company.city, company.state].filter(Boolean).join(', ')}
                  </span>
                )}
              </div>
              <p className="text-xs text-gray-400 mt-1">Owner: <span className="font-600 text-gray-600">{company.assigned_owner}</span></p>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setEditing(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
              <Icon name="PencilIcon" size={13} />
              Edit
            </button>
            <Link href={`/admin/crm/contacts/new?company=${companyId}`}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-600 bg-eb-green-700 text-white rounded-lg hover:bg-eb-green-800 transition-colors">
              <Icon name="PlusIcon" size={13} />
              Add Contact
            </Link>
          </div>
        </div>
        {company.notes && (
          <div className="mt-4 pt-4 border-t border-gray-100">
            <p className="text-sm text-gray-600">{company.notes}</p>
          </div>
        )}
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
          <p className="text-2xl font-700 text-gray-900 font-display">{contacts.length}</p>
          <p className="text-xs text-gray-500 mt-0.5">Contacts</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-4 text-center">
          <p className="text-2xl font-700 text-gray-900 font-display">{deals.length}</p>
          <p className="text-xs text-gray-500 mt-0.5">Deals</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="flex border-b border-gray-100">
          <button
            onClick={() => setActiveTab('contacts')}
            className={`px-5 py-3 text-sm font-600 transition-colors border-b-2 ${activeTab === 'contacts' ? 'border-eb-green-700 text-eb-green-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >
            Contacts ({contacts.length})
          </button>
          <button
            onClick={() => setActiveTab('deals')}
            className={`px-5 py-3 text-sm font-600 transition-colors border-b-2 ${activeTab === 'deals' ? 'border-eb-green-700 text-eb-green-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >
            Deals ({deals.length})
          </button>
        </div>

        {/* Contacts Tab */}
        {activeTab === 'contacts' && (
          <>
            {contacts.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-gray-400">No contacts associated with this company</div>
            ) : (
              <div className="divide-y divide-gray-50">
                {contacts.map((c) => (
                  <Link key={c.id} href={`/admin/crm/contacts/${c.id}`}
                    className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50 transition-colors">
                    <div className="w-8 h-8 rounded-full bg-eb-green-100 flex items-center justify-center flex-shrink-0">
                      <span className="text-xs font-700 text-eb-green-700">
                        {(c.first_name?.[0] || '?').toUpperCase()}{(c.last_name?.[0] || '').toUpperCase()}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-600 text-gray-900">{c.first_name} {c.last_name}</p>
                      <p className="text-xs text-gray-400">{c.primary_email}</p>
                    </div>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-600 ${STATUS_COLORS[c.lead_status] || 'bg-gray-100 text-gray-600'}`}>
                      {c.lead_status}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </>
        )}

        {/* Deals Tab */}
        {activeTab === 'deals' && (
          <>
            {deals.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-gray-400">No deals associated with this company or its contacts</div>
            ) : (
              <div className="divide-y divide-gray-50">
                {deals.map((d) => (
                  <Link key={d.id} href={`/admin/borrower/${d.id}`}
                    className="flex items-center gap-3 px-5 py-3 hover:bg-gray-50 transition-colors">
                    <div className="w-8 h-8 rounded-xl bg-gray-100 flex items-center justify-center flex-shrink-0">
                      <Icon name="BriefcaseIcon" size={14} className="text-gray-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-600 text-gray-900">{d.property_address || 'Unnamed Deal'}</p>
                      <p className="text-xs text-gray-400">
                        {d.first_name} {d.last_name} · {d.property_type || '—'} · {formatCurrency(d.deposit_amount)} EMD
                      </p>
                      <p className="text-xs text-gray-400">Due Diligence Period: {d.due_diligence_days != null ? `${d.due_diligence_days} ${d.due_diligence_days === 1 ? 'Day' : 'Days'}` : '—'}</p>
                    </div>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-600 ${DEAL_STATUS_COLORS[d.app_status] || 'bg-gray-100 text-gray-600'}`}>
                      {d.app_status?.replace(/_/g, ' ')}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Edit Modal */}
      {editing && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg">
            <div className="flex items-center justify-between p-6 border-b border-gray-100">
              <h2 className="text-lg font-700 text-gray-900 font-display">Edit Company</h2>
              <button onClick={() => setEditing(false)} className="p-2 rounded-lg hover:bg-gray-100"><Icon name="XMarkIcon" size={18} /></button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-600 text-gray-500 mb-1">Company Name</label>
                <input type="text" value={editForm.company_name || ''} onChange={(e) => setEditForm((f) => ({ ...f, company_name: e.target.value }))}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-600 text-gray-500 mb-1">Website</label>
                  <input type="text" value={editForm.website || ''} onChange={(e) => setEditForm((f) => ({ ...f, website: e.target.value }))}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-600 text-gray-500 mb-1">Phone</label>
                  <input type="tel" value={editForm.phone || ''} onChange={(e) => setEditForm((f) => ({ ...f, phone: e.target.value }))}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-600 text-gray-500 mb-1">City</label>
                  <input type="text" value={editForm.city || ''} onChange={(e) => setEditForm((f) => ({ ...f, city: e.target.value }))}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none" />
                </div>
                <div>
                  <label className="block text-xs font-600 text-gray-500 mb-1">State</label>
                  <input type="text" value={editForm.state || ''} onChange={(e) => setEditForm((f) => ({ ...f, state: e.target.value }))}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-600 text-gray-500 mb-1">Notes</label>
                <textarea value={editForm.notes || ''} onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))} rows={3}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none resize-none" />
              </div>
            </div>
            <div className="flex gap-3 p-6 border-t border-gray-100">
              <button onClick={handleSave} disabled={saving}
                className="flex-1 py-2.5 bg-eb-green-700 text-white text-sm font-600 rounded-lg hover:bg-eb-green-800 disabled:opacity-40 transition-colors">
                {saving ? 'Saving…' : 'Save Changes'}
              </button>
              <button onClick={() => setEditing(false)}
                className="px-6 py-2.5 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
