// LinkRay analytics middleware disabled temporarily.
// It must not intercept /start or main autoposting callbacks.

export async function handleLinkRayChannelAnalyticsIncoming(...args) { return false; }
export function mountLinkRayChannelAnalytics(...args) { console.log('[LinkRay channel analytics] middleware disabled'); return false; }
export function startDailyWorker(...args) { console.log('[LinkRay channel analytics] worker disabled'); return false; }
export function startLinkRayChannelAnalyticsDailyWorker(...args) { console.log('[LinkRay channel analytics] worker disabled'); return false; }

export default {};
