import { CheckIcon, ChevronDownIcon, LightBulbIcon } from '@heroicons/react/24/outline';
import {
  ModelThinkingLevel,
  type ModelThinkingLevelOption,
  normalizeThinkingLevelForProfile,
  resolveModelThinkingProfile,
} from '@shared/providers';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import { OpenClawSessionReasoningLevel } from '../../../common/openclawSession';
import { coworkService } from '../../services/cowork';
import { i18nService } from '../../services/i18n';
import type { Model } from '../../store/slices/modelSlice';

interface ThinkingModeControlProps {
  sessionId?: string;
  model: Model | null;
  disabled?: boolean;
  compact?: boolean;
  initialLevel?: ModelThinkingLevel;
  onLevelChange?: (level: ModelThinkingLevel) => void;
}

const getLevelLabel = (level: ModelThinkingLevelOption): string => {
  if (level.label === 'on') {
    return i18nService.t('coworkThinkingLevelOn');
  }
  if (level.label === 'max') {
    return i18nService.t('coworkThinkingLevelMax');
  }
  const keyByLevel: Record<ModelThinkingLevel, string> = {
    [ModelThinkingLevel.Off]: 'coworkThinkingLevelOff',
    [ModelThinkingLevel.Minimal]: 'coworkThinkingLevelMinimal',
    [ModelThinkingLevel.Low]: 'coworkThinkingLevelLow',
    [ModelThinkingLevel.Medium]: 'coworkThinkingLevelMedium',
    [ModelThinkingLevel.High]: 'coworkThinkingLevelHigh',
    [ModelThinkingLevel.XHigh]: 'coworkThinkingLevelXHigh',
    [ModelThinkingLevel.Adaptive]: 'coworkThinkingLevelAdaptive',
    [ModelThinkingLevel.Max]: 'coworkThinkingLevelMax',
  };
  return i18nService.t(keyByLevel[level.id]);
};

const ThinkingModeControl: React.FC<ThinkingModeControlProps> = ({
  sessionId,
  model,
  disabled = false,
  compact = false,
  initialLevel,
  onLevelChange,
}) => {
  const profile = useMemo(
    () => resolveModelThinkingProfile(model?.id ?? '', model?.supportsThinking === true),
    [model?.id, model?.supportsThinking],
  );
  const [selectedLevel, setSelectedLevel] = useState<ModelThinkingLevel>(
    () => initialLevel ?? profile?.defaultLevel ?? ModelThinkingLevel.Off,
  );
  const [isOpen, setIsOpen] = useState(false);
  const [isPatching, setIsPatching] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const previousSessionIdRef = useRef(sessionId);
  const requestIdRef = useRef(0);
  const initialLevelRef = useRef(initialLevel);
  const onLevelChangeRef = useRef(onLevelChange);

  useEffect(() => {
    initialLevelRef.current = initialLevel;
  }, [initialLevel]);

  useEffect(() => {
    onLevelChangeRef.current = onLevelChange;
  }, [onLevelChange]);

  useEffect(() => {
    requestIdRef.current += 1;
    setIsPatching(false);
    setIsOpen(false);
    if (!profile) {
      setSelectedLevel(ModelThinkingLevel.Off);
    } else if (previousSessionIdRef.current !== sessionId) {
      setSelectedLevel(initialLevelRef.current
        ? normalizeThinkingLevelForProfile(initialLevelRef.current, profile)
        : profile.defaultLevel);
    } else {
      setSelectedLevel(current => normalizeThinkingLevelForProfile(current, profile));
    }
    previousSessionIdRef.current = sessionId;
  }, [model?.id, profile, sessionId]);

  useEffect(() => {
    if (profile) {
      onLevelChangeRef.current?.(selectedLevel);
    }
  }, [profile, selectedLevel]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isOpen]);

  if (!profile) {
    return null;
  }

  const selectedOption = profile.levels.find(level => level.id === selectedLevel)
    ?? profile.levels[0];
  const selectedLabel = getLevelLabel(selectedOption);
  const buttonLabel = i18nService.t('coworkThinkingModeWithLevel')
    .replace('{level}', selectedLabel);
  const controlDisabled = disabled || isPatching;

  const handleSelect = async (nextLevel: ModelThinkingLevel): Promise<void> => {
    if (controlDisabled || nextLevel === selectedLevel) {
      setIsOpen(false);
      return;
    }
    const previousLevel = selectedLevel;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setSelectedLevel(nextLevel);
    setIsOpen(false);
    if (!sessionId) {
      return;
    }
    setIsPatching(true);
    try {
      const patchedSession = await coworkService.patchSession(sessionId, {
        thinkingLevel: nextLevel,
        reasoningLevel: OpenClawSessionReasoningLevel.Stream,
      });
      if (requestId === requestIdRef.current && !patchedSession) {
        setSelectedLevel(previousLevel);
        window.dispatchEvent(new CustomEvent('app:showToast', {
          detail: i18nService.t('coworkThinkingUpdateFailed'),
        }));
      }
    } catch (error) {
      if (requestId === requestIdRef.current) {
        setSelectedLevel(previousLevel);
        console.warn('[ThinkingModeControl] Failed to update session thinking level:', error);
        window.dispatchEvent(new CustomEvent('app:showToast', {
          detail: i18nService.t('coworkThinkingUpdateFailed'),
        }));
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setIsPatching(false);
      }
    }
  };

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setIsOpen(open => !open)}
        disabled={controlDisabled}
        className={`flex items-center gap-1 rounded-lg text-secondary transition-colors hover:bg-surface-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 ${
          compact ? 'h-7 px-1.5 text-xs' : 'h-8 px-2 text-xs'
        } ${selectedLevel !== ModelThinkingLevel.Off ? 'bg-primary/10 text-primary' : ''}`}
        aria-label={buttonLabel}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        title={buttonLabel}
      >
        <LightBulbIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="max-w-16 truncate">{selectedLabel}</span>
        <ChevronDownIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
      </button>
      {isOpen && (
        <div
          className="absolute bottom-full right-0 z-50 mb-1 min-w-36 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-popover"
          role="menu"
          aria-label={i18nService.t('coworkThinkingMode')}
        >
          {profile.levels.map(level => {
            const isSelected = level.id === selectedLevel;
            return (
              <button
                key={level.id}
                type="button"
                onClick={() => void handleSelect(level.id)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-surface-raised ${
                  isSelected ? 'text-primary' : 'text-foreground'
                }`}
                role="menuitemradio"
                aria-checked={isSelected}
              >
                <span className="min-w-0 flex-1 truncate">{getLevelLabel(level)}</span>
                {isSelected && <CheckIcon className="h-4 w-4 shrink-0" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ThinkingModeControl;
