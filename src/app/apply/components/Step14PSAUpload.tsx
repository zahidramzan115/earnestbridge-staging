'use client';
import React, { useState, useRef } from 'react';
import { ApplicationFormData } from './BorrowerApplicationForm';
import Icon from '@/components/ui/AppIcon';

interface Props {
  data: ApplicationFormData;
  onComplete: (updates: Partial<ApplicationFormData>) => void;
  onBack: () => void;
}

interface TooltipProps {
  text: string;
}

function Tooltip({ text }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  return (
    <span className="relative inline-flex items-center ml-1.5">
      <button
        type="button"
        onMouseEnter={() => setVisible(true)}
        onMouseLeave={() => setVisible(false)}
        onFocus={() => setVisible(true)}
        onBlur={() => setVisible(false)}
        className="text-gray-400 hover:text-eb-green-800 transition-colors focus:outline-none"
        aria-label="More information"
      >
        <Icon name="InformationCircleIcon" size={15} />
      </button>
      {visible && (
        <span className="absolute z-20 bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 bg-gray-900 text-white text-xs rounded-lg px-3 py-2 shadow-lg pointer-events-none leading-relaxed">
          {text}
          <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-900" />
        </span>
      )}
    </span>
  );
}

interface FileUploadZoneProps {
  file: File | null;
  fileName: string;
  onFile: (f: File) => void;
  onRemove: () => void;
  error: string;
  existingUrl?: string;
}

function FileUploadZone({ file, fileName, onFile, onRemove, error, existingUrl }: FileUploadZoneProps) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const ACCEPTED = ['.pdf', '.doc', '.docx'];
  const MAX_MB = 25;

  const handleFile = (f: File) => {
    const ext = '.' + f.name.split('.').pop()?.toLowerCase();
    if (!ACCEPTED.includes(ext)) return;
    if (f.size > MAX_MB * 1024 * 1024) return;
    onFile(f);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  };

  const hasFile = file || existingUrl;

  return (
    <>
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        className={`relative border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all
          ${dragOver ? 'border-eb-green-700 bg-eb-green-900/5' : hasFile ? 'border-eb-green-600 bg-eb-green-900/5' : 'border-gray-300 hover:border-eb-green-600 hover:bg-gray-50'}`}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.doc,.docx"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
        />
        {file ? (
          <div className="flex flex-col items-center gap-2">
            <div className="w-10 h-10 rounded-xl bg-eb-green-900/10 flex items-center justify-center">
              <Icon name="DocumentCheckIcon" size={22} className="text-eb-green-800" />
            </div>
            <div>
              <p className="font-600 text-gray-900 text-sm">{fileName}</p>
              <p className="text-xs text-gray-500 mt-0.5">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
            </div>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onRemove(); }}
              className="text-xs text-red-600 hover:text-red-700 font-medium flex items-center gap-1"
            >
              <Icon name="XMarkIcon" size={12} /> Remove file
            </button>
          </div>
        ) : existingUrl ? (
          <div className="flex flex-col items-center gap-2">
            <div className="w-10 h-10 rounded-xl bg-eb-green-900/10 flex items-center justify-center">
              <Icon name="DocumentCheckIcon" size={22} className="text-eb-green-800" />
            </div>
            <p className="font-600 text-gray-700 text-sm">File already uploaded</p>
            <p className="text-xs text-gray-400">Click to replace</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center">
              <Icon name="CloudArrowUpIcon" size={22} className="text-gray-400" />
            </div>
            <div>
              <p className="font-600 text-gray-700 text-sm">Drop file here, or <span className="text-eb-green-800 underline">browse</span></p>
              <p className="text-xs text-gray-400 mt-1">PDF, DOC, DOCX — up to {MAX_MB}MB</p>
            </div>
          </div>
        )}
      </div>
      {error && (
        <p className="text-xs text-red-600 flex items-center gap-1 mt-1.5">
          <Icon name="ExclamationCircleIcon" size={12} /> {error}
        </p>
      )}
    </>
  );
}

