const {test}=require('node:test');const assert=require('node:assert/strict');
const {validPage,clampSize,safeShortcut,activeTasks}=require('../shell-state.cjs');
test('window size is bounded by actual monitor and default centered size',()=>{assert.deepEqual(clampSize({width:99999,height:1},{width:1366,height:768}),{width:1366,height:650});assert.deepEqual(clampSize(null,{width:700,height:500}),{width:700,height:500});});
test('IPC pages and shortcuts reject untrusted payloads',()=>{assert.equal(validPage('https://evil.test'),'chat');assert.equal(safeShortcut('Ctrl+Shift+R'),'Control+Shift+R');assert.equal(safeShortcut(''),'');assert.throws(()=>safeShortcut('R'));assert.throws(()=>safeShortcut('Control+R;exec'));});
test('exit confirmation includes only currently active tasks',()=>{assert.deepEqual(activeTasks([{status:'running',id:1},{status:'paused',id:2},{status:'awaiting_approval',id:3}]).map(x=>x.id),[1,3]);});
test('unexpected main exit pauses only current role active tasks without replay',async()=>{
 const {pauseAfterCrash}=await import('./lifecycle-watch.mjs');const calls=[];
 const count=await pauseAfterCrash(async(path,options)=>{calls.push({path,options});return {tasks:[{id:'one',status:'running'},{id:'two',status:'paused'},{id:'three',status:'awaiting_approval'}]};});
 assert.equal(count,2);assert.equal(calls.length,3);assert.equal(calls[1].path,'/api/characters/changli/tasks/one/interrupt');assert.equal(calls[2].path,'/api/characters/changli/tasks/three/interrupt');
});
test('independent watchdog responds to real parent IPC disconnect',async()=>{
 const {createServer}=require('node:http'),{fork}=require('node:child_process'),{once}=require('node:events');
 const {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync}=require('node:fs'),{join,resolve}=require('node:path'),{tmpdir}=require('node:os');
 const base=mkdtempSync(join(tmpdir(),'changli-watchdog-'));mkdirSync(join(base,'data'));writeFileSync(join(base,'data/access-token'),'0'.repeat(64));
 const calls=[];
 const server=createServer((req,res)=>{calls.push(req.url);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.method==='GET'?{tasks:[{id:'active',status:'running'},{id:'done',status:'completed'}]}:{status:'paused'}));});
 server.listen(0,'127.0.0.1');await once(server,'listening');writeFileSync(join(base,'.env'),`PORT=${server.address().port}\n`);
 const child=fork(join(__dirname,'lifecycle-watch.mjs'),[base,join(base,'result.log')],{stdio:['ignore','ignore','ignore','ipc'],env:{SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP}});
 try{
  await new Promise(done=>setTimeout(done,400));child.disconnect();const [code]=await once(child,'exit');
  assert.equal(code,0,JSON.stringify({calls,result:readFileSync(join(base,'result.log'),'utf8')}));assert.deepEqual(calls,['/api/state?character=changli','/api/characters/changli/tasks/active/interrupt']);assert.equal(JSON.parse(readFileSync(join(base,'result.log'),'utf8')).paused,1);
 }finally{if(child.connected)child.disconnect();child.kill();await new Promise(done=>server.close(done));const target=resolve(base);if(target.startsWith(resolve(tmpdir())+require('node:path').sep)&&require('node:path').basename(target).startsWith('changli-watchdog-'))rmSync(target,{recursive:true,force:true});}
});

const {petPlacement}=require('../shell-state.cjs');
const {petSettings,petSize}=require('../shell-state.cjs');
test('pet display validates partial settings and uses scaled bounds without changing opacity on size updates',()=>{
 assert.deepEqual(petSettings({}),{scale:1,opacity:1});
 assert.deepEqual(petSettings({scale:2},{scale:1,opacity:.4}),{scale:2,opacity:.4});
 assert.deepEqual(petSize(petSettings({scale:.5,opacity:.2})),{width:125,height:95});
 for(const value of [null,[],{scale:NaN},{scale:0},{scale:2.1},{opacity:0},{opacity:1.1},{opacity:'0.5'},{unknown:true}])assert.throws(()=>petSettings(value));
 const desktop={x:0,y:0,width:1440,height:960},size=petSize({scale:2});
 const p=petPlacement({x:9000,y:9000},{...desktop,height:912},desktop,size);
 assert.equal(p.x,940);assert.equal(p.y,532);
});
test('pet reaches monitor corners using character bounds, including negative secondary display',()=>{
 const desktop={x:-1280,y:0,width:3200,height:1080};
 assert.deepEqual(petPlacement({x:-9000,y:-9000},{x:-1280,y:0,width:1280,height:1024},desktop),{x:0,y:0,below:true,alignLeft:true});
 assert.deepEqual(petPlacement({x:9000,y:9000},{x:0,y:0,width:1920,height:1040},desktop),{x:2950,y:850,below:false,alignLeft:false});
 assert.equal(petPlacement({x:0,y:0},{x:0,y:0,width:1920,height:1040},{x:0,y:0}).x,0);
});
