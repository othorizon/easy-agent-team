/** 在用户站点运行的选择器；身份和评论表单始终位于平台源 iframe 内。 */
export const SITE_EMBED_SCRIPT = String.raw`(() => {
  if (document.getElementById('__eat_widget')) return;
  var script = document.currentScript;
  var config = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(script.dataset.eat), c => c.charCodeAt(0))));
  var origin = new URL(config.platform).origin;
  var root = document.createElement('div'); root.id = '__eat_widget';
  root.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483646;font:14px system-ui;color:#172033';
  var toggle = document.createElement('button'); toggle.textContent = '评论 · v' + config.versionNumber;
  toggle.style.cssText = 'border:1px solid #dbe3ef;border-radius:24px;background:#fff;color:#172033;padding:12px 18px;box-shadow:0 4px 20px #0002;cursor:pointer';
  var panel = document.createElement('div'); panel.style.cssText = 'display:none;width:min(420px,calc(100vw - 36px));height:min(650px,calc(100dvh - 100px));margin-bottom:10px;background:white;border:1px solid #dbe3ef;border-radius:12px;overflow:hidden;box-shadow:0 8px 36px #0003';
  var frame = document.createElement('iframe'); frame.title = 'EAT 网站评论'; frame.style.cssText = 'width:100%;height:100%;border:0';
  var page = () => location.pathname + (/^#(?:\/|!)/.test(location.hash) ? location.hash : '');
  var url = new URL(config.platform + '/site-comments/' + config.slug);
  url.searchParams.set('versionId', config.versionId); url.searchParams.set('page', page());
  url.searchParams.set('origin', location.origin);
  var thread = new URL(location.href).searchParams.get('eat_thread'); if (thread) url.searchParams.set('thread', thread);
  frame.src = url.href; panel.appendChild(frame); root.append(panel, toggle); document.body.appendChild(root);
  var send = (type, data) => frame.contentWindow.postMessage({ type: type, ...data }, origin);
  var init = () => send('eat:init', { proof: config.proof, page: page(), versionId: config.versionId });
  frame.addEventListener('load', init);
  var open = () => { panel.style.display = 'block'; toggle.textContent = '收起评论 · v' + config.versionNumber; init(); };
  toggle.onclick = () => { if (panel.style.display === 'none') open(); else { panel.style.display = 'none'; toggle.textContent = '评论 · v' + config.versionNumber; } };
  if (thread) open();
  var overlay = document.createElement('div'); overlay.id = '__eat_highlight';
  overlay.style.cssText = 'display:none;position:fixed;z-index:2147483645;pointer-events:none;border:2px solid #4f46e5;background:#6366f11a;box-sizing:border-box'; document.body.appendChild(overlay);
  var selecting = null, start = null, current = null, suppressClick = false;
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
  var finish = a => { selecting=null; start=null; document.documentElement.style.cursor=''; open(); send('eat:anchor', { anchor:a }); };
  document.addEventListener('click', e => {
    if (suppressClick) { suppressClick=false; e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (selecting !== 'element' || root.contains(e.target)) return;
    e.preventDefault(); e.stopImmediatePropagation(); current={el:e.target}; draw(e.target); finish(anchor(e.target));
  }, true);
  document.addEventListener('pointerdown', e => { if (selecting !== 'region' || root.contains(e.target)) return; e.preventDefault(); e.stopImmediatePropagation(); start={el:e.target,x:e.clientX,y:e.clientY}; }, true);
  document.addEventListener('pointerup', e => {
    if (!start || selecting !== 'region') return; e.preventDefault(); e.stopImmediatePropagation();
    var r=start.el.getBoundingClientRect(); var clamp=x=>Math.max(0,Math.min(1,x));
    var x1=clamp((start.x-r.left)/(r.width||1)), y1=clamp((start.y-r.top)/(r.height||1)), x2=clamp((e.clientX-r.left)/(r.width||1)), y2=clamp((e.clientY-r.top)/(r.height||1));
    var a=anchor(start.el); a.type='region'; a.rect={x:Math.min(x1,x2),y:Math.min(y1,y2),width:Math.abs(x2-x1),height:Math.abs(y2-y1)};
    suppressClick=true; current={el:start.el,rect:a.rect}; draw(start.el,a.rect); finish(a);
  }, true);
  document.addEventListener('keydown', e=> { if(e.key==='Escape'){ selecting=null; start=null; document.documentElement.style.cursor=''; open(); } });
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
    if(e.data.type==='eat:select' && ['element','region'].includes(e.data.mode)){ selecting=e.data.mode; panel.style.display='none'; document.documentElement.style.cursor='crosshair'; toggle.textContent='点击元素或拖选区域，Esc 取消'; }
    if(e.data.type==='eat:locate') send('eat:located',{found:locate(e.data.anchor),threadId:e.data.threadId});
  });
  var redraw=()=>{ if(current && current.el.isConnected) draw(current.el,current.rect); else overlay.style.display='none'; };
  window.addEventListener('scroll',redraw,true); window.addEventListener('resize',redraw);
  ['pushState','replaceState'].forEach(k=>{var original=history[k];history[k]=function(){var result=original.apply(this,arguments);init();return result;};});
  window.addEventListener('popstate',init); window.addEventListener('hashchange',init);
})();`;
