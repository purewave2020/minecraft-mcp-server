import { EventEmitter } from 'node:events';
import test from 'ava';
import sinon from 'sinon';
import { BotConnection } from '../src/bot-connection.js';
import { MessageStore } from '../src/message-store.js';

test('constructor initializes with correct state', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  t.is(connection.getState(), 'disconnected');
  t.deepEqual(connection.getConfig(), config);
  t.is(connection.getBot(), null);
  t.false(connection.isConnected());
});

test('constructor accepts custom reconnect delay', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const customDelay = 5000;
  const connection = new BotConnection(config, callbacks, customDelay);

  t.is(connection.getState(), 'disconnected');
});

test('getState returns current state', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  t.is(connection.getState(), 'disconnected');
});

test('getConfig returns configuration', (t) => {
  const config = { host: 'example.com', port: 30000, username: 'MyBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  const returnedConfig = connection.getConfig();
  t.is(returnedConfig.host, 'example.com');
  t.is(returnedConfig.port, 30000);
  t.is(returnedConfig.username, 'MyBot');
});

test('getBot returns null initially', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  t.is(connection.getBot(), null);
});

test('isConnected returns false when state is disconnected', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  t.false(connection.isConnected());
});

test('formatError handles Error objects', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  const error = new Error('Test error');
  const formatted = (connection as unknown as { formatError: (error: unknown) => string }).formatError(error);

  t.is(formatted, 'Test error');
});

test('formatError handles plain objects', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  const errorObj = { code: 'ECONNREFUSED', message: 'Connection refused' };
  const formatted = (connection as unknown as { formatError: (error: unknown) => string }).formatError(errorObj);

  t.true(formatted.includes('ECONNREFUSED'));
  t.true(formatted.includes('Connection refused'));
});

test('formatError handles strings', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  const formatted = (connection as unknown as { formatError: (error: unknown) => string }).formatError('Simple error');

  t.is(formatted, '"Simple error"');
});

test('formatError handles non-serializable objects', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const formatted = (connection as unknown as { formatError: (error: unknown) => string }).formatError(circular);

  t.is(typeof formatted, 'string');
});

test('checkConnectionAndReconnect returns connected when already connected', async (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);
  
  (connection as unknown as { state: string }).state = 'connected';

  const result = await connection.checkConnectionAndReconnect();

  t.true(result.connected);
  t.is(result.message, undefined);
});

test('checkConnectionAndReconnect returns message when connecting', async (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  (connection as unknown as { state: string; isReconnecting: boolean }).state = 'connecting';
  (connection as unknown as { isReconnecting: boolean }).isReconnecting = true;

  const result = await connection.checkConnectionAndReconnect();

  t.false(result.connected);
  t.true(result.message!.includes('connecting'));
});

test('checkConnectionAndReconnect includes setup instructions on failure', async (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks, 100);

  (connection as unknown as { state: string }).state = 'disconnected';

  // Stub attemptReconnect to prevent actual connection attempt
  const attemptReconnectStub = sinon.stub(connection as unknown as { attemptReconnect: () => void }, 'attemptReconnect').callsFake(() => {
    (connection as unknown as { state: string }).state = 'connecting';
  });

  const result = await connection.checkConnectionAndReconnect();

  t.true(attemptReconnectStub.calledOnce);
  t.false(result.connected);
  t.true(result.message!.includes('Cannot connect'));
  t.true(result.message!.includes('localhost:25565'));
  t.true(result.message!.includes('github.com'));

  attemptReconnectStub.restore();
});

test('cleanup clears reconnect timer', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  (connection as unknown as { reconnectTimer: ReturnType<typeof setTimeout> }).reconnectTimer = setTimeout(() => {}, 10000);

  t.notThrows(() => {
    connection.cleanup();
  });
});

test('cleanup does not throw when no bot exists', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  t.notThrows(() => {
    connection.cleanup();
  });
});

test('ending before spawn schedules recovery and preserves plugin cleanup listeners', t => {
  const connection = new BotConnection({ host: 'localhost', port: 0, username: 'AuditFake' }, { onLog: () => {}, onChatMessage: () => {} }, 10000);
  const bot = new EventEmitter();
  const internals = connection as unknown as { bot: unknown; state: string; registerEventHandlers: (bot: unknown) => void };
  internals.bot = bot; internals.state = 'connecting'; internals.registerEventHandlers(bot);
  const cleanup = sinon.stub(); bot.on('end', cleanup); bot.emit('end', 'socketClosed');
  t.is(connection.getBot(), null);
  t.true(connection.getStatus().reconnectPending);
  t.true(cleanup.calledOnce);
  connection.cleanup();
});

