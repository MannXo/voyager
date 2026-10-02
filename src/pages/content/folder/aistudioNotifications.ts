export type NotificationLevel = 'info' | 'warning' | 'error';
export type AIStudioNotify = (message: string, level?: NotificationLevel) => void;

const COLORS: Record<NotificationLevel, string> = {
  info: '#2196F3',
  warning: '#FF9800',
  error: '#f44336',
};
const TIMEOUT_MS: Record<NotificationLevel, number> = { info: 3000, warning: 7000, error: 5000 };

/** A self-removing toast in the top-right corner; errors and warnings stay longer. */
export const showAIStudioNotification: AIStudioNotify = (message, level = 'error') => {
  try {
    const notification = document.createElement('div');
    notification.className = `gv-notification gv-notification-${level}`;
    notification.textContent = `[Gemini Voyager] ${message}`;
    Object.assign(notification.style, {
      position: 'fixed',
      top: '20px',
      right: '20px',
      padding: '12px 20px',
      background: COLORS[level],
      color: 'white',
      borderRadius: '4px',
      boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
      zIndex: String(2147483647),
      maxWidth: '400px',
      fontSize: '14px',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      lineHeight: '1.4',
    });
    document.body.appendChild(notification);
    setTimeout(() => notification.remove(), TIMEOUT_MS[level]);
  } catch (error) {
    console.error('[AIStudioFolderManager] Failed to show notification:', error);
  }
};
