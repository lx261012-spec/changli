const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, globalShortcut, screen, dialog, Notification, session } = require('electron');
const { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const {validPage,clampSize,safeShortcut,activeTasks,petPlacement,petSettings,petSize} = require('./shell-state.cjs');

const root=__dirname, uiCheck=process.argv.includes('--ui-check'), testMode=process.argv.includes('--smoke-test')||uiCheck;
const dataDir=resolve(root,testMode?'qa/shell-profile':'data');
mkdirSync(dataDir,{recursive:true}); mkdirSync(join(root,'logs'),{recursive:true});
app.setPath('userData',dataDir); app.setPath('sessionData',dataDir); app.setAppLogsPath(join(root,'logs'));
app.setPath('crashDumps',join(dataDir,'crashes'));
app.setName('长离 · 听雪闲叙');
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
if(uiCheck&&process.argv.includes('--qa-scale-one'))app.commandLine.appendSwitch('force-device-scale-factor','1');
if(uiCheck&&process.argv.includes('--qa-debug'))app.commandLine.appendSwitch('remote-debugging-port','9354');
const log=(event,detail={})=>{ const line=JSON.stringify({time:new Date().toISOString(),event,...detail}); require('node:fs').appendFileSync(join(root,'logs',testMode?'smoke.log':'shell.log'),line+'\n'); };
let mainWindow,petWindow,wallpaperWindow,tray,host,nativeChild,watchdog,taskTimer,quitting=false,entered=false,registeredShortcut='',lastTasks=new Map(),readyTasks=false;
const rendererErrors=[];
let nativePointers=0;
let petHasShape=false,petShapeKey='';
let petPosition;
let polledShortcut;
let recovery;
try {recovery=JSON.parse(readFileSync(join(dataDir,'task-recovery.json'),'utf8'));}catch{}
let settings={width:1180,height:820,petVisible:true,wallpaperEnabled:true};
try {settings={...settings,...JSON.parse(readFileSync(join(dataDir,'window.json'),'utf8'))};} catch(error) {if(error.code!=='ENOENT') log('settings-read-failed');}
try {settings.petSettings=petSettings(settings.petSettings||{});}catch{settings.petSettings=petSettings({});}
function saveSettings(){const file=join(dataDir,'window.json');writeFileSync(file+'.tmp',JSON.stringify(settings,null,2));renameSync(file+'.tmp',file);}
function windows(){return [mainWindow,petWindow,wallpaperWindow].filter(w=>w&&!w.isDestroyed());}
function emit(data){for(const w of windows())w.webContents.send('desktop:event',data);}
function windowState(){return {maximized:Boolean(mainWindow?.isMaximized()),minimized:Boolean(mainWindow?.isMinimized()),visible:Boolean(mainWindow?.isVisible())};}
function shellState(){return {window:windowState(),petPosition,petSettings:settings.petSettings,petVisible:Boolean(petWindow?.isVisible()),wallpaperEnabled:Boolean(wallpaperWindow&&!wallpaperWindow.isDestroyed()),wallpaperStatus:settings.wallpaperStatus||'loading',wallpaperSettings:settings.wallpaperSettings||{follow:true,volume:.8,videoSound:false,paused:false},recordingShortcut:registeredShortcut,entered,testMode,recovery};}
function showMain(page){if(!mainWindow||mainWindow.isDestroyed())return;if(mainWindow.isMinimized())mainWindow.restore();mainWindow.show();mainWindow.focus();if(page)mainWindow.webContents.send('desktop:event',{type:'navigate',page:validPage(page)});}
function secureWindow(options){
 const w=new BrowserWindow({...options,webPreferences:{preload:join(root,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,backgroundThrottling:false,partition:'persist:changli'}});
 w.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 w.webContents.on('will-navigate',(event,url)=>{if(!host||new URL(url).origin!==new URL(host.url).origin)event.preventDefault();});
 w.webContents.on('will-attach-webview',event=>event.preventDefault());
 w.webContents.on('render-process-gone',(_event,detail)=>{log('renderer-lost',{reason:detail.reason});if(w===mainWindow)dialog.showErrorBox('界面暂不可用','界面进程已停止，请重新启动长离；聊天记录由底基保存。');});
 w.webContents.on('did-fail-load',(_event,code)=>log('load-failed',{code}));
 w.webContents.on('console-message',(_event,details,message)=>{
  const level=typeof details==='object'?details.level:details;
  if(level==='error'||level===3)rendererErrors.push(String(typeof details==='object'?details.message:message).slice(0,250));
 });
 return w;
}
function native(mode,args=[]){
 return new Promise((done,reject)=>{
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(root,'native/desktop-host.ps1'),'-Mode',mode,...args],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let text=''; child.stdout.setEncoding('utf8');child.stdout.on('data',x=>text+=x);
  const timer=setTimeout(()=>{child.kill();reject(new Error('Windows桌面接口响应超时'));},25000);
  child.on('error',error=>{clearTimeout(timer);reject(error);});
  child.on('exit',code=>{clearTimeout(timer);try{const value=JSON.parse(text.trim().split(/\r?\n/).at(-1));if(code||value.type==='native-error')throw new Error(value.message||'桌面接口失败');done(value);}catch(error){reject(error);}});
 });
}
async function startWallpaper(force=false){
 if((testMode&&!force)||process.platform!=='win32'||(wallpaperWindow&&!wallpaperWindow.isDestroyed()))return;
 settings.wallpaperStatus='loading';emit({type:'shell-state',...shellState()});
 try {
  const snapshot=await native('Snapshot');
  writeFileSync(join(dataDir,'wallpaper-recovery.json'),JSON.stringify({wallpaper:snapshot.wallpaper,time:new Date().toISOString(),method:'workerw-overlay-settings-untouched'},null,2));
  const displays=screen.getAllDisplays();const left=Math.min(...displays.map(d=>d.bounds.x)),top=Math.min(...displays.map(d=>d.bounds.y));
  const right=Math.max(...displays.map(d=>d.bounds.x+d.bounds.width)),bottom=Math.max(...displays.map(d=>d.bounds.y+d.bounds.height));
  wallpaperWindow=secureWindow({x:left,y:top,width:right-left,height:bottom-top,show:false,frame:false,transparent:false,backgroundColor:'#15151b',skipTaskbar:true,resizable:false,focusable:false,hasShadow:false});
  wallpaperWindow.setIgnoreMouseEvents(true);
  await wallpaperWindow.loadURL(host.url+'/wallpaper/');
  const handle=wallpaperWindow.getNativeWindowHandle().readBigUInt64LE().toString();
  nativeChild=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(root,'native/desktop-host.ps1'),'-Mode','Attach','-WindowHandle',handle,'-ParentPid',String(process.pid)],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  await new Promise((done,reject)=>{
   let settled=false;
   const timer=setTimeout(()=>{if(!settled){settled=true;reject(new Error('壁纸嵌入超时'));}},25000);
   createInterface({input:nativeChild.stdout}).on('line',line=>{
    let event;try{event=JSON.parse(line);}catch{return;}
    if(event.type==='attached'){
     settings.wallpaperStatus='attached';wallpaperWindow.showInactive();log('wallpaper-attached',{verified:event.verified});
     if(!settled){settled=true;clearTimeout(timer);done();}
     emit({type:'shell-state',...shellState()});
     emit({type:'wallpaper-settings',settings:shellState().wallpaperSettings,...shellState().wallpaperSettings});
    }else if(event.type==='wallpaper-pointer'){
     nativePointers++;
     if(!wallpaperWindow||wallpaperWindow.isDestroyed())return;
     const point=screen.screenToDipPoint({x:event.x,y:event.y});
     wallpaperWindow.webContents.send('desktop:event',{...event,x:point.x-left,y:point.y-top,width:right-left,height:bottom-top,down:event.click});
    }else if(event.type==='native-error'&&!settled){settled=true;clearTimeout(timer);reject(new Error(event.message));}
   });
   nativeChild.on('error',error=>{if(!settled){settled=true;clearTimeout(timer);reject(error);}});
   nativeChild.on('exit',code=>{if(!settled){settled=true;clearTimeout(timer);reject(new Error('Windows壁纸接口已退出'));}else if(!quitting&&wallpaperWindow&&!wallpaperWindow.isDestroyed()){settings.wallpaperStatus='failed';wallpaperWindow.destroy();emit({type:'shell-state',...shellState()});log('wallpaper-helper-exit',{code});}});
  });
 }catch(error){stopWallpaper();settings.wallpaperStatus='failed';emit({type:'shell-state',...shellState(),message:'壁纸加载失败，可在角色与壁纸显示中重试。'});log('wallpaper-failed',{message:error.message});}
}
function stopWallpaper(){if(wallpaperWindow&&!wallpaperWindow.isDestroyed())wallpaperWindow.destroy();wallpaperWindow=null;if(nativeChild)nativeChild.kill();nativeChild=null;settings.wallpaperStatus='off';}
function showPet(){if(petWindow&&!petWindow.isDestroyed()){petWindow.setAlwaysOnTop(true,'screen-saver');petWindow.showInactive();settings.petVisible=true;saveSettings();emit({type:'shell-state',...shellState()});}}
function setShortcut(value){
 const shortcut=safeShortcut(value||'');
 if(shortcut===registeredShortcut)return {registered:Boolean(shortcut),shortcut};
 if(registeredShortcut)globalShortcut.unregister(registeredShortcut);registeredShortcut='';
 if(shortcut){if(!globalShortcut.register(shortcut,()=>{showPet();petWindow.webContents.send('desktop:event',{type:'record-toggle'});})){emit({type:'shortcut-error',message:'录音快捷键被其他程序占用，请在设置中重新选择。'});return {registered:false,shortcut,message:'快捷键已被占用'};}registeredShortcut=shortcut;}
 return {registered:Boolean(shortcut),shortcut};
}
function trusted(event){return windows().some(w=>w.webContents.id===event.sender.id)&&new URL(event.senderFrame.url).origin===new URL(host.url).origin;}
function handle(name,fn){ipcMain.handle('desktop:'+name,async(event,arg)=>{if(!trusted(event))throw new Error('拒绝未知界面请求');return fn(arg,event);});}
function installIPC(){
 handle('state',()=>shellState());handle('enter',()=>{const greet=!entered;entered=true;return {greet};});
 handle('show',page=>showMain(page));handle('settings',section=>{showMain('settings');mainWindow.webContents.send('desktop:event',{type:'settings-section',section:typeof section==='string'?section.slice(0,80):''});});
 handle('pet-hide',()=>{petWindow.hide();settings.petVisible=false;saveSettings();emit({type:'shell-state',...shellState()});});handle('pet-show',showPet);
 handle('pet-move',(delta,event)=>{
  if(event.sender.id!==petWindow.webContents.id||!delta||![delta.dx,delta.dy].every(Number.isFinite))return;
  const desktop=petWindow.getBounds();
  const size=petSize(settings.petSettings);
  const point={x:desktop.x+petPosition.x+delta.dx,y:desktop.y+petPosition.y+delta.dy};
  const area=screen.getDisplayNearestPoint({x:Math.round(point.x+size.width/2),y:Math.round(point.y+size.height/2)}).workArea;
  petPosition=petPlacement(point,area,desktop,size);
  return petPosition;
 });
 handle('pet-settings',value=>{
  const next=petSettings(value,settings.petSettings),oldSize=petSize(settings.petSettings),size=petSize(next),desktop=petWindow.getBounds();
  const point={x:desktop.x+petPosition.x+(oldSize.width-size.width)/2,y:desktop.y+petPosition.y+oldSize.height-size.height};
  const area=screen.getDisplayNearestPoint({x:Math.round(desktop.x+petPosition.x+oldSize.width/2),y:Math.round(desktop.y+petPosition.y+oldSize.height/2)}).workArea;
  settings.petSettings=next;saveSettings();petPosition=petPlacement(point,area,desktop,size);
  emit({type:'pet-settings',settings:next,petPosition});return next;
 });
 handle('pet-interactive',(value,event)=>{if(petHasShape||event.sender.id!==petWindow.webContents.id||typeof value!=='boolean')return;petWindow.setIgnoreMouseEvents(!value,{forward:true});});
 handle('pet-regions',(regions,event)=>{
  if(event.sender.id!==petWindow.webContents.id||!Array.isArray(regions)||regions.length>500)throw new Error('桌宠区域无效');
  const bounds=petWindow.getBounds();
  const safe=regions.map(rect=>{
   if(!rect||!['x','y','width','height'].every(key=>Number.isFinite(rect[key]))||rect.width<=0||rect.height<=0)throw new Error('桌宠区域无效');
   const x=Math.max(0,Math.floor(rect.x)),y=Math.max(0,Math.floor(rect.y));
   return {x,y,width:Math.max(0,Math.min(bounds.width-x,Math.ceil(rect.width))),height:Math.max(0,Math.min(bounds.height-y,Math.ceil(rect.height)))};
  }).filter(rect=>rect.width>0&&rect.height>0);
  const key=JSON.stringify(safe);if(key===petShapeKey)return {count:safe.length};
  petWindow.setShape(safe);petShapeKey=key;
  if(!petHasShape){petWindow.setIgnoreMouseEvents(false);petWindow.setAlwaysOnTop(true,'screen-saver');petHasShape=true;}
  return {count:safe.length};
 });
 handle('wallpaper',async value=>{if(typeof value!=='boolean')throw new Error('壁纸开关无效');settings.wallpaperEnabled=value;saveSettings();if(value)await startWallpaper();else stopWallpaper();emit({type:'shell-state',...shellState()});return shellState();});
 handle('wallpaper-settings',value=>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('壁纸设置无效');
  const next={...shellState().wallpaperSettings};
  for(const key of ['follow','videoSound','paused'])if(key in value){if(typeof value[key]!=='boolean')throw new Error('壁纸设置无效');next[key]=value[key];}
  if('volume' in value){if(!Number.isFinite(value.volume)||value.volume<0||value.volume>1)throw new Error('音量应在0到1之间');next.volume=value.volume;}
  settings.wallpaperSettings=next;saveSettings();emit({type:'wallpaper-settings',settings:next,...next});return next;
 });
 handle('shortcut',setShortcut);handle('minimize',()=>mainWindow.minimize());handle('hide',()=>mainWindow.hide());handle('quit',requestQuit);
 handle('toggle-maximize',()=>{if(mainWindow.isMaximized())mainWindow.unmaximize();else mainWindow.maximize();return windowState();});
 handle('voice',value=>{if(typeof value!=='boolean')throw new Error('语音开关无效');if(tray?._changliMenu)tray._changliMenu.items[3].checked=value;return value;});
}
async function pollTasks(){
 if(!host?.requestBackend)return;
 try{
  const state=await host.requestBackend('/api/state?character=changli');
  const desiredShortcut=state.speech?.recordingShortcut||'';
  if(desiredShortcut!==polledShortcut){polledShortcut=desiredShortcut;setShortcut(desiredShortcut);}
  for(const task of state.tasks||[]){
   const previous=lastTasks.get(task.id);lastTasks.set(task.id,task.status);
   if(!readyTasks)continue;
   if(task.status==='running'&&previous!=='running')mainWindow.hide();
   if(task.status==='awaiting_approval'&&previous!=='awaiting_approval')showMain('tasks');
   if(['completed','failed','cancelled'].includes(task.status)&&previous&&previous!==task.status){
    const title=task.status==='completed'?'任务已完成':'任务状态已更新';
    emit({type:'task-complete',taskId:task.id,title,status:task.status});
    if(Notification.isSupported()){const notice=new Notification({title,body:'点击查看任务结果与详情',silent:false});notice.on('click',()=>showMain('tasks'));notice.show();}
   }
  }
  readyTasks=true;
 }catch{log('backend-poll-unavailable');}
}
async function pauseCurrentTask(){
 try {
  const tasks=activeTasks((await host.requestBackend('/api/state?character=changli')).tasks||[]);
  for(const task of tasks)await host.requestBackend(`/api/characters/changli/tasks/${encodeURIComponent(task.id)}/interrupt`,{method:'POST',body:{}});
  showMain('tasks');
 }catch{showMain('tasks');emit({type:'task-pause-error',message:'暂时无法暂停，请在任务页重试。'});}
}
async function requestQuit(){
 if(quitting)return;
 let active=[];
 try {active=activeTasks((await host.requestBackend('/api/state?character=changli')).tasks||[]);}catch{
  const answer=await dialog.showMessageBox(mainWindow,{type:'warning',message:'暂时无法读取任务状态',detail:'为避免中断未知任务，请恢复连接后再退出。',buttons:['返回继续运行','仍然退出'],defaultId:0,cancelId:0});if(answer.response!==1)return;
 }
 if(active.length){
  const answer=await dialog.showMessageBox(mainWindow,{type:'question',message:'仍有任务正在执行',detail:'选择停止任务并退出，或返回继续运行。',buttons:['返回继续运行','停止任务并退出'],defaultId:0,cancelId:0});
  if(answer.response!==1)return;
  try {for(const task of active)await host.requestBackend(`/api/characters/changli/tasks/${encodeURIComponent(task.id)}/cancel`,{method:'POST',body:{}});}catch{dialog.showErrorBox('任务尚未停止','无法停止任务，程序将继续运行。请查看任务后重试。');return;}
 }
 await shutdown();
}
async function shutdown(){
 if(quitting)return;quitting=true;clearInterval(taskTimer);globalShortcut.unregisterAll();stopWallpaper();
 if(watchdog?.connected){await new Promise(done=>watchdog.send('clean-exit',()=>{watchdog.disconnect();done();}));}
 if(!testMode)writeFileSync(join(dataDir,'task-recovery.json'),JSON.stringify({time:new Date().toISOString(),ok:true,paused:0,clean:true}));
 try{const snapshot=await native('Snapshot');let original;try{original=JSON.parse(readFileSync(join(dataDir,'wallpaper-recovery.json'),'utf8'));}catch{}log('wallpaper-restoration',{unchanged:!original||snapshot.wallpaper===original.wallpaper});}catch{log('wallpaper-restoration-unverified');}
 for(const w of windows())w.destroy();tray?.destroy();await host?.close();app.quit();
}
async function smoke(){
 const result={electron:process.versions.electron,security:{nodeIntegration:false,contextIsolation:true,sandbox:true},checks:[]};
 result.checks.push({name:'main-initially-visible',pass:mainWindow.isVisible()});
 result.checks.push({name:'main-pet-local-page',pass:windows().every(w=>w.webContents.getURL().startsWith(host.url))});
 const bridge=await mainWindow.webContents.executeJavaScript('typeof window.desktop?.getState === "function"');result.checks.push({name:'isolated-preload-bridge',pass:bridge});
 await new Promise(done=>setTimeout(done,1000));
 writeFileSync(join(root,'qa/main-electron.png'),(await mainWindow.webContents.capturePage()).toPNG());
 writeFileSync(join(root,'qa/pet-electron.png'),(await petWindow.webContents.capturePage()).toPNG());
 const button=await petWindow.webContents.executeJavaScript("(()=>{const r=document.getElementById('pet-canvas').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
 const bounds=petWindow.getBounds(),point=screen.dipToScreenPoint({x:Math.round(bounds.x+button.x),y:Math.round(bounds.y+button.y)});
 const probe=await native('Probe',['-X',String(point.x),'-Y',String(point.y)]);
 result.checks.push({name:'native-pet-button-hittable',pass:probe.root===petWindow.getNativeWindowHandle().readBigUInt64LE().toString()});
 const blankPoint=screen.dipToScreenPoint({x:bounds.x+10,y:bounds.y+10});
 const blankProbe=await native('Probe',['-X',String(blankPoint.x),'-Y',String(blankPoint.y)]);
 result.checks.push({name:'native-transparent-area-falls-through',pass:blankProbe.root!==petWindow.getNativeWindowHandle().readBigUInt64LE().toString()});
 const firstEntry=await mainWindow.webContents.executeJavaScript('window.desktop.enterChat()');
 const secondEntry=await mainWindow.webContents.executeJavaScript('window.desktop.enterChat()');
 result.checks.push({name:'greeting-once-per-full-launch',pass:firstEntry.greet===true&&secondEntry.greet===false});
 mainWindow.close();result.checks.push({name:'close-hides-keeps-pet',pass:!mainWindow.isVisible()&&!petWindow.isDestroyed()});
 showMain('chat');result.checks.push({name:'restore-reuses-window',pass:mainWindow.isVisible()});
 result.checks.push({name:'tray-menu-six-actions',pass:tray._changliMenu.items.length===6});
 const snapshot=await native('Snapshot');result.checks.push({name:'windows-wallpaper-readable',pass:typeof snapshot.wallpaper==='string'});
 if(process.argv.includes('--wallpaper-smoke')){
  await startWallpaper(true);
  result.checks.push({name:'actual-workerw-attached',pass:settings.wallpaperStatus==='attached'});
  if(wallpaperWindow&&!wallpaperWindow.isDestroyed()){
   await new Promise(done=>setTimeout(done,1800));
   const image=await wallpaperWindow.webContents.capturePage();writeFileSync(join(root,'qa/wallpaper-electron.png'),image.toPNG());
  }
  stopWallpaper();const after=await native('Snapshot');
  result.checks.push({name:'actual-wallpaper-restored',pass:after.wallpaper===snapshot.wallpaper});
  result.checks.push({name:'native-cursor-forwarding',pass:nativePointers>0});
 }
 result.checks.push({name:'no-renderer-console-errors',pass:rendererErrors.length===0});result.rendererErrors=rendererErrors;
 writeFileSync(join(root,'qa/shell-smoke.json'),JSON.stringify(result,null,2));log('smoke-finished',{checks:result.checks.length,pass:result.checks.every(c=>c.pass)});
 await shutdown();
}
if(!app.requestSingleInstanceLock()){app.quit();}else{
 app.on('second-instance',()=>showMain());app.on('window-all-closed',()=>{});
 app.on('before-quit',event=>{if(!quitting){event.preventDefault();void requestQuit();}});
 app.whenReady().then(async()=>{
  const {startDesktopServer}=await import(pathToFileURL(join(root,'server.mjs')).href);
  host=await startDesktopServer({testMode,...(testMode?{port:0}:{})});
  if(!testMode){
   const foundationRoot='D:/GPT/背景项目通用功能/智能底基/底基1.0';
   if(existsSync(join(root,'runtime/node.exe'))&&existsSync(join(foundationRoot,'.env'))){
    const env={SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,PATH:process.env.PATH};
    watchdog=spawn(join(root,'runtime/node.exe'),[join(root,'scripts/lifecycle-watch.mjs'),foundationRoot,join(root,'logs/shell.log'),join(dataDir,'task-recovery.json')],{windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],env});
    watchdog.on('error',()=>log('task-watchdog-unavailable'));
   }
  }
  const localOrigin=new URL(host.url).origin;const shared=session.fromPartition('persist:changli');
  shared.setPermissionRequestHandler((contents,permission,callback,details)=>{callback(permission==='media'&&new URL(contents.getURL()).origin===localOrigin&&details.mediaTypes?.every(t=>t==='audio'));});
  shared.setPermissionCheckHandler((contents,permission,origin,details)=>permission==='media'&&origin===localOrigin&&details.mediaType==='audio');
  shared.webRequest.onBeforeRequest((details,callback)=>{try{const url=new URL(details.url);callback({cancel:!['blob:','devtools:'].includes(url.protocol)&&url.origin!==localOrigin});}catch{callback({cancel:true});}});
  const area=screen.getPrimaryDisplay().workArea,size=clampSize(settings,area);
  mainWindow=secureWindow({title:'长离 · 听雪闲叙',...size,show:false,center:true,frame:false,minWidth:Math.min(860,area.width),minHeight:Math.min(650,area.height),backgroundColor:'#1b191b'});
  mainWindow.center();mainWindow.on('resize',()=>{if(!mainWindow.isMaximized()){const b=mainWindow.getBounds();settings.width=b.width;settings.height=b.height;saveSettings();}});
  for(const event of ['maximize','unmaximize','minimize','restore','show','hide'])mainWindow.on(event,()=>emit({type:'window-state',...windowState()}));
  mainWindow.on('close',event=>{if(!quitting){event.preventDefault();mainWindow.hide();}});
  function sizePetDesktop(){
   const displays=screen.getAllDisplays(),x=Math.min(...displays.map(d=>d.bounds.x)),y=Math.min(...displays.map(d=>d.bounds.y));
   const desktop={x,y,width:Math.max(...displays.map(d=>d.bounds.x+d.bounds.width))-x,height:Math.max(...displays.map(d=>d.bounds.y+d.bounds.height))-y};
   const old=petWindow?.getBounds();
   const point=petPosition&&old?{x:old.x+petPosition.x,y:old.y+petPosition.y}:{x:area.x+area.width-280,y:area.y+area.height-210};
   const size=petSize(settings.petSettings);
   petPosition=petPlacement(point,screen.getDisplayNearestPoint({x:Math.round(point.x+size.width/2),y:Math.round(point.y+size.height/2)}).workArea,desktop,size);
   return desktop;
  }
  petWindow=secureWindow({title:'长离桌宠',...sizePetDesktop(),show:false,frame:false,transparent:true,skipTaskbar:true,resizable:false,alwaysOnTop:true,hasShadow:false});
  petWindow.setAlwaysOnTop(true,'screen-saver');petWindow.on('close',event=>{if(!quitting){event.preventDefault();petWindow.hide();}});
  const resizePet=()=>{if(petWindow.isDestroyed())return;const bounds=sizePetDesktop();petWindow.setBounds(bounds);petWindow.webContents.send('desktop:event',{type:'pet-position',...petPosition});};
  screen.on('display-added',resizePet);screen.on('display-removed',resizePet);screen.on('display-metrics-changed',resizePet);
  installIPC();Menu.setApplicationMenu(null);
  let icon=nativeImage.createFromPath(join(root,'assets/changli-avatar.jpg')).resize({width:32,height:32});
  if(icon.isEmpty()){const bitmap=Buffer.alloc(32*32*4);for(let i=0;i<bitmap.length;i+=4){bitmap[i]=57;bitmap[i+1]=43;bitmap[i+2]=145;bitmap[i+3]=255;}icon=nativeImage.createFromBitmap(bitmap,{width:32,height:32});}
  mainWindow.setIcon(icon);
  tray=new Tray(icon);tray.setToolTip('长离 · 听雪闲叙');
  const menu=Menu.buildFromTemplate([{label:'打开聊天',click:()=>showMain('chat')},{label:'查看任务',click:()=>showMain('tasks')},{label:'暂停当前任务',click:pauseCurrentTask},{label:'语音开关',type:'checkbox',checked:true,click:item=>emit({type:'audio-toggle',enabled:item.checked})},{label:'设置',click:()=>showMain('settings')},{label:'彻底退出',click:requestQuit}]);
  tray._changliMenu=menu;tray.setContextMenu(menu);tray.on('double-click',()=>showMain());
  await Promise.all([mainWindow.loadURL(host.url+'/'),petWindow.loadURL(host.url+'/pet.html')]);
  menu.items[3].checked=await mainWindow.webContents.executeJavaScript("localStorage.getItem('changli-speech-enabled') !== 'false'");
  mainWindow.show();if(settings.petVisible)petWindow.showInactive();
  log('desktop-ready',{electron:process.versions.electron,testMode});
  if(testMode){if(!uiCheck)await smoke();else {
   log('ui-check-ready');
   setTimeout(async()=>{
    showMain('home');
    writeFileSync(join(root,'qa/native-window-state.json'),JSON.stringify(BrowserWindow.getAllWindows().map(w=>({id:w.id,title:w.getTitle(),visible:w.isVisible(),minimized:w.isMinimized(),bounds:w.getBounds()})),null,2));
    writeFileSync(join(root,'qa/main-native-initial.png'),(await mainWindow.webContents.capturePage()).toPNG());
    writeFileSync(join(root,'qa/pet-native-initial.png'),(await petWindow.webContents.capturePage()).toPNG());
    const button=await petWindow.webContents.executeJavaScript("(()=>{const r=document.getElementById('pet-canvas').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
    const b=petWindow.getBounds(),point=screen.dipToScreenPoint({x:Math.round(b.x+button.x),y:Math.round(b.y+button.y)});
    const hit=await native('Probe',['-X',String(point.x),'-Y',String(point.y)]);
    writeFileSync(join(root,'qa/native-pet-hit.json'),JSON.stringify({button,bounds:b,point,hit,petRoot:petWindow.getNativeWindowHandle().readBigUInt64LE().toString(),petHasShape,rendererErrors},null,2));
   },500);
  }return;}
  taskTimer=setInterval(pollTasks,3000);void pollTasks();if(settings.wallpaperEnabled)void startWallpaper();
 }).catch(error=>{log('startup-failed',{message:error.message});dialog.showErrorBox('长离暂时无法启动',error.message);quitting=true;stopWallpaper();void host?.close();app.exit(1);});
}
