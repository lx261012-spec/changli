// Silent alpha-video playback is shared infrastructure; the manifest owns each character's assets and crop.
export async function loadIdleAnimation(manifestURL) {
  const response=await fetch(manifestURL);
  if(!response.ok) return null;
  const config=await response.json();
  const source=new URL(config.src,location.href);
  if(source.origin!==location.origin||!source.pathname.startsWith('/assets/')) throw new Error('待机视频资源地址无效');
  const video=document.createElement('video');
  video.id='pet-idle-video';video.muted=true;video.loop=true;video.playsInline=true;video.preload='auto';video.hidden=true;
  document.body.append(video);
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('待机视频加载超时')),15000);
    video.addEventListener('loadeddata',()=>{clearTimeout(timer);resolve();},{once:true});
    video.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('待机视频无法解码'));},{once:true});
    video.src=source.href;
  });
  const bounds=config.bounds||{left:0,top:0,width:video.videoWidth,height:video.videoHeight};
  if(!['left','top','width','height'].every(k=>Number.isFinite(bounds[k]))||bounds.left<0||bounds.top<0||bounds.width<=0||bounds.height<=0||bounds.left+bounds.width>video.videoWidth||bounds.top+bounds.height>video.videoHeight) throw new Error('待机视频尺寸无效');
  document.addEventListener('visibilitychange',()=>{if(document.hidden)video.pause();else void video.play().catch(()=>{});});
  if(!document.hidden)await video.play();
  const result={video,bounds,config,frame:0};
  if(video.requestVideoFrameCallback){const tick=()=>{result.frame++;video.requestVideoFrameCallback(tick);};video.requestVideoFrameCallback(tick);}
  return result;
}