export default function Step14PSAUpload({ data, onComplete, onBack }: Props) {
  const [loiFile, setLoiFile] = useState<File | null>(data.loiFile ?? null);
  const [loiFileName, setLoiFileName] = useState(data.loiFileName ?? '');
  const [psaFile, setPsaFile] = useState<File | null>(data.psaFile);
  const [psaFileName, setPsaFileName] = useState(data.psaFileName);
  const [loiError, setLoiError] = useState('');
  const [psaError, setPsaError] = useState('');

  const ACCEPTED = ['.pdf', '.doc', '.docx'];
  const MAX_MB = 25;

  const validateFile = (f: File): string => {
    const ext = '.' + f.name.split('.').pop()?.toLowerCase();
    if (!ACCEPTED.includes(ext)) return 'Only PDF, DOC, or DOCX files are accepted.';
    if (f.size > MAX_MB * 1024 * 1024) return `File must be under ${MAX_MB}MB.`;
    return '';
  };

  const handleLoiFile = (f: File) => {
    const err = validateFile(f);
    if (err) { setLoiError(err); return; }
    setLoiError('');
    setLoiFile(f);
    setLoiFileName(f.name);
  };

  const handlePsaFile = (f: File) => {
    const err = validateFile(f);
    if (err) { setPsaError(err); return; }
    setPsaError('');
    setPsaFile(f);
    setPsaFileName(f.name);
  };

  const handleContinue = () => {
    if (!loiFile && !data.loiFileUrl) {
      setLoiError('Please upload your signed LOI before continuing.');
      return;
    }

    // Fire-and-forget email notifications
    if (loiFile && data.email) {
      fetch('/api/send-document-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          borrowerEmail: data.email,
          borrowerFirstName: data.firstName,
          borrowerLastName: data.lastName,
          documentName: loiFileName || loiFile.name,
          documentType: 'Letter of Intent (LOI)',
          propertyAddress: data.propertyAddress || '',
        }),
      }).catch(() => {});
    }

    onComplete({
      loiFile,
      loiFileName,
      loiFileUrl: data.loiFileUrl,
      psaFile,
      psaFileName,
      psaFileUrl: data.psaFileUrl,
    });
  };

  return (
    <div>
      <div className="px-6 py-5 border-b border-gray-100">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-eb-green-900/10 flex items-center justify-center">
            <Icon name="DocumentArrowUpIcon" size={18} className="text-eb-green-800" />
          </div>
          <div>
            <h2 className="font-display font-700 text-gray-900 text-base">Document Upload</h2>
            <p className="text-xs text-gray-500 mt-0.5">Step 1.4 — Upload your LOI and optionally your PSA</p>
          </div>
        </div>
      </div>

      <div className="px-6 py-6 space-y-7">

        {/* LOI Upload — Required */}
        <div>
          <div className="flex items-center mb-2">
            <span className="text-sm font-700 text-gray-900">Letter of Intent (LOI)</span>
            <span className="ml-2 text-xs font-600 text-red-600 bg-red-50 border border-red-200 rounded-full px-2 py-0.5">Required</span>
            <Tooltip text="Signed LOI is required to for EMD Program approval" />
          </div>
          <FileUploadZone
            file={loiFile}
            fileName={loiFileName}
            onFile={handleLoiFile}
            onRemove={() => { setLoiFile(null); setLoiFileName(''); }}
            error={loiError}
            existingUrl={data.loiFileUrl}
          />
        </div>

        {/* PSA Upload — Optional */}
        <div>
          <div className="flex items-center mb-2">
            <span className="text-sm font-700 text-gray-900">Purchase & Sale Agreement (PSA)</span>
            <span className="ml-2 text-xs font-600 text-gray-500 bg-gray-100 border border-gray-200 rounded-full px-2 py-0.5">Optional</span>
            <Tooltip text="PSA is optional, our Legal Team can work with existing PSA or start from scratch." />
          </div>
          <FileUploadZone
            file={psaFile}
            fileName={psaFileName}
            onFile={handlePsaFile}
            onRemove={() => { setPsaFile(null); setPsaFileName(''); }}
            error={psaError}
            existingUrl={data.psaFileUrl}
          />
        </div>

      </div>

      <div className="px-6 py-4 bg-gray-50 border-t border-gray-100 flex justify-between">
        <button type="button" onClick={onBack} className="flex items-center gap-2 px-5 py-2.5 border border-gray-300 text-gray-700 text-sm font-600 rounded-lg hover:bg-gray-100 transition-colors">
          <Icon name="ArrowLeftIcon" size={15} /> Back
        </button>
        <button type="button" onClick={handleContinue} className="flex items-center gap-2 px-6 py-2.5 bg-eb-green-900 text-white text-sm font-600 rounded-lg hover:bg-eb-green-800 transition-colors">
          Continue <Icon name="ArrowRightIcon" size={15} />
        </button>
      </div>
    </div>
  );
}
