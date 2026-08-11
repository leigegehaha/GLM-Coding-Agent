import React, { useCallback, useEffect } from 'react';

import ComposeIcon from '../icons/ComposeIcon';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import WindowTitleBar from './WindowTitleBar';

interface WindowsAppTitleBarProps {
  isOverlayActive?: boolean;
  isSidebarCollapsed?: boolean;
  sidebarWidth?: number;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  sidebarToggleLabel?: string;
  newChatLabel?: string;
  updateBadge?: React.ReactNode;
}

const WindowsAppTitleBar: React.FC<WindowsAppTitleBarProps> = ({
  isOverlayActive = false,
  isSidebarCollapsed = false,
  sidebarWidth = 244,
  onToggleSidebar,
  onNewChat,
  sidebarToggleLabel,
  newChatLabel,
  updateBadge,
}) => {
  useEffect(() => {
    if (window.electron.platform !== 'win32') return;

    const message = 'Windows app title bar mounted';
    console.debug(`[WindowsAppTitleBar] ${message}`);
    try {
      window.electron?.log?.fromRenderer?.('debug', 'WindowsAppTitleBar', message);
    } catch {
      // Best-effort diagnostic only.
    }
  }, []);

  const handleNewChatClick = useCallback(() => {
    const message = `new chat requested from top bar isSidebarCollapsed=${isSidebarCollapsed}`;
    console.debug(`[WindowsAppTitleBar] ${message}`);
    try {
      window.electron?.log?.fromRenderer?.('debug', 'WindowsAppTitleBar', message);
    } catch {
      // Best-effort diagnostic only.
    }
    onNewChat?.();
  }, [isSidebarCollapsed, onNewChat]);

  if (window.electron.platform !== 'win32') {
    return null;
  }

  return (
    <div
      data-skin-app-titlebar="true"
      className="draggable flex h-9 shrink-0 items-center justify-between border-b border-border bg-surface-raised pl-3"
    >
      <div
        className={`flex h-full shrink-0 items-center ${isSidebarCollapsed ? 'gap-1' : 'justify-between'}`}
        style={isSidebarCollapsed ? undefined : { width: Math.max(0, sidebarWidth - 24) }}
      >
        <div className="flex shrink-0 items-center gap-2">
          <img
            src="logo.png"
            alt=""
            draggable={false}
            className="h-4 w-4 max-w-none shrink-0"
          />
          <span className={`${isSidebarCollapsed ? 'hidden' : 'truncate'} text-sm font-medium text-foreground`}>
            智码 GLM Code
          </span>
        </div>
        {(onToggleSidebar || onNewChat || updateBadge) && (
          <div className="non-draggable flex shrink-0 items-center gap-1">
            {onToggleSidebar && (
              <button
                type="button"
                onClick={onToggleSidebar}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:bg-surface transition-colors"
                aria-label={sidebarToggleLabel}
                title={sidebarToggleLabel}
              >
                <SidebarToggleIcon className="h-4 w-4" isCollapsed={isSidebarCollapsed} />
              </button>
            )}
            {onNewChat && (
              <button
                type="button"
                onClick={handleNewChatClick}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg text-secondary hover:bg-surface transition-colors"
                aria-label={newChatLabel}
                title={newChatLabel}
              >
                <ComposeIcon className="h-4 w-4" />
              </button>
            )}
            {updateBadge}
          </div>
        )}
      </div>
      <WindowTitleBar inline isOverlayActive={isOverlayActive} />
    </div>
  );
};

export default WindowsAppTitleBar;
