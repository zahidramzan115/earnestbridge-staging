'use client';
import React from 'react';
import { MILESTONE_STEPS } from '@/lib/mockData';

interface MilestoneStepperProps {
  currentStep: number; // 0-8 (step index)
}

export default function MilestoneStepper({ currentStep }: MilestoneStepperProps) {
  const totalSteps = MILESTONE_STEPS.length;
  const clampedStep = Math.min(currentStep, totalSteps - 1);
  const progressPct = Math.round((clampedStep / (totalSteps - 1)) * 100);
  const currentStepLabel = MILESTONE_STEPS[clampedStep]?.label ?? '';
  const currentPhase = MILESTONE_STEPS[clampedStep]?.phase ?? '';

  return (
    <div className="bg-white rounded-2xl shadow-card border border-gray-100 p-4 sm:p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="min-w-0">
          <h3 className="font-display font-600 text-gray-900 text-sm">Application Progress</h3>
          <p className="text-xs text-gray-400 mt-0.5 truncate">
            {currentPhase}: {currentStepLabel}
          </p>
        </div>
        <span className="text-sm font-display font-700 text-eb-green-900 tabular-nums flex-shrink-0 ml-3">
          {progressPct}%
        </span>
      </div>

      {/* Progress bar */}
      <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
        <div
          className="h-full bg-eb-green-900 rounded-full transition-all duration-500"
          style={{ width: `${progressPct}%` }}
        />
      </div>

      {/* Step counter */}
      <p className="text-[11px] text-gray-400 mt-2 tabular-nums">
        Step {clampedStep + 1} of {totalSteps}
      </p>
    </div>
  );
}