'use strict';
(() => {
  function receive(event) {
    if(event.type === 'wallpaper-pointer') {
      const stage = document.getElementById('stage');
      if(event.active===false){stage.dispatchEvent(new PointerEvent('pointerleave'));return;}
      const rect = stage.getBoundingClientRect();
      const x = event.x, y = event.y;
      stage.dispatchEvent(new PointerEvent('pointermove',{clientX:x,clientY:y,bubbles:true}));
      if(event.down) {
        const target = document.elementFromPoint(x,y)?.closest('.zone');
        target?.dispatchEvent(new MouseEvent('click',{clientX:x,clientY:y,bubbles:true}));
      }
      if(x<rect.left||x>rect.right||y<rect.top||y>rect.bottom) stage.dispatchEvent(new PointerEvent('pointerleave'));
    }
    if(event.type === 'audio-toggle' && event.enabled===false)document.getElementById('stop-voice').click();
    if(event.type === 'wallpaper-settings'){
      if(typeof event.follow==='boolean'){
        const follow=document.getElementById('eye-follow'); follow.checked=event.follow; follow.dispatchEvent(new Event('change'));
      }
      if(typeof event.volume==='number')document.getElementById('voice').volume=Math.max(0,Math.min(1,event.volume));
      if(typeof event.videoSound==='boolean')document.getElementById('wallpaper').muted=!event.videoSound;
      if(typeof event.paused==='boolean'){
        if(event.paused)document.getElementById('wallpaper').pause();
        else document.getElementById('wallpaper').play().catch(()=>{});
      }
    }
  }
  window.desktop?.onEvent(receive);
  const preferences = new BroadcastChannel('changli-preferences');
  preferences.addEventListener('message',({data})=>{if(data?.type==='wallpaper-settings')receive(data);});
  window.desktop?.getState().then(state=>{
    if(state?.wallpaperSettings)receive({type:'wallpaper-settings',...state.wallpaperSettings});
  }).catch(()=>{});
})();
