'use client';
import React from 'react';

interface ToggleProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  label?: string;
  description?: string;
  disabled?: boolean;
}

export default function Toggle({ checked, onChange, label, description, disabled }: ToggleProps) {
  return (
    <label className={`flex items-start gap-3 cursor-pointer ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}>
      <div className="relative flex-shrink-0 mt-0.5">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => !disabled && onChange(e.target.checked)}
          className="sr-only"
          disabled={disabled}
        />
        <div
          onClick={() => !disabled && onChange(!checked)}
          className={`w-9 h-5 rounded-full transition-colors duration-200 ${checked ? 'bg-eb-green-900' : 'bg-gray-200'}`}
        />
        <div
          onClick={() => !disabled && onChange(!checked)}
          className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow-sm transition-transform duration-200 ${checked ? 'translate-x-4' : 'translate-x-0'}`}
        />
      </div>
      {(label || description) && (
        <div>
          {label && <p className="text-sm font-medium text-gray-900">{label}</p>}
          {description && <p className="text-xs text-gray-500 mt-0.5">{description}</p>}
        </div>
      )}
    </label>
  );
}