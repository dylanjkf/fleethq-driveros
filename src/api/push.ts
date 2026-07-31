import { apiClient } from './client';

export async function getVapidPublicKey(): Promise<string | null> {
  const { data } = await apiClient.get<{ publicKey: string | null }>('/v1/push/vapid-public-key');
  return data.publicKey;
}

export async function subscribePush(subscription: PushSubscriptionJSON): Promise<void> {
  await apiClient.post('/v1/push/subscribe', subscription);
}

export async function unsubscribePush(endpoint: string): Promise<void> {
  await apiClient.post('/v1/push/unsubscribe', { endpoint });
}
