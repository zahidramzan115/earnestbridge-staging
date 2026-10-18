'use client';
import React from 'react';
import Icon from '@/components/ui/AppIcon';
import { useAuth } from '@/contexts/AuthContext';

export default function PortalAccessDisabledScreen() {
  const { signOut } = useAuth();

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="max-w-md w-full text-center">
        <div className="flex items-center justify-center w-20 h-20 rounded-2xl bg-red-100 mx-auto mb-6">
          <Icon name="LockClosedIcon" size={36} className="text-red-500" />
        </div>

        <h1 className="font-display font-700 text-2xl text-gray-900 mb-3">
          Portal Access Disabled
        </h1>

        <p className="text-gray-500 text-sm leading-relaxed mb-8">
          Portal access has been disabled. Please contact EarnestBridge for assistance.
        </p>

        <a
          href="mailto:deals@earnestbridge.com"
          className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-eb-green-900 text-white text-sm font-medium hover:bg-eb-green-800 transition-colors mb-4"
        >
          <Icon name="EnvelopeIcon" size={16} />
          Contact EarnestBridge: deals@earnestbridge.com
        </a>

        <div className="mt-4">
          <button
            onClick={() => signOut()}
            className="text-xs text-gray-400 hover:text-gray-600 transition-colors underline underline-offset-2"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
