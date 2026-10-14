'use client';
import React, { useState, useRef, useEffect, useCallback } from 'react';
import Link from 'next/link';
import Icon from '@/components/ui/AppIcon';

interface SearchResult {
  type: 'contact' | 'company' | 'deal';
  id: string;
  title: string;
  subtitle: string;
  meta: string;
  href: string;
}

const TYPE_ICONS: Record<string, string> = {
  contact: 'UserCircleIcon',
  company: 'BuildingOfficeIcon',
  deal:    'BriefcaseIcon',
};

const TYPE_COLORS: Record<string, string> = {
  contact: 'text-blue-600 bg-blue-50',
  company: 'text-purple-600 bg-purple-50',
  deal:    'text-emerald-600 bg-emerald-50',
};

export default function CRMGlobalSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = useCallback(async (q: string) => {
    if (q.length < 2) { setResults([]); setOpen(false); return; }
    setLoading(true);
    try {
      const res = await fetch(`/api/crm/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      setResults(data.results || []);
      setOpen(true);
    } catch {
      setResults([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(query), 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, search]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  return (
    <div ref={containerRef} className="relative w-full max-w-xs">
      <div className="relative">
        <Icon name="MagnifyingGlassIcon" size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-eb-green-300" />
        <input
          ref={inputRef}
          type="text"
          placeholder="Search CRM…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onFocus={() => results.length > 0 && setOpen(true)}
          className="w-full pl-8 pr-3 py-1.5 text-xs bg-white/10 border border-white/10 rounded-lg text-white placeholder-eb-green-300 focus:outline-none focus:bg-white/15 focus:border-white/20 transition-all"
        />
        {loading && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            <div className="w-3 h-3 border border-eb-green-300 border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>

      {open && results.length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-white rounded-xl shadow-2xl border border-gray-200 overflow-hidden z-50 max-h-80 overflow-y-auto">
          {results.map(r => (
            <Link
              key={`${r.type}-${r.id}`}
              href={r.href}
              onClick={() => { setOpen(false); setQuery(''); }}
              className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 transition-colors border-b border-gray-50 last:border-0"
            >
              <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${TYPE_COLORS[r.type]}`}>
                <Icon name={TYPE_ICONS[r.type] as Parameters<typeof Icon>[0]['name']} size={13} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-600 text-gray-800 truncate">{r.title}</p>
                <p className="text-xs text-gray-400 truncate">{r.subtitle}</p>
              </div>
              <span className="text-[10px] text-gray-400 capitalize flex-shrink-0">{r.type}</span>
            </Link>
          ))}
        </div>
      )}

      {open && query.length >= 2 && results.length === 0 && !loading && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-white rounded-xl shadow-2xl border border-gray-200 px-4 py-3 z-50">
          <p className="text-xs text-gray-400">No results for "{query}"</p>
        </div>
      )}
    </div>
  );
}
