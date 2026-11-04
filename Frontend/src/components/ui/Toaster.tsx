/**
 * DocFlow Frontend — Toaster (sonner, themed to "Ice").
 * The single app-wide toast surface. Mounted once in AppLayout.
 * Fire toasts anywhere via `import { toast } from 'sonner'`.
 */

import { Toaster as SonnerToaster } from 'sonner';
import { useUIStore } from '@/store/uiStore';

export function Toaster() {
  const theme = useUIStore((s) => s.theme);

  return (
    <SonnerToaster
      theme={theme}
      position="bottom-right"
      closeButton
      toastOptions={{
        style: {
          background: 'var(--popover)',
          color: 'var(--popover-foreground)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          boxShadow: 'var(--shadow-lg)',
        },
      }}
    />
  );
}

export default Toaster;
