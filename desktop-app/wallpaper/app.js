'use strict';
(async () => {
  const { SpeechPlayer } = await import("/speech-player.js");
  const $ = id => document.getElementById(id);
  const stage = $('stage'), video = $('wallpaper'), audio = $('voice'), status = $('status');
  const groups = {head_accessory:'头部／发饰',hand:'手部',shoulder_body:'肩部／身体'};
  const previous = {}, history = [];
  let requestId = 0, current = null;
  const channel = new BroadcastChannel('foundation-role-audio');
  const player = new SpeechPlayer({audio, channel, locks:navigator.locks, request:async()=>{}, status:text=>{status.textContent=text;}});
  channel.addEventListener('message',()=>{++requestId;current=null;});
  const preferences = new BroadcastChannel('changli-preferences');
  preferences.addEventListener('message',({data})=>{if(data?.key==='voiceEnabled'&&!data.value)stopVoice();});
  audio.volume = Number($('voice-volume').value);

  function stopVoice() {
    ++requestId;
    player.stop();
    if (audio.readyState) audio.currentTime = 0;
    current = null;
    status.textContent = '语音已停止，可以继续点击。';
  }

  async function playVoice(filename, group, id) {
    const ticket = ++requestId;
    player.stop();
    current = {group, id};
    history.push({group,id});
    if (history.length > 40) history.shift();
    status.dataset.group = group;
    status.dataset.voiceId = id;
    status.textContent = group === 'chat_sample' ? '聊天语音样本播放中；点击人物可以打断。' : groups[group] + '台词播放中。';
    try {
      const response = await fetch('media/' + encodeURIComponent(filename));
      if(!response.ok) throw new Error('台词未载入');
      const blob = await response.blob();
      if(ticket !== requestId) return;
      await player.playBlob(blob);
    } catch (error) {
      if (ticket === requestId) {
        current = null;
        status.textContent = '语音未能播放，请再点击一次；仍无声时检查页面与系统音量。';
      }
    }
  }

  function touch(group, element) {
    if (current && current.group !== 'chat_sample') {
      stopVoice();
      return;
    }
    const options = window.PREVIEW_ASSETS.voices.filter(row => row.group_id === group && row.id !== previous[group]);
    const choice = options[Math.floor(Math.random() * options.length)];
    if (!choice) return;
    previous[group] = choice.id;
    playVoice(choice.filename, group, choice.id);
    element.classList.add('flash');
    clearTimeout(element.flashTimer);
    element.flashTimer = setTimeout(() => element.classList.remove('flash'), 180);
  }
  document.querySelectorAll('.zone').forEach(element => {
    element.addEventListener('click', () => touch(element.dataset.group, element));
    element.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        touch(element.dataset.group, element);
      }
    });
  });
  audio.addEventListener('ended', () => {
    current = null;
    status.textContent = '播放结束，可以继续点击。';
  });
  $('chat-sample').addEventListener('click', () => playVoice('chat-sample.wav','chat_sample','chat-sample'));
  $('stop-voice').addEventListener('click', stopVoice);
  $('voice-volume').addEventListener('input', event => { audio.volume = Number(event.target.value); });
  $('show-zones').addEventListener('change', event => stage.classList.toggle('show-zones', event.target.checked));
  $('video-sound').addEventListener('change', event => { video.muted = !event.target.checked; });
  $('pause').addEventListener('click', () => {
    if (video.paused) video.play().catch(() => { $('loading').hidden = false; $('loading').textContent = '请再点击“播放画面”'; });
    else video.pause();
  });
  video.addEventListener('play', () => { $('pause').textContent = '暂停画面'; });
  video.addEventListener('pause', () => { $('pause').textContent = '播放画面'; });
  video.addEventListener('loadeddata', () => { $('loading').hidden = true; });
  video.addEventListener('error', () => { $('loading').hidden = false; $('loading').textContent = '视频未载入，请用文件夹内的启动入口重开'; });
  $('fullscreen').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch { status.textContent = '当前窗口不支持全屏，可在浏览器打开本页。'; }
  });

  const eyes = $('eyes'), eyeContext = eyes.getContext('2d');
  const source = document.createElement('canvas');
  source.width = eyes.width; source.height = eyes.height;
  const sourceContext = source.getContext('2d', {willReadFrequently:true});
  const zoomContext = $('eye-zoom').getContext('2d');
  const output = eyeContext.createImageData(180, 120);
  const gaze = {x:0,y:0,targetX:0,targetY:0,visibleEyes:0};
  const bounds = [{x:40,y:53,w:40,h:31},{x:108,y:29,w:40,h:33}];
  const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));

  function resetGaze() { gaze.targetX = gaze.targetY = 0; }
  stage.addEventListener('pointermove', event => {
    if (event.pointerType === 'touch' || !$('eye-follow').checked) return resetGaze();
    const rect = stage.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width * 1920;
    const y = (event.clientY - rect.top) / rect.height * 1080;
    if (x < 400 || x > 1120 || y < 0 || y > 650) return resetGaze();
    let horizontal = clamp((x - 742) / 160, -1, 1);
    let vertical = clamp((y - 290) / 150, -1, 1);
    const length = Math.max(1, Math.hypot(horizontal, vertical));
    gaze.targetX = horizontal / length * 2.5;
    gaze.targetY = vertical / length * 1;
  });
  stage.addEventListener('pointerleave', resetGaze);
  window.addEventListener('blur', resetGaze);
  $('eye-follow').addEventListener('change', () => { resetGaze(); if (!$('eye-follow').checked) gaze.x = gaze.y = 0; });

  // shortcut: eye regions belong to this fixed-camera clip; re-calibrate for a different video.
  function renderEyes(delta) {
    const ease = 1 - Math.exp(-delta / 100);
    gaze.x += (gaze.targetX - gaze.x) * ease;
    gaze.y += (gaze.targetY - gaze.y) * ease;
    eyeContext.clearRect(0, 0, 180, 120);
    gaze.visibleEyes = 0;
    if (!$('eye-follow').checked || Math.abs(gaze.x) + Math.abs(gaze.y) < .02) return;
    sourceContext.drawImage(video,650,230,180,120,0,0,180,120);
    const pixels = sourceContext.getImageData(0,0,180,120).data;
    output.data.fill(0);
    for (const region of bounds) {
      let weight=0,cx=0,cy=0,count=0;
      for(let y=region.y;y<region.y+region.h;y++)for(let x=region.x;x<region.x+region.w;x++) {
        const i=(y*180+x)*4,r=pixels[i],g=pixels[i+1],b=pixels[i+2];
        if(g-b>22&&r-g>6&&g>95&&r>130) {
          const w=g-b-22;weight+=w;cx+=x*w;cy+=y*w;count++;
        }
      }
      if(count<12||weight<170)continue;
      cx/=weight;cy/=weight;gaze.visibleEyes++;
      for(let y=Math.floor(cy-12);y<=Math.ceil(cy+12);y++)for(let x=Math.floor(cx-16);x<=Math.ceil(cx+16);x++) {
        const ox=x-cx,oy=y-cy,ex=ox*.92-oy*.39,ey=ox*.39+oy*.92;
        const radius=ex*ex/(14*14)+ey*ey/(7.5*7.5);
        if(radius>=1)continue;
        const edge=clamp((Math.sqrt(radius)-.25)/.75,0,1),strength=1-edge*edge*(3-2*edge);
        const sx=x-gaze.x*strength,sy=y-gaze.y*strength,x0=Math.floor(sx),y0=Math.floor(sy),fx=sx-x0,fy=sy-y0,dest=(y*180+x)*4;
        for(let c=0;c<3;c++) {
          const a=pixels[(y0*180+x0)*4+c],b=pixels[(y0*180+x0+1)*4+c],d=pixels[((y0+1)*180+x0)*4+c],e=pixels[((y0+1)*180+x0+1)*4+c];
          output.data[dest+c]=(a*(1-fx)+b*fx)*(1-fy)+(d*(1-fx)+e*fx)*fy;
        }
        output.data[dest+3]=255;
      }
    }
    eyeContext.putImageData(output,0,0);
  }
  let last = 0;
  function tick(now) {
    const delta = Math.min(now-last || 16,50); last = now;
    if (!document.hidden && video.readyState >= 2) {
      renderEyes(delta);
      if ($('eye-detail').open) {
        zoomContext.drawImage(video,650,230,180,90,0,0,720,360);
        zoomContext.drawImage(eyes,0,0,180,90,0,0,720,360);
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  window.WALLPAPER_PREVIEW = {
    get state() { return {current,history:history.slice(),gaze:{...gaze},eyeMode:'original-video-local-follow',baseGaze:{source:'original-video'},externalAudioPolicy:'allow-concurrent',liveChatConnected:false}; }
  };
})();