test('a duplicate login suspends recovery until an explicit handoff', t => {
  const connection = new BotConnection({ host: 'localhost', port: 0, username: 'AuditFake' }, { onLog: () => {}, onChatMessage: () => {} });
  const bot = Object.assign(new EventEmitter(), { quit: sinon.stub() });
  const internals = connection as unknown as { bot: unknown; state: string; registerEventHandlers: (bot: unknown) => void };
  internals.bot = bot; internals.state = 'connecting'; internals.registerEventHandlers(bot);
  bot.emit('kicked', { translate: 'multiplayer.disconnect.duplicate_login' }); bot.emit('end', 'socketClosed');
  t.regex(String(connection.getStatus().blockedReason), /handoff/);
  t.false(connection.getStatus().reconnectPending);
  connection.cleanup();
});

test('a late end event from an old bot cannot disconnect its replacement', t => {
  const connection = new BotConnection({ host: 'localhost', port: 0, username: 'AuditFake' }, { onLog: () => {}, onChatMessage: () => {} });
  const old = new EventEmitter(); const replacement = new EventEmitter();
  const internals = connection as unknown as { bot: unknown; state: string; registerEventHandlers: (bot: unknown) => void };
  internals.bot = old; internals.registerEventHandlers(old); internals.bot = replacement; internals.state = 'connected';
  old.emit('end', 'late disconnect');
  t.is(connection.getBot(), replacement as never); t.is(connection.getState(), 'connected');
  internals.bot = null; connection.cleanup();
});


test('server-confirmed self chat is readable by sender without entering the priority queue', t => {
  const store = new MessageStore();
  const connection = new BotConnection({ host: 'localhost', port: 0, username: 'GPTBot' }, {
    onLog: () => {}, onChatMessage: (username, message) => store.addMessage(username, message)
  });
  const bot = Object.assign(new EventEmitter(), { username: 'GPTBot', quit: sinon.stub() });
  const internals = connection as unknown as { bot: unknown; registerEventHandlers: (bot: unknown) => void };
  internals.bot = bot;
  internals.registerEventHandlers(bot);
  t.teardown(() => connection.cleanup());

  bot.emit('chat', 'GPTBot', '已采集1个粗铁');
  bot.emit('chat', 'qingyage', '先回营地');

  const own = store.read(100, 'GPTBot');
  t.is(own.length, 1);
  t.is(own[0].content, '已采集1个粗铁');
  t.is(store.read(100).length, 2);
  const priority = store.read(100, undefined, 0, true);
  t.is(priority.length, 1);
  t.is(priority[0].username, 'qingyage');
});

test('chat from a replaced bot connection cannot enter the current history', t => {
  const onChatMessage = sinon.stub();
  const connection = new BotConnection({ host: 'localhost', port: 0, username: 'GPTBot' }, {
    onLog: () => {}, onChatMessage
  });
  const old = Object.assign(new EventEmitter(), { username: 'GPTBot' });
  const replacement = Object.assign(new EventEmitter(), { username: 'GPTBot', quit: sinon.stub() });
  const internals = connection as unknown as { bot: unknown; registerEventHandlers: (bot: unknown) => void };
  internals.bot = old;
  internals.registerEventHandlers(old);
  internals.bot = replacement;
  internals.registerEventHandlers(replacement);
  t.teardown(() => connection.cleanup());

  old.emit('chat', 'GPTBot', '过期消息');
  old.emit('chat', 'qingyage', '过期指令');
  replacement.emit('chat', 'GPTBot', '当前消息');

  t.true(onChatMessage.calledOnceWithExactly('GPTBot', '当前消息'));
});

test('kick diagnosis survives the follow-up socket error and generic quit event', t => {
  const connection = new BotConnection({ host: 'localhost', port: 0, username: 'AuditFake' }, { onLog: () => {}, onChatMessage: () => {} });
  const bot = Object.assign(new EventEmitter(), { quit: sinon.stub() });
  const internals = connection as unknown as { bot: unknown; registerEventHandlers: (bot: unknown) => void };
  internals.bot = bot; internals.registerEventHandlers(bot);
  bot.emit('kicked', 'Connect failed: AnnotatedNoRouteToHostException');
  bot.emit('error', new Error('read ECONNRESET'));
  bot.emit('end', 'disconnect.quitting');
  const status = connection.getStatus();
  t.regex(String(status.lastDisconnect), /NoRouteToHost/);
  t.deepEqual((status.lastError as { reason: string }).reason, 'read ECONNRESET');
  t.regex((status.lastEnd as { reason: string }).reason, /disconnect.quitting/);
  t.is(status.disconnectCount, 1);
  connection.cleanup();
});
