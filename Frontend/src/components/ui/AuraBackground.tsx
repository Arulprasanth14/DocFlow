/**
 * AuraBackground — kept as a thin alias of LivingBackground for backward compatibility.
 * New code should import { LivingBackground } directly. The living background is now mounted
 * ONCE at the app shell (AppLayout), so pages no longer need their own copy.
 */

export { LivingBackground as AuraBackground, LivingBackground, default } from './LivingBackground';
