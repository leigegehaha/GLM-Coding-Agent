import { CodeBracketIcon } from '@heroicons/react/24/outline';
import React, { useState } from 'react';

import { i18nService } from '../../services/i18n';
import Tooltip, { TooltipAlign, TooltipPosition } from '../ui/Tooltip';

interface CodingOptimizationControlProps {
  enabled: boolean;
  disabled?: boolean;
  compact?: boolean;
  onChange: (enabled: boolean) => boolean | void | Promise<boolean | void>;
}

const CodingOptimizationControl: React.FC<CodingOptimizationControlProps> = ({
  enabled,
  disabled = false,
  compact = false,
  onChange,
}) => {
  const [isUpdating, setIsUpdating] = useState(false);
  const nextActionLabel = i18nService.t(
    enabled ? 'coworkCodingOptimizationDisable' : 'coworkCodingOptimizationEnable',
  );
  const modeHint = i18nService.t(
    enabled
      ? 'coworkCodingOptimizationEnabledHint'
      : 'coworkCodingOptimizationDisabledHint',
  );

  const handleClick = async (): Promise<void> => {
    if (disabled || isUpdating) return;
    setIsUpdating(true);
    try {
      const result = await onChange(!enabled);
      if (result === false) {
        window.dispatchEvent(new CustomEvent('app:showToast', {
          detail: i18nService.t('coworkCodingOptimizationUpdateFailed'),
        }));
      }
    } catch (error) {
      console.warn('[CodingOptimizationControl] Failed to update coding optimization:', error);
      window.dispatchEvent(new CustomEvent('app:showToast', {
        detail: i18nService.t('coworkCodingOptimizationUpdateFailed'),
      }));
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <Tooltip
      content={modeHint}
      position={TooltipPosition.Top}
      align={TooltipAlign.End}
      delay={250}
      maxWidth="20rem"
      multiline
      className="shrink-0"
    >
      <button
        type="button"
        onClick={() => void handleClick()}
        disabled={disabled || isUpdating}
        className={`flex items-center justify-center gap-1 rounded-lg px-2 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
          compact ? 'h-7' : 'h-8'
        } ${
          enabled
            ? 'bg-primary/10 text-primary hover:bg-primary/15'
            : 'text-secondary hover:bg-surface-raised hover:text-foreground'
        }`}
        aria-label={nextActionLabel}
        aria-pressed={enabled}
      >
        <CodeBracketIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="whitespace-nowrap">
          {i18nService.t('coworkCodingOptimization')}
        </span>
      </button>
    </Tooltip>
  );
};

export default CodingOptimizationControl;
