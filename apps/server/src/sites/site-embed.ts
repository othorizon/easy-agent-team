/** 在用户页面运行的选择器；身份和评论表单始终位于平台源 iframe 内。 */
export const SITE_EMBED_SCRIPT = String.raw`(() => {
  if (document.getElementById('__eat_widget')) return;
  var script = document.currentScript;
  var config = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(script.dataset.eat), c => c.charCodeAt(0))));
  var origin = new URL(config.platform).origin;
  var root = document.createElement('div'); root.id = '__eat_widget';
  root.style.cssText = 'position:fixed!important;right:18px!important;bottom:18px!important;z-index:2147483646!important';
  // 隔离页面自身的 button / iframe / 全局样式，保证评论入口始终可用。
  var ui = root.attachShadow({mode:'open'});
  var style = document.createElement('style');
  style.textContent = ':host{all:initial}*{box-sizing:border-box}.wrap{font:14px/1.5 system-ui,sans-serif;color:#171717;display:flex;flex-direction:column;align-items:flex-end;gap:12px}button{font:inherit;cursor:pointer}button:focus-visible{outline:2px solid #93c5fd;outline-offset:3px}.toggle{position:relative;display:grid;place-items:center;width:40px;height:40px;flex:none;padding:0;border:1px solid #e5e7eb;border-radius:50%;background:#fff;color:#6b7280;box-shadow:0 2px 12px #17203308;transition:background-color .16s ease,border-color .16s ease,color .16s ease,box-shadow .16s ease}.toggle:hover{background:#fafafa;border-color:#d1d5db;color:#374151;box-shadow:0 3px 14px #17203310}.toggle[aria-expanded="true"]{background:#f8fafc;color:#475569}.toggle:active{background:#f1f5f9}.toggle-icon{display:flex;pointer-events:none}.comment-dot{position:absolute;top:2px;right:2px;width:6px;height:6px;border:0;border-radius:50%;background:#60a5fa;box-shadow:0 0 0 2px #fff;pointer-events:none}.comment-dot[hidden]{display:none}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}.panel{display:none;width:min(420px,calc(100vw - 36px));height:min(680px,calc(100dvh - 100px));background:#fff;border:1px solid #e5e5e5;border-radius:16px;overflow:hidden;box-shadow:0 12px 48px #0003}.panel iframe{display:block;width:100%;height:100%;border:0;background:#fff}.hint{display:none;max-width:calc(100vw - 36px);padding:10px 14px;border:1px solid #e5e5e5;border-radius:12px;background:#fff;box-shadow:0 4px 18px #0002}.hint span{display:block;color:#737373;font-size:12px}@media(pointer:coarse){.toggle{width:44px;height:44px}}@media(max-width:480px){.panel{width:calc(100vw - 36px);height:calc(100dvh - 100px)}}@media(prefers-reduced-motion:reduce){.toggle{transition:none}}';
  var wrap = document.createElement('div'); wrap.className='wrap';
  var toggle = document.createElement('button'); toggle.className='toggle'; toggle.type='button';
  var commentIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 11.75a8.75 8.75 0 0 1-12.6 7.85L3 21l1.4-4.9a8.75 8.75 0 1 1 16.1-4.35Z"/></svg>';
  var closeIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
  var toggleIcon=document.createElement('span'); toggleIcon.className='toggle-icon'; toggleIcon.innerHTML=commentIcon;
  var dot=document.createElement('span'); dot.className='comment-dot'; dot.hidden=true; dot.setAttribute('aria-hidden','true');
  var description=document.createElement('span'); description.id='eat-comment-description'; description.className='sr-only';
  var hasComments=false;
  var updateToggle=()=>{ var label=selecting?'取消标注':expanded?'收起评论':'评论'; toggleIcon.innerHTML=selecting||expanded?closeIcon:commentIcon; toggle.setAttribute('aria-label',label); toggle.setAttribute('aria-expanded',String(expanded&&!selecting)); toggle.title=label; dot.hidden=!hasComments||expanded||!!selecting; description.textContent=hasComments?'当前页面已有评论':''; };
  toggle.append(toggleIcon,dot); toggle.setAttribute('aria-controls','eat-comment-panel'); toggle.setAttribute('aria-describedby',description.id);
  var panel = document.createElement('div'); panel.className='panel'; panel.id='eat-comment-panel';
  var hint = document.createElement('div'); hint.className='hint'; hint.setAttribute('role','status');
  var frame = document.createElement('iframe'); frame.title = 'Folio 评论';
  var page = () => location.pathname + (/^#(?:\/|!)/.test(location.hash) ? location.hash : '');
  var url = new URL(config.platform + '/folio-comments/' + config.slug);
  url.searchParams.set('versionId', config.versionId); url.searchParams.set('page', page());
  url.searchParams.set('origin', location.origin);
  var thread = new URL(location.href).searchParams.get('eat_thread'); if (thread) url.searchParams.set('thread', thread);
  frame.src = url.href; panel.appendChild(frame); wrap.append(panel,hint,toggle); ui.append(style,wrap,description); document.body.appendChild(root);
  var send = (type, data) => frame.contentWindow.postMessage({ type: type, ...data }, origin);
  var lastPage=page();
  var init = () => { if(lastPage!==page()){ lastPage=page(); hasComments=false; updateToggle(); current=null; overlay.style.display='none'; cancelSelection(false); } send('eat:init', { proof: config.proof, page: page(), versionId: config.versionId }); };
  frame.addEventListener('load', init);
  var expanded=false, selecting=null, start=null, current=null, suppressClick=false, previousCursor='';
  updateToggle();
  var overlay = document.createElement('div'); overlay.id = '__eat_highlight';
  overlay.style.cssText = 'display:none;position:fixed;z-index:2147483645;pointer-events:none;border:2px solid #4f46e5;background:#6366f11a;box-sizing:border-box'; document.body.appendChild(overlay);
  var open = (focus) => { expanded=true; panel.style.display='block'; updateToggle(); init(); if(focus) frame.focus(); };
  var close = () => { expanded=false; panel.style.display='none'; updateToggle(); toggle.focus(); };
  var cancelSelection = (reopen) => { if(!selecting) return; selecting=null; start=null; hint.style.display='none'; document.documentElement.style.cursor=previousCursor; updateToggle(); if(current) draw(current.el,current.rect); else overlay.style.display='none'; if(reopen) open(true); };
  toggle.onclick = () => { if(selecting) cancelSelection(true); else if(expanded) close(); else open(true); };
  if (thread) open(false);
  var css = el => {
    var parts = []; while (el && el !== document.body && parts.length < 12) {
      if (el.id) { parts.unshift('#' + CSS.escape(el.id)); break; }
      var siblings = el.parentElement ? Array.from(el.parentElement.children).filter(x => x.tagName === el.tagName) : [];
      parts.unshift(el.tagName.toLowerCase() + (siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(el) + 1) + ')' : '')); el = el.parentElement;
    } return parts.join(' > ') || 'body';
  };
  var anchor = el => {
    var text = (el.textContent || '').trim().slice(0, 1000);
    return { type: 'element', elementId: el.getAttribute('data-eat-id') || el.id || undefined, selector: css(el), text: text || undefined,
      prefix: el.previousElementSibling ? (el.previousElementSibling.textContent || '').trim().slice(-200) : undefined,
      suffix: el.nextElementSibling ? (el.nextElementSibling.textContent || '').trim().slice(0,200) : undefined };
  };
  var draw = (el, rect) => { var r = el.getBoundingClientRect(); var p = rect || {x:0,y:0,width:1,height:1}; overlay.style.display='block'; overlay.style.left=(r.left+r.width*p.x)+'px'; overlay.style.top=(r.top+r.height*p.y)+'px'; overlay.style.width=(r.width*p.width)+'px'; overlay.style.height=(r.height*p.height)+'px'; };
  var finish = a => { cancelSelection(false); open(true); send('eat:anchor', { anchor:a }); };
  document.addEventListener('click', e => {
    if (suppressClick) { suppressClick=false; e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (selecting !== 'element' || root.contains(e.target) || !(e.target instanceof Element)) return;
    e.preventDefault(); e.stopImmediatePropagation(); current={el:e.target}; draw(e.target); finish(anchor(e.target));
  }, true);
  document.addEventListener('pointerdown', e => { if (selecting !== 'region' || e.button !== 0 || root.contains(e.target) || !(e.target instanceof Element)) return; e.preventDefault(); e.stopImmediatePropagation(); start={el:e.target,x:e.clientX,y:e.clientY}; }, true);
  document.addEventListener('pointerup', e => {
    if (!start || selecting !== 'region') return; e.preventDefault(); e.stopImmediatePropagation();
    if(Math.abs(e.clientX-start.x)<4 || Math.abs(e.clientY-start.y)<4){ start=null; return; }
    var r=start.el.getBoundingClientRect(); var clamp=x=>Math.max(0,Math.min(1,x));
    var x1=clamp((start.x-r.left)/(r.width||1)), y1=clamp((start.y-r.top)/(r.height||1)), x2=clamp((e.clientX-r.left)/(r.width||1)), y2=clamp((e.clientY-r.top)/(r.height||1));
    var a=anchor(start.el); a.type='region'; a.rect={x:Math.min(x1,x2),y:Math.min(y1,y2),width:Math.abs(x2-x1),height:Math.abs(y2-y1)};
    suppressClick=true; current={el:start.el,rect:a.rect}; draw(start.el,a.rect); finish(a);
  }, true);
  document.addEventListener('pointermove', e => {
    if(!selecting || root.contains(e.target) || !(e.target instanceof Element)) return;
    if(selecting==='element') draw(e.target);
    else if(start){ var r=start.el.getBoundingClientRect(); var clamp=x=>Math.max(0,Math.min(1,x)); var x1=clamp((start.x-r.left)/(r.width||1)), y1=clamp((start.y-r.top)/(r.height||1)), x2=clamp((e.clientX-r.left)/(r.width||1)), y2=clamp((e.clientY-r.top)/(r.height||1)); draw(start.el,{x:Math.min(x1,x2),y:Math.min(y1,y2),width:Math.abs(x2-x1),height:Math.abs(y2-y1)}); }
  },true);
  document.addEventListener('pointercancel', () => { if(selecting) cancelSelection(true); });
  document.addEventListener('keydown', e=> { if(e.key==='Escape' && !e.defaultPrevented){ if(selecting) cancelSelection(true); else if(expanded) close(); } });
  var locate = a => {
    if(a.type==='page') return true; var el=null;
    if(a.elementId) el=document.querySelector('[data-eat-id="'+CSS.escape(a.elementId)+'"]') || document.getElementById(a.elementId);
    if(!el && a.selector) { try { var candidate=document.querySelector(a.selector); if(candidate && (!a.text || (candidate.textContent||'').trim().startsWith(a.text))) el=candidate; } catch {} }
    if(!el && a.text) {
      var candidates=Array.from(document.body.querySelectorAll('*')).filter(x=> !root.contains(x) && x.id!=='__eat_highlight' && (x.textContent||'').trim()===a.text);
      if(candidates.length>1) candidates=candidates.filter(x=>(!a.prefix || x.previousElementSibling && (x.previousElementSibling.textContent||'').trim().endsWith(a.prefix)) && (!a.suffix || x.nextElementSibling && (x.nextElementSibling.textContent||'').trim().startsWith(a.suffix)));
      if(candidates.length===1) el=candidates[0];
    }
    if(!el){ overlay.style.display='none'; current=null; return false; } el.scrollIntoView({block:'center',behavior:'smooth'}); current={el:el,rect:a.rect}; draw(el,a.rect); return true;
  };
  window.addEventListener('message', e => {
    if(e.origin!==origin || e.source!==frame.contentWindow || !e.data) return;
    if(e.data.type==='eat:ready') init();
    if(e.data.type==='eat:comment-state' && e.data.versionId===config.versionId && e.data.page===page() && typeof e.data.hasComments==='boolean'){ hasComments=e.data.hasComments; updateToggle(); }
    if(e.data.type==='eat:close'){ cancelSelection(false); close(); }
    if(e.data.type==='eat:clear-anchor'){ current=null; overlay.style.display='none'; }
    if(e.data.type==='eat:select' && ['element','region'].includes(e.data.mode)){ previousCursor=document.documentElement.style.cursor; selecting=e.data.mode; panel.style.display='none'; document.documentElement.style.cursor='crosshair'; updateToggle(); hint.textContent=selecting==='element'?'点击要评论的元素':'按住拖动，选择页面区域'; var help=document.createElement('span'); help.textContent='按 Esc 或点击取消标注返回'; hint.appendChild(help); hint.style.display='block'; }
    if(e.data.type==='eat:locate') send('eat:located',{found:locate(e.data.anchor),threadId:e.data.threadId});
  });
  var redraw=()=>{ if(current && current.el.isConnected) draw(current.el,current.rect); else overlay.style.display='none'; };
  window.addEventListener('scroll',redraw,true); window.addEventListener('resize',redraw);
  ['pushState','replaceState'].forEach(k=>{var original=history[k];history[k]=function(){var result=original.apply(this,arguments);init();return result;};});
  window.addEventListener('popstate',init); window.addEventListener('hashchange',init);
})();`;
