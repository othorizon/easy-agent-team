'use strict';

(() => {
  const tabList = document.querySelector('.scene-tabs');
  const tabs = [...document.querySelectorAll('[data-tab]')];
  const panels = [...document.querySelectorAll('[data-panel]')];
  const sceneNames = new Set(panels.map((panel) => panel.dataset.panel));
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let activeScene = 'updates';

  function selectScene(scene, focus = false) {
    if (!sceneNames.has(scene)) return;
    activeScene = scene;
    tabs.forEach((tab) => {
      const selected = tab.dataset.tab === scene;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) {
        tab.focus({ preventScroll: true });
        const offset = tab.offsetLeft - tabList.offsetLeft;
        if (offset < tabList.scrollLeft || offset + tab.offsetWidth > tabList.scrollLeft + tabList.clientWidth) {
          tabList.scrollTo({ left: offset, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
        }
      }
    });
    panels.forEach((panel) => { panel.hidden = panel.dataset.panel !== scene; });
  }

  tabList.setAttribute('role', 'tablist');
  tabList.hidden = false;
  tabs.forEach((tab) => {
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `panel-${tab.dataset.tab}`);
    tab.addEventListener('click', () => selectScene(tab.dataset.tab));
    tab.addEventListener('keydown', (event) => {
      const currentIndex = tabs.indexOf(tab);
      let nextIndex;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % tabs.length;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = tabs.length - 1;
      if (nextIndex === undefined) return;
      event.preventDefault();
      selectScene(tabs[nextIndex].dataset.tab, true);
    });
  });
  panels.forEach((panel) => {
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `tab-${panel.dataset.panel}`);
    panel.tabIndex = 0;
  });
  selectScene(activeScene);

  const verticalTabs = window.matchMedia('(min-width: 801px)');
  const updateTabOrientation = () => tabList.setAttribute('aria-orientation', verticalTabs.matches ? 'vertical' : 'horizontal');
  verticalTabs.addEventListener('change', updateTabOrientation);
  updateTabOrientation();

  document.querySelectorAll('[data-scene]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      selectScene(link.dataset.scene);
      const section = document.getElementById('scenarios');
      window.scrollTo({ top: section.getBoundingClientRect().top + window.scrollY - 104, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
      document.getElementById(`tab-${activeScene}`).focus({ preventScroll: true });
    });
  });

  const prompts = {
    updates: '帮我把【本次更新的真实材料】做成一份 Changelog Folio，面向【使用者】。按“变化、影响、下一步”组织内容，说明谁会受益、在哪里体验，并提出一个具体的反馈问题。适合加入前后对比或截图。缺失的信息先标注，不编造更新、指标或链接。',
    research: '帮我把【研究材料】做成一份研究成果 Folio，面向【读者】。先给出核心结论，再展示证据、研究方法、来源与适用边界，最后说明建议和待验证问题。区分事实、推断与假设，引用提供的真实来源；缺失的信息先标注，不编造数据。',
    ideas: '帮我把【我的想法和观察】做成一份想法分享 Folio，面向【读者】。解释问题背景、我的主张、假设和取舍，标注内容仍在探索，最后提出一个具体的讨论问题。保留原意，缺失的信息先标注，不把假设写成定论。',
    demos: '帮我把【我的原型、工具或可视化】做成一份可交互的静态 Folio，面向【体验者】。说明体验目标，清晰标识可操作区域，加入必要的说明和反馈问题。明确标注假设参数、演示数据与尚未实现的能力；不调用未授权的接口，不编造业务指标。',
    retros: '帮我把【项目或实验的真实记录】做成一份复盘 Folio，面向【读者】。按目标、实际结果、关键取舍和可复用经验组织，解释当时的上下文与限制，给出下次可以执行的建议。区分事实与事后推测；缺失的信息先标注，不编造结果。',
    guides: '帮我把【反复被问到的问题和已有材料】做成一份团队指南 Folio，面向【使用者】。先说明适用场景，再按读者任务组织判断方法、示例、常见疑问与后续入口。以帮助读者自助理解为目标，缺失的信息先标注，不编造流程或链接。',
  };
  const status = document.getElementById('copy-status');
  const promptDialog = document.getElementById('prompt-dialog');
  const fallback = document.getElementById('prompt-fallback');
  const buttonTimers = new WeakMap();

  async function copyPrompt(button, value) {
    if (button.disabled) return;
    const original = button.innerHTML;
    button.disabled = true;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value);
      status.textContent = '起草提示已复制，可以粘贴给你的 AI 助手。';
      button.textContent = '已复制';
      if (buttonTimers.has(button)) window.clearTimeout(buttonTimers.get(button));
      buttonTimers.set(button, window.setTimeout(() => { button.innerHTML = original; button.disabled = false; }, 1800));
    } catch {
      button.disabled = false;
      fallback.value = value;
      promptDialog.showModal();
      fallback.focus();
      fallback.select();
      status.textContent = '自动复制不可用，请在弹窗中手动复制。';
    }
  }
  document.querySelectorAll('.copy-prompt').forEach((button) => {
    button.hidden = false;
    button.addEventListener('click', () => copyPrompt(button, prompts[button.dataset.prompt]));
  });
  const starterButton = document.getElementById('copy-starter');
  starterButton.hidden = false;
  starterButton.addEventListener('click', () => copyPrompt(starterButton, document.getElementById('starter-prompt').textContent));
  document.getElementById('select-prompt').addEventListener('click', () => { fallback.focus(); fallback.select(); });

  const count = document.getElementById('repeat-count');
  count.addEventListener('input', () => {
    document.getElementById('repeat-label').textContent = count.value;
    document.getElementById('saved-minutes').textContent = String(Number(count.value) * 5);
  });

  const tweaks = document.getElementById('tweaks-dialog');
  const tweaksButton = document.getElementById('open-tweaks');
  tweaksButton.hidden = false;
  tweaksButton.addEventListener('click', () => tweaks.showModal());
  document.querySelectorAll('[data-close-dialog]').forEach((button) => {
    button.addEventListener('click', () => button.closest('dialog').close());
  });
  [promptDialog, tweaks].forEach((dialog) => {
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
  });
  [['reading-size', 'readingSize', ['standard', 'large']], ['reading-density', 'readingDensity', ['comfortable', 'compact']]].forEach(([id, attribute, options]) => {
    const input = document.getElementById(id);
    try {
      const saved = localStorage.getItem(`folio-guide:${id}`);
      if (options.includes(saved)) input.value = saved;
    } catch { /* Reading controls work when browser storage is unavailable. */ }
    document.documentElement.dataset[attribute] = input.value;
    input.addEventListener('change', () => {
      document.documentElement.dataset[attribute] = input.value;
      try { localStorage.setItem(`folio-guide:${id}`, input.value); } catch { /* Optional persistence. */ }
    });
  });
})();
