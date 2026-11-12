<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { state } from './state.js';
import { speechState, toggleSpeech } from './chat-speech.js';
import { avatar, playerColor } from './bluemap.js';
import { changeCamera, changeFollowView, changeMap, focusPlayer, refreshMap, selectPlayer, showTrail, stopFollowing } from './main.js';
import type { Player } from '../server/types.js';
import { CHAT_MAX_LENGTH, CHAT_USERNAME } from '../server/types.js';
import { environmentView } from './environment-model.js';

const playersOpen = ref(window.innerWidth >= 760);
const chatOpen = ref(window.innerWidth >= 1000);
const activeFeed = ref<'chat' | 'activity'>('chat');
const chatDraft = ref('');
const chatSending = ref(false);
const chatComposing = ref(false);
const chatError = ref<string | null>(null);
const chatSent = ref(false);
const chatInput = ref<HTMLInputElement | null>(null);
const filter = ref('all');
const trail = ref(false);
const detail = ref<Player | null>(null);
const detailError = ref(false);
const online = computed(() => state.players.filter(player => player.online));
const humans = computed(() => online.value.filter(player => !player.bot).length);
const players = computed(() => [...state.players].filter(player => player.online && (filter.value === 'all' || (filter.value === 'human' ? !player.bot : player.bot))).sort((a, b) => Number(a.bot) - Number(b.bot) || a.name.localeCompare(b.name)));
const selected = computed(() => state.players.find(player => player.id === state.selectedId) ?? null);
const currentPlayer = computed(() => selected.value ? { ...detail.value, ...selected.value, inventory: detail.value?.id === selected.value.id ? detail.value.inventory : [] } : null);
const tick = computed(() => state.metrics?.tick as Record<string, number> | undefined);
const metricsFresh = computed(() => !!state.metrics?.observedAt && state.now - Date.parse(String(state.metrics.observedAt)) < 120_000);
const live = computed(() => state.streamConnected && state.collector.connected && state.now - state.collector.observedAt < 20_000);
const chats = computed(() => [...state.chat].reverse().slice(0, 100));
const activities = computed(() => [...state.activity].reverse().slice(0, 30));
const dimensions = [{ id: 'overworld', name: '主世界', symbol: '◈' }, { id: 'the_nether', name: '下界', symbol: '◇' }, { id: 'the_end', name: '末地', symbol: '✧' }];
const dimensionNames: Record<string, string> = { 'minecraft:overworld': '主世界', 'minecraft:the_nether': '下界', 'minecraft:the_end': '末地' };
const clock = computed(() => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(state.now));
const environment = computed(() => environmentView(state.environment, state.currentMap, state.now));
const environmentTitle = computed(() => state.currentMap !== 'overworld' ? '此维度保持自身环境，不受主世界昼夜和天气影响' : environment.value.stale ? '环境数据待更新，保留最近一次状态' : '与游戏时间和天气同步');
const speechLabel = computed(() => speechState.changing ? '切换中' : speechState.loading ? '加载声音4' : !speechState.supported ? '声音4不可用' : speechState.error ? '重试播报' : speechState.ready ? (speechState.speaking ? '正在播报' : '后台播报已开') : '开启播报');
const speechTitle = computed(() => speechState.error ?? (speechState.ready ? '关闭本机后台语音播报（声音4）' : '开启本机后台语音播报（声音4），关闭浏览器后仍会继续'));
const itemNames: Record<string, string> = {
  stone_pickaxe: '石镐', wooden_pickaxe: '木镐', iron_pickaxe: '铁镐', diamond_pickaxe: '钻石镐', iron_sword: '铁剑', stone_sword: '石剑',
  oak_log: '橡木原木', birch_log: '白桦原木', oak_planks: '橡木木板', birch_planks: '白桦木板', cobblestone: '圆石', coal: '煤炭',
  raw_iron: '粗铁', iron_ingot: '铁锭', torch: '火把', crafting_table: '工作台', furnace: '熔炉', bread: '面包', cooked_beef: '牛排',
  dirt: '泥土', stone: '石头', gravel: '沙砾', stick: '木棍', rotten_flesh: '腐肉', red_bed: '红色床', black_bed: '黑色床',
  stone_bricks: '石砖', stone_brick_slab: '石砖台阶', glass: '玻璃', glass_pane: '玻璃板', shears: '剪刀', chest: '箱子'
};
const equipmentNames: Record<string, string> = { head: '头盔', chest: '胸甲', legs: '护腿', feet: '靴子', mainhand: '主手', offhand: '副手' };
function itemName(name: string): string { return itemNames[name] ?? name.replaceAll('_', ' '); }
function time(value: number | string | null | undefined): string {
  if (!value) return '等待更新';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value));
}
function age(value: number | null): string {
  if (!value) return '等待位置';
  const seconds = Math.max(0, Math.floor((state.now - value) / 1000));
  return seconds < 60 ? `${seconds} 秒前` : `${Math.floor(seconds / 60)} 分钟前`;
}
function duration(value: number): string {
  const minutes = Math.max(0, Math.floor((state.now - value) / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟` : `${minutes} 分钟`;
}
function coord(player: Player): string { return player.position ? `${Math.floor(player.position.x)}, ${Math.floor(player.position.y)}, ${Math.floor(player.position.z)}` : '等待位置'; }
function available(id: string): boolean { return state.map.maps.some(map => map.id === id); }
function choose(player: Player): void { selectPlayer(player.id); }
async function follow(): Promise<void> {
  if (!selected.value) return;
  if (state.follow) stopFollowing(); else await focusPlayer(selected.value, true);
}
function toggleBubbles(): void { localStorage.setItem('minecraft-dashboard-bubbles', String(state.bubbles)); }
async function sendChat(): Promise<void> {
  if (chatSending.value || chatComposing.value || !chatDraft.value.trim() || !live.value) return;
  const draft = chatDraft.value;
  chatSending.value = true; chatError.value = null; chatSent.value = false;
  try {
    const response = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: draft }), signal: AbortSignal.timeout(25_000)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? '聊天发送失败，请稍后重试');
    if (chatDraft.value === draft) chatDraft.value = '';
    chatSent.value = true;
  } catch (error) {
    chatError.value = error instanceof Error && error.name !== 'TimeoutError' && error.name !== 'TypeError'
      ? error.message : '未能确认发送结果，请先检查游戏聊天记录再重试';
  } finally { chatSending.value = false; chatInput.value?.focus(); }
}
function chatKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
  event.preventDefault(); void sendChat();
}
watch(chatDraft, () => { chatError.value = null; chatSent.value = false; }, { flush: 'sync' });
let detailTimer: ReturnType<typeof setInterval> | null = null;
let requestGeneration = 0;
async function loadDetail(): Promise<void> {
  if (!state.selectedId) return;
  const id = state.selectedId; const generation = requestGeneration;
  try {
    const response = await fetch('/api/players/' + id);
    if (!response.ok) throw new Error('detail');
    const value = await response.json();
    if (state.selectedId === id && generation === requestGeneration) { detail.value = value; detailError.value = false; }
  } catch { if (state.selectedId === id) detailError.value = true; }
}
watch(() => state.selectedId, () => {
  requestGeneration++; detail.value = null; trail.value = false; detailError.value = false;
  if (detailTimer) clearInterval(detailTimer);
  void loadDetail(); detailTimer = setInterval(() => void loadDetail(), 5000);
  if (selected.value) { void showTrail(selected.value, false); if (window.innerWidth < 760) playersOpen.value = false; }
}, { immediate: true });
watch(trail, value => { if (selected.value) void showTrail(selected.value, value); });
onUnmounted(() => { if (detailTimer) clearInterval(detailTimer); });
</script>

<template>
  <div class="md-shell">
    <header class="md-topbar">
      <div class="md-brand"><span class="md-brand-mark">◈</span><div><strong>世界沙盘</strong><span>MINECRAFT · LIVE WORLD</span></div></div>
      <nav class="md-dimensions" aria-label="世界维度">
        <button v-for="dimension in dimensions" :key="dimension.id" :class="{ active: state.currentMap === dimension.id }" :disabled="!available(dimension.id) || !state.engineReady" :title="available(dimension.id) ? dimension.name : '该维度尚未生成存档'" @click="changeMap(dimension.id)"><span>{{ dimension.symbol }}</span>{{ dimension.name }}</button>
      </nav>
      <div class="md-top-status">
        <button class="md-speech-toggle" :class="{ active: speechState.ready }" :disabled="speechState.loading || speechState.changing || !speechState.supported" :aria-pressed="speechState.ready" :aria-label="speechState.ready ? '关闭聊天语音播报' : '开启聊天语音播报'" :title="speechTitle" @click="toggleSpeech">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4 6 8H3v8h3l5 4Z" /><path v-if="speechState.ready" d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" /><path v-else d="m16 9 5 6m0-6-5 6" /></svg>
          <span>{{ speechLabel }}</span>
        </button>
        <span class="md-connection" :class="{ online: live }"><i></i>{{ live ? '实时连接' : '正在连接' }}</span><time>{{ clock }}</time>
      </div>
    </header>

    <div v-if="state.error || state.collector.error" class="md-alert" role="status">{{ state.error || state.collector.error }} · 显示最近一次数据</div>

    <aside v-if="playersOpen" class="md-panel md-players">
      <div class="md-panel-heading"><div><span class="md-eyebrow">PLAYERS</span><h2>在线玩家 <span>{{ online.length }}</span></h2></div><button class="md-icon-button" aria-label="收起玩家列表" @click="playersOpen = false">−</button></div>
      <div class="md-player-summary"><span>真人 <b>{{ humans }}</b></span><span>机器人 <b>{{ online.length - humans }}</b></span><span v-if="metricsFresh && tick">MSPT <b>{{ tick.averageMs?.toFixed(1) ?? '—' }}</b></span></div>
      <div class="md-segmented" aria-label="玩家类型"><button :class="{ active: filter === 'all' }" @click="filter = 'all'">全部</button><button :class="{ active: filter === 'human' }" @click="filter = 'human'">真人</button><button :class="{ active: filter === 'bot' }" @click="filter = 'bot'">机器人</button></div>
      <div class="md-player-list">
        <button v-for="player in players" :key="player.id" class="md-player-row" :class="{ selected: state.selectedId === player.id, stale: !player.positionAt || state.now - player.positionAt > 15000 }" :style="{ '--player-color': playerColor(player.name) }" @click="choose(player)">
          <img :src="avatar(player.name)" alt="" class="md-avatar" />
          <div class="md-player-copy"><div><strong>{{ player.name }}</strong><span class="md-type">{{ player.bot ? 'BOT' : '玩家' }}</span></div><span class="md-coordinates">{{ coord(player) }}</span><div class="md-row-meta"><span>{{ dimensionNames[player.dimension] ?? player.dimension }}</span><span>{{ age(player.positionAt) }}</span></div></div>
          <span class="md-player-hp" :class="{ low: player.health !== null && player.health < 8 }">♥<b>{{ player.health === null ? '—' : Math.ceil(player.health) }}</b></span>
        </button>
        <div v-if="!players.length" class="md-empty">{{ live ? '当前没有匹配的在线玩家' : '正在获取服务器玩家…' }}</div>
      </div>
      <div class="md-list-footer"><i :class="{ live }"></i>统一采集 · 位置约 2–3 秒更新</div>
    </aside>
    <button v-else class="md-floating md-open-players" @click="playersOpen = true">◈ 玩家 <b>{{ online.length }}</b></button>

    <aside v-if="currentPlayer" class="md-panel md-detail" :class="{ 'with-chat': chatOpen, 'following-third-person': state.follow && state.followView === 'third' }">
      <div class="md-detail-top"><span class="md-eyebrow">PLAYER DETAILS</span><button class="md-icon-button" aria-label="关闭玩家详情" @click="state.selectedId = null; stopFollowing()">×</button></div>
      <div class="md-detail-identity"><img :src="avatar(currentPlayer.name)" alt="" class="md-avatar large" /><div><h2>{{ currentPlayer.name }}</h2><span>{{ currentPlayer.bot ? '机器人玩家' : '真人玩家' }} · {{ currentPlayer.online ? dimensionNames[currentPlayer.dimension] : '已离线' }}</span></div></div>
      <div class="md-detail-position">{{ coord(currentPlayer) }}<span>{{ age(currentPlayer.positionAt) }}</span></div>
      <div class="md-vitals"><div><span>生命</span><b>♥ {{ currentPlayer.health === null ? '—' : currentPlayer.health.toFixed(0) }}<small> / 20</small></b><i><em :style="{ width: Math.min(100, (currentPlayer.health ?? 0) * 5) + '%' }"></em></i></div><div><span>饥饿</span><b>◆ {{ currentPlayer.food ?? '—' }}<small> / 20</small></b><i class="food"><em :style="{ width: Math.min(100, (currentPlayer.food ?? 0) * 5) + '%' }"></em></i></div></div>
      <div class="md-detail-actions"><button :disabled="!state.engineReady || !currentPlayer.position || !currentPlayer.online" @click="focusPlayer(currentPlayer)">⌖ 定位</button><button class="primary" :class="{ following: state.follow }" :title="state.follow ? '停止跟随并保持当前视角' : state.followView === 'third' ? '从玩家身后近距离跟随' : '以玩家的第一人称视角跟随'" :disabled="!state.engineReady || !currentPlayer.position || !currentPlayer.online" @click="follow">{{ state.follow ? '停止跟随' : '跟随玩家' }}</button></div>
      <div class="md-segmented md-follow-view" role="group" aria-label="跟随视角">
        <button :class="{ active: state.followView === 'first' }" :aria-pressed="state.followView === 'first'" :disabled="!state.engineReady || !currentPlayer.position || !currentPlayer.online" title="从玩家眼睛位置观察" @click="changeFollowView('first')">第一人称</button>
        <button :class="{ active: state.followView === 'third' }" :aria-pressed="state.followView === 'third'" :disabled="!state.engineReady || !currentPlayer.position || !currentPlayer.online" title="从玩家身后近距离观察" @click="changeFollowView('third')">第三人称</button>
      </div>
      <label class="md-checkbox"><input v-model="trail" type="checkbox" :disabled="!state.engineReady" />显示最近 15 分钟轨迹</label>
      <div class="md-detail-scroll">
        <div class="md-section-label">装备 <span>等级 {{ currentPlayer.xp ?? '—' }}</span></div>
        <div class="md-equipment"><div v-for="(name, key) in equipmentNames" :key="key"><span>{{ name }}</span><b>{{ currentPlayer.equipment[key] ? itemName(currentPlayer.equipment[key]!.name) : '—' }}</b></div></div>
        <div class="md-section-label">背包 <span>{{ currentPlayer.inventory.length }} 格</span></div>
        <div v-if="detailError" class="md-inline-error">背包读取失败，正在重试</div>
        <div v-else-if="!detail" class="md-empty compact">正在读取背包…</div>
        <div v-else-if="!currentPlayer.inventory.length" class="md-empty compact">背包为空</div>
        <div v-else class="md-inventory"><div v-for="(item, index) in currentPlayer.inventory" :key="`${item.slot}-${index}`" :title="item.name"><span>{{ itemName(item.name) }}</span><b>×{{ item.count }}</b></div></div>
        <div v-if="currentPlayer.effects.length" class="md-effects">效果：{{ currentPlayer.effects.join(' · ') }}</div>
        <div class="md-detail-footnote">持续观测 {{ duration(currentPlayer.joinedAt) }}</div>
      </div>
    </aside>

    <aside v-if="chatOpen" class="md-panel md-feed" :class="{ 'with-detail': !!currentPlayer }">
      <div class="md-feed-heading"><div class="md-feed-tabs"><button :class="{ active: activeFeed === 'chat' }" @click="activeFeed = 'chat'">公共聊天</button><button :class="{ active: activeFeed === 'activity' }" @click="activeFeed = 'activity'">世界动态</button></div><button class="md-icon-button" aria-label="收起聊天记录" @click="chatOpen = false">−</button></div>
      <div v-if="activeFeed === 'chat'" class="md-feed-list"><article v-for="message in chats" :key="message.id" class="md-message"><div><button :style="{ color: playerColor(message.username) }" @click="message.playerId && selectPlayer(message.playerId)">{{ message.username }}</button><time>{{ time(message.timestamp) }}</time></div><p>{{ message.content }}</p></article><div v-if="!chats.length" class="md-empty">玩家发言后会在沙盘冒泡，也会记录在这里</div></div>
      <div v-else class="md-feed-list"><article v-for="event in activities" :key="event.id" class="md-activity"><time>{{ time(event.timestamp) }}</time><p>{{ event.text }}</p></article><div v-if="!activities.length" class="md-empty">暂无新的世界动态</div></div>
      <form v-if="activeFeed === 'chat'" class="md-chat-composer" @submit.prevent="sendChat" @keydown.stop @keyup.stop>
        <label for="md-chat-input" class="md-chat-identity">发送身份 <strong>{{ CHAT_USERNAME }}</strong><span>{{ chatDraft.length }}/{{ CHAT_MAX_LENGTH }}</span></label>
        <div class="md-chat-input-row">
          <input id="md-chat-input" ref="chatInput" v-model="chatDraft" type="text" name="message" :maxlength="CHAT_MAX_LENGTH" autocomplete="off" placeholder="输入聊天内容…" aria-label="聊天内容" :aria-describedby="'md-chat-status'" :readonly="chatSending" enterkeyhint="send" @keydown="chatKeydown" @compositionstart="chatComposing = true" @compositionend="chatComposing = false" />
          <button type="submit" :disabled="chatSending || !chatDraft.trim() || !live">{{ chatSending ? '发送中…' : '发送' }}</button>
        </div>
        <div id="md-chat-status" class="md-chat-status" :class="{ error: chatError }" role="status" aria-live="polite">{{ chatError ?? (!live ? '服务器连接中断，恢复后可发送' : chatSent ? '已发送' : 'Enter 发送') }}</div>
      </form>
      <label class="md-checkbox md-bubble-toggle"><input v-model="state.bubbles" type="checkbox" @change="toggleBubbles" />显示玩家头顶聊天气泡<span>8 秒</span></label>
    </aside>
    <button v-else class="md-floating md-open-chat" @click="chatOpen = true">▤ 聊天 <span v-if="state.chat.length">{{ state.chat.length }}</span></button>

    <div class="md-map-tools" aria-label="地图视角"><button :disabled="!state.engineReady" title="放大" aria-label="放大地图" @click="changeCamera('in')">＋</button><button :disabled="!state.engineReady" title="缩小" aria-label="缩小地图" @click="changeCamera('out')">−</button><span></span><button :disabled="!state.engineReady" @click="changeCamera('perspective')">3D</button><button :disabled="!state.engineReady" @click="changeCamera('top')">俯视</button><button :disabled="!state.engineReady" title="重新加载当前地图" aria-label="刷新地图" @click="refreshMap">↻</button></div>
    <footer class="md-world-status">
      <span class="md-environment-status" :class="{ 'md-warning': state.currentMap === 'overworld' && environment.stale }" :title="environmentTitle" :data-phase="environment.phase" :data-weather="environment.weather">{{ environment.label }}</span>
      <span v-if="state.map.syncing" class="md-updating"><i></i>地图更新中</span><span v-else-if="state.map.error" class="md-warning" :title="state.map.error">地图同步待恢复</span><span v-else>存档 {{ time(state.map.snapshotAt) }}</span><span class="md-status-divider">·</span><span>拖动浏览 · 滚轮缩放</span>
    </footer>
    <a class="md-attribution" href="https://bluemap.bluecolored.de/" target="_blank" rel="noopener noreferrer">BlueMap</a>

    <div v-if="!state.engineReady" class="md-map-loading"><div class="md-loading-symbol">◈</div><h1>正在打开你的世界</h1><p>{{ state.map.error ?? (state.map.syncing ? '正在生成真实地形与建筑' : '正在加载三维地图') }}</p><span>{{ state.map.progress }}</span></div>
  </div>
</template>
