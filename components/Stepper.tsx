
import React from 'react';
import { Step } from '../types';

interface StepperProps {
  currentStep: Step;
}

const steps = [
  { label: '招集通知解析', icon: '1' },
  { label: 'ガイドライン抽出', icon: '2' },
  { label: '事実抽出', icon: '3' },
  { label: '総合判断', icon: '4' },
  { label: 'エクスポート', icon: '5' },
];

export const Stepper: React.FC<StepperProps> = ({ currentStep }) => {
  return (
    <div className="flex items-center justify-between w-full mb-12 px-4">
      {steps.map((step, index) => (
        <React.Fragment key={index}>
          <div className="flex flex-col items-center relative z-10">
            <div className={`
              w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm
              transition-all duration-300
              ${index <= currentStep ? 'bg-blue-600 text-white shadow-lg' : 'bg-gray-200 text-gray-500'}
            `}>
              {step.icon}
            </div>
            <span className={`mt-2 text-xs font-medium ${index <= currentStep ? 'text-blue-700' : 'text-gray-400'}`}>
              {step.label}
            </span>
          </div>
          {index < steps.length - 1 && (
            <div className={`flex-1 h-0.5 mx-4 transition-all duration-500 ${index < currentStep ? 'bg-blue-600' : 'bg-gray-200'}`} />
          )}
        </React.Fragment>
      ))}
    </div>
  );
};
