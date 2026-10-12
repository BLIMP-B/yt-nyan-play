(() => {
  if (typeof NyanMedia === 'undefined') return;
  const buttonMap = new Map();
  let candidates = [], scanTimer, positionFrame, modal, current, previousFocus, playMode = 'play', timeMode = 'start';
  const alive = () => { try { return !!chrome.runtime.id; } catch { return false; } };
  const message = payload => new Promise(resolve => {
    try { chrome.runtime.sendMessage(payload, result => resolve(chrome.runtime.lastError ? { ok: false, error: '拡張機能を再読み込みし、このタブを更新してください。' } : result || { ok: false, error: '送信結果を取得できませんでした。' })); }
    catch { resolve({ ok: false, error: '拡張機能を再読み込みし、このタブを更新してください。' }); }
  });
  const storage = defaults => new Promise(resolve => { try { chrome.storage.sync.get(defaults, r => resolve(chrome.runtime.lastError ? defaults : r || defaults)); } catch { resolve(defaults); } });
  const mask = url => { try { const u = new URL(url); return `${u.hostname}/api/webhooks/••••${u.pathname.split('/').at(-1).slice(-4)}`; } catch { return '未設定'; } };
  const style = `
    :host { all: initial; font: 14px/1.5 system-ui, "Noto Sans CJK JP", sans-serif; color: #252526; color-scheme: light; --bg:#fff; --field:#f5f5f5; --fg:#252526; --muted:#616161; --border:#d4d4d4; --accent:#0078d4; --hover:#e8f2fa; }
    :host([hidden]) { display:none !important; }
    :host([data-theme="dark"]) { color-scheme:dark; --bg:#252526; --field:#1e1e1e; --fg:#e4e4e4; --muted:#aaa; --border:#454545; --accent:#70b7f5; --hover:#323e48; }
    *, *::before, *::after { box-sizing:border-box; } button,input,select { font:inherit; } button { cursor:pointer; }
    button:focus-visible,input:focus-visible,select:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
    button { background:var(--bg); color:var(--fg); border:1px solid var(--border); border-radius:6px; padding:7px 12px; display:inline-flex; align-items:center; justify-content:center; gap:7px; }
    button:hover { background:var(--hover); } button:disabled { opacity:.5; cursor:default; }
    .trigger { font-weight:600; border-radius:20px; box-shadow:0 2px 8px #0003; white-space:nowrap; padding:6px 11px; font-size:13px; }
    .trigger img { width:20px; height:20px; border-radius:5px; }
    .overlay { position:fixed; inset:0; background:#0008; display:grid; place-items:center; padding:12px; pointer-events:auto; }
    .panel { width:min(540px,100%); max-height:calc(100dvh - 24px); display:flex; flex-direction:column; background:var(--bg); color:var(--fg); border:1px solid var(--border); border-radius:10px; box-shadow:0 16px 64px #0006; }
    header,footer { padding:13px 16px; display:flex; align-items:center; gap:10px; flex-shrink:0; } header { border-bottom:1px solid var(--border); } header img { width:25px; height:25px; border-radius:5px; } header strong { flex:1; font-size:16px; } header button { border:0; padding:4px 8px; font-size:22px; line-height:1; }
    main { overflow:auto; padding:14px 16px; display:grid; gap:13px; } footer { border-top:1px solid var(--border); justify-content:flex-end; }
    label,.label { display:block; font-size:13px; color:var(--muted); } select { width:100%; margin-top:5px; padding:8px; background:var(--field); color:var(--fg); border:1px solid var(--border); border-radius:5px; }
    .segments { display:flex; flex-wrap:wrap; gap:6px; } .segments button[aria-pressed="true"] { background:var(--hover); color:var(--accent); border-color:var(--accent); }
    .hint { font-size:12px; color:var(--muted); margin:0; } .preview { padding:10px 12px; background:var(--field); border:1px solid var(--border); border-radius:6px; white-space:pre-wrap; overflow-wrap:anywhere; font-size:12px; }
    .destination { display:flex; align-items:center; gap:10px; padding:9px 10px; border:1px solid var(--border); border-radius:6px; color:var(--fg); cursor:pointer; } .destination small { display:block; color:var(--muted); font-size:11px; } input[type="checkbox"] { accent-color:var(--accent); width:16px; height:16px; }
    .destinations { display:grid; gap:7px; } #status { margin:0; font-size:13px; color:var(--fg); } #send { background:#0078d4; color:white; border-color:#0078d4; } #settings { margin-right:auto; }
    @media(max-width:420px) { main { padding:12px; } header,footer { padding:12px; } .segments button { padding:6px 9px; } }
  `;
  function theme(host) {
    const bg = getComputedStyle(document.body || document.documentElement).backgroundColor.match(/[\d.]+/g)?.map(Number);
    const dark = bg && bg.length >= 3 && (bg.length < 4 || bg[3] > .2) ? .2126*bg[0]+.7152*bg[1]+.0722*bg[2] < 128 : matchMedia('(prefers-color-scheme: dark)').matches;
    host.dataset.theme = dark ? 'dark' : 'light';
  }
  function shadow(host) { const root = host.attachShadow({ mode:'open' }); const css = document.createElement('style'); css.textContent=style; root.append(css); theme(host); return root; }
  function node(tag, text, props = {}) { const e=document.createElement(tag); if(text!=null)e.textContent=text; Object.assign(e,props); return e; }
  function icon() { return node('img', null, {src:chrome.runtime.getURL('furoneko70furoneko70.png'),alt:''}); }
  function close() { if(modal) modal.hidden=true; previousFocus?.focus(); }
  async function open(candidate) {
    if (!alive()) return;
    scan(); candidates = candidates.filter(c=>c.media.isConnected);
    current=candidates.find(c=>c.media===candidate.media); if(!current)return;
    previousFocus=document.activeElement;
    modal?.remove(); modal=node('div',null,{id:'nyan-play-share-modal'}); modal.style.cssText='position:fixed;inset:0;z-index:2147483647;pointer-events:none';
    const root=shadow(modal), overlay=node('div',null,{className:'overlay'}), panel=node('section',null,{className:'panel'});
    panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','true');panel.setAttribute('aria-labelledby','dialog-title');
    const header=node('header'), title=node('strong','Discordで再生',{id:'dialog-title'}), dismiss=node('button','×',{type:'button'});dismiss.setAttribute('aria-label','閉じる');dismiss.onclick=close;header.append(icon(),title,dismiss);
    const main=node('main'), mediaLabel=node('label','送信するメディア'), select=node('select',null,{id:'media-candidate'});
    for(let i=0;i<candidates.length;i++) { const c=candidates[i];select.append(node('option',`${c.serviceName} · ${c.title} (${c.kind}${candidates.filter(x=>x.url===c.url).length>1?' '+(i+1):''})`,{value:String(i),selected:c===current})); }
    mediaLabel.append(select);main.append(mediaLabel);
    const preview=node('div',null,{id:'preview',className:'preview'}), hint=node('p',null,{className:'hint'}), status=node('p','',{id:'status'}); status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    let busy=false, failedOnly=null; const selected = new Set();
    const refresh=()=>{ preview.textContent=NyanMedia.content(current,{mode:playMode,time:timeMode});hint.textContent=playMode==='play'?'サービス名の読み上げ後、45秒再生します。':playMode==='infinite'?'サービス名の読み上げ後、最後まで1回再生します。':'案内の読み上げなしで、最後まで1回再生します。'; };
    const segments=(id,choices,get,set)=>{ const row=node('div',null,{id,className:'segments'});row.setAttribute('role','group');row.setAttribute('aria-label',id==='mode'?'再生方式':'開始位置');for(const[value,label]of choices){const b=node('button',label,{type:'button'});b.dataset.value=value;b.onclick=()=>{if(busy)return;set(value);for(const x of row.children)x.setAttribute('aria-pressed',String(x.dataset.value===get()));refresh();};b.setAttribute('aria-pressed',String(value===get()));row.append(b);}return row; };
    main.append(segments('mode',[['play','再生'],['infinite','無限'],['direct','直接']],()=>playMode,x=>playMode=x),hint,segments('position',[['start','最初から'],['current','現在位置']],()=>timeMode,x=>timeMode=x),node('div','送信内容',{className:'label'}),preview);
    const destRoot=node('div',null,{className:'destinations'}), data=await storage({destinations:[]});
    const destinations=Array.isArray(data.destinations)?data.destinations.filter(x=>x&&typeof x.webhookUrl==='string'):[];
    const footer=node('footer'), settings=node('button','設定',{id:'settings',type:'button'}),cancel=node('button','キャンセル',{type:'button'}),send=node('button','送信',{id:'send',type:'button',disabled:true});
    settings.onclick=()=>message({type:'OPEN_OPTIONS'});cancel.onclick=()=>{if(!busy)close();};footer.append(settings,cancel,send);
    if(!destinations.length)destRoot.append(node('p','送信先が未設定です。「設定」から追加してください。',{className:'hint'}));
    for(const d of destinations){const label=node('label',null,{className:'destination'}),cb=node('input',null,{type:'checkbox'}),meta=node('span',d.label||'送信先');meta.append(node('small',mask(d.webhookUrl)));cb.onchange=()=>{if(cb.checked)selected.add(d.webhookUrl);else selected.delete(d.webhookUrl);failedOnly=null;send.textContent='送信';send.disabled=selected.size===0;};label.append(cb,meta);destRoot.append(label);}
    select.onchange=()=>{current=candidates[Number(select.value)];failedOnly=null;send.textContent='送信';refresh();};
    main.append(node('div','送信先',{className:'label'}),destRoot,status);panel.append(header,main,footer);overlay.append(panel);root.append(overlay);document.documentElement.append(modal);refresh();dismiss.focus();
    overlay.onclick=e=>{if(e.target===overlay&&!busy)close();};
    root.addEventListener('keydown',e=>{if(e.key==='Escape'&&!busy){e.preventDefault();close();}if(e.key==='Tab'){const f=[...root.querySelectorAll('button,input,select')].filter(x=>!x.disabled),first=f[0],last=f.at(-1);if(e.shiftKey&&root.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&root.activeElement===last){e.preventDefault();first.focus();}}});
    send.onclick=async()=>{
      if(busy)return;
      if(!current.media.isConnected||!NyanMedia.detect().some(c=>c.media===current.media&&c.url===current.url)){status.textContent='対象のメディアが変更されました。送信画面を開き直してください。';return;}
      const urls=failedOnly||[...selected],content=NyanMedia.content(current,{mode:playMode,time:timeMode});if(!urls.length)return;
      busy=true;send.disabled=true;send.textContent='送信中…';for(const input of root.querySelectorAll('input,select'))input.disabled=true;status.textContent='';
      const result=await message({type:'SEND_TO_DISCORD_WEBHOOKS',webhookUrls:urls,content});
      busy=false;for(const input of root.querySelectorAll('input,select'))input.disabled=false;
      const results=Array.isArray(result.results)?result.results:urls.map(url=>({url,ok:false,error:result.error||'結果を確認できませんでした。'}));
      const ok=results.filter(r=>r.ok),bad=results.filter(r=>!r.ok);failedOnly=bad.map(r=>r.url);send.disabled=!bad.length;send.textContent=bad.length?'失敗した宛先に再送':'送信完了';
      status.textContent=results.map(r=>`${destinations.find(d=>d.webhookUrl===r.url)?.label||'送信先'}: ${r.ok?'送信完了':r.error||'送信失敗'}`).join(' / ');
      if(ok.length){const saved=await storage({history:[]});const history=Array.isArray(saved.history)?saved.history:[];history.unshift({text:content,time:new Date().toISOString(),webhookUrls:ok.map(r=>mask(r.url)),status:bad.length?'partial':'success'});try{await chrome.storage.sync.set({history:history.slice(0,20)});}catch{status.textContent+=' / 履歴を保存できませんでした。';}}
    };
  }
  function createButton(candidate) {
    const host=node('div');host.dataset.nyanPlayButton='';host.style.cssText='position:fixed;z-index:2147483646;pointer-events:auto';const root=shadow(host),button=node('button','',{type:'button',className:'trigger'});button.setAttribute('aria-label',`${candidate.serviceName}のメディアをDiscordで再生`);button.append(icon(),node('span','再生'));button.onclick=e=>{e.preventDefault();e.stopPropagation();open(buttonMap.get(candidate.media)?.candidate||candidate);};root.append(button);document.documentElement.append(host);return{host,button,candidate};
  }
  function positions() {
    positionFrame=null;
    for(const {host,candidate}of buttonMap.values()){
      const r=candidate.media.getBoundingClientRect(),audio=candidate.kind==='音声';
      const visible=candidate.media.isConnected&&r.width>100&&r.height>(audio?12:50)&&r.bottom>20&&r.top<innerHeight-20&&r.right>50&&r.left<innerWidth-50&&getComputedStyle(candidate.media).visibility!=='hidden'&&getComputedStyle(candidate.media).display!=='none';
      if(!visible){host.hidden=true;continue;}host.hidden=false;
      const container=candidate.service==='youtube'&&location.pathname==='/watch'?document.querySelector('#top-level-buttons-computed'):null;
      if(container){if(host.parentElement!==container){host.style.position='relative';host.style.left='';host.style.top='';host.style.marginRight='8px';container.prepend(host);}}
      else {if(host.parentElement!==document.documentElement){document.documentElement.append(host);host.style.position='fixed';}host.style.left=`${Math.min(innerWidth-94,Math.max(4,r.right-94))}px`;host.style.top=`${Math.max(4,r.top+10)}px`;}
    }
  }
  function schedulePositions(){if(!positionFrame)positionFrame=requestAnimationFrame(positions);}
  function scan(){
    scanTimer=null;if(!alive()){for(const x of buttonMap.values())x.host.remove();buttonMap.clear();return;}
    candidates=NyanMedia.detect();const keep=new Set(candidates.map(c=>c.media));
    for(const [media,x]of buttonMap)if(!keep.has(media)||!x.host.isConnected){x.host.remove();buttonMap.delete(media);}
    for(const c of candidates){let x=buttonMap.get(c.media);if(!x){x=createButton(c);buttonMap.set(c.media,x);}x.candidate=c;theme(x.host);}
    schedulePositions();
  }
  function scheduleScan(){if(!scanTimer)scanTimer=setTimeout(scan,120);}
  new MutationObserver(records=>{if(records.some(r=>!r.target.closest?.('[data-nyan-play-button], #nyan-play-share-modal')))scheduleScan();}).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['src','href','class','style','hidden','aria-hidden']});
  document.addEventListener('loadedmetadata',scheduleScan,true);document.addEventListener('emptied',scheduleScan,true);document.addEventListener('yt-navigate-finish',scheduleScan);
  window.addEventListener('popstate',scheduleScan);window.addEventListener('resize',schedulePositions);document.addEventListener('scroll',schedulePositions,true);
  let previousUrl=location.href;setInterval(()=>{if(location.href!==previousUrl){previousUrl=location.href;close();scheduleScan();}},500);
  // Layout can change without scrolling (responsive players and lazy loading).
  setInterval(schedulePositions,750);scan();
})();
