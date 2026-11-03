import test from 'node:test';
import assert from 'node:assert/strict';
import { requestsQQMusic } from '../src/local-apps.mjs';
import { createApp } from '../src/server.mjs';
import { config, tempDir, removeTempDir } from './helpers.mjs';
import { Store } from '../src/store.mjs';
import { once } from 'node:events';

test('only explicit QQ Music launch requests match, never prose or shell input', () => {
  for (const text of ['打开qq音乐', '帮我打开QQ音乐。', '你可以帮我打开 QQ音乐吗？', '请启动一下QQ音乐', '能不能打开QQ音乐？', '幫我打開QQ音樂','長离幫我打開QQ音樂\n','幫我打開qq音樂','长离，能帮我把QQ音乐打开一下吗？','愛彌斯，請幫我啟動ＱＱ音樂']) {
    assert.equal(requestsQQMusic(text), true, text);
  }
  for (const text of ['不要打开QQ音乐', '長離，不要幫我打開QQ音樂', '打开QQ音乐的方法', '她说“打开QQ音乐”', '打开QQ音乐并发送消息', '打开QQ音乐; calc.exe', '打开网易云', null]) assert.equal(requestsQQMusic(text), false, String(text));
});

test('software launch switch persists by role and can only be changed by the user',t=>{
  const directory=tempDir(t);let store=new Store(directory);
  try{
    assert.equal(store.getAppLaunchEnabled('changli'),true);
    assert.throws(()=>store.setAppLaunchEnabled('changli',false,{actor:'assistant'}));
    assert.throws(()=>store.setAppLaunchEnabled('changli','false'));
    store.setAppLaunchEnabled('changli',false);store.close();store=new Store(directory);
    assert.equal(store.getAppLaunchEnabled('changli'),false);assert.equal(store.getAppLaunchEnabled('aimisi'),true);
  }finally{store.close();}
});

test('capability state and authenticated switch control real chat dispatch before any model call',async t=>{
  let calls=0;
  const directory=tempDir();
  const app=createApp({config:{...config,dataDir:directory,apiKey:''},model:{count:async()=>{throw new Error('unexpected model');}},openLocalApp:async()=>{calls++;return 'QQ音乐已启动';},token:'b'.repeat(64)});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  t.after(async()=>{await app.close();removeTempDir(directory);});
  const base=`http://127.0.0.1:${app.server.address().port}`,headers={Authorization:'Bearer '+'b'.repeat(64),'Content-Type':'application/json'};
  const url=base+'/api/characters/changli/app-launch-permission';
  assert.equal((await fetch(url,{method:'PUT',body:'{}'})).status,401);
  assert.equal((await fetch(url,{method:'PUT',headers,body:'{"enabled":"false"}'})).status,400);
  assert.deepEqual(await (await fetch(url,{method:'PUT',headers,body:'{"enabled":false}'})).json(),{enabled:false});
  const state=await (await fetch(base+'/api/state?character=changli',{headers})).json();
  assert.equal(state.modelConfigured,false);assert.equal(state.guiConfigured,false);
  assert.deepEqual(state.localApps,{configured:true,enabled:false,apps:[{id:'qqmusic',name:'QQ音乐',available:true}]});
  const session=app.store.createSession('changli');
  await assert.rejects(app.service.chat('changli',session.id,'長离幫我打開QQ音樂',()=>{}),{code:'app_launch_disabled'});
  assert.equal(calls,0);assert.equal(app.store.messages('changli',session.id).length,0);
  app.store.setAppLaunchEnabled('changli',true);app.service.quotaPaused=true;
  await app.service.chat('changli',session.id,'長离幫我打開QQ音樂',()=>{});
  assert.equal(calls,1);assert.equal(app.store.messages('changli',session.id).length,2);
  assert.equal((await (await fetch(base+'/api/state?character=aimisi',{headers})).json()).localApps.enabled,true);
});

test('real chat service dispatches locally, saves accurate replies, preserves retries and never replays on regeneration', async t => {
  let launches = 0, fail = true, modelCalls = 0;
  const model = { count: async () => 1, stream: async () => { modelCalls++; return { text: '普通回复' }; }, extractMemory: async () => [] };
  const directory = tempDir();
  const app = createApp({ config: { ...config, dataDir: directory }, model, openLocalApp: async () => { launches++; if (fail) throw Object.assign(new Error('启动未确认'), { code: 'app_launch_unconfirmed' }); return 'QQ音乐已启动'; } });
  t.after(async () => { await app.close(); removeTempDir(directory); });
  const session = app.store.createSession('changli'), events = [];
  const emit = (type, data) => events.push({ type, data });
  await assert.rejects(app.service.chat('changli', session.id, '帮我打开QQ音乐', emit), { code: 'app_launch_unconfirmed' });
  const user = app.store.messages('changli', session.id)[0];
  assert.equal(app.store.messages('changli', session.id).length, 1);
  fail = false; app.service.quotaPaused = true;
  await app.service.chat('changli', session.id, undefined, emit, undefined, { retryId: user.id });
  const messages = app.store.messages('changli', session.id);
  assert.deepEqual(messages.map(m => m.content), ['帮我打开QQ音乐', 'QQ音乐已启动']);
  assert.equal(modelCalls, 0); assert.equal(launches, 2);
  assert.ok(events.some(item => item.type === 'saved'));
  app.service.quotaPaused = false;
  await app.service.chat('changli', session.id, undefined, emit, undefined, { regenerateId: messages[1].id });
  assert.equal(launches, 2); assert.equal(modelCalls, 1);
  await app.service.chat('changli', session.id, '不要打开QQ音乐', emit);
  assert.equal(launches, 2); assert.equal(modelCalls, 2);
  assert.deepEqual(app.store.listSessions('aimisi'), []);
});
