import { getVapidPublicKey, subscribePush, unsubscribePush } from '@/api/push';

function urlBase64ToUint8Array(base64: string): BufferSource {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const base64Safe = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64Safe);
  const bytes = new ArrayBuffer(raw.length);
  const view = new Uint8Array(bytes);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return bytes;
}

export function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window;
}

/** True only in a secure context (https, or http on localhost). Push + service workers require this. */
export function isSecureForPush(): boolean {
  return window.isSecureContext;
}

export async function getPushSubscriptionState(): Promise<'subscribed' | 'unsubscribed' | 'unsupported'> {
  if (!isPushSupported()) return 'unsupported';
  const registration = await navigator.serviceWorker.getRegistration();
  const existing = await registration?.pushManager.getSubscription();
  return existing ? 'subscribed' : 'unsubscribed';
}

/** Registers the service worker, requests permission, subscribes, and tells the backend. */
export async function enablePushNotifications(): Promise<void> {
  if (!isPushSupported()) throw new Error('Push notifications are not supported on this device.');
  if (!isSecureForPush()) {
    throw new Error('Notifications need a secure connection — open DriverOS over https (or localhost during development).');
  }

  const permission = await Notification.requestPermission();
  if (permission === 'denied') throw new Error('Notifications are blocked. Allow them in your browser’s site settings, then try again.');
  if (permission !== 'granted') throw new Error('Notification permission was not granted.');

  const publicKey = await getVapidPublicKey();
  if (!publicKey) throw new Error('Notifications aren’t configured on the server yet.');

  const registration = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  await subscribePush(subscription.toJSON() as PushSubscriptionJSON);
}

export async function disablePushNotifications(): Promise<void> {
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;
  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  await unsubscribePush(endpoint);
}
