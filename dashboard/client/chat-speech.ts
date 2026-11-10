import { reactive } from 'vue';
import type { BackgroundSpeechStatus } from '../server/types.js';

export const speechState = reactive<BackgroundSpeechStatus & { changing: boolean }>({
  supported: false, loading: true, voiceName: '声音4', voiceId: '', enabled: false,
  ready: false, speaking: false, pending: 0, error: null, revision: -1, changing: false
});

export function applySpeechStatus(status: BackgroundSpeechStatus): void {
  if (status.revision < speechState.revision) return;
  Object.assign(speechState, status);
}

export async function toggleSpeech(): Promise<void> {
  if (speechState.changing || speechState.loading || !speechState.supported) return;
  speechState.changing = true;
  try {
    const response = await fetch('/api/speech', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !speechState.ready })
    });
    if (!response.ok) throw new Error('无法切换后台播报，请点击重试');
    applySpeechStatus(await response.json());
  } catch {
    speechState.error = '无法切换后台播报，请点击重试';
  } finally { speechState.changing = false; }
}
