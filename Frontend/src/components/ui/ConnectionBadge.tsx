/**
 * DocFlow Frontend — Shared Component: ConnectionBadge
 * Displays the WebSocket connection status in an unobtrusive pill badge.
 * Used in both ChatPage and WorkflowChatPanel.
 */
import { Wifi, WifiOff, Loader2 } from 'lucide-react';
import type { ConnectionStatus } from '@/hooks/useChatWebSocket';

interface Props {
  status: ConnectionStatus;
}

const STATUS_CONFIG: Record<ConnectionStatus, { color: string; label: string; animated?: boolean }> = {
  connected:     { color: 'var(--color-success-400)', label: 'Live' },
  connecting:    { color: 'var(--color-warning-400)', label: 'Connecting…', animated: true },
  reconnecting:  { color: 'var(--color-warning-400)', label: 'Reconnecting…', animated: true },
  disconnected:  { color: 'var(--color-error-400)',   label: 'Offline' },
};

export function ConnectionBadge({ status }: Props) {
  const cfg = STATUS_CONFIG[status];
  const Icon = cfg.animated ? Loader2 : status === 'disconnected' ? WifiOff : Wifi;

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 5,
      padding: '3px 9px', borderRadius: 99,
      background: `color-mix(in srgb, ${cfg.color} 12%, transparent)`,
      border: `1px solid color-mix(in srgb, ${cfg.color} 25%, transparent)`,
    }}>
      <Icon
        size={11}
        color={cfg.color}
        style={cfg.animated ? { animation: 'spin 1s linear infinite' } : undefined}
      />
      <span style={{ fontSize: 11, fontWeight: 600, color: cfg.color }}>{cfg.label}</span>
    </div>
  );
}
