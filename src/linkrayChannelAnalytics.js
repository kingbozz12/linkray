// LinkRay channel analytics is disabled as middleware.
// It must not intercept /start, main menu, forwarded posts or autoposting callbacks.
export function mountLinkRayChannelAnalytics() {
  console.log('[LinkRay channel analytics] middleware disabled');
  return false;
}
export async function handleLinkRayChannelAnalyticsIncoming() {
  return false;
}
export function startLinkRayChannelAnalyticsDailyWorker() {
  console.log('[LinkRay channel analytics] daily worker disabled');
  return false;
}
export function startDailyWorker() {
  console.log('[LinkRay channel analytics] daily worker disabled');
  return false;
}
export default {};
