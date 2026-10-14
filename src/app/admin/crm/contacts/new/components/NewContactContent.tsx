'use client';
import React, { useState } from 'react';
import { createClient } from '@/lib/supabase/client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';

const LEAD_STATUSES = [
  'New Lead', 'Contacted', 'Qualified', 'Deal Submitted',
  'Client', 'Nurture', 'Lost', 'Not Qualified',
];
const OWNERS = ['Dan', 'Tucker', 'Eric', 'Unassigned'];

export default function NewContactContent() {
  const supabase = createClient();
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    first_name: '',
    last_name: '',
    primary_email: '',
    phone: '',
    job_title: '',
    company_name: '',
    lead_status: 'New Lead',
    assigned_owner: 'Unassigned',
    lead_source: '',
    notes: '',
    estimated_deal_volume: '',
    estimated_emd_need: '',
    next_follow_up_at: '',
  });

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.primary_email.trim()) { setError('Email is required'); return; }
    setSaving(true);
    setError('');

    // Handle company
    let companyId: string | null = null;
    if (form.company_name.trim()) {
      const { data: existing } = await supabase
        .from('crm_companies')
        .select('id')
        .ilike('company_name', form.company_name.trim())
        .maybeSingle();
      if (existing) {
        companyId = existing.id;
      } else {
        const { data: newCo } = await supabase
          .from('crm_companies')
          .insert({ company_name: form.company_name.trim(), assigned_owner: 'Unassigned' })
          .select('id')
          .single();
        if (newCo) companyId = newCo.id;
      }
    }

    const { data, error: insertError } = await supabase
      .from('crm_contacts')
      .insert({
        first_name: form.first_name,
        last_name: form.last_name,
        primary_email: form.primary_email.toLowerCase().trim(),
        phone: form.phone || null,
        job_title: form.job_title || null,
        company_id: companyId,
        lead_status: form.lead_status,
        assigned_owner: form.assigned_owner,
        lead_source: form.lead_source || null,
        notes: form.notes || null,
        estimated_deal_volume: form.estimated_deal_volume ? parseFloat(form.estimated_deal_volume) : null,
        estimated_emd_need: form.estimated_emd_need ? parseFloat(form.estimated_emd_need) : null,
        next_follow_up_at: form.next_follow_up_at || null,
        portal_link_status: 'none',
        original_lead_source: form.lead_source || null,
      })
      .select('id')
      .single();

    if (insertError) {
      setError(insertError.message.includes('unique') ? 'A contact with this email already exists.' : insertError.message);
      setSaving(false);
      return;
    }

    // Log activity
    await supabase.from('crm_activities').insert({
      contact_id: data.id,
      event_type: 'contact_created',
      title: 'Contact created by Admin',
      actor: 'Admin',
    });

    router.push(`/admin/crm/contacts/${data.id}`);
  };

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-5">
      <div className="flex items-center gap-2 text-sm text-gray-400">
        <Link href="/admin/crm" className="hover:text-gray-600">CRM</Link>
        <span>/</span>
        <Link href="/admin/crm/contacts" className="hover:text-gray-600">Contacts</Link>
        <span>/</span>
        <span className="text-gray-700 font-500">New Contact</span>
      </div>

      <div>
        <h1 className="text-2xl font-700 text-gray-900 font-display">New Contact</h1>
        <p className="text-sm text-gray-500 mt-0.5">Create a CRM contact. No portal account required.</p>
      </div>

      <form onSubmit={handleSubmit} className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-600 text-gray-500 mb-1">First Name</label>
            <input type="text" value={form.first_name} onChange={(e) => set('first_name', e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20 focus:border-eb-green-500" />
          </div>
          <div>
            <label className="block text-xs font-600 text-gray-500 mb-1">Last Name</label>
            <input type="text" value={form.last_name} onChange={(e) => set('last_name', e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20 focus:border-eb-green-500" />
          </div>
        </div>

        <div>
          <label className="block text-xs font-600 text-gray-500 mb-1">Email <span className="text-red-500">*</span></label>
          <input type="email" required value={form.primary_email} onChange={(e) => set('primary_email', e.target.value)}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20 focus:border-eb-green-500" />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-600 text-gray-500 mb-1">Phone</label>
            <input type="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20 focus:border-eb-green-500" />
          </div>
          <div>
            <label className="block text-xs font-600 text-gray-500 mb-1">Job Title</label>
            <input type="text" value={form.job_title} onChange={(e) => set('job_title', e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20 focus:border-eb-green-500" />
          </div>
        </div>

        <div>
          <label className="block text-xs font-600 text-gray-500 mb-1">Company Name</label>
          <input type="text" value={form.company_name} onChange={(e) => set('company_name', e.target.value)}
            placeholder="Will match or create a company record"
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20 focus:border-eb-green-500" />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-600 text-gray-500 mb-1">Lead Status</label>
            <select value={form.lead_status} onChange={(e) => set('lead_status', e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none bg-white">
              {LEAD_STATUSES.map((s) => <option key={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-600 text-gray-500 mb-1">Assigned Owner</label>
            <select value={form.assigned_owner} onChange={(e) => set('assigned_owner', e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none bg-white">
              {OWNERS.map((o) => <option key={o}>{o}</option>)}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-600 text-gray-500 mb-1">Lead Source</label>
            <input type="text" value={form.lead_source} onChange={(e) => set('lead_source', e.target.value)}
              placeholder="e.g. Referral, BPCON26, Website"
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20 focus:border-eb-green-500" />
          </div>
          <div>
            <label className="block text-xs font-600 text-gray-500 mb-1">Next Follow-Up</label>
            <input type="date" value={form.next_follow_up_at} onChange={(e) => set('next_follow_up_at', e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-600 text-gray-500 mb-1">Est. Deal Volume ($)</label>
            <input type="number" value={form.estimated_deal_volume} onChange={(e) => set('estimated_deal_volume', e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20 focus:border-eb-green-500" />
          </div>
          <div>
            <label className="block text-xs font-600 text-gray-500 mb-1">Est. EMD Need ($)</label>
            <input type="number" value={form.estimated_emd_need} onChange={(e) => set('estimated_emd_need', e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20 focus:border-eb-green-500" />
          </div>
        </div>

        <div>
          <label className="block text-xs font-600 text-gray-500 mb-1">Notes</label>
          <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={3}
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-eb-green-500/20 focus:border-eb-green-500 resize-none" />
        </div>

        <div className="flex gap-3 pt-2">
          <button type="submit" disabled={saving}
            className="flex-1 py-2.5 bg-eb-green-700 text-white text-sm font-600 rounded-lg hover:bg-eb-green-800 disabled:opacity-40 transition-colors">
            {saving ? 'Creating…' : 'Create Contact'}
          </button>
          <Link href="/admin/crm/contacts"
            className="px-6 py-2.5 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors text-center">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
